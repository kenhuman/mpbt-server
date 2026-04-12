/**
 * World server — command and event handlers.
 *
 * All gameplay event handlers: ComStar messaging, room menu actions, combat
 * bootstrap, text commands, map travel, compass navigation, and room
 * arrival/departure notifications.
 */

import {
  buildCmd3BroadcastPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd11PlayerEventPacket,
  buildCmd13PlayerArrivalPacket,
} from '../protocol/world.js';
import {
  buildCmd20Packet,
  buildCmd36MessageViewPacket,
  parseClientCmd10WeaponFire,
  parseClientCmd12Action,
  parseClientCmd8Coasting,
  parseClientCmd9Moving,
} from '../protocol/game.js';
import { buildCombatWelcomePacket }    from '../protocol/auth.js';
import {
  buildCmd62CombatStartPacket,
  buildCmd64RemoteActorPacket,
  buildCmd72LocalBootstrapPacket,
  buildCmd65PositionSyncPacket,
  buildCmd66ActorDamagePacket,
  buildCmd67LocalDamagePacket,
  buildCmd68ProjectileSpawnPacket,
  buildCmd70ActorTransitionPacket,
  buildCmd71ResetEffectStatePacket,
  COORD_BIAS,
  MOTION_DIV,
  MOTION_NEUTRAL,
} from '../protocol/combat.js';
import { PlayerRegistry, ClientSession } from '../state/players.js';
import { storeMessage } from '../db/messages.js';
import { updateCharacterMech } from '../db/characters.js';
import { Logger }        from '../util/logger.js';
import { CaptureLogger } from '../util/capture.js';
import { buildMechExamineText, MECH_STATS } from '../data/mech-stats.js';
import { mechInternalStateBytes } from '../data/mechs.js';
import {
  type CombatAttachmentHitSection,
  getCombatModelIdForMechId,
  resolveCombatAttachmentHitSection,
} from '../data/mech-attachments.js';

import {
  FALLBACK_MECH_ID,
  WORLD_MECH_BY_ID,
  WORLD_MECHS,
  DEFAULT_MAP_ROOM_ID,
  DEFAULT_SCENE_NAME,
  SOLARIS_ROOM_BY_ID,
  worldMapByRoomId,
  getSolarisRoomExits,
  getSolarisRoomName,
  setSessionRoomPosition,
  CLASS_KEYS,
  getMechChassis,
  getMechChassisListForClass,
  MECH_CLASS_LIST_ID,
  MECH_CHASSIS_LIST_ID,
  MECH_VARIANT_LIST_ID,
} from './world-data.js';
import {
  send,
  sendToWorldSession,
  nextSeq,
  getDisplayName,
  mapRoomKey,
  getPresenceStatus,
  getComstarId,
  findWorldTargetBySelectionId,
  buildComstarDeliveryText,
  sendSceneRefresh,
  sendAllRosterList,
  sendSolarisTravelMap,
  sendMechClassPicker,
  sendMechChassisPicker,
  sendMechVariantPicker,
} from './world-scene.js';
import {
  BOT_INITIAL_HEALTH,
  BOT_SPAWN_DISTANCE,
  BOT_FALLBACK_WEAPON_DAMAGE,
  JUMP_JET_ALTITUDE,
  JUMP_JET_STEP,
  JUMP_JET_TICK_MS,
  JUMP_JET_FUEL_MAX,
  JUMP_JET_FUEL_DRAIN_PER_TICK,
  JUMP_JET_FUEL_REGEN_PER_FRAME,
  JUMP_JET_FUEL_REGEN_INTERVAL_MS,
  JUMP_JET_FUEL_REGEN_PER_TICK,
  FIRE_ACTION_WINDOW_MS,
  BOT_FIRE_INTERVAL_MS,
  BOT_RETALIATION_DAMAGE,
  VERIFY_DELAY_MS,
  VERIFY_SWEEP_STEP_MS,
  VERIFY_DAMAGE_CODES,
  THROTTLE_RUN_SCALE,
} from './combat-config.js';

function regenJumpFuelIfGrounded(session: ClientSession): void {
  if (session.combatJumpTimer !== undefined) return;
  if ((session.combatJumpAltitude ?? 0) > 0) return;
  const fuel = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
  if (fuel >= JUMP_JET_FUEL_MAX) return;
  session.combatJumpFuel = Math.min(JUMP_JET_FUEL_MAX, fuel + JUMP_JET_FUEL_REGEN_PER_FRAME);
}

const DEFAULT_BOT_ARMOR_VALUES = Array<number>(10).fill(10);
const DEFAULT_BOT_INTERNAL_VALUES = Array<number>(8).fill(9);

