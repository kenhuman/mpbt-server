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
import * as path   from 'path';

import { WORLD_PORT, Msg } from './protocol/constants.js';
import { PacketParser, buildPacket, hexDump } from './protocol/aries.js';
import {
  parseLoginPayload,
  buildLoginRequest,
  buildSyncAck,
  buildWelcomePacket,
} from './protocol/auth.js';
import {
  parseClientCmd4,
  parseClientCmd7,
} from './protocol/game.js';
import {
  buildCmd3BroadcastPacket,
  buildCmd10RoomPresenceSyncPacket,
  buildCmd11PlayerEventPacket,
  buildCmd13PlayerArrivalPacket,
  buildCmd14PersonnelRecordPacket,
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
import { findCharacter } from './db/characters.js';

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

// Default arena name shown in the window title.
const DEFAULT_SCENE_NAME = 'Solaris Arena';
const WELCOME_TEXT       = 'Welcome to the game world.';
const DEFAULT_ROOM_ID    = 'world_default_room';
const ALL_ROSTER_LIST_ID = 0x3F4;
const PERSONNEL_LIST_ID  = 0x3F2;
const PERSONNEL_MORE_ID  = 0x95;
let nextWorldRosterId    = 1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: net.Socket, pkt: Buffer, capture: CaptureLogger, label: string): void {
  capture.logSend(pkt);
  socket.write(pkt);
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
  return ((session.displayName ?? session.username) || 'Pilot').slice(0, 84);
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
  const status = getPresenceStatus(session);
  if (status <= 5) return 'Standing';
  if (status <= 12) return `Booth ${status - 5}`;
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
      col2:   DEFAULT_SCENE_NAME,
      col3:   getPresenceLocation(other),
    }));
}

function buildPersonnelRecordLines(target: ClientSession, page: number): string[] {
  if (page <= 1) {
    return [
      'Rank     : Warrior',
      `House    : ${target.allegiance ?? 'Unaffiliated'}`,
      `Sector   : ${DEFAULT_SCENE_NAME}`,
      `Location : ${getPresenceLocation(target)}`,
      'Status   : Online',
      `Account  : ${target.username || 'Unknown'}`,
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
    other.socket.write(
      buildCmd11PlayerEventPacket(session.worldRosterId, status, callsign, nextSeq(other)),
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
): void {
  const clean = text.replace(/\x1b/g, '?').trim();
  if (clean.length === 0) {
    connLog.debug('[world] cmd-4 text ignored (empty)');
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

    other.socket.write(buildCmd3BroadcastPacket(line, nextSeq(other)));
  }
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
    other.socket.write(
      buildCmd13PlayerArrivalPacket(session.worldRosterId, callsign, nextSeq(other)),
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
    other.socket.write(
      buildCmd11PlayerEventPacket(session.worldRosterId, 0, callsign, nextSeq(other)),
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
  session.phase    = 'world';
  session.roomId   = DEFAULT_ROOM_ID;

  // Retrieve the mech the player picked in the lobby.
  const launch = launchRegistry.consume(session.username);
  if (launch) {
    session.selectedMechId   = launch.mechId;
    session.selectedMechSlot = launch.mechSlot;
    connLog.info(
      '[world-login] launch record found: mech=%s (id=%d slot=%d)',
      launch.mechTypeString, launch.mechId, launch.mechSlot,
    );
  } else {
    session.selectedMechId   = FALLBACK_MECH_ID;
    session.selectedMechSlot = 0;
    connLog.warn(
      '[world-login] no launch record for "%s" — using fallback mech_id=%d',
      session.username, FALLBACK_MECH_ID,
    );
  }

  // displayName and allegiance are set by the lobby before REDIRECT.
  // If missing (e.g. direct connection for testing), fall back to DB lookup.
  if (!session.displayName && session.accountId !== undefined) {
    const character = await findCharacter(session.accountId);
    if (character) {
      session.displayName = character.display_name;
      session.allegiance  = character.allegiance;
      connLog.info(
        '[world-login] character loaded from DB: displayName="%s" allegiance=%s',
        character.display_name, character.allegiance,
      );
    }
  }

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
    // Respond with the world initialization sequence.
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
    handleWorldTextCommand(players, session, parsed.text, connLog);

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
      sendPersonnelRecord(players, session, parsed.selection - 1, 1, connLog, capture);
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
 * Cmd9 is intentionally omitted here. Newer RE ties it to a room-occupant
 * inquiry flow (`FUN_0040C310 -> FUN_0042DA40 -> FUN_0040CA70 -> FUN_00412980`)
 * rather than a passive world-entry roster sync. Current best candidate for the
 * missing initial room-sync packet is Cmd10 (`FUN_0040C370`), which seeds the
 * same `DAT_004e1870` roster table later updated by Cmd13/Cmd11.
 */
function sendWorldInitSequence(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const { socket } = session;
  const mechId     = session.selectedMechId ?? FALLBACK_MECH_ID;
  // Prefer the character display name (set from DB after login); fall back to
  // the login username only when character data is unavailable.
  const callsign   = (session.displayName ?? session.username).slice(0, 84) || 'Pilot';

  // Cmd6 — CursorBusy (hourglass while arena loads)
  send(socket, buildCmd6CursorBusyPacket(nextSeq(session)), capture, 'CMD6_BUSY');

  // Cmd4 — SceneInit: create the arena, chat window, and scoreboard.
  //   sessionFlags 0x30 = has-opponents (0x10) + clear-arena-data (0x20).
  //   All 4 opponent slots are absent → wire values of 0 → stored as -1 → buttons hidden.
  //   callsign and sceneName are provided via the has-opponents (0x10) branch reads.
  const sceneInit = buildCmd4SceneInitPacket(
    {
      sessionFlags:     0x30,   // has-opponents + clear-arena resets
      playerScoreSlot:  0,
      playerMechId:     mechId,
      opponents:        [],     // all 4 slots = "no opponent" (wire 0x21 / [0x21,0x21])
      callsign,
      sceneName:        DEFAULT_SCENE_NAME,
      arenaOptions:     [],
    },
    nextSeq(session),
  );
  connLog.info('[world] sending Cmd4 SceneInit (mech_id=%d callsign="%s")', mechId, callsign);
  send(socket, sceneInit, capture, 'CMD4_SCENE_INIT');

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

  // Cmd3 — TextBroadcast: welcome message (only visible after g_chatReady=1, set by Cmd4).
  send(
    socket,
    buildCmd3BroadcastPacket(WELCOME_TEXT, nextSeq(session)),
    capture,
    'CMD3_WELCOME',
  );

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

  connLog.info('[world] client connected from %s (session %s)', remoteAddr, sessionId);

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
          connLog.debug('[world] keepalive — echoing');
          send(socket, buildPacket(Msg.KEEPALIVE, Buffer.alloc(0)), capture, 'KEEPALIVE');
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
    capture.close();
  });

  socket.setKeepAlive(true, 15_000);
  socket.setTimeout(120_000);
  socket.on('timeout', () => {
    connLog.warn('[world] session timed out, closing');
    socket.destroy();
  });

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
