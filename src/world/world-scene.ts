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
  buildCmd45ScrollListContent,
  buildCmd45ScrollListShellPacket,
  buildCmd43SolarisMapPacket,
  buildCmd48KeyedTripleStringListPacket,
  buildCmd58SetScrollListIdPacket,
} from '../protocol/world.js';
import {
  buildCmd44KeyedSingleStringListPacket,
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
  COMSTAR_ACCESS_ACTION_TYPE,
  ARENA_SIDE_ACTION_TYPE,
  ARENA_STATUS_ACTION_TYPE,
  ARENA_SIDE_MENU_ID,
  ARENA_STATUS_LIST_ID,
  ARENA_READY_ROOM_MAX_PARTICIPANTS,
  ARENA_SIDE_MENU_ITEMS,
  FALLBACK_MECH_ID,
  SOLARIS_TRAVEL_CONTEXT_ID,
  TERMINAL_MENU_ITEMS,
  TERMINAL_MENU_LIST_ID,
  worldMapByRoomId,
  WORLD_MECH_BY_ID,
  getSolarisRoomExits,
  getSolarisSceneIndex,
  getSolarisRoomName,
  getSolarisRoomDescription,
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
  const room = roomId === undefined ? 'world' : getSolarisRoomName(roomId);
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
    return 'No mech picked';
  }
  const mech = WORLD_MECH_BY_ID.get(session.selectedMechId);
  const chassis = mech ? getMechChassis(mech.typeString) : `Mech ${session.selectedMechId}`;
  return `Picked: ${chassis}`;
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
      col3:   getPresenceLocation(other),
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

export function buildSceneInitForSession(session: ClientSession) {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const sceneIndex = getSolarisSceneIndex(roomId);

  // Build a 4-slot array (N=0, S=1, E=2, W=3) preserving direction positions.
  // When using world-map.json the exits array already has nulls for empty slots.
  // When using the fallback, compact exits are back-filled starting at slot 0.
  const mapRoom = worldMapByRoomId.get(roomId);
  let slottedExits: (number | null)[];
  if (mapRoom) {
    const { north, south, east, west } = mapRoom.exits;
    slottedExits = [north, south, east, west];
  } else {
    const exits = getSolarisRoomExits(roomId);
    slottedExits = [
      exits[0] ?? null,
      exits[1] ?? null,
      exits[2] ?? null,
      exits[3] ?? null,
    ];
  }

  const exitMask = slottedExits.reduce<number>(
    (mask, id, slot) => (id !== null ? mask | (1 << slot) : mask),
    0,
  );

  // Room-type-aware action buttons.
  // actionType 4 → "Travel" (opens Cmd43 travel map).
  // actionType 5 → "Fight"  (enter combat; handled by cmd-5 dispatch in server-world.ts).
  // actionType 6 → "Mech"/"Mech Bay" (opens the 3-step mech picker).
  // actionType 8 → "ComStar"/"Terminal" (opens the Cmd44 utility menu).
  // The client hard-codes actionType 0 (0x100 wire) as the local Help button.
  const isArena = mapRoom?.type === 'arena';
  const hasRoomTerminal = mapRoom?.type === 'bar' || mapRoom?.type === 'terminal';
  const arenaOptions: Array<{ type: number; label: string }> = [
    { type: 0, label: 'Help' },
    { type: 4, label: 'Travel' },
  ];
  if (isArena) {
    arenaOptions.push({ type: 6, label: 'Mech' });
    arenaOptions.push({ type: ARENA_SIDE_ACTION_TYPE, label: 'Side' });
    arenaOptions.push({ type: ARENA_STATUS_ACTION_TYPE, label: 'Status' });
    arenaOptions.push({ type: COMSTAR_ACCESS_ACTION_TYPE, label: hasRoomTerminal ? 'Terminal' : 'ComStar' });
    if (session.duelTermsAvailable) {
      arenaOptions.push({ type: 7, label: 'Duel Terms' });
    }
    arenaOptions.push({ type: 5, label: 'Fight' });
  } else {
    arenaOptions.push({ type: 6, label: 'Mech Bay' });
    arenaOptions.push({ type: COMSTAR_ACCESS_ACTION_TYPE, label: hasRoomTerminal ? 'Terminal' : 'ComStar' });
  }

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
            arr[slot] = { type: getSolarisSceneIndex(exitRoomId), mechId: getSolarisRoomIcon(exitRoomId) };
          }
        }
        return arr;
      })(),
      callsign:         getDisplayName(session),
      sceneName:        (() => {
        const name = getSolarisRoomName(roomId);
        const desc = getSolarisRoomDescription(roomId);
        // 0x5C (\) is a hard line-break in both FUN_00416710 and FUN_00431320
        return desc ? `${name}\x5c${desc}` : name;
      })(),
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
      'All Personnel Online',
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
  connLog.info('[world] sending arena status list (%d entries)', entries.length);
  send(
    session.socket,
    buildCmd48KeyedTripleStringListPacket(
      ARENA_STATUS_LIST_ID,
      `Arena Status (${entries.length}/${ARENA_READY_ROOM_MAX_PARTICIPANTS})`,
      entries,
      nextSeq(session),
    ),
    capture,
    'CMD48_ARENA_STATUS',
  );
}