function sumValues(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function getBotDurability(armorValues: readonly number[], internalValues: readonly number[]): number {
  return sumValues(armorValues) + sumValues(internalValues);
}

function resolveBotHitSection(
  mechId: number | undefined,
  attach: number,
  impactZ: number,
): CombatAttachmentHitSection {
  return resolveCombatAttachmentHitSection(mechId, attach, impactZ);
}

function shouldSpillUpperBodyHitToCenter(hitSection: CombatAttachmentHitSection): boolean {
  return hitSection.armorIndex === 0
    || hitSection.armorIndex === 1
    || hitSection.armorIndex === 5
    || hitSection.armorIndex === 6;
}

function isBotDestroyed(internalValues: readonly number[]): boolean {
  const centerTorsoGone = (internalValues[4] ?? 0) <= 0;
  const bothLegsGone = (internalValues[2] ?? 0) <= 0 && (internalValues[3] ?? 0) <= 0;
  return centerTorsoGone || bothLegsGone;
}

function getWeaponDamageByName(weaponName: string | undefined): number | undefined {
  switch (weaponName) {
    case 'Machine Gun': return 2;
    case 'Small Laser': return 3;
    case 'SRM-2': return 4;
    case 'Autocannon/2': return 2;
    case 'Medium Laser': return 5;
    case 'LRM-5': return 5;
    case 'Autocannon/5': return 5;
    case 'SRM-4': return 8;
    case 'Large Laser': return 8;
    case 'Autocannon/10': return 10;
    case 'Particle Projector Cannon': return 10;
    case 'LRM-10': return 10;
    case 'SRM-6': return 12;
    case 'LRM-15': return 15;
    case 'Autocannon/20': return 20;
    case 'LRM-20': return 20;
    default: return undefined;
  }
}

function getShotDamage(session: ClientSession, weaponSlot: number): { damage: number; weaponName?: string } {
  const sourceMechId = session.selectedMechId ?? FALLBACK_MECH_ID;
  const sourceMechType = WORLD_MECH_BY_ID.get(sourceMechId)?.typeString?.toUpperCase();
  const weaponName = sourceMechType !== undefined
    ? MECH_STATS.get(sourceMechType)?.armament[weaponSlot]
    : undefined;
  return {
    damage: getWeaponDamageByName(weaponName) ?? BOT_FALLBACK_WEAPON_DAMAGE,
    weaponName,
  };
}

function applyDamageToBotSection(
  armorValues: number[],
  internalValues: number[],
  hitSection: CombatAttachmentHitSection,
  damage: number,
): Array<{ damageCode: number; damageValue: number }> {
  const updates: Array<{ damageCode: number; damageValue: number }> = [];
  let remaining = Math.max(0, damage);

  if (remaining <= 0) return updates;

  const armorIndex = hitSection.armorIndex;
  const internalIndex = hitSection.internalIndex;
  const armorCurrent = armorValues[armorIndex] ?? 0;

  if (armorCurrent > 0) {
    const absorbedByArmor = Math.min(armorCurrent, remaining);
    const armorValue = armorCurrent - absorbedByArmor;
    armorValues[armorIndex] = armorValue;
    updates.push({ damageCode: 0x15 + armorIndex, damageValue: armorValue });
    remaining -= absorbedByArmor;
  }

  if (remaining > 0) {
    const internalCurrent = internalValues[internalIndex] ?? 0;
    const absorbedByInternal = Math.min(internalCurrent, remaining);
    const internalValue = internalCurrent - absorbedByInternal;
    internalValues[internalIndex] = internalValue;
    updates.push({ damageCode: 0x20 + internalIndex, damageValue: internalValue });
  }

  return updates;
}

function resolveEffectiveHitSection(
  mechId: number | undefined,
  attach: number,
  impactZ: number,
  armorValues: readonly number[],
  internalValues: readonly number[],
): CombatAttachmentHitSection {
  let hitSection = resolveBotHitSection(mechId, attach, impactZ);
  const primaryArmorCurrent = armorValues[hitSection.armorIndex] ?? 0;
  const primaryInternalCurrent = internalValues[hitSection.internalIndex] ?? 0;
  if (
    primaryArmorCurrent <= 0 &&
    primaryInternalCurrent <= 0 &&
    shouldSpillUpperBodyHitToCenter(hitSection)
  ) {
    hitSection = { armorIndex: 4, internalIndex: 4, label: 'ct-front-spill' };
  }
  return hitSection;
}

function stopBotCombatActions(session: ClientSession): void {
  if (session.botPositionTimer !== undefined) {
    clearInterval(session.botPositionTimer);
    session.botPositionTimer = undefined;
  }
  if (session.botFireTimer !== undefined) {
    clearInterval(session.botFireTimer);
    session.botFireTimer = undefined;
  }
}

function sendBotDeathTransition(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  reason: string,
): void {
  if (session.botDeathTimer !== undefined) {
    clearTimeout(session.botDeathTimer);
    session.botDeathTimer = undefined;
  }

  // Dynamic test result: subcommand 1 leaves the dead bot upright in the v1.23
  // client, so try 8 as the pre-wreck collapse trigger before the confirmed 4
  // wreck transition.
  connLog.info('[world/combat] bot destroyed — sending collapse transition (%s)', reason);
  send(
    session.socket,
    buildCmd70ActorTransitionPacket(1, 8, nextSeq(session)),
    capture,
    'CMD70_BOT_COLLAPSE',
  );

  session.botDeathTimer = setTimeout(() => {
    session.botDeathTimer = undefined;
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;
    connLog.info('[world/combat] bot wreck transition after fall (%s)', reason);
    send(
      session.socket,
      buildCmd70ActorTransitionPacket(1, 4, nextSeq(session)),
      capture,
      'CMD70_BOT_WRECK',
    );
  }, 1200);
  session.botDeathTimer.unref();
}

/**
 * Clear all repeating combat timers on a session.
 *
 * Called both from the TCP 'close' handler (cleanup on disconnect) and from
 * the `/fightrestart` handler (cleanup before re-bootstrapping in the same
 * connection).  Idempotent — safe to call multiple times.
 */
export function stopCombatTimers(session: ClientSession): void {
  stopBotCombatActions(session);
  if (session.botDeathTimer !== undefined) {
    clearTimeout(session.botDeathTimer);
    session.botDeathTimer = undefined;
  }
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }
  if (session.combatJumpFuelRegenTimer !== undefined) {
    clearInterval(session.combatJumpFuelRegenTimer);
    session.combatJumpFuelRegenTimer = undefined;
  }
}

// ── ComStar messaging ─────────────────────────────────────────────────────────

export function handleComstarTextReply(
  players: PlayerRegistry,
  session: ClientSession,
  dialogId: number,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const clean = text.replace(/\x1b/g, '?').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) {
    connLog.warn('[world] cmd-21 ComStar text ignored (empty)');
    send(
      session.socket,
      buildCmd3BroadcastPacket('ComStar message not sent: empty text.', nextSeq(session)),
      capture,
      'CMD3_COMSTAR_EMPTY',
    );
    return;
  }

  const senderName      = getDisplayName(session);
  const senderComstarId = getComstarId(session);
  const formattedBody   = buildComstarDeliveryText(senderName, clean);

  const target = findWorldTargetBySelectionId(players, dialogId);
  if (target) {
    // Recipient is online — deliver immediately.
    const targetName = getDisplayName(target);
    connLog.info(
      '[world] cmd-21 ComStar (online): from="%s" to="%s" target=%d text=%j',
      senderName, targetName, dialogId, clean,
    );
    sendToWorldSession(
      target,
      buildCmd36MessageViewPacket(senderComstarId, formattedBody, nextSeq(target)),
      'CMD36_COMSTAR_DELIVERY',
    );
    send(
      session.socket,
      buildCmd3BroadcastPacket(`ComStar sent to ${targetName}.`, nextSeq(session)),
      capture,
      'CMD3_COMSTAR_ACK',
    );
    return;
  }

  // Recipient is offline (or their session ended between roster fetch and now).
  // comstarId = 100_000 + accountId for authenticated players;
  // 900_000 + worldRosterId for anonymous sessions (cannot persist).
  const recipientAccountId =
    dialogId > 100_000 && dialogId < 900_000 ? dialogId - 100_000 : undefined;
  const senderAccountId = session.accountId;

  if (senderAccountId !== undefined && recipientAccountId !== undefined) {
    connLog.info(
      '[world] cmd-21 ComStar (offline): from=%d to account=%d text=%j — persisting',
      senderAccountId, recipientAccountId, clean,
    );
    storeMessage(senderAccountId, recipientAccountId, senderComstarId, formattedBody)
      .then(() => {
        connLog.info('[world] ComStar message stored for offline delivery (account=%d)', recipientAccountId);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd3BroadcastPacket('ComStar message queued for offline delivery.', nextSeq(session)),
            capture,
            'CMD3_COMSTAR_QUEUED',
          );
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        connLog.error('[world] failed to store offline ComStar: %s', msg);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd3BroadcastPacket('ComStar delivery failed \u2014 please try again.', nextSeq(session)),
            capture,
            'CMD3_COMSTAR_FAIL',
          );
        }
      });
  } else {
    connLog.warn(
      '[world] cmd-21 ComStar target unavailable and cannot persist: dialogId=%d senderAccId=%s',
      dialogId, senderAccountId,
    );
    send(
      session.socket,
      buildCmd3BroadcastPacket('ComStar target unavailable.', nextSeq(session)),
      capture,
      'CMD3_COMSTAR_MISSING',
    );
  }
}

// ── Room presence ─────────────────────────────────────────────────────────────

export function nextAvailableBooth(players: PlayerRegistry, roomId: string, excludeId: string): number {
  const occupied = new Set<number>();
  for (const other of players.inRoom(roomId)) {
    if (
      other.id === excludeId ||
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }

    const booth = getPresenceStatus(other) - 5;
    if (booth > 0) occupied.add(booth);
  }

  for (let booth = 1; booth <= 7; booth += 1) {
    if (!occupied.has(booth)) return booth;
  }

  return 1;
}

