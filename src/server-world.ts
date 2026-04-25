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
import { readFileSync } from 'fs';

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
  decodeArgType4,
  parseClientCmd4,
  parseClientCmd5SceneAction,
  parseClientCmd10MapReply,
  parseClientCmd15DuelTerms,
  parseClientCmd21TextReply,
  parseClientCmd23LocationAction,
  parseClientCmd29ControlFrame,
  parseClientCmd7,
  splitInboundGameFrames,
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
import { replaceSessionForReconnect } from './state/session-replacement.js';
import { worldResumeRegistry } from './state/world-resume.js';
import {
  countSavedUnreadMessages,
} from './db/messages.js';
import { Logger } from './util/logger.js';
import { CaptureLogger } from './util/capture.js';
import { ARIES_KEEPALIVE_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from './config.js';

import {
  worldCaptures,
  allocateWorldRosterId,
  DEFAULT_MAP_ROOM_ID,
  ALL_ROSTER_LIST_ID,
  COMSTAR_SEND_TARGET_MENU_ID,
  COMSTAR_ACCESS_ACTION_TYPE,
  COMSTAR_ACCESS_MENU_ID,
  INQUIRY_MENU_ID,
  MATCH_RESULTS_MENU_LIST_ID,
  NEWS_CATEGORY_MENU_ID,
  NEWSGRID_ARTICLE_LIST_ID,
  TIER_RANKING_CHOOSER_LIST_ID,
  CLASS_RANKING_CHOOSER_LIST_ID,
  TIER_RANKING_RESULTS_LIST_ID,
  CLASS_RANKING_RESULTS_LIST_ID,
  PERSONNEL_LIST_ID,
  PERSONNEL_MORE_ID,
  ARENA_READY_ROOM_MENU_ID,
  ARENA_READY_ACTION_TYPE,
  ARENA_SIDE_MENU_ID,
  ARENA_STATUS_LIST_ID,
  ARENA_SIDE_ACTION_TYPE,
  ARENA_STATUS_ACTION_TYPE,
  SOLARIS_TRAVEL_ACTION_TYPE,
  SOLARIS_TRAVEL_CONTEXT_ID,
  getSolarisSceneHeaderDetail,
  getSolarisRoomName,
  getSolarisSceneRoomId,
  setSessionRoomPosition,
  worldMapByRoomId,
} from './world/world-data.js';
import {
  send,
  nextSeq,
  getDisplayName,
  mapRoomKey,
  arenaReadyRoomKey,
  getComstarId,
  findWorldTargetBySelectionId,
  sendComstarAccessMenu,
  sendInquiryMenu,
  sendPersonnelRecord,
  buildSceneInitForSession,
  sendSceneRefresh,
  sendWorldUiRestore,
  sendAllRosterList,
  sendArenaSideMenu,
  sendArenaStatusList,
  sendSolarisTravelMap,
  currentRoomPresenceEntries,
  sendMechClassPicker,
} from './world/world-scene.js';
import {
  handleComstarTextReply,
  handleComstarAccessSelection,
  COMSTAR_INCOMING_DIALOG_ID,
  handleComstarIncomingPromptCmd7,
  handleComstarSendTargetSelection,
  handleMatchResultsSelection,
  handleNewsCategorySelection,
  handleNewsgridArticleSelection,
  handleTierRankingMenuSelection,
  handleClassRankingMenuSelection,
  handleRankingResultsSelection,
  handleRoomMenuSelection,
  handleMapTravelReply,
  handleLocationAction,
  handleWorldTextCommand,
  handleBotMechTextCommand,
  clearSessionDuelState,
  handleDuelTermsSubmit,
  tryStartArenaReadyRoomCombat,
  sendStagedDuelTermsPanel,
  sendCombatBootstrapSequence,
  resetCombatState,
  savePendingIncomingComstarPrompt,
  stopCombatTimers,
  notifyRoomArrival,
  notifyRoomDeparture,
  handleCombatMovementFrame,
  handleCombatWeaponFireFrame,
  handleCombatActionFrame,
  handleCombatContactReportFrame,
  handleCombatEjectRequest,
  handleCombatKeepalivePacket,
  handleArenaCombatDisconnect,
  handleMechPickerCmd7,
  handleMechPickerCmd20,
  handleActiveScrollListMore,
  handleArenaReadyToggle,
  handleArenaReadyRoomSelection,
  handleArenaSideSelection,
  completePendingWorldReadySceneRefresh,
  flushPendingDuelSettlementNotice,
} from './world/world-handlers.js';

const _pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const WELCOME_TEXT = `Welcome to the game world.  (Server v${_pkg.version})`;

// ── Login handler ─────────────────────────────────────────────────────────────

async function handleWorldLogin(
  players:  PlayerRegistry,
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

  if (launch.accountId !== undefined) {
    session.accountId = launch.accountId;
    const existingSession = players.findActiveSessionByAccountId(launch.accountId, session.id);
    if (existingSession) {
      connLog.info(
        '[world-login] replacing existing session for accountId=%d (existingSession=%s phase=%s -> replacement=%s)',
        launch.accountId,
        existingSession.id.slice(0, 8),
        existingSession.phase,
        session.id.slice(0, 8),
      );
      replaceSessionForReconnect(existingSession, session.id);
    }
  }

  const accountResume = worldResumeRegistry.consume(session.accountId, session.username);
  const restoredRoomId = accountResume?.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;

  session.displayName     = accountResume?.displayName ?? launch.displayName;
  session.allegiance      = accountResume?.allegiance ?? launch.allegiance;
  session.cbills          = accountResume?.cbills ?? launch.cbills;
  session.selectedMechId   = accountResume?.selectedMechId ?? launch.mechId;
  session.selectedMechSlot = accountResume?.selectedMechSlot ?? launch.mechSlot;
  session.worldArenaSide   = accountResume?.worldArenaSide;
  session.worldArenaReadyRoomId = accountResume?.worldArenaReadyRoomId;
  session.pendingDuelSettlementNotice = accountResume?.pendingDuelSettlementNotice;
  if (session.accountId !== undefined) {
    session.worldRosterId = 100000 + session.accountId;
  }
  connLog.info(
    '[world-login] launch record found: displayName="%s" allegiance=%s mech=%s (id=%d slot=%d rosterId=%d room=%d)',
    session.displayName ?? session.username,
    session.allegiance ?? '(none)',
    launch.mechTypeString,
    launch.mechId,
    launch.mechSlot,
    session.worldRosterId ?? 0,
    restoredRoomId,
  );

  session.phase          = 'world';
  setSessionRoomPosition(session, restoredRoomId);
  session.roomId         = (
    worldMapByRoomId.get(restoredRoomId)?.type === 'arena'
    && session.worldArenaReadyRoomId !== undefined
  )
    ? arenaReadyRoomKey(restoredRoomId, session.worldArenaReadyRoomId)
    : mapRoomKey(restoredRoomId);

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
//   cmd 29 — control frame (retail v1.29 uses subtype 2 for world-menu replies on
//            later client UI surfaces, including Cmd7 compatibility menus)

function dispatchWorldMenuSelection(
  players: PlayerRegistry,
  session: ClientSession,
  listId: number,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  // Keep world menu routing transport-neutral. The v1.29 client can submit the
  // same logical listId/selection pair through plain cmd-7 or through world
  // cmd-29 subtype 2, so the remaining late-client Cmd57 gap is the outbound
  // menu packet surface rather than this selection dispatcher.
  if (handleMechPickerCmd7(players, session, listId, selection, connLog, capture)) {
    return true;
  }

  if (
    listId === COMSTAR_INCOMING_DIALOG_ID
    && handleComstarIncomingPromptCmd7(session, selection, connLog, capture)
  ) {
    return true;
  }

  if (listId === 3) {
    handleRoomMenuSelection(players, session, selection, connLog, capture);
    return true;
  }

  if (listId === ALL_ROSTER_LIST_ID && selection === 0) {
    connLog.info('[world] all-roster cancel -> restoring world UI');
    sendWorldUiRestore(players, session, connLog, capture, 'all-roster cancel');
    return true;
  }

  if (listId === ALL_ROSTER_LIST_ID && selection > 0) {
    const target = findWorldTargetBySelectionId(players, selection - 1);
    if (!target) {
      connLog.warn('[world] all-roster selection target not found: selection=%d', selection);
      return true;
    }
    sendInquiryMenu(session, target, connLog, capture);
    return true;
  }

  if (listId === INQUIRY_MENU_ID && selection > 0) {
    const targetId = session.worldInquiryTargetId;
    if (targetId === undefined) {
      connLog.warn('[world] inquiry submenu reply with no active target');
      return true;
    }

    const target = findWorldTargetBySelectionId(players, targetId);
    if (!target) {
      connLog.warn('[world] inquiry submenu target unavailable: target=%d', targetId);
      return true;
    }

    if (selection === 1) {
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
      return true;
    }

    if (selection === 2) {
      connLog.info('[world] inquiry submenu: personnel data for target=%d', targetId);
      sendPersonnelRecord(players, session, targetId, 1, connLog, capture);
      return true;
    }

    connLog.warn('[world] inquiry submenu: unsupported selection=%d', selection);
    return true;
  }

  if (listId === ARENA_SIDE_MENU_ID) {
    handleArenaSideSelection(players, session, selection, connLog, capture);
    return true;
  }

  if (listId === ARENA_READY_ROOM_MENU_ID) {
    handleArenaReadyRoomSelection(players, session, selection, connLog, capture);
    return true;
  }

  if (listId === ARENA_STATUS_LIST_ID && selection > 0) {
    sendPersonnelRecord(players, session, selection - 1, 1, connLog, capture);
    return true;
  }

  if (listId === COMSTAR_SEND_TARGET_MENU_ID) {
    handleComstarSendTargetSelection(players, session, selection, connLog, capture);
    return true;
  }

  if (listId === NEWS_CATEGORY_MENU_ID) {
    handleNewsCategorySelection(session, selection, connLog, capture);
    return true;
  }

  if (listId === NEWSGRID_ARTICLE_LIST_ID) {
    handleNewsgridArticleSelection(session, selection, connLog, capture);
    return true;
  }

  if (listId === MATCH_RESULTS_MENU_LIST_ID) {
    handleMatchResultsSelection(session, selection, connLog, capture);
    return true;
  }

  if (listId === TIER_RANKING_CHOOSER_LIST_ID) {
    handleTierRankingMenuSelection(session, selection, connLog, capture);
    return true;
  }

  if (listId === CLASS_RANKING_CHOOSER_LIST_ID) {
    handleClassRankingMenuSelection(session, selection, connLog, capture);
    return true;
  }

  if (
    listId === TIER_RANKING_RESULTS_LIST_ID
    || listId === CLASS_RANKING_RESULTS_LIST_ID
  ) {
    handleRankingResultsSelection(session, selection, connLog, capture);
    return true;
  }

  if (listId === PERSONNEL_LIST_ID && selection > 0) {
    sendPersonnelRecord(players, session, selection - 1, 1, connLog, capture);
    return true;
  }

  if (listId === PERSONNEL_MORE_ID && selection === 2) {
    if (session.worldInquiryTargetId === undefined) {
      connLog.warn('[world] personnel more with no active record target');
      return true;
    }
    sendPersonnelRecord(players, session, session.worldInquiryTargetId, 2, connLog, capture);
    return true;
  }

  if (listId === COMSTAR_ACCESS_MENU_ID) {
    handleComstarAccessSelection(players, session, selection, connLog, capture);
    return true;
  }

  return false;
}

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

  const innerFrames = splitInboundGameFrames(payload);
  if (innerFrames.length > 1) {
    connLog.info('[world] SYNC payload contained %d inner frames', innerFrames.length);
    for (const frame of innerFrames) {
      handleWorldGameData(players, session, frame, connLog, capture);
    }
    return;
  }

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
  connLog.debug('[world] client seq=%d cmd=%d', seq, cmdIdx);

  if (cmdIdx === 3) {
    if (session.worldInitialized) {
      connLog.debug('[world] duplicate cmd-3 after initialization — ignoring');
      return;
    }
    // Cmd-3: client capabilities / ready signal (RPS mode).
    // Called by FUN_0040d3c0 immediately after the world-MMW welcome is received.
    // Respond with the world initialization sequence exactly once.
    if (session.pendingWorldReadySceneRefresh) {
      completePendingWorldReadySceneRefresh(players, session, connLog, capture, 'client-ready');
      return;
    }
    session.worldInitialized = true;
    connLog.info('[world] cmd-3 (client-ready) → sending world init sequence');
    sendWorldInitSequence(players, session, connLog, capture);
    notifyRoomArrival(players, session, connLog);

    // Notify about unread ComStar messages that are waiting in the Postgres-backed inbox.
    const recipientAccountId = session.accountId;
    if (recipientAccountId !== undefined) {
      countSavedUnreadMessages(recipientAccountId)
        .then((unreadCount) => {
          if (unreadCount <= 0) return;
          connLog.info('[world] %d unread ComStar message(s) waiting', unreadCount);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket(
                unreadCount === 1
                  ? 'You have 1 unread ComStar message waiting.'
                  : `You have ${unreadCount} unread ComStar messages waiting.`,
                nextSeq(session),
              ),
              capture,
              'CMD3_COMSTAR_WAITING',
            );
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error('[world] failed to query unread ComStar messages: %s', msg);
        });
    }
    flushPendingDuelSettlementNotice(session);

  } else if (cmdIdx === 1) {
    // Cmd-1 PingAck: client acknowledging a server ping; no server reply needed.
    connLog.debug('[world] cmd-1 (ping-ack) — noted');

  } else if (cmdIdx === 2) {
    // Cmd-2 PingRequest: client requesting a latency probe reply.
    // COMMEG32 Ordinal_7 sends the reply directly; server does not need to act.
    connLog.debug('[world] cmd-2 (ping-request) — client handles reply via COMMEG32');

  } else if (cmdIdx === 4) {
    const parsed = parseClientCmd4(payload, session.phase === 'combat');
    if (!parsed) {
      if (session.phase === 'combat') {
        connLog.debug('[world] cmd-4 in combat phase parse failed — ignoring');
        return;
      }
      connLog.warn('[world] cmd-4 parse failed');
      return;
    }
    const textCmd = parsed.text.trim().toLowerCase();
    // "/fightrestart": stop any running combat timers, reset state, and
    // re-run the bootstrap from scratch — works even if combat was already
    // started.  Useful for iterating test scenarios without disconnecting.
    if (textCmd === '/fightrestart') {
      if (session.phase !== 'world' && session.phase !== 'combat') {
        connLog.debug('[world] /fightrestart ignored in phase=%s', session.phase);
        return;
      }
      if (players.getCombatSession(session.combatSessionId)?.mode === 'duel') {
        connLog.info('[world] /fightrestart ignored during duel session=%s', session.combatSessionId);
        if (session.phase === 'world') {
          send(
            session.socket,
            buildCmd3BroadcastPacket(
              'Duel combat restart is not wired yet. Clear the duel and stage a new challenge instead.',
              nextSeq(session),
            ),
            capture,
            'CMD3_DUEL_FIGHTRESTART_BLOCKED',
          );
        }
        return;
      }
      connLog.info('[world] /fightrestart: stopping timers and resetting combat state');
      resetCombatState(session);
      if (session.phase === 'world') {
        if (tryStartArenaReadyRoomCombat(players, session, connLog)) {
          return;
        }
      }
      sendCombatBootstrapSequence(players, session, connLog, capture);
      return;
    }
    if (session.phase === 'combat') {
      if (handleBotMechTextCommand(session, parsed.text, connLog, capture, { suppressBroadcast: true })) {
        return;
      }
      if (textCmd === '/fight') {
        connLog.debug(
          '[world] /fight ignored: combatInitialized=%s phase=%s',
          session.combatInitialized,
          session.phase,
        );
        return;
      }
      if (textCmd.length > 0) {
        connLog.debug('[world] cmd-4 text ignored during combat: %j', parsed.text);
      } else {
        connLog.debug('[world] empty cmd-4 text ignored during combat');
      }
      return;
    }
    // "/fight" family: trigger combat bootstrap if not already in combat.
    if (
      textCmd === '/fight' ||
      textCmd === '/fightwin' ||
      textCmd === '/fightlose' ||
      textCmd === '/fightdmglocal' ||
      textCmd === '/fightdmgbot' ||
      textCmd === '/fightstrictfire' ||
      textCmd === '/fighthead' ||
      textCmd === '/fightleg' ||
      textCmd === '/fightlegseq' ||
      textCmd === '/fightlegair' ||
      textCmd === '/fightlegfull' ||
      textCmd === '/fightlegrecover' ||
      textCmd === '/fightlegdefer' ||
      textCmd === '/fightlegdefer73'
    ) {
      const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
      const mapRoom = worldMapByRoomId.get(currentRoomId);
      if (mapRoom?.type !== 'arena') {
        connLog.warn(
          '[world] %s rejected: room %d is not an arena (type=%s)',
          textCmd,
          currentRoomId,
          mapRoom?.type ?? 'unknown',
        );
        session.combatVerificationMode = undefined;
        return;
      }
      if (tryStartArenaReadyRoomCombat(players, session, connLog)) {
        session.combatVerificationMode = undefined;
        return;
      }
      if (textCmd === '/fightwin') {
        session.combatVerificationMode = 'autowin';
      } else if (textCmd === '/fightlose') {
        session.combatVerificationMode = 'autolose';
      } else if (textCmd === '/fightdmglocal') {
        session.combatVerificationMode = 'dmglocal';
      } else if (textCmd === '/fightdmgbot') {
        session.combatVerificationMode = 'dmgbot';
      } else if (textCmd === '/fightstrictfire') {
        session.combatVerificationMode = 'strictfire';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Strict fire gate armed: ungated SPACEBAR fire will be rejected until recent action0.',
            nextSeq(session),
          ),
          capture,
          'CMD3_STRICTFIRE_ARMED',
        );
      } else if (textCmd === '/fighthead') {
        session.combatVerificationMode = 'headtest';
      } else if (textCmd === '/fightleg') {
        session.combatVerificationMode = 'legtest';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg fall verifier armed: bot retaliation will target the left leg until first collapse.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEG_ARMED',
        );
      } else if (textCmd === '/fightlegseq') {
        session.combatVerificationMode = 'legseq';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg fall sequence verifier armed: bot retaliation will target the left leg and emit Cmd70 1->8 on first collapse.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGSEQ_ARMED',
        );
      } else if (textCmd === '/fightlegair') {
        session.combatVerificationMode = 'legair';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg airborne verifier armed: bot retaliation will target the left leg and emit Cmd70 4->8->6 on first collapse.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGAIR_ARMED',
        );
      } else if (textCmd === '/fightlegfull') {
        session.combatVerificationMode = 'legfull';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg full-sequence verifier armed: bot retaliation will target the left leg and emit Cmd70 1->4->8->6 on first collapse.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGFULL_ARMED',
        );
      } else if (textCmd === '/fightlegrecover') {
        session.combatVerificationMode = 'legrecover';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg recovery verifier armed: bot retaliation will target the left leg and emit Cmd70 1->8->0 on first collapse.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGRECOVER_ARMED',
        );
      } else if (textCmd === '/fightlegdefer') {
        session.combatVerificationMode = 'legdefer';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg deferred-collapse verifier armed: jump before leg loss so the server can emit local Cmd70/8 only while action4 is active.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGDEFER_ARMED',
        );
      } else if (textCmd === '/fightlegdefer73') {
        session.combatVerificationMode = 'legdefercmd73';
        send(
          session.socket,
          buildCmd3BroadcastPacket(
            'Leg deferred-collapse Cmd73 verifier armed: jump before leg loss; Cmd73 rate probes will be sent around local fall/recovery.',
            nextSeq(session),
          ),
          capture,
          'CMD3_FIGHTLEGDEFER73_ARMED',
        );
      } else {
        session.combatVerificationMode = undefined;
      }
      if (!session.combatInitialized && session.phase === 'world') {
        sendCombatBootstrapSequence(players, session, connLog, capture);
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
        connLog.warn('[world] cmd-5 ComStar icon ignored outside world phase: phase=%s', session.phase);
        return;
      }
      sendComstarAccessMenu(session, connLog, capture);
      return;
    }
    if (parsed.actionType === SOLARIS_TRAVEL_ACTION_TYPE) {
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
        send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
        return;
      }
      if (tryStartArenaReadyRoomCombat(players, session, connLog)) {
        if (session.phase === 'world' && !session.combatInitialized) {
          send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
        }
        return;
      }
      if (!session.combatInitialized && session.phase === 'world') {
        connLog.info('[world] cmd-5 Fight button: triggering combat bootstrap room=%d', currentRoomId);
        sendCombatBootstrapSequence(players, session, connLog, capture);
      } else {
        connLog.debug('[world] cmd-5 Fight ignored: combatInitialized=%s phase=%s',
          session.combatInitialized, session.phase);
      }
      return;
    }
    if (parsed.actionType === 6) {
      if (session.phase === 'combat') {
        if (handleCombatEjectRequest(players, session, connLog, 'cmd-5 action=6')) {
          return;
        }
        connLog.warn('[world] cmd-5 combat action type=6 ignored outside active duel');
        return;
      }
      // "Mech"/"Mech Bay" button — open the 3-step mech picker.
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 mech bay ignored outside world phase: phase=%s', session.phase);
        return;
      }
      sendMechClassPicker(session, connLog, capture);
      return;
    }
    if (parsed.actionType === 7) {
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 duel terms ignored outside world phase: phase=%s', session.phase);
        return;
      }
      sendStagedDuelTermsPanel(players, session, connLog, capture);
      return;
    }
    if (parsed.actionType === ARENA_SIDE_ACTION_TYPE) {
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 arena side ignored outside world phase: phase=%s', session.phase);
        return;
      }
      if (worldMapByRoomId.get(session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID)?.type !== 'arena') {
        connLog.warn('[world] cmd-5 arena side ignored outside arena room: room=%d', session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID);
        return;
      }
      sendArenaSideMenu(session, connLog, capture);
      return;
    }
    if (parsed.actionType === ARENA_READY_ACTION_TYPE) {
      handleArenaReadyToggle(players, session, connLog, capture);
      return;
    }
    if (parsed.actionType === ARENA_STATUS_ACTION_TYPE) {
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 arena status ignored outside world phase: phase=%s', session.phase);
        return;
      }
      if (worldMapByRoomId.get(session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID)?.type !== 'arena') {
        connLog.warn('[world] cmd-5 arena status ignored outside arena room: room=%d', session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID);
        return;
      }
      sendArenaStatusList(players, session, connLog, capture);
      return;
    }
    if (parsed.actionType === COMSTAR_ACCESS_ACTION_TYPE) {
      if (session.phase !== 'world') {
        connLog.warn('[world] cmd-5 ComStar access ignored outside world phase: phase=%s', session.phase);
        return;
      }
      sendComstarAccessMenu(session, connLog, capture);
      return;
    }
    connLog.warn('[world] cmd-5 unsupported scene action type=%d', parsed.actionType);

  } else if (cmdIdx === 10) {
    if (session.phase === 'combat') {
      if (!session.combatInitialized) {
        connLog.debug('[world] cmd-10 weapon-fire ignored before combat initialization');
        return;
      }
      handleCombatWeaponFireFrame(players, session, payload, connLog, capture);
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

  } else if (cmdIdx === 20) {
    let selection = 0;
    if (payload.length >= 8) {
      const [slotPlusOne] = decodeArgType4(payload, 3);
      const requestedSlot = Number.isFinite(slotPlusOne) ? slotPlusOne - 1 : 0;
      selection = Math.max(0, requestedSlot);
    }
    if (handleMechPickerCmd20(session, selection, connLog, capture)) {
      return;
    }
    connLog.debug('[world] cmd-20 ignored outside mech picker: selection=%d', selection);

  } else if (cmdIdx === 21) {
    const parsed = parseClientCmd21TextReply(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-21 parse failed');
      return;
    }
    handleComstarTextReply(players, session, parsed.dialogId, parsed.text, connLog, capture);

  } else if (cmdIdx === 15) {
    if (session.phase !== 'world' || !session.worldInitialized) {
      connLog.debug(
        '[world] cmd-15 duel terms ignored outside initialized world phase: phase=%s worldInitialized=%s',
        session.phase,
        session.worldInitialized === true ? 'true' : 'false',
      );
      return;
    }
    const parsed = parseClientCmd15DuelTerms(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-15 duel terms parse failed');
      return;
    }
    handleDuelTermsSubmit(players, session, parsed.stakeA, parsed.stakeB, connLog, capture);

  } else if (cmdIdx === 23) {
    const parsed = parseClientCmd23LocationAction(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-23 location action parse failed');
      return;
    }
    handleLocationAction(players, session, parsed.slot, parsed.targetCached, connLog, capture);

  } else if (cmdIdx === 28) {
    if (session.phase !== 'world') {
      connLog.debug('[world] cmd-28 MORE ignored outside world phase: phase=%s', session.phase);
      return;
    }
    connLog.info('[world] cmd-28 MORE');
    handleActiveScrollListMore(session, connLog, capture);

  } else if (cmdIdx === 29) {
    const parsed = parseClientCmd29ControlFrame(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-29 parse failed');
      return;
    }

    connLog.info(
      '[world] cmd-29 control frame: subtype=%d controlId=%d value=%d',
      parsed.subtype,
      parsed.controlId,
      parsed.value,
    );

    if (parsed.subtype === 2) {
      connLog.info(
        '[world] cmd-29 menu reply: listId=%d selection=%d',
        parsed.controlId,
        parsed.value,
      );
      if (!dispatchWorldMenuSelection(
        players,
        session,
        parsed.controlId,
        parsed.value,
        connLog,
        capture,
      )) {
        connLog.debug(
          '[world] cmd-29 subtype-2 ignored: unsupported listId=%d',
          parsed.controlId,
        );
      }
      return;
    }

    connLog.debug(
      '[world] cmd-29 ignored: unsupported subtype=%d controlId=%d value=%d',
      parsed.subtype,
      parsed.controlId,
      parsed.value,
    );
  } else if (cmdIdx === 7) {
    const parsed = parseClientCmd7(payload);
    if (!parsed) {
      connLog.warn('[world] cmd-7 parse failed');
      return;
    }

    connLog.info(
      '[world] world menu reply (cmd-7): listId=%d selection=%d',
      parsed.listId,
      parsed.selection,
    );
    if (!dispatchWorldMenuSelection(
      players,
      session,
      parsed.listId,
      parsed.selection,
      connLog,
      capture,
    )) {
      connLog.debug('[world] cmd-7 ignored: unsupported listId=%d', parsed.listId);
    }
  } else if (session.phase === 'combat') {
    if (!session.combatInitialized) {
      connLog.debug('[world/combat] inbound combat cmd=%d ignored during DROP delay', cmdIdx);
      return;
    }
    // Combat-mode inbound frame (client sends Cmd8/Cmd9 for movement; weapon fire uses Cmd10).
    if (cmdIdx === 8 || cmdIdx === 9) {
      handleCombatMovementFrame(players, session, payload, connLog, capture);
    } else if (cmdIdx === 13) {
      handleCombatContactReportFrame(players, session, payload, connLog);
    } else if (cmdIdx === 12) {
      handleCombatActionFrame(players, session, payload, connLog, capture);
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
  const sceneRoomId = getSolarisSceneRoomId(roomId);
  connLog.info(
    '[world] sending Cmd4 SceneInit (logicalRoom=%d sceneRoom=%d header="%s" detail="%s")',
    roomId,
    sceneRoomId,
    getSolarisRoomName(roomId),
    getSolarisSceneHeaderDetail(roomId),
  );
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
    worldKeepalivePending: false,
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

      if (pkt.type !== Msg.KEEPALIVE) {
        session.worldKeepalivePending = false;
      }

      switch (pkt.type) {
        case Msg.LOGIN:
          handleWorldLogin(players, session, pkt.payload, connLog, capture).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            connLog.error('[world] uncaught error in handleWorldLogin: %s', msg);
            socket.destroy();
          });
          break;

        case Msg.SYNC:
          handleWorldGameData(players, session, pkt.payload, connLog, capture);
          break;

        case Msg.KEEPALIVE:
          if (session.phase === 'combat' && !session.worldKeepalivePending) {
            if (handleCombatKeepalivePacket(players, session, connLog)) {
              break;
            }
          }
          session.worldKeepalivePending = false;
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
    if (session.replacedBySessionId) {
      connLog.info(
        '[world] client disconnected (phase=%s, bytes=%d, replacedBy=%s)',
        session.phase,
        session.bytesReceived,
        session.replacedBySessionId.slice(0, 8),
      );
    } else {
      connLog.info(
        '[world] client disconnected (phase=%s, bytes=%d)',
        session.phase, session.bytesReceived,
      );
    }
    savePendingIncomingComstarPrompt(session, connLog, 'disconnect');
    handleArenaCombatDisconnect(players, session, connLog);
    clearSessionDuelState(players, session, connLog, 'player disconnected');
    if (!session.skipWorldResumeSave) {
      worldResumeRegistry.save(session);
    }
    if (session.worldInitialized) {
      notifyRoomDeparture(players, session, connLog);
    }
    players.remove(session.id);
    worldCaptures.delete(session.id);
    if (keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
    }
    stopCombatTimers(session);
    // Reset combat per-session counters so a reconnect starts fresh.
    if (
      session.combatShotsAccepted !== undefined ||
      session.combatShotsRejected !== undefined ||
      session.combatShotsAction0Correlated !== undefined ||
      session.combatShotsDirectCmd10 !== undefined ||
      session.combatAction0NoShotCount !== undefined
    ) {
      const durationMs = session.combatStartAt !== undefined
        ? Date.now() - session.combatStartAt
        : undefined;
      connLog.info(
        '[world/combat] session summary: requireAction0=%s accepted=%d rejected=%d ungatedAccepted=%d action0Correlated=%d action0NoShot=%d duration=%s',
        session.combatRequireAction0 === true ? 'true' : 'false',
        session.combatShotsAccepted ?? 0,
        session.combatShotsRejected ?? 0,
        session.combatShotsDirectCmd10 ?? 0,
        session.combatShotsAction0Correlated ?? 0,
        session.combatAction0NoShotCount ?? 0,
        durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : 'n/a',
      );
    }
    session.botHealth            = undefined;
    session.playerHealth         = undefined;
    session.combatBotHeadArmor = undefined;
    session.combatPlayerHeadArmor = undefined;
    session.combatBotCriticalStateBytes = undefined;
    session.combatPlayerArmorValues = undefined;
    session.combatPlayerInternalValues = undefined;
    session.combatPlayerCriticalStateBytes = undefined;
    session.combatRetaliationCursor = undefined;
    session.combatVerificationMode = undefined;
    session.combatJumpActive     = undefined;
    session.combatJumpFuel       = undefined;
    session.lastCombatFireActionAt = undefined;
    session.combatRequireAction0 = undefined;
    session.combatShotsAccepted = undefined;
    session.combatShotsRejected = undefined;
    session.combatShotsAction0Correlated = undefined;
    session.combatShotsDirectCmd10 = undefined;
    session.combatAction0NoShotCount = undefined;
    session.combatStartAt = undefined;
    capture.close();
  });

  socket.setNoDelay(true);
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
      if (session.phase === 'combat') {
        return;
      }
      connLog.debug('[world] keepalive — sending ping');
      session.worldKeepalivePending = true;
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
