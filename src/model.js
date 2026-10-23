import { createHash } from 'node:crypto';

export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const slug = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const BUCKETS = [10, 30, 70, 90];
const statuses = ['unasked', 'missed', 'creating', 'pending', 'answered', 'late', 'expired', 'cancelled', 'invalid_answer'];

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(ms).toISOString();
}
export function validateManifest(value) {
  if (!keys(value, ['studyId', 'events']) || !slug(value.studyId) || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > 12) throw new Error('Provide a study ID and 1–12 prospective events.');
  const events = value.events.map(event => {
    if (!keys(event, ['id', 'statement', 'forecastBefore', 'observeAfter']) || !slug(event.id) || !line(event.statement, 200)) throw new Error('Each event needs an ID, a 1–200 character ASCII statement, and UTC dates.');
    const forecastBefore = iso(event.forecastBefore), observeAfter = iso(event.observeAfter);
    if (observeAfter <= forecastBefore) throw new Error('observeAfter must be later than forecastBefore.');
    return { id: event.id, statement: event.statement, forecastBefore, observeAfter };
  });
  if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Event IDs must be unique.');
  return { studyId: value.studyId, events };
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires the exact participant UUID and a label.');
  return structuredClone(config);
}
export function requestFor(manifest, config, event, attempt) {
  const ttl = Math.min(86400, Math.floor((Date.parse(event.forecastBefore) - Date.parse(attempt.intendedAt)) / 1000));
  if (!isId(attempt.id) || ttl < 30 || attempt.ttl !== ttl) throw new Error('Invalid forecast intent or insufficient answer time.');
  const key = `forecast-${attempt.id}`;
  return {
    prompt: `${event.statement}\nChance this will be true? Answer before ${event.forecastBefore}.\nOutcome assessed after ${event.observeAfter}.`,
    context: `Forecast ${hash({ manifest, event }).slice(0, 20)}`,
    options: BUCKETS.map(percent => ({ value: `p${percent}`, label: `${percent}%`, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl, correlation_id: key,
    data: { manifest_hash: hash(manifest), event_id: event.id, attempt_id: attempt.id, forecast_before: event.forecastBefore, observe_after: event.observeAfter },
    idempotencyKey: key,
  };
}
function validateObservation(observation, status, request, event) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (Math.abs(duration - request.ttl * 1000) > 1000) throw new Error('Question lifetime differs from the saved request.');
  if (observation.createdAt > observation.checkedAt) throw new Error('Question creation is in the future; synchronize the clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt || observation.resolvedAt > observation.checkedAt
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid question resolution time.');
  if (['answered', 'late'].includes(status)) {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some(option => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt) throw new Error('Invalid forecast answer evidence.');
    const timely = observation.createdAt < event.forecastBefore && answer.answeredAt < event.forecastBefore;
    if ((status === 'answered') !== timely) throw new Error('Forecast timeliness contradicts its timestamps.');
  } else if (observation.answer !== null) throw new Error('Unanswered event contains forecast evidence.');
}
export function observeQuestion(q, attempt, expectedId, room, event, checkedAt) {
  const request = attempt.request;
  if (!isId(expectedId) || q?.id !== expectedId || q.kind !== 'question' || q.is_handoff !== false || q.results !== null
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || q.room_code !== room || q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 4 || q.options.some((option, index) => option?.value !== request.options[index].value
      || option?.label !== request.options[index].label || option.primary !== false || option.destructive !== false)) throw new Error('Question does not match the saved event, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id, resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  if (Date.parse(observation.createdAt) < Date.parse(attempt.intendedAt) - 1000) throw new Error('Question predates its creation intent.');
  let status = q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved question contains an answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    status = 'invalid_answer';
    if (answer && answer.text === null && answer.responder?.id === request.target_user_id
      && request.options.some(option => option.value === answer.value && option.label === answer.label)) {
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      status = observation.createdAt < event.forecastBefore && observation.answer.answeredAt < event.forecastBefore ? 'answered' : 'late';
    }
  }
  validateObservation(observation, status, request, event);
  if (attempt.observation && ['createdAt', 'expiresAt', 'askerId'].some(key => attempt.observation[key] !== observation[key])) throw new Error('Question identity or lifetime changed.');
  return { status, observation };
}
export function validateReceipt(receipt, manifest, event, importedAt) {
  if (!keys(receipt, ['version', 'manifestHash', 'eventId', 'observedAt', 'outcome', 'sourceReference']) || receipt.version !== 1
    || receipt.manifestHash !== hash(manifest) || receipt.eventId !== event.id || ![true, false, null].includes(receipt.outcome)
    || !line(receipt.sourceReference, 200)) throw new Error('Outcome receipt does not match this event and manifest.');
  const observedAt = iso(receipt.observedAt);
  if (observedAt < event.observeAfter || observedAt > importedAt) throw new Error('Outcome must be observed after observeAfter and no later than import time.');
  return { ...receipt, observedAt };
}
export function validateState(state, rawManifest) {
  const manifest = validateManifest(rawManifest);
  if (!keys(state, ['version', 'manifestHash', 'config', 'room', 'credentialHash', 'startedAt', 'updatedAt', 'events']) || state.version !== 1
    || state.manifestHash !== hash(manifest) || !ROOM.test(state.room ?? '') || !/^[a-f0-9]{64}$/.test(state.credentialHash ?? '')
    || iso(state.startedAt) !== state.startedAt || iso(state.updatedAt) !== state.updatedAt || state.updatedAt < state.startedAt
    || !Array.isArray(state.events) || state.events.length !== manifest.events.length) throw new Error('Invalid state or changed manifest; restore the original study.');
  validateConfig(state.config);
  const attempts = new Set(), questions = new Set(); let askerId;
  for (const [index, row] of state.events.entries()) {
    const event = manifest.events[index];
    if (!keys(row, ['eventId', 'status', 'missedReason', 'attempt', 'outcome']) || row.eventId !== event.id || !statuses.includes(row.status)) throw new Error('Invalid saved event.');
    if (['unasked', 'missed'].includes(row.status)) {
      if (row.attempt !== null || (row.status === 'missed' ? !['cutoff_passed', 'less_than_30_seconds'].includes(row.missedReason) : row.missedReason !== null)) throw new Error('Invalid unasked event.');
      if (row.status === 'missed' && (row.missedReason === 'cutoff_passed' ? state.updatedAt < event.forecastBefore : Date.parse(event.forecastBefore) - Date.parse(state.updatedAt) >= 30000)) throw new Error('Missed window contradicts the journal time.');
    } else {
      const attempt = row.attempt;
      if (row.missedReason !== null || !keys(attempt, ['id', 'intendedAt', 'ttl', 'request', 'questionId', 'observation']) || !isId(attempt.id) || attempts.has(attempt.id)
        || iso(attempt.intendedAt) !== attempt.intendedAt || attempt.intendedAt < state.startedAt || attempt.intendedAt > state.updatedAt
        || hash(attempt.request) !== hash(requestFor(manifest, state.config, event, attempt))) throw new Error('Invalid forecast creation intent.');
      attempts.add(attempt.id);
      if (row.status === 'creating') {
        if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation record.');
      } else {
        if (!isId(attempt.questionId) || questions.has(attempt.questionId)) throw new Error('Invalid or duplicated question ID.');
        questions.add(attempt.questionId);
        validateObservation(attempt.observation, row.status, attempt.request, event);
        if (attempt.observation.checkedAt > state.updatedAt || Date.parse(attempt.observation.createdAt) < Date.parse(attempt.intendedAt) - 1000) throw new Error('Observation contradicts the saved intent.');
        if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
        askerId = attempt.observation.askerId;
      }
    }
    if (row.outcome !== null) {
      if (!keys(row.outcome, ['receipt', 'receiptHash', 'importedAt']) || iso(row.outcome.importedAt) !== row.outcome.importedAt
        || row.outcome.importedAt < state.startedAt || row.outcome.importedAt > state.updatedAt) throw new Error('Invalid outcome journal.');
      const receipt = validateReceipt(row.outcome.receipt, manifest, event, row.outcome.importedAt);
      if (hash(receipt) !== row.outcome.receiptHash) throw new Error('Outcome receipt hash changed.');
    }
  }
  return state;
}
export function report(state, manifest) {
  validateState(state, manifest);
  const events = state.events.map((row, index) => {
    const event = manifest.events[index], answer = row.attempt?.observation?.answer;
    const probability = answer ? Number(answer.value.slice(1)) / 100 : null;
    const outcome = row.outcome?.receipt.outcome ?? null;
    const scored = row.status === 'answered' && outcome !== null;
    const score = scored ? (Number(answer.value.slice(1)) - (outcome ? 100 : 0)) ** 2 / 10000 : null;
    return { eventId: row.eventId, statement: event.statement, forecastBefore: event.forecastBefore, observeAfter: event.observeAfter,
      status: row.status === 'creating' ? 'create_unknown' : row.status, missedReason: row.missedReason,
      questionId: row.attempt?.questionId ?? null, answeredAt: answer?.answeredAt ?? null, probability,
      outcomeStatus: row.outcome === null ? 'not_imported' : outcome === null ? 'unresolved' : 'resolved', outcome,
      sourceReference: row.outcome?.receipt.sourceReference ?? null, scored, brierScore: score };
  });
  const scored = events.filter(event => event.scored);
  return { studyId: manifest.studyId, manifestHash: state.manifestHash, participant: state.config.participant,
    startedAt: state.startedAt, updatedAt: state.updatedAt, eventCount: events.length, scoredCount: scored.length, unscoredCount: events.length - scored.length,
    meanBrierScore: scored.length ? scored.reduce((sum, event) => sum + Math.round(event.brierScore * 10000), 0) / scored.length / 10000 : null,
    buckets: BUCKETS.map(percent => {
      const bucket = scored.filter(event => event.probability === percent / 100);
      return { probability: percent / 100, count: bucket.length, observedFraction: bucket.length ? bucket.filter(event => event.outcome).length / bucket.length : null };
    }), events };
}
export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter(value => value?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some(member => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