export function updateRoomPresenceStatus(
  players: PlayerRegistry,
  session: ClientSession,
  status: number,
  connLog: Logger,
): void {
  if (
    !session.roomId ||
    session.worldRosterId === undefined ||
    !session.worldInitialized
  ) {
    return;
  }

  if (getPresenceStatus(session) === status) {
    connLog.debug('[world] room presence unchanged: rosterId=%d status=%d', session.worldRosterId, status);
    return;
  }

  session.worldPresenceStatus = status;
  const callsign = getDisplayName(session);
  for (const other of players.inRoom(session.roomId)) {
    if (
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }
    sendToWorldSession(
      other,
      buildCmd11PlayerEventPacket(session.worldRosterId, status, callsign, nextSeq(other)),
      'CMD11_STATUS_UPDATE',
    );
  }

  connLog.info(
    '[world] room presence update: rosterId=%d status=%d callsign="%s"',
    session.worldRosterId,
    status,
    callsign,
  );
}

export function handleRoomMenuSelection(
  players: PlayerRegistry,
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection === 1) {
    connLog.info('[world] room menu: all-roster request');
    sendAllRosterList(players, session, connLog, capture);
    return;
  }

  if (selection === 0) {
    const booth = nextAvailableBooth(players, session.roomId, session.id);
    connLog.info('[world] room menu: new booth requested -> booth %d', booth);
    updateRoomPresenceStatus(players, session, 5 + booth, connLog);
    return;
  }

  if (selection === 2) {
    connLog.info('[world] room menu: stand requested');
    updateRoomPresenceStatus(players, session, 5, connLog);
    return;
  }

  const booth = selection - 2;
  if (booth < 1 || booth > 7) {
    connLog.warn('[world] room menu: unsupported booth selection=%d', selection);
    return;
  }

  connLog.info('[world] room menu: join booth %d', booth);
  updateRoomPresenceStatus(players, session, 5 + booth, connLog);
}

// ── Combat entry ──────────────────────────────────────────────────────────────

/**
 * Send the combat entry bootstrap sequence after the player types "/fight".
 *
 * Protocol order (CONFIRMED by Ghidra RE of Main_ModePacketDispatch_v123):
 *   1. MMC SYNC — raw ARIES packet; triggers client RPS→combat dispatch-table
 *      switch.  Client calls Main_SetModeName_v123(1) + Combat_InitMode_v123()
 *      (loads scenes.dat locally — no server data required for that step).
 *   2. Cmd72   — local-bootstrap game frame using combat CRC seed (0x0A5C45).
 *      Seeds scenario title, terrain, identity strings, spawn coords, and the
 *      local mech damage state.  remainingActorCount=0 → solo arena (no bots).
 *
 * Unresolved assumptions (safe defaults used):
 *   • terrainId / terrainResourceId — 1/0 chosen; live capture needed.
 *   • headingBias  — 0 (MOTION_NEUTRAL added by encoder); live capture needed.
 *   • globalA/B/C  — globalA=2800 confirmed (D²=7840000 → eq. v = speed_target); B/C = 0.
 *   • identity2/3  — populated with mech typeString and house allegiance (assumption; live capture needed).
 *   • identity4    — empty; unknown purpose.
 */
