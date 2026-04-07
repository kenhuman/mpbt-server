/**
 * MPBT World Server — game world (RPS) TCP connection handler.
 *
 * Accepts the secondary TCP connection that the client opens after the lobby
 * sends a REDIRECT packet.  Runs on WORLD_PORT (2001).
 *
 * World handshake (CONFIRMED by RESEARCH.md §18 / Ghidra RE):
 *
 *   Server → Client: LOGIN_REQUEST (type 0x16, empty payload)
 *   Client → Server: LOGIN         (type 0x15, same format as lobby)
 *   Server → Client: SYNC ack      (type 0x00, empty)
 *   Server → Client: SYNC          (type 0x00, payload = "\x1B?MMW Copyright Kesmai Corp. 1991")
 *   [Client FUN_00429870 fires world-MMW init sequence, calls Cmd3_SendCapabilities]
 *   Client → Server: SYNC          (type 0x00, cmd-3 capabilities frame)
 *   Server → Client: Cmd6 CursorBusy   (show hourglass while loading)
 *   Server → Client: Cmd4 SceneInit    (create arena window; sets g_chatReady=1)
 *   Server → Client: Cmd3 Broadcast    (welcome message; requires g_chatReady=1)
 *   Server → Client: Cmd5 CursorNormal (restore cursor)
 *
 * CRC mode: RPS (seed 0x0A5C25); same as lobby; DAT_004e2cd0 stays 0 on MMW path.
 */

import * as net    from 'net';
import * as crypto from 'crypto';

import { WORLD_PORT, Msg } from './protocol/constants.js';
import { PacketParser, buildPacket, hexDump } from './protocol/aries.js';
import {
  parseLoginPayload,
  buildLoginRequest,
  buildSyncAck,
  buildWelcomePacket,
} from './protocol/auth.js';
import {
  buildCmd36MessageViewPacket,
  buildMenuDialogPacket,
  parseClientCmd4,
  parseClientCmd5SceneAction,
  parseClientCmd10MapReply,
  parseClientCmd21TextReply,
  parseClientCmd23LocationAction,
  parseClientCmd7,
  verifyInboundGameCRC,
} from './protocol/game.js';
import {
  buildCmd3BroadcastPacket,
  buildCmd10RoomPresenceSyncPacket,
  buildCmd11PlayerEventPacket,
  buildCmd13PlayerArrivalPacket,
  buildCmd14PersonnelRecordPacket,
  buildCmd43SolarisMapPacket,
  buildCmd48KeyedTripleStringListPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd6CursorBusyPacket,
} from './protocol/world.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { launchRegistry } from './state/launch.js';
import { loadMechs } from './data/mechs.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { ARIES_KEEPALIVE_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from './config.js';

// ── Shared mech catalog (same on-disk data as lobby) ─────────────────────────
// Loaded once at module import time.  Provides a fallback when a player's
// launch record is absent (e.g. direct connection to world port in tests).
let WORLD_MECHS: ReturnType<typeof loadMechs>;
try {
  WORLD_MECHS = loadMechs();
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Non-fatal: the world server still starts; FALLBACK_MECH_ID is used instead.
  process.stderr.write(`[world] WARNING: failed to load mechs: ${msg}\n`);
  WORLD_MECHS = [];
}

/** Mech ID used when the player's launch record is missing. */
const FALLBACK_MECH_ID = WORLD_MECHS.length > 0 ? WORLD_MECHS[0].id : 0;

