import { setTimeout as delay } from 'node:timers/promises';
import {
  assert,
  buildWorldCmd4TextPacket,
  buildWorldCmd5SceneActionPacket,
  buildWorldCmd7MenuReplyPacket,
  nextGamePacket,
  prepareArenaSession,
} from './smoke-lib.mjs';

const ARENA_SIDE_ACTION_TYPE = 9;
const ARENA_STATUS_ACTION_TYPE = 10;
const ARENA_SIDE_MENU_ID = 0x3F6;

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

function payloadText(packet) {
  return packet.packet.payload.toString('latin1');
}

async function chooseArenaSide(session, side, seqBase) {
  session.world.socket.write(buildWorldCmd5SceneActionPacket(ARENA_SIDE_ACTION_TYPE, seqBase));
  const menu = await waitForFrame(session.world.reader, packet => packet.frame.cmd === 7, 5000);
  assert(payloadText(menu).includes('Choose a side:'), 'arena side menu title missing');

  session.world.socket.write(buildWorldCmd7MenuReplyPacket(ARENA_SIDE_MENU_ID, side, seqBase + 1));
  const notice = await waitForFrame(
    session.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes(`Arena side set: Side ${side}.`),
    5000,
  );
  assert(payloadText(notice).includes(`Arena side set: Side ${side}.`), 'arena side confirmation missing');

  const status = await waitForFrame(
    session.world.reader,
    packet => packet.frame.cmd === 48 && payloadText(packet).includes(`Side ${side}`),
    5000,
  );
  return status;
}

const observer = await prepareArenaSession('arena_obs');
let entrant;
let challenger;

try {
  entrant = await prepareArenaSession('arena_ent');
  const observerSceneInit = observer.arenaInitPackets.find(packet => packet.frame.cmd === 4);
  assert(observerSceneInit, 'observer missing arena scene init');
  assert(payloadText(observerSceneInit).includes('Mech'), 'arena scene did not expose Mech action');
  assert(!payloadText(observerSceneInit).includes('Mech Bay'), 'arena scene still exposed Mech Bay label');

  const arrival = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 13 && payloadText(packet).includes(entrant.callsign),
    5000,
  );
  assert(payloadText(arrival).includes(entrant.callsign), 'observer did not see entrant arrival');

  observer.world.socket.write(buildWorldCmd5SceneActionPacket(ARENA_STATUS_ACTION_TYPE, 3));
  const baselineStatus = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 48
      && payloadText(packet).includes(observer.callsign)
      && payloadText(packet).includes(entrant.callsign),
    5000,
  );
  assert(payloadText(baselineStatus).includes('Arena Status'), 'arena status list title missing');
  assert(payloadText(baselineStatus).includes('Picked:'), 'arena status list did not report mech-picked state');

  const observerStatus = await chooseArenaSide(observer, 1, 4);
  assert(payloadText(observerStatus).includes(observer.callsign), 'observer missing from side status list');

  const entrantStatus = await chooseArenaSide(entrant, 1, 3);
  assert(payloadText(entrantStatus).includes(entrant.callsign), 'entrant missing from side status list');

  observer.world.socket.write(buildWorldCmd4TextPacket(`/duel ${entrant.callsign}`, 6));
  const teammateReject = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes('Same-side pilots are teammates.'),
    5000,
  );
  assert(payloadText(teammateReject).includes('Side 1'), 'same-side duel rejection did not mention the shared side');

  entrant.world.socket.destroy();
  await delay(200);
  const departure = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 11 && payloadText(packet).includes(entrant.callsign),
    5000,
  );
  assert(payloadText(departure).includes(entrant.callsign), 'observer did not see entrant departure');

  challenger = await prepareArenaSession('arena_challenger');
  const challengerArrival = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 13 && payloadText(packet).includes(challenger.callsign),
    5000,
  );
  assert(payloadText(challengerArrival).includes(challenger.callsign), 'observer did not see challenger arrival');

  challenger.world.socket.write(buildWorldCmd4TextPacket(`/duel ${observer.callsign}`, 3));
  const incoming = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes('challenged you to a duel'),
    5000,
  );
  assert(payloadText(incoming).includes(challenger.callsign), 'observer did not receive challenger invite');

  challenger.world.socket.destroy();
  await delay(200);
  observer.world.socket.write(buildWorldCmd4TextPacket('/acceptduel', 7));
  const stale = await waitForFrame(
    observer.world.reader,
    packet => packet.frame.cmd === 3 && payloadText(packet).includes('challenger is no longer available'),
    5000,
  );
  assert(payloadText(stale).includes('challenger is no longer available'), 'stale duel accept was not rejected');

  console.log('PASS arena-room-smoke side/status/arrival/stale-duel');
} finally {
  observer.world.socket.destroy();
  entrant?.world.socket.destroy();
  challenger?.world.socket.destroy();
  await delay(500);
}
