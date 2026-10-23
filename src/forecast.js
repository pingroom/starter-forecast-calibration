import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, readJson, atomicJson } from './storage.js';
import { validateManifest, validateConfig, validateState, validateReceipt, report, hash, isId, iso, requestFor, observeQuestion, assertParticipantRoom } from './model.js';
import { validateConnection } from './config.js';

const timestamp = (state, now) => {
  const time = iso(now());
  if (time < state.updatedAt) throw new Error('Clock moved backwards. Synchronize it before continuing.');
  return time;
};
function closeMissed(state, manifest, time) {
  return { ...state, updatedAt: time, events: state.events.map((row, index) => {
    if (row.status !== 'unasked') return row;
    const remaining = Date.parse(manifest.events[index].forecastBefore) - Date.parse(time);
    return remaining >= 30000 ? row : { ...row, status: 'missed', missedReason: remaining <= 0 ? 'cutoff_passed' : 'less_than_30_seconds' };
  }) };
}

/** One question creation or read, with a durable intent before any POST. */
export async function step({ client, directory, manifest: rawManifest, config: rawConfig, token, room, command = 'run', eventId, attachId,
  now = () => new Date().toISOString(), signal, write = atomicJson }) {
  const manifest = validateManifest(rawManifest), config = validateConfig(rawConfig), connection = validateConnection({ token, room });
  room = connection.room;
  if (!['run', 'find', 'recover'].includes(command) || eventId !== undefined && !manifest.events.some(event => event.id === eventId)
    || command !== 'run' && eventId === undefined || command === 'recover' && !isId(attachId)
    || command !== 'recover' && attachId !== undefined) throw new Error('Supply a valid event ID and, for recovery, its exact Question UUID.');
  const release = await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    let state = await readJson(join(directory, 'state.json'));
    if (state !== null) {
      validateState(state, manifest);
      if (state.credentialHash !== hash(token) || state.room !== room || hash(state.config) !== hash(config)) throw new Error('State belongs to another credential, room, or participant. Restore the original connection.');
    } else {
      if (command !== 'run') throw new Error('No existing forecast study to recover.');
      const time = iso(now());
      state = closeMissed({ version: 1, manifestHash: hash(manifest), config, room, credentialHash: hash(token), startedAt: time, updatedAt: time,
        events: manifest.events.map(event => ({ eventId: event.id, status: 'unasked', missedReason: null, attempt: null, outcome: null })) }, manifest, time);
      validateState(state, manifest);
      await write(directory, 'state.json', state);
    }
    const save = async next => { validateState(next, manifest); await write(directory, 'state.json', next); state = next; };
    const finish = () => report(state, manifest);
    const time = timestamp(state, now), closed = closeMissed(state, manifest, time);
    if (closed.events.some((row, index) => row.status !== state.events[index].status)) await save(closed);
    let index = eventId === undefined ? -1 : manifest.events.findIndex(event => event.id === eventId);
    if (index < 0) index = state.events.map((row, index) => ({ row, index })).filter(({ row }) => row.status === 'unasked')
      .sort((a, b) => manifest.events[a.index].forecastBefore.localeCompare(manifest.events[b.index].forecastBefore))[0]?.index ?? -1;
    if (index < 0) index = state.events.map((row, index) => ({ row, index })).filter(({ row }) => row.status === 'pending')
      .sort((a, b) => a.row.attempt.observation.checkedAt.localeCompare(b.row.attempt.observation.checkedAt))[0]?.index ?? -1;
    if (index < 0) return finish();
    let row = state.events[index]; const event = manifest.events[index];
    if (command === 'find') {
      if (row.status !== 'creating') throw new Error('This event has no uncertain creation.');
      const questions = await client.questions.list({ state: 'all' });
      if (!Array.isArray(questions) || questions.length > 200) throw new Error('Question list exceeds the bounded recent window.');
      const candidates = [];
      for (const question of questions) {
        try {
          observeQuestion(question, row.attempt, question.id, room, event, timestamp(state, now));
          candidates.push({ id: question.id, state: question.state });
        } catch { /* A recent-list miss cannot prove absence. Explicit GET recovery is authoritative. */ }
      }
      return { ...finish(), candidates };
    }
    if (command === 'recover' && !['creating', 'pending'].includes(row.status)) throw new Error('Only an uncertain or pending event can be recovered.');
    if (!['unasked', 'creating', 'pending'].includes(row.status) || row.status === 'creating' && command !== 'recover') return finish();
    let question, expectedId;
    if (row.status === 'pending' || command === 'recover') {
      if (row.attempt.questionId && attachId && row.attempt.questionId !== attachId) throw new Error('This event already tracks another Question.');
      expectedId = row.attempt.questionId ?? attachId;
      question = await client.questions.get(expectedId);
    } else {
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      const intendedAt = timestamp(state, now);
      const next = closeMissed(state, manifest, intendedAt);
      if (next.events[index].status === 'missed') { await save(next); return finish(); }
      const attempt = { id: randomUUID(), intendedAt, ttl: Math.min(86400, Math.floor((Date.parse(event.forecastBefore) - Date.parse(intendedAt)) / 1000)), request: null, questionId: null, observation: null };
      attempt.request = requestFor(manifest, config, event, attempt);
      row = { ...row, status: 'creating', attempt };
      await save({ ...next, events: next.events.map((item, i) => i === index ? row : item) });
      signal?.throwIfAborted();
      if (timestamp(state, now) >= event.forecastBefore) throw new Error('Cutoff passed after saving intent. Keep the uncertain record; no automatic resend.');
      try { question = await client.questions.ask(room, attempt.request); }
      catch { return finish(); }
      expectedId = question?.id;
    }
    signal?.throwIfAborted();
    const checkedAt = timestamp(state, now);
    const observed = observeQuestion(question, row.attempt, expectedId, room, event, checkedAt);
    row = { ...row, status: observed.status, attempt: { ...row.attempt, questionId: expectedId, observation: observed.observation } };
    await save({ ...state, updatedAt: checkedAt, events: state.events.map((item, i) => i === index ? row : item) });
    return finish();
  } finally { await release(); }
}

