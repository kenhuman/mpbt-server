import { setTimeout as delay } from 'node:timers/promises';
import { Msg } from '../dist/protocol/constants.js';
import {
  decodeArgType1,
  decodeArgType2,
  decodeArgType3,
} from '../dist/protocol/game.js';
import {
  assert,
  buildWorldCmd4TextPacket,
  buildWorldCmd5SceneActionPacket,
  buildWorldCmd7MenuReplyPacket,
  parseGameFrame,
  prepareArenaSession,
} from './smoke-lib.mjs';

const MMC_ESCAPE = '\x1b?MMC Copyright Kesmai Corp. 1991';
const MECH_BAY_ACTION_TYPE = 6;
const MECH_PICKER_LIST_ID = 0;

function decodeShortString(buf, offset) {
  const len = buf[offset] - 0x21;
  const start = offset + 1;
  const end = start + len;
  return [buf.subarray(start, end).toString('latin1'), end];
}

function parseCmd26(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 26) {
    throw new Error(`expected cmd 26, got ${frame?.cmd ?? 'non-frame'}`);
  }

  let offset = 3;
  const [typeFlag, nextAfterType] = decodeArgType1(payload, offset);
  offset = nextAfterType;
  const count = payload[offset] - 0x21;
  offset += 1;

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const [id, nextAfterId] = decodeArgType2(payload, offset);
    offset = nextAfterId;
    const mechType = payload[offset] - 0x21;
    offset += 1;
    const [slot, nextAfterSlot] = decodeArgType2(payload, offset);
    offset = nextAfterSlot;
    const [typeString, nextAfterTypeString] = decodeShortString(payload, offset);
    offset = nextAfterTypeString;
    const [variant, nextAfterVariant] = decodeShortString(payload, offset);
    offset = nextAfterVariant;
    const [name, nextAfterName] = decodeShortString(payload, offset);
    offset = nextAfterName;
    entries.push({ id, mechType, slot, typeString, variant, name });
  }

  const [footer] = decodeShortString(payload, offset);
  return { typeFlag, count, entries, footer };
}

function parseCmd64MechId(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 64) {
    throw new Error(`expected cmd 64, got ${frame?.cmd ?? 'non-frame'}`);
  }

  let offset = 3;
  offset += 1; // slot
  offset += 1; // actorType
  for (let i = 0; i < 5; i += 1) {
    const [, next] = decodeShortString(payload, offset);
    offset = next;
  }
  offset += 1; // statusByte
  const [mechId] = decodeArgType2(payload, offset);
  return mechId;
}

function parseCmd72MechId(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 72) {
    throw new Error(`expected cmd 72, got ${frame?.cmd ?? 'non-frame'}`);
  }

  let offset = 3;
  const [, nextAfterScenario] = decodeShortString(payload, offset);
  offset = nextAfterScenario;
  offset += 1; // localSlot
  offset += 1; // unknownByte0
  offset += 1; // terrainId

  const [, nextAfterTerrainResource] = decodeArgType2(payload, offset);
  offset = nextAfterTerrainResource;

  const terrainPointCount = payload[offset] - 0x21;
  offset += 1;
  for (let i = 0; i < terrainPointCount; i += 1) {
    [, offset] = decodeArgType3(payload, offset);
    [, offset] = decodeArgType3(payload, offset);
    [, offset] = decodeArgType2(payload, offset);
  }

  const arenaPointCount = payload[offset] - 0x21;
  offset += 1;
  for (let i = 0; i < arenaPointCount; i += 1) {
    [, offset] = decodeArgType3(payload, offset);
    [, offset] = decodeArgType3(payload, offset);
  }

  [, offset] = decodeArgType2(payload, offset);
  [, offset] = decodeArgType2(payload, offset);
  [, offset] = decodeArgType2(payload, offset);
  [, offset] = decodeArgType1(payload, offset); // headingBias raw

  for (let i = 0; i < 5; i += 1) {
    const [, next] = decodeShortString(payload, offset);
    offset = next;
  }

  offset += 1; // statusByte
  [, offset] = decodeArgType3(payload, offset); // initialX
  [, offset] = decodeArgType3(payload, offset); // initialY

  const boundsFlag = payload[offset] - 0x21;
  offset += 1;
  if (boundsFlag > 0) {
    [, offset] = decodeArgType3(payload, offset);
    [, offset] = decodeArgType3(payload, offset);
  }

  const extraType2Count = payload[offset] - 0x21;
  offset += 1;
  for (let i = 0; i < extraType2Count; i += 1) {
    [, offset] = decodeArgType2(payload, offset);
  }

  offset += 1; // remainingActorCount
  [, offset] = decodeArgType1(payload, offset); // unknownType1Raw
  const [mechId] = decodeArgType2(payload, offset);
  return mechId;
}

async function waitForMatchingPacket(reader, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const packet = await reader.next(Math.max(1, deadline - Date.now()));
    if (predicate(packet)) {
      return packet;
    }
  }
  throw new Error('timed out waiting for matching packet');
}

