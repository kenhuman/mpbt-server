import { setTimeout as delay } from 'node:timers/promises';
import {
  assert,
  buildWorldCmd5SceneActionPacket,
  buildWorldCmd10MapReplyPacket,
  nextGamePacket,
  prepareArenaSession,
  prepareWorldSession,
} from './smoke-lib.mjs';

const TRAVEL_ACTION_TYPE = 4;
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

async function expectNoFrame(reader, predicate, timeoutMs = 2000) {
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

const observer = await prepareArenaSession('arena_cap_obs');
const fillers = [];
let blocked;

try {
  for (let index = 0; index < 7; index += 1) {
    const filler = await prepareArenaSession(`arena_cap_fill_${index}`);
    fillers.push(filler);
    const arrival = await waitForFrame(
      observer.world.reader,
      packet => packet.frame.cmd === 13 && payloadText(packet).includes(filler.callsign),
      5000,
    );
    assert(payloadText(arrival).includes(filler.callsign), `observer did not see filler ${index} arrival`);
  }

  observer.world.socket.write(buildWorldCmd5SceneActionPacket(ARENA_STATUS_ACTION_TYPE, 20));
  const fullStatus = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 48 && payloadText(packet).includes('Arena Status (8/8)'),
    5000,
  );
  assert(payloadText(fullStatus).includes(observer.callsign), 'observer missing from full arena status list');

  blocked = await prepareWorldSession('arena_cap_blocked');
  blocked.world.socket.write(buildWorldCmd5SceneActionPacket(TRAVEL_ACTION_TYPE, 1));
  const travelMap = await waitForFrame(
    blocked.world.reader,
    packet => packet.frame.cmd === 43,
    5000,
  );
  assert(travelMap.frame.cmd === 43, 'blocked pilot did not receive travel map');

  blocked.world.socket.write(buildWorldCmd10MapReplyPacket(0xc6, 148, 2));
  const rejection = await waitForFrame(
    blocked.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes('Arena ready room full: Ishiyama Arena already has 8 pilots.'),
    5000,
  );
  assert(payloadText(rejection).includes('8 pilots'), 'blocked pilot did not receive arena-cap rejection');

  await expectNoFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 13 && payloadText(packet).includes(blocked.callsign),
    2000,
  );

  console.log('PASS arena-room-cap-smoke 8-cap-enforced');
} finally {
  observer.world.socket.destroy();
  for (const filler of fillers) {
    filler.world.socket.destroy();
  }
  blocked?.world.socket.destroy();
  await delay(500);
}
