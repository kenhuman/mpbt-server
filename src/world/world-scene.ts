/**
 * World server — session helpers and scene/UI packet builders.
 *
 * Low-level send wrappers, session state accessors, player-presence queries,
 * and all functions that construct and dispatch UI packets (scene init, roster
 * lists, personnel records, travel map).
 */

import * as net from 'net';

import { listCharacters, STARTING_CBILLS } from '../db/characters.js';
import {
  type DuelResultRow,
  listAllDuelResults,
} from '../db/duel-results.js';
import {
  buildCmd3BroadcastPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd6CursorBusyPacket,
  buildCmd10RoomPresenceSyncPacket,
  buildCmd14PersonnelRecordPacket,
  buildCmd43SolarisMapPacket,
  buildCmd46ClearWorldUiChildrenPacket,
  buildCmd48KeyedTripleStringListPacket,
} from '../protocol/world.js';
import {
  buildMenuDialogPacket,
  buildMechListPacket,
} from '../protocol/game.js';
import { PlayerRegistry, ClientSession } from '../state/players.js';
import { Logger }         from '../util/logger.js';
import { CaptureLogger }  from '../util/capture.js';

import {
  worldCaptures,
  DEFAULT_MAP_ROOM_ID,
  ALL_ROSTER_LIST_ID,
  COMSTAR_SEND_TARGET_MENU_ID,
  COMSTAR_SEND_TARGET_MENU_ITEMS,
  COMSTAR_ACCESS_MENU_ID,
  INQUIRY_MENU_ID,
  MATCH_RESULTS_MENU_LIST_ID,
  NEWS_CATEGORY_MENU_ID,
  NEWS_CATEGORY_MENU_ITEMS,
  NEWSGRID_ARTICLE_LIST_ID,
  TIER_RANKING_CHOOSER_LIST_ID,
  TIER_RANKING_CHOOSER_ITEMS,
  CLASS_RANKING_CHOOSER_LIST_ID,
  CLASS_RANKING_CHOOSER_ITEMS,
  TIER_RANKING_RESULTS_LIST_ID,
  CLASS_RANKING_RESULTS_LIST_ID,
  PERSONNEL_LIST_ID,
  ARENA_READY_ROOM_MENU_ID,
  ARENA_SIDE_ACTION_TYPE,
  ARENA_STATUS_ACTION_TYPE,
  ARENA_SIDE_MENU_ID,
  ARENA_STATUS_LIST_ID,
  ARENA_READY_ROOM_MAX_PARTICIPANTS,
  ARENA_SIDE_MENU_ITEMS,
  COMSTAR_ACCESS_ACTION_TYPE,
  FALLBACK_MECH_ID,
  SOLARIS_TRAVEL_CONTEXT_ID,
  SOLARIS_TRAVEL_ACTION_TYPE,
  GLOBAL_COMSTAR_MENU_ITEMS,
  worldMapByRoomId,
  WORLD_MECH_BY_ID,
  getSolarisRoomSlottedExits,
  getSolarisSceneIndex,
  getSolarisSceneRoomId,
  getSolarisRoomName,
  getSolarisDistrictName,
  getSolarisSceneHeaderDetail,
  getSolarisSceneHeaderTitle,
  getSolarisRoomIcon,
  WORLD_MECHS,
  getMechChassis,
  getMechChassisListForClass,
  getMechWeightClass,
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
import {
  computeSolarisStandings,
  type SolarisStanding,
  formatSolarisRankLabel,
  formatSolarisStandingLine,
} from './solaris-rankings.js';

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

function formatMechPickerVariantSummary(mech: {
  tonnage: number;
  walkSpeedMag: number;
  maxSpeedMag: number;
  jumpJetCount: number;
}): string {
  const parts = [`${mech.tonnage}T`, `${mechKph(mech.walkSpeedMag)}/${mechKph(mech.maxSpeedMag)}kph`];
  if (mech.jumpJetCount > 0) {
    parts.push(`JJ:${mech.jumpJetCount}`);
  }
  return parts.join(' ');
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

export function arenaReadyRoomKey(roomId: number, readyRoomId: number): string {
  return `arena_ready_room_${roomId}_${readyRoomId}`;
}

export function parseArenaReadyRoomKey(roomKey: string): { roomId: number; readyRoomId: number } | undefined {
  const match = /^arena_ready_room_(\d+)_(\d+)$/.exec(roomKey);
  if (!match) {
    return undefined;
  }
  const roomId = Number.parseInt(match[1] ?? '', 10);
  const readyRoomId = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(roomId) || !Number.isFinite(readyRoomId) || readyRoomId < 1) {
    return undefined;
  }
  return { roomId, readyRoomId };
}

export function getArenaReadyRoomLabel(readyRoomId: number | undefined): string {
  if (readyRoomId === undefined || readyRoomId < 1) {
    return 'Ready Room';
  }
  return `Ready Room ${readyRoomId}`;
}

export function getArenaReadyRoomId(session: ClientSession): number | undefined {
  const parsed = parseArenaReadyRoomKey(session.roomId);
  if (parsed && parsed.roomId === session.worldMapRoomId) {
    return parsed.readyRoomId;
  }
  return session.worldArenaReadyRoomId;
}

export function getArenaReadyRoomLabelForSession(session: ClientSession): string | undefined {
  const roomId = session.worldMapRoomId;
  if (roomId === undefined || worldMapByRoomId.get(roomId)?.type !== 'arena') {
    return undefined;
  }
  const readyRoomId = getArenaReadyRoomId(session);
  if (readyRoomId === undefined) {
    return undefined;
  }
  return getArenaReadyRoomLabel(readyRoomId);
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
  const roomName = roomId === undefined ? 'world' : getSolarisRoomName(roomId);
  const readyRoomLabel = getArenaReadyRoomLabelForSession(session);
  const room = readyRoomLabel ? `${roomName} - ${readyRoomLabel}` : roomName;
  if (status <= 5) return `Standing in ${room}`;
  if (status <= 12) return `Booth ${status - 5} in ${room}`;
  return `Status ${status}`;
}

export function getArenaSideLabel(side: number | undefined): string {
  if (side === undefined || side < 1 || side > 8) {
    return 'Open';
  }
  return `Side ${side}`;
}

function getArenaReadyState(session: ClientSession): string {
  if (session.selectedMechId === undefined) {
    return 'NOT READY - no mech picked';
  }
  const mech = WORLD_MECH_BY_ID.get(session.selectedMechId);
  const chassis = mech ? getMechChassis(mech.typeString) : `Mech ${session.selectedMechId}`;
  return session.worldArenaReady ? `READY - ${chassis}` : `NOT READY - ${chassis}`;
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
      col3:   getSolarisDistrictName(other.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID),
    }));
}