export function sendCombatBootstrapSequence(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const { socket } = session;
  const mechId   = session.selectedMechId ?? FALLBACK_MECH_ID;
  const callsign = getDisplayName(session);

  // Look up the mech's extra crit count (confirmed by RE of
  // Combat_ReadLocalActorMechState_v123 @ 0x004456c0 — the client reads
  // extraCritCount + 21 bytes from the packet, where extraCritCount comes from
  // the mech's .MEC file at offset 0x3c after decryption).
  const mechEntry       = WORLD_MECH_BY_ID.get(mechId);
  const extraCritCount  = mechEntry?.extraCritCount ?? 0;
  const critBytes       = Math.max(0, extraCritCount + 21);

  // Store per-mech speedMag caps so Cmd8/9 handlers can apply them.
  session.combatMaxSpeedMag  = mechEntry?.maxSpeedMag  ?? 0;
  session.combatWalkSpeedMag = mechEntry?.walkSpeedMag ?? 0;
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }
  if (session.combatJumpFuelRegenTimer !== undefined) {
    clearInterval(session.combatJumpFuelRegenTimer);
    session.combatJumpFuelRegenTimer = undefined;
  }
  session.combatJumpAltitude = 0;
  session.combatJumpFuel = JUMP_JET_FUEL_MAX;
  session.botHealth    = BOT_INITIAL_HEALTH;
  session.playerHealth = BOT_INITIAL_HEALTH; // simplified IS counter (stops Cmd67 when ≤ 0)

  // 1. MMC SYNC — plain ARIES packet; no game-frame CRC.
  send(socket, buildCombatWelcomePacket(), capture, 'COMBAT_WELCOME_MMC');

  // Switch phase *before* sending combat game frames so that any inbound
  // frames that arrive immediately use the correct CRC seed.
  session.phase = 'combat';

  // 2. Cmd72 — local bootstrap (combat CRC seed applied by buildGamePacket).
  const cmd72 = buildCmd72LocalBootstrapPacket(
    {
      scenarioTitle:      DEFAULT_SCENE_NAME,
      localSlot:          0,
      unknownByte0:       0,
      terrainId:          1,      // ASSUMPTION: default terrain set
      terrainResourceId:  0,      // ASSUMPTION: no additional resource
      terrainPoints:      [],
      arenaPoints:        [],
      globalA:            2800,   // D=2800 → D²=7840000; equilibrium v = speed_target (RE: FUN_0042c830)
      globalB:            0,
      globalC:            0,
      headingBias:        0,      // ASSUMPTION: 0 → MOTION_NEUTRAL after encode
      identity0:          callsign.substring(0, 11),
      identity1:          callsign.substring(0, 31),
      identity2:          mechEntry?.typeString ?? '',   // mech variant string (e.g. "SDR-5V")
      identity3:          session.allegiance   ?? '',   // house allegiance (e.g. "Davion")
      identity4:          '',     // ASSUMPTION: unknown; empty safe
      statusByte:         0,
      initialX:           0,
      initialY:           0,
      extraType2Values:   [],
      remainingActorCount: 1,     // 1 remote bot actor follows (Cmd64 below)
      unknownType1Raw:    MOTION_NEUTRAL,
      mech: {
        mechId,
        critStateExtraCount:  extraCritCount,
        criticalStateBytes:   Array<number>(critBytes).fill(0),
        extraStateBytes:      [],
        armorLikeStateBytes:  Array<number>(11).fill(0),  // full armor
        // internalStateBytes[i] must be non-zero for each IS slot index i
        // referenced by a weapon (mec[0x8e+slot*2] == i per FUN_0042c200).
        // Indices 4 and 7 are also required non-zero by the IS gate (FUN_0042bb00).
        // Order: [arm, arm, side, side, CT, leg, leg, head] (§23.8, IS lookup RE).
        internalStateBytes:   mechInternalStateBytes(mechEntry?.tonnage ?? 0),
        // Empty ammoStateValues → client uses mec file defaults; avoids the
        // "400/slot" display artefact from sending arbitrary capacity values.
        // Per-mech ammo bin data will be wired in issue #80.
        ammoStateValues:      [],  // let client use mec defaults
        actorDisplayName:     callsign.substring(0, 31),
      },
    },
    nextSeq(session),
  );

  connLog.info('[world] sending Cmd72 combat bootstrap (mech_id=%d callsign="%s" type=%s allegiance=%s)',
    mechId, callsign, mechEntry?.typeString ?? '?', session.allegiance ?? '?');
  send(socket, cmd72, capture, 'CMD72_COMBAT_BOOTSTRAP');
  session.combatStartAt = Date.now();

  // 3. Cmd64 — add remote bot actor at slot 1.
  const botMechId   = session.combatBotMechId ?? mechId;
  const botMechEntry = WORLD_MECH_BY_ID.get(botMechId);
  session.combatBotArmorValues = [...(botMechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
  session.combatBotInternalValues = botMechEntry !== undefined
    ? mechInternalStateBytes(botMechEntry.tonnage)
    : [...DEFAULT_BOT_INTERNAL_VALUES];
  session.botHealth = getBotDurability(
    session.combatBotArmorValues,
    session.combatBotInternalValues,
  );
  const cmd64 = buildCmd64RemoteActorPacket(
    {
      slot:          1,
      actorTypeByte: 0,
      identity0:     'Opponent',
      identity1:     'Opponent',
      identity2:     botMechEntry?.typeString ?? '',  // bot mech variant string
      identity3:     '',
      identity4:     '',
      statusByte:    0,
      mechId:        botMechId,
    },
    nextSeq(session),
  );
  send(socket, cmd64, capture, 'CMD64_BOT_ACTOR');
  connLog.info('[world] bot actor: mech_id=%d type=%s', botMechId, botMechEntry?.typeString ?? '?');

  // 4. Cmd65 — initial position for the local actor (slot 0) at the origin.
  //    Gives the client something to render immediately after bootstrap.
  //    facing/throttle/legVel/speedMag = 0 (stationary, no heading).
  const cmd65 = buildCmd65PositionSyncPacket(
    { slot: 0, x: 0, y: 0, z: 0, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
    nextSeq(session),
  );
  send(socket, cmd65, capture, 'CMD65_INITIAL_POSITION');

  // 5. Cmd65 — initial position for the bot (slot 1), BOT_SPAWN_DISTANCE units
  //    out to the north on the
  //    arena floor. In the live protocol path here, x/y are the horizontal
  //    world coordinates and z is altitude; putting the distance into z leaves the
  //    actor effectively airborne/off-scene and breaks visibility/targeting.
  const cmd65Bot = buildCmd65PositionSyncPacket(
    { slot: 1, x: 0, y: BOT_SPAWN_DISTANCE, z: 0, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
    nextSeq(session),
  );
  send(socket, cmd65Bot, capture, 'CMD65_BOT_POSITION');

  // 6. Cmd62 — "all actors ready" / combat-start signal.
  //    Clears DAT_0047ef60 bit 0x20, which blocks SPACEBAR weapon fire.
  //    Must be sent after all Cmd64/Cmd65 packets.
  const cmd62 = buildCmd62CombatStartPacket(nextSeq(session));
  send(socket, cmd62, capture, 'CMD62_COMBAT_START');

  // Keep bot stationary by re-sending its position every second.
  session.botPositionTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable) return;
    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        { slot: 1, x: 0, y: BOT_SPAWN_DISTANCE, z: 0, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
        nextSeq(session),
      ),
      capture, 'CMD65_BOT_POSITION',
    );
  }, 1000);
  session.botPositionTimer.unref();

  // Passive jump fuel regeneration while grounded/idle.
  session.combatJumpFuelRegenTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable) return;
    const before = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
    regenJumpFuelIfGrounded(session);
    const after = session.combatJumpFuel ?? before;
    if (after !== before) {
      connLog.debug('[world/combat] jump fuel regen: %d -> %d', before, after);
    }
  }, JUMP_JET_FUEL_REGEN_INTERVAL_MS);
  session.combatJumpFuelRegenTimer.unref();

  // Bot fires back at the player every BOT_FIRE_INTERVAL_MS milliseconds.
  // Stops once server-side playerHealth estimate reaches 0 (client handles
  // the actual death/results screen via local IS simulation — see §23.6).
  session.botFireTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable) return;

    // Server-side health gate — stop retaliating after estimated player death.
    if ((session.playerHealth ?? 0) <= 0) {
      clearInterval(session.botFireTimer);
      session.botFireTimer = undefined;
      connLog.info('[world/combat] player IS depleted (server-side estimate) — bot stopped firing');
      return;
    }

    session.playerHealth = Math.max(0, (session.playerHealth ?? 0) - BOT_RETALIATION_DAMAGE);
    connLog.debug(
      '[world/combat] bot fires Cmd67: damage=%d playerHealth=%d',
      BOT_RETALIATION_DAMAGE,
      session.playerHealth,
    );
    send(
      session.socket,
      buildCmd67LocalDamagePacket(1, BOT_RETALIATION_DAMAGE, nextSeq(session)),
      capture, 'CMD67_BOT_RETALIATION',
    );
  }, BOT_FIRE_INTERVAL_MS);
  session.botFireTimer.unref();

  const verificationMode = session.combatVerificationMode;
  session.combatVerificationMode = undefined;
  session.combatShotsAccepted = 0;
  session.combatShotsAction0Correlated = 0;
  session.combatShotsDirectCmd10 = 0;
  if (verificationMode === 'autowin') {
    setTimeout(() => {
      if (session.socket.destroyed || !session.socket.writable) return;
      connLog.info('[world/combat] scripted verification: autowin');
      session.botHealth = 0;
      send(
        session.socket,
        buildCmd66ActorDamagePacket(1, 1, 999, nextSeq(session)),
        capture,
        'CMD66_VERIFY_AUTOWIN',
      );
      stopBotCombatActions(session);
      sendBotDeathTransition(session, connLog, capture, 'verify-autowin');
    }, VERIFY_DELAY_MS).unref();
  } else if (verificationMode === 'autolose') {
    setTimeout(() => {
      if (session.socket.destroyed || !session.socket.writable) return;
      connLog.info('[world/combat] scripted verification: autolose');
      session.playerHealth = 0;
      send(
        session.socket,
        buildCmd67LocalDamagePacket(1, 999, nextSeq(session)),
        capture,
        'CMD67_VERIFY_AUTOLOSE',
      );
      if (session.botFireTimer !== undefined) {
        clearInterval(session.botFireTimer);
        session.botFireTimer = undefined;
      }
    }, VERIFY_DELAY_MS).unref();
  } else if (verificationMode === 'dmglocal' || verificationMode === 'dmgbot') {
    const sendSweep = (): void => {
      if (session.socket.destroyed || !session.socket.writable) return;
      connLog.info('[world/combat] scripted verification: %s sweep', verificationMode);

      VERIFY_DAMAGE_CODES.forEach((code, idx) => {
        setTimeout(() => {
          if (session.socket.destroyed || !session.socket.writable) return;
          if (verificationMode === 'dmglocal') {
            send(
              session.socket,
              buildCmd67LocalDamagePacket(code, 5, nextSeq(session)),
              capture,
              `CMD67_VERIFY_SWEEP_${code}`,
            );
          } else {
            send(
              session.socket,
              buildCmd66ActorDamagePacket(1, code, 5, nextSeq(session)),
              capture,
              `CMD66_VERIFY_SWEEP_${code}`,
            );
          }
        }, idx * VERIFY_SWEEP_STEP_MS).unref();
      });
    };

    setTimeout(sendSweep, VERIFY_DELAY_MS).unref();
  } else if (verificationMode === 'strictfire') {
    setTimeout(() => {
      if (session.socket.destroyed || !session.socket.writable) return;
      connLog.info('[world/combat] scripted verification: strictfire observation mode (cmd12/action0 correlations logged; direct TIC cmd10 accepted)');
    }, VERIFY_DELAY_MS).unref();
  }

  session.combatInitialized = true;
  connLog.info('[world] combat entry complete for "%s"', callsign);
}

