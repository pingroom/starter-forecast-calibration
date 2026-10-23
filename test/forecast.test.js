import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, recordOutcome, localReport } from '../src/forecast.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';
import { validateManifest, hash, iso, report, validateState } from '../src/model.js';
import { atomicJson, readJson, readText, acquireLock } from '../src/storage.js';
import { makeClient, API } from '../src/client.js';
import { loadEnvironment, loadConnection } from '../src/config.js';

const rawManifest = (count = 2) => ({ studyId: 'release-week', events: Array.from({ length: count }, (_, index) => ({ id: `event-${index + 1}`,
  statement: `Operational event ${index + 1} happens by the observation time.`, forecastBefore: '2026-10-23T18:00:00Z', observeAfter: '2026-10-25T00:00:00Z' })) });
async function fixture(t, count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'forecast-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = '2026-10-23T12:00:00.000Z'; const now = () => clock;
  const api = mockApi(now), manifest = validateManifest(rawManifest(count));
  const options = { client: api.client, directory, manifest, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, api, manifest, options, now, time: value => { clock = value; },
    run: extra => step({ ...options, ...extra }),
    state: () => readJson(join(directory, 'state.json')),
    receipt: (eventId, outcome = true) => ({ version: 1, manifestHash: hash(manifest), eventId, observedAt: now(), outcome, sourceReference: 'Fixture receipt' }),
    import: (eventId, receipt) => recordOutcome({ directory, manifest, eventId, now, loadReceipt: async () => receipt }),
  };
}
const posts = f => f.api.calls.filter(call => call.method === 'POST');
async function answered(f, eventId, value = 'p70') {
  let result = await f.run({ eventId });
  const questionId = result.events.find(event => event.eventId === eventId).questionId;
  f.api.answer(questionId, value);
  result = await f.run({ eventId });
  return { result, questionId };
}

test('real SDK creates named four-choice questions; correct binary scores and bucket denominators', async t => {
  const f = await fixture(t);
  const first = await answered(f, 'event-1', 'p70');
  await answered(f, 'event-2', 'p30');
  assert.equal(first.result.events[0].status, 'answered');
  assert.equal(posts(f).length, 2);
  assert.deepEqual(posts(f)[0].body.options.map(option => option.value), ['p10', 'p30', 'p70', 'p90']);
  assert.equal(posts(f)[0].body.target_user_id, CONFIG.participant.id);
  assert.equal(posts(f)[0].body.ttl, 21600);
  assert.equal('outcome' in posts(f)[0].body.data, false);
  f.time('2026-10-25T00:05:00.000Z');
  await f.import('event-1', f.receipt('event-1', true));
  const result = await f.import('event-2', f.receipt('event-2', false));
  assert.equal(result.meanBrierScore, 0.09); assert.equal(result.scoredCount, 2);
  assert.deepEqual(result.buckets, [{ probability: 0.1, count: 0, observedFraction: null }, { probability: 0.3, count: 1, observedFraction: 0 },
    { probability: 0.7, count: 1, observedFraction: 1 }, { probability: 0.9, count: 0, observedFraction: null }]);
  const replay = await f.run({ eventId: 'event-1' });
  assert.equal(replay.meanBrierScore, 0.09); assert.equal(posts(f).length, 2);
});

test('default advances unasked events before reading the oldest pending question', async t => {
  const f = await fixture(t);
  await f.run(); await f.run(); assert.equal(posts(f).length, 2);
  f.time('2026-10-23T12:01:00.000Z'); await f.run();
  assert.equal(f.api.calls.at(-1).path, `/api/agent/questions/${id(1)}`);
  f.time('2026-10-23T12:02:00.000Z'); await f.run();
  assert.equal(f.api.calls.at(-1).path, `/api/agent/questions/${id(2)}`);
});

test('first initialization after cutoff records missed without any API call', async t => {
  const f = await fixture(t); f.time('2026-10-23T18:00:00.000Z');
  const result = await f.run();
  assert.ok(result.events.every(event => event.status === 'missed' && event.missedReason === 'cutoff_passed'));
  assert.equal(f.api.calls.length, 0); assert.equal(result.meanBrierScore, null);
});