function buildArenaStatusEntries(players: PlayerRegistry, session: ClientSession) {
  return players.inRoom(session.roomId)
    .filter(other =>
      other.phase === 'world' &&
      other.worldInitialized &&
      !other.socket.destroyed &&
      other.worldRosterId !== undefined,
    )
    .slice()
    .sort((a, b) => {
      const sideDiff = (a.worldArenaSide ?? 9) - (b.worldArenaSide ?? 9);
      if (sideDiff !== 0) return sideDiff;
      return getDisplayName(a).localeCompare(getDisplayName(b));
    })
    .map(other => ({
      itemId: getComstarId(other),
      col1: getDisplayName(other),
      col2: getArenaSideLabel(other.worldArenaSide),
      col3: getArenaReadyState(other),
    }));
}

interface PersonnelRecordContext {
  standing?: SolarisStanding;
  latestResult?: DuelResultRow;
}

function countMatchesForAccount(results: DuelResultRow[], accountId: number | undefined): number {
  if (!accountId) return 0;
  let matches = 0;
  for (const result of results) {
    if (result.winner_account_id === accountId || result.loser_account_id === accountId) {
      matches += 1;
    }
  }
  return matches;
}

function findLatestDuelResultForAccount(
  results: DuelResultRow[],
  accountId: number | undefined,
): DuelResultRow | undefined {
  if (!accountId) return undefined;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const result = results[i];
    if (result.winner_account_id === accountId || result.loser_account_id === accountId) {
      return result;
    }
  }
  return undefined;
}