// ── Text commands ─────────────────────────────────────────────────────────────

export function handleWorldTextCommand(
  players: PlayerRegistry,
  session: ClientSession,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const clean = text.replace(/\x1b/g, '?').trim();
  if (clean.length === 0) {
    connLog.debug('[world] cmd-4 text ignored (empty)');
    return;
  }

  if (clean.toLowerCase() === '/map' || clean.toLowerCase() === '/travel') {
    sendSolarisTravelMap(session, connLog, capture);
    return;
  }

  if (clean.toLowerCase() === '/mechbay' || clean.toLowerCase() === '/mechs') {
    sendMechClassPicker(session, connLog, capture);
    return;
  }

  // /icons [start] — send a fake scene with 4 exit slots showing icons N, N+1,
  // N+2, N+3.  Used to empirically map icon IDs to their displayed graphics.
  const iconsMatch = clean.match(/^\/icons(?:\s+(\d+))?$/i);
  if (iconsMatch) {
    const base = parseInt(iconsMatch[1] ?? '0', 10);
    connLog.info('[world] /icons test: base=%d', base);
    send(
      session.socket,
      buildCmd4SceneInitPacket(
        {
          sessionFlags:    0x30 | 0x0F,  // all 4 slots enabled
          playerScoreSlot: 0,
          playerMechId:    base,
          opponents: [
            { type: 0, mechId: base },
            { type: 0, mechId: base + 1 },
            { type: 0, mechId: base + 2 },
            { type: 0, mechId: base + 3 },
          ],
          callsign:  getDisplayName(session),
          sceneName: `Icons ${base}–${base + 3}`,
          arenaOptions: [
            { type: 0, label: 'Help' },
            { type: 4, label: 'Travel' },
          ],
        },
        nextSeq(session),
      ),
      capture,
      'CMD4_ICONS_TEST',
    );
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        `N=${base} S=${base+1} E=${base+2} W=${base+3}  (center=${base})  Type /icons ${base+4} for next batch.`,
        nextSeq(session),
      ),
      capture,
      'CMD3_ICONS_LABEL',
    );
    return;
  }

  const line = `${getDisplayName(session)}: ${clean}`;
  connLog.info('[world] cmd-4 text: %s', line);

  // /botmech <id> — choose the mech ID for the scripted bot opponent.
  // The ID is a numeric mech variant ID from the loaded mech list.  Persists
  // across /fightrestart within the same connection.
  const botmechMatch = clean.match(/^\/botmech\s+(\d+)$/i);
  if (botmechMatch) {
    const requestedId = parseInt(botmechMatch[1], 10);
    const mechEntry   = WORLD_MECH_BY_ID.get(requestedId);
    if (!mechEntry) {
      connLog.warn('[world] /botmech: unknown mech_id=%d', requestedId);
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          `Unknown mech_id ${requestedId}. Use /mechs to browse available mechs.`,
          nextSeq(session),
        ),
        capture,
        'CMD3_BOTMECH_UNKNOWN',
      );
    } else {
      session.combatBotMechId = requestedId;
      connLog.info('[world] /botmech: bot mech set to %s (id=%d)', mechEntry.typeString, requestedId);
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          `Bot mech set to ${mechEntry.typeString} (id=${requestedId}). Use /fight or /fightrestart.`,
          nextSeq(session),
        ),
        capture,
        'CMD3_BOTMECH_ACK',
      );
    }
    return;
  }

  const senderStatus  = getPresenceStatus(session);
  const senderInBooth = senderStatus > 5;

  for (const other of players.inRoom(session.roomId)) {
    if (
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }

    // Booth privacy: booth chat is only heard by occupants of the same booth;
    // standing chat is only heard by other standing players.
    const otherStatus = getPresenceStatus(other);
    if (senderInBooth ? otherStatus !== senderStatus : otherStatus > 5) {
      continue;
    }

    sendToWorldSession(other, buildCmd3BroadcastPacket(line, nextSeq(other)), 'CMD3_CHAT_FANOUT');
  }
}

// ── Map travel ────────────────────────────────────────────────────────────────

export function handleMapTravelReply(
  players: PlayerRegistry,
  session: ClientSession,
  contextId: number,
  selection: number,
  selectedRoomId: number | undefined,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection === 0) {
    connLog.info('[world] cmd-10 map reply: context=%d cancel', contextId);
    return;
  }

  if (selectedRoomId === undefined) {
    connLog.warn('[world] cmd-10 map reply missing selected room: context=%d selection=%d', contextId, selection);
    return;
  }

  if (!SOLARIS_ROOM_BY_ID.has(selectedRoomId)) {
    connLog.warn('[world] cmd-10 map reply unknown selectedRoomId=%d', selectedRoomId);
    return;
  }

  const oldRoomId = session.roomId;
  const newRoomId = mapRoomKey(selectedRoomId);
  connLog.info(
    '[world] cmd-10 map reply: context=%d selection=%d selectedRoomId=%d',
    contextId,
    selection,
    selectedRoomId,
  );

  if (oldRoomId === newRoomId) {
    send(
      session.socket,
      buildCmd3BroadcastPacket(`Already at room ${selectedRoomId}.`, nextSeq(session)),
      capture,
      'CMD3_TRAVEL_ALREADY_THERE',
    );
    return;
  }

  notifyRoomDeparture(players, session, connLog);
  session.roomId = newRoomId;
  setSessionRoomPosition(session, selectedRoomId);
  session.worldPresenceStatus = 5;

  sendSceneRefresh(
    players,
    session,
    connLog,
    capture,
    `Travel complete: ${getSolarisRoomName(selectedRoomId)}.`,
  );
  notifyRoomArrival(players, session, connLog);
}

