/**
 * World server — session helpers and scene/UI packet builders.
 *
 * Low-level send wrappers, session state accessors, player-presence queries,
 * and all functions that construct and dispatch UI packets (scene init, roster
 * lists, personnel records, travel map).
 */

import * as net from 'net';

import {
  buildCmd3BroadcastPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd6CursorBusyPacket,
  buildCmd10RoomPresenceSyncPacket,
  buildCmd14PersonnelRecordPacket,
  buildCmd43SolarisMapPacket,
  buildCmd48KeyedTripleStringListPacket,
} from '../protocol/world.js';
import { buildMenuDialogPacket, buildMechListPacket } from '../protocol/game.js';
import { PlayerRegistry, ClientSession } from '../state/players.js';
import { Logger }         from '../util/logger.js';
import { CaptureLogger }  from '../util/capture.js';

import {
  worldCaptures,
  DEFAULT_MAP_ROOM_ID,
  ALL_ROSTER_LIST_ID,
  INQUIRY_MENU_ID,
  PERSONNEL_LIST_ID,
  FALLBACK_MECH_ID,
  SOLARIS_TRAVEL_CONTEXT_ID,
  worldMapByRoomId,
  getSolarisRoomExits,
  getSolarisSceneIndex,
  getSolarisRoomName,
  getSolarisRoomDescription,
  getSolarisRoomIcon,
  WORLD_MECHS,
  getMechChassis,
  getMechChassisListForClass,
  getRepresentativeMechForClass,
  getRepresentativeMechForChassis,
  CLASS_LABELS,
  CLASS_KEYS,
  MECH_CLASS_FOOTER,
  MECH_CHASSIS_FOOTER,
  MECH_CLASS_LIST_ID,
  MECH_CHASSIS_LIST_ID,
  MECH_VARIANT_FOOTER,
  MECH_VARIANT_LIST_ID,
  MECH_CHASSIS_PAGE_SIZE,
  mechKph,
} from './world-data.js';

// ── Low-level send helpers ────────────────────────────────────────────────────

export function send(socket: net.Socket, pkt: Buffer, capture: CaptureLogger, label: string): void {
  capture.logSend(pkt, label);
  socket.write(pkt);
}

export function sendToWorldSession(session: ClientSession, pkt: Buffer, label: string): void {
  if (session.socket.destroyed || !session.socket.writable) return;
  worldCaptures.get(session.id)?.logSend(pkt, label);
  session.socket.write(pkt);
}

/**
 * Advance and return the session's outgoing sequence number.
 * Valid range: 0–42 (FUN_0040C2A0: val > 42 → treated as ACK request, not data).
 */
export function nextSeq(session: ClientSession): number {
  const s = session.serverSeq;
  session.serverSeq = (session.serverSeq + 1) % 43;
  return s;
}

export function getDisplayName(session: ClientSession): string {
  const raw = String((session.displayName ?? session.username) || 'Pilot');
  const withoutEsc = raw.replace(/[\x00-\x1F\x7F]/g, '');
  const latin1 = Buffer.from(withoutEsc, 'latin1').subarray(0, 84).toString('latin1');
  return latin1 || 'Pilot';
}

export function mapRoomKey(roomId: number): string {
  return `map_room_${roomId}`;
}

// ── Presence accessors ────────────────────────────────────────────────────────

export function getPresenceStatus(session: ClientSession): number {
  return session.worldPresenceStatus ?? 5;
}

export function getComstarId(session: ClientSession): number {
  if (session.accountId !== undefined) {
    return 100000 + session.accountId;
  }
  return 900000 + (session.worldRosterId ?? 0);
}

export function getPresenceLocation(session: ClientSession): string {
  const roomId = session.worldMapRoomId;
  const status = getPresenceStatus(session);
  const room = roomId === undefined ? 'world' : getSolarisRoomName(roomId);
  if (status <= 5) return `Standing in ${room}`;
  if (status <= 12) return `Booth ${status - 5} in ${room}`;
  return `Status ${status}`;
}

// ── Roster / presence queries ─────────────────────────────────────────────────

export function currentRoomPresenceEntries(players: PlayerRegistry, session: ClientSession) {
  if (session.worldRosterId === undefined) {
    return [];
  }

  const entries = [
    {
      rosterId: session.worldRosterId,
      status:   getPresenceStatus(session),
      callsign: getDisplayName(session),
    },
  ];

  for (const other of players.inRoom(session.roomId)) {
    if (
      other.id === session.id ||
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.worldRosterId === undefined ||
      other.socket.destroyed
    ) {
      continue;
    }

    entries.push({
      rosterId: other.worldRosterId,
      status:   getPresenceStatus(other),
      callsign: getDisplayName(other),
    });
  }

  return entries;
}