/** Receipts are read only after the configured observation date, and never revised. */
export async function recordOutcome({ directory, manifest: rawManifest, eventId, loadReceipt, now = () => new Date().toISOString(), write = atomicJson }) {
  const manifest = validateManifest(rawManifest), index = manifest.events.findIndex(event => event.id === eventId);
  if (index < 0 || typeof loadReceipt !== 'function') throw new Error('Supply an existing event ID and outcome receipt path.');
  const release = await acquireLock(directory);
  try {
    let state = await readJson(join(directory, 'state.json'));
    if (state === null) throw new Error('Initialize the study before importing an outcome.');
    validateState(state, manifest);
    const event = manifest.events[index], beforeRead = timestamp(state, now);
    if (beforeRead < event.observeAfter) throw new Error('Outcome receipt cannot be read before observeAfter.');
    const raw = await loadReceipt();
    const importedAt = timestamp(state, now);
    const receipt = validateReceipt(raw, manifest, event, importedAt), receiptHash = hash(receipt);
    if (state.events[index].outcome !== null) {
      if (state.events[index].outcome.receiptHash !== receiptHash) throw new Error('Outcome is already sealed. Receipts cannot be revised, including unresolved outcomes.');
      return report(state, manifest);
    }
    state = closeMissed(state, manifest, importedAt);
    state.events[index] = { ...state.events[index], outcome: { receipt, receiptHash, importedAt } };
    validateState(state, manifest); await write(directory, 'state.json', state);
    return report(state, manifest);
  } finally { await release(); }
}
export async function localReport(directory, rawManifest, { save = false } = {}) {
  const manifest = validateManifest(rawManifest), release = await acquireLock(directory);
  try {
    const state = await readJson(join(directory, 'state.json'));
    if (state === null) return { status: 'not_started' };
    const result = report(state, manifest);
    if (save) await atomicJson(directory, 'report.json', result);
    return result;
  } finally { await release(); }
}