test('under 30 seconds left is missed; exactly 30 seconds is allowed', async t => {
  const f = await fixture(t); f.time('2026-10-23T17:59:30.000Z');
  await f.run({ eventId: 'event-1' }); assert.equal(posts(f)[0].body.ttl, 30);
  f.time('2026-10-23T17:59:30.001Z'); const result = await f.run({ eventId: 'event-2' });
  assert.equal(result.events[1].missedReason, 'less_than_30_seconds'); assert.equal(posts(f).length, 1);
});

test('preflight crossing cutoff does not send', async t => {
  const f = await fixture(t, 1);
  const list = f.api.client.rooms.list.bind(f.api.client.rooms);
  f.api.client.rooms.list = async () => { const result = await list(); f.time('2026-10-23T18:00:00.000Z'); return result; };
  assert.equal((await f.run()).events[0].status, 'missed'); assert.equal(posts(f).length, 0);
});

test('question TTL caps at one day; expired forecasts are never reissued', async t => {
  const f = await fixture(t, 1); f.options.manifest = validateManifest({ ...rawManifest(1), events: [{ ...rawManifest(1).events[0], forecastBefore: '2026-10-24T18:00:00Z' }] });
  const created = await f.run(); assert.equal(posts(f)[0].body.ttl, 86400);
  f.time('2026-10-24T12:01:00.000Z'); f.api.terminal(created.events[0].questionId, 'expired');
  assert.equal((await f.run()).events[0].status, 'expired'); await f.run(); assert.equal(posts(f).length, 1);
});

test('answer exactly at cutoff is late and unscored even with a true outcome', async t => {
  const f = await fixture(t, 1); const created = await f.run();
  f.time('2026-10-23T18:00:00.000Z'); f.api.answer(created.events[0].questionId, 'p90');
  assert.equal((await f.run()).events[0].status, 'late');
  f.time('2026-10-25T00:05:00.000Z'); const result = await f.import('event-1', f.receipt('event-1'));
  assert.equal(result.events[0].probability, 0.9); assert.equal(result.scoredCount, 0); assert.equal(result.meanBrierScore, null);
});

test('cancelled and invalid-responder answers remain unscored and terminal', async t => {
  const f = await fixture(t); await f.run(); await f.run();
  f.api.terminal(id(1), 'cancelled'); f.api.answer(id(2), 'p10'); f.api.questions.get(id(2)).answer.responder.id = OTHER;
  assert.equal((await f.run({ eventId: 'event-1' })).events[0].status, 'cancelled');
  assert.equal((await f.run({ eventId: 'event-2' })).events[1].status, 'invalid_answer');
  await f.run({ eventId: 'event-2' }); assert.equal(posts(f).length, 2);
});

test('pending with a known outcome and answered with unresolved outcome are unscored', async t => {
  const f = await fixture(t); await f.run({ eventId: 'event-1' }); await answered(f, 'event-2');
  f.time('2026-10-25T00:05:00.000Z'); await f.import('event-1', f.receipt('event-1'));
  const result = await f.import('event-2', f.receipt('event-2', null));
  assert.equal(result.scoredCount, 0); assert.equal(result.events[1].outcomeStatus, 'unresolved');
});

test('outcome gate refuses to read the receipt file before observation date', async t => {
  const f = await fixture(t); await f.run(); let reads = 0;
  await assert.rejects(recordOutcome({ directory: f.directory, manifest: f.manifest, eventId: 'event-1', now: f.now, loadReceipt: async () => { reads++; return {}; } }), /before observeAfter/);
  assert.equal(reads, 0);
});

test('receipt replay is a no-op and resolved or unresolved receipts cannot be revised', async t => {
  const f = await fixture(t); await f.run(); f.time('2026-10-25T00:05:00.000Z');
  const receipt = f.receipt('event-1', null); await f.import('event-1', receipt);
  const before = await readFile(join(f.directory, 'state.json'), 'utf8');
  f.time('2026-10-25T00:06:00.000Z'); await f.import('event-1', receipt);
  assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), before);
  await assert.rejects(f.import('event-1', { ...receipt, outcome: true }), /already sealed/);
  await assert.rejects(f.import('event-1', { ...receipt, sourceReference: 'Changed evidence' }), /already sealed/);
});

