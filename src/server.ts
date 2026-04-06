/**
 * MPBT ARIES Server Emulator — entry point.
 *
 * Protocol flow (CONFIRMED by RE of COMMEG32.DLL + INITAR.DLL):
 *
 *   1. Client connects (MPBTWIN.EXE configures address via play.pcgi server=host:port).
 *   2. Server sends LOGIN_REQUEST (type 0x16, empty payload) immediately.
 *   3. COMMEG32.DLL responds by calling FUN_10001420 → sends LOGIN packet (type 0x15).
 *   4. Server parses the LOGIN packet, extracts username/password.
 *   5. Server sends SYNC (type 0x00) as acknowledgment.
 *   6. Further game packets TBD (capture-driven).
 *
 * Run with:
 *   npx ts-node src/server.ts
 *   node dist/server.js
 */

import * as net from 'net';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';

import { ARIES_PORT, Msg } from './protocol/constants.js';
import { PacketParser, buildPacket, hexDump } from './protocol/aries.js';
import { parseLoginPayload, buildLoginRequest, buildSyncAck, buildWelcomePacket } from './protocol/auth.js';
import { buildMechListPacket, buildMenuDialogPacket, buildRedirectPacket, buildCmd20Packet, parseClientCmd7, decodeArgType4, type MechEntry } from './protocol/game.js';
import { loadMechs } from './data/mechs.js';
import { MECH_STATS } from './data/mech-stats.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';

// ── Global state ──────────────────────────────────────────────────────────────

const log = new Logger('server', 'debug', path.join('logs', 'server.log'));
const players = new PlayerRegistry();

// Advertised host sent in REDIRECT packets.
// Set SERVER_HOST env var to the server's LAN/public IP for non-local clients.
// Defaults to 127.0.0.1 (loopback only — works when client is on the same machine).
const SERVER_HOST = process.env['SERVER_HOST'] ?? '127.0.0.1';

const MECH_SEND_LIMIT = 20; // Client (FUN_0043A370) stores mechs in parallel static arrays.
                           // Array stride analysis (Ghidra RE):
                           //   DAT_004dc510 (slot_info, int×N) + N×4 = DAT_004dc560 (mech_id)
                           //   gap = 0x4DC560 - 0x4DC510 = 0x50 = 80 bytes / 4 = 20 entries.
                           //   Entry 21 writes slot_info[20] into mech_id[0] → immediate corruption.
                           // All parallel arrays (typeString/variant@ stride 40, name@ stride 20)
                           // confirm the same 20-entry capacity.  Hard limit: do not exceed 20.
                           // TODO (M9): replace with player-specific roster assignment.

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: net.Socket, pkt: Buffer, capture: CaptureLogger, label: string): void {
  capture.logSend(pkt);
  socket.write(pkt);
}

/**
 * Build the examine-dialog text for cmd-20 (X key / Examine button).
 *
 * Returns a ≤84-byte string ready for buildCmd20Args().  Lines are separated by
 * '\\' (0x5C).  FUN_00433310 (lobby text renderer) treats '\\' as a forced line
 * break: it NULs it in the staging buffer before passing to FUN_00431f10, so no
 * backslash is ever rendered.  Only NUL and '\\' terminate a line; 0x8D is NOT
 * handled and causes signed-char wrap (index -460) in FUN_00431e00's font table.
 *
 * The returned string MUST NOT contain 0x1B (ESC) because the client's ESC
 * accumulator (FUN_00429510) would prematurely terminate the inner frame.
 *
 * We send the text DIRECTLY instead of the legacy "#NNN" shortcode.  The "#NNN"
 * path does a client-side lookup in DAT_00473ad8[mech_id] → MPBT.MSG line → stats
 * string, but the MPBT.MSG in this distribution has "Mechs now in use:" at the
 * expected line (252) rather than actual mech stats.  Sending the formatted text
 * from the server bypasses the broken lookup entirely.
 */
