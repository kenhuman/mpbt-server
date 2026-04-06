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
 *   Server → Client: Cmd9 RoomList     (set roster ready flag)
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
  buildCmd3BroadcastPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd6CursorBusyPacket,
  buildCmd9RoomPlayerListPacket,
} from './protocol/world.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { launchRegistry } from './state/launch.js';
import { loadMechs } from './data/mechs.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { findCharacter, createCharacter, ALLEGIANCES, type Allegiance, updateCharacterAllegiance } from './db/characters.js';

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

/**
 * Map of player-typed text → canonical allegiance.
 * Accepts numbers 1-5 or house names (lower-cased before lookup).
 * Confirmed cmd-4 wire format: client sends raw typed text as
 *   [length_hi = len/85 + 0x21] [length_lo = len%85 + 0x21] [raw ASCII bytes].
 */
const ALLEGIANCE_TEXT_MAP: Readonly<Record<string, Allegiance>> = {
  '1': 'Davion',  'davion':  'Davion',
  '2': 'Steiner', 'steiner': 'Steiner',
  '3': 'Liao',    'liao':    'Liao',
  '4': 'Marik',   'marik':   'Marik',
  '5': 'Kurita',  'kurita':  'Kurita',
};

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

  // Retrieve the mech the player picked in the lobby.
  const launch = launchRegistry.consume(session.username);
  if (launch) {
    session.selectedMechId   = launch.mechId;
    session.selectedMechSlot = launch.mechSlot;
    if (launch.accountId !== undefined) session.accountId   = launch.accountId;
    if (launch.displayName !== undefined) session.displayName = launch.displayName;
    if (launch.allegiance !== undefined) session.allegiance  = launch.allegiance;
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
      session.allegiance  = character.allegiance ?? undefined;
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
    // Cmd-3: client capabilities / ready signal (RPS mode).
    // Called by FUN_0040d3c0 immediately after the world-MMW welcome is received.
    // Respond with the world initialization sequence.
    connLog.info('[world] cmd-3 (client-ready) → sending world init sequence');
    sendWorldInitSequence(session, connLog, capture);

  } else if (cmdIdx === 1) {
    // Cmd-1 PingAck: client acknowledging a server ping; no server reply needed.
    connLog.debug('[world] cmd-1 (ping-ack) — noted');

  } else if (cmdIdx === 2) {
    // Cmd-2 PingRequest: client requesting a latency probe reply.
    // COMMEG32 Ordinal_7 sends the reply directly; server does not need to act.
    connLog.debug('[world] cmd-2 (ping-request) — client handles reply via COMMEG32');

  } else if (cmdIdx === 5) {
    // Cmd-5: allegiance selection from the character-creation wizard.
    // Triggered by FUN_0040d2d0 in MPBTWIN.EXE when the player clicks one of the
    // arenaOptions items (button IDs 0x101-0x105) in the Cmd4-driven picker UI.
    //
    // Wire format (args after seq+cmd):
    //   [1 byte: type+0x21]  — decoded as ALLEGIANCES array index (0-4)
    //
    // arenaOptions[0] (button 0x100) is hardcoded to Help and never sends cmd-5.
    // arenaOptions[1..5] have types 0..4 mapping directly to ALLEGIANCES indices:
    //   0=Davion, 1=Steiner, 2=Liao, 3=Marik, 4=Kurita
    if (payload.length < 4) {
      connLog.debug('[world] cmd-5 (allegiance-pick): payload too short');
      return;
    }
    const allegianceType = payload[3] - 0x21;
    if (allegianceType < 0 || allegianceType >= ALLEGIANCES.length) {
      connLog.warn('[world] cmd-5 (allegiance-pick): type=%d out of range', allegianceType);
      return;
    }
    const allegiance = ALLEGIANCES[allegianceType] as Allegiance;
    connLog.info('[world] cmd-5 (allegiance-pick): player chose %s', allegiance);
    applyAllegiancePick(session, allegiance, 'cmd-5', connLog, capture);

  } else if (cmdIdx === 4) {
    // Cmd-4: chat text from the player (FUN_0040d280 in MPBTWIN.EXE).
    // The player types text in the chat box and presses Enter; the client
    // sends the raw input string with a 2-byte base-85 length prefix:
    //   [hi = len/85 + 0x21] [lo = len%85 + 0x21] [raw ASCII bytes]
    // During first-login (session.allegiance === undefined) we parse the text
    // as a house name or number to select the player's allegiance faction.
    if (payload.length < 5) {
      connLog.debug('[world] cmd-4 (chat): payload too short');
      return;
    }
    const textLen = (payload[3] - 0x21) * 85 + (payload[4] - 0x21);
    if (textLen <= 0 || payload.length < 5 + textLen) {
      connLog.debug('[world] cmd-4 (chat): invalid text length=%d', textLen);
      return;
    }
    const chatText = payload.subarray(5, 5 + textLen).toString('latin1').trim();
    connLog.info('[world] cmd-4 (chat): text="%s"', chatText);

    if (session.allegiance !== undefined) {
      // Allegiance already set — ignore (normal chat during gameplay is not yet implemented).
      connLog.debug('[world] cmd-4 (chat): allegiance already set, ignoring');
      return;
    }

    const picked = ALLEGIANCE_TEXT_MAP[chatText.toLowerCase()];
    if (!picked) {
      connLog.info('[world] cmd-4 (chat): unrecognised allegiance text "%s"', chatText);
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          `"${chatText}" is not valid. Type 1-5 or: Davion Steiner Liao Marik Kurita`,
          nextSeq(session),
        ),
        capture,
        'CMD3_INVALID',
      );
      return;
    }
    connLog.info('[world] cmd-4 (chat): player chose %s', picked);
    applyAllegiancePick(session, picked, 'cmd-4', connLog, capture);

  } else {
    connLog.debug('[world] cmd=%d — not yet handled (M3 stub)', cmdIdx);
  }
}