async function waitForCmd(reader, cmd, timeoutMs = 5000) {
  const packet = await waitForMatchingPacket(reader, candidate => {
    if (candidate.type !== Msg.SYNC) return false;
    const frame = parseGameFrame(candidate.payload);
    return frame?.cmd === cmd;
  }, timeoutMs);
  return { packet, frame: parseGameFrame(packet.payload) };
}

async function waitForCmd3Containing(reader, text, timeoutMs = 5000) {
  return waitForMatchingPacket(reader, candidate => {
    if (candidate.type !== Msg.SYNC) return false;
    const frame = parseGameFrame(candidate.payload);
    if (!frame || frame.cmd !== 3) return false;
    const [len, offset] = decodeArgType1(candidate.payload, 3);
    return candidate.payload.subarray(offset, offset + len).toString('latin1').includes(text);
  }, timeoutMs);
}

async function chooseMechByClass(session, classSelection, seqBase) {
  session.world.socket.write(buildWorldCmd5SceneActionPacket(MECH_BAY_ACTION_TYPE, seqBase));
  const classList = parseCmd26((await waitForCmd(session.world.reader, 26, 5000)).packet.payload);
  assert(classList.count >= classSelection, `class selection ${classSelection} unavailable`);

  session.world.socket.write(buildWorldCmd7MenuReplyPacket(MECH_PICKER_LIST_ID, classSelection, seqBase + 1));
  const chassisList = parseCmd26((await waitForCmd(session.world.reader, 26, 5000)).packet.payload);
  assert(chassisList.count > 0, 'chassis list unexpectedly empty');

  session.world.socket.write(buildWorldCmd7MenuReplyPacket(MECH_PICKER_LIST_ID, 1, seqBase + 2));
  const variantList = parseCmd26((await waitForCmd(session.world.reader, 26, 5000)).packet.payload);
  assert(variantList.count > 0, 'variant list unexpectedly empty');
  const chosen = variantList.entries[0];

  session.world.socket.write(buildWorldCmd7MenuReplyPacket(MECH_PICKER_LIST_ID, 1, seqBase + 3));
  await waitForCmd3Containing(session.world.reader, `Mech selected: ${chosen.typeString}`, 5000);
  return chosen;
}

async function collectCombatBootstrap(reader, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let sawMmc = false;
  const frames = [];

  while (Date.now() < deadline) {
    const packet = await reader.next(Math.max(1, deadline - Date.now()));
    if (packet.type !== Msg.SYNC) continue;
    if (packet.payload.toString('latin1') === MMC_ESCAPE) {
      sawMmc = true;
      continue;
    }
    const frame = parseGameFrame(packet.payload);
    if (!frame || !sawMmc) continue;
    frames.push({ packet, frame });
    if (frames.length >= 5) break;
  }

  assert(sawMmc, 'did not observe MMC combat welcome');
  const commands = frames.map(entry => entry.frame.cmd);
  assert(
    JSON.stringify(commands.slice(0, 5)) === JSON.stringify([72, 64, 65, 65, 62]),
    `unexpected combat bootstrap order ${commands.join(',')}`,
  );

  return {
    localMechId: parseCmd72MechId(frames[0].packet.payload),
    remoteMechId: parseCmd64MechId(frames[1].packet.payload),
  };
}

const attacker = await prepareArenaSession('mech_bootstrap_a');
const defender = await prepareArenaSession('mech_bootstrap_b');

try {
  const attackerChosen = await chooseMechByClass(attacker, 1, 3);
  const defenderChosen = await chooseMechByClass(defender, 4, 3);
  assert(attackerChosen.id !== defenderChosen.id, 'expected different selected mechs for the duel pair');

  attacker.world.socket.write(buildWorldCmd4TextPacket(`/duel ${defender.callsign}`, 7));
  await delay(250);
  defender.world.socket.write(buildWorldCmd4TextPacket('/acceptduel', 7));
  await delay(250);
  attacker.world.socket.write(buildWorldCmd4TextPacket('/fight', 8));

  const [attackerBootstrap, defenderBootstrap] = await Promise.all([
    collectCombatBootstrap(attacker.world.reader, 20000),
    collectCombatBootstrap(defender.world.reader, 20000),
  ]);

  assert(
    attackerBootstrap.localMechId === attackerChosen.id,
    `attacker local mech mismatch: expected ${attackerChosen.id}, got ${attackerBootstrap.localMechId}`,
  );
  assert(
    attackerBootstrap.remoteMechId === defenderChosen.id,
    `attacker remote mech mismatch: expected ${defenderChosen.id}, got ${attackerBootstrap.remoteMechId}`,
  );
  assert(
    defenderBootstrap.localMechId === defenderChosen.id,
    `defender local mech mismatch: expected ${defenderChosen.id}, got ${defenderBootstrap.localMechId}`,
  );
  assert(
    defenderBootstrap.remoteMechId === attackerChosen.id,
    `defender remote mech mismatch: expected ${attackerChosen.id}, got ${defenderBootstrap.remoteMechId}`,
  );

  console.log(
    `PASS duel-selected-mech-smoke attacker=${attackerChosen.typeString}:${attackerChosen.id} defender=${defenderChosen.typeString}:${defenderChosen.id}`,
  );
} finally {
  attacker.world.socket.destroy();
  defender.world.socket.destroy();
  await delay(500);
}