function buildLastDuelLine(target: ClientSession, latestResult?: DuelResultRow): string {
  const accountId = target.accountId;
  if (!latestResult || !accountId) {
    return 'Last duel: None';
  }
  const won = latestResult.winner_account_id === accountId;
  const opponent = won ? latestResult.loser_display_name : latestResult.winner_display_name;
  return `Last duel: ${won ? 'Won' : 'Lost'} vs ${opponent}`;
}

function getPersonnelMechSummary(target: ClientSession): { chassis: string; classLabel: string } {
  const mech = WORLD_MECH_BY_ID.get(target.selectedMechId ?? FALLBACK_MECH_ID);
  const chassis = mech ? getMechChassis(mech.typeString) : 'Unknown';
  const classKey = mech ? getMechWeightClass(mech) : undefined;
  const classLabel = classKey
    ? `${classKey.charAt(0)}${classKey.slice(1).toLowerCase()}`
    : 'Unknown';
  return { chassis, classLabel };
}

function formatPersonnelLong(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(10);
}

function getPersonnelEconomySummary(target: ClientSession): { earnings: number; wealth: number } {
  const wealth = Math.max(0, Math.trunc(target.cbills ?? 0));
  return {
    earnings: Math.max(0, wealth - STARTING_CBILLS),
    wealth,
  };
}

