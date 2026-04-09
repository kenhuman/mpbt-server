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
  buildCombatWelcomePacket,
} from './protocol/auth.js';
import {
  buildCmd36MessageViewPacket,
  buildCmd37OpenComposePacket,
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
import { loadSolarisRooms, WorldRoom } from './data/maps.js';
import {
  storeMessage,
  claimUndeliveredMessages,
  markDelivered,
} from './db/messages.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { ARIES_KEEPALIVE_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from './config.js';

import {
  buildCmd72LocalBootstrapPacket,
  buildCmd65PositionSyncPacket,
  MOTION_NEUTRAL,
} from './protocol/combat.js';

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


/** Fast lookup from mech ID to MechEntry (for extraCritCount etc.). */
const WORLD_MECH_BY_ID = new Map(WORLD_MECHS.map(m => [m.id, m]));

// Default arena name shown in the window title.
const DEFAULT_SCENE_NAME = 'Solaris Arena';
const WELCOME_TEXT       = 'Welcome to the game world.';
const DEFAULT_MAP_ROOM_ID = 146; // Solaris Starport

// ── Solaris room model ────────────────────────────────────────────────────────
// Loaded at startup from SOLARIS.MAP via parseMapFile().  Falls back to a
// hardcoded list when the proprietary map asset is absent so the server still
// starts during development without the full game data.

/** Hardcoded fallback used when SOLARIS.MAP is not present. */
const SOLARIS_FALLBACK_ROOMS: WorldRoom[] = [
  { roomId: 146, name: 'Solaris Starport',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 0 },
  { roomId: 147, name: 'Ishiyama Arena',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 1 },
  { roomId: 148, name: 'Government House',        flags: 0, centreX: 0, centreY: 0, sceneIndex: 2 },
  { roomId: 149, name: 'White Lotus',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 3 },
  { roomId: 150, name: 'Waterfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 4 },
  { roomId: 151, name: 'Kobe Slums',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 5 },
  { roomId: 152, name: 'Steiner Stadium',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 6 },
  { roomId: 153, name: 'Lyran Building',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 7 },
  { roomId: 154, name: 'Chahar Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 8 },
  { roomId: 155, name: 'Riverside',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 9 },
  { roomId: 156, name: 'Black Throne',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 10 },
  { roomId: 157, name: 'Factory',                 flags: 0, centreX: 0, centreY: 0, sceneIndex: 11 },
  { roomId: 158, name: 'Marik Tower',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 12 },
  { roomId: 159, name: 'Allman',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 13 },
  { roomId: 160, name: 'Riverfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 14 },
  { roomId: 161, name: 'Wasteland',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 15 },
  { roomId: 162, name: 'Jungle',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 16 },
  { roomId: 163, name: "Chancellor's Quarters",   flags: 0, centreX: 0, centreY: 0, sceneIndex: 17 },
  { roomId: 164, name: 'Middletown',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 18 },
  { roomId: 165, name: 'Rivertown',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 19 },
  { roomId: 166, name: 'Maze',                    flags: 0, centreX: 0, centreY: 0, sceneIndex: 20 },
  { roomId: 167, name: 'Davion Arena',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 21 },
  { roomId: 168, name: 'Sortek Building',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 22 },
  { roomId: 169, name: 'Guzman Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 23 },
  { roomId: 170, name: 'Marina',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 24 },
  { roomId: 171, name: 'Viewpoint',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 25 },
  { roomId: 1,   name: 'International Sector',    flags: 0, centreX: 0, centreY: 0, sceneIndex: 26 },
  { roomId: 2,   name: 'Kobe Sector',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 27 },
  { roomId: 3,   name: 'Silesia Sector',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 28 },
  { roomId: 4,   name: 'Montenegro Sector',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 29 },
  { roomId: 5,   name: 'Cathay Sector',           flags: 0, centreX: 0, centreY: 0, sceneIndex: 30 },
  { roomId: 6,   name: 'Black Hills Sector',      flags: 0, centreX: 0, centreY: 0, sceneIndex: 31 },
];

let solarisRooms: WorldRoom[];
try {
  const loaded = loadSolarisRooms();
  if (loaded) {
    solarisRooms = loaded;
    process.stderr.write(`[world] loaded ${loaded.length} rooms from SOLARIS.MAP\n`);
  } else {
    solarisRooms = SOLARIS_FALLBACK_ROOMS;
    process.stderr.write('[world] WARNING: SOLARIS.MAP not found — using hardcoded room list\n');
  }
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[world] WARNING: failed to parse SOLARIS.MAP: ${msg}\n`);
  solarisRooms = SOLARIS_FALLBACK_ROOMS;
}

const SOLARIS_ROOM_BY_ID = new Map<number, WorldRoom>(
  solarisRooms.map(room => [room.roomId, room]),
);
const ALL_ROSTER_LIST_ID = 0x3F4;
// 0x3E8 (1000) is reserved by the client for its own local "Personal inquiry on:"
// submenu (FUN_00412980).  Sending Cmd7 with that listId triggers special client
// handling that ignores our payload and uses a garbage internal target_id.  Use
// any non-reserved positive integer instead (see RESEARCH.md §11 avoid-list).
const INQUIRY_MENU_ID    = 0x3F3;  // 1011 — safe, not in client avoid-list
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

function getSolarisRoomInfo(roomId: number): WorldRoom {
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

/**
 * Return up to 4 exit room IDs for a given room.
 *
 * When SOLARIS.MAP was loaded (rooms have real coordinates), assign one room
 * per cardinal quadrant (N/E/S/W) using the closest room whose centroid lies
 * in that half-plane.  This keeps directional navigation consistent — the room
 * you arrived from always ends up in the opposite slot.
 *
 * When running on the hardcoded fallback (all centroids are 0,0), use the
 * provisional linear topology: room 146 is the Solaris hub, each Solaris room
 * connects back to the hub and to its immediate neighbours in the list, and
 * each Solaris room also connects to its sector row.
 */
function getSolarisRoomExits(roomId: number): number[] {
  const room = getSolarisRoomInfo(roomId);
  const hasRealCoords = room.centreX !== 0 || room.centreY !== 0;

  if (hasRealCoords) {
    // Directional adjacency: assign the closest room per cardinal quadrant
    // (slot 0=N, 1=E, 2=S, 3=W).  A plain distance sort would place the room
    // you just arrived from in the same slot every time, causing oscillation.
    // With quadrant assignment the origin room always ends up in the opposite
    // slot, so "keep going east" never bounces you back west.
    type SlotCandidate = { roomId: number; dist: number };
    const bySlot: (SlotCandidate | null)[] = [null, null, null, null];

    for (const r of solarisRooms) {
      if (r.roomId === roomId) continue;
      if (r.centreX === 0 && r.centreY === 0) continue;
      const dx = r.centreX - room.centreX;
      const dy = r.centreY - room.centreY;
      const dist = Math.hypot(dx, dy);
      // Pick the cardinal slot whose axis dominates.
      // Map Y increases downward (screen coords), so dy>0 → S.
      const slot = Math.abs(dx) >= Math.abs(dy)
        ? (dx > 0 ? 1 : 3)   // E=1, W=3
        : (dy > 0 ? 2 : 0);  // S=2, N=0
      const best = bySlot[slot];
      if (!best || dist < best.dist) {
        bySlot[slot] = { roomId: r.roomId, dist };
      }
    }

    return bySlot
      .filter((c): c is SlotCandidate => c !== null)
      .map(c => c.roomId);
  }

  // Provisional topology fallback (hardcoded room list, no real coordinates).
  if (roomId === 146) return [147, 152, 157, 162];

  const index = solarisRooms.findIndex(r => r.roomId === roomId);
  const exits = [146];

  if (index > 0) exits.push(solarisRooms[index - 1].roomId);
  if (index >= 0 && index < solarisRooms.length - 1) exits.push(solarisRooms[index + 1].roomId);

  if (roomId >= 147 && roomId <= 171) {
    const sectorOffset = Math.floor((roomId - 147) / 5);
    exits.push(solarisRooms[26 + Math.min(sectorOffset, 5)].roomId);
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
      // The client special-cases the first Cmd4 option button (0x100) as local Help.
      // Put server actions at 0x101+ so FUN_00413790 emits cmd 5 with the type byte.
      arenaOptions:     [
        { type: 0, label: 'Help' },
        { type: 4, label: 'Travel' },
      ],
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

  const senderName   = getDisplayName(session);
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
function sendCombatBootstrapSequence(
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
      globalA:            0,
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
      remainingActorCount: 0,     // solo arena — no remote actors
      unknownType1Raw:    MOTION_NEUTRAL,
      mech: {
        mechId,
        critStateExtraCount:  extraCritCount,
        criticalStateBytes:   Array<number>(critBytes).fill(0),
        extraStateBytes:      [],
        armorLikeStateBytes:  Array<number>(11).fill(0),  // full armor
        internalStateBytes:   Array<number>(8).fill(0),   // full internals
        ammoStateValues:      [],
        actorDisplayName:     callsign.substring(0, 31),
      },
    },
    nextSeq(session),
  );

  connLog.info('[world] sending Cmd72 combat bootstrap (mech_id=%d callsign="%s")', mechId, callsign);
  send(socket, cmd72, capture, 'CMD72_COMBAT_BOOTSTRAP');

  // 3. Cmd65 — initial position for the local actor at the origin.
  //    Gives the client something to render immediately after bootstrap.
  //    facing/throttle/legVel/speedMag = 0 (stationary, no heading).
  const cmd65 = buildCmd65PositionSyncPacket(
    { slot: 0, x: 0, y: 0, z: 0, facing: 0, throttle: 0, legVel: 0, speedMag: 0 },
    nextSeq(session),
  );
  send(socket, cmd65, capture, 'CMD65_INITIAL_POSITION');

  session.combatInitialized = true;
  connLog.info('[world] combat entry complete for "%s"', callsign);
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

  const senderStatus = getPresenceStatus(session);
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

  if (contextId !== SOLARIS_TRAVEL_CONTEXT_ID) {
    connLog.warn('[world] cmd-10 map reply unexpected context=%d (expected %d)', contextId, SOLARIS_TRAVEL_CONTEXT_ID);
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
  if (session.phase !== 'world' && session.phase !== 'combat') {
    connLog.debug('[world] SYNC in phase=%s (len=%d) — ignoring', session.phase, payload.length);
    return;
  }

  connLog.debug('[world] rx type-0 len=%d\n%s', payload.length, hexDump(payload));

  // Frame: \x1b [seq+0x21] [cmd+0x21] [args] [0x20] [CRC×3] \x1b
  if (payload.length < 4 || payload[0] !== 0x1B) {
    connLog.debug('[world] short/non-ESC payload — ignoring');
    return;
  }

  if (!verifyInboundGameCRC(payload, session.phase === 'combat')) {
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

    // Deliver any ComStar messages that arrived while this player was offline.
    const recipientAccountId = session.accountId;
    if (recipientAccountId !== undefined) {
      claimUndeliveredMessages(recipientAccountId)
        .then((pending) => {
          if (pending.length === 0) return;
          connLog.info('[world] delivering %d pending ComStar message(s)', pending.length);
          const deliveredIds: number[] = [];
          for (const msg of pending) {
            if (session.socket.destroyed) break;
            session.socket.write(
              buildCmd36MessageViewPacket(msg.sender_comstar_id, msg.body, nextSeq(session)),
            );
            deliveredIds.push(msg.id);
          }
          if (deliveredIds.length > 0) {
            markDelivered(deliveredIds).catch((err: unknown) => {
              const e = err instanceof Error ? err.message : String(err);
              connLog.error('[world] failed to mark ComStar messages delivered: %s', e);
            });
          }
          connLog.info('[world] delivered %d ComStar message(s)', deliveredIds.length);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error('[world] failed to claim/deliver pending ComStar messages: %s', msg);
        });
    }

  } else if (cmdIdx === 1) {
    // Cmd-1 PingAck: client acknowledging a server ping; no server reply needed.
    connLog.debug('[world] cmd-1 (ping-ack) — noted');

  } else if (cmdIdx === 2) {
    // Cmd-2 PingRequest: client requesting a latency probe reply.
    // COMMEG32 Ordinal_7 sends the reply directly; server does not need to act.
    connLog.debug('[world] cmd-2 (ping-request) — client handles reply via COMMEG32');

  } else if (cmdIdx === 4) {
    if (session.phase === 'combat') {
      connLog.debug('[world] cmd-4 in combat phase — different encoding, ignoring');
      return;
    }
    const parsed = parseClientCmd4(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-4 parse failed');
      return;
    }
    // "/fight" command: trigger combat bootstrap if not already in combat.
    if (parsed.text.trim().toLowerCase() === '/fight') {
      if (!session.combatInitialized && session.phase === 'world') {
        sendCombatBootstrapSequence(session, connLog, capture);
      } else {
        connLog.debug('[world] /fight ignored: combatInitialized=%s phase=%s',
          session.combatInitialized, session.phase);
      }
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
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 travel-map request ignored outside world phase: phase=%s', session.phase);
        return;
      }
      sendSolarisTravelMap(session, connLog, capture);
      return;
    }
    connLog.warn('[world] cmd-5 unsupported scene action type=%d', parsed.actionType);

  } else if (cmdIdx === 10) {
    if (session.phase !== 'world') {
      connLog.debug('[world] cmd-10 ignored outside world phase: phase=%s', session.phase);
      return;
    }
    const parsed = parseClientCmd10MapReply(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-10 map reply parse failed');
      return;
    }
    if (parsed.contextId !== SOLARIS_TRAVEL_CONTEXT_ID) {
      connLog.warn('[world] cmd-10 ignored: unexpected map contextId=%d', parsed.contextId);
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
          '[world] inquiry submenu: sending Cmd37 open-compose for target=%d',
          targetId,
        );
        send(
          session.socket,
          buildCmd37OpenComposePacket(targetId, nextSeq(session)),
          capture,
          'CMD37_OPEN_COMPOSE',
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
  } else if (session.phase === 'combat') {
    // Combat-mode inbound frame (client sends Cmd8/Cmd9 for movement/fire).
    if (cmdIdx === 20) {
      // Cmd20 — "examine self": correct combat-mode response is unconfirmed.
      // Sending the lobby-phase buildCmd20Packet here (world CRC seed) caused
      // the client to dispatch a garbage byte as "command 13 not handled".
      // Drop silently until the combat-specific response format is captured.
      connLog.debug('[world/combat] cmd-20 examine-self — no response (combat response unconfirmed)');
    } else {
      // Exact encoding of combat client→server cmd indices is unconfirmed
      // (live capture needed for Cmd8/9 movement); log and drop.
      connLog.debug('[world/combat] inbound combat cmd=%d len=%d — not yet handled', cmdIdx, payload.length);
    }
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
    if (session.worldInitialized) {
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