export function handleLocationAction(
  players: PlayerRegistry,
  session: ClientSession,
  slot: number,
  targetCached: boolean,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;

  // Resolve exit by compass slot (0=N 1=S 2=E 3=W).  Must use slotted exits
  // (nulls preserved) so slot indices match the buttons sent to the client.
  // getSolarisRoomExits() returns a compact filtered array — do NOT use it here.
  const mapRoom = worldMapByRoomId.get(currentRoomId);
  let targetRoomId: number | undefined;
  if (mapRoom) {
    const slotted: (number | null)[] = [
      mapRoom.exits.north, mapRoom.exits.south, mapRoom.exits.east, mapRoom.exits.west,
    ];
    targetRoomId = slotted[slot] ?? undefined;
  } else {
    // Fallback linear topology densely fills all slots, so compact is fine.
    targetRoomId = getSolarisRoomExits(currentRoomId)[slot];
  }

  if (targetRoomId === undefined) {
    connLog.warn('[world] cmd-23 location action has no exit: room=%d slot=%d cached=%s', currentRoomId, slot, targetCached);
    send(
      session.socket,
      buildCmd3BroadcastPacket('There is no exit in that direction.', nextSeq(session)),
      capture,
      'CMD3_LOCATION_NO_EXIT',
    );
    return;
  }

  connLog.info(
    '[world] cmd-23 location action: room=%d slot=%d cached=%s -> room=%d',
    currentRoomId,
    slot,
    targetCached,
    targetRoomId,
  );

  notifyRoomDeparture(players, session, connLog);
  session.roomId = mapRoomKey(targetRoomId);
  setSessionRoomPosition(session, targetRoomId);
  session.worldPresenceStatus = 5;
  sendSceneRefresh(
    players,
    session,
    connLog,
    capture,
    `Arrived at ${getSolarisRoomName(targetRoomId)}.`,
  );
  notifyRoomArrival(players, session, connLog);
}

// ── Room arrival / departure notifications ────────────────────────────────────

export function notifyRoomArrival(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): void {
  if (!session.roomId || session.worldRosterId === undefined) return;
  const callsign = getDisplayName(session);
  for (const other of players.inRoom(session.roomId)) {
    if (
      other.id === session.id ||
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }
    sendToWorldSession(
      other,
      buildCmd13PlayerArrivalPacket(session.worldRosterId, callsign, nextSeq(other)),
      'CMD13_ARRIVAL',
    );
  }
  connLog.info('[world] notified room of arrival: rosterId=%d callsign="%s"', session.worldRosterId, callsign);
}

export function notifyRoomDeparture(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): void {
  if (!session.roomId || session.worldRosterId === undefined) return;
  const callsign = getDisplayName(session);
  for (const other of players.inRoom(session.roomId)) {
    if (
      other.id === session.id ||
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }
    sendToWorldSession(
      other,
      buildCmd11PlayerEventPacket(session.worldRosterId, 0, callsign, nextSeq(other)),
      'CMD11_DEPARTURE',
    );
  }
  connLog.info('[world] notified room of departure: rosterId=%d callsign="%s"', session.worldRosterId, callsign);
}

// ── Combat movement / action frames ───────────────────────────────────────────

export function handleCombatMovementFrame(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const cmd = payload[2] - 0x21;

  if (cmd === 8) {
    const frame = parseClientCmd8Coasting(payload);
    if (!frame) return;
    regenJumpFuelIfGrounded(session);
    session.combatX          = frame.xRaw - COORD_BIAS;
    session.combatY          = frame.yRaw - COORD_BIAS;
    session.combatHeadingRaw = frame.headingRaw;

    const clientSpeed       = frame.rotationRaw - MOTION_NEUTRAL;

    if (clientSpeed !== 0) {
      connLog.debug(
        '[world/combat] cmd8 coasting: x=%d y=%d heading=%d clientSpeed=%d -> no echo (trust local key events)',
        session.combatX, session.combatY, frame.headingRaw, clientSpeed,
      );
      return;
    }

    // clientSpeed === 0 → mech has fully stopped; reset so the next KP8 press
    // is treated as a fresh startup (breaks the trap correctly).
    session.combatSpeedMag  = 0;
    connLog.debug(
      '[world/combat] cmd8 coasting: x=%d y=%d heading=%d clientSpeed=0 suppressing echo (stopped)',
      session.combatX, session.combatY, frame.headingRaw,
    );
    return;
  }

  if (cmd === 9) {
    const frame = parseClientCmd9Moving(payload);
    if (!frame) return;
    regenJumpFuelIfGrounded(session);
    session.combatX          = frame.xRaw - COORD_BIAS;
    session.combatY          = frame.yRaw - COORD_BIAS;
    session.combatHeadingRaw = frame.headingRaw;

    const maxSpeedMag    = session.combatMaxSpeedMag ?? 0;
    const throttlePct    = frame.throttleRaw - MOTION_NEUTRAL; // negative = forward
    const legVelPct      = frame.legVelRaw   - MOTION_NEUTRAL;

    // Scale sVar2 (max=45 from KP8, Ghidra-confirmed) to maxSpeedMag so full-throttle
    // input produces run speed rather than capping at walk speed.
    const nextSpeedMag = maxSpeedMag > 0
      ? Math.max(-maxSpeedMag, Math.min(maxSpeedMag, Math.round(-throttlePct * maxSpeedMag / THROTTLE_RUN_SCALE)))
      : 0;

    // iVar5 from FUN_0042c7a0: actual physics speed (+ve=forward, -ve=reverse).
    const clientSpeed = frame.rotationRaw - MOTION_NEUTRAL;

    // throttle: preserve DAT_004f1f7c as-is (no sign flip).
    // Ghidra: encodeThrottle(V) → client reads back V; -throttle was wrong and
    // caused DAT_004f1f7c oscillation limiting top speed to walk (~21 kph).
    const throttle = throttlePct * MOTION_DIV;
    const legVel   = legVelPct   * MOTION_DIV;
    session.combatThrottle = throttle;
    session.combatLegVel   = legVel;
    session.combatSpeedMag = clientSpeed;

    connLog.debug(
      '[world/combat] cmd9 moving: throttlePct=%d legVelPct=%d clientSpeed=%d throttle=%d legVel=%d maxSpeedMag=%d nextSpeedMag=%d',
      throttlePct, legVelPct, clientSpeed, throttle, legVel, maxSpeedMag, nextSpeedMag,
    );

    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        {
          slot:     0,
          x:        session.combatX,
          y:        session.combatY,
          z:        session.combatJumpAltitude ?? 0,
          facing:   (frame.headingRaw - MOTION_NEUTRAL) * MOTION_DIV,
          throttle,
          legVel,
          speedMag: clientSpeed,
        },
        nextSeq(session),
      ),
      capture,
      'CMD65_MOVEMENT',
    );
  }
}