export function buildPersonnelRecordLines(
  target: ClientSession,
  page: number,
  context: PersonnelRecordContext = {},
): string[] {
  const { standing, latestResult } = context;
  const { chassis, classLabel } = getPersonnelMechSummary(target);
  const { earnings, wealth } = getPersonnelEconomySummary(target);
  if (page <= 1) {
    return [
      // The client's Cmd14 header always shows the querying user's own callsign
      // as "Handle" (it reads from the room-roster selection cursor, which
      // defaults to self).  We have no wire field that overrides it, so we
      // repeat the correct handle as the first body line.
      `Handle  : ${getDisplayName(target)}`,
      `Rank    : ${formatSolarisRankLabel(standing)}`,
      formatSolarisStandingLine(target.allegiance, standing),
      `Earnings: ${formatPersonnelLong(earnings)}`,
      `Wealth  : ${formatPersonnelLong(wealth)}`,
      `ID      : ${getComstarId(target)}`,
    ];
  }

  return [
    `Stable  : ${chassis} (${classLabel})`,
    `Location : ${getPresenceLocation(target)}`,
    'Status   : Online',
    `Score    : ${standing?.score ?? 0}`,
    `Record   : ${standing?.ratioText ?? '0/0'}`,
    buildLastDuelLine(target, latestResult),
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
  const logicalRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneRoomId = getSolarisSceneRoomId(logicalRoomId);
  connLog.info(
    '[world] sending Cmd43 Solaris travel map: logicalRoomId=%d sceneRoomId=%d',
    logicalRoomId,
    sceneRoomId,
  );
  send(
    session.socket,
    buildCmd43SolarisMapPacket(
      {
        contextId: SOLARIS_TRAVEL_CONTEXT_ID,
        currentRoomId: sceneRoomId,
      },
      nextSeq(session),
    ),
    capture,
    'CMD43_SOLARIS_MAP',
  );
}

export function buildSceneInitForSession(session: ClientSession) {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneRoomId = getSolarisSceneRoomId(roomId);
  const sceneIndex = getSolarisSceneIndex(sceneRoomId);

  // Build a 4-slot array (N=0, S=1, E=2, W=3) preserving direction positions.
  // These `type` values are client scene-cache row ids, not travel-map room ids.
  // Keep generated road/tram exits on their own synthetic scene slots here; if
  // several visible icons alias back to the current retail scene slot, the
  // v1.29 local room-roster/modal path can stall until a Windows focus repaint.
  // The player's current scene slot remains retail-anchored: live launch tests
  // showed v1.29 can tear down its socket window during startup when a generated
  // road node is used as the primary scene table row.
  const mapRoom = worldMapByRoomId.get(roomId);
  const slottedExits = getSolarisRoomSlottedExits(roomId);

  const exitMask = slottedExits.reduce<number>(
    (mask, id, slot) => (id !== null ? mask | (1 << slot) : mask),
    0,
  );

  // Room-type-aware action buttons.
  // actionType 4 is reserved for the fixed lower-left world icon path.
  // Solaris map access primarily hangs off tram location icons, but keep a
  // top-row Travel fallback so players can recover if they get stuck.
  // actionType 5 → "Fight"  (enter combat; handled by cmd-5 dispatch in server-world.ts).
  // actionType 6 → "Mech"/"Mech Bay" (opens the 3-step mech picker).
  // The client hard-codes button 0x100 as a local-only Help slot and only
  // dispatches 0x101..0x105, so arena rows must fit within 5 forwarded buttons.
  // Preserve the retail-style MECH/SIDE/STATUS/FIGHT surface in arenas and
  // leave READY on the text-command path.
  const roomType = mapRoom?.type;
  const isArena = roomType === 'arena';
  const hasTerminalAccess = roomType === 'bar' || roomType === 'terminal';
  const readyRoomLabel = isArena ? getArenaReadyRoomLabelForSession(session) : undefined;
  const arenaOptions: Array<{ type: number; label: string }> = [
    { type: 0, label: 'Help' },
    { type: SOLARIS_TRAVEL_ACTION_TYPE, label: 'Travel' },
  ];
  if (isArena) {
    arenaOptions.push({ type: 6, label: 'Mech' });
    arenaOptions.push({ type: ARENA_SIDE_ACTION_TYPE, label: 'Side' });
    if (session.duelTermsAvailable) {
      arenaOptions.push({ type: 7, label: 'Duel Terms' });
    } else {
      arenaOptions.push({ type: ARENA_STATUS_ACTION_TYPE, label: 'Status' });
    }
    arenaOptions.push({ type: 5, label: 'Fight' });
  } else {
    arenaOptions.push({ type: 6, label: 'Mech Bay' });
    if (hasTerminalAccess) {
      arenaOptions.push({ type: COMSTAR_ACCESS_ACTION_TYPE, label: 'Terminal' });
    }
  }

  const sceneDetailBase = getSolarisSceneHeaderDetail(roomId);
  const sceneDetail = readyRoomLabel
    ? `${readyRoomLabel}${sceneDetailBase ? ` - ${sceneDetailBase}` : ''}`
    : sceneDetailBase;

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
            arr[slot] = {
              type: getSolarisSceneIndex(exitRoomId),
              mechId: getSolarisRoomIcon(exitRoomId),
            };
          }
        }
        return arr;
      })(),
      sceneHeader:      getSolarisSceneHeaderTitle(roomId),
      sceneDetail,
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
  const logicalRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneRoomId = getSolarisSceneRoomId(logicalRoomId);
  connLog.info(
    '[world] scene refresh: logicalRoomId=%d sceneRoomId=%d header="%s"',
    logicalRoomId,
    sceneRoomId,
    getSolarisSceneHeaderTitle(logicalRoomId),
  );
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

