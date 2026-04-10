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
  buildCmd36MessageViewPacket,
  parseClientCmd10WeaponFire,
  parseClientCmd12Action,
  parseClientCmd8Coasting,
  parseClientCmd9Moving,
} from '../protocol/game.js';
import { MECH_STATS } from '../data/mech-stats.js';
import { buildCombatWelcomePacket }    from '../protocol/auth.js';
import {
  buildCmd62CombatStartPacket,
  buildCmd64RemoteActorPacket,
  buildCmd72LocalBootstrapPacket,
  buildCmd65PositionSyncPacket,
  buildCmd66ActorDamagePacket,
  buildCmd68ProjectileSpawnPacket,
  buildCmd70ActorTransitionPacket,
  buildCmd71ResetEffectStatePacket,
  COORD_BIAS,
  MOTION_DIV,
  MOTION_NEUTRAL,
} from '../protocol/combat.js';
import { PlayerRegistry, ClientSession } from '../state/players.js';
import { storeMessage } from '../db/messages.js';
import { Logger }        from '../util/logger.js';
import { CaptureLogger } from '../util/capture.js';

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
  MECH_CLASS_LIST_ID,
  MECH_CHASSIS_LIST_ID,
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

/** Server-side HP counter for the scripted single-client bot opponent. */
const BOT_INITIAL_HEALTH = 100;
/** Prototype damage applied to the scripted bot for each cmd10 fire frame. */
const BOT_DAMAGE_PER_HIT = 20;

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
 *   • identity2..4 — empty; purpose in client UI unconfirmed.
 *   • headingBias  — 0 (MOTION_NEUTRAL added by encoder); live capture needed.
 *   • globalA/B/C  — 0; purpose unlabelled in Ghidra.
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

  // Store per-mech speedMag cap so Cmd8/9 handlers can apply it.
  session.combatMaxSpeedMag = mechEntry?.maxSpeedMag ?? 0;
  session.botHealth = BOT_INITIAL_HEALTH;

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
      globalA:            3612,   // avoids div-by-zero in Cmd65 handler (RE: checkpoint 019-021)
      globalB:            0,
      globalC:            0,
      headingBias:        0,      // ASSUMPTION: 0 → MOTION_NEUTRAL after encode
      identity0:          callsign.substring(0, 11),
      identity1:          callsign.substring(0, 31),
      identity2:          '',     // ASSUMPTION: mech type or empty
      identity3:          '',     // ASSUMPTION: house or empty
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
        // internalStateBytes[i] must be non-zero for each weapon slot that uses
        // mec[0x8e+slot*2] == i as the ammo-type/IS index (RE: FUN_0042c200).
        // Indices 4 and 7 are also required non-zero by the IS gate (FUN_0042bb00).
        // ANH-1A mec[0x8e] values = [1,0,6,5,1,0,4,4] → indices 0,1,4,5,6 active.
        internalStateBytes:   [100, 100, 100, 100, 12, 100, 100, 9],
        // ANH-1A has 4 ammo bins, all serving weapon type 8 (mec[0x202+j*2]=8).
        // FUN_0042c200 checks actor[0x1e6+bin_index*2] > 0 before allowing fire.
        ammoStateValues:      [],  // let client use mec defaults; avoids display showing 400/slot
        actorDisplayName:     callsign.substring(0, 31),
      },
    },
    nextSeq(session),
  );

  connLog.info('[world] sending Cmd72 combat bootstrap (mech_id=%d callsign="%s")', mechId, callsign);
  send(socket, cmd72, capture, 'CMD72_COMBAT_BOOTSTRAP');

  // 3. Cmd64 — add remote bot actor at slot 1.
  const cmd64 = buildCmd64RemoteActorPacket(
    {
      slot:          1,
      actorTypeByte: 0,
      identity0:     'Opponent',
      identity1:     'Opponent',
      identity2:     '',
      identity3:     '',
      identity4:     '',
      statusByte:    0,
      mechId:        mechId,  // same mech type as player
    },
    nextSeq(session),
  );
  send(socket, cmd64, capture, 'CMD64_BOT_ACTOR');

  // 4. Cmd65 — initial position for the local actor (slot 0) at the origin.
  //    Gives the client something to render immediately after bootstrap.
  //    facing/throttle/legVel/speedMag = 0 (stationary, no heading).
  const cmd65 = buildCmd65PositionSyncPacket(
    { slot: 0, x: 0, y: 0, z: 0, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
    nextSeq(session),
  );
  send(socket, cmd65, capture, 'CMD65_INITIAL_POSITION');

  // 5. Cmd65 — initial position for the bot (slot 1), 300000 units north (open arena space).
  const cmd65Bot = buildCmd65PositionSyncPacket(
    { slot: 1, x: 0, y: 0, z: 300000, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
    nextSeq(session),
  );
  send(socket, cmd65Bot, capture, 'CMD65_BOT_POSITION');

  // 6. Cmd62 — "all actors ready" / combat-start signal.
  //    Clears DAT_0047ef60 bit 0x20, which blocks SPACEBAR weapon fire.
  //    MUST be sent after all Cmd64/Cmd65 packets.
  const cmd62 = buildCmd62CombatStartPacket(nextSeq(session));
  send(socket, cmd62, capture, 'CMD62_COMBAT_START');

  // Keep bot stationary by re-sending its position every second.
  session.botPositionTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable) return;
    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        { slot: 1, x: 0, y: 0, z: 300000, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
        nextSeq(session),
      ),
      capture, 'CMD65_BOT_POSITION',
    );
  }, 1000);
  session.botPositionTimer.unref();

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
    session.combatX          = frame.xRaw - COORD_BIAS;
    session.combatY          = frame.yRaw - COORD_BIAS;
    session.combatHeadingRaw = frame.headingRaw;
    const throttle = session.combatThrottle ?? 0;
    const legVel = session.combatLegVel ?? 0;
    const speedMag = session.combatSpeedMag ?? 0;
    connLog.debug(
      '[world/combat] cmd8 coasting: x=%d y=%d heading=%d throttle=%d legVel=%d speedMag=%d',
      session.combatX, session.combatY, frame.headingRaw, throttle, legVel, speedMag,
    );

    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        {
          slot:     0,
          x:        session.combatX,
          y:        session.combatY,
          z:        0,
          facing:   (frame.headingRaw - MOTION_NEUTRAL) * MOTION_DIV,
          throttle,
          legVel,
          speedMag,
        },
        nextSeq(session),
      ),
      capture,
      'CMD65_MOVEMENT',
    );
    return;
  }

  if (cmd === 9) {
    const frame = parseClientCmd9Moving(payload);
    if (!frame) return;
    session.combatX          = frame.xRaw - COORD_BIAS;
    session.combatY          = frame.yRaw - COORD_BIAS;
    session.combatHeadingRaw = frame.headingRaw;

    const maxSpeedMag = session.combatMaxSpeedMag ?? 0;
    const throttlePct = frame.throttleRaw - MOTION_NEUTRAL; // negative = forward
    const signedSpeedMag = maxSpeedMag > 0
      ? Math.round(-throttlePct * maxSpeedMag / 45)
      : 0;
    const throttle = (frame.throttleRaw - MOTION_NEUTRAL) * MOTION_DIV;
    const legVel = (frame.legVelRaw - MOTION_NEUTRAL) * MOTION_DIV;
    session.combatThrottle = throttle;
    session.combatLegVel = legVel;
    session.combatSpeedMag = signedSpeedMag;

    connLog.debug(
      '[world/combat] cmd9 moving: throttlePct=%d throttle=%d legVel=%d maxSpeedMag=%d signedSpeedMag=%d',
      throttlePct, throttle, legVel, maxSpeedMag, signedSpeedMag,
    );

    send(
      session.socket,
      buildCmd65PositionSyncPacket(
        {
          slot:     0,
          x:        session.combatX,
          y:        session.combatY,
          z:        0,
          facing:   (frame.headingRaw - MOTION_NEUTRAL) * MOTION_DIV,
          throttle,
          legVel,
          speedMag: signedSpeedMag,
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
  const shot = parseClientCmd10WeaponFire(payload);
  if (!shot) {
    connLog.warn('[world/combat] cmd-10 weapon fire parse failed (len=%d)', payload.length);
    return;
  }

  if (session.botHealth === undefined) {
    session.botHealth = BOT_INITIAL_HEALTH;
  }
  if (session.botHealth <= 0) {
    connLog.debug('[world/combat] cmd-10 shot ignored — bot already destroyed');
    return;
  }

  session.botHealth = Math.max(0, session.botHealth - BOT_DAMAGE_PER_HIT);
  connLog.info(
    '[world/combat] cmd-10 weapon fire: targetRaw=%d weaponSlot=%d flag=%d botHealth=%d',
    shot.targetRaw,
    shot.weaponSlot,
    shot.flag,
    session.botHealth,
  );

  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_RESET');
  send(
    session.socket,
    buildCmd68ProjectileSpawnPacket(
      {
        sourceSlot:   0,
        weaponSlot:   shot.weaponSlot,
        targetRaw:    2, // bot actor slot 1 encoded as slot + 1
        targetAttach: 0,
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
  send(
    session.socket,
    buildCmd66ActorDamagePacket(1, 1, BOT_DAMAGE_PER_HIT, nextSeq(session)),
    capture,
    'CMD66_BOT_DAMAGE',
  );
  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_CLOSE');

  if (session.botHealth <= 0) {
    connLog.info('[world/combat] bot destroyed — sending Cmd70 death animation');
    send(
      session.socket,
      buildCmd70ActorTransitionPacket(1, 4, nextSeq(session)),
      capture,
      'CMD70_BOT_DEATH',
    );
    if (session.botPositionTimer !== undefined) {
      clearInterval(session.botPositionTimer);
      session.botPositionTimer = undefined;
    }
  }
}

export function handleCombatActionFrame(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  _capture: CaptureLogger,
): void {
  const action = parseClientCmd12Action(payload);
  if (!action) {
    connLog.warn('[world/combat] cmd-12 action parse failed (len=%d)', payload.length);
    return;
  }
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
    const classIndex = session.mechPickerClass ?? 0;
    const classKey = CLASS_KEYS[classIndex] as string | undefined;
    const seenChassis = new Set<string>();
    const chassisList: string[] = [];
    for (const mech of WORLD_MECHS) {
      const stat = MECH_STATS.get(mech.typeString);
      if (classKey && stat?.weightClass.toUpperCase() !== classKey) continue;
      const chassis = getMechChassis(mech.typeString);
      if (!seenChassis.has(chassis)) {
        seenChassis.add(chassis);
        chassisList.push(chassis);
      }
    }
    chassisList.sort((a, b) => a.localeCompare(b));
    const chassis = chassisList[selection - 1];
    if (!chassis) {
      sendMechClassPicker(session, connLog, capture);
      return true;
    }
    sendMechVariantPicker(session, chassis, connLog, capture);
    return true;
  }

  if (step === 'variant' && listId === MECH_CLASS_LIST_ID) {
    if (selection === 0) {
      sendMechChassisPicker(session, session.mechPickerClass ?? 0, connLog, capture);
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

    session.selectedMechSlot  = chosen.slot;
    session.selectedMechId    = chosen.id;
    session.mechPickerStep    = undefined;
    session.mechPickerClass   = undefined;
    session.mechPickerChassis = undefined;

    connLog.info('[world] mech selected: callsign="%s" slot=%d id=%d typeString=%s',
      getDisplayName(session), chosen.slot, chosen.id, chosen.typeString);
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