export function findWorldTargetBySelectionId(
  players: PlayerRegistry,
  targetId: number,
): ClientSession | undefined {
  return players.worldSessions().find(other =>
    getComstarId(other) === targetId || other.worldRosterId === targetId,
  );
}

export function buildAllRosterEntries(players: PlayerRegistry) {
  return players.worldSessions()
    .slice()
    .sort((a, b) => getComstarId(a) - getComstarId(b))
    .map(other => ({
      itemId: getComstarId(other),
      col1:   getDisplayName(other),
      col2:   getSolarisRoomName(other.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID),
      col3:   getPresenceLocation(other),
    }));
}

export function buildPersonnelRecordLines(target: ClientSession, page: number): string[] {
  if (page <= 1) {
    return [
      // The client's Cmd14 header always shows the querying user's own callsign
      // as "Handle" (it reads from the room-roster selection cursor, which
      // defaults to self).  We have no wire field that overrides it, so we
      // repeat the correct handle as the first body line.
      `Handle   : ${getDisplayName(target)}`,
      `House    : ${target.allegiance ?? 'Unaffiliated'}`,
      `Sector   : ${getSolarisRoomName(target.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID)}`,
      `Location : ${getPresenceLocation(target)}`,
      'Status   : Online',
      `ComStar  : ${getComstarId(target)}`,
    ];
  }

  return [
    'Stable   : Independent',
    `Mech ID  : ${target.selectedMechId ?? FALLBACK_MECH_ID}`,
    `Roster   : ${target.worldRosterId ?? 0}`,
    'Standing : 0',
    'Winnings : 0 cb',
    'Record   : Prototype page 2',
  ];
}