export function handleCombatWeaponFireFrame(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const shots = parseClientCmd10WeaponFire(payload);
  if (!shots || shots.length === 0) {
    connLog.warn('[world/combat] cmd-10 weapon fire parse failed (len=%d)', payload.length);
    return;
  }

  const now = Date.now();
  const actionAgeMs = session.lastCombatFireActionAt === undefined
    ? undefined
    : now - session.lastCombatFireActionAt;
  const hasRecentFireAction = actionAgeMs !== undefined && actionAgeMs >= 0 && actionAgeMs <= FIRE_ACTION_WINDOW_MS;
  const firePath = hasRecentFireAction ? 'selected-weapon' : 'direct-cmd10';
  session.combatShotsAccepted = (session.combatShotsAccepted ?? 0) + shots.length;
  if (hasRecentFireAction) {
    session.combatShotsAction0Correlated = (session.combatShotsAction0Correlated ?? 0) + shots.length;
    connLog.debug(
      '[world/combat] cmd10 %s path: correlated with cmd12/action0 (age=%dms records=%d)',
      firePath,
      actionAgeMs,
      shots.length,
    );
    session.lastCombatFireActionAt = undefined;
  } else {
    session.combatShotsDirectCmd10 = (session.combatShotsDirectCmd10 ?? 0) + shots.length;
    connLog.debug(
      '[world/combat] cmd10 %s path: no recent cmd12/action0 (age=%s records=%d) — compatible with TIC fire geometry',
      firePath,
      actionAgeMs === undefined ? 'n/a' : `${actionAgeMs}ms`,
      shots.length,
    );
  }

  if (session.botHealth === undefined) {
    session.botHealth = getBotDurability(
      session.combatBotArmorValues ?? DEFAULT_BOT_ARMOR_VALUES,
      session.combatBotInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES,
    );
  }
  if (session.botHealth <= 0) {
    connLog.debug('[world/combat] cmd-10 shot ignored — bot already destroyed');
    return;
  }

  const botArmorValues = [...(session.combatBotArmorValues ?? DEFAULT_BOT_ARMOR_VALUES)];
  const botInternalValues = [...(session.combatBotInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES)];
  const botMechId = session.combatBotMechId ?? session.selectedMechId;
  const botModelId = getCombatModelIdForMechId(botMechId);
  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_RESET');
  const shotSummaries: string[] = [];
  let totalDamageUpdates = 0;

  for (const shot of shots) {
    const { damage: shotDamage, weaponName } = getShotDamage(session, shot.weaponSlot);
    const hitSection = resolveEffectiveHitSection(
      botMechId,
      shot.targetAttach,
      shot.impactZ,
      botArmorValues,
      botInternalValues,
    );
    const damageUpdates = applyDamageToBotSection(
      botArmorValues,
      botInternalValues,
      hitSection,
      shotDamage,
    );

    send(
      session.socket,
      buildCmd68ProjectileSpawnPacket(
        {
          sourceSlot:   0,
          weaponSlot:   shot.weaponSlot,
          targetRaw:    shot.targetSlot < 0 ? 0 : shot.targetSlot + 1,
          targetAttach: shot.targetAttach < 0 ? 0 : shot.targetAttach + 1,
          angleSeedA:   shot.angleSeedA,
          angleSeedB:   shot.angleSeedB,
          impactX:      shot.impactXRaw - COORD_BIAS,
          impactY:      shot.impactYRaw - COORD_BIAS,
          impactZ:      shot.impactZ,
        },
        nextSeq(session),
      ),
      capture,
      'CMD68_PROJECTILE',
    );
    for (const update of damageUpdates) {
      send(
        session.socket,
        buildCmd66ActorDamagePacket(1, update.damageCode, update.damageValue, nextSeq(session)),
        capture,
        'CMD66_BOT_DAMAGE',
      );
    }

    totalDamageUpdates += damageUpdates.length;
    shotSummaries.push(
      `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:${hitSection.label}:${shot.targetSlot}/${shot.targetAttach}`,
    );
  }

  session.combatBotArmorValues = botArmorValues;
  session.combatBotInternalValues = botInternalValues;
  session.botHealth = getBotDurability(botArmorValues, botInternalValues);
  connLog.info(
    '[world/combat] cmd10 weapon fire accepted: firePath=%s records=%d weaponSlots=%s botMechId=%s botModelId=%s botHealth=%d updates=%d shots=[%s]',
    firePath,
    shots.length,
    shots.map(shot => shot.weaponSlot).join('/'),
    botMechId ?? 'n/a',
    botModelId ?? 'n/a',
    session.botHealth,
    totalDamageUpdates,
    shotSummaries.join(','),
  );
  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_CLOSE');

  if (isBotDestroyed(botInternalValues)) {
    session.botHealth = 0;
    stopBotCombatActions(session);
    sendBotDeathTransition(session, connLog, capture, 'fatal-damage');
  }
}

export function handleCombatActionFrame(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const action = parseClientCmd12Action(payload);
  if (!action) {
    connLog.warn('[world/combat] cmd-12 action parse failed (len=%d)', payload.length);
    return;
  }

  if (action.action === 0) {
    session.lastCombatFireActionAt = Date.now();
    connLog.debug('[world/combat] cmd-12 action=0 (selected-weapon fire trigger)');
    // Keep the local effects state fresh before a possible selected-weapon cmd10.
    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_FIRE_GATE');
    return;
  }

  if (action.action >= 0x16 && action.action <= 0x1f) {
    connLog.debug('[world/combat] cmd-12 select weapon slot=%d (client-local HUD state)', action.action - 0x16);
    return;
  }

  if (action.action === 0x20 || action.action === 0x21) {
    connLog.debug('[world/combat] cmd-12 cycle weapon slot action=0x%s (client-local HUD state)', action.action.toString(16));
    return;
  }

  if (action.action >= 0x23 && action.action <= 0x25) {
    connLog.debug('[world/combat] cmd-12 toggle selected weapon into TIC=%d (client-local HUD state)', action.action - 0x23);
    return;
  }

  if (action.action >= 0xb1 && action.action <= 0xce) {
    const zeroBased = action.action - 0xb1;
    const weaponSlot = Math.floor(zeroBased / 3);
    const ticIndex = zeroBased % 3;
    connLog.debug(
      '[world/combat] cmd-12 HUD TIC toggle weapon slot=%d TIC=%d (client-local HUD state)',
      weaponSlot,
      ticIndex,
    );
    return;
  }

  if (action.action === 4) {
    const fuel = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
    if (fuel <= 0) {
      connLog.info('[world/combat] cmd-12 jump action=4 ignored (fuel depleted)');
      return;
    }

    if (session.combatJumpTimer !== undefined) {
      clearInterval(session.combatJumpTimer);
      session.combatJumpTimer = undefined;
    }

    let jumpDirection = 1;
    session.combatJumpAltitude = Math.max(0, session.combatJumpAltitude ?? 0);

    const sendJumpUpdate = (tag: string): void => {
      const x = session.combatX ?? 0;
      const y = session.combatY ?? 0;
      const headingRaw = session.combatHeadingRaw ?? MOTION_NEUTRAL;
      const throttle = session.combatThrottle ?? 0;
      const legVel = session.combatLegVel ?? 0;
      const speedMag = session.combatSpeedMag ?? 0;
      send(
        session.socket,
        buildCmd65PositionSyncPacket(
          {
            slot:     0,
            x,
            y,
            z:        session.combatJumpAltitude ?? 0,
            facing:   (headingRaw - MOTION_NEUTRAL) * MOTION_DIV,
            throttle,
            legVel,
            speedMag,
          },
          nextSeq(session),
        ),
        capture,
        tag,
      );
    };

    // Emit the first ascent step immediately so jump feedback is visible without delay.
    session.combatJumpAltitude = Math.min(JUMP_JET_ALTITUDE, (session.combatJumpAltitude ?? 0) + JUMP_JET_STEP);
    session.combatJumpFuel = Math.max(0, fuel - JUMP_JET_FUEL_DRAIN_PER_TICK);
    connLog.info(
      '[world/combat] cmd-12 jump action=4 altitude=%d fuel=%d (ascent start)',
      session.combatJumpAltitude,
      session.combatJumpFuel,
    );
    sendJumpUpdate('CMD65_JUMP_ASCENT');

    session.combatJumpTimer = setInterval(() => {
      if (session.socket.destroyed || !session.socket.writable) return;

      const currentFuel = session.combatJumpFuel ?? 0;
      if (currentFuel <= 0) {
        jumpDirection = -1;
      }

      const currentAltitude = session.combatJumpAltitude ?? 0;
      if (jumpDirection > 0) {
        const nextAltitude = Math.min(JUMP_JET_ALTITUDE, currentAltitude + JUMP_JET_STEP);
        session.combatJumpAltitude = nextAltitude;
        session.combatJumpFuel = Math.max(0, currentFuel - JUMP_JET_FUEL_DRAIN_PER_TICK);
        sendJumpUpdate('CMD65_JUMP_ASCENT');
        if (nextAltitude >= JUMP_JET_ALTITUDE) {
          jumpDirection = -1;
        }
        return;
      }

      const nextAltitude = Math.max(0, currentAltitude - JUMP_JET_STEP);
      session.combatJumpAltitude = nextAltitude;
      session.combatJumpFuel = Math.max(0, currentFuel - JUMP_JET_FUEL_DRAIN_PER_TICK);
      sendJumpUpdate('CMD65_JUMP_DESCENT');
      if (nextAltitude <= 0) {
        clearInterval(session.combatJumpTimer);
        session.combatJumpTimer = undefined;
        connLog.info('[world/combat] jump arc complete (fuel=%d)', session.combatJumpFuel ?? 0);
      }
    }, JUMP_JET_TICK_MS);
    session.combatJumpTimer.unref();
    return;
  }

  if (action.action === 6) {
    if (session.combatJumpTimer !== undefined) {
      clearInterval(session.combatJumpTimer);
      session.combatJumpTimer = undefined;
    }
    session.combatJumpAltitude = 0;

    const x = session.combatX ?? 0;
    const y = session.combatY ?? 0;
    const headingRaw = session.combatHeadingRaw ?? MOTION_NEUTRAL;
    const throttle = session.combatThrottle ?? 0;
    const legVel = session.combatLegVel ?? 0;
    const speedMag = session.combatSpeedMag ?? 0;

    connLog.info('[world/combat] cmd-12 jump action=6 altitude=0 (forced land)');
    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        {
          slot:     0,
          x,
          y,
          z:        0,
          facing:   (headingRaw - MOTION_NEUTRAL) * MOTION_DIV,
          throttle,
          legVel,
          speedMag,
        },
        nextSeq(session),
      ),
      capture,
      'CMD65_JUMP_LAND',
    );
    return;
  }

  // Ghidra confirmed: action 0x34 (THROTTLE_UP) calls FUN_004229a0 locally
  // but does NOT call Combat_SendCmd12Action_v123 — so these packets never
  // arrive from the client.  Speed is driven entirely by the Cmd9
  // throttleRaw → THROTTLE_RUN_SCALE path; no server response is needed here.
  connLog.debug('[world/combat] cmd-12 combat action=%d — no response', action.action);
}