function buildMechExamineText(mech: MechEntry): string {
  const SEP = '\x5c'; // 0x5C ('\') — lobby dialog line-break in FUN_00433310.
                      // FUN_00433310 NULs the '\' in the line buffer before calling
                      // FUN_00431f10, so it forces a new line without being rendered.
                      // 0x8D was wrong: FUN_00431e00 indexes the font-width table with
                      // signed-char arithmetic → 0x8D = -115 → offset -460 → bad memory.
  // Strip 0x1B (ESC) from any field that feeds into the packet.  buildCmd20Args
  // (and encodeString) now check the encoded Buffer for 0x1B and throw, which
  // would propagate as an uncaught exception and crash the server process.
  const sanitize = (s: string) => s.replace(/\x1b/g, '');

  const stats = MECH_STATS.get(mech.typeString);

  if (!stats || stats.disabled) {
    // No documented stats: show designation and weight class if known.
    const safeType = sanitize(mech.typeString);
    const cls = stats ? sanitize(stats.weightClass.charAt(0).toUpperCase() + stats.weightClass.slice(1)) : '';
    return cls ? `${safeType}${SEP}${cls} Class` : safeType;
  }

  // Known mech: build a compact but informative summary.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const safeType = sanitize(mech.typeString);
  const safeName = stats.name ? sanitize(stats.name) : '';
  const title = safeName ? `${safeType}  ${safeName}` : safeType;
  const specParts: string[] = [sanitize(cap(stats.weightClass))];
  if (stats.tonnage != null) specParts.push(`${stats.tonnage}T`);
  if (stats.maxSpeedKph != null) specParts.push(`${stats.maxSpeedKph}kph`);
  if (stats.jumpMeters != null) specParts.push(`Jump:${stats.jumpMeters}m`);
  const specs = specParts.join('  ');
  const arms  = Array.isArray(stats.armament) && stats.armament.length > 0
    ? sanitize(stats.armament.join(' '))
    : '';

  const lines = [title];
  if (specs) lines.push(specs);
  if (arms) lines.push(arms);
  const full  = lines.join(SEP);
  // Truncate to 84 bytes if the armament list is very long (safety guard).
  return Buffer.byteLength(full, 'latin1') <= 84 ? full : Buffer.from(full, 'latin1').subarray(0, 84).toString('latin1');
}

// ── Connection handler ────────────────────────────────────────────────────────

function handleConnection(socket: net.Socket): void {
  const sessionId = crypto.randomUUID();
  const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  const connLog = log.child(sessionId.slice(0, 8));

  connLog.info('Client connected from %s (session %s)', remoteAddr, sessionId);

  const capture = new CaptureLogger(sessionId);
  const parser = new PacketParser();

  const session: ClientSession = {
    id: sessionId,
    username: '',
    phase: 'connected',
    roomId: '',
    socket,
    connectedAt: new Date(),
    bytesReceived: 0,
    mechListSent: false,
    awaitingMechConfirm: false,
    serverSeq: 0,
  };
  players.add(session);

  // ── Data handler ────────────────────────────────────────────────────────────

  socket.on('data', (data: Buffer) => {
    session.bytesReceived += data.length;
    connLog.debug(
      'recv %d bytes (total=%d, phase=%s)',
      data.length,
      session.bytesReceived,
      session.phase,
    );

    const packets = parser.push(data);

    for (const pkt of packets) {
      capture.logRecv(pkt.payload, pkt.streamOffset);
      connLog.debug(
        'pkt type=0x%s tag=0x%s payloadLen=%d',
        pkt.type.toString(16).padStart(2, '0'),
        pkt.tag.toString(16),
        pkt.payload.length,
      );

      if (pkt.payload.length > 0) {
        connLog.debug('[rx]\n%s', hexDump(pkt.payload));
      }

      switch (pkt.type) {
        case Msg.LOGIN:
          handleLogin(session, pkt.payload, connLog, capture);
          break;

        case Msg.SYNC:
          // Type-0x00: game data channel (bidirectional after auth).
          // Client sends its first packet (command index 0 = "client ready")
          // after receiving the WELCOME escape.  We respond with game state.
          handleGameData(session, pkt.payload, connLog, capture);
          break;

        case Msg.KEEPALIVE:
          // Echo keepalive back (client sends 0x05, server echoes 0x05)
          connLog.debug('[keepalive] echoing');
          send(socket, buildPacket(Msg.KEEPALIVE, Buffer.alloc(0)), capture, 'keepalive');
          break;

        default:
          connLog.info(
            '[rx] unhandled type=0x%s (phase=%s, payloadLen=%d)',
            pkt.type.toString(16),
            session.phase,
            pkt.payload.length,
          );
      }
    }
  });

  // ── Error / close handlers ──────────────────────────────────────────────────

  socket.on('error', (err: Error) => {
    connLog.error('Socket error: %s', err.message);
  });

  socket.on('close', () => {
    connLog.info('Client disconnected (phase=%s, bytes=%d)', session.phase, session.bytesReceived);
    players.remove(session.id);
    capture.close();
  });

  // ── TCP keep-alive ──────────────────────────────────────────────────────────
  socket.setKeepAlive(true, 15_000);
  socket.setTimeout(120_000);
  socket.on('timeout', () => {
    connLog.warn('Session timed out, closing');
    socket.destroy();
  });

  // ── SERVER SPEAKS FIRST ─────────────────────────────────────────────────────
  // COMMEG32.DLL FUN_100014e0 case 0x16: when LOGIN_REQUEST arrives, it calls
  // FUN_10001420() which builds and sends the type-0x15 LOGIN packet.
  session.phase = 'auth';
  const loginReq = buildLoginRequest();
  connLog.info('Sending LOGIN_REQUEST (0x16) — %d bytes', loginReq.length);
  send(socket, loginReq, capture, 'LOGIN_REQUEST');
}

