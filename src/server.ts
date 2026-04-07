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

import { ARIES_PORT, WORLD_PORT, Msg } from './protocol/constants.js';
import { PacketParser, buildPacket, hexDump } from './protocol/aries.js';
import { parseLoginPayload, buildLoginRequest, buildSyncAck, buildWelcomePacket } from './protocol/auth.js';
import {
  buildMechListPacket,
  buildMenuDialogPacket,
  buildRedirectPacket,
  buildCmd20Packet,
  parseClientCmd7,
  parseClientCmd9CharacterCreationReply,
  decodeArgType4,
  verifyInboundGameCRC,
  type MechEntry,
} from './protocol/game.js';
import { buildCmd9CharacterCreationPromptPacket } from './protocol/world.js';
import { loadMechs } from './data/mechs.js';
import { MECH_STATS } from './data/mech-stats.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { launchRegistry } from './state/launch.js';
import { startWorldServer } from './server-world.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { verifyOrRegister } from './db/accounts.js';
import { findCharacter, createCharacter, ALLEGIANCES } from './db/characters.js';
import { ARIES_KEEPALIVE_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from './config.js';

// ── Global state ──────────────────────────────────────────────────────────────

const log = new Logger('server', 'debug', path.join('logs', 'server.log'));
const players = new PlayerRegistry();

// Advertised host sent in REDIRECT packets.
// Set SERVER_HOST env var to the server's LAN/public IP for non-local clients.
// Defaults to 127.0.0.1 (loopback only — works when client is on the same machine).
const SERVER_HOST = process.env['SERVER_HOST'] ?? '127.0.0.1';

// Validate the redirect address at startup so a misconfigured SERVER_HOST
// surfaces immediately rather than crashing on the first player login.
{
  const redirectAddr = `${SERVER_HOST}:${WORLD_PORT}`;
  const colonCount   = (redirectAddr.match(/:/g) ?? []).length;
  const addrLen      = Buffer.byteLength(redirectAddr, 'ascii');
  if (colonCount !== 1 || addrLen > 39) {
    process.stderr.write(
      `[startup] invalid REDIRECT addr "${redirectAddr}" ` +
      `(${colonCount} colons, ${addrLen} bytes) — check SERVER_HOST\n`,
    );
    process.exit(1);
  }
}

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
  capture.logSend(pkt, label);
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
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

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
          // Client response to server-initiated ARIES type-0x05 keepalive.
          connLog.debug('[keepalive] response received');
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
    if (keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
    }
    capture.close();
  });

  // ── TCP keep-alive ──────────────────────────────────────────────────────────
  socket.setKeepAlive(true, 15_000);
  if (SOCKET_IDLE_TIMEOUT_MS > 0) {
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => {
      connLog.warn('Session timed out after %d ms, closing', SOCKET_IDLE_TIMEOUT_MS);
      socket.destroy();
    });
  }

  keepaliveTimer = ARIES_KEEPALIVE_INTERVAL_MS > 0
    ? setInterval(() => {
      if (socket.destroyed || !socket.writable) {
        return;
      }
      connLog.debug('[keepalive] sending ping');
      send(socket, buildPacket(Msg.KEEPALIVE, Buffer.alloc(0)), capture, 'KEEPALIVE_PING');
    }, ARIES_KEEPALIVE_INTERVAL_MS)
    : undefined;
  keepaliveTimer?.unref();

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
  const rawUsername = login.username || '(unknown)';
  session.username = rawUsername;

  connLog.info(
    '[login] credentials received: user="%s" service="%s" clientVer="%s"',
    rawUsername,
    login.serviceId,
    login.clientVer,
  );

  // DB authentication: auto-register on first login, verify password on subsequent.
  verifyOrRegister(rawUsername, login.password ?? '').then(authResult => {
    if (session.socket.destroyed) return;
    if (!authResult.ok) {
      connLog.warn('[login] rejected by DB: %s (user="%s")', authResult.reason, rawUsername);
      session.socket.destroy();
      return;
    }

    session.accountId = authResult.account.id;
    session.phase = 'lobby';

    if (authResult.created) {
      connLog.info('[login] new account created for "%s" (id=%d)', rawUsername, session.accountId);
    } else {
      connLog.info('[login] authenticated: user="%s" (id=%d)', rawUsername, session.accountId);
    }

    // Send SYNC acknowledgment (type 0x00, empty payload) — establishes timing.
    const syncAck = buildSyncAck(Date.now());
    connLog.info('[login] sending SYNC ack — %d bytes', syncAck.length);
    send(session.socket, syncAck, capture, 'SYNC');

    // Send welcome data (type 0x00, payload = "\x1b?MMW Copyright Kesmai Corp. 1991").
    const welcomePkt = buildWelcomePacket();
    connLog.info('[login] sending WELCOME escape — %d bytes', welcomePkt.length);
    send(session.socket, welcomePkt, capture, 'WELCOME');
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    connLog.error('[login] DB error during auth: %s', msg);
    session.socket.destroy();
  });
}

