import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, recordOutcome } from './forecast.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';
import { hash, validateManifest } from './model.js';

// Synthetic dates make the offline example reproducible; this clock is never used by the CLI.
let clock = '2026-10-23T12:00:00.000Z';
const now = () => clock;
const directory = await mkdtemp(join(tmpdir(), 'pingroom-forecast-demo-'));
const manifest = validateManifest({ studyId: 'offline-release-week', events: [
  { id: 'build-duration', statement: 'The next production build finishes in under 15 minutes.', forecastBefore: '2026-10-23T18:00:00Z', observeAfter: '2026-10-25T00:00:00Z' },
  { id: 'support-backlog', statement: 'The support backlog has fewer than 10 open tickets at the agreed observation time.', forecastBefore: '2026-10-23T18:00:00Z', observeAfter: '2026-10-25T00:00:00Z' },
] });
const api = mockApi(now);
const options = { client: api.client, directory, manifest, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
try {
  let result = await step(options);
  api.answer(result.events[0].questionId, 'p70');
  await step({ ...options, eventId: 'build-duration' });
  result = await step(options);
  api.answer(result.events[1].questionId, 'p30');
  await step({ ...options, eventId: 'support-backlog' });
  clock = '2026-10-25T00:05:00.000Z';
  for (const [index, event] of manifest.events.entries()) result = await recordOutcome({ directory, manifest, eventId: event.id, now,
    loadReceipt: async () => ({ version: 1, manifestHash: hash(manifest), eventId: event.id, observedAt: now(), outcome: index === 0, sourceReference: `Offline fixture ${index + 1}` }) });
  console.log('Offline demo, synthetic October 2026 clock, real SDK with an in-memory HTTP transport. No credentials or network.');
  console.log(JSON.stringify({ scoredCount: result.scoredCount, meanBrierScore: result.meanBrierScore, buckets: result.buckets }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