const WELCOME_TEXT       = 'Welcome to the game world.';
const DEFAULT_MAP_ROOM_ID = 146; // Solaris Starport
const SOLARIS_SCENE_ROOMS = [
  { roomId: 146, name: 'Solaris Starport' },
  { roomId: 147, name: 'Ishiyama Arena' },
  { roomId: 148, name: 'Government House' },
  { roomId: 149, name: 'White Lotus' },
  { roomId: 150, name: 'Waterfront' },
  { roomId: 151, name: 'Kobe Slums' },
  { roomId: 152, name: 'Steiner Stadium' },
  { roomId: 153, name: 'Lyran Building' },
  { roomId: 154, name: 'Chahar Park' },
  { roomId: 155, name: 'Riverside' },
  { roomId: 156, name: 'Black Throne' },
  { roomId: 157, name: 'Factory' },
  { roomId: 158, name: 'Marik Tower' },
  { roomId: 159, name: 'Allman' },
  { roomId: 160, name: 'Riverfront' },
  { roomId: 161, name: 'Wasteland' },
  { roomId: 162, name: 'Jungle' },
  { roomId: 163, name: "Chancellor's Quarters" },
  { roomId: 164, name: 'Middletown' },
  { roomId: 165, name: 'Rivertown' },
  { roomId: 166, name: 'Maze' },
  { roomId: 167, name: 'Davion Arena' },
  { roomId: 168, name: 'Sortek Building' },
  { roomId: 169, name: 'Guzman Park' },
  { roomId: 170, name: 'Marina' },
  { roomId: 171, name: 'Viewpoint' },
  { roomId: 1, name: 'International Sector' },
  { roomId: 2, name: 'Kobe Sector' },
  { roomId: 3, name: 'Silesia Sector' },
  { roomId: 4, name: 'Montenegro Sector' },
  { roomId: 5, name: 'Cathay Sector' },
  { roomId: 6, name: 'Black Hills Sector' },
] as const;
const SOLARIS_ROOM_BY_ID = new Map<number, { roomId: number; name: string; sceneIndex: number }>(
  SOLARIS_SCENE_ROOMS.map((room, index) => [room.roomId, { ...room, sceneIndex: index }]),
);
const ALL_ROSTER_LIST_ID = 0x3F4;
const INQUIRY_MENU_ID    = 1000;
const PERSONNEL_LIST_ID  = 0x3F2;
const PERSONNEL_MORE_ID  = 0x95;
const SOLARIS_TRAVEL_CONTEXT_ID = 0xC6;
let nextWorldRosterId    = 1;
const worldCaptures      = new Map<string, CaptureLogger>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: net.Socket, pkt: Buffer, capture: CaptureLogger, label: string): void {
  capture.logSend(pkt, label);
  socket.write(pkt);
}

function sendToWorldSession(session: ClientSession, pkt: Buffer, label: string): void {
  if (session.socket.destroyed || !session.socket.writable) return;
  worldCaptures.get(session.id)?.logSend(pkt, label);
  session.socket.write(pkt);
}

/**
 * Advance and return the session's outgoing sequence number.
 * Valid range: 0–42 (FUN_0040C2A0: val > 42 → treated as ACK request, not data).
 */
function nextSeq(session: ClientSession): number {
  const s = session.serverSeq;
  session.serverSeq = (session.serverSeq + 1) % 43;
  return s;
}

function getDisplayName(session: ClientSession): string {
  const raw = String((session.displayName ?? session.username) || 'Pilot');
  const withoutEsc = raw.replace(/[\x00-\x1F\x7F]/g, '');
  const latin1 = Buffer.from(withoutEsc, 'latin1').subarray(0, 84).toString('latin1');
  return latin1 || 'Pilot';
}

function mapRoomKey(roomId: number): string {
  return `map_room_${roomId}`;
}

function getSolarisRoomInfo(roomId: number) {
  return SOLARIS_ROOM_BY_ID.get(roomId) ?? SOLARIS_ROOM_BY_ID.get(DEFAULT_MAP_ROOM_ID)!;
}

function getSolarisSceneIndex(roomId: number): number {
  return getSolarisRoomInfo(roomId).sceneIndex;
}

function getSolarisRoomName(roomId: number): string {
  return getSolarisRoomInfo(roomId).name;
}

function uniqueRoomIds(roomIds: number[]): number[] {
  return [...new Set(roomIds)].filter(roomId => SOLARIS_ROOM_BY_ID.has(roomId));
}