export function sendComstarAccessMenu(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const roomType = worldMapByRoomId.get(roomId)?.type;
  connLog.info('[world] sending Cmd44 ComStar access menu: room=%d type=%s', roomId, roomType ?? 'unknown');
  send(
    session.socket,
    buildCmd44KeyedSingleStringListPacket(
      TERMINAL_MENU_LIST_ID,
      'Choose option:',
      [...TERMINAL_MENU_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD44_COMSTAR_MENU',
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
): void {
  connLog.info('[world] sending tier ranking chooser');
  send(
    session.socket,
    buildCmd44KeyedSingleStringListPacket(
      TIER_RANKING_CHOOSER_LIST_ID,
      'Choose a ranking tier:',
      [...TIER_RANKING_CHOOSER_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD44_TIER_RANKING_CHOOSER',
  );
}

export function sendClassRankingChooser(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  connLog.info('[world] sending class ranking chooser');
  send(
    session.socket,
    buildCmd44KeyedSingleStringListPacket(
      CLASS_RANKING_CHOOSER_LIST_ID,
      'Choose a mech class:',
      [...CLASS_RANKING_CHOOSER_ITEMS],
      nextSeq(session),
    ),
    capture,
    'CMD44_CLASS_RANKING_CHOOSER',
  );
}

export function sendRankingResultsList(
  session: ClientSession,
  listId: number,
  title: string,
  rows: Array<{ itemId: number; text: string }>,
  hasMore: boolean,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const content = buildCmd45ScrollListContent(title, rows);
  const mode = hasMore ? 2 : 0;
  connLog.info(
    '[world] sending Cmd45 ranking shell: listId=%d rows=%d mode=%d more=%s',
    listId,
    rows.length,
    mode,
    hasMore ? 'true' : 'false',
  );
  send(
    session.socket,
    buildCmd58SetScrollListIdPacket(listId, nextSeq(session)),
    capture,
    'CMD58_SCROLL_LIST_ID',
  );
  send(
    session.socket,
    buildCmd45ScrollListShellPacket(mode, content, nextSeq(session)),
    capture,
    listId === TIER_RANKING_RESULTS_LIST_ID ? 'CMD45_TIER_RANKINGS' : 'CMD45_CLASS_RANKINGS',
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
): void {
  session.mechPickerStep        = 'class';
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
      armorLikeMaxValues: Array<number>(10).fill(0),
      weaponMountInternalIndices: [],
    };
  });
  connLog.info('[world] sending mech class picker');
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
      armorLikeMaxValues: Array<number>(10).fill(0),
      weaponMountInternalIndices: [],
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
    armorLikeMaxValues: mech.armorLikeMaxValues,
    weaponMountInternalIndices: mech.weaponMountInternalIndices,
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
