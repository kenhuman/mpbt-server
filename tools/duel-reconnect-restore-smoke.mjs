import { setTimeout as delay } from 'node:timers/promises';
import { Msg } from '../dist/protocol/constants.js';
import {
  decodeArgType1,
  decodeArgType2,
  decodeArgType3,
} from '../dist/protocol/game.js';
import {
  assert,
  buildCombatClientPacket,
  buildWorldCmd4TextPacket,
  buildWorldCmd5SceneActionPacket,
  buildWorldCmd7MenuReplyPacket,
  buildWorldCmd15DuelTermsPacket,
  connectExistingWorldSession,
  parseGameFrame,
  prepareArenaSession,
  waitForWorldRestore,
} from './smoke-lib.mjs';
import { waitForCombatBootstrap } from './duel-smoke-lib.mjs';

const MMC_ESCAPE = '\x1b?MMC Copyright Kesmai Corp. 1991';
const MECH_BAY_ACTION_TYPE = 6;
const DUEL_TERMS_ACTION_TYPE = 7;
const MECH_PICKER_LIST_ID = 0;
const STAKE_CB = 250;

function buildCombatCmd12ActionPacket(action, seq = 1) {
  return buildCombatClientPacket(12, Buffer.from([action + 0x21]), seq);
}

function decodeShortString(buf, offset) {
  const len = buf[offset] - 0x21;
  const start = offset + 1;
  const end = start + len;
  return [buf.subarray(start, end).toString('latin1'), end];
}

function parseCmd3Text(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 3) {
    throw new Error(`expected cmd 3, got ${frame?.cmd ?? 'non-frame'}`);
  }
  const [len, offset] = decodeArgType1(payload, 3);
  return payload.subarray(offset, offset + len).toString('latin1');
}

function parseCmd26(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 26) {
    throw new Error(`expected cmd 26, got ${frame?.cmd ?? 'non-frame'}`);
  }

  let offset = 3;
  [, offset] = decodeArgType1(payload, offset);
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

  return { count, entries };
}