test('wrong event, manifest, dates, extra fields and malformed receipt preserve saved state', async t => {
  const f = await fixture(t, 1); await f.run(); f.time('2026-10-25T00:05:00.000Z');
  const before = await f.state(), valid = f.receipt('event-1');
  for (const receipt of [{ ...valid, eventId: 'event-2' }, { ...valid, manifestHash: 'a'.repeat(64) }, { ...valid, observedAt: '2026-10-24T23:59:59Z' },
    { ...valid, observedAt: '2026-10-25T00:06:00Z' }, { ...valid, outcome: 'true' }, { ...valid, answer: 'yes' }, null]) {
    await assert.rejects(f.import('event-1', receipt)); assert.deepEqual(await f.state(), before);
  }
});

test('lost POST response is durable, never retried, and recovered by exact verified ID', async t => {
  const f = await fixture(t, 1); f.api.controls.loseNext = true;
  assert.equal((await f.run()).events[0].status, 'create_unknown');
  await f.run(); assert.equal(posts(f).length, 1);
  const found = await f.run({ command: 'find', eventId: 'event-1' }); assert.deepEqual(found.candidates, [{ id: id(1), state: 'pending' }]);
  await f.run({ command: 'recover', eventId: 'event-1', attachId: id(1) });
  assert.equal((await f.state()).events[0].status, 'pending'); assert.equal(posts(f).length, 1);
});

test('malformed POST reply leaves uncertain intent; an empty recent list cannot clear it', async t => {
  const f = await fixture(t, 1); f.api.controls.malformedNext = true;
  await assert.rejects(f.run(), /does not match/);
  f.api.questions.clear(); const result = await f.run({ command: 'find', eventId: 'event-1' });
  assert.deepEqual(result.candidates, []); assert.equal(result.events[0].status, 'create_unknown');
  await f.run(); assert.equal(posts(f).length, 1);
});

test('recovery rejects wrong provenance and requires exact event nonce', async t => {
  const f = await fixture(t); f.api.controls.loseNext = true; await f.run({ eventId: 'event-1' }); await f.run({ eventId: 'event-2' });
  const before = await f.state();
  await assert.rejects(f.run({ command: 'recover', eventId: 'event-1', attachId: id(2) }), /does not match/);
  assert.deepEqual(await f.state(), before);
});

test('room, kind, poll results, options, context, origin and data tampering fail closed', async t => {
  const f = await fixture(t, 1); await f.run(); const original = structuredClone(f.api.questions.get(id(1))), before = await f.state();
  const changes = [q => { q.room.code = 'OTHER1234567'; }, q => { q.is_handoff = true; }, q => { q.results = {}; }, q => { q.options[0].primary = true; },
    q => { q.context = 'changed'; }, q => { q.asker.type = 'user'; }, q => { q.data.event_id = 'other'; }, q => { q.target_user_id = OTHER; }];
  for (const change of changes) { const q = structuredClone(original); change(q); f.api.questions.set(id(1), q); await assert.rejects(f.run()); assert.deepEqual(await f.state(), before); }
});

test('late resolution beyond expiry, before creation and future answer timestamps are rejected', async t => {
  const f = await fixture(t, 1); await f.run(); f.api.answer(id(1), 'p70'); const original = structuredClone(f.api.questions.get(id(1))), before = await f.state();
  for (const at of ['2026-10-23T11:59:59Z', '2026-10-23T18:00:01Z', '2026-10-23T12:00:01Z']) {
    const q = structuredClone(original); q.answer.answered_at = at; q.resolved_at = at; f.api.questions.set(id(1), q);
    await assert.rejects(f.run()); assert.deepEqual(await f.state(), before);
  }
});

test('same asking registration is required across events', async t => {
  const f = await fixture(t); await f.run(); await f.run(); const before = await f.state();
  f.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(f.run({ eventId: 'event-2' }), /identity or lifetime changed/); assert.deepEqual(await f.state(), before);
});