// ── Login handler ─────────────────────────────────────────────────────────────

function handleLogin(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.phase !== 'auth') {
    connLog.warn('[login] received LOGIN in phase %s — ignoring', session.phase);
    return;
  }

  const result = parseLoginPayload(payload, connLog);
  if (!result) {
    connLog.debug('[login] incomplete payload, waiting for more data');
    return;
  }

  if (!result.ok) {
    connLog.warn('[login] rejected: %s', result.reason);
    session.socket.destroy();
    return;
  }

  const { login } = result;
  session.username = login.username || '(unknown)';
  session.phase = 'lobby';

  connLog.info(
    '[login] accepted: user="%s" service="%s" clientVer="%s"',
    login.username,
    login.serviceId,
    login.clientVer,
  );

  // Send SYNC acknowledgment (type 0x00, empty payload) — establishes timing.
  // COMMEG32 case-0 fires WM 0x7f0 with length=0; FUN_00429a00 does nothing
  // (param_2=0 skips the byte loop) but stores timing state for subsequent packets.
  const syncAck = buildSyncAck(Date.now());
  connLog.info('[login] sending SYNC ack — %d bytes', syncAck.length);
  send(session.socket, syncAck, capture, 'SYNC');

  // Send welcome data (type 0x00, payload = "\x1b?MMW Copyright Kesmai Corp. 1991").
  // COMMEG32 fires WM 0x7f0 again; this time FUN_00429a00 accumulates the ESC
  // sequence, strcmp-matches DAT_00474d48, sets DAT_004e2de8=1, and the game
  // advances to the main loop (FUN_00433ef0 + FUN_00429580 + ...).
  const welcomePkt = buildWelcomePacket();
  connLog.info('[login] sending WELCOME escape — %d bytes', welcomePkt.length);
  send(session.socket, welcomePkt, capture, 'WELCOME');
}

// ── Game-data handler ─────────────────────────────────────────────────────────
// Handles type-0x00 packets in 'lobby' phase.
//
// Lobby command flow (client → server → client):
//   cmd  3 (client-ready)   → server sends cmd 26 (mech list)
//   cmd 20 (examine mech)   → server TODO: send mech stats
//   cmd  7 (mech select)    → server sends cmd  7 (confirm dialog)
//   cmd  7 (confirm pick)   → server sends type-0x03 REDIRECT — game world