function getSolarisRoomExits(roomId: number): number[] {
  if (roomId === 146) return [147, 152, 157, 162];

  const index = SOLARIS_SCENE_ROOMS.findIndex(room => room.roomId === roomId);
  const room = getSolarisRoomInfo(roomId);
  const exits = [146];

  if (index > 0) exits.push(SOLARIS_SCENE_ROOMS[index - 1].roomId);
  if (index >= 0 && index < SOLARIS_SCENE_ROOMS.length - 1) exits.push(SOLARIS_SCENE_ROOMS[index + 1].roomId);

  // Sector rows are the last six records in SOLARIS.MAP; each combat/social
  // room's low flags byte points at that row. This is still a topology
  // placeholder, but it keeps exits within valid client scene indices.
  if (room.roomId >= 147 && room.roomId <= 171) {
    const sectorOffset = Math.floor((room.roomId - 147) / 5);
    exits.push(SOLARIS_SCENE_ROOMS[26 + Math.min(sectorOffset, 5)].roomId);
  }

  return uniqueRoomIds(exits).filter(exit => exit !== roomId).slice(0, 4);
}

function getPresenceStatus(session: ClientSession): number {
  return session.worldPresenceStatus ?? 5;
}

function getComstarId(session: ClientSession): number {
  if (session.accountId !== undefined) {
    return 100000 + session.accountId;
  }
  return 900000 + (session.worldRosterId ?? 0);
}

function getPresenceLocation(session: ClientSession): string {
  const roomId = session.worldMapRoomId;
  const status = getPresenceStatus(session);
  const room = roomId === undefined ? 'world' : getSolarisRoomName(roomId);
  if (status <= 5) return `Standing in ${room}`;
  if (status <= 12) return `Booth ${status - 5} in ${room}`;
  return `Status ${status}`;
}