test('network failure preserves prior observation; terminal events are cached locally', async t => {
  const f = await fixture(t, 1); await f.run(); const before = await f.state(); f.api.controls.readError = true;
  await assert.rejects(f.run()); assert.deepEqual(await f.state(), before);
  f.api.controls.readError = false; f.api.answer(id(1), 'p90'); await f.run(); const calls = f.api.calls.length;
  await f.run(); assert.equal(f.api.calls.length, calls);
});

test('credential, room, participant or immutable manifest changes are rejected before API calls', async t => {
  const f = await fixture(t, 1); await f.run(); const calls = f.api.calls.length;
  for (const extra of [{ token: 'different-token' }, { room: 'OTHER1234567' }, { config: { participant: { id: OTHER, label: 'Other' } } },
    { manifest: { ...f.manifest, studyId: 'changed' } }]) await assert.rejects(f.run(extra));
  assert.equal(f.api.calls.length, calls);
});

test('manifest rejects bounds, unsafe text, duplicate IDs, unknown answers and invalid UTC dates', () => {
  for (const value of [rawManifest(0), rawManifest(13), { ...rawManifest(), answer: true }, { ...rawManifest(), events: [rawManifest().events[0], rawManifest().events[0]] },
    { ...rawManifest(1), events: [{ ...rawManifest().events[0], statement: 'line\nbreak' }] },
    { ...rawManifest(1), events: [{ ...rawManifest().events[0], forecastBefore: '2026-10-25T00:00:00Z' }] }]) assert.throws(() => validateManifest(value));
  for (const value of ['2026-02-30T12:00:00Z', '2026-10-23T12:00:00-04:00', '2026-10-23', '2026-10-23T24:00:00Z']) assert.throws(() => iso(value));
});

test('null, malformed and contradictory saved state never reset a study', async t => {
  const f = await fixture(t, 1); await f.run(); const original = await f.state(), calls = f.api.calls.length;
  for (const contents of ['null', '{', JSON.stringify({ ...original, updatedAt: original.startedAt, events: [{ ...original.events[0], status: 'answered' }] })]) {
    await writeFile(join(f.directory, 'state.json'), contents); await assert.rejects(f.run());
  }
  assert.equal(f.api.calls.length, calls);
});

test('saved answer and outcome tampering is detected during offline report', async t => {
  const f = await fixture(t, 1); await answered(f, 'event-1'); f.time('2026-10-25T00:05:00.000Z'); await f.import('event-1', f.receipt('event-1'));
  const original = await f.state();
  const badAnswer = structuredClone(original); badAnswer.events[0].attempt.observation.answer.answeredAt = '2026-10-23T18:01:00.000Z';
  assert.throws(() => report(badAnswer, f.manifest));
  const badOutcome = structuredClone(original); badOutcome.events[0].outcome.receipt.outcome = false;
  assert.throws(() => validateState(badOutcome, f.manifest), /hash changed/);
});

test('clock regression, concurrent lock and failed intent persistence prevent writes', async t => {
  const f = await fixture(t, 1); const release = await acquireLock(f.directory);
  await assert.rejects(f.run(), /lock exists/); await release();
  await assert.rejects(f.run({ write: async () => { throw new Error('disk full'); } }), /disk full/); assert.equal(posts(f).length, 0);
  await f.run(); f.time('2026-10-23T11:59:59.000Z'); await assert.rejects(f.run(), /Clock moved backwards/); assert.equal(posts(f).length, 1);
});