function parseCmd72MechId(payload) {
  const frame = parseGameFrame(payload);
  if (!frame || frame.cmd !== 72) {
    throw new Error(`expected cmd 72, got ${frame?.cmd ?? 'non-frame'}`);
  }

  let offset = 3;
  [, offset] = decodeShortString(payload, offset);
  offset += 1;
  offset += 1;
  offset += 1;

  [, offset] = decodeArgType2(payload, offset);

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
  [, offset] = decodeArgType1(payload, offset);

  for (let i = 0; i < 5; i += 1) {
    [, offset] = decodeShortString(payload, offset);
  }

  offset += 1;
  [, offset] = decodeArgType3(payload, offset);
  [, offset] = decodeArgType3(payload, offset);

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

  offset += 1;
  [, offset] = decodeArgType1(payload, offset);
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
  const packet = await waitForMatchingPacket(reader, candidate => {
    if (candidate.type !== Msg.SYNC) return false;
    const frame = parseGameFrame(candidate.payload);
    if (!frame || frame.cmd !== 3) return false;
    return parseCmd3Text(candidate.payload).includes(text);
  }, timeoutMs);
  return parseCmd3Text(packet.payload);
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

async function collectResultAndScene(reader, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let resultCode;
  let sawResultScene = false;

  while (Date.now() < deadline) {
    const packet = await reader.next(Math.max(1, deadline - Date.now()));
    const frame = parseGameFrame(packet.payload);
    if (!frame) continue;
    if (frame.cmd === 75) {
      resultCode = frame.payload[3] - 0x21;
      continue;
    }
    if (frame.cmd === 63 && resultCode !== undefined) {
      sawResultScene = true;
      break;
    }
  }

  assert(resultCode !== undefined, 'timed out waiting for Cmd75 result');
  assert(sawResultScene, 'timed out waiting for Cmd63 result scene');
  return resultCode;
}

async function collectLocalCombatBootstrap(reader, timeoutMs = 15000) {
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
  return parseCmd72MechId(frames[0].packet.payload);
}

const attacker = await prepareArenaSession('reconnect_restore_a');
const defender = await prepareArenaSession('reconnect_restore_b');
let replacement;

try {
  const chosenMech = await chooseMechByClass(attacker, 4, 10);

  attacker.world.socket.write(buildWorldCmd4TextPacket(`/duel ${defender.callsign}`, 20));
  await delay(250);
  defender.world.socket.write(buildWorldCmd4TextPacket('/acceptduel', 20));
  await delay(250);

  attacker.world.socket.write(buildWorldCmd5SceneActionPacket(DUEL_TERMS_ACTION_TYPE, 21));
  await waitForCmd(attacker.world.reader, 17, 5000);
  attacker.world.socket.write(buildWorldCmd15DuelTermsPacket(STAKE_CB, STAKE_CB, 22));
  await Promise.all([
    waitForCmd3Containing(attacker.world.reader, 'Duel terms updated:', 5000),
    waitForCmd3Containing(defender.world.reader, 'Duel terms updated:', 5000),
  ]);

  attacker.world.socket.write(buildWorldCmd4TextPacket('/fight', 23));
  await Promise.all([
    waitForCombatBootstrap(attacker.world.reader, 20000),
    waitForCombatBootstrap(defender.world.reader, 20000),
  ]);

  attacker.world.socket.write(buildCombatCmd12ActionPacket(0x11, 24));
  await delay(200);
  attacker.world.socket.write(buildCombatCmd12ActionPacket(0x11, 25));

  const [attackerResult, defenderResult] = await Promise.all([
    collectResultAndScene(attacker.world.reader, 20000),
    collectResultAndScene(defender.world.reader, 20000),
  ]);
  assert(attackerResult === 1, `ejecting player saw unexpected Cmd75=${attackerResult}`);
  assert(defenderResult === 0, `opponent saw unexpected Cmd75=${defenderResult}`);

  attacker.world.socket.destroy();
  await delay(500);
  replacement = await connectExistingWorldSession(attacker.username);

  const [attackerSettlement] = await Promise.all([
    waitForCmd3Containing(replacement.world.reader, 'Sanctioned settlement:', 12000),
    waitForWorldRestore(defender.world.reader, 25000),
  ]);
  assert(attackerSettlement.includes(`-${STAKE_CB} cb`), `unexpected reconnect settlement notice ${JSON.stringify(attackerSettlement)}`);

  const defenderSettlement = await waitForCmd3Containing(defender.world.reader, 'Sanctioned settlement:', 5000);
  assert(defenderSettlement.includes(`+${STAKE_CB} cb`), `unexpected defender settlement notice ${JSON.stringify(defenderSettlement)}`);

  replacement.world.socket.write(buildWorldCmd4TextPacket(`/duel ${defender.callsign}`, 30));
  await delay(250);
  defender.world.socket.write(buildWorldCmd4TextPacket('/acceptduel', 30));
  await delay(250);
  replacement.world.socket.write(buildWorldCmd4TextPacket('/fight', 31));

  const [replacementLocalMechId] = await Promise.all([
    collectLocalCombatBootstrap(replacement.world.reader, 20000),
    waitForCombatBootstrap(defender.world.reader, 20000),
  ]);
  assert(
    replacementLocalMechId === chosenMech.id,
    `reconnected pilot local mech mismatch: expected ${chosenMech.id}, got ${replacementLocalMechId}`,
  );

  console.log(
    `PASS duel-reconnect-restore-smoke mech=${chosenMech.typeString}:${chosenMech.id} settlement=${JSON.stringify(attackerSettlement)}`,
  );
} finally {
  replacement?.world.socket.destroy();
  attacker.world.socket.destroy();
  defender.world.socket.destroy();
  await delay(500);
}