/**
 * Shared handler called when the player selects their allegiance, regardless
 * of how the selection was delivered (cmd-5 button click or cmd-4 chat text).
 *
 * Persists the choice to the database (INSERT new character or UPDATE existing)
 * and then sends the post-allegiance arena reinit sequence to the client.
 */
function applyAllegiancePick(
  session:   ClientSession,
  allegiance: Allegiance,
  source:    string,
  connLog:   Logger,
  capture:   CaptureLogger,
): void {
  session.allegiance = allegiance;

  if (session.accountId !== undefined) {
    const displayName = session.displayName ?? session.username;
    // For first-time players the character does not yet exist in the DB (the
    // lobby deferred creation to here).  Try to INSERT; if the record already
    // exists (reconnect race / returning player edge-case) fall back to UPDATE.
    createCharacter(session.accountId, displayName, allegiance)
      .then(() => connLog.info(
        '[world] %s: character created (displayName="%s" allegiance=%s)',
        source, displayName, allegiance,
      ))
      .catch((err: unknown) => {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          // Character already exists — just update allegiance.
          updateCharacterAllegiance(session.accountId!, allegiance).catch((err2: unknown) => {
            const m2 = err2 instanceof Error ? err2.message : String(err2);
            connLog.error('[world] %s: failed to update allegiance: %s', source, m2);
          });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error('[world] %s: failed to create character: %s', source, msg);
        }
      });
  } else {
    connLog.warn('[world] %s: no accountId — allegiance not persisted to DB', source);
  }

  connLog.info('[world] %s: sending post-allegiance reinit (no wizard)', source);
  sendPostAllegianceReinit(session, allegiance, connLog, capture);
}

/**
 * Respond to the client after it sends cmd-5 (allegiance picked).
 *
 * The client calls FUN_00433ef0 (hourglass) right after sending cmd-5 and then
 * waits for the server.  We re-initialize the arena window with sessionFlags=0x30
 * (has-opponents | clear-arena) so that the client READS a new arenaOptions count
 * from the wire (flag 0x10 triggers wire-read in FUN_00414b70).  Sending count=0
 * clears DAT_004e6a70 on the client; without this, the client reuses the stale
 * count-6 from the initial Cmd4 and redraws the wizard.
 */