// ARIES list-id used for our mech-confirm dialog (any value ≠ client special IDs).
const CONFIRM_DIALOG_ID = 2;

// Sample mech roster — one Shadowhawk entry so the UI has something to show.
// Mech roster loaded from mechdata/*.MEC at startup.
// See src/data/mechs.ts — no names are hardcoded; the client resolves chassis
// display names internally via MechWin_LookupMechName (FUN_00438280).
const MECHS: MechEntry[] = (() => {
  try {
    return loadMechs();
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error('Failed to load mechs: %s', message);
    throw err;
  }
})();
log.info('Loaded %d mechs from mechdata/', MECHS.length);

/**
 * Advance and return the server's outgoing sequence number.
 * Sequence values 0–42 are valid data frames (val ≤ 42 → proceed in client pre-handler).
 * Confirmed from Lobby_SeqHandler (FUN_0040C2A0): values > 42 are treated as ACK requests.
 */
function nextSeq(session: ClientSession): number {
  const s = session.serverSeq;
  session.serverSeq = (session.serverSeq + 1) % 43; // 0..42 inclusive
  return s;
}

function handleGameData(
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.phase !== 'lobby') {
    connLog.debug('[game] type-0 in phase=%s (len=%d) — ignoring', session.phase, payload.length);
    return;
  }

  connLog.debug('[game] rx type-0 len=%d\n%s', payload.length, hexDump(payload));

  // Frame format: \x1b [seq+0x21] [cmd+0x21] [args] [0x20] [CRC×3] \x1b
  // payload[0]=0x1B  payload[1]=seq byte  payload[2]=cmd byte
  if (payload.length < 4 || payload[0] !== 0x1B) {
    connLog.debug('[game] short/non-ESC payload — ignoring');
    return;
  }

  const seq = payload[1] - 0x21;

  // ACK request: client uses seq > 42 to request server acknowledgment.
  // Lobby_SendAck (FUN_0040c280) confirmed: reply = raw bytes [0x22, val+0x2b]
  // wrapped in ARIES type-0. val = seq byte - 0x21, which is `seq` here.
  if (seq > 42) {
    const ackPayload = Buffer.from([0x22, seq + 0x2b]);
    connLog.debug('[game] seq=%d > 42 → sending ACK [0x22, 0x%s]', seq, (seq + 0x2b).toString(16));
    send(session.socket, buildPacket(Msg.SYNC, ackPayload), capture, 'ACK');
    return;
  }

  const cmdIdx = payload[2] - 0x21;
  connLog.info('[game] client seq=%d cmd=%d', seq, cmdIdx);

  if (cmdIdx === 3 && !session.mechListSent) {
    // cmd 3 = client-ready (FUN_0040d3c0): send mech list exactly once.
    // FUN_0043A370 reads it → FUN_00439f70 creates the mech-selection window.
    //
    // The client stores mech entries in fixed-size static arrays; the UI shows
    // 4 slots. Cap at MECH_SEND_LIMIT until player-specific roster assignment is implemented.
    // TODO: load player-specific mech assignments rather than the global catalog.
    const mechsToSend = MECHS.slice(0, MECH_SEND_LIMIT);
    connLog.info('[game] client-ready → sending MECH LIST (cmd 26) — %d mechs (capped at %d)', mechsToSend.length, MECH_SEND_LIMIT);
    const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
    send(session.socket, mechPkt, capture, 'MECH_LIST');
    session.mechListSent = true;

  } else if (cmdIdx === 7) {
    // cmd 7: mech-window selection (listId=typeFlag=0) or confirm-dialog reply.
    const parsed = parseClientCmd7(payload);
    if (!parsed) {
      connLog.warn('[game] cmd 7 parse failed (len=%d)', payload.length);
      return;
    }
    const { listId, selection } = parsed;
    connLog.info('[game] cmd 7: listId=%d selection=%d awaitConfirm=%s',
      listId, selection, session.awaitingMechConfirm);

    if (listId === 0 && selection > 0 && session.mechListSent && !session.awaitingMechConfirm) {
      // Mech-window selection: user picked a mech (selection = mech.slot + 1).
      // Send server cmd-7 confirmation dialog — FUN_004112b0 shows a numbered menu.
      // Two options: 1=Launch! 2=Cancel. ESC from inside this dialog type sends
      // cmd 0x1D (handled below); both ESC and the Cancel item re-send the mech
      // list so the client returns to the mech selection screen.
      connLog.info('[game] mech selected (slot=%d) → sending CONFIRM dialog', selection - 1);
      const confirmPkt = buildMenuDialogPacket(CONFIRM_DIALOG_ID, 'CONFIRM', ['Launch!', 'Cancel'], nextSeq(session));
      send(session.socket, confirmPkt, capture, 'CONFIRM_DIALOG');
      session.awaitingMechConfirm = true;

    } else if (listId === CONFIRM_DIALOG_ID && selection > 0 && session.awaitingMechConfirm) {
      if (selection === 1) {
        // Item 1 = "Launch!" → redirect to game world.
        // COMMEG32.DLL case 3: 120-byte payload [addr40|internet40|pw40],
        // then FUN_100011c0 opens a new TCP connection to addr.
        // No world listener exists yet (TODO M3). Redirect back to ARIES_PORT
        // so the client re-connects to this server rather than hitting a dead port.
        // When M3 is implemented, change this to WORLD_PORT and open a second listener.
        connLog.info('[game] confirmed (Launch!) → sending REDIRECT to %s:%d (ARIES_PORT; world listener not yet implemented)', SERVER_HOST, ARIES_PORT);
        // IMPORTANT: addr must be "host:port" format.
        // Aries_OpenSocket (COMMEG32.DLL) calls strchr(addr, ':') and returns -1
        // immediately if ':' is not found, silently failing the secondary connection.
        // SERVER_HOST defaults to 127.0.0.1 (loopback); set the SERVER_HOST env var
        // to the server's LAN/public IP for clients connecting from another machine.
        const redir = buildRedirectPacket(`${SERVER_HOST}:${ARIES_PORT}`);
        send(session.socket, redir, capture, 'REDIRECT');
        session.phase = 'closing';
      } else if (selection === 2) {
        // Item 2 = "Cancel" → dismiss dialog, re-send mech list so client returns
        // to mech selection screen.
        connLog.info('[game] cancelled → re-sending mech list');
        session.awaitingMechConfirm = false;
        const mechsToSend = MECHS.slice(0, MECH_SEND_LIMIT);
        const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
        send(session.socket, mechPkt, capture, 'MECH_LIST');
      } else {
        connLog.warn('[game] CONFIRM dialog: unexpected selection=%d — ignoring', selection);
      }

    } else {
      connLog.debug('[game] cmd 7 ignored (listId=%d sel=%d mechSent=%s awaitConfirm=%s)',
        listId, selection, session.mechListSent, session.awaitingMechConfirm);
    }

  } else if (cmdIdx === 0x1D) {
    // cmd 0x1D (29) = ESC/cancel pressed in a menu dialog.
    // Client format confirmed: [Frame_ReadByte(p1)] [type1 2B: p2] [type4 5B: p3]
    // Response: re-send the mech list so the client dismisses the dialog and
    // returns to the mech selection screen. Sending nothing leaves the dialog
    // frozen (client waits indefinitely for a server packet to close it).
    const p1 = payload.length > 3 ? payload[3] - 0x21 : -1;
    connLog.info('[game] cmd 0x1D (cancel/ESC): p1=%d — re-sending mech list to dismiss dialog', p1);
    session.awaitingMechConfirm = false;
    const mechsToSend = MECHS.slice(0, MECH_SEND_LIMIT);
    const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
    send(session.socket, mechPkt, capture, 'MECH_LIST');

  } else if (cmdIdx === 20) {
    // cmd 20 = 'X' key / Examine button — client requests stats for the highlighted mech.
    //
    // CLIENT PAYLOAD (CONFIRMED by capture analysis — RESEARCH.md §16):
    //   type4(slot + 1) at payload[3..7]  — 5-byte base-85 encoding, identical to
    //   the cmd-7 mech-selection encoding; slot is 0-based, value is 1-indexed.
    //
    // SERVER RESPONSE — direct text (NOT the legacy "#NNN" shortcode):
    //   ONE packet: mode=2, text = mech stats built by buildMechExamineText().
    //
    //   String encoding: encodeB85_1(len) + raw bytes — NOT encodeString.
    //   FUN_00411D90 reads the string via FUN_0040c130 → FUN_00402b10(1) (base-85 2-byte
    //   length prefix).  encodeString's 1-byte prefix caused the client to decode 2 bytes
    //   as a 1732-byte length, fail the bounds check → return -1 ("RPS command 20 failed.").
    //
    //   The legacy "#NNN" path (confirmed by RE of FUN_00411a10, FUN_00473ad8) does a
    //   client-side lookup: DAT_00473ad8[mech_id] → MPBT.MSG line → stats string.
    //   Unfortunately our MPBT.MSG has "Mechs now in use:" at the expected line (252)
    //   for mech_id=156 (ANH-1A) instead of the actual mech stats.  Sending the stats
    //   text directly from the server bypasses this broken lookup entirely.
    //
    // IMPORTANT: Do NOT send mode=0 or mode=1 packets.
    //   FUN_00411a10 creates a NEW independent dialog object for EVERY call. Modes 0 and 1
    //   produce "Yes"/"No" button dialogs (unrelated to stats) that stack under mode=2 and
    //   were never closed by the server, causing the UI to appear frozen (T1 failure).
    const CMD20_DIALOG_ID = 5;
    let slot = 0;
    if (payload.length >= 8) {
      const [slotPlusOne] = decodeArgType4(payload, 3);
      slot = Math.max(0, slotPlusOne - 1);
    }
    const mech = MECHS[slot] ?? MECHS[0];
    if (!mech) {
      connLog.warn('[game] cmd 20: MECHS empty, cannot examine');
      return;
    }
    const examineText = buildMechExamineText(mech);
    connLog.info('[game] cmd 20 (examine): slot=%d mech_id=%d (%s) → %j',
      slot, mech.id, mech.typeString, examineText);
    send(session.socket, buildCmd20Packet(CMD20_DIALOG_ID, 2, examineText, nextSeq(session)), capture, 'CMD20_STATS');

  } else {
    connLog.debug('[game] cmd=%d ignored (mechListSent=%s)', cmdIdx, session.mechListSent);
  }
}