// ── Game-data handler ─────────────────────────────────────────────────────────
// Handles type-0x00 packets in 'lobby' and 'char-creation' phases.
//
// Login → character lookup → branch:
//   character exists  → REDIRECT immediately to WORLD_PORT (issue #27)
//   no character      → Cmd9 callsign + allegiance prompt → create character → REDIRECT (issue #26)
//
// Pre-combat mech select (cmd-26 / cmd-7 confirm) is kept in place for the
// M6 combat-entry path but is no longer triggered on initial login.

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
  // Accept packets in 'lobby' (initial post-auth) and 'char-creation' phases.
  if (session.phase !== 'lobby' && session.phase !== 'char-creation') {
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

  if (!verifyInboundGameCRC(payload)) {
    connLog.warn('[game] inbound CRC mismatch (seq=0x%s) — processing anyway', payload[1].toString(16));
  }

  const seq = payload[1] - 0x21;

  // ACK request: client uses seq > 42 to request server acknowledgment.
  if (seq > 42) {
    const ackPayload = Buffer.from([0x22, seq + 0x2b]);
    connLog.debug('[game] seq=%d > 42 → sending ACK [0x22, 0x%s]', seq, (seq + 0x2b).toString(16));
    send(session.socket, buildPacket(Msg.SYNC, ackPayload), capture, 'ACK');
    return;
  }

  const cmdIdx = payload[2] - 0x21;
  connLog.info('[game] client seq=%d cmd=%d phase=%s', seq, cmdIdx, session.phase);

  if (cmdIdx === 3 && session.phase === 'lobby') {
    // cmd 3 = client-ready signal.
    //
    // LOGIN FLOW (issues #26/#27):
    //   Look up the player's character in the DB.
    //   - Character exists → REDIRECT immediately to world port (issue #27).
    //   - No character     → send Cmd9 callsign + allegiance prompt (issue #26).
    //
    // The Cmd9 path was captured from the live MPBTWIN.EXE client and preserves
    // the typed callsign before the world REDIRECT.
    const accountId = session.accountId;
    if (accountId === undefined) {
      connLog.error('[game] cmd-3 received but session has no accountId — possible auth race');
      session.socket.destroy();
      return;
    }

    findCharacter(accountId).then(character => {
      if (session.socket.destroyed || session.phase !== 'lobby') return;
      if (character) {
        // Returning player: character on file → straight to world.
        session.displayName = character.display_name;
        session.allegiance  = character.allegiance;
        connLog.info(
          '[game] character found: displayName="%s" allegiance=%s → REDIRECT to world',
          character.display_name, character.allegiance,
        );
        // Do not pre-set selectedMechId here — ensureDefaultWorldLaunch() inside
        // issueWorldRedirect() will choose the default mech and call launchRegistry.record().
        issueWorldRedirect(session, connLog, capture);
      } else {
        // First login: no character → prompt for callsign + House allegiance.
        connLog.info('[game] no character for account %d — starting char creation', accountId);
        session.phase = 'char-creation';
        sendCharacterCreationPrompt(session, connLog, capture);
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      connLog.error('[game] DB error during character lookup: %s', msg);
      session.socket.destroy();
    });

  } else if (cmdIdx === 7) {
    // cmd 7: dialog reply. Handles two lobby mech-selection sub-cases:
    //   A) Mech-window selection (M6 pre-combat, future) (listId = 0)
    //   B) Launch-confirm dialog (M6 pre-combat, future) (listId = CONFIRM_DIALOG_ID)
    const parsed = parseClientCmd7(payload);
    if (!parsed) {
      connLog.warn('[game] cmd 7 parse failed (len=%d)', payload.length);
      return;
    }
    const { listId, selection } = parsed;
    connLog.info('[game] cmd 7: listId=%d selection=%d phase=%s', listId, selection, session.phase);

    if (listId === 0 && selection > 0 && session.mechListSent && !session.awaitingMechConfirm) {
      // M6 pre-combat mech-window selection.
      const chosenSlot = selection - 1;
      session.pendingMechSlot = chosenSlot;
      connLog.info('[game] mech selected (slot=%d) → sending CONFIRM dialog', chosenSlot);
      const confirmPkt = buildMenuDialogPacket(CONFIRM_DIALOG_ID, 'CONFIRM', ['Launch!', 'Cancel'], nextSeq(session));
      send(session.socket, confirmPkt, capture, 'CONFIRM_DIALOG');
      session.awaitingMechConfirm = true;

    } else if (listId === CONFIRM_DIALOG_ID && selection > 0 && session.awaitingMechConfirm) {
      // M6 pre-combat launch-confirm dialog.
      if (selection === 1) {
        const pendingSlot = session.pendingMechSlot ?? 0;
        const selectedMech = MECHS.find(m => m.slot === pendingSlot) ?? MECHS[0];
        recordWorldLaunch(session, selectedMech, connLog);
        connLog.info(
          '[game] confirmed (Launch!) → recording launch mech=%s (id=%d) and REDIRECT to %s:%d',
          selectedMech.typeString, selectedMech.id, SERVER_HOST, WORLD_PORT,
        );
        issueWorldRedirect(session, connLog, capture);
      } else if (selection === 2) {
        connLog.info('[game] cancelled → re-sending mech list');
        session.awaitingMechConfirm = false;
        const mechsToSend = MECHS.slice(0, MECH_SEND_LIMIT);
        const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
        send(session.socket, mechPkt, capture, 'MECH_LIST');
      } else {
        connLog.warn('[game] CONFIRM dialog: unexpected selection=%d — ignoring', selection);
      }

    } else {
      connLog.debug('[game] cmd 7 ignored (listId=%d sel=%d phase=%s)', listId, selection, session.phase);
    }

  } else if (cmdIdx === 9 && session.phase === 'char-creation') {
    const parsed = parseClientCmd9CharacterCreationReply(payload);
    if (!parsed) {
      connLog.warn('[game] cmd 9 character reply parse failed (len=%d)', payload.length);
      return;
    }
    connLog.info(
      '[game] cmd 9 character reply: subcmd=%d displayName="%s" selection=%d phase=%s',
      parsed.subcmd, parsed.displayName, parsed.selection, session.phase,
    );

    const displayName = parsed.displayName.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 64);
    const allegiance = ALLEGIANCES[parsed.selection - 1];
    if (parsed.subcmd !== 1 || !displayName || !allegiance) {
      connLog.warn(
        '[game] char-creation Cmd9 rejected: subcmd=%d displayNameLen=%d selection=%d',
        parsed.subcmd, displayName.length, parsed.selection,
      );
      sendCharacterCreationPrompt(session, connLog, capture);
      return;
    }

    createCharacter(session.accountId!, displayName, allegiance).then((character) => {
      session.displayName = character.display_name;
      session.allegiance = character.allegiance;

      connLog.info(
        '[game] char-creation Cmd9 accepted: displayName="%s" allegiance=%s → REDIRECT',
        displayName, allegiance,
      );
      issueWorldRedirect(session, connLog, capture);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      connLog.warn('[game] character create failed after Cmd9: %s', msg);
      sendCharacterCreationPrompt(session, connLog, capture);
    });

  } else if (cmdIdx === 0x1D) {
    // cmd 0x1D (29) = ESC/cancel pressed in a menu dialog.
    const p1 = payload.length > 3 ? payload[3] - 0x21 : -1;
    if (session.phase === 'char-creation') {
      // Re-send creation dialog — player cannot skip character creation.
      connLog.info('[game] cmd 0x1D in char-creation: p1=%d — re-sending Cmd9 character prompt', p1);
      sendCharacterCreationPrompt(session, connLog, capture);
    } else {
      connLog.info('[game] cmd 0x1D (cancel/ESC): p1=%d — re-sending mech list to dismiss dialog', p1);
      session.awaitingMechConfirm = false;
      const mechsToSend = MECHS.slice(0, MECH_SEND_LIMIT);
      const mechPkt = buildMechListPacket(mechsToSend, 0, '', nextSeq(session));
      send(session.socket, mechPkt, capture, 'MECH_LIST');
    }

  } else if (cmdIdx === 20) {
    // cmd 20 = 'X' key / Examine button — client requests stats for the highlighted mech.
    // Only meaningful when the mech list is visible (pre-combat M6 path).
    const CMD20_DIALOG_ID = 5;
    if (MECHS.length === 0) {
      connLog.warn('[game] cmd 20: MECHS empty, cannot examine');
      return;
    }
    const maxSlot = MECHS.length - 1;
    let slot = 0;
    if (payload.length >= 8) {
      const [slotPlusOne] = decodeArgType4(payload, 3);
      const requestedSlot = Number.isFinite(slotPlusOne) ? slotPlusOne - 1 : 0;
      slot = Math.min(maxSlot, Math.max(0, requestedSlot));
      if (slot !== requestedSlot) {
        connLog.warn('[game] cmd 20: clamped invalid slot %d to %d (max=%d)', requestedSlot, slot, maxSlot);
      }
    }
    const mech = MECHS[slot];
    const examineText = buildMechExamineText(mech);
    connLog.info('[game] cmd 20 (examine): slot=%d mech_id=%d (%s) → %j',
      slot, mech.id, mech.typeString, examineText);
    send(session.socket, buildCmd20Packet(CMD20_DIALOG_ID, 2, examineText, nextSeq(session)), capture, 'CMD20_STATS');

  } else {
    connLog.debug('[game] cmd=%d ignored (phase=%s)', cmdIdx, session.phase);
  }
}