function currentRoomPresenceEntries(players: PlayerRegistry, session: ClientSession) {
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

function findWorldTargetBySelectionId(
  players: PlayerRegistry,
  targetId: number,
): ClientSession | undefined {
  return players.worldSessions().find(other =>
    getComstarId(other) === targetId || other.worldRosterId === targetId,
  );
}

function buildAllRosterEntries(players: PlayerRegistry) {
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

function buildPersonnelRecordLines(target: ClientSession, page: number): string[] {
  if (page <= 1) {
    return [
      'Rank     : Warrior',
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

function buildComstarDeliveryText(senderName: string, text: string): string {
  const raw = `ComStar message from ${senderName}\\${text}`;
  let trimmed = raw.replace(/\x1b/g, '?');
  while (Buffer.byteLength(trimmed, 'latin1') > (85 * 85 - 1)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function sendSolarisTravelMap(
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

function buildSceneInitForSession(session: ClientSession) {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneIndex = getSolarisSceneIndex(roomId);
  const exits = getSolarisRoomExits(roomId);
  const exitMask = exits.reduce((mask, _roomId, slot) => mask | (1 << slot), 0);

  return buildCmd4SceneInitPacket(
    {
      sessionFlags:     0x30 | exitMask,
      playerScoreSlot:  sceneIndex,
      playerMechId:     sceneIndex,
      opponents:        exits.map(exitRoomId => {
        const exitSceneIndex = getSolarisSceneIndex(exitRoomId);
        return { type: exitSceneIndex, mechId: exitSceneIndex };
      }),
      callsign:         getDisplayName(session),
      sceneName:        getSolarisRoomName(roomId),
      arenaOptions:     [{ type: 4, label: 'Travel' }],
    },
    nextSeq(session),
  );
}

function sendSceneRefresh(
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

function sendAllRosterList(
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

function sendInquiryMenu(
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

function sendPersonnelRecord(
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
      buildCmd3BroadcastPacket('Personnel record unavailable.', nextSeq(session)),
      capture,
      'CMD3_PERSONNEL_MISSING',
    );
    return;
  }

  const resolvedTargetId = getComstarId(target);
  session.worldInquiryTargetId = resolvedTargetId;
  session.worldInquiryPage = page;

  connLog.info(
    '[world] sending Cmd14 personnel record: target=%d handle="%s" page=%d',
    resolvedTargetId,
    getDisplayName(target),
    page,
  );
  send(
    session.socket,
    buildCmd14PersonnelRecordPacket(
      {
        comstarId:     resolvedTargetId,
        battlesToDate: 0,
        lines:         buildPersonnelRecordLines(target, page),
      },
      nextSeq(session),
    ),
    capture,
    page <= 1 ? 'CMD14_PERSONNEL_P1' : 'CMD14_PERSONNEL_P2',
  );
}

function handleComstarTextReply(
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

  const target = findWorldTargetBySelectionId(players, dialogId);
  if (!target) {
    connLog.warn('[world] cmd-21 ComStar target unavailable: id=%d', dialogId);
    send(
      session.socket,
      buildCmd3BroadcastPacket('ComStar target unavailable.', nextSeq(session)),
      capture,
      'CMD3_COMSTAR_MISSING',
    );
    return;
  }

  const senderName = getDisplayName(session);
  const targetName = getDisplayName(target);
  const ack = `ComStar sent to ${targetName}.`;

  connLog.info(
    '[world] cmd-21 ComStar: from="%s" to="%s" target=%d text=%j',
    senderName,
    targetName,
    dialogId,
    clean,
  );

  sendToWorldSession(
    target,
    buildCmd36MessageViewPacket(
      getComstarId(session),
      buildComstarDeliveryText(senderName, clean),
      nextSeq(target),
    ),
    'CMD36_COMSTAR_DELIVERY',
  );
  send(
    session.socket,
    buildCmd3BroadcastPacket(ack, nextSeq(session)),
    capture,
    'CMD3_COMSTAR_ACK',
  );
}

function nextAvailableBooth(players: PlayerRegistry, roomId: string, excludeId: string): number {
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

function updateRoomPresenceStatus(
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

function handleRoomMenuSelection(
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

function handleWorldTextCommand(
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

  const line = `${getDisplayName(session)}: ${clean}`;
  connLog.info('[world] cmd-4 text: %s', line);

  for (const other of players.inRoom(session.roomId)) {
    if (
      other.id === session.id ||
      other.phase !== 'world' ||
      !other.worldInitialized ||
      other.socket.destroyed
    ) {
      continue;
    }

    sendToWorldSession(other, buildCmd3BroadcastPacket(line, nextSeq(other)), 'CMD3_CHAT_FANOUT');
  }
}

function handleMapTravelReply(
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
  session.worldMapRoomId = selectedRoomId;
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

function handleLocationAction(
  players: PlayerRegistry,
  session: ClientSession,
  slot: number,
  targetCached: boolean,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const exits = getSolarisRoomExits(currentRoomId);
  const targetRoomId = exits[slot];
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
  session.worldMapRoomId = targetRoomId;
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

function notifyRoomArrival(
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

function notifyRoomDeparture(
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

// ── Login handler ─────────────────────────────────────────────────────────────

async function handleWorldLogin(
  session:  ClientSession,
  payload:  Buffer,
  connLog:  Logger,
  capture:  CaptureLogger,
): Promise<void> {
  if (session.phase !== 'auth') {
    connLog.warn('[world-login] received LOGIN in phase %s — ignoring', session.phase);
    return;
  }

  const result = parseLoginPayload(payload, connLog);
  if (!result) {
    connLog.debug('[world-login] incomplete payload, waiting');
    return;
  }
  if (!result.ok) {
    connLog.warn('[world-login] rejected: %s', result.reason);
    session.socket.destroy();
    return;
  }

  const { login } = result;
  session.username = login.username || '(unknown)';

  // Require a lobby-issued launch record. Reject any connection that did not
  // come through the lobby auth + REDIRECT flow (closes the direct-connect bypass).
  const launch = launchRegistry.consume(session.username);
  if (!launch) {
    connLog.warn(
      '[world-login] rejected: no launch record for "%s" — must connect via lobby',
      session.username,
    );
    session.socket.destroy();
    return;
  }

  session.accountId       = launch.accountId;
  session.displayName     = launch.displayName;
  session.allegiance      = launch.allegiance;
  session.selectedMechId   = launch.mechId;
  session.selectedMechSlot = launch.mechSlot;
  connLog.info(
    '[world-login] launch record found: displayName="%s" allegiance=%s mech=%s (id=%d slot=%d)',
    session.displayName ?? session.username,
    session.allegiance ?? '(none)',
    launch.mechTypeString,
    launch.mechId,
    launch.mechSlot,
  );

  session.phase          = 'world';
  session.worldMapRoomId = DEFAULT_MAP_ROOM_ID;
  session.roomId         = mapRoomKey(DEFAULT_MAP_ROOM_ID);

  connLog.info(
    '[world-login] accepted: user="%s" displayName="%s" allegiance=%s service="%s"',
    session.username,
    session.displayName ?? session.username,
    session.allegiance ?? '(none)',
    login.serviceId,
  );

  // SYNC ack — same timing packet as lobby.
  const syncAck = buildSyncAck(Date.now());
  connLog.info('[world-login] sending SYNC ack');
  send(session.socket, syncAck, capture, 'SYNC_ACK');

  // Welcome escape — "\x1B?MMW Copyright Kesmai Corp. 1991"
  // COMMEG32 fires WM_0x7f0; FUN_00429870 ≥1 path matches DAT_00474d48, sets
  // DAT_004e2cd0 = 0 (RPS mode) and calls Cmd3_SendCapabilities (FUN_0040d3c0).
  // The client then immediately sends cmd-3 on the same SYNC channel.
  const welcomePkt = buildWelcomePacket();
  connLog.info('[world-login] sending WELCOME escape (%d bytes)', welcomePkt.length);
  send(session.socket, welcomePkt, capture, 'WORLD_WELCOME');
}

// ── World data handler ────────────────────────────────────────────────────────
// Handles type-0x00 (SYNC) packets in 'world' phase.
//
// Expected client commands in RPS mode (from §18 dispatch table):
//   cmd  1 — PingAck  (client acknowledging a server ping request)
//   cmd  2 — PingRequest (client requesting ack from server — echo reply needed)
//   cmd  3 — client capabilities / ready signal (initial trigger; also sent on reconnect)
//   cmd 29 — FUN_00427710 (unknown; observed in some sessions)

function handleWorldGameData(
  players: PlayerRegistry,
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.phase !== 'world') {
    connLog.debug('[world] SYNC in phase=%s (len=%d) — ignoring', session.phase, payload.length);
    return;
  }

  connLog.debug('[world] rx type-0 len=%d\n%s', payload.length, hexDump(payload));

  // Frame: \x1b [seq+0x21] [cmd+0x21] [args] [0x20] [CRC×3] \x1b
  if (payload.length < 4 || payload[0] !== 0x1B) {
    connLog.debug('[world] short/non-ESC payload — ignoring');
    return;
  }

  if (!verifyInboundGameCRC(payload)) {
    connLog.warn('[world] inbound CRC mismatch (seq=0x%s) — processing anyway', payload[1].toString(16));
  }

  const seq = payload[1] - 0x21;

  // ACK request: seq byte > 42 means client wants an ACK.
  // Reply format: [0x22, seq + 0x2b] wrapped in ARIES type-0.
  if (seq > 42) {
    const ackPayload = Buffer.from([0x22, seq + 0x2b]);
    connLog.debug('[world] seq=%d > 42 → sending ACK', seq);
    send(session.socket, buildPacket(Msg.SYNC, ackPayload), capture, 'WORLD_ACK');
    return;
  }

  const cmdIdx = payload[2] - 0x21;
  connLog.info('[world] client seq=%d cmd=%d', seq, cmdIdx);

  if (cmdIdx === 3) {
    if (session.worldInitialized) {
      connLog.debug('[world] duplicate cmd-3 after initialization — ignoring');
      return;
    }
    // Cmd-3: client capabilities / ready signal (RPS mode).
    // Called by FUN_0040d3c0 immediately after the world-MMW welcome is received.
    // Respond with the world initialization sequence exactly once.
    connLog.info('[world] cmd-3 (client-ready) → sending world init sequence');
    sendWorldInitSequence(players, session, connLog, capture);
    session.worldInitialized = true;
    notifyRoomArrival(players, session, connLog);

  } else if (cmdIdx === 1) {
    // Cmd-1 PingAck: client acknowledging a server ping; no server reply needed.
    connLog.debug('[world] cmd-1 (ping-ack) — noted');

  } else if (cmdIdx === 2) {
    // Cmd-2 PingRequest: client requesting a latency probe reply.
    // COMMEG32 Ordinal_7 sends the reply directly; server does not need to act.
    connLog.debug('[world] cmd-2 (ping-request) — client handles reply via COMMEG32');

  } else if (cmdIdx === 4) {
    const parsed = parseClientCmd4(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-4 parse failed');
      return;
    }
    handleWorldTextCommand(players, session, parsed.text, connLog, capture);

  } else if (cmdIdx === 5) {
    const parsed = parseClientCmd5SceneAction(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-5 scene action parse failed');
      return;
    }
    connLog.info('[world] cmd-5 scene action: type=%d', parsed.actionType);
    if (parsed.actionType === 4) {
      sendSolarisTravelMap(session, connLog, capture);
      return;
    }
    connLog.warn('[world] cmd-5 unsupported scene action type=%d', parsed.actionType);

  } else if (cmdIdx === 10) {
    const parsed = parseClientCmd10MapReply(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-10 map reply parse failed');
      return;
    }
    handleMapTravelReply(players, session, parsed.contextId, parsed.selection, parsed.selectedRoomId, connLog, capture);

  } else if (cmdIdx === 21) {
    const parsed = parseClientCmd21TextReply(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-21 parse failed');
      return;
    }
    handleComstarTextReply(players, session, parsed.dialogId, parsed.text, connLog, capture);

  } else if (cmdIdx === 23) {
    const parsed = parseClientCmd23LocationAction(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-23 location action parse failed');
      return;
    }
    handleLocationAction(players, session, parsed.slot, parsed.targetCached, connLog, capture);

  } else if (cmdIdx === 7) {
    const parsed = parseClientCmd7(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-7 parse failed');
      return;
    }

    connLog.info('[world] cmd-7 menu reply: listId=%d selection=%d', parsed.listId, parsed.selection);
    if (parsed.listId === 3) {
      handleRoomMenuSelection(players, session, parsed.selection, connLog, capture);
      return;
    }

    if (parsed.listId === ALL_ROSTER_LIST_ID && parsed.selection > 0) {
      const target = findWorldTargetBySelectionId(players, parsed.selection - 1);
      if (!target) {
        connLog.warn('[world] all-roster selection target not found: selection=%d', parsed.selection);
        return;
      }
      sendInquiryMenu(session, target, connLog, capture);
      return;
    }

    if (parsed.listId === INQUIRY_MENU_ID && parsed.selection > 0) {
      const targetId = session.worldInquiryTargetId;
      if (targetId === undefined) {
        connLog.warn('[world] inquiry submenu reply with no active target');
        return;
      }

      const target = findWorldTargetBySelectionId(players, targetId);
      if (!target) {
        connLog.warn('[world] inquiry submenu target unavailable: target=%d', targetId);
        return;
      }

      if (parsed.selection === 1) {
        connLog.info(
          '[world] inquiry submenu: local ComStar compose expected for target=%d',
          targetId,
        );
        return;
      }

      if (parsed.selection === 2) {
        connLog.info('[world] inquiry submenu: personnel data for target=%d', targetId);
        sendPersonnelRecord(players, session, targetId, 1, connLog, capture);
        return;
      }

      connLog.warn('[world] inquiry submenu: unsupported selection=%d', parsed.selection);
      return;
    }

    if (parsed.listId === PERSONNEL_LIST_ID && parsed.selection > 0) {
      sendPersonnelRecord(players, session, parsed.selection - 1, 1, connLog, capture);
      return;
    }

    if (parsed.listId === PERSONNEL_MORE_ID && parsed.selection === 2) {
      if (session.worldInquiryTargetId === undefined) {
        connLog.warn('[world] cmd-7 personnel more with no active record target');
        return;
      }
      sendPersonnelRecord(players, session, session.worldInquiryTargetId, 2, connLog, capture);
      return;
    }

    connLog.debug('[world] cmd-7 ignored: unsupported listId=%d', parsed.listId);
  } else {
    connLog.debug('[world] cmd=%d — not yet handled (M3 stub)', cmdIdx);
  }
}

/**
 * Send the full world initialization sequence after cmd-3 (client-ready).
 *
 * Order:
 *   1. Cmd6 — show busy cursor (hourglass)
 *   2. Cmd4 — SceneInit (creates game window and sets g_chatReady=1)
 *   3. Cmd10 — RoomPresenceSync (self + current room occupants)
 *   4. Cmd3 — TextBroadcast (welcome message; requires g_chatReady=1)
 *   5. Cmd5 — restore normal cursor
 *
 * Cmd9 is intentionally omitted here. Newer RE ties it to the original
 * character name + allegiance prompt (`FUN_0040C310 -> FUN_0042DA40 ->
 * FUN_00413800(0x3fd, MPBT.MSG[5]) -> FUN_0042DAA0(MPBT.MSG[6])`), not a
 * passive world-entry roster sync. Cmd10 (`FUN_0040C370`) seeds the same
 * `DAT_004e1870` roster table later updated by Cmd13/Cmd11.
 */
function sendWorldInitSequence(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const { socket } = session;

  // Cmd6 — CursorBusy (hourglass while arena loads)
  send(socket, buildCmd6CursorBusyPacket(nextSeq(session)), capture, 'CMD6_BUSY');

  // Cmd4 — SceneInit: create the world scene, chat window, scene action
  // buttons, and up to four adjacent location icons.
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  connLog.info('[world] sending Cmd4 SceneInit (room=%d scene="%s" callsign="%s")', roomId, getSolarisRoomName(roomId), getDisplayName(session));
  send(socket, buildSceneInitForSession(session), capture, 'CMD4_SCENE_INIT');

  // Cmd10 — RoomPresenceSync: seed the live room roster table before later
  // Cmd13/Cmd11 incremental updates are applied.
  const roomPresenceEntries = currentRoomPresenceEntries(players, session);
  connLog.info('[world] sending Cmd10 RoomPresenceSync (%d entries)', roomPresenceEntries.length);
  send(
    socket,
    buildCmd10RoomPresenceSyncPacket(roomPresenceEntries, nextSeq(session)),
    capture,
    'CMD10_ROOM_SYNC',
  );

  // Cmd3 — TextBroadcast: welcome message. g_chatReady is set to 1 by Cmd4, so
  // this is the earliest point at which Cmd3 will be displayed by the client.
  send(socket, buildCmd3BroadcastPacket(WELCOME_TEXT, nextSeq(session)), capture, 'CMD3_WELCOME');

  // Cmd5 — CursorNormal: restore the arrow cursor.
  send(socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');

  connLog.info('[world] world init sequence complete');
}

// ── Connection handler ────────────────────────────────────────────────────────

function handleWorldConnection(socket: net.Socket, players: PlayerRegistry, log: Logger): void {
  const sessionId   = crypto.randomUUID();
  const remoteAddr  = `${socket.remoteAddress}:${socket.remotePort}`;
  const connLog     = log.child(sessionId.slice(0, 8));
  const capture     = new CaptureLogger(sessionId);
  const parser      = new PacketParser();
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  connLog.info('[world] client connected from %s (session %s)', remoteAddr, sessionId);
  worldCaptures.set(sessionId, capture);

  const session: ClientSession = {
    id:                sessionId,
    username:          '',
    phase:             'connected',
    roomId:            '',
    socket,
    connectedAt:       new Date(),
    bytesReceived:     0,
    mechListSent:      false,
    awaitingMechConfirm: false,
    serverSeq:         0,
    worldInitialized:  false,
    worldRosterId:     nextWorldRosterId++,
    worldPresenceStatus: 5,
  };
  players.add(session);

  // ── Data handler ─────────────────────────────────────────────────────────

  socket.on('data', (data: Buffer) => {
    session.bytesReceived += data.length;
    connLog.debug(
      '[world] recv %d bytes (total=%d, phase=%s)',
      data.length, session.bytesReceived, session.phase,
    );

    const packets = parser.push(data);
    for (const pkt of packets) {
      capture.logRecv(pkt.payload, pkt.streamOffset);
      connLog.debug(
        '[world] pkt type=0x%s tag=0x%s payloadLen=%d',
        pkt.type.toString(16).padStart(2, '0'),
        pkt.tag.toString(16),
        pkt.payload.length,
      );

      if (pkt.payload.length > 0) {
        connLog.debug('[world][rx]\n%s', hexDump(pkt.payload));
      }

      switch (pkt.type) {
        case Msg.LOGIN:
          handleWorldLogin(session, pkt.payload, connLog, capture).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            connLog.error('[world] uncaught error in handleWorldLogin: %s', msg);
            socket.destroy();
          });
          break;

        case Msg.SYNC:
          handleWorldGameData(players, session, pkt.payload, connLog, capture);
          break;

        case Msg.KEEPALIVE:
          connLog.debug('[world] keepalive response received');
          break;

        default:
          connLog.info(
            '[world] unhandled type=0x%s (phase=%s, payloadLen=%d)',
            pkt.type.toString(16), session.phase, pkt.payload.length,
          );
      }
    }
  });

  // ── Error / close ─────────────────────────────────────────────────────────

  socket.on('error', (err: Error) => {
    connLog.error('[world] socket error: %s', err.message);
  });

  socket.on('close', () => {
    connLog.info(
      '[world] client disconnected (phase=%s, bytes=%d)',
      session.phase, session.bytesReceived,
    );
    if (session.phase === 'world' && session.worldInitialized) {
      notifyRoomDeparture(players, session, connLog);
    }
    players.remove(session.id);
    worldCaptures.delete(session.id);
    if (keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
    }
    capture.close();
  });

  socket.setKeepAlive(true, 15_000);
  if (SOCKET_IDLE_TIMEOUT_MS > 0) {
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => {
      connLog.warn('[world] session timed out after %d ms, closing', SOCKET_IDLE_TIMEOUT_MS);
      socket.destroy();
    });
  }

  keepaliveTimer = ARIES_KEEPALIVE_INTERVAL_MS > 0
    ? setInterval(() => {
      if (socket.destroyed || !socket.writable) {
        return;
      }
      connLog.debug('[world] keepalive — sending ping');
      send(socket, buildPacket(Msg.KEEPALIVE, Buffer.alloc(0)), capture, 'WORLD_KEEPALIVE_PING');
    }, ARIES_KEEPALIVE_INTERVAL_MS)
    : undefined;
  keepaliveTimer?.unref();

  // ── Server speaks first ───────────────────────────────────────────────────
  session.phase = 'auth';
  const loginReq = buildLoginRequest();
  connLog.info('[world] sending LOGIN_REQUEST (%d bytes)', loginReq.length);
  send(socket, loginReq, capture, 'WORLD_LOGIN_REQUEST');
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create and start the world TCP server on WORLD_PORT.
 *
 * @param log      Root logger (world events logged under '[world]' prefix).
 * @param players  Shared player registry (world sessions registered here).
 * @returns        The net.Server instance (caller may attach error handlers).
 */
export function startWorldServer(log: Logger, players: PlayerRegistry): net.Server {
  const worldServer = net.createServer(socket =>
    handleWorldConnection(socket, players, log),
  );

  worldServer.on('error', (err: Error) => {
    log.error('[world] server error: %s', err.message);
    process.exit(1);
  });

  worldServer.listen(WORLD_PORT, '0.0.0.0', () => {
    const addr = worldServer.address() as net.AddressInfo;
    log.info('[world] ══════════════════════════════════════════════');
    log.info('[world]   Game World Server (M3)');
    log.info('[world]   Listening on 0.0.0.0:%d', addr.port);
    log.info('[world]   CRC seed: 0x0A5C25 (RPS / MMW path)');
    log.info('[world] ══════════════════════════════════════════════');
  });

  return worldServer;
}
