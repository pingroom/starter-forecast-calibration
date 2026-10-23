import { resolve } from 'node:path';
import { loadEnvironment, loadConnection, loadManifest, loadConfig, forecastDirectory } from './config.js';
import { readJson } from './storage.js';
import { makeClient } from './client.js';
import { connect } from './connect.js';
import { step, localReport, recordOutcome } from './forecast.js';
import { isId } from './model.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Stopped.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const [command, argument, second, ...extra] = process.argv.slice(2);
  const counts = { run: [0, 1], connect: [0], inspect: [0], status: [0], report: [0], find: [1], recover: [2], outcome: [2] };
  if (!counts[command]?.includes([argument, second, ...extra].filter(value => value !== undefined).length)) throw new Error('Unexpected command or arguments.');
  if (command === 'connect') await connect(controller.signal);
  else if (['status', 'report'].includes(command)) console.log(JSON.stringify(await localReport(forecastDirectory, await loadManifest(), { save: command === 'report' }), null, 2));
  else if (command === 'outcome') console.log(JSON.stringify(await recordOutcome({ directory: forecastDirectory, manifest: await loadManifest(), eventId: argument,
    loadReceipt: () => readJson(resolve(second), 16384) }), null, 2));
  else {
    await loadEnvironment();
    const connection = await loadConnection();
    const client = makeClient({ token: connection.token, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
    if (command === 'inspect') {
      const rooms = await client.rooms.list();
      if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
      const room = rooms.find(entry => entry?.invite_code === connection.room);
      if (!room || room.type !== 'standard' || room.is_public !== false || !Array.isArray(room.members) || room.members.length > 1000) throw new Error('Choose a granted standard private room with visible members.');
      console.log(JSON.stringify({ room: connection.room, people: room.members.filter(member => isId(member?.user_id)).map(member => ({ id: member.user_id,
        name: typeof member.user?.name === 'string' ? member.user.name.slice(0, 100) : null, role: member.role })) }, null, 2));
      console.log('Verify the intended person in the app. Use their exact member UUID; a display name alone does not establish identity.');
    } else {
      const result = await step({ client, ...connection, directory: forecastDirectory, manifest: await loadManifest(), config: await loadConfig(), command,
        eventId: argument, attachId: command === 'recover' ? second : undefined, signal: controller.signal });
      console.log(JSON.stringify(result, null, 2));
      if (result.events.some(event => event.status === 'create_unknown')) process.exitCode = 4;
      else if (result.events.some(event => ['unasked', 'pending'].includes(event.status))) process.exitCode = 3;
    }
  }
} catch (error) {
  if (controller.signal.aborted) { console.error('Stopped. Keep saved state; creation may be uncertain. Run status before continuing.'); process.exitCode = 130; }
  else {
    const safeLocal = error instanceof Error && !('code' in error) && error.name === 'Error';
    console.error(safeLocal ? error.message : 'Operation failed. Check configuration, granted room/scopes, network, and private state. Raw API errors are suppressed.');
    process.exitCode = 1;
  }
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