// ── Character creation helpers ────────────────────────────────────────────────

/** Send the original first-login callsign + House allegiance dialog. */
function sendCharacterCreationPrompt(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const pkt = buildCmd9CharacterCreationPromptPacket(ALLEGIANCES, nextSeq(session));
  connLog.info('[game] sending Cmd9 character creation prompt (%s)', ALLEGIANCES.join('/'));
  send(session.socket, pkt, capture, 'CMD9_CHARACTER_CREATION');
}

function recordWorldLaunch(
  session: ClientSession,
  mech: MechEntry,
  connLog: Logger,
): void {
  session.selectedMechId = mech.id;
  session.selectedMechSlot = mech.slot;
  launchRegistry.record(session.username, {
    accountId:       session.accountId,
    displayName:     session.displayName,
    allegiance:      session.allegiance,
    mechId:          mech.id,
    mechSlot:        mech.slot,
    mechTypeString:  mech.typeString,
  });
  connLog.info(
    '[game] recorded world launch: displayName="%s" allegiance=%s mech=%s (id=%d)',
    session.displayName ?? session.username,
    session.allegiance ?? '(none)',
    mech.typeString,
    mech.id,
  );
}

function ensureDefaultWorldLaunch(session: ClientSession, connLog: Logger): void {
  // Skip if recordWorldLaunch() was already called at this call site (selectedMechId is set).
  if (session.selectedMechId !== undefined) return;
  const defaultMech = MECHS[0];
  if (!defaultMech) {
    connLog.warn('[game] cannot record default world launch: no mechs loaded');
    return;
  }
  recordWorldLaunch(session, defaultMech, connLog);
}

/**
 * Issue a REDIRECT packet to the game world server (WORLD_PORT).
 * Validates the addr string, sends the packet, and sets phase='closing'.
 */
function issueWorldRedirect(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const redirectAddr = `${SERVER_HOST}:${WORLD_PORT}`;
  const colonCount   = (redirectAddr.match(/:/g) ?? []).length;
  const addrLen      = Buffer.byteLength(redirectAddr, 'ascii');
  if (colonCount !== 1 || addrLen > 39) {
    connLog.error(
      '[game] invalid REDIRECT addr "%s" (%d ":" chars, %d bytes); check SERVER_HOST/WORLD_PORT',
      redirectAddr, colonCount, addrLen,
    );
    throw new Error(`Invalid REDIRECT addr "${redirectAddr}"`);
  }
  const redir = buildRedirectPacket(redirectAddr);
  ensureDefaultWorldLaunch(session, connLog);
  connLog.info('[game] sending REDIRECT → %s', redirectAddr);
  send(session.socket, redir, capture, 'REDIRECT');
  session.phase = 'closing';
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

// Start the world server (M3) — listens on WORLD_PORT (2001).
// Shares the same player registry and logger as the lobby server.
startWorldServer(log, players);

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
