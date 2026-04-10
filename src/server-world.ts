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
  buildCmd37OpenComposePacket,
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
  buildCmd5CursorNormalPacket,
  buildCmd6CursorBusyPacket,
  buildCmd10RoomPresenceSyncPacket,
} from './protocol/world.js';
import { PlayerRegistry, ClientSession } from './state/players.js';
import { launchRegistry } from './state/launch.js';
import {
  claimUndeliveredMessages,
  markDelivered,
} from './db/messages.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { ARIES_KEEPALIVE_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from './config.js';

import {
  worldCaptures,
  allocateWorldRosterId,
  DEFAULT_MAP_ROOM_ID,
  ALL_ROSTER_LIST_ID,
  INQUIRY_MENU_ID,
  PERSONNEL_LIST_ID,
  PERSONNEL_MORE_ID,
  SOLARIS_TRAVEL_CONTEXT_ID,
  getSolarisRoomName,
  setSessionRoomPosition,
  worldMapByRoomId,
} from './world/world-data.js';
import {
  send,
  nextSeq,
  getDisplayName,
  mapRoomKey,
  getComstarId,
  findWorldTargetBySelectionId,
  sendInquiryMenu,
  sendPersonnelRecord,
  buildSceneInitForSession,
  sendSceneRefresh,
  sendAllRosterList,
  sendSolarisTravelMap,
  currentRoomPresenceEntries,
} from './world/world-scene.js';
import {
  handleComstarTextReply,
  handleRoomMenuSelection,
  handleMapTravelReply,
  handleLocationAction,
  handleWorldTextCommand,
  sendCombatBootstrapSequence,
  notifyRoomArrival,
  notifyRoomDeparture,
  handleCombatMovementFrame,
  handleCombatWeaponFireFrame,
  handleCombatActionFrame,
  handleMechPickerCmd7,
} from './world/world-handlers.js';

const WELCOME_TEXT = 'Welcome to the game world.';

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
  setSessionRoomPosition(session, DEFAULT_MAP_ROOM_ID);
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
    if (parsed.actionType === 5) {
      // "Fight" button — verify the session is in an arena room server-side
      // even though buildSceneInitForSession only shows the button for arenas,
      // because a client can always send cmd-5 type=5 manually.
      const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
      const mapRoom = worldMapByRoomId.get(currentRoomId);
      if (mapRoom?.type !== 'arena') {
        connLog.warn('[world] cmd-5 Fight rejected: room %d is not an arena (type=%s)',
          currentRoomId, mapRoom?.type ?? 'unknown');
        return;
      }
      if (!session.combatInitialized && session.phase === 'world') {
        connLog.info('[world] cmd-5 Fight button: triggering combat bootstrap room=%d', currentRoomId);
        sendCombatBootstrapSequence(session, connLog, capture);
      } else {
        connLog.debug('[world] cmd-5 Fight ignored: combatInitialized=%s phase=%s',
          session.combatInitialized, session.phase);
      }
      return;
    }
    connLog.warn('[world] cmd-5 unsupported scene action type=%d', parsed.actionType);

  } else if (cmdIdx === 10) {
    if (session.phase === 'combat') {
      handleCombatWeaponFireFrame(session, payload, connLog, capture);
      return;
    }
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

    if (handleMechPickerCmd7(players, session, parsed.listId, parsed.selection, connLog, capture)) {
      return;
    }

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
    if (cmdIdx === 8 || cmdIdx === 9) {
      handleCombatMovementFrame(session, payload, connLog, capture);
    } else if (cmdIdx === 12) {
      handleCombatActionFrame(session, payload, connLog, capture);
    } else if (cmdIdx === 20) {
      // Cmd20 — "examine self": correct combat-mode response is unconfirmed.
      // Sending the lobby-phase buildCmd20Packet here (world CRC seed) caused
      // the client to dispatch a garbage byte as "command 13 not handled".
      // Drop silently until the combat-specific response format is captured.
      connLog.debug('[world/combat] cmd-20 examine-self — no response (combat response unconfirmed)');
    } else {
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
    worldRosterId:     allocateWorldRosterId(),
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
    if (session.botPositionTimer !== undefined) {
      clearInterval(session.botPositionTimer);
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