test('POST response followed by a failed state save leaves recoverable creation intent', async t => {
  const f = await fixture(t, 1); let writes = 0;
  await assert.rejects(f.run({ write: async (...args) => { writes++; if (writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await f.state()).events[0].status, 'creating'); await f.run(); assert.equal(posts(f).length, 1);
  await f.run({ command: 'recover', eventId: 'event-1', attachId: id(1) }); assert.equal((await f.state()).events[0].status, 'pending');
});

test('offline report needs no credential and private files are bounded with POSIX permissions', async t => {
  const f = await fixture(t, 1); await f.run(); const result = await localReport(f.directory, f.manifest, { save: true });
  assert.equal(result.scoredCount, 0); assert.equal((await stat(join(f.directory, 'report.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  await assert.rejects(atomicJson(f.directory, 'too-big.json', { text: 'x'.repeat(100) }, 20), /size limit/);
});

test('complete external environment pair overrides saved credentials; partial and blank pairs never mix', async t => {
  const f = await fixture(t, 1); await atomicJson(f.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  assert.equal((await loadConnection(f.directory, {})).token, 'saved');
  assert.deepEqual(await loadConnection(f.directory, { PINGROOM_TOKEN: 'external', PINGROOM_ROOM: ROOM_CODE.toLowerCase() }), { token: 'external', room: ROOM_CODE });
  const dotenv = join(f.directory, '.env'); await writeFile(dotenv, `PINGROOM_TOKEN=file\nPINGROOM_ROOM=${ROOM_CODE}\n`);
  for (const env of [{ PINGROOM_TOKEN: 'external' }, { PINGROOM_ROOM: ROOM_CODE }, { PINGROOM_TOKEN: '', PINGROOM_ROOM: ROOM_CODE }]) {
    await assert.rejects(loadEnvironment(env, dotenv)); await assert.rejects(loadConnection(f.directory, env));
  }
  const env = {}; await loadEnvironment(env, dotenv); assert.equal((await loadConnection(f.directory, env)).token, 'file');
});

test('transport refuses redirects, oversized/malformed UTF-8 bodies, unexpected endpoints and hung requests', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://example.com' } }), new Response('x'.repeat(512 * 1024 + 1)), new Response(new Uint8Array([0xff]))]) {
    const client = makeClient({ token: 'fixture', fetchImpl: async () => response }); await assert.rejects(client.rooms.list());
  }
  const hung = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(hung.rooms.list());
  const refused = makeClient({ token: 'fixture', fetchImpl: async () => { throw new Error('must not reach transport'); } });
  await assert.rejects(refused.rooms.create({ name: 'No' }));
});

test('abort and local malformed UTF-8 fail without sending a forecast', async t => {
  const f = await fixture(t, 1), controller = new AbortController(); controller.abort();
  await assert.rejects(f.run({ signal: controller.signal })); assert.equal(posts(f).length, 0);
  const path = join(f.directory, 'bad.json'); await writeFile(path, new Uint8Array([0xff])); await assert.rejects(readText(path), /UTF-8/);
});

test('grant preflight rejects a public room or missing participant before POST', async t => {
  const f = await fixture(t, 1); f.api.rooms[0].is_public = true; await assert.rejects(f.run(), /standard private/);
  f.api.rooms[0].is_public = false; f.api.rooms[0].members = [{ user_id: OTHER }]; await assert.rejects(f.run(), /named participant/);
  assert.equal(posts(f).length, 0);
});

test('delayed expiry resolution is accepted; expiry before its deadline is rejected', async t => {
  const f = await fixture(t, 1); await f.run(); f.time('2026-10-23T18:01:00.000Z'); f.api.terminal(id(1), 'expired');
  f.api.questions.get(id(1)).resolved_at = '2026-10-23T17:59:59.000Z';
  await assert.rejects(f.run(), /resolution time/);
  f.api.questions.get(id(1)).resolved_at = f.now(); assert.equal((await f.run()).events[0].status, 'expired');
  assert.equal(posts(f).length, 1);
});

test('Brier score uses squared probability error, with equal weight per scored event', async t => {
  const f = await fixture(t); await answered(f, 'event-1', 'p90'); await answered(f, 'event-2', 'p10');
  f.time('2026-10-25T00:05:00.000Z'); await f.import('event-1', f.receipt('event-1', false));
  const result = await f.import('event-2', f.receipt('event-2', false));
  assert.equal(result.events[0].brierScore, 0.81); assert.equal(result.events[1].brierScore, 0.01); assert.equal(result.meanBrierScore, 0.41);
});