function sendPostAllegianceReinit(
  session:   ClientSession,
  allegiance: string,
  connLog:   Logger,
  capture:   CaptureLogger,
): void {
  const { socket } = session;
  const mechId    = session.selectedMechId ?? FALLBACK_MECH_ID;
  const callsign  = (session.displayName ?? session.username).slice(0, 84) || 'Pilot';

  // Cmd6 — hourglass while the arena reloads.
  send(socket, buildCmd6CursorBusyPacket(nextSeq(session)), capture, 'CMD6_BUSY');

  // Cmd4 — reinit WITH flag 0x10 so the client reads the new arenaOptions count
  // (0) from wire.  This zeroes DAT_004e6a70 and removes the wizard buttons.
  send(
    socket,
    buildCmd4SceneInitPacket(
      {
        sessionFlags:    0x30,  // has-opponents (0x10) + clear-arena (0x20)
        playerScoreSlot: 0,
        playerMechId:    mechId,
        opponents:       [],    // all 4 slots absent
        callsign,
        sceneName:       DEFAULT_SCENE_NAME,
        arenaOptions:    [],    // explicitly empty → writes count=0 to wire
      },
      nextSeq(session),
    ),
    capture,
    'CMD4_REINIT',
  );

  // Cmd9 — reset roster ready flag.
  send(socket, buildCmd9RoomPlayerListPacket([], nextSeq(session)), capture, 'CMD9_ROOM_LIST');

  // Cmd3 — notify the player of their allegiance.
  send(
    socket,
    buildCmd3BroadcastPacket(`Allegiance set to ${allegiance}.`, nextSeq(session)),
    capture,
    'CMD3_ALLEGIANCE',
  );

  // Cmd5 — restore arrow cursor (clears the hourglass).
  send(socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
}

/**
 * Send the full world initialization sequence after cmd-3 (client-ready).
 *
 * Order:
 *   1. Cmd6 — show busy cursor (hourglass)
 *   2. Cmd4 — SceneInit (creates game window and sets g_chatReady=1)
 *   3. Cmd9 — RoomPlayerList (empty room; sets roster ready flag)
 *   4. Cmd3 — TextBroadcast (welcome message; requires g_chatReady=1)
 *   5. Cmd5 — restore normal cursor
 */
function sendWorldInitSequence(
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
  // arenaOptions items render as a horizontal row at the top of the arena screen.
  // Item 0 (tag 0x100) is always routed to Help by the client; clicking it does not
  // send cmd-5.  Items 1-5 (tags 0x101-0x105) send cmd-5 with type=0..4 respectively.
  // Use the Great House family names so each label fits within the ~79-pixel button
  // width that the client computes for a 6-item row.
  const arenaOptions: Array<{ type: number; label: string }> =
    session.allegiance === undefined
      ? [
          // index 0 → button tag 0x100 → Help (spacer; not selectable)
          { type: 0, label: '< Choose >' },
          // index 1 → button tag 0x101 → cmd-5 type=0 → ALLEGIANCES[0]='Davion'
          { type: 0, label: 'Davion' },
          // index 2 → button tag 0x102 → cmd-5 type=1 → ALLEGIANCES[1]='Steiner'
          { type: 1, label: 'Steiner' },
          // index 3 → button tag 0x103 → cmd-5 type=2 → ALLEGIANCES[2]='Liao'
          { type: 2, label: 'Liao' },
          // index 4 → button tag 0x104 → cmd-5 type=3 → ALLEGIANCES[3]='Marik'
          { type: 3, label: 'Marik' },
          // index 5 → button tag 0x105 → cmd-5 type=4 → ALLEGIANCES[4]='Kurita'
          { type: 4, label: 'Kurita' },
        ]
      : []; // returning player — allegiance already set, no wizard needed

  const sceneInit = buildCmd4SceneInitPacket(
    {
      sessionFlags:     0x30,   // has-opponents + clear-arena resets
      playerScoreSlot:  0,
      playerMechId:     mechId,
      opponents:        [],     // all 4 slots = "no opponent" (wire 0x21 / [0x21,0x21])
      callsign,
      sceneName:        DEFAULT_SCENE_NAME,
      arenaOptions,
    },
    nextSeq(session),
  );
  connLog.info('[world] sending Cmd4 SceneInit (mech_id=%d callsign="%s")', mechId, callsign);
  send(socket, sceneInit, capture, 'CMD4_SCENE_INIT');

  // Cmd9 — RoomPlayerList: empty room, sets DAT_004ddfc0+0x44 = 8 (roster ready flag).
  send(
    socket,
    buildCmd9RoomPlayerListPacket([], nextSeq(session)),
    capture,
    'CMD9_ROOM_LIST',
  );

  // Cmd3 — TextBroadcast: welcome message (only visible after g_chatReady=1, set by Cmd4).
  // For new players send multiple lines listing the house options with numbers so
  // the player can type their choice in the chat box and press Enter.
  // The client also renders a horizontal row of arenaOptions buttons at the top of
  // the arena panel; clicking a house button sends cmd-5 as an alternative path.
  if (session.allegiance === undefined) {
    send(socket, buildCmd3BroadcastPacket('NEW PILOT: Choose your house allegiance by typing a number or name below, then press Enter:', nextSeq(session)), capture, 'CMD3_WELCOME');
    send(socket, buildCmd3BroadcastPacket('  1. Davion   2. Steiner   3. Liao   4. Marik   5. Kurita', nextSeq(session)), capture, 'CMD3_OPTIONS');
  } else {
    send(socket, buildCmd3BroadcastPacket(WELCOME_TEXT, nextSeq(session)), capture, 'CMD3_WELCOME');
  }

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
          handleWorldGameData(session, pkt.payload, connLog, capture);
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