export function sendWorldUiRestore(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  reason: string,
): void {
  const logicalRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneRoomId = getSolarisSceneRoomId(logicalRoomId);
  connLog.info(
    '[world] restoring world UI after %s: logicalRoomId=%d sceneRoomId=%d',
    reason,
    logicalRoomId,
    sceneRoomId,
  );
  send(
    session.socket,
    buildCmd46ClearWorldUiChildrenPacket(nextSeq(session)),
    capture,
    'CMD46_CLEAR_WORLD_UI_CHILDREN',
  );
  send(session.socket, buildSceneInitForSession(session), capture, 'CMD4_SCENE_RESTORE');

  const roomPresenceEntries = currentRoomPresenceEntries(players, session);
  connLog.info('[world] restoring Cmd10 RoomPresenceSync (%d entries)', roomPresenceEntries.length);
  send(
    session.socket,
    buildCmd10RoomPresenceSyncPacket(roomPresenceEntries, nextSeq(session)),
    capture,
    'CMD10_ROOM_RESTORE',
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
      'Show All Players',
      entries,
      nextSeq(session),
    ),
    capture,
    'CMD48_ALL_ROSTER',
  );
}

export function sendArenaSideMenu(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  connLog.info('[world] sending arena side menu');
  send(
    session.socket,
    buildMenuDialogPacket(
      ARENA_SIDE_MENU_ID,
      'Choose a side:',
      [...ARENA_SIDE_MENU_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD7_ARENA_SIDE_MENU',
  );
}

export function sendArenaStatusList(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const entries = buildArenaStatusEntries(players, session);
  const readyRoomLabel = getArenaReadyRoomLabelForSession(session);
  const titlePrefix = readyRoomLabel ? `${readyRoomLabel} Status` : 'Arena Status';
  connLog.info('[world] sending arena status list (%d entries)', entries.length);
  send(
    session.socket,
    buildCmd48KeyedTripleStringListPacket(
      ARENA_STATUS_LIST_ID,
      `${titlePrefix} (${entries.length}/${ARENA_READY_ROOM_MAX_PARTICIPANTS})`,
      entries,
      nextSeq(session),
    ),
    capture,
    'CMD48_ARENA_STATUS',
  );
}

export function sendArenaReadyRoomMenu(
  session: ClientSession,
  arenaRoomId: number,
  roomOptions: Array<{ readyRoomId: number; label: string }>,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingArenaReadyRoomArenaId = arenaRoomId;
  session.pendingArenaReadyRoomChoices = roomOptions.map(option => option.readyRoomId);
  connLog.info('[world] sending arena ready-room menu: arena=%d options=%d', arenaRoomId, roomOptions.length);
  send(
    session.socket,
    buildMenuDialogPacket(
      ARENA_READY_ROOM_MENU_ID,
      `Select a ready room in ${getSolarisRoomName(arenaRoomId)} (empty=droids, players=PvP):`,
      roomOptions.map(option => option.label),
      nextSeq(session),
    ),
    capture,
    'CMD7_ARENA_READY_ROOM_MENU',
  );
}

export function sendComstarAccessMenu(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const roomType = worldMapByRoomId.get(roomId)?.type;
  connLog.info('[world] sending Cmd7 ComStar access menu: room=%d type=%s', roomId, roomType ?? 'unknown');
  send(
    session.socket,
    buildMenuDialogPacket(
      COMSTAR_ACCESS_MENU_ID,
      'Choose option:',
      GLOBAL_COMSTAR_MENU_ITEMS.map(item => item.text),
      nextSeq(session),
    ),
    capture,
    'CMD7_COMSTAR_MENU',
  );
}

export function sendComstarSendTargetMenu(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  connLog.info('[world] sending ComStar send-target menu');
  send(
    session.socket,
    buildMenuDialogPacket(
      COMSTAR_SEND_TARGET_MENU_ID,
      'Who do you wish to send this to?',
      [...COMSTAR_SEND_TARGET_MENU_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD7_COMSTAR_SEND_TARGET_MENU',
  );
}

export function sendNewsCategoryMenu(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  connLog.info('[world] sending news category menu');
  send(
    session.socket,
    buildMenuDialogPacket(
      NEWS_CATEGORY_MENU_ID,
      'What news do you wish to see?',
      [...NEWS_CATEGORY_MENU_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD7_NEWS_CATEGORY_MENU',
  );
}

export function sendNewsgridArticleMenu(
  session: ClientSession,
  articleIds: number[],
  articleTitles: string[],
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingNewsArticleIds = articleIds;
  connLog.info('[world] sending newsgrid article menu (%d entries)', articleIds.length);
  send(
    session.socket,
    buildMenuDialogPacket(
      NEWSGRID_ARTICLE_LIST_ID,
      'Access Newsgrid',
      articleTitles,
      nextSeq(session),
    ),
    capture,
    'CMD7_NEWSGRID_ARTICLE_MENU',
  );
}

export function sendTierRankingChooser(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  title = 'Choose a ranking tier:',
): void {
  // v1.29 ranking-result pages now use the later scroll-shell family, but the
  // exact late-client chooser transport is still under RE. Keep using the
  // proven Cmd7 compatibility menu until the Cmd57 preset-strip/paging contract
  // is solid enough to replace it safely. The row-body and submit path are no
  // longer the blocker: `World_SendMenuSelection_v129` still emits ordinary
  // cmd-7 single-pick replies, and the recovered Cmd57 row body is a counted
  // `(selectionValue, rowText)` list. The remaining gap is the preset-strip
  // state needed to page or expose more than the six directly handled row
  // controls (`0x100..0x105`) in the late client.
  connLog.info('[world] sending compatibility Cmd7 tier ranking chooser');
  send(
    session.socket,
    buildMenuDialogPacket(
      TIER_RANKING_CHOOSER_LIST_ID,
      title,
      TIER_RANKING_CHOOSER_ITEMS.map(item => item.text),
      nextSeq(session),
    ),
    capture,
    'CMD7_TIER_RANKING_CHOOSER',
  );
}

export function sendClassRankingChooser(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  // Same note as the tier chooser above: the unresolved gap is now the Cmd57
  // preset/header contract rather than the row body or submit path. Current RE
  // suggests the preset byte selects a stock art/control bundle (not just a
  // simple row-only style), so even this 4-row chooser is not yet safe to
  // migrate speculatively.
  connLog.info('[world] sending compatibility Cmd7 class ranking chooser');
  send(
    session.socket,
    buildMenuDialogPacket(
      CLASS_RANKING_CHOOSER_LIST_ID,
      'Choose a mech class:',
      CLASS_RANKING_CHOOSER_ITEMS.map(item => item.text),
      nextSeq(session),
    ),
    capture,
    'CMD7_CLASS_RANKING_CHOOSER',
  );
}

export function sendRankingResultsList(
  session: ClientSession,
  listId: number,
  title: string,
  rows: string[],
  hasMore: boolean,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const items = [...rows];
  if (hasMore) items.push('More...');
  const label = listId === MATCH_RESULTS_MENU_LIST_ID
    ? 'CMD7_MATCH_RESULTS_MENU'
    : listId === TIER_RANKING_RESULTS_LIST_ID
      ? 'CMD7_TIER_RANKINGS'
      : 'CMD7_CLASS_RANKINGS';
  connLog.info(
    '[world] sending Cmd7 paged results menu: listId=%d rows=%d more=%s',
    listId,
    rows.length,
    hasMore ? 'true' : 'false',
  );
  send(
    session.socket,
    buildMenuDialogPacket(
      listId,
      title,
      items,
      nextSeq(session),
    ),
    capture,
    label,
  );
}

export function sendMatchResultsMenu(
  session: ClientSession,
  resultIds: number[],
  labels: string[],
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingMatchResultIds = resultIds;
  connLog.info('[world] sending Solaris match results menu (%d entries)', resultIds.length);
  send(
    session.socket,
    buildMenuDialogPacket(
      MATCH_RESULTS_MENU_LIST_ID,
      'Solaris Match Results',
      labels,
      nextSeq(session),
    ),
    capture,
    'CMD7_MATCH_RESULTS_MENU',
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

  // The client's Cmd14 header splits its data sources:
  //   - Handle comes from the local room-presence table (Cmd10/Cmd13), keyed by worldRosterId.
  //   - ID comes from the packet's type4 comstarId field.
  // World login now aligns authenticated worldRosterId with the pilot's real
  // ComStar ID, so Cmd14 can usually drive both header fields correctly with a
  // single identifier. The body `ID` line remains as a compatibility fallback
  // for any non-authenticated or legacy/fallback presence IDs.
  const presenceId = target.worldRosterId ?? 0;

  connLog.info(
    '[world] sending Cmd14 personnel record: presenceId=%d handle="%s" page=%d',
    presenceId,
    getDisplayName(target),
    page,
  );
  const startedAt = Date.now();
  Promise.all([listAllDuelResults(), listCharacters()])
    .then(([results, characters]) => {
      if (session.socket.destroyed || !session.socket.writable) return;
      const standing = target.accountId === undefined
        ? undefined
        : computeSolarisStandings(results, characters)
          .find(entry => entry.accountId === target.accountId);
      const latestResult = findLatestDuelResultForAccount(results, target.accountId);
      send(
        session.socket,
        buildCmd14PersonnelRecordPacket(
          {
            comstarId:     presenceId,
            battlesToDate: standing?.matches ?? countMatchesForAccount(results, target.accountId),
            lines:         buildPersonnelRecordLines(target, page, { standing, latestResult }),
          },
          nextSeq(session),
        ),
        capture,
        page <= 1 ? 'CMD14_PERSONNEL_P1' : 'CMD14_PERSONNEL_P2',
      );
      connLog.debug(
        '[world] Cmd14 personnel record ready in %d ms (results=%d characters=%d)',
        Date.now() - startedAt,
        results.length,
        characters.length,
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to build personnel record: %s', detail);
      if (session.socket.destroyed || !session.socket.writable) return;
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
      connLog.debug(
        '[world] Cmd14 personnel record fallback sent in %d ms',
        Date.now() - startedAt,
      );
    });
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
  options: {
    target?: 'player' | 'bot';
    botIndex?: number;
  } = {},
): void {
  session.mechPickerStep        = 'class';
  session.mechPickerTarget      = options.target ?? 'player';
  session.mechPickerTargetBotIndex = session.mechPickerTarget === 'bot'
    ? Math.max(0, Math.min(6, options.botIndex ?? 0))
    : undefined;
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
      jumpJetCount:   0,
      heatSinks:      0,
      armorLikeMaxValues: Array<number>(10).fill(0),
      weaponMountInternalIndices: [],
      weaponTypeIds: [],
      ammoBinCapacities: [],
      ammoBinTypeIds: [],
    };
  });
  connLog.info(
    '[world] sending mech class picker: target=%s%s',
    session.mechPickerTarget,
    session.mechPickerTarget === 'bot'
      ? ` index=${(session.mechPickerTargetBotIndex ?? 0) + 1}`
      : '',
  );
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
      jumpJetCount: 0,
      heatSinks:  0,
      armorLikeMaxValues: Array<number>(10).fill(0),
      weaponMountInternalIndices: [],
      weaponTypeIds: [],
      ammoBinCapacities: [],
      ammoBinTypeIds: [],
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
    variant:    formatMechPickerVariantSummary(mech),
    name:       mech.typeString,
    walkSpeedMag: mech.walkSpeedMag,
    maxSpeedMag: mech.maxSpeedMag,
    extraCritCount: mech.extraCritCount,
    tonnage:    mech.tonnage,
    jumpJetCount: mech.jumpJetCount,
    heatSinks: mech.heatSinks,
    armorLikeMaxValues: mech.armorLikeMaxValues,
    weaponMountInternalIndices: mech.weaponMountInternalIndices,
    weaponTypeIds: mech.weaponTypeIds,
    ammoBinCapacities: mech.ammoBinCapacities,
    ammoBinTypeIds: mech.ammoBinTypeIds,
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