// ── 3-step mech picker — Cmd7 routing ─────────────────────────────────────────

export function handleMechPickerCmd7(
  players: PlayerRegistry,
  session: ClientSession,
  listId: number,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const step = session.mechPickerStep;

  if (step === 'class' && listId === MECH_CLASS_LIST_ID) {
    if (selection === 0) {
      session.mechPickerStep = undefined;
      return true;
    }
    const classIndex = selection - 1;
    if (classIndex < 0 || classIndex >= CLASS_KEYS.length) return true;
    sendMechChassisPicker(session, classIndex, connLog, capture);
    return true;
  }

  if (step === 'chassis' && listId === MECH_CHASSIS_LIST_ID) {
    if (selection === 0) {
      sendMechClassPicker(session, connLog, capture);
      return true;
    }
    const classIndex  = session.mechPickerClass ?? 0;
    const chassisList = getMechChassisListForClass(classIndex);
    const visible     = chassisList.slice(0, 20);
    const chassis = visible[selection - 1];
    if (!chassis) {
      sendMechClassPicker(session, connLog, capture);
      return true;
    }
    sendMechVariantPicker(session, chassis, connLog, capture);
    return true;
  }

  if (step === 'variant' && listId === MECH_VARIANT_LIST_ID) {
    if (selection === 0) {
      sendMechChassisPicker(session, session.mechPickerClass ?? 0, connLog, capture, session.mechPickerChassisPage ?? 0);
      return true;
    }
    const chassis = session.mechPickerChassis ?? '';
    const variants = WORLD_MECHS.filter(mech => getMechChassis(mech.typeString) === chassis);
    const chosen = variants[selection - 1];
    if (!chosen) {
      send(
        session.socket,
        buildCmd3BroadcastPacket('Mech selection invalid. Please try again.', nextSeq(session)),
        capture,
        'CMD3_MECH_SELECT_ERR',
      );
      sendMechClassPicker(session, connLog, capture);
      return true;
    }

    session.selectedMechSlot       = chosen.slot;
    session.selectedMechId         = chosen.id;
    session.mechPickerStep         = undefined;
    session.mechPickerClass        = undefined;
    session.mechPickerChassis      = undefined;
    session.mechPickerChassisPage  = undefined;

    connLog.info('[world] mech selected: callsign="%s" slot=%d id=%d typeString=%s',
      getDisplayName(session), chosen.slot, chosen.id, chosen.typeString);
    if (session.accountId !== undefined) {
      void updateCharacterMech(session.accountId, chosen.id, chosen.slot)
        .then(() => {
          connLog.info(
            '[world] persisted mech selection: accountId=%d slot=%d id=%d typeString=%s',
            session.accountId, chosen.slot, chosen.id, chosen.typeString,
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error(
            '[world] failed to persist mech selection: accountId=%d slot=%d id=%d err=%s',
            session.accountId, chosen.slot, chosen.id, msg,
          );
        });
    } else {
      connLog.warn('[world] mech selection not persisted: no accountId on session');
    }
    send(
      session.socket,
      buildCmd3BroadcastPacket(`Mech selected: ${chosen.typeString}`, nextSeq(session)),
      capture,
      'CMD3_MECH_SELECTED',
    );
    send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
    return true;
  }

  return false;
}

export function handleMechPickerCmd20(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const step = session.mechPickerStep;
  const dialogId = 5;

  if (!step) return false;

  if (step !== 'variant') {
    connLog.info('[world] cmd-20 examine ignored during mech picker step=%s selection=%d', step, selection);
    send(
      session.socket,
      buildCmd20Packet(dialogId, 2, 'Select a mech variant to examine its loadout.', nextSeq(session)),
      capture,
      'CMD20_MECH_PICKER_HINT',
    );
    return true;
  }

  const chassis = session.mechPickerChassis ?? '';
  const variants = WORLD_MECHS.filter(mech => getMechChassis(mech.typeString) === chassis);
  const slot = Math.min(variants.length - 1, Math.max(0, selection));
  const chosen = variants[slot];
  if (!chosen) {
    connLog.warn('[world] cmd-20 examine invalid variant selection=%d chassis=%s', selection, chassis);
    send(
      session.socket,
      buildCmd20Packet(dialogId, 2, 'Select a mech variant to examine its loadout.', nextSeq(session)),
      capture,
      'CMD20_MECH_PICKER_HINT',
    );
    return true;
  }

  const examineText = buildMechExamineText(chosen.typeString);
  connLog.info('[world] cmd-20 mech picker examine: slot=%d mech_id=%d (%s) → %j',
    slot, chosen.id, chosen.typeString, examineText);
  send(
    session.socket,
    buildCmd20Packet(dialogId, 2, examineText, nextSeq(session)),
    capture,
    'CMD20_STATS',
  );
  return true;
}