export function buildComstarDeliveryText(senderName: string, text: string): string {
  const raw = `ComStar message from ${senderName}\\${text}`;
  let trimmed = raw.replace(/\x1b/g, '?');
  while (Buffer.byteLength(trimmed, 'latin1') > (85 * 85 - 1)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

// ── Scene and UI packet senders ───────────────────────────────────────────────

export function sendSolarisTravelMap(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  connLog.info('[world] sending Cmd43 Solaris travel map: currentRoomId=%d', currentRoomId);
  send(
    session.socket,
    buildCmd43SolarisMapPacket(
      {
        contextId: SOLARIS_TRAVEL_CONTEXT_ID,
        currentRoomId,
      },
      nextSeq(session),
    ),
    capture,
    'CMD43_SOLARIS_MAP',
  );
}

export function buildSceneInitForSession(session: ClientSession) {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneIndex = getSolarisSceneIndex(roomId);

  // Build a 4-slot array (N=0, S=1, E=2, W=3) preserving direction positions.
  // When using world-map.json the exits array already has nulls for empty slots.
  // When using the fallback, compact exits are back-filled starting at slot 0.
  const mapRoom = worldMapByRoomId.get(roomId);
  let slottedExits: (number | null)[];
  if (mapRoom) {
    const { north, south, east, west } = mapRoom.exits;
    slottedExits = [north, south, east, west];
  } else {
    const exits = getSolarisRoomExits(roomId);
    slottedExits = [
      exits[0] ?? null,
      exits[1] ?? null,
      exits[2] ?? null,
      exits[3] ?? null,
    ];
  }

  const exitMask = slottedExits.reduce<number>(
    (mask, id, slot) => (id !== null ? mask | (1 << slot) : mask),
    0,
  );

  // Room-type-aware action buttons.
  // actionType 4 → "Travel" (opens Cmd43 travel map).
  // actionType 5 → "Fight"  (enter combat; handled by cmd-5 dispatch in server-world.ts).
  // actionType 6 → "Mech Bay" (opens the 3-step mech picker).
  // The client hard-codes actionType 0 (0x100 wire) as the local Help button.
  const isArena = mapRoom?.type === 'arena';
  const arenaOptions: Array<{ type: number; label: string }> = [
    { type: 0, label: 'Help' },
    { type: 4, label: 'Travel' },
    { type: 6, label: 'Mech Bay' },
  ];
  if (isArena) {
    arenaOptions.push({ type: 5, label: 'Fight' });
  }

  return buildCmd4SceneInitPacket(
    {
      sessionFlags:     0x30 | exitMask,
      playerScoreSlot:  sceneIndex,
      playerMechId:     getSolarisRoomIcon(roomId),
      opponents:        (() => {
        // Build a 4-slot sparse array: set only slots with a real exit so that
        // buildCmd4Args treats absent indices as "no location" (icon hidden).
        const arr: Array<{ type: number; mechId: number }> = [];
        for (let slot = 0; slot < slottedExits.length; slot++) {
          const exitRoomId = slottedExits[slot];
          if (exitRoomId !== null) {
            arr[slot] = { type: getSolarisSceneIndex(exitRoomId), mechId: getSolarisRoomIcon(exitRoomId) };
          }
        }
        return arr;
      })(),
      callsign:         getDisplayName(session),
      sceneName:        (() => {
        const name = getSolarisRoomName(roomId);
        const desc = getSolarisRoomDescription(roomId);
        // 0x5C (\) is a hard line-break in both FUN_00416710 and FUN_00431320
        return desc ? `${name}\x5c${desc}` : name;
      })(),
      arenaOptions,
    },
    nextSeq(session),
  );
}

export function sendSceneRefresh(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  message: string,
): void {
  send(session.socket, buildCmd6CursorBusyPacket(nextSeq(session)), capture, 'CMD6_BUSY');
  send(session.socket, buildSceneInitForSession(session), capture, 'CMD4_SCENE_REFRESH');

  const roomPresenceEntries = currentRoomPresenceEntries(players, session);
  connLog.info('[world] sending Cmd10 RoomPresenceSync (%d entries)', roomPresenceEntries.length);
  send(
    session.socket,
    buildCmd10RoomPresenceSyncPacket(roomPresenceEntries, nextSeq(session)),
    capture,
    'CMD10_ROOM_SYNC',
  );
  send(
    session.socket,
    buildCmd3BroadcastPacket(message, nextSeq(session)),
    capture,
    'CMD3_TRAVEL_COMPLETE',
  );

  send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
}

export function sendAllRosterList(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const entries = buildAllRosterEntries(players);
  connLog.info('[world] sending Cmd48 all-roster list (%d entries)', entries.length);
  send(
    session.socket,
    buildCmd48KeyedTripleStringListPacket(
      ALL_ROSTER_LIST_ID,
      'All Personnel Online',
      entries,
      nextSeq(session),
    ),
    capture,
    'CMD48_ALL_ROSTER',
  );
}

export function sendInquiryMenu(
  session: ClientSession,
  target: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const targetId = getComstarId(target);
  session.worldInquiryTargetId = targetId;
  session.worldInquiryPage = undefined;

  connLog.info(
    '[world] sending inquiry submenu: target=%d handle="%s"',
    targetId,
    getDisplayName(target),
  );
  send(
    session.socket,
    buildMenuDialogPacket(
      INQUIRY_MENU_ID,
      'Personal inquiry on:',
      ['Send a ComStar message', 'Access personnel data'],
      nextSeq(session),
    ),
    capture,
    'CMD7_INQUIRY_MENU',
  );
}

export function sendPersonnelRecord(
  players: PlayerRegistry,
  session: ClientSession,
  targetId: number,
  page: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const target = findWorldTargetBySelectionId(players, targetId);
  if (!target) {
    connLog.warn('[world] personnel record target not found: id=%d page=%d', targetId, page);
    send(
      session.socket,
      buildCmd14PersonnelRecordPacket(
        {
          comstarId: targetId,
          battlesToDate: 0,
          lines: ['Status   : Offline', 'Record   : Unavailable', '', '', '', ''],
        },
        nextSeq(session),
      ),
      capture,
      'CMD14_PERSONNEL_OFFLINE',
    );
    return;
  }

  const resolvedTargetId = getComstarId(target);
  session.worldInquiryTargetId = resolvedTargetId;
  session.worldInquiryPage = page;

  // The client's Cmd14 handler looks up the handle for the record in the room
  // presence table (seeded by Cmd10/Cmd13), which is keyed by worldRosterId.
  // Sending getComstarId (100000+accountId) as comstarId results in a lookup
  // miss → "Handle = null" and the client falls back to its own callsign.
  // The real ComStar ID is already shown in the body lines ('ComStar  : N').
  const presenceId = target.worldRosterId ?? 0;

  connLog.info(
    '[world] sending Cmd14 personnel record: presenceId=%d handle="%s" page=%d',
    presenceId,
    getDisplayName(target),
    page,
  );
  send(
    session.socket,
    buildCmd14PersonnelRecordPacket(
      {
        comstarId:     presenceId,
        battlesToDate: 0,
        lines:         buildPersonnelRecordLines(target, page),
      },
      nextSeq(session),
    ),
    capture,
    page <= 1 ? 'CMD14_PERSONNEL_P1' : 'CMD14_PERSONNEL_P2',
  );
}

// Re-export PERSONNEL_LIST_ID so the dispatch handler can reference it without
// importing from world-data directly (it already imports this module wholesale).
export { PERSONNEL_LIST_ID };

// ── 3-step mech picker ────────────────────────────────────────────────────────

/** Step 1 — send the weight-class picker (Light / Medium / Heavy / Assault). */
export function sendMechClassPicker(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.mechPickerStep        = 'class';
  session.mechPickerClass       = undefined;
  session.mechPickerChassis     = undefined;
  session.mechPickerChassisPage = undefined;
  const entries = CLASS_LABELS.map((label, slot) => {
    const preview = getRepresentativeMechForClass(slot);
    return {
      id:             preview?.id ?? 0,
      mechType:       preview?.mechType ?? 0,
      slot,
      typeString:     '',
      variant:        '',
      name:           label,
      walkSpeedMag:   0,
      maxSpeedMag:    0,
      extraCritCount: 0,
      tonnage:        0,
    };
  });
  connLog.info('[world] sending mech class picker');
  send(
    session.socket,
    buildMechListPacket(entries, MECH_CLASS_LIST_ID, MECH_CLASS_FOOTER, nextSeq(session)),
    capture,
    'CMD26_MECH_CLASS_PICKER',
  );
  send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
}

/** Step 2 — send the chassis picker for the chosen weight class (with pagination). */
export function sendMechChassisPicker(
  session: ClientSession,
  classIndex: number,
  connLog: Logger,
  capture: CaptureLogger,
  page = 0,
): void {
  session.mechPickerStep        = 'chassis';
  session.mechPickerClass       = classIndex;
  session.mechPickerChassisPage = 0;

  const classKey    = CLASS_KEYS[classIndex] as string | undefined;
  const chassisList = getMechChassisListForClass(classIndex);
  const start       = 0;
  const visible     = chassisList.slice(start, start + 20);

  const entries = visible.map((chassis, slot) => {
    const preview = getRepresentativeMechForChassis(chassis);
    return {
      id:         preview?.id ?? 0,
      mechType:   preview?.mechType ?? 0,
      slot,
      typeString: '',
      variant:    '',
      name:       chassis,
      walkSpeedMag: 0,
      maxSpeedMag: 0,
      extraCritCount: 0,
      tonnage:    0,
    };
  });

  connLog.info('[world] sending mech chassis picker: class=%s page=%d entries=%d total=%d',
    classKey ?? classIndex, 0, entries.length, chassisList.length);
  send(
    session.socket,
    buildMechListPacket(entries, MECH_CHASSIS_LIST_ID, MECH_CHASSIS_FOOTER, nextSeq(session)),
    capture,
    'CMD26_MECH_CHASSIS_PICKER',
  );
  send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
}

/** Step 3 — send the variant picker for the chosen chassis. */
export function sendMechVariantPicker(
  session: ClientSession,
  chassis: string,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.mechPickerStep    = 'variant';
  session.mechPickerChassis = chassis;

  const variants = WORLD_MECHS.filter(mech => getMechChassis(mech.typeString) === chassis);
  // slot must be the 0-based positional index so the client echoes back (slot+1)
  // as the selection, which the handler converts back to variants[selection-1].
  // Using mech.slot (the raw DB slot) causes out-of-range lookups for any mech
  // whose DB slot is not equal to its position in this filtered list.
  const entries = variants.map((mech, i) => ({
    id:         mech.id,
    mechType:   mech.mechType,
    slot:       i,
    typeString: mech.typeString,
    variant:    `${mechKph(mech.walkSpeedMag)}/${mechKph(mech.maxSpeedMag)} kph`,
    name:       mech.typeString,
    walkSpeedMag: mech.walkSpeedMag,
    maxSpeedMag: mech.maxSpeedMag,
    extraCritCount: mech.extraCritCount,
    tonnage:    mech.tonnage,
  }));

  connLog.info('[world] sending mech variant picker: chassis="%s" entries=%d', chassis, entries.length);
  send(
    session.socket,
    buildMechListPacket(entries, MECH_VARIANT_LIST_ID, MECH_VARIANT_FOOTER, nextSeq(session)),
    capture,
    'CMD26_MECH_VARIANT_PICKER',
  );
  send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
}