// ── Server startup ────────────────────────────────────────────────────────────

// Capture unhandled exceptions so they appear in logs/server.log.
// Set exitCode first, then flush the log stream before exiting so buffered
// output is not dropped. Child loggers share the root stream, so closing
// `log` is sufficient.
process.on('uncaughtException', (err: Error) => {
  log.error('Uncaught exception: %s\n%s', err.message, err.stack ?? '');
  process.exitCode = 1;
  log.close(() => process.exit());
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  log.error('Unhandled rejection: %s', msg);
  process.exitCode = 1;
  log.close(() => process.exit());
});

const server = net.createServer(handleConnection);

server.on('error', (err: Error) => {
  log.error('Server error: %s', err.message);
  process.exit(1);
});

server.listen(ARIES_PORT, '0.0.0.0', () => {
  const addr = server.address() as net.AddressInfo;
  log.info('═══════════════════════════════════════════════════════');
  log.info('  MPBT ARIES Server Emulator');
  log.info('  Listening on 0.0.0.0:%d', addr.port);
  log.info('  Hostname: %s', os.hostname());
  log.info('  Protocol: ARIES binary (12-byte header, confirmed by RE)');
  log.info('    play.pcgi server=127.0.0.1:%d', addr.port);
  log.info('  Captures → captures/    Logs → logs/server.log');
  log.info('═══════════════════════════════════════════════════════');
});

process.on('SIGINT', () => {
  log.info('Shutting down...');
  server.close(() => {
    log.info('Server closed.');
    log.close();
    process.exit(0);
  });
});
