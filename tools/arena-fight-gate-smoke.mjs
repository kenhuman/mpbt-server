import { setTimeout as delay } from 'node:timers/promises';
import {
  assert,
  buildWorldCmd5SceneActionPacket,
  nextGamePacket,
  prepareArenaSession,
} from './smoke-lib.mjs';

const FIGHT_ACTION_TYPE = 5;
const ARENA_STATUS_ACTION_TYPE = 10;

async function waitForFrame(reader, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packet = await nextGamePacket(reader, Math.max(1, deadline - Date.now()));
    if (predicate(packet)) {
      return packet;
    }
  }
  throw new Error('timed out waiting for matching frame');
}

async function expectNoFrame(reader, predicate, timeoutMs = 2500) {
  try {
    await waitForFrame(reader, predicate, timeoutMs);
  } catch (error) {
    if (
      String(error).includes('timed out waiting for matching frame')
      || String(error).includes('timed out waiting for packet')
    ) {
      return;
    }
    throw error;
  }
  throw new Error('unexpected matching frame arrived');
}

function payloadText(packet) {
  return packet.packet.payload.toString('latin1');
}

const observer = await prepareArenaSession('fight_gate_obs');
let entrant;

try {
  entrant = await prepareArenaSession('fight_gate_ent');
  const arrival = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 13 && payloadText(packet).includes(entrant.callsign),
    5000,
  );
  assert(payloadText(arrival).includes(entrant.callsign), 'observer did not see entrant arrival');

  observer.world.socket.write(buildWorldCmd5SceneActionPacket(FIGHT_ACTION_TYPE, 3));
  const rejection = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes('Arena ready room occupied: stage a duel before entering combat.'),
    5000,
  );
  assert(payloadText(rejection).includes('stage a duel'), 'observer did not receive occupied-room fight rejection');

  await expectNoFrame(
    entrant.world.reader,
    packet => packet.frame.cmd === 11 && payloadText(packet).includes(observer.callsign),
    2500,
  );

  observer.world.socket.write(buildWorldCmd5SceneActionPacket(ARENA_STATUS_ACTION_TYPE, 4));
  const status = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 48
      && payloadText(packet).includes(observer.callsign)
      && payloadText(packet).includes(entrant.callsign),
    5000,
  );
  assert(payloadText(status).includes('Arena Status'), 'status list missing after fight gate rejection');

  console.log('PASS arena-fight-gate-smoke occupied-room-fight-rejected');
} finally {
  observer.world.socket.destroy();
  entrant?.world.socket.destroy();
  await delay(500);
}
