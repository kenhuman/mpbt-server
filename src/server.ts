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
import { buildMechListPacket, buildMenuDialogPacket, buildRedirectPacket, parseClientCmd7, type MechEntry } from './protocol/game.js';
import { loadMechs } from './data/mechs.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';

// ── Global state ──────────────────────────────────────────────────────────────

const log = new Logger('server', 'debug', path.join('logs', 'server.log'));
const players = new PlayerRegistry();

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: net.Socket, pkt: Buffer, capture: CaptureLogger, label: string): void {
  capture.logSend(pkt);
  socket.write(pkt);
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
const MECHS: MechEntry[] = loadMechs();
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
    // 4 slots. Cap at 4 until player-specific roster assignment is implemented.
    // TODO: load player-specific mech assignments rather than the global catalog.
    const MECH_SEND_LIMIT = 4;
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
      connLog.info('[game] mech selected (slot=%d) → sending CONFIRM dialog', selection - 1);
      const confirmPkt = buildMenuDialogPacket(CONFIRM_DIALOG_ID, 'CONFIRM', ['Launch!'], nextSeq(session));
      send(session.socket, confirmPkt, capture, 'CONFIRM_DIALOG');
      session.awaitingMechConfirm = true;

    } else if (listId === CONFIRM_DIALOG_ID && selection > 0 && session.awaitingMechConfirm) {
      // User confirmed from the dialog → redirect to game world.
      // COMMEG32.DLL case 3: 120-byte payload [addr40|internet40|pw40],
      // then FUN_100011c0 opens a new TCP connection to addr.
      connLog.info('[game] confirmed (item=%d) → sending REDIRECT', selection);
      const redir = buildRedirectPacket('127.0.0.1');
      send(session.socket, redir, capture, 'REDIRECT');
      session.phase = 'closing';

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
    const mechsToSend = MECHS.slice(0, 4);
    const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
    send(session.socket, mechPkt, capture, 'MECH_LIST');

  } else if (cmdIdx === 20) {
    // cmd 20 = 'X' key — examine mech (requests mech stats from server).
    // WARNING: sending no response locks the client (it waits indefinitely for
    // the reply). Tracked in issues #3 (RE) and #4 (implementation). SKIP for M1.
    // TODO: respond with mech detail data once format is understood.
    // RE target: Cmd20_MouseHandler (FUN_00401c90)
    connLog.debug('[game] cmd 20 (examine mech) — noop (client will lock; see issues #3/#4)');

  } else {
    connLog.debug('[game] cmd=%d ignored (mechListSent=%s)', cmdIdx, session.mechListSent);
  }
}

// ── Server startup ────────────────────────────────────────────────────────────

// Capture unhandled exceptions so they appear in logs/server.log.
process.on('uncaughtException', (err: Error) => {
  log.error('Uncaught exception: %s\n%s', err.message, err.stack ?? '');
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  log.error('Unhandled rejection: %s', String(reason));
  process.exit(1);
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
