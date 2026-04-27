/**
 * World server — command and event handlers.
 *
 * All gameplay event handlers: ComStar messaging, room menu actions, combat
 * bootstrap, text commands, map travel, compass navigation, and room
 * arrival/departure notifications.
 */

import {
  buildCmd14PersonnelRecordPacket,
  buildCmd3BroadcastPacket,
  buildCmd17DuelTermsPacket,
  buildCmd4SceneInitPacket,
  buildCmd5CursorNormalPacket,
  buildCmd11PlayerEventPacket,
  buildCmd13PlayerArrivalPacket,
} from '../protocol/world.js';
import {
  buildCmd20Packet,
  buildCmd36MessageViewPacket,
  buildCmd37OpenComposePacket,
  parseClientCmd10WeaponFire,
  parseClientCmd13ContactReport,
  parseClientCmd12Action,
  parseClientCmd8Coasting,
  parseClientCmd9Moving,
} from '../protocol/game.js';
import { buildCombatWelcomePacket, buildWelcomePacket }    from '../protocol/auth.js';
import { findAccountById } from '../db/accounts.js';
import {
  fetchLatestPublishedArticle,
  fetchLatestPublishedArticleForTerm,
  fetchPublishedArticleById,
  listLatestPublishedArticles,
} from '../db/articles.js';
import {
  createDuelResult,
  type DuelResultRow,
  fetchDuelResultById,
  listAllDuelResults,
  listRecentDuelResults,
  updateDuelResultSettlement,
} from '../db/duel-results.js';
import {
  isDisplayNameTaken,
  listCharacters,
  settleDuelStakeTransfer,
  updateCharacterDisplayName,
  updateCharacterMech,
} from '../db/characters.js';
import {
  buildCmd62CombatStartPacket,
  buildCmd63ArenaSceneInitPacket,
  buildCmd64RemoteActorPacket,
  buildCmd72LocalBootstrapPacket,
  buildCmd65PositionSyncPacket,
  buildCmd66ActorDamagePacket,
  buildCmd67LocalDamagePacket,
  buildCmd68ProjectileSpawnPacket,
  buildCmd70ActorTransitionPacket,
  buildCmd71ResetEffectStatePacket,
  buildCmd73ActorRatePacket,
  buildCmd75CombatResultPacket,
  COMBAT_RESULT_LOSS,
  COMBAT_RESULT_VICTORY,
  COORD_BIAS,
  FACING_ACCUMULATOR_NEUTRAL,
  MOTION_DIV,
  MOTION_NEUTRAL,
} from '../protocol/combat.js';
import { PlayerRegistry, ClientSession, type CombatSession, type DuelCombatSession, type SoloCombatBotActorState } from '../state/players.js';
import { worldResumeRegistry } from '../state/world-resume.js';
import {
  countSavedUnreadMessages,
  fetchNextSavedUnreadMessage,
  markDelivered,
  markRead,
  markSaved,
  storeMessage,
} from '../db/messages.js';
import { Logger }        from '../util/logger.js';
import { CaptureLogger } from '../util/capture.js';
import { buildMechExamineText, MECH_STATS } from '../data/mech-stats.js';
import { mechInternalStateBytes } from '../data/mechs.js';
import {
  getWeaponAmmoPerBinByTypeId,
  getWeaponNameByTypeId,
  getWeaponLongRangeMeters,
  getWeaponRangeBandForDistance,
  getWeaponSpecByName,
  getWeaponSpecByTypeId,
  type WeaponSpec as WeaponDataSpec,
} from '../data/weapons.js';
import {
  type CombatAttachmentImpactContext,
  type CombatAttachmentHitSection,
  findRepresentativeCombatAttachmentIdForSection,
  getCombatModelIdForMechId,
  projectCombatImpactToTargetLocalSpace,
  resolveCombatAttachmentHitSection,
} from '../data/mech-attachments.js';

import {
  FALLBACK_MECH_ID,
  WORLD_MECH_BY_ID,
  WORLD_MECHS,
  GLOBAL_COMSTAR_MENU_ITEMS,
  DEFAULT_MAP_ROOM_ID,
  DEFAULT_SCENE_NAME,
  MATCH_RESULTS_MENU_LIST_ID,
  NEWS_CATEGORY_MENU_ID,
  NEWSGRID_ARTICLE_LIST_ID,
  TIER_RANKING_CHOOSER_LIST_ID,
  CLASS_RANKING_CHOOSER_LIST_ID,
  TIER_RANKING_RESULTS_LIST_ID,
  CLASS_RANKING_RESULTS_LIST_ID,
  ARENA_SIDE_MENU_ID,
  ARENA_STATUS_LIST_ID,
  ARENA_READY_ROOM_MAX_PARTICIPANTS,
  SOLARIS_ROOM_BY_ID,
  worldCaptures,
  worldMapByRoomId,
  getSolarisRoomSlottedExits,
  getSolarisRoomName,
  setSessionRoomPosition,
  SOLARIS_TRAVEL_ACTION_TYPE,
  CLASS_KEYS,
  getMechWeightClass,
  getMechChassis,
  getMechChassisListForClass,
  MECH_CLASS_LIST_ID,
  MECH_CHASSIS_LIST_ID,
  MECH_VARIANT_LIST_ID,
} from './world-data.js';
import {
  send,
  sendToWorldSession,
  nextSeq,
  getDisplayName,
  mapRoomKey,
  arenaReadyRoomKey,
  parseArenaReadyRoomKey,
  getPresenceStatus,
  getComstarId,
  findWorldTargetBySelectionId,
  buildComstarDeliveryText,
  getArenaSideLabel,
  getArenaReadyRoomLabel,
  getArenaReadyRoomLabelForSession,
  sendSceneRefresh,
  sendAllRosterList,
  sendArenaReadyRoomMenu,
  sendArenaSideMenu,
  sendArenaStatusList,
  sendComstarSendTargetMenu,
  sendNewsCategoryMenu,
  sendNewsgridArticleMenu,
  sendTierRankingChooser,
  sendClassRankingChooser,
  sendRankingResultsList,
  sendPersonnelRecord,
  sendSolarisTravelMap,
  sendWorldUiRestore,
  sendMechClassPicker,
  sendMechChassisPicker,
  sendMechVariantPicker,
} from './world-scene.js';
import {
  type SolarisTierKey,
  type SolarisClassKey,
  type SolarisStanding,
  computeSolarisStandings,
  findStandingByComstarId,
  formatSolarisRankLabel,
  formatSolarisStandingLine,
} from './solaris-rankings.js';
import {
  BOT_INITIAL_HEALTH,
  BOT_SPAWN_DISTANCE,
  BOT_AI_SPAWN_DISTANCE,
  BOT_FALLBACK_WEAPON_DAMAGE,
  COMBAT_WORLD_UNITS_PER_METER,
  COMBAT_TEAMMATE_SPAWN_SPACING,
  JUMP_JET_DEFAULT_APEX_METERS,
  JUMP_JET_ASCENT_STEPS,
  JUMP_JET_TICK_MS,
  JUMP_JET_REMOTE_MIRROR_MS_PER_APEX_METER,
  JUMP_JET_FUEL_MAX,
  JUMP_JET_START_FUEL_THRESHOLD,
  JUMP_JET_FUEL_REGEN_INTERVAL_MS,
  JUMP_JET_FUEL_REGEN_PER_TICK,
  COLLISION_PROBE_HORIZONTAL_DISTANCE,
  COLLISION_PROBE_VERTICAL_TOLERANCE,
  COLLISION_PROBE_LOG_COOLDOWN_MS,
  COLLISION_PROBE_LANDING_WINDOW_MS,
  FIRE_ACTION_WINDOW_MS,
  BOT_FIRE_INTERVAL_MS,
  BOT_RETALIATION_DAMAGE,
  BOT_AI_TICK_MS,
  COMBAT_GLOBAL_A,
  COMBAT_GLOBAL_B,
  COMBAT_GLOBAL_C,
  BOT_AI_MIN_PREFERRED_RANGE_METERS,
  BOT_AI_MAX_PREFERRED_RANGE_METERS,
  BOT_AI_RANGE_BUFFER_METERS,
  BOT_AI_JUMP_COOLDOWN_MS,
  BOT_AI_JUMP_RANGE_FIT_GAIN_THRESHOLD,
  BOT_AI_PLAYER_THREAT_BUFFER_METERS,
  BOT_AI_RANGE_FIT_SHORT_WEIGHT,
  BOT_AI_RANGE_FIT_MEDIUM_WEIGHT,
  BOT_AI_RANGE_FIT_LONG_WEIGHT,
  BOT_AI_RANGE_ADVANTAGE_BONUS_METERS,
  DEFAULT_BOT_DIFFICULTY_LEVEL,
  BOT_AI_HEAT_DISSIPATION_WINDOW_MS,
  BOT_AI_TIC_ALPHA_HEAT_RATIO,
  BOT_AI_TIC_SUSTAIN_HEAT_RATIO,
  BOT_AI_TIC_POKE_HEAT_RATIO,
  BOT_AI_TIC_SAFE_OVERHEAT_RISK,
  BOT_AI_TIC_FINISHER_OVERHEAT_RISK,
  BOT_TO_HIT_MIN_CHANCE,
  BOT_TO_HIT_MEDIUM_RANGE_BONUS,
  BOT_TO_HIT_LONG_RANGE_MAX_PENALTY,
  BOT_TO_HIT_ATTACKER_SPEED_MAX_PENALTY,
  BOT_TO_HIT_TARGET_SPEED_MAX_PENALTY,
  BOT_TO_HIT_TARGET_CROSSING_MAX_PENALTY,
  BOT_TO_HIT_ATTACKER_JUMP_PENALTY,
  BOT_TO_HIT_TARGET_JUMP_PENALTY,
  BOT_MISS_OFFSET_MIN_METERS,
  BOT_MISS_OFFSET_MAX_METERS,
  clampBotDifficultyLevel,
  getBotDifficultyProfile,
  type BotDifficultyProfile,
  VERIFY_DELAY_MS,
  VERIFY_SWEEP_STEP_MS,
  VERIFY_DAMAGE_CODES,
} from './combat-config.js';

function regenJumpFuelIfGrounded(
  session: ClientSession,
  amount: number,
): void {
  if (session.combatJumpActive) return;
  if (session.combatJumpTimer !== undefined) return;
  if ((session.combatJumpAltitude ?? 0) > 0) return;
  const fuel = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
  if (fuel >= JUMP_JET_FUEL_MAX) return;
  session.combatJumpFuel = Math.min(JUMP_JET_FUEL_MAX, fuel + amount);
}

function regenBotJumpFuelIfGrounded(
  bot: SoloCombatBotActorState,
  amount: number,
): void {
  if (bot.jumpActive) return;
  if (bot.z > 0) return;
  if (bot.jumpFuel >= JUMP_JET_FUEL_MAX) return;
  bot.jumpFuel = Math.min(JUMP_JET_FUEL_MAX, bot.jumpFuel + amount);
}

function mechSupportsJumpJets(mechId: number | undefined): boolean {
  const mechEntry = getMechEntryForId(mechId);
  if (mechEntry === undefined) return true;
  return mechEntry.jumpJetCount > 0;
}

function selectedMechSupportsJumpJets(session: ClientSession): boolean {
  return mechSupportsJumpJets(session.selectedMechId ?? FALLBACK_MECH_ID);
}

function getJumpArcForMechId(mechId: number | undefined): { apexUnits: number; stepUnits: number } {
  const mechEntry = getMechEntryForId(mechId);
  const stats = mechEntry ? MECH_STATS.get(mechEntry.typeString) : undefined;
  const documentedJumpMeters = stats?.jumpMeters;
  const apexMeters =
    documentedJumpMeters === null || documentedJumpMeters === undefined
      ? JUMP_JET_DEFAULT_APEX_METERS
      : Math.max(JUMP_JET_DEFAULT_APEX_METERS, Math.round(documentedJumpMeters / 2));
  const apexUnits = apexMeters * COMBAT_WORLD_UNITS_PER_METER;
  return {
    apexUnits,
    stepUnits: Math.max(
      COMBAT_WORLD_UNITS_PER_METER,
      Math.round(apexUnits / JUMP_JET_ASCENT_STEPS),
    ),
  };
}

function getSelectedMechJumpArc(session: ClientSession): { apexUnits: number; stepUnits: number } {
  return getJumpArcForMechId(session.selectedMechId ?? FALLBACK_MECH_ID);
}

function getJumpMirrorDurationMsForMechId(mechId: number | undefined): number {
  const { apexUnits } = getJumpArcForMechId(mechId);
  const apexMeters = Math.max(1, Math.round(apexUnits / COMBAT_WORLD_UNITS_PER_METER));
  return Math.max(JUMP_JET_TICK_MS * 8, apexMeters * JUMP_JET_REMOTE_MIRROR_MS_PER_APEX_METER);
}

function getSelectedMechJumpMirrorDurationMs(session: ClientSession): number {
  return getJumpMirrorDurationMsForMechId(session.selectedMechId ?? FALLBACK_MECH_ID);
}

function getLocalCmd65Altitude(session: ClientSession): number {
  return Math.max(0, session.combatAltitudeRaw ?? session.combatJumpAltitude ?? 0);
}

function syncCombatAltitudeFromClientFrame(
  session: ClientSession,
  altitudeRaw: number,
): void {
  const altitude = Math.max(0, altitudeRaw);
  session.combatAltitudeRaw = altitudeRaw;
  session.combatJumpAltitude = altitude;
}

function startPeerOnlyJumpMirror(
  players: PlayerRegistry,
  session: ClientSession,
): void {
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }

  const { apexUnits } = getSelectedMechJumpArc(session);
  const durationMs = getSelectedMechJumpMirrorDurationMs(session);
  const startedAt = Date.now();
  const startedFuel = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
  session.combatJumpAltitude = 0;

  session.combatJumpTimer = setInterval(() => {
    if (!session.combatJumpActive) {
      if (session.combatJumpTimer !== undefined) {
        clearInterval(session.combatJumpTimer);
        session.combatJumpTimer = undefined;
      }
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    const progress = Math.min(1, elapsedMs / Math.max(durationMs, 1));
    const fallbackAltitude =
      progress >= 1
        ? COMBAT_WORLD_UNITS_PER_METER
        : Math.max(COMBAT_WORLD_UNITS_PER_METER, Math.round(apexUnits * 4 * progress * (1 - progress)));
    const useRecentClientAltitude =
      session.combatLastMoveAt !== undefined
      && Date.now() - session.combatLastMoveAt <= JUMP_JET_TICK_MS * 2
      && (session.combatAltitudeRaw ?? 0) > 0;
    const mirroredAltitude = useRecentClientAltitude
      ? Math.max(0, session.combatAltitudeRaw ?? 0)
      : fallbackAltitude;

    session.combatJumpAltitude = mirroredAltitude;
    session.combatJumpFuel = Math.max(0, Math.round(startedFuel * (1 - progress)));
    mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_JUMP_MIRROR');
  }, JUMP_JET_TICK_MS);
  session.combatJumpTimer.unref();
}

const DEFAULT_BOT_ARMOR_VALUES = Array<number>(10).fill(10);
const DEFAULT_BOT_INTERNAL_VALUES = Array<number>(8).fill(9);
const HEAD_ARMOR_VALUE = 9;
const NO_ARMOR_INDEX = -1;
const DUEL_STAKE_MAX = 9_999_999;
const BASE_CRITICAL_STATE_COUNT = 0x15;
const SENSOR_CRITICAL_CODE = 0x11;
const LIFE_SUPPORT_CRITICAL_CODE = 0x12;
const CRITICAL_STATE_DAMAGED = 1;
const CRITICAL_STATE_DESTROYED = 2;
const LEG_ACTUATOR_CRITICAL_CODES_BY_INTERNAL_INDEX: Readonly<Record<number, readonly number[]>> = {
  5: [0x08, 0x09, 0x0a, 0x0b],
  6: [0x0c, 0x0d, 0x0e, 0x0f],
};
const LEG_SECTION_LABEL_BY_INTERNAL_INDEX: Readonly<Record<number, string>> = {
  5: 'left-leg',
  6: 'right-leg',
};
const WEAPON_STATE_UNAVAILABLE = 1;
const PLAYER_RESULT_DELAY_MS = 750;
const BOT_RESULT_DELAY_MS = 1500;
const COMBAT_DROP_DELAY_MS = 4000;
const RESULT_WORLD_RESTORE_DELAY_MS = 10_500;
const WORLD_READY_SCENE_REFRESH_FALLBACK_MS = 3_000;
const REVERSE_MOVEMENT_DISTANCE_TOLERANCE = 1.25;
const COMSTAR_DIALOG_ID = 6;
export const COMSTAR_INCOMING_DIALOG_ID = 7;
const HEAD_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: NO_ARMOR_INDEX,
  internalIndex: 7,
  label: 'head',
};
const LEFT_ARM_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 0,
  internalIndex: 0,
  label: 'left-arm',
};
const RIGHT_ARM_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 1,
  internalIndex: 1,
  label: 'right-arm',
};
const LEFT_TORSO_FRONT_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 5,
  internalIndex: 2,
  label: 'left-torso-front',
};
const LEFT_TORSO_REAR_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 8,
  internalIndex: 2,
  label: 'left-torso-rear',
};
const CENTER_TORSO_FRONT_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 4,
  internalIndex: 4,
  label: 'center-torso-front',
};
const CENTER_TORSO_REAR_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 7,
  internalIndex: 4,
  label: 'center-torso-rear',
};
const RIGHT_TORSO_FRONT_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 6,
  internalIndex: 3,
  label: 'right-torso-front',
};
const RIGHT_TORSO_REAR_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 9,
  internalIndex: 3,
  label: 'right-torso-rear',
};
const LEFT_LEG_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 2,
  internalIndex: 5,
  label: 'left-leg',
};
const RIGHT_LEG_RETALIATION_SECTION: CombatAttachmentHitSection = {
  armorIndex: 3,
  internalIndex: 6,
  label: 'right-leg',
};
const BOT_TACTICAL_TORSO_SECTIONS = [
  CENTER_TORSO_FRONT_RETALIATION_SECTION,
  LEFT_TORSO_FRONT_RETALIATION_SECTION,
  RIGHT_TORSO_FRONT_RETALIATION_SECTION,
] as const;
const BOT_TACTICAL_LEG_SECTIONS = [
  LEFT_LEG_RETALIATION_SECTION,
  RIGHT_LEG_RETALIATION_SECTION,
] as const;
const BOT_TACTICAL_ARM_SECTIONS = [
  LEFT_ARM_RETALIATION_SECTION,
  RIGHT_ARM_RETALIATION_SECTION,
] as const;
const LEG_LOSS_COLLAPSE_ONLY_TRANSITION = [
  { subcommand: 8, delayMs: 0, labelSuffix: 'COLLAPSE' },
] as const;
const LEG_LOSS_FALL_THEN_COLLAPSE_TRANSITION = [
  { subcommand: 1, delayMs: 0, labelSuffix: 'FALL' },
  { subcommand: 8, delayMs: 300, labelSuffix: 'COLLAPSE' },
] as const;
const LEG_LOSS_AIRBORNE_COLLAPSE_LAND_TRANSITION = [
  { subcommand: 4, delayMs: 0, labelSuffix: 'AIRBORNE' },
  { subcommand: 8, delayMs: JUMP_JET_TICK_MS * 2, labelSuffix: 'COLLAPSE' },
  { subcommand: 6, delayMs: JUMP_JET_TICK_MS * 8, labelSuffix: 'LAND' },
] as const;
const LEG_LOSS_FALL_AIRBORNE_COLLAPSE_LAND_TRANSITION = [
  { subcommand: 1, delayMs: 0, labelSuffix: 'FALL' },
  { subcommand: 4, delayMs: JUMP_JET_TICK_MS, labelSuffix: 'AIRBORNE' },
  { subcommand: 8, delayMs: JUMP_JET_TICK_MS * 3, labelSuffix: 'COLLAPSE' },
  { subcommand: 6, delayMs: JUMP_JET_TICK_MS * 9, labelSuffix: 'LAND' },
] as const;
const LEG_LOSS_FALL_COLLAPSE_RECOVER_TRANSITION = [
  { subcommand: 1, delayMs: 0, labelSuffix: 'FALL' },
  { subcommand: 8, delayMs: 300, labelSuffix: 'COLLAPSE' },
  // Recovery probe: slot-0 Cmd70/0 is the strongest current local stand-up ack candidate.
  { subcommand: 0, delayMs: JUMP_JET_TICK_MS * 16, labelSuffix: 'RECOVER' },
] as const;
const LEG_LOSS_DEFER_WHILE_AIRBORNE_TRANSITION = [
  { subcommand: 8, delayMs: 0, labelSuffix: 'DEFER' },
] as const;
const FORCED_COMBAT_VERIFICATION_ACCOUNT =
  process.env['MPBT_FORCE_VERIFICATION_ACCOUNT']?.trim().toLowerCase() ?? '';
const FORCED_COMBAT_VERIFICATION_MODE_RAW =
  process.env['MPBT_FORCE_VERIFICATION_MODE']?.trim().toLowerCase() ?? '';
const FORCED_COMBAT_VERIFICATION_MODES = new Set([
  'autowin',
  'autolose',
  'dmglocal',
  'dmgbot',
  'strictfire',
  'headtest',
  'legtest',
  'legseq',
  'legair',
  'legfull',
  'legrecover',
  'legdefer',
  'legdeferquiet',
  'legdefercmd73',
]);

function parseCmd73ProbeEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, raw.startsWith('0x') || raw.startsWith('0X') ? 16 : 10);
  if (!Number.isFinite(value) || value < 0 || value > 84) return fallback;
  return value;
}

const CMD73_RATE_PROBE_A = parseCmd73ProbeEnv('MPBT_CMD73_RATE_A', 43);
const CMD73_RATE_PROBE_B = parseCmd73ProbeEnv('MPBT_CMD73_RATE_B', 43);

type ForcedRetaliationVerification = {
  name: string;
  hitSection: CombatAttachmentHitSection;
  stopAfterDestroyedLegInternalIndex?: number;
  queueLossOnActorDestroyed?: boolean;
};
type CombatLegLossTransitionMode = 'collapse-only' | 'fall-then-collapse' | 'airborne-collapse-land' | 'fall-airborne-collapse-land' | 'fall-collapse-recover' | 'defer-while-airborne';

function sendCmd73RateProbe(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger | undefined,
  reason: string,
  label: string,
): void {
  if (!session.combatCmd73RateProbe) return;
  if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;
  if (session.combatResultCode !== undefined) return;

  connLog.info(
    '[world/combat] Cmd73 rate probe: slot=0 rateA=%d rateB=%d (%s)',
    CMD73_RATE_PROBE_A,
    CMD73_RATE_PROBE_B,
    reason,
  );
  const packet = buildCmd73ActorRatePacket(0, CMD73_RATE_PROBE_A, CMD73_RATE_PROBE_B, nextSeq(session));
  if (capture) {
    send(session.socket, packet, capture, label);
    return;
  }
  sendToWorldSession(session, packet, label);
}

function maybeApplyForcedCombatVerificationMode(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (
    session.combatVerificationMode !== undefined
    || FORCED_COMBAT_VERIFICATION_ACCOUNT.length === 0
    || !FORCED_COMBAT_VERIFICATION_MODES.has(FORCED_COMBAT_VERIFICATION_MODE_RAW)
    || session.username.trim().toLowerCase() !== FORCED_COMBAT_VERIFICATION_ACCOUNT
  ) {
    return;
  }

  session.combatVerificationMode = FORCED_COMBAT_VERIFICATION_MODE_RAW as ClientSession['combatVerificationMode'];
  connLog.info(
    '[world/combat] forced verification override: username=%s mode=%s',
    session.username,
    session.combatVerificationMode,
  );

  if (session.combatVerificationMode === 'strictfire') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Strict fire gate armed: ungated SPACEBAR fire will be rejected until recent action0.',
        nextSeq(session),
      ),
      capture,
      'CMD3_STRICTFIRE_ARMED',
    );
  } else if (session.combatVerificationMode === 'legtest') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg fall verifier armed: bot retaliation will target the left leg until first collapse.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEG_ARMED',
    );
  } else if (session.combatVerificationMode === 'legseq') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg fall sequence verifier armed: bot retaliation will target the left leg and emit Cmd70 1->8 on first collapse.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGSEQ_ARMED',
    );
  } else if (session.combatVerificationMode === 'legair') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg airborne verifier armed: bot retaliation will target the left leg and emit Cmd70 4->8->6 on first collapse.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGAIR_ARMED',
    );
  } else if (session.combatVerificationMode === 'legfull') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg full-sequence verifier armed: bot retaliation will target the left leg and emit Cmd70 1->4->8->6 on first collapse.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGFULL_ARMED',
    );
  } else if (session.combatVerificationMode === 'legrecover') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg recovery verifier armed: bot retaliation will target the left leg and emit Cmd70 1->8->0 on first collapse.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGRECOVER_ARMED',
    );
  } else if (session.combatVerificationMode === 'legdefer') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg deferred-collapse verifier armed: jump before leg loss so the server can emit local Cmd70/8 only while action4 is active.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGDEFER_ARMED',
    );
  } else if (session.combatVerificationMode === 'legdeferquiet') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        'Leg deferred-collapse quiet verifier armed: jump before leg loss; local Cmd65 landing/movement echoes are suppressed after deferred touchdown.',
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGDEFERQUIET_ARMED',
    );
  } else if (session.combatVerificationMode === 'legdefercmd73') {
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        `Leg deferred-collapse Cmd73 verifier armed: jump before leg loss; Cmd73 rates ${CMD73_RATE_PROBE_A}/${CMD73_RATE_PROBE_B} will be sent around fall/recovery.`,
        nextSeq(session),
      ),
      capture,
      'CMD3_FIGHTLEGDEFER73_ARMED',
    );
  }
}

export function notifyUnreadComstarMessages(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const recipientAccountId = session.accountId;
  if (recipientAccountId === undefined) return;
  countSavedUnreadMessages(recipientAccountId)
    .then((unreadCount) => {
      if (unreadCount <= 0 || session.socket.destroyed || !session.socket.writable) return;
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
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to query unread ComStar messages: %s', msg);
    });
}

export function completePendingWorldReadySceneRefresh(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  reason: 'client-ready' | 'timeout',
): void {
  const pendingSceneRefresh = session.pendingWorldReadySceneRefresh;
  if (!pendingSceneRefresh) {
    return;
  }

  if (pendingSceneRefresh.fallbackTimer !== undefined) {
    clearTimeout(pendingSceneRefresh.fallbackTimer);
    pendingSceneRefresh.fallbackTimer = undefined;
  }

  session.pendingWorldReadySceneRefresh = undefined;
  session.worldInitialized = true;
  connLog.info(
    '[world] completing deferred world scene refresh (%s)',
    reason,
  );
  sendSceneRefresh(players, session, connLog, capture, pendingSceneRefresh.message);
  if (pendingSceneRefresh.notifyUnreadComstar) {
    notifyUnreadComstarMessages(session, connLog, capture);
  }
  if (pendingSceneRefresh.flushPendingDuelSettlement) {
    flushPendingDuelSettlementNotice(session);
  }
  if (pendingSceneRefresh.notifyRoomArrival) {
    notifyRoomArrival(players, session, connLog);
  }
  pendingSceneRefresh.onComplete?.();
}

function deferWorldSceneRefreshAfterWelcome(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger | undefined,
  label: string,
  message: string,
  options: {
    notifyRoomArrival?: boolean;
    notifyUnreadComstar?: boolean;
    flushPendingDuelSettlement?: boolean;
    onComplete?: () => void;
  } = {},
): void {
  const existingPending = session.pendingWorldReadySceneRefresh;
  if (existingPending?.fallbackTimer !== undefined) {
    clearTimeout(existingPending.fallbackTimer);
  }

  session.worldInitialized = false;
  const pending: NonNullable<ClientSession['pendingWorldReadySceneRefresh']> = {
    message,
    notifyRoomArrival: options.notifyRoomArrival,
    notifyUnreadComstar: options.notifyUnreadComstar,
    flushPendingDuelSettlement: options.flushPendingDuelSettlement,
    onComplete: options.onComplete,
  };
  session.pendingWorldReadySceneRefresh = pending;

  if (capture) {
    pending.fallbackTimer = setTimeout(() => {
      if (session.pendingWorldReadySceneRefresh !== pending) {
        return;
      }
      if (session.socket.destroyed || !session.socket.writable) {
        session.pendingWorldReadySceneRefresh = undefined;
        pending.onComplete?.();
        return;
      }
      connLog.warn(
        '[world] no cmd-3 after deferred welcome within %dms — sending world scene refresh fallback',
        WORLD_READY_SCENE_REFRESH_FALLBACK_MS,
      );
      completePendingWorldReadySceneRefresh(players, session, connLog, capture, 'timeout');
    }, WORLD_READY_SCENE_REFRESH_FALLBACK_MS);
    pending.fallbackTimer.unref();
  } else {
    connLog.warn('[world] deferred world scene refresh has no capture logger; waiting for client-ready without fallback timer');
  }

  const welcomePacket = buildWelcomePacket();
  if (capture) {
    send(session.socket, welcomePacket, capture, label);
    return;
  }
  sendToWorldSession(session, welcomePacket, label);
}

function openComstarTargetPrompt(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingComstarTargetPrompt = true;
  session.pendingHandleChangePrompt = false;
  connLog.info('[world] prompting for direct ComStar recipient id');
  send(
    session.socket,
    buildCmd3BroadcastPacket('Enter the recipient ComStar ID, then press SEND.', nextSeq(session)),
    capture,
    'CMD3_COMSTAR_TARGET_PROMPT',
  );
  send(
    session.socket,
    buildCmd37OpenComposePacket(0, nextSeq(session)),
    capture,
    'CMD37_COMSTAR_TARGET_PROMPT',
  );
}

function openHandleChangePrompt(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingHandleChangePrompt = true;
  session.pendingComstarTargetPrompt = false;
  connLog.info('[world] prompting for new handle');
  send(
    session.socket,
    buildCmd3BroadcastPacket('Enter your new handle, then press SEND.', nextSeq(session)),
    capture,
    'CMD3_HANDLE_CHANGE_PROMPT',
  );
  send(
    session.socket,
    buildCmd37OpenComposePacket(0, nextSeq(session)),
    capture,
    'CMD37_HANDLE_CHANGE_PROMPT',
  );
}

function broadcastDisplayNameRefresh(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): void {
  if (!session.roomId || session.worldRosterId === undefined || !session.worldInitialized) return;
  const callsign = getDisplayName(session);
  const status = getPresenceStatus(session);
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
      buildCmd11PlayerEventPacket(session.worldRosterId, status, callsign, nextSeq(other)),
      'CMD11_HANDLE_REFRESH',
    );
  }
  connLog.info(
    '[world] refreshed room display name: rosterId=%d status=%d callsign="%s"',
    session.worldRosterId,
    status,
    callsign,
  );
}

function broadcastSolarisResultMarquee(
  players: PlayerRegistry,
  winnerName: string,
  loserName: string,
  roomName: string,
  connLog: Logger,
): void {
  const line = `Solaris update: ${winnerName} defeated ${loserName} in ${roomName}.`;
  let recipients = 0;
  for (const other of players.worldSessions()) {
    if (!other.socket.writable) continue;
    sendToWorldSession(
      other,
      buildCmd3BroadcastPacket(line, nextSeq(other)),
      'CMD3_SOLARIS_RESULT',
    );
    recipients += 1;
  }
  connLog.info(
    '[world] broadcast Solaris result marquee to %d world session(s): %s',
    recipients,
    line,
  );
}

function buildCompactNewsText(title: string, summary: string, body: string): string {
  const SEP = '\x5c';
  const sanitize = (value: string) =>
    value
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      .replace(/\x1b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = [
    sanitize(title),
    sanitize(summary || body).slice(0, 64),
  ].filter(Boolean);
  const full = lines.join(SEP);
  return Buffer.byteLength(full, 'latin1') <= 84
    ? full
    : Buffer.from(full, 'latin1').subarray(0, 84).toString('latin1');
}

function sendNewsArticleText(
  session: ClientSession,
  title: string,
  summary: string,
  body: string,
  capture: CaptureLogger,
): void {
  send(
    session.socket,
    buildCmd20Packet(COMSTAR_DIALOG_ID, 2, buildCompactNewsText(title, summary, body), nextSeq(session)),
    capture,
    'CMD20_NEWS_ARTICLE',
  );
}

function sendNoNewsAvailable(
  session: ClientSession,
  capture: CaptureLogger,
): void {
  send(
    session.socket,
    buildCmd20Packet(COMSTAR_DIALOG_ID, 2, 'No information is available.', nextSeq(session)),
    capture,
    'CMD20_NEWS_EMPTY',
  );
}

function buildCompactDialogText(lines: string[]): string {
  const SEP = '\x5c';
  const safeLines = lines
    .map(line => line.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\x1b/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const full = safeLines.join(SEP);
  return Buffer.byteLength(full, 'latin1') <= 84
    ? full
    : Buffer.from(full, 'latin1').subarray(0, 84).toString('latin1');
}

function getSessionMaxHealth(session: ClientSession): number {
  if (session.combatPlayerArmorValues && session.combatPlayerInternalValues) {
    return getCombatDurability(session.combatPlayerArmorValues, session.combatPlayerInternalValues)
      + (session.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE);
  }
  return session.playerHealth ?? HEAD_ARMOR_VALUE;
}

function getSessionCbills(session: ClientSession): number {
  return Math.max(0, Math.trunc(session.cbills ?? 0));
}

function getCombatSessionStakeForParticipant(combatSession: DuelCombatSession, sessionId: string): number {
  const [participantAId, participantBId] = combatSession.participantSessionIds;
  const [stakeA, stakeB] = combatSession.duelStakeValues;
  if (sessionId === participantAId) return stakeA;
  if (sessionId === participantBId) return stakeB;
  return 0;
}

function getDuelStakeBalanceError(
  participantA: ClientSession,
  stakeA: number,
  participantB: ClientSession,
  stakeB: number,
): string | undefined {
  const balanceA = getSessionCbills(participantA);
  if (stakeA > balanceA) {
    return `${getDisplayName(participantA)} only has ${balanceA} cb for a ${stakeA} cb stake.`;
  }
  const balanceB = getSessionCbills(participantB);
  if (stakeB > balanceB) {
    return `${getDisplayName(participantB)} only has ${balanceB} cb for a ${stakeB} cb stake.`;
  }
  return undefined;
}

function isArenaRoom(session: ClientSession): boolean {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  return worldMapByRoomId.get(roomId)?.type === 'arena';
}

function getSharedArenaSide(
  session: ClientSession,
  other: ClientSession,
): number | undefined {
  if (!isArenaRoom(session) || !isArenaRoom(other)) {
    return undefined;
  }
  const side = session.worldArenaSide;
  if (side === undefined || side !== other.worldArenaSide) {
    return undefined;
  }
  return side;
}

const COMBAT_REMOTE_ACTOR_TYPE_DEFAULT = 0;
const COMBAT_REMOTE_ACTOR_TYPE_FORCE_VISIBLE = 1;

function getCombatRemoteActorTypeByte(forceVisible: boolean): number {
  // v1.29 RE: non-zero actorTypeByte makes Combat_MainLoop force actor flag 0x20
  // instead of relying on LOS/occlusion, which keeps teammates rendered and on radar.
  return forceVisible
    ? COMBAT_REMOTE_ACTOR_TYPE_FORCE_VISIBLE
    : COMBAT_REMOTE_ACTOR_TYPE_DEFAULT;
}

function getLiveArenaRoomParticipants(players: PlayerRegistry, roomId: string): ClientSession[] {
  return players.inRoom(roomId).filter(other =>
    other.phase === 'world'
    && other.worldInitialized
    && !other.socket.destroyed,
  );
}

function clearPendingArenaReadyRoomSelection(session: ClientSession): void {
  session.pendingArenaReadyRoomArenaId = undefined;
  session.pendingArenaReadyRoomChoices = undefined;
}

function getArenaReadyRoomParticipants(
  players: PlayerRegistry,
  arenaRoomId: number,
  readyRoomId: number,
): ClientSession[] {
  return getLiveArenaRoomParticipants(players, arenaReadyRoomKey(arenaRoomId, readyRoomId));
}

function formatArenaReadyRoomMenuOccupants(participants: ClientSession[]): string {
  const names = participants
    .map(other => getDisplayName(other))
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    return 'Empty';
  }
  if (names.length <= 2) {
    return names.join(', ');
  }
  return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

function getWorldReturnLocationLabel(session: ClientSession): string {
  const roomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const readyRoomLabel = getArenaReadyRoomLabelForSession(session);
  return readyRoomLabel ? `${getSolarisRoomName(roomId)} - ${readyRoomLabel}` : getSolarisRoomName(roomId);
}

function listArenaReadyRoomMenuOptions(
  players: PlayerRegistry,
  session: ClientSession,
  arenaRoomId: number,
): Array<{ readyRoomId: number; label: string }> {
  const occupiedRoomIds = new Set<number>();
  for (const other of players.worldSessions()) {
    const parsed = parseArenaReadyRoomKey(other.roomId);
    if (
      parsed?.roomId === arenaRoomId
      && other.phase === 'world'
      && other.worldInitialized
      && !other.socket.destroyed
    ) {
      occupiedRoomIds.add(parsed.readyRoomId);
    }
  }

  const currentReadyRoom = parseArenaReadyRoomKey(session.roomId);
  if (currentReadyRoom?.roomId === arenaRoomId) {
    occupiedRoomIds.add(currentReadyRoom.readyRoomId);
  }

  let emptyRoomId = 1;
  while (occupiedRoomIds.has(emptyRoomId)) {
    emptyRoomId += 1;
  }

  const roomIds = [...occupiedRoomIds, emptyRoomId].sort((a, b) => a - b);

  return roomIds.map(readyRoomId => {
    const participants = getArenaReadyRoomParticipants(players, arenaRoomId, readyRoomId);
    const occupancyLabel = participants.length === 0
      ? 'Empty (droid opponents)'
      : formatArenaReadyRoomMenuOccupants(participants);
    return {
      readyRoomId,
      label: `${getArenaReadyRoomLabel(readyRoomId)} - ${occupancyLabel}`,
    };
  });
}

export function openArenaReadyRoomMenu(
  players: PlayerRegistry,
  session: ClientSession,
  arenaRoomId: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const roomOptions = listArenaReadyRoomMenuOptions(players, session, arenaRoomId);
  sendArenaReadyRoomMenu(session, arenaRoomId, roomOptions, connLog, capture);
}

export function handleArenaReadyRoomSelection(
  players: PlayerRegistry,
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const arenaRoomId = session.pendingArenaReadyRoomArenaId;
  const readyRoomChoices = session.pendingArenaReadyRoomChoices;
  if (!arenaRoomId || !readyRoomChoices || readyRoomChoices.length === 0) {
    connLog.warn('[world] arena ready-room selection without active menu: selection=%d', selection);
    return;
  }

  if (selection === 0) {
    clearPendingArenaReadyRoomSelection(session);
    sendSceneRefresh(players, session, connLog, capture, 'Arena ready-room selection cancelled.');
    return;
  }

  const readyRoomId = readyRoomChoices[selection - 1];
  if (!readyRoomId) {
    connLog.warn('[world] arena ready-room selection invalid: arena=%d selection=%d', arenaRoomId, selection);
    openArenaReadyRoomMenu(players, session, arenaRoomId, connLog, capture);
    return;
  }

  const newRoomId = arenaReadyRoomKey(arenaRoomId, readyRoomId);
  const oldRoomId = session.roomId;
  if (oldRoomId === newRoomId) {
    clearPendingArenaReadyRoomSelection(session);
    sendSceneRefresh(
      players,
      session,
      connLog,
      capture,
      `Already in ${getSolarisRoomName(arenaRoomId)} - ${getArenaReadyRoomLabel(readyRoomId)}.`,
    );
    return;
  }

  const occupants = getArenaReadyRoomParticipants(players, arenaRoomId, readyRoomId);
  const occupantCountExcludingSelf = occupants.filter(other => other.id !== session.id).length;
  if (occupantCountExcludingSelf >= ARENA_READY_ROOM_MAX_PARTICIPANTS) {
    connLog.warn(
      '[world] arena ready-room selection rejected: arena=%d readyRoom=%d full for callsign="%s"',
      arenaRoomId,
      readyRoomId,
      getDisplayName(session),
    );
    openArenaReadyRoomMenu(players, session, arenaRoomId, connLog, capture);
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        `${getArenaReadyRoomLabel(readyRoomId)} in ${getSolarisRoomName(arenaRoomId)} is full.`,
        nextSeq(session),
      ),
      capture,
      'CMD3_ARENA_READY_ROOM_FULL',
    );
    return;
  }

  clearPendingArenaReadyRoomSelection(session);
  clearSessionDuelState(players, session, connLog, `left ${getSolarisRoomName(session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID)}`);
  notifyRoomDeparture(players, session, connLog);
  session.roomId = newRoomId;
  session.worldArenaReadyRoomId = readyRoomId;
  setSessionRoomPosition(session, arenaRoomId);
  session.worldArenaSide = undefined;
  session.worldArenaReady = undefined;
  session.worldPresenceStatus = 5;
  worldResumeRegistry.save(session);

  sendSceneRefresh(
    players,
    session,
    connLog,
    capture,
    `Entered ${getSolarisRoomName(arenaRoomId)} - ${getArenaReadyRoomLabel(readyRoomId)}. Type /help to see available commands.`,
  );
  notifyRoomArrival(players, session, connLog);
}

function isArenaParticipantReady(session: ClientSession): boolean {
  return session.worldArenaReady === true
    && session.worldArenaSide !== undefined
    && session.selectedMechId !== undefined;
}

function formatPilotList(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? 'unknown pilot';
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function broadcastArenaReadyRoomNotice(
  players: PlayerRegistry,
  roomId: string,
  message: string,
  label: string,
): void {
  for (const participant of getLiveArenaRoomParticipants(players, roomId)) {
    sendToWorldSession(
      participant,
      buildCmd3BroadcastPacket(message, nextSeq(participant)),
      label,
    );
  }
}

function getArenaReadyToggleError(session: ClientSession): string | undefined {
  if (session.selectedMechId === undefined) {
    return 'pick a mech first';
  }
  if (session.worldArenaSide === undefined) {
    return 'pick a side first';
  }
  return undefined;
}

function shouldSendArenaReadyReminder(session: ClientSession): boolean {
  return isArenaRoom(session)
    && session.worldArenaReady !== true
    && session.worldArenaSide !== undefined
    && session.selectedMechId !== undefined;
}

function sendArenaReadyReminder(
  session: ClientSession,
  capture: CaptureLogger,
): void {
  if (!shouldSendArenaReadyReminder(session)) {
    return;
  }
  send(
    session.socket,
    buildCmd3BroadcastPacket('Reminder: use /ready when ready to DROP.', nextSeq(session)),
    capture,
    'CMD3_ARENA_READY_REMINDER',
  );
}

function hasPendingArenaDuelState(session: ClientSession): boolean {
  return !!session.combatSessionId
    || !!session.outgoingDuelInviteTargetSessionId
    || !!session.pendingDuelInviteFromSessionId;
}

function assignStagedDuelSession(
  sessionA: ClientSession,
  sessionB: ClientSession,
  combatSessionId: string,
): void {
  sessionA.combatSessionId = combatSessionId;
  sessionA.combatPeerSessionId = sessionB.id;
  sessionA.duelTermsAvailable = true;
  sessionB.combatSessionId = combatSessionId;
  sessionB.combatPeerSessionId = sessionA.id;
  sessionB.duelTermsAvailable = true;
}

function assignArenaCombatSession(
  participants: readonly ClientSession[],
  combatSessionId: string,
): void {
  for (const participant of participants) {
    participant.combatSessionId = combatSessionId;
    participant.combatPeerSessionId = undefined;
    participant.duelTermsAvailable = false;
  }
}

function getCombatSessionParticipants(
  players: PlayerRegistry,
  combatSession: CombatSession,
): ClientSession[] {
  return combatSession.participantSessionIds
    .map(participantId => players.get(participantId))
    .filter((participant): participant is ClientSession => participant !== undefined);
}

function getCombatReadyParticipants(
  players: PlayerRegistry,
  combatSession: CombatSession,
): ClientSession[] {
  return getCombatSessionParticipants(players, combatSession).filter(participant =>
    !participant.socket.destroyed
    && participant.phase === 'combat'
    && participant.combatSessionId === combatSession.id
    && participant.combatInitialized
    && participant.combatWorldRestoreTimer === undefined
  );
}

function getCombatActiveParticipants(
  players: PlayerRegistry,
  combatSession: CombatSession,
): ClientSession[] {
  return getCombatSessionParticipants(players, combatSession).filter(participant =>
    !participant.socket.destroyed
    && participant.phase === 'combat'
    && participant.combatSessionId === combatSession.id
    && participant.combatResultCode === undefined
    && (participant.playerHealth ?? 1) > 0,
  );
}

function getCombatRemoteParticipantsForViewer(
  players: PlayerRegistry,
  combatSession: CombatSession,
  viewer: ClientSession,
): ClientSession[] {
  return combatSession.participantSessionIds
    .filter(participantId => participantId !== viewer.id)
    .map(participantId => players.get(participantId))
    .filter((participant): participant is ClientSession => participant !== undefined);
}

function getCombatRemoteSlotForViewer(
  combatSession: CombatSession,
  viewer: ClientSession,
  target: ClientSession,
): number | undefined {
  if (viewer.id === target.id) {
    return 0;
  }
  let nextSlot = 1;
  for (const participantId of combatSession.participantSessionIds) {
    if (participantId === viewer.id) {
      continue;
    }
    if (participantId === target.id) {
      return nextSlot;
    }
    nextSlot += 1;
  }
  return undefined;
}

function getCombatTargetParticipantForViewerSlot(
  players: PlayerRegistry,
  combatSession: CombatSession,
  viewer: ClientSession,
  targetSlot: number,
): ClientSession | undefined {
  if (targetSlot <= 0) {
    return undefined;
  }
  let nextSlot = 1;
  for (const participantId of combatSession.participantSessionIds) {
    if (participantId === viewer.id) {
      continue;
    }
    if (nextSlot === targetSlot) {
      return players.get(participantId);
    }
    nextSlot += 1;
  }
  return undefined;
}

function getCombatTargetRawForViewer(
  combatSession: CombatSession,
  viewer: ClientSession,
  target: ClientSession | undefined,
): number {
  if (!target) {
    return 0;
  }
  if (target.id === viewer.id) {
    return 10;
  }
  const remoteSlot = getCombatRemoteSlotForViewer(combatSession, viewer, target);
  return remoteSlot === undefined ? 0 : remoteSlot + 1;
}

function getCombatSourceSlotForViewer(
  combatSession: CombatSession,
  viewer: ClientSession,
  source: ClientSession,
): number {
  if (source.id === viewer.id) {
    return 0;
  }
  return getCombatRemoteSlotForViewer(combatSession, viewer, source) ?? 0;
}

function buildCombatTeamClusterPositions<T>(
  items: readonly T[],
  baseX: number,
  baseY: number,
  tangentX: number,
  tangentY: number,
): Array<{ item: T; x: number; y: number }> {
  const centerOffset = (items.length - 1) / 2;
  return items.map((item, index) => {
    const lateralOffset = (index - centerOffset) * COMBAT_TEAMMATE_SPAWN_SPACING;
    return {
      item,
      x: Math.round(baseX + (tangentX * lateralOffset)),
      y: Math.round(baseY + (tangentY * lateralOffset)),
    };
  });
}

function getArenaCombatSpawnPoints(participants: ClientSession[]): Array<{ x: number; y: number }> {
  if (participants.length <= 1) {
    return [{ x: 0, y: 0 }];
  }
  const groups = new Map<number, ClientSession[]>();
  for (const participant of participants) {
    const sideKey = participant.worldArenaSide ?? (100 + groups.size);
    const existing = groups.get(sideKey);
    if (existing) {
      existing.push(participant);
      continue;
    }
    groups.set(sideKey, [participant]);
  }

  const groupedSides = [...groups.entries()]
    .sort(([sideA], [sideB]) => sideA - sideB);
  const radius = BOT_SPAWN_DISTANCE;
  const spawnByParticipantId = new Map<string, { x: number; y: number }>();

  for (let groupIndex = 0; groupIndex < groupedSides.length; groupIndex += 1) {
    const [, groupParticipants] = groupedSides[groupIndex];
    const angle = (Math.PI * 2 * groupIndex) / groupedSides.length;
    const baseX = Math.sin(angle) * radius;
    const baseY = Math.cos(angle) * radius;
    const tangentX = Math.cos(angle);
    const tangentY = -Math.sin(angle);
    for (const position of buildCombatTeamClusterPositions(groupParticipants, baseX, baseY, tangentX, tangentY)) {
      spawnByParticipantId.set(position.item.id, {
        x: position.x,
        y: position.y,
      });
    }
  }

  return participants.map(participant => spawnByParticipantId.get(participant.id) ?? { x: 0, y: 0 });
}

function getArenaRoomEntryRejection(
  players: PlayerRegistry,
  session: ClientSession,
  targetRoomId: number,
): string | undefined {
  if (worldMapByRoomId.get(targetRoomId)?.type !== 'arena') {
    return undefined;
  }
  const targetRoomKey = mapRoomKey(targetRoomId);
  const occupants = getLiveArenaRoomParticipants(players, targetRoomKey);
  const occupantCountExcludingSelf = occupants.filter(other => other.id !== session.id).length;
  if (occupantCountExcludingSelf < ARENA_READY_ROOM_MAX_PARTICIPANTS) {
    return undefined;
  }
  return `Arena ready room full: ${getSolarisRoomName(targetRoomId)} already has ${ARENA_READY_ROOM_MAX_PARTICIPANTS} pilots.`;
}

export function tryStartArenaReadyRoomCombat(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): boolean {
  if (!isArenaRoom(session)) {
    return false;
  }
  const stagedCombatSession = players.getCombatSession(session.combatSessionId);
  if (stagedCombatSession?.mode === 'duel') {
    return tryStartStagedDuelCombat(players, session, connLog);
  }
  const roomParticipants = getLiveArenaRoomParticipants(players, session.roomId);
  if (roomParticipants.length <= 1) {
    return false;
  }

  const notReadyPilots = roomParticipants
    .filter(other => !isArenaParticipantReady(other))
    .map(other => getDisplayName(other));
  if (notReadyPilots.length > 0) {
    broadcastArenaReadyRoomNotice(
      players,
      session.roomId,
      `Fight blocked: waiting on ${formatPilotList(notReadyPilots)} to READY.`,
      'CMD3_ARENA_READY_BLOCKED',
    );
    return true;
  }

  const readyParticipants = roomParticipants
    .slice()
    .sort((a, b) => {
      const sideDiff = (a.worldArenaSide ?? 9) - (b.worldArenaSide ?? 9);
      if (sideDiff !== 0) return sideDiff;
      return getDisplayName(a).localeCompare(getDisplayName(b));
    });
  const distinctSides = new Set(readyParticipants.map(other => other.worldArenaSide));
  if (distinctSides.size <= 1) {
    broadcastArenaReadyRoomNotice(
      players,
      session.roomId,
      `Fight blocked: all ready pilots are on ${getArenaSideLabel(readyParticipants[0]?.worldArenaSide)}. Pick at least two sides before dropping.`,
      'CMD3_ARENA_READY_SIDE_BLOCKED',
    );
    return true;
  }

  if (roomParticipants.some(other => hasPendingArenaDuelState(other))) {
    broadcastArenaReadyRoomNotice(
      players,
      session.roomId,
      'Fight blocked: clear the current duel request or staged duel first.',
      'CMD3_ARENA_READY_BUSY',
    );
    return true;
  }

  const combatSession = players.createArenaCombatSession(readyParticipants);
  assignArenaCombatSession(readyParticipants, combatSession.id);
  connLog.info(
    '[world/arena] starting ready-room arena session=%s room=%s pilots=%s',
    combatSession.id,
    combatSession.roomId,
    readyParticipants.map(other => `${getDisplayName(other)}:${getArenaSideLabel(other.worldArenaSide)}`).join(', '),
  );
  return startArenaCombatSession(players, combatSession, connLog);
}

function clearSameSideDuelRequest(
  players: PlayerRegistry,
  session: ClientSession,
  peer: ClientSession,
  connLog: Logger,
): void {
  clearSessionDuelState(players, session, connLog, 'same-side teammates');
  const sideLabel = getArenaSideLabel(getSharedArenaSide(session, peer));
  sendToWorldSession(
    session,
    buildCmd3BroadcastPacket(
      `Duel request cleared: ${getDisplayName(peer)} is on ${sideLabel}. Same-side pilots are teammates.`,
      nextSeq(session),
    ),
    'CMD3_DUEL_SAME_SIDE',
  );
  if (peer.phase === 'world' && peer.worldInitialized && !peer.socket.destroyed) {
    sendToWorldSession(
      peer,
      buildCmd3BroadcastPacket(
        `Duel request cleared: ${getDisplayName(session)} is on ${sideLabel}. Same-side pilots are teammates.`,
        nextSeq(peer),
      ),
      'CMD3_DUEL_SAME_SIDE',
    );
  }
}

export function flushPendingDuelSettlementNotice(session: ClientSession): void {
  const notice = session.pendingDuelSettlementNotice;
  if (
    !notice
    || session.phase !== 'world'
    || !session.worldInitialized
    || session.socket.destroyed
    || !session.socket.writable
  ) {
    return;
  }
  session.pendingDuelSettlementNotice = undefined;
  sendToWorldSession(
    session,
    buildCmd3BroadcastPacket(notice, nextSeq(session)),
    'CMD3_DUEL_SETTLEMENT',
  );
}

function syncSettlementStateToReplacementSession(
  players: PlayerRegistry,
  sourceSession: ClientSession,
  cbills: number,
  notice: string,
): void {
  if (sourceSession.accountId === undefined) {
    return;
  }

  const replacement = players.findActiveSessionByAccountId(sourceSession.accountId, sourceSession.id);
  if (!replacement) {
    return;
  }

  replacement.cbills = cbills;
  replacement.pendingDuelSettlementNotice = notice;
  worldResumeRegistry.save(replacement);
  flushPendingDuelSettlementNotice(replacement);
}

function persistDuelResult(
  players: PlayerRegistry,
  winner: ClientSession,
  loser: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  const combatSessionId = winner.combatSessionId;
  const winnerAccountId = winner.accountId;
  const loserAccountId = loser.accountId;
  if (!combatSessionId || !winnerAccountId || !loserAccountId) {
    connLog.warn('[world/duel] skipping duel-result persistence: missing session/account ids');
    return;
  }
  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'duel' || !combatSession.worldMapRoomId) {
    connLog.warn('[world/duel] skipping duel-result persistence: missing combat session room id');
    return;
  }
  const winnerStakeCb = getCombatSessionStakeForParticipant(combatSession, winner.id);
  const loserStakeCb = getCombatSessionStakeForParticipant(combatSession, loser.id);

  createDuelResult({
    combatSessionId,
    worldMapRoomId: combatSession.worldMapRoomId,
    roomName: getSolarisRoomName(combatSession.worldMapRoomId),
    winnerAccountId,
    loserAccountId,
    winnerDisplayName: getDisplayName(winner),
    loserDisplayName: getDisplayName(loser),
    winnerComstarId: getComstarId(winner),
    loserComstarId: getComstarId(loser),
    winnerMechId: winner.selectedMechId ?? FALLBACK_MECH_ID,
    loserMechId: loser.selectedMechId ?? FALLBACK_MECH_ID,
    winnerStakeCb,
    loserStakeCb,
    winnerRemainingHealth: Math.max(0, Math.round(winner.playerHealth ?? 0)),
    winnerMaxHealth: Math.max(1, getSessionMaxHealth(winner)),
    loserRemainingHealth: Math.max(0, Math.round(loser.playerHealth ?? 0)),
    loserMaxHealth: Math.max(1, getSessionMaxHealth(loser)),
    resultReason: reason,
  })
    .then((row) => {
      if (!row) {
        connLog.debug('[world/duel] duel result already persisted for session=%s', combatSessionId);
        return;
      }
      broadcastSolarisResultMarquee(
        players,
        row.winner_display_name,
        row.loser_display_name,
        row.room_name,
        connLog,
      );
      connLog.info('[world/duel] persisted duel result id=%d session=%s', row.id, combatSessionId);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world/duel] failed to persist duel result: %s', detail);
    });
}

function settleDuelCbills(
  players: PlayerRegistry,
  winner: ClientSession,
  loser: ClientSession,
  connLog: Logger,
): void {
  const combatSessionId = winner.combatSessionId;
  const winnerAccountId = winner.accountId;
  const loserAccountId = loser.accountId;
  if (!combatSessionId || !winnerAccountId || !loserAccountId) {
    connLog.warn('[world/duel] skipping duel settlement: missing session/account ids');
    return;
  }
  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'duel') {
    connLog.warn('[world/duel] skipping duel settlement: combat session missing');
    return;
  }
  const transferCb = getCombatSessionStakeForParticipant(combatSession, loser.id);
  if (transferCb <= 0) {
    return;
  }
  const recordSettlement = (remainingAttempts = 3): void => {
    updateDuelResultSettlement(combatSessionId, transferCb, winner.cbills ?? 0, loser.cbills ?? 0)
      .then((row) => {
        if (row || remainingAttempts <= 1) {
          if (!row) {
            connLog.warn('[world/duel] settlement update missed duel result session=%s', combatSessionId);
          }
          return;
        }
        const retryTimer = setTimeout(() => recordSettlement(remainingAttempts - 1), 50);
        retryTimer.unref();
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        connLog.error('[world/duel] failed to update duel-result settlement: %s', detail);
      });
  };
  settleDuelStakeTransfer(winnerAccountId, loserAccountId, transferCb)
    .then(({ winnerCbills, loserCbills }) => {
      const winnerNotice = `Sanctioned settlement: +${transferCb} cb (balance ${winnerCbills} cb).`;
      const loserNotice = `Sanctioned settlement: -${transferCb} cb (balance ${loserCbills} cb).`;
      winner.cbills = winnerCbills;
      loser.cbills = loserCbills;
      winner.pendingDuelSettlementNotice = winnerNotice;
      loser.pendingDuelSettlementNotice = loserNotice;
      worldResumeRegistry.save(winner);
      worldResumeRegistry.save(loser);
      syncSettlementStateToReplacementSession(players, winner, winnerCbills, winnerNotice);
      syncSettlementStateToReplacementSession(players, loser, loserCbills, loserNotice);
      recordSettlement();
      flushPendingDuelSettlementNotice(winner);
      flushPendingDuelSettlementNotice(loser);
      connLog.info(
        '[world/duel] settled %d cb winner="%s" loser="%s"',
        transferCb,
        getDisplayName(winner),
        getDisplayName(loser),
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      winner.pendingDuelSettlementNotice = 'Sanctioned settlement failed; balances unchanged.';
      loser.pendingDuelSettlementNotice = 'Sanctioned settlement failed; balances unchanged.';
      worldResumeRegistry.save(winner);
      worldResumeRegistry.save(loser);
      syncSettlementStateToReplacementSession(
        players,
        winner,
        winner.cbills ?? 0,
        winner.pendingDuelSettlementNotice,
      );
      syncSettlementStateToReplacementSession(
        players,
        loser,
        loser.cbills ?? 0,
        loser.pendingDuelSettlementNotice,
      );
      flushPendingDuelSettlementNotice(winner);
      flushPendingDuelSettlementNotice(loser);
      connLog.error('[world/duel] failed to settle duel cbills: %s', detail);
    });
}

function findLatestResultForAccount(
  results: DuelResultRow[],
  accountId: number,
): DuelResultRow | undefined {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const result = results[i];
    if (result.winner_account_id === accountId || result.loser_account_id === accountId) {
      return result;
    }
  }
  return undefined;
}

function buildRankingLastDuelLine(
  standing: SolarisStanding,
  latestResult?: DuelResultRow,
): string {
  if (!latestResult) {
    return 'Last duel: None';
  }
  const won = latestResult.winner_account_id === standing.accountId;
  const opponent = won ? latestResult.loser_display_name : latestResult.winner_display_name;
  return `Last duel: ${won ? 'Won' : 'Lost'} vs ${opponent}`;
}

function buildRankingInfoPanelLines(
  standing: SolarisStanding,
  latestResult?: DuelResultRow,
  context?: {
    tierKey?: SolarisTierKey;
    classKey?: SolarisClassKey;
  },
): string[] {
  return [
    `Rank    : ${formatSolarisRankLabel(standing)}`,
    `Score   : ${standing.score}`,
    `Record  : ${standing.ratioText}`,
    `House   : ${standing.allegiance}`,
    formatSolarisStandingLine(standing.allegiance, standing, context),
    buildRankingLastDuelLine(standing, latestResult),
  ];
}

function buildPersonalTierChooserTitle(standing: SolarisStanding): string {
  return `Rank: ${formatSolarisRankLabel(standing)} / Score: ${standing.score}`.slice(0, 84);
}

function sendRankingInfoPanel(
  session: ClientSession,
  standing: SolarisStanding,
  latestResult: DuelResultRow | undefined,
  capture: CaptureLogger,
  label: string,
  context?: {
    tierKey?: SolarisTierKey;
    classKey?: SolarisClassKey;
  },
): void {
  const packetOptions = {
    comstarId: standing.comstarId,
    battlesToDate: standing.matches,
    lines: buildRankingInfoPanelLines(standing, latestResult, context),
  };

  // v1.29 repurposes world Cmd46 as an explicit UI-clear/browser-child teardown
  // packet. Cmd14 keeps the same detail payload shape and is the v1.29-safe
  // ranking-detail surface.
  const packet = buildCmd14PersonnelRecordPacket(packetOptions, nextSeq(session));

  send(
    session.socket,
    packet,
    capture,
    label,
  );
}

function buildMatchResultDetailText(result: {
  roomName: string;
  winnerDisplayName: string;
  loserDisplayName: string;
  winnerStakeCb: number;
  loserStakeCb: number;
  settledTransferCb: number;
  resultReason: string;
}): string {
  const stakeLine = (result.winnerStakeCb > 0 || result.loserStakeCb > 0)
    ? `Stakes: ${result.winnerStakeCb}/${result.loserStakeCb} cb`
    : 'Stakes: none';
  const settlementLine = result.settledTransferCb > 0
    ? `Settled: +${result.settledTransferCb} cb`
    : undefined;
  return buildCompactDialogText([
    result.roomName,
    `${result.winnerDisplayName} def. ${result.loserDisplayName}`,
    stakeLine,
    ...(settlementLine ? [settlementLine] : []),
    result.resultReason,
  ]);
}

function classKeyFromSelection(selection: number): SolarisClassKey | undefined {
  switch (selection) {
    case 1: return 'LIGHT';
    case 2: return 'MEDIUM';
    case 3: return 'HEAVY';
    case 4: return 'ASSAULT';
    default: return undefined;
  }
}

const RANKING_SHELL_PAGE_SIZE = 5;
const MATCH_RESULTS_SHELL_PAGE_SIZE = 5;
const TIER_RANKING_KEYS: SolarisTierKey[] = [
  'UNRANKED',
  'NOVICE',
  'AMATEUR',
  'PROFESSIONAL',
  'VETERAN',
  'MASTER',
  'BATTLEMASTER',
  'CHAMPION',
];
const TIER_RANKING_LABELS = new Map<SolarisTierKey, string>([
  ['UNRANKED', 'Unranked'],
  ['NOVICE', 'Novice'],
  ['AMATEUR', 'Amateur'],
  ['PROFESSIONAL', 'Professional'],
  ['VETERAN', 'Veteran'],
  ['MASTER', 'Master'],
  ['BATTLEMASTER', 'BattleMaster'],
  ['CHAMPION', 'Champion'],
]);

function buildRankingMenuRows(standings: SolarisStanding[]) {
  return standings.map(
    standing => `${String(standing.comstarId).padStart(6)} ${standing.displayName.slice(0, 8).padEnd(8)} ${String(standing.score).padStart(5)} ${standing.ratioText.padStart(5)}`,
  );
}

function buildMatchResultMenuRows(results: DuelResultRow[]) {
  return results.map(
    result => `${result.winner_display_name.slice(0, 8)} vs ${result.loser_display_name.slice(0, 8)}`,
  );
}

function sendRankingPage(
  session: ClientSession,
  listId: number,
  title: string,
  standings: SolarisStanding[],
  pageIndex: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const start = pageIndex * RANKING_SHELL_PAGE_SIZE;
  const pageStandings = standings.slice(start, start + RANKING_SHELL_PAGE_SIZE);
  if (pageStandings.length === 0) {
    session.worldScrollList = undefined;
    sendNoNewsAvailable(session, capture);
    return;
  }
  const hasMore = start + pageStandings.length < standings.length;
  if (session.worldScrollList?.listId === listId) {
    session.worldScrollList.visibleItemIds = pageStandings.map(standing => standing.comstarId);
    session.worldScrollList.hasMore = hasMore;
  }
  sendRankingResultsList(
    session,
    listId,
    title,
    buildRankingMenuRows(pageStandings),
    hasMore,
    connLog,
    capture,
  );
}

function showPersonalTierRanking(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const accountId = session.accountId;
  if (!accountId) {
    sendNoNewsAvailable(session, capture);
    return;
  }
  Promise.all([listAllDuelResults(), listCharacters()])
    .then(([results, characters]) => {
      session.worldScrollList = undefined;
      const standings = computeSolarisStandings(results, characters);
      const standing = standings.find(entry => entry.accountId === accountId);
      if (!standing || session.socket.destroyed || !session.socket.writable) {
        if (!standing && !session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
        return;
      }
      sendTierRankingChooser(session, connLog, capture, buildPersonalTierChooserTitle(standing));
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to build personal tier ranking: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

function showTierRankingList(
  session: ClientSession,
  tierKey: SolarisTierKey,
  tierLabel: string,
  connLog: Logger,
  capture: CaptureLogger,
  pageIndex = 0,
): void {
  const title = `Tier Rankings - ${tierLabel}`;
  Promise.all([listAllDuelResults(), listCharacters()])
    .then(([results, characters]) => {
      const standings = computeSolarisStandings(results, characters)
        .filter(standing => standing.tierKey === tierKey);
      if (session.socket.destroyed || !session.socket.writable) return;
      if (standings.length === 0) {
        session.worldScrollList = undefined;
        sendNoNewsAvailable(session, capture);
        return;
      }
      session.worldScrollList = {
        listId: TIER_RANKING_RESULTS_LIST_ID,
        kind: 'tier-ranking',
        pageIndex,
        pageSize: RANKING_SHELL_PAGE_SIZE,
        title,
        tierKey,
      };
      sendRankingPage(
        session,
        TIER_RANKING_RESULTS_LIST_ID,
        title,
        standings,
        pageIndex,
        connLog,
        capture,
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to build tier rankings: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

function showClassRankingList(
  session: ClientSession,
  classKey: SolarisClassKey,
  connLog: Logger,
  capture: CaptureLogger,
  pageIndex = 0,
): void {
  const title = `${classKey.charAt(0)}${classKey.slice(1).toLowerCase()} Class Rankings`;
  Promise.all([listAllDuelResults(), listCharacters()])
    .then(([results, characters]) => {
      const standings = computeSolarisStandings(results, characters, classKey);
      if (session.socket.destroyed || !session.socket.writable) return;
      if (standings.length === 0) {
        session.worldScrollList = undefined;
        sendNoNewsAvailable(session, capture);
        return;
      }
      session.worldScrollList = {
        listId: CLASS_RANKING_RESULTS_LIST_ID,
        kind: 'class-ranking',
        pageIndex,
        pageSize: RANKING_SHELL_PAGE_SIZE,
        title,
        classKey,
      };
      sendRankingPage(
        session,
        CLASS_RANKING_RESULTS_LIST_ID,
        title,
        standings,
        pageIndex,
        connLog,
        capture,
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to build class rankings: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

function showStandingDetailByComstarId(
  session: ClientSession,
  comstarId: number,
  connLog: Logger,
  capture: CaptureLogger,
  context?: {
    tierKey?: SolarisTierKey;
    classKey?: SolarisClassKey;
  },
): void {
  Promise.all([listAllDuelResults(), listCharacters()])
    .then(([results, characters]) => {
      session.worldScrollList = undefined;
      let standings = computeSolarisStandings(results, characters, context?.classKey);
      if (context?.tierKey) {
        standings = standings.filter(entry => entry.tierKey === context.tierKey);
      }
      const standing = findStandingByComstarId(standings, comstarId);
      const latestResult = standing ? findLatestResultForAccount(results, standing.accountId) : undefined;
      if (!standing || session.socket.destroyed || !session.socket.writable) {
        if (!standing && !session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
        return;
      }
      sendRankingInfoPanel(session, standing, latestResult, capture, 'CMD46_RANKING_DETAIL', context);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to build ranking detail: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

function showMatchResults(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  pageIndex = 0,
): void {
  listRecentDuelResults(20)
    .then((results) => {
      if (session.socket.destroyed || !session.socket.writable) return;
      if (results.length === 0) {
        session.worldScrollList = undefined;
        session.pendingMatchResultIds = undefined;
        sendNoNewsAvailable(session, capture);
        return;
      }
      const start = pageIndex * MATCH_RESULTS_SHELL_PAGE_SIZE;
      const pageResults = results.slice(start, start + MATCH_RESULTS_SHELL_PAGE_SIZE);
      if (pageResults.length === 0) {
        session.worldScrollList = undefined;
        session.pendingMatchResultIds = undefined;
        sendNoNewsAvailable(session, capture);
        return;
      }
      session.pendingMatchResultIds = undefined;
      session.worldScrollList = {
        listId: MATCH_RESULTS_MENU_LIST_ID,
        kind: 'match-results',
        pageIndex,
        pageSize: MATCH_RESULTS_SHELL_PAGE_SIZE,
        title: 'Solaris Match Results',
        visibleItemIds: pageResults.map(result => result.id),
        hasMore: start + pageResults.length < results.length,
      };
      session.pendingMatchResultIds = pageResults.map(result => result.id);
      sendRankingResultsList(
        session,
        MATCH_RESULTS_MENU_LIST_ID,
        'Solaris Match Results',
        buildMatchResultMenuRows(pageResults),
        start + pageResults.length < results.length,
        connLog,
        capture,
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to fetch Solaris match results: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

function clearPendingIncomingComstarPrompt(session: ClientSession): void {
  session.pendingIncomingComstarMessageId = undefined;
  session.pendingIncomingComstarSenderId = undefined;
  session.pendingIncomingComstarBody = undefined;
}

function promptIncomingComstarMessage(
  session: ClientSession,
  messageId: number,
  senderComstarId: number,
  body: string,
  connLog: Logger,
): void {
  session.pendingIncomingComstarMessageId = messageId;
  session.pendingIncomingComstarSenderId = senderComstarId;
  session.pendingIncomingComstarBody = body;
  connLog.info('[world] prompting live ComStar recipient: msgId=%d sender=%d', messageId, senderComstarId);
  sendToWorldSession(
    session,
    buildCmd20Packet(COMSTAR_INCOMING_DIALOG_ID, 0, 'Incoming ComStar message\\Read now?', nextSeq(session)),
    'CMD20_COMSTAR_INCOMING',
  );
  markDelivered([messageId]).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    connLog.error('[world] failed to mark prompted ComStar message delivered: %s', detail);
  });
}

function sendLiveUnreadComstarNotice(session: ClientSession): void {
  sendToWorldSession(
    session,
    buildCmd3BroadcastPacket('You have unread ComStar messages waiting.', nextSeq(session)),
    'CMD3_COMSTAR_WAITING_LIVE',
  );
}

export function savePendingIncomingComstarPrompt(
  session: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  const messageId = session.pendingIncomingComstarMessageId;
  if (messageId === undefined) return;
  clearPendingIncomingComstarPrompt(session);
  connLog.info('[world] saving pending incoming ComStar prompt: msgId=%d reason=%s', messageId, reason);
  markSaved([messageId]).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    connLog.error('[world] failed to save pending incoming ComStar prompt: %s', detail);
  });
}
type CombatResultCode = 0 | 1;

const LOCAL_RETALIATION_SECTIONS: readonly CombatAttachmentHitSection[] = [
  LEFT_ARM_RETALIATION_SECTION,
  LEFT_TORSO_FRONT_RETALIATION_SECTION,
  LEFT_TORSO_REAR_RETALIATION_SECTION,
  CENTER_TORSO_FRONT_RETALIATION_SECTION,
  CENTER_TORSO_REAR_RETALIATION_SECTION,
  RIGHT_TORSO_FRONT_RETALIATION_SECTION,
  RIGHT_TORSO_REAR_RETALIATION_SECTION,
  RIGHT_ARM_RETALIATION_SECTION,
  LEFT_LEG_RETALIATION_SECTION,
  RIGHT_LEG_RETALIATION_SECTION,
  HEAD_RETALIATION_SECTION,
] as const;

type DamageCodeUpdate = { damageCode: number; damageValue: number };
type DestroyedLegSection = { internalIndex: number; label: string };
type PostDamageStateUpdates = { updates: DamageCodeUpdate[]; newlyDestroyedLegs: DestroyedLegSection[] };
type AppliedWeaponDamageResult = {
  updates: DamageCodeUpdate[];
  headArmor: number;
  hitSections: CombatAttachmentHitSection[];
  headInternalDamaged: boolean;
};

function sumValues(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function getCombatDurability(armorValues: readonly number[], internalValues: readonly number[]): number {
  return sumValues(armorValues) + sumValues(internalValues);
}

function normalizeExtraCritCount(extraCritCount: number | undefined): number {
  if (extraCritCount === undefined || extraCritCount < -20 || extraCritCount === -21) return 0;
  return extraCritCount;
}

function getTrackedCriticalStateCount(extraCritCount: number | undefined): number {
  return Math.max(BASE_CRITICAL_STATE_COUNT, BASE_CRITICAL_STATE_COUNT + normalizeExtraCritCount(extraCritCount));
}

function createCriticalStateBytes(extraCritCount: number | undefined): number[] {
  return Array<number>(getTrackedCriticalStateCount(extraCritCount)).fill(0);
}

function getHeadCriticalState(headInternalValue: number): number {
  if (headInternalValue <= 0) return CRITICAL_STATE_DESTROYED;
  if (headInternalValue < HEAD_ARMOR_VALUE) return CRITICAL_STATE_DAMAGED;
  return 0;
}

function applyHeadCriticalStateUpdates(
  criticalStateBytes: number[],
  headInternalValue: number,
): DamageCodeUpdate[] {
  const targetState = getHeadCriticalState(headInternalValue);
  if (targetState === 0) return [];

  const updates: DamageCodeUpdate[] = [];
  for (const damageCode of [SENSOR_CRITICAL_CODE, LIFE_SUPPORT_CRITICAL_CODE]) {
    if ((criticalStateBytes[damageCode] ?? 0) >= targetState) continue;
    criticalStateBytes[damageCode] = targetState;
    updates.push({ damageCode, damageValue: targetState });
  }
  return updates;
}

function getNewlyDestroyedLegSections(
  previousInternalValues: readonly number[],
  nextInternalValues: readonly number[],
): DestroyedLegSection[] {
  const updates: DestroyedLegSection[] = [];
  for (const internalIndex of [5, 6]) {
    const previousValue = previousInternalValues[internalIndex] ?? 0;
    const nextValue = nextInternalValues[internalIndex] ?? 0;
    if (previousValue > 0 && nextValue <= 0) {
      updates.push({
        internalIndex,
        label: LEG_SECTION_LABEL_BY_INTERNAL_INDEX[internalIndex] ?? `internal-${internalIndex}`,
      });
    }
  }
  return updates;
}

function applyLegActuatorCriticalStateUpdates(
  criticalStateBytes: number[],
  newlyDestroyedLegs: readonly DestroyedLegSection[],
): DamageCodeUpdate[] {
  const updates: DamageCodeUpdate[] = [];
  for (const leg of newlyDestroyedLegs) {
    const criticalCodes = LEG_ACTUATOR_CRITICAL_CODES_BY_INTERNAL_INDEX[leg.internalIndex] ?? [];
    for (const damageCode of criticalCodes) {
      // A zeroed leg internal section means the leg's actuators are destroyed,
      // not merely damaged. The retail client only runs actuator side effects
      // when the critical state increases, so send the terminal state directly.
      if ((criticalStateBytes[damageCode] ?? 0) >= CRITICAL_STATE_DESTROYED) continue;
      criticalStateBytes[damageCode] = CRITICAL_STATE_DESTROYED;
      updates.push({ damageCode, damageValue: CRITICAL_STATE_DESTROYED });
    }
  }
  return updates;
}

function collectPostDamageStateUpdates(
  mechId: number | undefined,
  criticalStateBytes: number[],
  previousInternalValues: readonly number[],
  nextInternalValues: readonly number[],
  headInternalDamaged: boolean,
): PostDamageStateUpdates {
  const newlyDestroyedLegs = getNewlyDestroyedLegSections(previousInternalValues, nextInternalValues);
  const updates = [
    ...(headInternalDamaged ? applyHeadCriticalStateUpdates(criticalStateBytes, nextInternalValues[7] ?? 0) : []),
    ...applyLegActuatorCriticalStateUpdates(criticalStateBytes, newlyDestroyedLegs),
    ...getWeaponSectionLossUpdates(mechId, previousInternalValues, nextInternalValues),
  ];
  return { updates, newlyDestroyedLegs };
}

function sendCombatLegLossCollapse(
  session: ClientSession,
  slot: number,
  connLog: Logger,
  reason: string,
  label: string,
  capture?: CaptureLogger,
  transitionMode: CombatLegLossTransitionMode = 'collapse-only',
): void {
  if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;
  if (session.combatResultCode !== undefined) return;

  const transitionSteps =
    transitionMode === 'fall-then-collapse'
      ? LEG_LOSS_FALL_THEN_COLLAPSE_TRANSITION
      : transitionMode === 'airborne-collapse-land'
        ? LEG_LOSS_AIRBORNE_COLLAPSE_LAND_TRANSITION
      : transitionMode === 'fall-airborne-collapse-land'
          ? LEG_LOSS_FALL_AIRBORNE_COLLAPSE_LAND_TRANSITION
          : transitionMode === 'fall-collapse-recover'
            ? LEG_LOSS_FALL_COLLAPSE_RECOVER_TRANSITION
            : transitionMode === 'defer-while-airborne'
              ? LEG_LOSS_DEFER_WHILE_AIRBORNE_TRANSITION
          : LEG_LOSS_COLLAPSE_ONLY_TRANSITION;

  connLog.info(
    '[world/combat] leg-loss transition slot=%d mode=%s sequence=%s (%s)',
    slot,
    transitionMode,
    transitionSteps.map(step => step.subcommand).join('->'),
    reason,
  );

  const sendStep = (subcommand: number, stepLabel: string): void => {
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;
    if (session.combatResultCode !== undefined) return;
    const localDeferredCollapseProbe =
      transitionMode === 'defer-while-airborne' && slot === 0 && subcommand === 8;
    if (localDeferredCollapseProbe) {
      if (!session.combatJumpActive) {
        connLog.info(
          '[world/combat] leg-loss deferred-collapse probe skipped: slot=0 jump inactive altitude=%d (%s)',
          session.combatJumpAltitude ?? 0,
          reason,
        );
        return;
      }
      connLog.info(
        '[world/combat] leg-loss deferred-collapse probe: sending local Cmd70/8 while jump/action4 is active altitude=%d fuel=%d (%s)',
        session.combatJumpAltitude ?? 0,
        session.combatJumpFuel ?? JUMP_JET_FUEL_MAX,
        reason,
      );
      sendCmd73RateProbe(
        session,
        connLog,
        capture,
        `before local Cmd70/8 deferred collapse: ${reason}`,
        `${stepLabel}_CMD73_BEFORE`,
      );
      session.combatDeferredLocalCollapsePending = true;
    } else if (slot === 0 && subcommand === 8) {
      sendCmd73RateProbe(
        session,
        connLog,
        capture,
        `before local Cmd70/8 collapse: ${reason}`,
        `${stepLabel}_CMD73_BEFORE`,
      );
      session.combatLastLocalCollapseAt = Date.now();
      session.combatLocalDowned = true;
      session.combatRecoveryExperimentPending = true;
    } else if (slot === 0 && subcommand === 0) {
      session.combatLocalDowned = false;
      session.combatDeferredLocalCollapsePending = false;
      session.combatRecoveryExperimentPending = false;
    }
    const packet = buildCmd70ActorTransitionPacket(slot, subcommand, nextSeq(session));
    if (capture) {
      send(session.socket, packet, capture, stepLabel);
      return;
    }
    sendToWorldSession(session, packet, stepLabel);
  };

  for (const step of transitionSteps) {
    const stepLabel =
      transitionSteps.length === 1
        ? label
        : `${label}_${step.labelSuffix}`;
    if (step.delayMs <= 0) {
      sendStep(step.subcommand, stepLabel);
      continue;
    }

    const delayedStep = setTimeout(() => {
      if (session.combatLegLossTransitionTimers) {
        const timerIndex = session.combatLegLossTransitionTimers.indexOf(delayedStep);
        if (timerIndex >= 0) {
          session.combatLegLossTransitionTimers.splice(timerIndex, 1);
        }
        if (session.combatLegLossTransitionTimers.length === 0) {
          session.combatLegLossTransitionTimers = undefined;
        }
      }
      sendStep(step.subcommand, stepLabel);
    }, step.delayMs);
    if (!session.combatLegLossTransitionTimers) {
      session.combatLegLossTransitionTimers = [];
    }
    session.combatLegLossTransitionTimers.push(delayedStep);
    delayedStep.unref();
  }
}

function startForcedRetaliationVerification(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  mechId: number | undefined,
  extraCritCount: number | undefined,
  mode: ForcedRetaliationVerification,
): void {
  session.botFireTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable) return;

    const playerArmorValues = [...(session.combatPlayerArmorValues ?? DEFAULT_BOT_ARMOR_VALUES)];
    const playerInternalValues = [...(session.combatPlayerInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES)];
    const playerCriticalStateBytes = [...(session.combatPlayerCriticalStateBytes ?? createCriticalStateBytes(extraCritCount))];
    const playerHeadArmor = session.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE;

    if (isActorDestroyed(playerInternalValues)) {
      clearInterval(session.botFireTimer);
      session.botFireTimer = undefined;
      if (mode.queueLossOnActorDestroyed === false) {
        connLog.info('[world/combat] scripted verification: %s stopped because actor is already destroyed', mode.name);
        return;
      }
      connLog.info('[world/combat] player IS depleted during %s — bot stopped firing', mode.name);
      queueCombatResultTransition(
        players,
        session,
        connLog,
        capture,
        COMBAT_RESULT_LOSS,
        `${mode.name}-already-destroyed`,
        PLAYER_RESULT_DELAY_MS,
      );
      return;
    }

    const previousInternalValues = [...playerInternalValues];
    const damageResult = applyDamageToSection(
      playerArmorValues,
      playerInternalValues,
      mode.hitSection,
      BOT_RETALIATION_DAMAGE,
      playerHeadArmor,
    );
    session.combatPlayerArmorValues = playerArmorValues;
    session.combatPlayerInternalValues = playerInternalValues;
    const postDamageUpdates = collectPostDamageStateUpdates(
      mechId,
      playerCriticalStateBytes,
      previousInternalValues,
      playerInternalValues,
      mode.hitSection.internalIndex === 7 && damageResult.updates.some(update => update.damageCode === 0x27),
    );
    session.combatPlayerCriticalStateBytes = playerCriticalStateBytes;
    session.combatPlayerHeadArmor = damageResult.headArmor;
    session.playerHealth = getCombatDurability(playerArmorValues, playerInternalValues);
    session.playerHealth += damageResult.headArmor;
    const allUpdates = [...damageResult.updates, ...postDamageUpdates.updates];
    const armorRemaining = mode.hitSection.armorIndex >= 0
      ? `${playerArmorValues[mode.hitSection.armorIndex] ?? 0}`
      : `${damageResult.headArmor}`;
    connLog.debug(
      '[world/combat] scripted verification %s: damage=%d hit=%s playerHealth=%d armor=%s internal=%d updates=%s',
      mode.name,
      BOT_RETALIATION_DAMAGE,
      mode.hitSection.label,
      session.playerHealth,
      armorRemaining,
      playerInternalValues[mode.hitSection.internalIndex] ?? 0,
      allUpdates.map(update => `0x${update.damageCode.toString(16)}=${update.damageValue}`).join(',') || 'none',
    );
    for (const update of allUpdates) {
      send(
        session.socket,
        buildCmd67LocalDamagePacket(update.damageCode, update.damageValue, nextSeq(session)),
        capture,
        `CMD67_VERIFY_${mode.name.toUpperCase()}_${update.damageCode.toString(16)}`,
      );
    }
    if (postDamageUpdates.newlyDestroyedLegs.length > 0 && !isActorDestroyed(playerInternalValues)) {
      sendCombatLegLossCollapse(
        session,
        0,
        connLog,
        `${postDamageUpdates.newlyDestroyedLegs.map(leg => leg.label).join('+')} destroyed`,
        'CMD70_LOCAL_LEG_COLLAPSE',
        capture,
        session.combatLegLossTransitionMode ?? 'collapse-only',
      );
    }

    if (
      mode.stopAfterDestroyedLegInternalIndex !== undefined
      && postDamageUpdates.newlyDestroyedLegs.some(leg => leg.internalIndex === mode.stopAfterDestroyedLegInternalIndex)
    ) {
      clearInterval(session.botFireTimer);
      session.botFireTimer = undefined;
      connLog.info(
        '[world/combat] scripted verification: %s complete (%s destroyed without match end)',
        mode.name,
        mode.hitSection.label,
      );
      return;
    }

    if (isActorDestroyed(playerInternalValues)) {
      clearInterval(session.botFireTimer);
      session.botFireTimer = undefined;
      if (mode.queueLossOnActorDestroyed === false) {
        connLog.info('[world/combat] scripted verification: %s reached actor destruction but is non-terminal', mode.name);
        return;
      }
      const fatalReason = (playerInternalValues[7] ?? 0) <= 0
        ? 'head destroyed'
        : 'center torso destroyed';
      connLog.info(
        '[world/combat] player IS depleted by hit=%s during %s (%s, server-side section tracking) — bot stopped firing',
        mode.hitSection.label,
        mode.name,
        fatalReason,
      );
      queueCombatResultTransition(
        players,
        session,
        connLog,
        capture,
        COMBAT_RESULT_LOSS,
        fatalReason,
        PLAYER_RESULT_DELAY_MS,
      );
    }
  }, BOT_FIRE_INTERVAL_MS);
  session.botFireTimer.unref();
}

function resolveBotHitSection(
  mechId: number | undefined,
  attach: number,
  impactZ: number,
  impactContext?: CombatAttachmentImpactContext,
): CombatAttachmentHitSection {
  return resolveCombatAttachmentHitSection(mechId, attach, impactZ, impactContext);
}

function buildTargetImpactContext(
  impactX: number,
  impactY: number,
  impactZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  facingAccumulator: number,
): CombatAttachmentImpactContext {
  return {
    impactX,
    impactY,
    impactZ,
    targetX,
    targetY,
    targetZ,
    facingAccumulator,
  };
}

function getModel13AttachProbeSuffix(
  mechId: number | undefined,
  attach: number,
  impactContext: CombatAttachmentImpactContext | undefined,
): string {
  if (impactContext === undefined) return '';
  if (getCombatModelIdForMechId(mechId) !== 13) return '';
  if (attach !== 41 && attach !== 55) return '';

  const localImpact = projectCombatImpactToTargetLocalSpace(impactContext);
  return `:m13probe=local(${Math.round(localImpact.forward)},${Math.round(localImpact.lateral)},${Math.round(localImpact.vertical)})`
    + `:target=${impactContext.targetX}/${impactContext.targetY}/${impactContext.targetZ}`
    + `:impact=${impactContext.impactX}/${impactContext.impactY}/${impactContext.impactZ}`
    + `:facing=${impactContext.facingAccumulator}`;
}

function shouldSpillUpperBodyHitToCenter(hitSection: CombatAttachmentHitSection): boolean {
  return hitSection.armorIndex === 0
    || hitSection.armorIndex === 1
    || hitSection.armorIndex === 5
    || hitSection.armorIndex === 6;
}

function isActorDestroyed(internalValues: readonly number[]): boolean {
  const centerTorsoGone = (internalValues[4] ?? 0) <= 0;
  const headGone = (internalValues[7] ?? 0) <= 0;
  return centerTorsoGone || headGone;
}

function getMechEntryForId(mechId: number | undefined) {
  return mechId === undefined ? undefined : WORLD_MECH_BY_ID.get(mechId);
}

function getWeaponNameForMechSlot(
  mechId: number | undefined,
  weaponSlot: number,
): string | undefined {
  const mechEntry = getMechEntryForId(mechId);
  const recoveredName = getWeaponNameByTypeId(mechEntry?.weaponTypeIds[weaponSlot]);
  if (recoveredName !== undefined) {
    return recoveredName;
  }
  const mechType = mechEntry?.typeString?.toUpperCase();
  return mechType !== undefined
    ? MECH_STATS.get(mechType)?.armament[weaponSlot]
    : undefined;
}

function getMechEntryForSession(session: ClientSession) {
  const sourceMechId = session.selectedMechId ?? FALLBACK_MECH_ID;
  return getMechEntryForId(sourceMechId);
}

function getWeaponNameForSlot(
  session: ClientSession,
  weaponSlot: number,
): string | undefined {
  return getWeaponNameForMechSlot(session.selectedMechId ?? FALLBACK_MECH_ID, weaponSlot);
}

function getWeaponTypeIdForMechSlot(
  mechId: number | undefined,
  weaponSlot: number,
): number | undefined {
  return getMechEntryForId(mechId)?.weaponTypeIds[weaponSlot];
}

function getWeaponTypeIdForSlot(
  session: ClientSession,
  weaponSlot: number,
): number | undefined {
  return getWeaponTypeIdForMechSlot(session.selectedMechId ?? FALLBACK_MECH_ID, weaponSlot);
}

function getWeaponSpecForMechSlot(mechId: number | undefined, weaponSlot: number) {
  const weaponTypeId = getWeaponTypeIdForMechSlot(mechId, weaponSlot);
  return getWeaponSpecByTypeId(weaponTypeId) ?? getWeaponSpecByName(getWeaponNameForMechSlot(mechId, weaponSlot));
}

function getWeaponSpecForSlot(session: ClientSession, weaponSlot: number) {
  return getWeaponSpecForMechSlot(session.selectedMechId ?? FALLBACK_MECH_ID, weaponSlot);
}

function getAmmoDamageCodeBase(extraCritCount: number | undefined, weaponCount: number): number {
  return 0x28 + weaponCount + normalizeExtraCritCount(extraCritCount);
}

function weaponTypeUsesAmmo(weaponTypeId: number | undefined): boolean {
  return (getWeaponAmmoPerBinByTypeId(weaponTypeId) ?? 0) > 0;
}

function getInitialCombatAmmoStateValues(ammoBinTypeIds: readonly number[] | undefined): number[] {
  if (!ammoBinTypeIds || ammoBinTypeIds.length === 0) {
    return [];
  }

  return ammoBinTypeIds.map(typeId => getWeaponAmmoPerBinByTypeId(typeId) ?? 0);
}

function getOrCreateAmmoStateValues(
  currentValues: number[] | undefined,
  ammoBinTypeIds: readonly number[] | undefined,
): number[] {
  return currentValues ? [...currentValues] : getInitialCombatAmmoStateValues(ammoBinTypeIds);
}

const INTERNAL_SECTION_LABELS = [
  'left arm',
  'right arm',
  'left torso',
  'right torso',
  'center torso',
  'left leg',
  'right leg',
  'head',
] as const;

function getWeaponMountGateForMech(
  mechId: number | undefined,
  internalValues: readonly number[] | undefined,
  weaponSlot: number,
): { allowed: boolean; reason?: string; mountedSectionIndex?: number } {
  const mechEntry = getMechEntryForId(mechId);
  if (!mechEntry) return { allowed: true };
  if (weaponSlot < 0 || weaponSlot >= mechEntry.weaponMountInternalIndices.length) {
    return { allowed: false, reason: 'invalid slot' };
  }

  const mountedSectionIndex = mechEntry.weaponMountInternalIndices[weaponSlot];
  if (
    mountedSectionIndex < 0
    || mountedSectionIndex >= INTERNAL_SECTION_LABELS.length
  ) {
    return { allowed: true, mountedSectionIndex };
  }

  const combatInternalValues = internalValues ?? mechInternalStateBytes(mechEntry.tonnage);
  if ((combatInternalValues[mountedSectionIndex] ?? 0) > 0) {
    return { allowed: true, mountedSectionIndex };
  }

  return {
    allowed: false,
    reason: `${INTERNAL_SECTION_LABELS[mountedSectionIndex]} destroyed`,
    mountedSectionIndex,
  };
}

function getWeaponMountGate(
  session: ClientSession,
  weaponSlot: number,
): { allowed: boolean; reason?: string; mountedSectionIndex?: number } {
  return getWeaponMountGateForMech(
    session.selectedMechId ?? FALLBACK_MECH_ID,
    session.combatPlayerInternalValues,
    weaponSlot,
  );
}

function getWeaponSectionLossUpdates(
  mechId: number | undefined,
  previousInternalValues: readonly number[],
  nextInternalValues: readonly number[],
): DamageCodeUpdate[] {
  const mechEntry = mechId === undefined ? undefined : WORLD_MECH_BY_ID.get(mechId);
  if (!mechEntry) return [];

  const destroyedSections = new Set<number>();
  for (let sectionIndex = 0; sectionIndex < nextInternalValues.length; sectionIndex += 1) {
    const previousValue = previousInternalValues[sectionIndex] ?? 0;
    const nextValue = nextInternalValues[sectionIndex] ?? 0;
    if (previousValue > 0 && nextValue <= 0) {
      destroyedSections.add(sectionIndex);
    }
  }
  if (destroyedSections.size === 0) return [];

  const updates: DamageCodeUpdate[] = [];
  for (let weaponSlot = 0; weaponSlot < mechEntry.weaponMountInternalIndices.length; weaponSlot += 1) {
    if (!destroyedSections.has(mechEntry.weaponMountInternalIndices[weaponSlot] ?? -1)) continue;
    updates.push({
      damageCode: 0x28 + weaponSlot,
      // RE confirms any non-zero weapon state triggers the local HUD/TIC refresh.
      // The exact retail tier split is still unresolved; 1 is the first unavailable state.
      damageValue: WEAPON_STATE_UNAVAILABLE,
    });
  }
  return updates;
}

function getShotDamageForMechSlot(
  mechId: number | undefined,
  weaponSlot: number,
): { damage: number; weaponName?: string; weaponSpec?: WeaponDataSpec } {
  const weaponName = getWeaponNameForMechSlot(mechId, weaponSlot);
  const weaponSpec = getWeaponSpecForMechSlot(mechId, weaponSlot);
  return {
    damage: weaponSpec?.damage ?? BOT_FALLBACK_WEAPON_DAMAGE,
    weaponName,
    weaponSpec,
  };
}

function getShotDamage(session: ClientSession, weaponSlot: number): { damage: number; weaponName?: string; weaponSpec?: WeaponDataSpec } {
  return getShotDamageForMechSlot(session.selectedMechId ?? FALLBACK_MECH_ID, weaponSlot);
}

function getWeaponHeatForMechSlot(mechId: number | undefined, weaponSlot: number): number {
  return getWeaponSpecForMechSlot(mechId, weaponSlot)?.heat ?? 0;
}

function getShotMaxRangeGateForMechSlot(
  mechId: number | undefined,
  weaponSlot: number,
  sourceX: number | undefined,
  sourceY: number | undefined,
  targetX: number | undefined,
  targetY: number | undefined,
): { allowed: boolean; distanceMeters?: number; maxRangeMeters?: number; weaponName?: string } {
  const weaponName = getWeaponNameForMechSlot(mechId, weaponSlot);
  const maxRangeMeters = getWeaponLongRangeMeters(getWeaponSpecForMechSlot(mechId, weaponSlot));
  if (
    maxRangeMeters === undefined
    || sourceX === undefined
    || sourceY === undefined
    || targetX === undefined
    || targetY === undefined
  ) {
    return { allowed: true, maxRangeMeters, weaponName };
  }

  const distanceMeters = getCombatDisplayDistanceMeters(sourceX, sourceY, targetX, targetY);
  return {
    allowed: distanceMeters <= maxRangeMeters,
    distanceMeters,
    maxRangeMeters,
    weaponName,
  };
}

function getShotMaxRangeGate(
  session: ClientSession,
  weaponSlot: number,
  targetX: number | undefined,
  targetY: number | undefined,
): { allowed: boolean; distanceMeters?: number; maxRangeMeters?: number; weaponName?: string } {
  return getShotMaxRangeGateForMechSlot(
    session.selectedMechId ?? FALLBACK_MECH_ID,
    weaponSlot,
    session.combatX ?? 0,
    session.combatY ?? 0,
    targetX,
    targetY,
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getCombatClientIntegerSqrt(value: number): number {
  if (value < 2) {
    return value;
  }
  let scaled = value;
  let estimate = value;
  if (value < 4) {
    return 1;
  }
  while (scaled > 2) {
    scaled = Math.trunc(scaled / 4);
    estimate = Math.trunc(estimate / 2);
  }
  let delta = Math.abs(estimate - value);
  while (delta > 1) {
    const nextEstimate = estimate + Math.trunc((Math.trunc(value / estimate) - estimate) / 2);
    delta = Math.abs(nextEstimate - estimate);
    estimate = nextEstimate;
  }
  while ((estimate * estimate) > value) {
    estimate -= 1;
  }
  return estimate;
}

function getCombatDisplayDistanceMeters(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): number {
  // Match the client radar exactly: truncate each axis delta by 100 world units
  // first, then run the client's integer sqrt helper on dx^2 + dy^2.
  const dxMeters = Math.trunc((sourceX - targetX) / COMBAT_WORLD_UNITS_PER_METER);
  const dyMeters = Math.trunc((sourceY - targetY) / COMBAT_WORLD_UNITS_PER_METER);
  return getCombatClientIntegerSqrt((dxMeters * dxMeters) + (dyMeters * dyMeters));
}

function speedMagToMetersPerSecond(speedMag: number): number {
  // mechKph(speedMag) = speedMag * 16.2 / 450 = speedMag * 0.036 kph,
  // so combat speedMag converts to meters/sec as speedMag * 0.01.
  return Math.abs(speedMag) / 100;
}

function signedSpeedMagToMetersPerSecond(speedMag: number): number {
  return speedMag / 100;
}

function clampAcceptedCombatPosition(
  session: ClientSession,
  nextX: number,
  nextY: number,
  clientSpeed: number,
  now: number,
): {
  x: number;
  y: number;
  speedMag: number;
  clamped: boolean;
  elapsedMs?: number;
  submittedDistanceUnits?: number;
  maxDistanceUnits?: number;
} {
  const walkSpeedMag = session.combatWalkSpeedMag ?? 0;
  const reverseSpeedCap = walkSpeedMag > 0
    ? walkSpeedMag
    : Math.abs(session.combatMaxSpeedMag ?? 0);
  const cappedSpeedMag = clientSpeed < 0 && reverseSpeedCap > 0
    ? Math.max(clientSpeed, -reverseSpeedCap)
    : clientSpeed;
  if (
    clientSpeed >= 0
    || reverseSpeedCap <= 0
    || session.combatJumpActive
    || (session.combatJumpAltitude ?? 0) > 0
    || session.combatX === undefined
    || session.combatY === undefined
    || session.combatLastMoveAt === undefined
  ) {
    return { x: nextX, y: nextY, speedMag: cappedSpeedMag, clamped: false };
  }

  const elapsedMs = now - session.combatLastMoveAt;
  if (elapsedMs <= 0) {
    return { x: nextX, y: nextY, speedMag: cappedSpeedMag, clamped: false };
  }

  const deltaX = nextX - session.combatX;
  const deltaY = nextY - session.combatY;
  const submittedDistanceUnits = Math.hypot(deltaX, deltaY);
  const maxDistanceUnits = Math.max(
    COMBAT_WORLD_UNITS_PER_METER,
    Math.round(
      speedMagToMetersPerSecond(reverseSpeedCap)
      * (elapsedMs / 1000)
      * COMBAT_WORLD_UNITS_PER_METER
      * REVERSE_MOVEMENT_DISTANCE_TOLERANCE,
    ),
  );
  if (submittedDistanceUnits <= maxDistanceUnits || submittedDistanceUnits <= 0) {
    return {
      x: nextX,
      y: nextY,
      speedMag: cappedSpeedMag,
      clamped: false,
      elapsedMs,
      submittedDistanceUnits: Math.round(submittedDistanceUnits),
      maxDistanceUnits,
    };
  }

  const scale = maxDistanceUnits / submittedDistanceUnits;
  return {
    x: Math.round(session.combatX + (deltaX * scale)),
    y: Math.round(session.combatY + (deltaY * scale)),
    speedMag: cappedSpeedMag,
    clamped: true,
    elapsedMs,
    submittedDistanceUnits: Math.round(submittedDistanceUnits),
    maxDistanceUnits,
  };
}

function facingAccumulatorToRadians(facingAccumulator: number): number {
  const southFacingRadians = -Math.PI / 2;
  const deltaUnits = normalizeFacingAccumulator(facingAccumulator) - FACING_ACCUMULATOR_NEUTRAL;
  return southFacingRadians + (deltaUnits * (Math.PI * 2 / 0x10000));
}

function getSpeedRatio(speedMag: number | undefined, maxSpeedMag: number | undefined): number {
  const absSpeed = Math.abs(speedMag ?? 0);
  const speedCap = Math.max(1, Math.abs(maxSpeedMag ?? absSpeed));
  return clampNumber(absSpeed / speedCap, 0, 1);
}

function getCrossingFactor(
  attackerX: number,
  attackerY: number,
  targetX: number,
  targetY: number,
  targetFacing: number,
  targetSpeedMag: number,
): number {
  if ((targetSpeedMag ?? 0) === 0) {
    return 0;
  }

  const dx = targetX - attackerX;
  const dy = targetY - attackerY;
  if (dx === 0 && dy === 0) {
    return 0;
  }

  const movementFacing = normalizeFacingAccumulator(
    targetFacing + ((targetSpeedMag ?? 0) < 0 ? 0x8000 : 0),
  );
  const movementRadians = facingAccumulatorToRadians(movementFacing);
  const shotRadians = Math.atan2(dy, dx);
  const delta = Math.atan2(
    Math.sin(movementRadians - shotRadians),
    Math.cos(movementRadians - shotRadians),
  );
  return Math.abs(Math.sin(delta));
}

type CombatRangeBand = 'short' | 'medium' | 'long' | 'out-of-range';

interface CombatToHitEstimate {
  chance: number;
  rangeBand: CombatRangeBand;
  crossingFactor: number;
}

interface CombatToHitRoll extends CombatToHitEstimate {
  hit: boolean;
  roll: number;
}

interface CombatToHitRollInput {
  attackerX: number;
  attackerY: number;
  attackerFacing: number;
  attackerSpeedMag?: number;
  attackerMaxSpeedMag?: number;
  attackerAirborne: boolean;
  targetX: number;
  targetY: number;
  targetFacing: number;
  targetSpeedMag?: number;
  targetMaxSpeedMag?: number;
  targetAirborne: boolean;
  targetMoveVectorX?: number;
  targetMoveVectorY?: number;
  distanceMeters: number;
  weaponSpec?: WeaponDataSpec;
  maxRangeMeters?: number;
}

function getCrossingFactorForVector(
  attackerX: number,
  attackerY: number,
  targetX: number,
  targetY: number,
  moveVectorX: number,
  moveVectorY: number,
): number {
  if (moveVectorX === 0 && moveVectorY === 0) {
    return 0;
  }
  const shotVectorX = targetX - attackerX;
  const shotVectorY = targetY - attackerY;
  const shotDistance = Math.hypot(shotVectorX, shotVectorY);
  const moveDistance = Math.hypot(moveVectorX, moveVectorY);
  if (shotDistance === 0 || moveDistance === 0) {
    return 0;
  }
  const shotUnitX = shotVectorX / shotDistance;
  const shotUnitY = shotVectorY / shotDistance;
  const moveUnitX = moveVectorX / moveDistance;
  const moveUnitY = moveVectorY / moveDistance;
  return Math.abs((shotUnitX * moveUnitY) - (shotUnitY * moveUnitX));
}

function getCombatRangeCaps(
  weaponSpec: WeaponDataSpec | undefined,
  fallbackMaxRangeMeters: number | undefined,
): { shortRangeCap: number; mediumRangeCap: number; longRangeCap?: number } {
  const longRangeCap = getWeaponLongRangeMeters(weaponSpec) ?? fallbackMaxRangeMeters;
  const shortRangeCap = Math.min(
    weaponSpec?.shortRangeMeters ?? BOT_AI_MIN_PREFERRED_RANGE_METERS,
    longRangeCap ?? BOT_AI_MIN_PREFERRED_RANGE_METERS,
  );
  const mediumRangeCap = Math.max(
    shortRangeCap,
    Math.min(
      weaponSpec?.mediumRangeMeters ?? 270,
      longRangeCap ?? (weaponSpec?.mediumRangeMeters ?? 270),
    ),
  );
  return { shortRangeCap, mediumRangeCap, longRangeCap };
}

function getCombatRangeBandForDistance(
  weaponSpec: WeaponDataSpec | undefined,
  distanceMeters: number,
  fallbackMaxRangeMeters: number | undefined,
): CombatRangeBand {
  const explicitRangeBand = getWeaponRangeBandForDistance(weaponSpec, distanceMeters);
  if (
    explicitRangeBand === 'short'
    || explicitRangeBand === 'medium'
    || explicitRangeBand === 'long'
    || explicitRangeBand === 'out-of-range'
  ) {
    return explicitRangeBand;
  }

  const { shortRangeCap, mediumRangeCap, longRangeCap } = getCombatRangeCaps(weaponSpec, fallbackMaxRangeMeters);
  if (longRangeCap !== undefined && distanceMeters > longRangeCap) {
    return 'out-of-range';
  }
  if (distanceMeters <= shortRangeCap) {
    return 'short';
  }
  if (distanceMeters <= mediumRangeCap) {
    return 'medium';
  }
  return 'long';
}

function estimateCombatToHit(
  input: CombatToHitRollInput,
  difficultyProfile?: BotDifficultyProfile,
): CombatToHitEstimate {
  const profile = difficultyProfile ?? getBotDifficultyProfile(DEFAULT_BOT_DIFFICULTY_LEVEL);
  const { shortRangeCap, mediumRangeCap, longRangeCap } = getCombatRangeCaps(input.weaponSpec, input.maxRangeMeters);
  const rangeBand = getCombatRangeBandForDistance(input.weaponSpec, input.distanceMeters, input.maxRangeMeters);
  const attackerSpeedRatio = getSpeedRatio(input.attackerSpeedMag, input.attackerMaxSpeedMag);
  const targetSpeedRatio = getSpeedRatio(input.targetSpeedMag, input.targetMaxSpeedMag);
  const explicitCrossingFactor = input.targetMoveVectorX === undefined || input.targetMoveVectorY === undefined
    ? undefined
    : getCrossingFactorForVector(
      input.attackerX,
      input.attackerY,
      input.targetX,
      input.targetY,
      input.targetMoveVectorX,
      input.targetMoveVectorY,
    );
  const crossingFactor = explicitCrossingFactor ?? getCrossingFactor(
    input.attackerX,
    input.attackerY,
    input.targetX,
    input.targetY,
    input.targetFacing,
    input.targetSpeedMag ?? 0,
  );
  if (rangeBand === 'out-of-range') {
    return {
      chance: 0,
      rangeBand,
      crossingFactor,
    };
  }

  let rangeModifier = 0;
  if (rangeBand === 'short') {
    rangeModifier = profile.toHitShortRangeBonus;
  } else if (rangeBand === 'medium') {
    rangeModifier = BOT_TO_HIT_MEDIUM_RANGE_BONUS;
  } else if (longRangeCap !== undefined && longRangeCap > mediumRangeCap) {
    const longRangeProgress = clampNumber(
      (input.distanceMeters - mediumRangeCap) / (longRangeCap - mediumRangeCap),
      0,
      1,
    );
    rangeModifier = -(BOT_TO_HIT_LONG_RANGE_MAX_PENALTY * longRangeProgress);
  }

  return {
    chance: clampNumber(
      profile.toHitBaseChance
        + rangeModifier
        - (attackerSpeedRatio * BOT_TO_HIT_ATTACKER_SPEED_MAX_PENALTY)
        - (targetSpeedRatio * BOT_TO_HIT_TARGET_SPEED_MAX_PENALTY)
        - (targetSpeedRatio * crossingFactor * BOT_TO_HIT_TARGET_CROSSING_MAX_PENALTY)
        - (input.attackerAirborne ? BOT_TO_HIT_ATTACKER_JUMP_PENALTY : 0)
        - (input.targetAirborne ? BOT_TO_HIT_TARGET_JUMP_PENALTY : 0),
      BOT_TO_HIT_MIN_CHANCE,
      profile.toHitMaxChance,
    ),
    rangeBand,
    crossingFactor,
  };
}

function resolveCombatToHitRoll(
  input: CombatToHitRollInput,
  difficultyProfile?: BotDifficultyProfile,
): CombatToHitRoll {
  const estimate = estimateCombatToHit(input, difficultyProfile);
  const roll = Math.random();
  return {
    hit: roll <= estimate.chance,
    chance: estimate.chance,
    roll,
    rangeBand: estimate.rangeBand,
    crossingFactor: estimate.crossingFactor,
  };
}

function getMissImpactPoint(
  attackerX: number,
  attackerY: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  distanceMeters: number,
): { impactX: number; impactY: number; impactZ: number } {
  const dx = targetX - attackerX;
  const dy = targetY - attackerY;
  const distanceUnits = Math.hypot(dx, dy);
  const forwardX = distanceUnits > 0 ? dx / distanceUnits : 1;
  const forwardY = distanceUnits > 0 ? dy / distanceUnits : 0;
  const normalX = -forwardY;
  const normalY = forwardX;
  const lateralOffsetUnits = clampNumber(
    10 + (distanceMeters * 0.06),
    BOT_MISS_OFFSET_MIN_METERS,
    BOT_MISS_OFFSET_MAX_METERS,
  ) * COMBAT_WORLD_UNITS_PER_METER;
  const forwardOffsetUnits = clampNumber(2 + (distanceMeters * 0.02), 2, 12) * COMBAT_WORLD_UNITS_PER_METER;
  const lateralSign = Math.random() < 0.5 ? -1 : 1;
  const forwardSign = Math.random() < 0.5 ? -1 : 1;
  return {
    impactX: Math.round(targetX + (normalX * lateralOffsetUnits * lateralSign) + (forwardX * forwardOffsetUnits * forwardSign)),
    impactY: Math.round(targetY + (normalY * lateralOffsetUnits * lateralSign) + (forwardY * forwardOffsetUnits * forwardSign)),
    impactZ: Math.max(0, Math.round(targetZ * 0.5)),
  };
}

function setBotMoveVector(bot: SoloCombatBotActorState, moveVectorX: number, moveVectorY: number): void {
  bot.moveVectorX = moveVectorX;
  bot.moveVectorY = moveVectorY;
}

function setPlayerMoveVector(session: ClientSession, moveVectorX: number, moveVectorY: number): void {
  session.combatMoveVectorX = moveVectorX;
  session.combatMoveVectorY = moveVectorY;
}

type BotTicPresetName = 'A' | 'B' | 'C';

interface BotVolleyCandidateShot {
  weaponSlot: number;
  damage: number;
  heat: number;
  weaponName?: string;
  weaponSpec?: WeaponDataSpec;
  cooldownMs?: number;
  maxRangeMeters?: number;
  rangeBand: CombatRangeBand;
  efficiency: number;
  hitChance: number;
  expectedDamage: number;
  expectedEfficiency: number;
}

interface BotTicPreset {
  name: BotTicPresetName;
  shots: BotVolleyCandidateShot[];
  totalHeat: number;
  totalDamage: number;
  totalExpectedDamage: number;
  overheatRisk: number;
}

function getBotHeatSinkCount(bot: SoloCombatBotActorState): number {
  return Math.max(1, getMechEntryForId(bot.mechId)?.heatSinks ?? 10);
}

function getBotHeatCapacity(heatSinks: number): number {
  return Math.max(12, heatSinks * 1.5);
}

function estimateBotOverheatRisk(currentHeat: number, addedHeat: number, heatSinks: number): number {
  const heatCapacity = getBotHeatCapacity(heatSinks);
  const riskStart = heatSinks * 0.9;
  return clampNumber(
    ((currentHeat + addedHeat) - riskStart) / Math.max(6, heatCapacity - riskStart),
    0,
    1,
  );
}

function coolBotHeat(bot: SoloCombatBotActorState, heatSinks: number): void {
  const currentHeat = bot.heat;
  const cooledHeat = Math.max(
    0,
    currentHeat - ((heatSinks * BOT_AI_TICK_MS) / BOT_AI_HEAT_DISSIPATION_WINDOW_MS),
  );
  bot.heat = cooledHeat;
}

function buildBotTicPresetFromCandidates(
  name: BotTicPresetName,
  candidates: readonly BotVolleyCandidateShot[],
  heatBudget: number,
  currentHeat: number,
  heatSinks: number,
): BotTicPreset {
  const shots: BotVolleyCandidateShot[] = [];
  let totalHeat = 0;
  let totalDamage = 0;
  let totalExpectedDamage = 0;
  for (const shot of candidates) {
    if (shots.length > 0 && totalHeat + shot.heat > heatBudget) {
      continue;
    }
    shots.push(shot);
    totalHeat += shot.heat;
    totalDamage += shot.damage;
    totalExpectedDamage += shot.expectedDamage;
  }
  if (shots.length === 0 && candidates.length > 0) {
    shots.push(candidates[0]);
    totalHeat = candidates[0].heat;
    totalDamage = candidates[0].damage;
    totalExpectedDamage = candidates[0].expectedDamage;
  }
  return {
    name,
    shots,
    totalHeat,
    totalDamage,
    totalExpectedDamage,
    overheatRisk: estimateBotOverheatRisk(currentHeat, totalHeat, heatSinks),
  };
}

function buildBotTicPresets(
  availableShots: readonly BotVolleyCandidateShot[],
  currentHeat: number,
  heatSinks: number,
): Record<BotTicPresetName, BotTicPreset> {
  const alphaCandidates = [...availableShots].sort((a, b) => {
    const rangePriority = (band: CombatRangeBand) => band === 'short' ? 2 : band === 'medium' ? 1 : 0;
    return (rangePriority(b.rangeBand) - rangePriority(a.rangeBand))
      || (b.expectedDamage - a.expectedDamage)
      || (b.hitChance - a.hitChance)
      || (b.damage - a.damage)
      || (a.heat - b.heat)
      || (b.expectedEfficiency - a.expectedEfficiency)
      || (b.efficiency - a.efficiency);
  });
  const sustainCandidates = [...availableShots].sort((a, b) => {
    const rangePriority = (band: CombatRangeBand) => band === 'medium' ? 2 : band === 'long' ? 1 : 0;
    return (b.expectedEfficiency - a.expectedEfficiency)
      || (b.expectedDamage - a.expectedDamage)
      || (b.hitChance - a.hitChance)
      || (b.efficiency - a.efficiency)
      || (rangePriority(b.rangeBand) - rangePriority(a.rangeBand))
      || (b.damage - a.damage)
      || (a.heat - b.heat);
  });
  const pokeCandidates = [...availableShots].sort((a, b) => {
    const rangePriority = (band: CombatRangeBand) => band === 'long' ? 2 : band === 'medium' ? 1 : 0;
    return (rangePriority(b.rangeBand) - rangePriority(a.rangeBand))
      || (b.hitChance - a.hitChance)
      || (b.expectedEfficiency - a.expectedEfficiency)
      || (b.expectedDamage - a.expectedDamage)
      || (a.heat - b.heat)
      || (b.efficiency - a.efficiency)
      || (b.damage - a.damage);
  });
  return {
    A: buildBotTicPresetFromCandidates('A', alphaCandidates, Math.max(1, heatSinks * BOT_AI_TIC_ALPHA_HEAT_RATIO), currentHeat, heatSinks),
    B: buildBotTicPresetFromCandidates('B', sustainCandidates, Math.max(1, heatSinks * BOT_AI_TIC_SUSTAIN_HEAT_RATIO), currentHeat, heatSinks),
    C: buildBotTicPresetFromCandidates('C', pokeCandidates, Math.max(1, heatSinks * BOT_AI_TIC_POKE_HEAT_RATIO), currentHeat, heatSinks),
  };
}

function chooseBotTicPreset(
  presets: Record<BotTicPresetName, BotTicPreset>,
  distanceMeters: number,
  playerHealth: number,
  currentHeat: number,
  heatSinks: number,
  difficultyProfile: BotDifficultyProfile,
): BotTicPreset | undefined {
  const alpha = presets.A;
  const sustain = presets.B;
  const poke = presets.C;
  if (alpha.shots.length === 0 && sustain.shots.length === 0 && poke.shots.length === 0) {
    return undefined;
  }

  const heatCapacity = getBotHeatCapacity(heatSinks);
  const heatRatio = currentHeat / heatCapacity;

  if (
    playerHealth <= difficultyProfile.finisherPushHealthThreshold
    && alpha.shots.length > 0
    && alpha.overheatRisk <= BOT_AI_TIC_FINISHER_OVERHEAT_RISK
    && alpha.totalExpectedDamage >= Math.max(5, sustain.totalExpectedDamage * 0.85)
  ) {
    return alpha;
  }
  if (heatRatio >= 0.78 || sustain.overheatRisk > BOT_AI_TIC_SAFE_OVERHEAT_RISK) {
    return poke.shots.length > 0 ? poke : sustain.shots.length > 0 ? sustain : alpha;
  }
  if (
    distanceMeters > 430
    && poke.shots.length > 0
    && poke.totalExpectedDamage >= Math.max(3, sustain.totalExpectedDamage * 0.7)
  ) {
    return poke;
  }
  if (
    distanceMeters <= 170
    && alpha.shots.length > 0
    && alpha.overheatRisk <= BOT_AI_TIC_SAFE_OVERHEAT_RISK
    && alpha.totalExpectedDamage >= Math.max(4, sustain.totalExpectedDamage * 0.9)
  ) {
    return alpha;
  }
  if (distanceMeters <= 300 && sustain.shots.length > 0) {
    if (
      alpha.shots.length > 0
      && alpha.overheatRisk <= BOT_AI_TIC_SAFE_OVERHEAT_RISK
      && alpha.totalExpectedDamage >= sustain.totalExpectedDamage * 1.15
    ) {
      return alpha;
    }
    return sustain;
  }
  if (poke.shots.length > 0 && poke.totalExpectedDamage >= Math.max(3, sustain.totalExpectedDamage * 0.7)) {
    return poke;
  }
  return sustain.shots.length > 0 ? sustain : alpha.shots.length > 0 ? alpha : poke;
}

function getWeaponCooldownGateForState(
  readyAtBySlot: readonly number[] | undefined,
  weaponSlot: number,
  weaponName: string | undefined,
  cooldownMs: number | undefined,
  now: number,
): { allowed: boolean; remainingMs?: number; cooldownMs?: number; weaponName?: string } {
  if (cooldownMs === undefined || cooldownMs <= 0) {
    return { allowed: true, cooldownMs, weaponName };
  }

  const readyAt = readyAtBySlot?.[weaponSlot];
  if (readyAt !== undefined && readyAt > now) {
    return {
      allowed: false,
      remainingMs: readyAt - now,
      cooldownMs,
      weaponName,
    };
  }

  return {
    allowed: true,
    cooldownMs,
    weaponName,
  };
}

function getWeaponCooldownGate(
  session: ClientSession,
  weaponSlot: number,
  now: number,
): { allowed: boolean; remainingMs?: number; cooldownMs?: number; weaponName?: string } {
  const weaponName = getWeaponNameForSlot(session, weaponSlot);
  const cooldownMs = getWeaponSpecForSlot(session, weaponSlot)?.cooldownMs;
  return getWeaponCooldownGateForState(
    session.combatWeaponReadyAtBySlot,
    weaponSlot,
    weaponName,
    cooldownMs,
    now,
  );
}

function consumeWeaponAmmo(
  session: ClientSession,
  weaponSlot: number,
): { allowed: boolean; remainingAmmo?: number; ammoBinIndex?: number; damageCode?: number; weaponName?: string } {
  const mechEntry = getMechEntryForSession(session);
  const weaponName = getWeaponNameForSlot(session, weaponSlot);
  const weaponTypeId = getWeaponTypeIdForSlot(session, weaponSlot);
  if (!mechEntry || weaponTypeId === undefined) {
    return { allowed: true, weaponName };
  }
  if (!weaponTypeUsesAmmo(weaponTypeId)) {
    return { allowed: true, weaponName };
  }

  const matchingAmmoBinIndexes: number[] = [];
  for (let ammoBinIndex = 0; ammoBinIndex < mechEntry.ammoBinTypeIds.length; ammoBinIndex += 1) {
    if (mechEntry.ammoBinTypeIds[ammoBinIndex] === weaponTypeId) {
      matchingAmmoBinIndexes.push(ammoBinIndex);
    }
  }
  if (matchingAmmoBinIndexes.length === 0) {
    return { allowed: false, weaponName };
  }

  const ammoStateValues = getOrCreateAmmoStateValues(session.combatAmmoStateValues, mechEntry.ammoBinTypeIds);
  const ammoBinIndex = matchingAmmoBinIndexes.find(index => (ammoStateValues[index] ?? 0) > 0);
  if (ammoBinIndex === undefined) {
    return { allowed: false, weaponName };
  }

  const remainingAmmo = Math.max(0, (ammoStateValues[ammoBinIndex] ?? 0) - 1);
  ammoStateValues[ammoBinIndex] = remainingAmmo;
  session.combatAmmoStateValues = ammoStateValues;
  return {
    allowed: true,
    remainingAmmo,
    ammoBinIndex,
    damageCode: getAmmoDamageCodeBase(mechEntry.extraCritCount, mechEntry.weaponTypeIds.length) + ammoBinIndex,
    weaponName,
  };
}

function markWeaponSlotFired(
  session: ClientSession,
  weaponSlot: number,
  cooldownMs: number | undefined,
  now: number,
): void {
  if (cooldownMs === undefined || cooldownMs <= 0) {
    return;
  }

  if (!session.combatWeaponReadyAtBySlot) {
    session.combatWeaponReadyAtBySlot = [];
  }
  if (!session.combatWeaponReadyTimerBySlot) {
    session.combatWeaponReadyTimerBySlot = [];
  }

  const readyAt = now + cooldownMs;
  session.combatWeaponReadyAtBySlot[weaponSlot] = readyAt;

  const existingTimer = session.combatWeaponReadyTimerBySlot[weaponSlot];
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  // Retail updates the local actor's weapon/ammo HUD state inside the client's
  // own fire gate. We keep the timer only for server-side rejection logic.
  const readyTimer = setTimeout(() => {
    if (session.combatWeaponReadyTimerBySlot) {
      session.combatWeaponReadyTimerBySlot[weaponSlot] = undefined;
    }
    if ((session.combatWeaponReadyAtBySlot?.[weaponSlot] ?? 0) !== readyAt) {
      return;
    }

    const readyAtBySlot = session.combatWeaponReadyAtBySlot;
    if (!readyAtBySlot) {
      return;
    }
    readyAtBySlot[weaponSlot] = 0;
    if (
      session.socket.destroyed
      || !session.socket.writable
      || session.phase !== 'combat'
      || !session.combatInitialized
    ) {
      return;
    }

    const mountGate = getWeaponMountGate(session, weaponSlot);
    if (!mountGate.allowed) {
      return;
    }
  }, cooldownMs);
  readyTimer.unref();
  session.combatWeaponReadyTimerBySlot[weaponSlot] = readyTimer;
}

function getBotWeaponAmmoGate(
  bot: SoloCombatBotActorState,
  weaponSlot: number,
  consume: boolean,
): { allowed: boolean; remainingAmmo?: number; ammoBinIndex?: number; damageCode?: number; weaponName?: string } {
  const botMechId = bot.mechId;
  const mechEntry = getMechEntryForId(botMechId);
  const weaponName = getWeaponNameForMechSlot(botMechId, weaponSlot);
  const weaponTypeId = getWeaponTypeIdForMechSlot(botMechId, weaponSlot);
  if (!mechEntry || weaponTypeId === undefined) {
    return { allowed: true, weaponName };
  }
  if (!weaponTypeUsesAmmo(weaponTypeId)) {
    return { allowed: true, weaponName };
  }

  const matchingAmmoBinIndexes: number[] = [];
  for (let ammoBinIndex = 0; ammoBinIndex < mechEntry.ammoBinTypeIds.length; ammoBinIndex += 1) {
    if (mechEntry.ammoBinTypeIds[ammoBinIndex] === weaponTypeId) {
      matchingAmmoBinIndexes.push(ammoBinIndex);
    }
  }
  if (matchingAmmoBinIndexes.length === 0) {
    return { allowed: false, weaponName };
  }

  const ammoStateValues = consume
    ? getOrCreateAmmoStateValues(bot.ammoStateValues, mechEntry.ammoBinTypeIds)
    : (bot.ammoStateValues.length > 0 ? bot.ammoStateValues : getInitialCombatAmmoStateValues(mechEntry.ammoBinTypeIds));
  const ammoBinIndex = matchingAmmoBinIndexes.find(index => (ammoStateValues[index] ?? 0) > 0);
  if (ammoBinIndex === undefined) {
    return { allowed: false, weaponName };
  }

  const remainingAmmo = Math.max(0, (ammoStateValues[ammoBinIndex] ?? 0) - 1);
  if (consume) {
    ammoStateValues[ammoBinIndex] = remainingAmmo;
    bot.ammoStateValues = ammoStateValues;
  }
  return {
    allowed: true,
    remainingAmmo: consume ? remainingAmmo : (ammoStateValues[ammoBinIndex] ?? 0),
    ammoBinIndex,
    damageCode: getAmmoDamageCodeBase(mechEntry.extraCritCount, mechEntry.weaponTypeIds.length) + ammoBinIndex,
    weaponName,
  };
}

function peekBotWeaponAmmo(
  bot: SoloCombatBotActorState,
  weaponSlot: number,
): { allowed: boolean; remainingAmmo?: number; ammoBinIndex?: number; damageCode?: number; weaponName?: string } {
  return getBotWeaponAmmoGate(bot, weaponSlot, false);
}

function consumeBotWeaponAmmo(
  bot: SoloCombatBotActorState,
  weaponSlot: number,
): { allowed: boolean; remainingAmmo?: number; ammoBinIndex?: number; damageCode?: number; weaponName?: string } {
  return getBotWeaponAmmoGate(bot, weaponSlot, true);
}

function markBotWeaponSlotFired(
  bot: SoloCombatBotActorState,
  weaponSlot: number,
  cooldownMs: number | undefined,
  now: number,
): void {
  if (cooldownMs === undefined || cooldownMs <= 0) {
    return;
  }
  bot.weaponReadyAtBySlot[weaponSlot] = now + cooldownMs;
}

function clearPendingCombatAction0Followup(session: ClientSession): void {
  if (session.combatAction0FollowupTimer !== undefined) {
    clearTimeout(session.combatAction0FollowupTimer);
    session.combatAction0FollowupTimer = undefined;
  }
}

function maybeSendAction0RecoveryAck(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (!session.combatRecoveryExperimentPending) {
    return;
  }
  if (!session.combatLocalDowned) {
    session.combatRecoveryExperimentPending = false;
    connLog.debug('[world/combat] action0 recovery ack skipped: no pending local downed state');
    return;
  }
  if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') {
    return;
  }
  if (session.combatResultCode !== undefined) {
    session.combatLocalDowned = false;
    session.combatRecoveryExperimentPending = false;
    return;
  }

  session.combatLocalDowned = false;
  session.combatRecoveryExperimentPending = false;
  connLog.info(
    '[world/combat] action0 recovery ack: sending local Cmd70/0 after cmd12/action0 while local actor is downed',
  );
  sendCmd73RateProbe(
    session,
    connLog,
    capture,
    'before local Cmd70/0 recovery ack',
    'CMD73_RATE_PROBE_RECOVERY_BEFORE_CMD70_0',
  );
  send(
    session.socket,
    buildCmd70ActorTransitionPacket(0, 0, nextSeq(session)),
    capture,
    'CMD70_ACTION0_RECOVERY_ACK',
  );
}

function noteCombatAction0Observed(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  clearPendingCombatAction0Followup(session);
  const observedAt = Date.now();
  session.lastCombatFireActionAt = observedAt;
  const followupTimer = setTimeout(() => {
    if (session.lastCombatFireActionAt !== observedAt) {
      return;
    }
    session.combatAction0NoShotCount = (session.combatAction0NoShotCount ?? 0) + 1;
    session.lastCombatFireActionAt = undefined;
    session.combatAction0FollowupTimer = undefined;
    connLog.info(
      '[world/combat] cmd12 action=0 had no cmd10 follow-up within %dms',
      FIRE_ACTION_WINDOW_MS,
    );
    maybeSendAction0RecoveryAck(session, connLog, capture);
  }, FIRE_ACTION_WINDOW_MS + 25);
  session.combatAction0FollowupTimer = followupTimer;
  followupTimer.unref();
}

function applyDamageToSection(
  armorValues: number[],
  internalValues: number[],
  hitSection: CombatAttachmentHitSection,
  damage: number,
  headArmor = 0,
): { updates: DamageCodeUpdate[]; headArmor: number } {
  const updates: DamageCodeUpdate[] = [];
  let remaining = Math.max(0, damage);
  let nextHeadArmor = Math.max(0, headArmor);

  if (remaining <= 0) return { updates, headArmor: nextHeadArmor };

  const armorIndex = hitSection.armorIndex;
  const internalIndex = hitSection.internalIndex;
  const armorCurrent = armorIndex >= 0
    ? (armorValues[armorIndex] ?? 0)
    : internalIndex === 7 ? nextHeadArmor : 0;

  if (armorIndex >= 0 && armorCurrent > 0) {
    const absorbedByArmor = Math.min(armorCurrent, remaining);
    const armorValue = armorCurrent - absorbedByArmor;
    armorValues[armorIndex] = armorValue;
    updates.push({ damageCode: 0x15 + armorIndex, damageValue: armorValue });
    remaining -= absorbedByArmor;
  } else if (armorIndex < 0 && internalIndex === 7 && armorCurrent > 0) {
    const absorbedByArmor = Math.min(armorCurrent, remaining);
    nextHeadArmor = armorCurrent - absorbedByArmor;
    remaining -= absorbedByArmor;
  }

  if (remaining > 0) {
    const internalCurrent = internalValues[internalIndex] ?? 0;
    const absorbedByInternal = Math.min(internalCurrent, remaining);
    const internalValue = internalCurrent - absorbedByInternal;
    internalValues[internalIndex] = internalValue;
    updates.push({ damageCode: 0x20 + internalIndex, damageValue: internalValue });
  }

  return { updates, headArmor: nextHeadArmor };
}

function chooseRetaliationHitSection(
  session: { combatRetaliationCursor?: number } | undefined,
  armorValues: readonly number[],
  internalValues: readonly number[],
  headArmor: number,
): CombatAttachmentHitSection {
  const start = session?.combatRetaliationCursor ?? 0;
  for (let offset = 0; offset < LOCAL_RETALIATION_SECTIONS.length; offset++) {
    const idx = (start + offset) % LOCAL_RETALIATION_SECTIONS.length;
    const section = LOCAL_RETALIATION_SECTIONS[idx];
    if (
      (section.armorIndex >= 0
        ? (armorValues[section.armorIndex] ?? 0)
        : section.internalIndex === 7 ? headArmor : 0) > 0
      || (internalValues[section.internalIndex] ?? 0) > 0
    ) {
      if (session) {
        session.combatRetaliationCursor = (idx + 1) % LOCAL_RETALIATION_SECTIONS.length;
      }
      return section;
    }
  }
  const fallback = LOCAL_RETALIATION_SECTIONS[start % LOCAL_RETALIATION_SECTIONS.length]
    ?? LOCAL_RETALIATION_SECTIONS[0];
  if (session) {
    session.combatRetaliationCursor = ((start % LOCAL_RETALIATION_SECTIONS.length) + 1)
      % LOCAL_RETALIATION_SECTIONS.length;
  }
  return fallback;
}

function resolveEffectiveHitSection(
  mechId: number | undefined,
  attach: number,
  impactZ: number,
  armorValues: readonly number[],
  internalValues: readonly number[],
  impactContext?: CombatAttachmentImpactContext,
): CombatAttachmentHitSection {
  let hitSection = resolveBotHitSection(mechId, attach, impactZ, impactContext);
  const primaryArmorCurrent = armorValues[hitSection.armorIndex] ?? 0;
  const primaryInternalCurrent = internalValues[hitSection.internalIndex] ?? 0;
  if (
    primaryArmorCurrent <= 0 &&
    primaryInternalCurrent <= 0 &&
    shouldSpillUpperBodyHitToCenter(hitSection)
  ) {
    hitSection = { armorIndex: 4, internalIndex: 4, label: 'ct-front-spill' };
  }
  return hitSection;
}

function sectionsMatch(
  a: CombatAttachmentHitSection,
  b: CombatAttachmentHitSection,
): boolean {
  return a.armorIndex === b.armorIndex && a.internalIndex === b.internalIndex;
}

function getMissileSpreadFallbackSection(primaryHitSection: CombatAttachmentHitSection): CombatAttachmentHitSection {
  if (
    sectionsMatch(primaryHitSection, LEFT_TORSO_REAR_RETALIATION_SECTION)
    || sectionsMatch(primaryHitSection, CENTER_TORSO_REAR_RETALIATION_SECTION)
    || sectionsMatch(primaryHitSection, RIGHT_TORSO_REAR_RETALIATION_SECTION)
  ) {
    return CENTER_TORSO_REAR_RETALIATION_SECTION;
  }
  if (shouldSpillUpperBodyHitToCenter(primaryHitSection)) {
    return CENTER_TORSO_FRONT_RETALIATION_SECTION;
  }
  return primaryHitSection;
}

function getMissileSpreadCandidates(
  primaryHitSection: CombatAttachmentHitSection,
  spreadSeed: number,
): readonly CombatAttachmentHitSection[] {
  const preferRight = (spreadSeed & 1) !== 0;
  const frontTorsoA = preferRight ? RIGHT_TORSO_FRONT_RETALIATION_SECTION : LEFT_TORSO_FRONT_RETALIATION_SECTION;
  const frontTorsoB = preferRight ? LEFT_TORSO_FRONT_RETALIATION_SECTION : RIGHT_TORSO_FRONT_RETALIATION_SECTION;
  const rearTorsoA = preferRight ? RIGHT_TORSO_REAR_RETALIATION_SECTION : LEFT_TORSO_REAR_RETALIATION_SECTION;
  const rearTorsoB = preferRight ? LEFT_TORSO_REAR_RETALIATION_SECTION : RIGHT_TORSO_REAR_RETALIATION_SECTION;
  const frontArmA = preferRight ? RIGHT_ARM_RETALIATION_SECTION : LEFT_ARM_RETALIATION_SECTION;
  const frontArmB = preferRight ? LEFT_ARM_RETALIATION_SECTION : RIGHT_ARM_RETALIATION_SECTION;
  const frontLegA = preferRight ? RIGHT_LEG_RETALIATION_SECTION : LEFT_LEG_RETALIATION_SECTION;
  const frontLegB = preferRight ? LEFT_LEG_RETALIATION_SECTION : RIGHT_LEG_RETALIATION_SECTION;

  if (sectionsMatch(primaryHitSection, HEAD_RETALIATION_SECTION)) {
    return [
      HEAD_RETALIATION_SECTION,
      HEAD_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
      frontTorsoA,
      frontTorsoB,
    ];
  }
  if (sectionsMatch(primaryHitSection, LEFT_ARM_RETALIATION_SECTION)) {
    return [
      LEFT_ARM_RETALIATION_SECTION,
      LEFT_ARM_RETALIATION_SECTION,
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, RIGHT_ARM_RETALIATION_SECTION)) {
    return [
      RIGHT_ARM_RETALIATION_SECTION,
      RIGHT_ARM_RETALIATION_SECTION,
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, LEFT_TORSO_FRONT_RETALIATION_SECTION)) {
    return [
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      LEFT_ARM_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
      LEFT_LEG_RETALIATION_SECTION,
      HEAD_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, CENTER_TORSO_FRONT_RETALIATION_SECTION)) {
    return [
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
      frontTorsoA,
      frontTorsoB,
      HEAD_RETALIATION_SECTION,
      frontArmA,
      frontArmB,
      frontLegA,
      frontLegB,
    ];
  }
  if (sectionsMatch(primaryHitSection, RIGHT_TORSO_FRONT_RETALIATION_SECTION)) {
    return [
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      RIGHT_ARM_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
      RIGHT_LEG_RETALIATION_SECTION,
      HEAD_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, LEFT_LEG_RETALIATION_SECTION)) {
    return [
      LEFT_LEG_RETALIATION_SECTION,
      LEFT_LEG_RETALIATION_SECTION,
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, RIGHT_LEG_RETALIATION_SECTION)) {
    return [
      RIGHT_LEG_RETALIATION_SECTION,
      RIGHT_LEG_RETALIATION_SECTION,
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      CENTER_TORSO_FRONT_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, LEFT_TORSO_REAR_RETALIATION_SECTION)) {
    return [
      LEFT_TORSO_REAR_RETALIATION_SECTION,
      LEFT_TORSO_REAR_RETALIATION_SECTION,
      CENTER_TORSO_REAR_RETALIATION_SECTION,
      LEFT_TORSO_FRONT_RETALIATION_SECTION,
      LEFT_ARM_RETALIATION_SECTION,
      LEFT_LEG_RETALIATION_SECTION,
    ];
  }
  if (sectionsMatch(primaryHitSection, CENTER_TORSO_REAR_RETALIATION_SECTION)) {
    return [
      CENTER_TORSO_REAR_RETALIATION_SECTION,
      CENTER_TORSO_REAR_RETALIATION_SECTION,
      rearTorsoA,
      rearTorsoB,
      HEAD_RETALIATION_SECTION,
      frontTorsoA,
      frontTorsoB,
    ];
  }
  if (sectionsMatch(primaryHitSection, RIGHT_TORSO_REAR_RETALIATION_SECTION)) {
    return [
      RIGHT_TORSO_REAR_RETALIATION_SECTION,
      RIGHT_TORSO_REAR_RETALIATION_SECTION,
      CENTER_TORSO_REAR_RETALIATION_SECTION,
      RIGHT_TORSO_FRONT_RETALIATION_SECTION,
      RIGHT_ARM_RETALIATION_SECTION,
      RIGHT_LEG_RETALIATION_SECTION,
    ];
  }
  return [primaryHitSection];
}

function getMissileSpreadSeed(
  weaponSlot: number,
  targetAttach: number,
  angleSeedA: number,
  angleSeedB: number,
): number {
  const attachSeed = Math.max(0, targetAttach);
  return (
    ((weaponSlot + 1) * 97)
    ^ ((attachSeed + 1) * 193)
    ^ ((angleSeedA + 1) * 389)
    ^ ((angleSeedB + 1) * 769)
  ) >>> 0;
}

function chooseMissileClusterHitSection(
  primaryHitSection: CombatAttachmentHitSection,
  spreadSeed: number,
  clusterIndex: number,
  armorValues: readonly number[],
  internalValues: readonly number[],
  headArmor: number,
): CombatAttachmentHitSection {
  if (
    clusterIndex === 0
    && getSectionRemainingDurability(armorValues, internalValues, headArmor, primaryHitSection) > 0
  ) {
    return primaryHitSection;
  }

  const candidates = getMissileSpreadCandidates(primaryHitSection, spreadSeed);
  const startIndex = clusterIndex <= 0
    ? 0
    : (spreadSeed + clusterIndex - 1) % candidates.length;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(startIndex + offset) % candidates.length] ?? primaryHitSection;
    if (getSectionRemainingDurability(armorValues, internalValues, headArmor, candidate) > 0) {
      return candidate;
    }
  }

  return getMissileSpreadFallbackSection(primaryHitSection);
}

function summarizeHitSections(hitSections: readonly CombatAttachmentHitSection[]): string {
  const counts = new Map<string, number>();
  for (const section of hitSections) {
    counts.set(section.label, (counts.get(section.label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => count > 1 ? `${label}x${count}` : label)
    .join('+');
}

function applyWeaponDamage(
  weaponSpec: WeaponDataSpec | undefined,
  shotDamage: number,
  primaryHitSection: CombatAttachmentHitSection,
  weaponSlot: number,
  targetAttach: number,
  angleSeedA: number,
  angleSeedB: number,
  armorValues: number[],
  internalValues: number[],
  headArmor: number,
): AppliedWeaponDamageResult {
  const missileCount = weaponSpec?.missileCount ?? 0;
  const damagePerMissile = weaponSpec?.damagePerMissile ?? 0;
  if (
    missileCount <= 1
    || damagePerMissile <= 0
    || missileCount * damagePerMissile !== shotDamage
  ) {
    const damageResult = applyDamageToSection(
      armorValues,
      internalValues,
      primaryHitSection,
      shotDamage,
      headArmor,
    );
    return {
      updates: damageResult.updates,
      headArmor: damageResult.headArmor,
      hitSections: [primaryHitSection],
      headInternalDamaged: damageResult.updates.some(update => update.damageCode === 0x27),
    };
  }

  const spreadSeed = getMissileSpreadSeed(weaponSlot, targetAttach, angleSeedA, angleSeedB);
  const updates: DamageCodeUpdate[] = [];
  const hitSections: CombatAttachmentHitSection[] = [];
  let nextHeadArmor = headArmor;
  let headInternalDamaged = false;
  for (let clusterIndex = 0; clusterIndex < missileCount; clusterIndex += 1) {
    const hitSection = chooseMissileClusterHitSection(
      primaryHitSection,
      spreadSeed,
      clusterIndex,
      armorValues,
      internalValues,
      nextHeadArmor,
    );
    const damageResult = applyDamageToSection(
      armorValues,
      internalValues,
      hitSection,
      damagePerMissile,
      nextHeadArmor,
    );
    nextHeadArmor = damageResult.headArmor;
    if (damageResult.updates.length > 0 || clusterIndex === 0) {
      hitSections.push(hitSection);
    }
    if (damageResult.updates.length > 0) {
      updates.push(...damageResult.updates);
      if (!headInternalDamaged && damageResult.updates.some(update => update.damageCode === 0x27)) {
        headInternalDamaged = true;
      }
    }
  }

  return {
    updates,
    headArmor: nextHeadArmor,
    hitSections: hitSections.length > 0 ? hitSections : [primaryHitSection],
    headInternalDamaged,
  };
}

function getBotMechId(session: ClientSession): number {
  return session.combatBotMechId ?? session.selectedMechId ?? FALLBACK_MECH_ID;
}

const MAX_SINGLE_PLAYER_BOT_OPPONENTS = 7;
const MIN_SOLO_COMBAT_SIDE = 1;
const MAX_SOLO_COMBAT_SIDE = 8;

function clampBotOpponentCount(count: number | undefined): number {
  return Math.max(1, Math.min(MAX_SINGLE_PLAYER_BOT_OPPONENTS, Math.trunc(count ?? 1)));
}

function clampSoloCombatSide(side: number | undefined, fallback = MIN_SOLO_COMBAT_SIDE): number {
  if (side === undefined || !Number.isFinite(side)) {
    return fallback;
  }
  return Math.max(MIN_SOLO_COMBAT_SIDE, Math.min(MAX_SOLO_COMBAT_SIDE, Math.trunc(side)));
}

function getConfiguredSoloCombatPlayerSide(session: ClientSession): number {
  return clampSoloCombatSide(session.worldArenaSide, MIN_SOLO_COMBAT_SIDE);
}

function getConfiguredSoloCombatDefaultEnemySide(session: ClientSession): number {
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  return playerSide === MIN_SOLO_COMBAT_SIDE ? 2 : MIN_SOLO_COMBAT_SIDE;
}

function getConfiguredBotOpponentCount(session: ClientSession): number {
  return clampBotOpponentCount(session.combatBotOpponentCount);
}

function getConfiguredBotDifficultyLevel(session: ClientSession): number {
  return clampBotDifficultyLevel(session.combatBotDifficultyLevel ?? DEFAULT_BOT_DIFFICULTY_LEVEL);
}

function getConfiguredBotDifficultyProfile(session: ClientSession): BotDifficultyProfile {
  return getBotDifficultyProfile(getConfiguredBotDifficultyLevel(session));
}

function getConfiguredBotLoadoutId(
  session: ClientSession,
  botIndex: number,
): number {
  const index = Math.max(0, Math.min(MAX_SINGLE_PLAYER_BOT_OPPONENTS - 1, botIndex));
  const configured = session.combatBotLoadoutIds?.[index];
  if (configured !== undefined) {
    return configured;
  }
  const primary = session.combatBotLoadoutIds?.[0] ?? session.combatBotMechId;
  return primary ?? session.selectedMechId ?? FALLBACK_MECH_ID;
}

function getConfiguredBotLoadoutLabel(
  session: ClientSession,
  botIndex: number,
): string {
  const mechId = getConfiguredBotLoadoutId(session, botIndex);
  const mechEntry = WORLD_MECH_BY_ID.get(mechId);
  return mechEntry
    ? `${mechEntry.typeString} (id=${mechId})`
    : `Mech ${mechId}`;
}

function setConfiguredBotLoadoutId(
  session: ClientSession,
  botIndex: number,
  mechId: number,
): void {
  const index = Math.max(0, Math.min(MAX_SINGLE_PLAYER_BOT_OPPONENTS - 1, botIndex));
  const loadoutIds = [...(session.combatBotLoadoutIds ?? [])];
  loadoutIds[index] = mechId;
  if (index === 0) {
    session.combatBotMechId = mechId;
    loadoutIds[0] = mechId;
  }
  session.combatBotLoadoutIds = loadoutIds;
  session.combatBotOpponentCount = Math.max(getConfiguredBotOpponentCount(session), index + 1);
}

function getConfiguredBotSide(
  session: ClientSession,
  botIndex: number,
  verificationMode?: ClientSession['combatVerificationMode'],
): number {
  if (verificationMode) {
    return getConfiguredSoloCombatDefaultEnemySide(session);
  }
  const index = Math.max(0, Math.min(MAX_SINGLE_PLAYER_BOT_OPPONENTS - 1, botIndex));
  const configured = session.combatBotSides?.[index];
  return clampSoloCombatSide(configured, getConfiguredSoloCombatDefaultEnemySide(session));
}

function setConfiguredBotSide(
  session: ClientSession,
  botIndex: number,
  side: number,
): void {
  const index = Math.max(0, Math.min(MAX_SINGLE_PLAYER_BOT_OPPONENTS - 1, botIndex));
  const sides = [...(session.combatBotSides ?? [])];
  sides[index] = clampSoloCombatSide(side, getConfiguredSoloCombatDefaultEnemySide(session));
  session.combatBotSides = sides;
  session.combatBotOpponentCount = Math.max(getConfiguredBotOpponentCount(session), index + 1);
}

function getConfiguredBotSideSummaryLabel(
  session: ClientSession,
  botIndex: number,
  verificationMode?: ClientSession['combatVerificationMode'],
): string {
  const botSide = getConfiguredBotSide(session, botIndex, verificationMode);
  return botSide === getConfiguredSoloCombatPlayerSide(session)
    ? `${getArenaSideLabel(botSide)} (player team)`
    : getArenaSideLabel(botSide);
}

function hasConfiguredSoloCombatHostileBots(
  session: ClientSession,
  verificationMode?: ClientSession['combatVerificationMode'],
): boolean {
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  const botCount = getConfiguredSoloCombatBotCount(session, verificationMode);
  for (let index = 0; index < botCount; index += 1) {
    if (getConfiguredBotSide(session, index, verificationMode) !== playerSide) {
      return true;
    }
  }
  return false;
}

function buildBotConfigurationSummary(session: ClientSession): string {
  const count = getConfiguredBotOpponentCount(session);
  const difficultyLevel = getConfiguredBotDifficultyLevel(session);
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  const loadouts = Array.from({ length: count }, (_, index) =>
    `#${index + 1} ${getConfiguredBotSideSummaryLabel(session, index)} ${getConfiguredBotLoadoutLabel(session, index)}`,
  );
  return `Bot roster: ${count}. Player side: ${getArenaSideLabel(playerSide)}. Difficulty: ${difficultyLevel}/5. Slots: ${loadouts.join('; ')}`;
}

function getConfiguredSoloCombatBotCount(
  session: ClientSession,
  verificationMode: ClientSession['combatVerificationMode'],
): number {
  return verificationMode ? 1 : getConfiguredBotOpponentCount(session);
}

function getSoloCombatBotSlotLabel(
  slot: number,
  side: number,
  playerSide: number,
): string {
  const prefix = side === playerSide ? 'Ally' : 'Opponent';
  return slot === 1 ? prefix : `${prefix} ${slot}`;
}

function buildSoloCombatBotClusterSpawnPoints(
  indexes: number[],
  centerAngle: number,
  radiusUnits: number,
): Array<{ index: number; x: number; y: number }> {
  if (indexes.length === 0) {
    return [];
  }
  const baseX = Math.cos(centerAngle) * radiusUnits;
  const baseY = Math.sin(centerAngle) * radiusUnits;
  const tangentX = -Math.sin(centerAngle);
  const tangentY = Math.cos(centerAngle);
  return buildCombatTeamClusterPositions(indexes, baseX, baseY, tangentX, tangentY).map(position => ({
    index: position.item,
    x: position.x,
    y: position.y,
  }));
}

function getSoloCombatSpawnLayout(
  botSides: number[],
  playerSide: number,
): { playerSpawn: { x: number; y: number }; botSpawnPoints: Array<{ x: number; y: number }> } {
  const allyIndexes: number[] = [];
  const hostileIndexes: number[] = [];
  for (let index = 0; index < botSides.length; index += 1) {
    if (botSides[index] === playerSide) {
      allyIndexes.push(index);
    } else {
      hostileIndexes.push(index);
    }
  }

  const spawnPoints = Array.from({ length: botSides.length }, () => ({ x: 0, y: BOT_AI_SPAWN_DISTANCE }));
  let playerSpawn = { x: 0, y: 0 };
  const allyFormation = [...allyIndexes];
  allyFormation.splice(Math.floor(allyIndexes.length / 2), 0, -1);
  for (const position of buildCombatTeamClusterPositions(allyFormation, 0, 0, 1, 0)) {
    if (position.item === -1) {
      playerSpawn = { x: position.x, y: position.y };
      continue;
    }
    spawnPoints[position.item] = { x: position.x, y: position.y };
  }
  for (const point of buildSoloCombatBotClusterSpawnPoints(hostileIndexes, Math.PI / 2, BOT_AI_SPAWN_DISTANCE)) {
    spawnPoints[point.index] = { x: point.x, y: point.y };
  }
  return { playerSpawn, botSpawnPoints: spawnPoints };
}

function getSoloCombatBots(session: ClientSession): SoloCombatBotActorState[] {
  return session.combatBotActors ?? [];
}

function getActiveSoloCombatBots(session: ClientSession): SoloCombatBotActorState[] {
  return getSoloCombatBots(session).filter(bot => bot.health > 0);
}

function getActiveHostileSoloCombatBots(session: ClientSession): SoloCombatBotActorState[] {
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  return getActiveSoloCombatBots(session).filter(bot => bot.side !== playerSide);
}

function getSoloCombatBotBySlot(
  session: ClientSession,
  slot: number,
): SoloCombatBotActorState | undefined {
  return getSoloCombatBots(session).find(bot => bot.slot === slot);
}

interface SoloCombatBotTargetState {
  kind: 'player' | 'bot';
  slot: number;
  side: number;
  mechId: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  speedMag: number;
  maxSpeedMag?: number;
  airborne: boolean;
  moveVectorX: number;
  moveVectorY: number;
  health: number;
  internalValues: readonly number[];
  bot?: SoloCombatBotActorState;
}

function getPreferredSoloCombatTarget(
  session: ClientSession,
  attacker: SoloCombatBotActorState,
): SoloCombatBotTargetState | undefined {
  const candidates: SoloCombatBotTargetState[] = [];
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  const playerInternalValues = session.combatPlayerInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES;
  const playerHealth = session.playerHealth ?? getCombatDurability(
    session.combatPlayerArmorValues ?? DEFAULT_BOT_ARMOR_VALUES,
    playerInternalValues,
  ) + (session.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE);
  if (playerSide !== attacker.side && playerHealth > 0 && !isActorDestroyed(playerInternalValues)) {
    candidates.push({
      kind: 'player',
      slot: 0,
      side: playerSide,
      mechId: session.selectedMechId ?? FALLBACK_MECH_ID,
      x: session.combatX ?? 0,
      y: session.combatY ?? 0,
      z: session.combatJumpAltitude ?? 0,
      facing: getCombatCmd65Facing(session),
      speedMag: session.combatSpeedMag ?? 0,
      maxSpeedMag: session.combatMaxSpeedMag,
      airborne: (session.combatJumpAltitude ?? 0) > 0,
      moveVectorX: session.combatMoveVectorX ?? 0,
      moveVectorY: session.combatMoveVectorY ?? 0,
      health: playerHealth,
      internalValues: playerInternalValues,
    });
  }

  for (const bot of getActiveSoloCombatBots(session)) {
    if (bot.slot === attacker.slot || bot.side === attacker.side || bot.health <= 0) {
      continue;
    }
    candidates.push({
      kind: 'bot',
      slot: bot.slot,
      side: bot.side,
      mechId: bot.mechId,
      x: bot.x,
      y: bot.y,
      z: bot.z,
      facing: bot.facing,
      speedMag: bot.speedMag,
      maxSpeedMag: getMechEntryForId(bot.mechId)?.maxSpeedMag,
      airborne: bot.jumpActive === true || bot.z > 0,
      moveVectorX: bot.moveVectorX,
      moveVectorY: bot.moveVectorY,
      health: bot.health,
      internalValues: bot.internalValues,
      bot,
    });
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((a, b) => {
    const distanceDiff = Math.hypot(attacker.x - a.x, attacker.y - a.y) - Math.hypot(attacker.x - b.x, attacker.y - b.y);
    if (Math.abs(distanceDiff) > 0.5) {
      return distanceDiff;
    }
    const healthDiff = a.health - b.health;
    if (healthDiff !== 0) {
      return healthDiff;
    }
    return a.slot - b.slot;
  });
  return candidates[0];
}

function clearLegacySoloCombatBotState(session: ClientSession): void {
  session.botHealth = undefined;
  session.combatBotArmorValues = undefined;
  session.combatBotInternalValues = undefined;
  session.combatBotHeadArmor = undefined;
  session.combatBotCriticalStateBytes = undefined;
  session.combatBotX = undefined;
  session.combatBotY = undefined;
  session.combatBotZ = undefined;
  session.combatBotFacing = undefined;
  session.combatBotSpeedMag = undefined;
  session.combatBotLastMoveAt = undefined;
  session.combatBotLastAimLimitLogAt = undefined;
  session.combatBotMoveVectorX = undefined;
  session.combatBotMoveVectorY = undefined;
  session.combatBotWeaponReadyAtBySlot = undefined;
  session.combatBotAmmoStateValues = undefined;
  session.combatBotHeat = undefined;
  session.combatBotJumpActive = undefined;
  session.combatBotJumpFuel = undefined;
  session.combatBotJumpStartedAt = undefined;
  session.combatBotJumpDurationMs = undefined;
  session.combatBotJumpStartFuel = undefined;
  session.combatBotJumpApexUnits = undefined;
  session.combatBotJumpStartX = undefined;
  session.combatBotJumpStartY = undefined;
  session.combatBotJumpTargetX = undefined;
  session.combatBotJumpTargetY = undefined;
  session.combatBotLastJumpAt = undefined;
}

function syncLegacySoloCombatBotState(session: ClientSession): void {
  const bots = getSoloCombatBots(session);
  if (bots.length === 0) {
    clearLegacySoloCombatBotState(session);
    return;
  }

  const primaryBot = bots[0];
  session.botHealth = bots.reduce((sum, bot) => sum + Math.max(0, bot.health), 0);
  session.combatBotArmorValues = [...primaryBot.armorValues];
  session.combatBotInternalValues = [...primaryBot.internalValues];
  session.combatBotHeadArmor = primaryBot.headArmor;
  session.combatBotCriticalStateBytes = [...primaryBot.criticalStateBytes];
  session.combatBotX = primaryBot.x;
  session.combatBotY = primaryBot.y;
  session.combatBotZ = primaryBot.z;
  session.combatBotFacing = primaryBot.facing;
  session.combatBotSpeedMag = primaryBot.speedMag;
  session.combatBotLastMoveAt = primaryBot.lastMoveAt;
  session.combatBotLastAimLimitLogAt = primaryBot.lastAimLimitLogAt;
  session.combatBotMoveVectorX = primaryBot.moveVectorX;
  session.combatBotMoveVectorY = primaryBot.moveVectorY;
  session.combatBotWeaponReadyAtBySlot = [...primaryBot.weaponReadyAtBySlot];
  session.combatBotAmmoStateValues = [...primaryBot.ammoStateValues];
  session.combatBotHeat = primaryBot.heat;
  session.combatBotJumpActive = primaryBot.jumpActive;
  session.combatBotJumpFuel = primaryBot.jumpFuel;
  session.combatBotJumpStartedAt = primaryBot.jumpStartedAt;
  session.combatBotJumpDurationMs = primaryBot.jumpDurationMs;
  session.combatBotJumpStartFuel = primaryBot.jumpStartFuel;
  session.combatBotJumpApexUnits = primaryBot.jumpApexUnits;
  session.combatBotJumpStartX = primaryBot.jumpStartX;
  session.combatBotJumpStartY = primaryBot.jumpStartY;
  session.combatBotJumpTargetX = primaryBot.jumpTargetX;
  session.combatBotJumpTargetY = primaryBot.jumpTargetY;
  session.combatBotLastJumpAt = primaryBot.lastJumpAt;
}

function clearSoloCombatBotDeathTimers(session: ClientSession): void {
  for (const bot of getSoloCombatBots(session)) {
    if (bot.deathTimer !== undefined) {
      clearTimeout(bot.deathTimer);
      bot.deathTimer = undefined;
    }
  }
}

function createSoloCombatBotActor(
  session: ClientSession,
  slot: number,
  mechId: number,
  side: number,
  spawnX: number,
  spawnY: number,
): SoloCombatBotActorState {
  const mechEntry = WORLD_MECH_BY_ID.get(mechId);
  const armorValues = [...(mechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
  const internalValues = mechEntry !== undefined
    ? mechInternalStateBytes(mechEntry.tonnage)
    : [...DEFAULT_BOT_INTERNAL_VALUES];
  const headArmor = HEAD_ARMOR_VALUE;
  const playerX = session.combatX ?? 0;
  const playerY = session.combatY ?? 0;
  const playerSide = getConfiguredSoloCombatPlayerSide(session);
  const initialFacingTargetY = side === playerSide
    ? playerY + BOT_AI_SPAWN_DISTANCE
    : playerY;
  return {
    slot,
    mechId,
    side,
    health: getCombatDurability(armorValues, internalValues) + headArmor,
    armorValues,
    internalValues,
    criticalStateBytes: createCriticalStateBytes(mechEntry?.extraCritCount),
    headArmor,
    x: spawnX,
    y: spawnY,
    z: 0,
    facing: getBotFacingAccumulatorTowardTarget(
      spawnX,
      spawnY,
      playerX,
      initialFacingTargetY,
      FACING_ACCUMULATOR_NEUTRAL,
    ),
    speedMag: 0,
    moveVectorX: 0,
    moveVectorY: 0,
    weaponReadyAtBySlot: [],
    ammoStateValues: getInitialCombatAmmoStateValues(mechEntry?.ammoBinTypeIds),
    heat: 0,
    jumpActive: false,
    jumpFuel: JUMP_JET_FUEL_MAX,
  };
}

function sendBotPositionSync(
  session: ClientSession,
  bot: SoloCombatBotActorState,
  capture: CaptureLogger,
  label: string,
  target?: SoloCombatBotTargetState,
): void {
  if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') {
    return;
  }
  const { throttle, legVel } = getBotCmd65UpperBodyChannels(session, bot, target);
  send(
    session.socket,
    buildCmd65PositionSyncPacket(
      {
        slot: bot.slot,
        x: bot.x,
        y: bot.y,
        z: bot.z,
        facing: bot.facing,
        throttle,
        legVel,
        speedMag: bot.speedMag,
      },
      nextSeq(session),
    ),
    capture,
    label,
  );
}

function normalizeFacingAccumulator(value: number): number {
  const turn = 0x10000;
  const normalized = value % turn;
  return normalized < 0 ? normalized + turn : normalized;
}

const BOT_VISUAL_FACING_OFFSET = 0x8000;
// Ghidra evidence: FUN_0040d270 / FUN_0040d2d0 clamp DAT_004f1f7a / DAT_004f1f7c
// to +/-0x1ffe, and FUN_00446e40 draws DAT_004f1d5c (chassis) plus DAT_004f1f7a
// (torso yaw) separately on the heading tape. The client converts those values
// to tenths of a degree via value * 10 / 0xb6, so +/-0x1ffe is effectively
// about +/-45 deg
// torso twist / bend window.
const BOT_TORSO_AIM_LIMIT_UNITS = 0x1ffe;
const BOT_FORWARD_ALIGNMENT_LIMIT_UNITS = 0x1000;
const BOT_AI_AIM_LIMIT_LOG_COOLDOWN_MS = 1000;
// Ghidra evidence: FUN_00422aa0 drives chassis turning through FUN_0040d050 using
// a full-input scalar of 0x11c6 units per 100ms.
const BOT_CLIENT_TURN_RATE_UNITS_PER_100MS = 0x11c6;

function getBotFacingAccumulatorTowardTarget(
  botX: number,
  botY: number,
  targetX: number,
  targetY: number,
  fallback: number,
): number {
  const dx = targetX - botX;
  const dy = targetY - botY;
  if (dx === 0 && dy === 0) {
    return fallback;
  }
  const southFacingRadians = -Math.PI / 2;
  const deltaRadians = Math.atan2(dy, dx) - southFacingRadians;
  const deltaUnits = Math.round(deltaRadians * (0x10000 / (Math.PI * 2)));
  // Live single-player validation shows the visually correct remote slot-1 bot
  // heading is 180 degrees offset from the raw target vector mapping.
  return normalizeFacingAccumulator(FACING_ACCUMULATOR_NEUTRAL + deltaUnits + BOT_VISUAL_FACING_OFFSET);
}

function getSignedFacingAccumulatorDelta(current: number, target: number): number {
  let delta = normalizeFacingAccumulator(target) - normalizeFacingAccumulator(current);
  if (delta > 0x8000) {
    delta -= 0x10000;
  } else if (delta < -0x8000) {
    delta += 0x10000;
  }
  return delta;
}

function stepFacingAccumulatorToward(current: number, target: number, maxStep: number): number {
  const delta = getSignedFacingAccumulatorDelta(current, target);
  if (Math.abs(delta) <= maxStep) {
    return normalizeFacingAccumulator(target);
  }
  return normalizeFacingAccumulator(current + (Math.sign(delta) * maxStep));
}

function getBotMovementFacingAccumulator(botFacing: number): number {
  return normalizeFacingAccumulator(botFacing - BOT_VISUAL_FACING_OFFSET);
}

function getBotForwardUnitVector(botFacing: number): { x: number; y: number } {
  const movementRadians = facingAccumulatorToRadians(getBotMovementFacingAccumulator(botFacing));
  return {
    x: Math.cos(movementRadians),
    y: Math.sin(movementRadians),
  };
}

function getBotAimDeltaToTarget(
  botX: number,
  botY: number,
  targetX: number,
  targetY: number,
  botFacing: number,
): number {
  const targetFacing = getBotFacingAccumulatorTowardTarget(botX, botY, targetX, targetY, botFacing);
  return getSignedFacingAccumulatorDelta(botFacing, targetFacing);
}

function getBotPitchToTargetRaw(
  botX: number,
  botY: number,
  botZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
): number {
  const horizontalDistance = Math.hypot(targetX - botX, targetY - botY);
  const pitchDegrees = Math.atan2(targetZ - botZ, horizontalDistance) * (180 / Math.PI);
  return Math.round(pitchDegrees * MOTION_DIV);
}

function getBotPitchToTarget(
  botX: number,
  botY: number,
  botZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
): number {
  return clampNumber(
    getBotPitchToTargetRaw(botX, botY, botZ, targetX, targetY, targetZ),
    -BOT_TORSO_AIM_LIMIT_UNITS,
    BOT_TORSO_AIM_LIMIT_UNITS,
  );
}

function getBotCmd65UpperBodyChannels(
  session: ClientSession,
  bot: SoloCombatBotActorState,
  preferredTarget?: SoloCombatBotTargetState,
): { throttle: number; legVel: number } {
  const botX = bot.x;
  const botY = bot.y;
  const botZ = bot.z;
  const target = preferredTarget ?? getPreferredSoloCombatTarget(session, bot);
  const targetX = target?.x ?? (session.combatX ?? 0);
  const targetY = target?.y ?? (session.combatY ?? 0);
  const targetZ = target?.z ?? (session.combatJumpAltitude ?? 0);
  const botFacing = bot.facing;
  const torsoYaw = clampNumber(
    getBotAimDeltaToTarget(
      botX,
      botY,
      targetX,
      targetY,
      botFacing,
    ),
    -BOT_TORSO_AIM_LIMIT_UNITS,
    BOT_TORSO_AIM_LIMIT_UNITS,
  );
  return {
    throttle: getBotPitchToTarget(botX, botY, botZ, targetX, targetY, targetZ),
    legVel: torsoYaw,
  };
}

function maybeLogBotAimLimit(
  bot: SoloCombatBotActorState,
  connLog: Logger,
  botX: number,
  botY: number,
  botZ: number,
  targetX: number,
  targetY: number,
  targetZ: number,
  rawYaw: number,
  rawPitch: number,
): void {
  const now = Date.now();
  if (
    bot.lastAimLimitLogAt !== undefined
    && now - bot.lastAimLimitLogAt < BOT_AI_AIM_LIMIT_LOG_COOLDOWN_MS
  ) {
    return;
  }
  bot.lastAimLimitLogAt = now;
  connLog.debug(
    '[world/combat] bot fire gated by aim: slot=%d yaw=%d pitch=%d limit=%d bot=(%d,%d,%d) target=(%d,%d,%d)',
    bot.slot,
    rawYaw,
    rawPitch,
    BOT_TORSO_AIM_LIMIT_UNITS,
    botX,
    botY,
    botZ,
    targetX,
    targetY,
    targetZ,
  );
}

function getBotTurnStepUnits(elapsedMs: number): number {
  return Math.max(1, Math.round((BOT_CLIENT_TURN_RATE_UNITS_PER_100MS * elapsedMs) / 100));
}

function stepBotGroundedSpeedMagTowardTarget(
  currentSpeedMag: number,
  targetSpeedMag: number,
  speedCap: number,
  elapsedMs: number,
): number {
  const dtSeconds = Math.max(0, elapsedMs) / 1000;
  if (dtSeconds <= 0) {
    return currentSpeedMag;
  }

  let nextSpeedMag = currentSpeedMag;
  const groundedDragPercent = Math.min(100, COMBAT_GLOBAL_B + (COMBAT_GLOBAL_A / 100));
  if (nextSpeedMag !== 0) {
    const dragDelta = Math.abs(nextSpeedMag) * (groundedDragPercent / 100) * dtSeconds;
    nextSpeedMag = nextSpeedMag < 0
      ? Math.min(0, nextSpeedMag + dragDelta)
      : Math.max(0, nextSpeedMag - dragDelta);
  }

  if (targetSpeedMag !== 0 && speedCap > 0) {
    const throttlePercent = clampNumber((Math.abs(targetSpeedMag) / speedCap) * 100, 0, 100);
    const governorFactor = (100 - (throttlePercent / 5)) / 100;
    const accelPerSecond = (Math.abs(targetSpeedMag) * 980 / COMBAT_GLOBAL_A) * governorFactor;
    nextSpeedMag += Math.sign(targetSpeedMag) * accelPerSecond * dtSeconds;
    if (Math.sign(nextSpeedMag) === Math.sign(targetSpeedMag) && Math.abs(nextSpeedMag) > Math.abs(targetSpeedMag)) {
      nextSpeedMag = targetSpeedMag;
    }
  } else if (Math.abs(nextSpeedMag) < 1) {
    nextSpeedMag = 0;
  }

  const clampedMagnitude = speedCap > 0
    ? Math.min(Math.abs(nextSpeedMag), speedCap)
    : 0;
  if (clampedMagnitude < 1) {
    return 0;
  }
  return Math.round(Math.sign(nextSpeedMag) * clampedMagnitude);
}

function getWeaponRangeProfileForMech(
  mechId: number | undefined,
  internalValues: readonly number[] | undefined,
): {
  shortestRangeMeters: number;
  longestRangeMeters: number;
  preferredRangeMeters: number;
  hasUsableWeapon: boolean;
} {
  const mechEntry = getMechEntryForId(mechId);
  if (!mechEntry) {
    return {
      shortestRangeMeters: BOT_AI_MIN_PREFERRED_RANGE_METERS,
      longestRangeMeters: BOT_AI_MIN_PREFERRED_RANGE_METERS,
      preferredRangeMeters: 180,
      hasUsableWeapon: false,
    };
  }

  let shortestRangeMeters = Number.POSITIVE_INFINITY;
  let longestRangeMeters = 0;
  let hasUsableWeapon = false;
  for (let weaponSlot = 0; weaponSlot < mechEntry.weaponTypeIds.length; weaponSlot += 1) {
    const mountGate = getWeaponMountGateForMech(mechId, internalValues, weaponSlot);
    if (!mountGate.allowed) continue;
    const maxRangeMeters = getWeaponLongRangeMeters(getWeaponSpecForMechSlot(mechId, weaponSlot)) ?? 0;
    if (maxRangeMeters <= 0) continue;
    hasUsableWeapon = true;
    shortestRangeMeters = Math.min(shortestRangeMeters, maxRangeMeters);
    longestRangeMeters = Math.max(longestRangeMeters, maxRangeMeters);
  }

  if (!Number.isFinite(shortestRangeMeters)) {
    shortestRangeMeters = BOT_AI_MIN_PREFERRED_RANGE_METERS;
  }
  if (longestRangeMeters <= 0) {
    longestRangeMeters = BOT_AI_MIN_PREFERRED_RANGE_METERS;
  }

  return {
    shortestRangeMeters,
    longestRangeMeters,
    preferredRangeMeters: Math.max(
      BOT_AI_MIN_PREFERRED_RANGE_METERS,
      Math.min(
        BOT_AI_MAX_PREFERRED_RANGE_METERS,
        Math.round(longestRangeMeters * 0.75),
      ),
    ),
    hasUsableWeapon,
  };
}

function isBotWeaponUsableForRangePlanning(bot: SoloCombatBotActorState, weaponSlot: number): boolean {
  return peekBotWeaponAmmo(bot, weaponSlot).allowed;
}

function getBotWeaponRangeProfile(bot: SoloCombatBotActorState): {
  shortestRangeMeters: number;
  longestRangeMeters: number;
  preferredRangeMeters: number;
  hasUsableWeapon: boolean;
} {
  const botMechId = bot.mechId;
  const mechEntry = getMechEntryForId(botMechId);
  if (!mechEntry) {
    return {
      shortestRangeMeters: BOT_AI_MIN_PREFERRED_RANGE_METERS,
      longestRangeMeters: BOT_AI_MIN_PREFERRED_RANGE_METERS,
      preferredRangeMeters: 180,
      hasUsableWeapon: false,
    };
  }

  let shortestRangeMeters = Number.POSITIVE_INFINITY;
  let longestRangeMeters = 0;
  let hasUsableWeapon = false;
  for (let weaponSlot = 0; weaponSlot < mechEntry.weaponTypeIds.length; weaponSlot += 1) {
    const mountGate = getWeaponMountGateForMech(botMechId, bot.internalValues, weaponSlot);
    if (!mountGate.allowed || !isBotWeaponUsableForRangePlanning(bot, weaponSlot)) continue;
    const maxRangeMeters = getWeaponLongRangeMeters(getWeaponSpecForMechSlot(botMechId, weaponSlot)) ?? 0;
    if (maxRangeMeters <= 0) continue;
    hasUsableWeapon = true;
    shortestRangeMeters = Math.min(shortestRangeMeters, maxRangeMeters);
    longestRangeMeters = Math.max(longestRangeMeters, maxRangeMeters);
  }

  if (!Number.isFinite(shortestRangeMeters)) {
    shortestRangeMeters = BOT_AI_MIN_PREFERRED_RANGE_METERS;
  }
  if (longestRangeMeters <= 0) {
    longestRangeMeters = BOT_AI_MIN_PREFERRED_RANGE_METERS;
  }

  return {
    shortestRangeMeters,
    longestRangeMeters,
    preferredRangeMeters: Math.max(
      BOT_AI_MIN_PREFERRED_RANGE_METERS,
      Math.min(
        BOT_AI_MAX_PREFERRED_RANGE_METERS,
        Math.round(longestRangeMeters * 0.75),
      ),
    ),
    hasUsableWeapon,
  };
}

function getBotPreferredRangeMeters(bot: SoloCombatBotActorState): number {
  return getBotWeaponRangeProfile(bot).preferredRangeMeters;
}

function getWeaponFitScoreForMechAtDistance(
  mechId: number | undefined,
  internalValues: readonly number[] | undefined,
  distanceMeters: number,
  isWeaponUsable?: (weaponSlot: number) => boolean,
): number {
  const mechEntry = getMechEntryForId(mechId);
  if (!mechEntry) {
    return 0;
  }

  let score = 0;
  for (let weaponSlot = 0; weaponSlot < mechEntry.weaponTypeIds.length; weaponSlot += 1) {
    const mountGate = getWeaponMountGateForMech(mechId, internalValues, weaponSlot);
    if (!mountGate.allowed || (isWeaponUsable !== undefined && !isWeaponUsable(weaponSlot))) continue;
    const weaponSpec = getWeaponSpecForMechSlot(mechId, weaponSlot);
    const maxRangeMeters = getWeaponLongRangeMeters(weaponSpec);
    if (maxRangeMeters === undefined || maxRangeMeters <= 0 || distanceMeters > maxRangeMeters) {
      continue;
    }
    const rangeBand = getCombatRangeBandForDistance(weaponSpec, distanceMeters, maxRangeMeters);
    const bandWeight = rangeBand === 'short'
      ? BOT_AI_RANGE_FIT_SHORT_WEIGHT
      : rangeBand === 'medium'
        ? BOT_AI_RANGE_FIT_MEDIUM_WEIGHT
        : BOT_AI_RANGE_FIT_LONG_WEIGHT;
    score += (weaponSpec?.damage ?? BOT_FALLBACK_WEAPON_DAMAGE) * bandWeight;
  }
  return score;
}

function isMeaningfulJumpFitGain(currentScore: number, landingScore: number): boolean {
  return landingScore > currentScore
    && (
      currentScore <= 0
      || landingScore >= currentScore + BOT_AI_JUMP_RANGE_FIT_GAIN_THRESHOLD
    );
}

function getSectionRemainingDurability(
  armorValues: readonly number[],
  internalValues: readonly number[],
  headArmor: number,
  section: CombatAttachmentHitSection,
): number {
  const armorRemaining = section.armorIndex >= 0
    ? (armorValues[section.armorIndex] ?? 0)
    : section.internalIndex === 7 ? headArmor : 0;
  const internalRemaining = internalValues[section.internalIndex] ?? 0;
  return Math.max(0, armorRemaining) + Math.max(0, internalRemaining);
}

function chooseWeakestSurvivingSection(
  armorValues: readonly number[],
  internalValues: readonly number[],
  headArmor: number,
  sections: readonly CombatAttachmentHitSection[],
): CombatAttachmentHitSection | undefined {
  let weakest: CombatAttachmentHitSection | undefined;
  let weakestDurability = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    const durability = getSectionRemainingDurability(armorValues, internalValues, headArmor, section);
    if (durability <= 0 || durability >= weakestDurability) continue;
    weakest = section;
    weakestDurability = durability;
  }
  return weakest;
}

function chooseBotAttackSection(
  bot: SoloCombatBotActorState,
  weaponSlot: number,
  armorValues: readonly number[],
  internalValues: readonly number[],
  headArmor: number,
  distanceMeters: number,
  targetHealth: number,
): CombatAttachmentHitSection {
  const botMechId = bot.mechId;
  const weaponSpec = getWeaponSpecForMechSlot(botMechId, weaponSlot);
  const weaponDamage = weaponSpec?.damage ?? BOT_FALLBACK_WEAPON_DAMAGE;
  const weaponRangeMeters = getWeaponLongRangeMeters(weaponSpec) ?? getBotPreferredRangeMeters(bot);
  const botBehindOnDurability = bot.health < targetHealth;

  const headRemaining = getSectionRemainingDurability(
    armorValues,
    internalValues,
    headArmor,
    HEAD_RETALIATION_SECTION,
  );
  if (
    headRemaining > 0
    && headArmor <= 2
    && headRemaining <= weaponDamage + 1
  ) {
    return HEAD_RETALIATION_SECTION;
  }

  const centerTorsoRemaining = getSectionRemainingDurability(
    armorValues,
    internalValues,
    headArmor,
    CENTER_TORSO_FRONT_RETALIATION_SECTION,
  );
  if (
    centerTorsoRemaining > 0
    && (
      (armorValues[CENTER_TORSO_FRONT_RETALIATION_SECTION.armorIndex] ?? 0) <= weaponDamage
      || (internalValues[CENTER_TORSO_FRONT_RETALIATION_SECTION.internalIndex] ?? 0) <= weaponDamage * 2
      || (!botBehindOnDurability && distanceMeters <= BOT_AI_MIN_PREFERRED_RANGE_METERS)
    )
  ) {
    return CENTER_TORSO_FRONT_RETALIATION_SECTION;
  }

  const weakestLeg = chooseWeakestSurvivingSection(
    armorValues,
    internalValues,
    headArmor,
    BOT_TACTICAL_LEG_SECTIONS,
  );
  if (
    weakestLeg
    && (
      weaponRangeMeters <= 270
      || distanceMeters <= BOT_AI_MIN_PREFERRED_RANGE_METERS + BOT_AI_RANGE_BUFFER_METERS
      || botBehindOnDurability
    )
  ) {
    const weakestLegDurability = getSectionRemainingDurability(armorValues, internalValues, headArmor, weakestLeg);
    if (
      weakestLegDurability <= weaponDamage * 3
      || botBehindOnDurability
      || bot.jumpActive
    ) {
      return weakestLeg;
    }
  }

  const weakestTorso = chooseWeakestSurvivingSection(
    armorValues,
    internalValues,
    headArmor,
    BOT_TACTICAL_TORSO_SECTIONS,
  );
  if (weakestTorso) {
    return weakestTorso;
  }

  const weakestArm = chooseWeakestSurvivingSection(
    armorValues,
    internalValues,
    headArmor,
    BOT_TACTICAL_ARM_SECTIONS,
  );
  if (weakestArm) {
    return weakestArm;
  }

  return chooseRetaliationHitSection(bot, armorValues, internalValues, headArmor);
}

function getBotJumpTravelUnits(bot: SoloCombatBotActorState): number {
  const { apexUnits } = getJumpArcForMechId(bot.mechId);
  return Math.max(24 * COMBAT_WORLD_UNITS_PER_METER, apexUnits * 2);
}

function startBotJump(
  session: ClientSession,
  bot: SoloCombatBotActorState,
  connLog: Logger,
  capture: CaptureLogger,
  landingX: number,
  landingY: number,
  reason: string,
): boolean {
  const botMechId = bot.mechId;
  const now = Date.now();
  const fuel = bot.jumpFuel;
  const currentBotX = bot.x;
  const currentBotY = bot.y;

  if (!mechSupportsJumpJets(botMechId)) return false;
  if (bot.jumpActive) return false;
  if (fuel <= JUMP_JET_START_FUEL_THRESHOLD) return false;
  if (
    bot.lastJumpAt !== undefined
    && now - bot.lastJumpAt < BOT_AI_JUMP_COOLDOWN_MS
  ) {
    return false;
  }
  if (landingX === currentBotX && landingY === currentBotY) {
    return false;
  }

  const jumpArc = getJumpArcForMechId(botMechId);
  bot.jumpActive = true;
  bot.jumpStartedAt = now;
  bot.jumpDurationMs = getJumpMirrorDurationMsForMechId(botMechId);
  bot.jumpStartFuel = fuel;
  bot.jumpFuel = fuel;
  bot.jumpApexUnits = jumpArc.apexUnits;
  bot.jumpStartX = currentBotX;
  bot.jumpStartY = currentBotY;
  bot.jumpTargetX = landingX;
  bot.jumpTargetY = landingY;
  bot.lastJumpAt = now;
  bot.z = 0;
  bot.speedMag = 0;
  setBotMoveVector(bot, 0, 0);
  const combatTarget = getPreferredSoloCombatTarget(session, bot);
  if (combatTarget) {
    bot.facing = getBotFacingAccumulatorTowardTarget(
      currentBotX,
      currentBotY,
      combatTarget.x,
      combatTarget.y,
      bot.facing,
    );
  }
  connLog.info(
    '[world/combat] bot jump start: slot=%d mechId=%d fuel=%d from=(%d,%d) to=(%d,%d) apex=%d reason=%s',
    bot.slot,
    botMechId,
    fuel,
    currentBotX,
    currentBotY,
    landingX,
    landingY,
    jumpArc.apexUnits,
    reason,
  );
  sendBotPositionSync(session, bot, capture, 'CMD65_BOT_JUMP_START', combatTarget);
  return true;
}

function advanceBotJump(
  session: ClientSession,
  bot: SoloCombatBotActorState,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  if (!bot.jumpActive) {
    return false;
  }

  const startedAt = bot.jumpStartedAt ?? Date.now();
  const durationMs = Math.max(1, bot.jumpDurationMs ?? getJumpMirrorDurationMsForMechId(bot.mechId));
  const startX = bot.jumpStartX ?? bot.x;
  const startY = bot.jumpStartY ?? bot.y;
  const targetX = bot.jumpTargetX ?? startX;
  const targetY = bot.jumpTargetY ?? startY;
  const apexUnits = bot.jumpApexUnits ?? getJumpArcForMechId(bot.mechId).apexUnits;
  const startedFuel = bot.jumpStartFuel ?? bot.jumpFuel;
  const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
  const previousBotX = bot.x;
  const previousBotY = bot.y;

  bot.x = Math.round(startX + ((targetX - startX) * progress));
  bot.y = Math.round(startY + ((targetY - startY) * progress));
  setBotMoveVector(
    bot,
    bot.x - previousBotX,
    bot.y - previousBotY,
  );
  bot.z = progress >= 1
    ? 0
    : Math.max(COMBAT_WORLD_UNITS_PER_METER, Math.round(apexUnits * 4 * progress * (1 - progress)));
  bot.speedMag = 0;
  const combatTarget = getPreferredSoloCombatTarget(session, bot);
  if (combatTarget) {
    bot.facing = getBotFacingAccumulatorTowardTarget(
      bot.x,
      bot.y,
      combatTarget.x,
      combatTarget.y,
      bot.facing,
    );
  }
  bot.jumpFuel = Math.max(0, Math.round(startedFuel * (1 - progress)));

  if (progress >= 1) {
    bot.jumpActive = false;
    bot.jumpStartedAt = undefined;
    bot.jumpDurationMs = undefined;
    bot.jumpStartFuel = undefined;
    bot.jumpApexUnits = undefined;
    bot.jumpStartX = undefined;
    bot.jumpStartY = undefined;
    bot.jumpTargetX = undefined;
    bot.jumpTargetY = undefined;
    sendBotPositionSync(session, bot, capture, 'CMD65_BOT_JUMP_LAND', combatTarget);
    connLog.info(
      '[world/combat] bot jump land: slot=%d mechId=%d fuel=%d at=(%d,%d)',
      bot.slot,
      bot.mechId,
      bot.jumpFuel,
      bot.x,
      bot.y,
    );
    return true;
  }

  sendBotPositionSync(session, bot, capture, 'CMD65_BOT_JUMP_MIRROR', combatTarget);
  return true;
}

function stepBotMovement(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const activeBots = getActiveSoloCombatBots(session);
  if (activeBots.length === 0) {
    syncLegacySoloCombatBotState(session);
    return;
  }

  for (const bot of activeBots) {
    const difficultyProfile = getConfiguredBotDifficultyProfile(session);
    const now = Date.now();
    const elapsedMs = clampNumber(
      now - (bot.lastMoveAt ?? (now - BOT_AI_TICK_MS)),
      1,
      BOT_AI_TICK_MS * 4,
    );
    bot.lastMoveAt = now;
    const botMechEntry = getMechEntryForId(bot.mechId);
    coolBotHeat(bot, Math.max(1, botMechEntry?.heatSinks ?? 10));
    const fuelRegenAmount = Math.max(
      1,
      Math.round(JUMP_JET_FUEL_REGEN_PER_TICK * elapsedMs / JUMP_JET_FUEL_REGEN_INTERVAL_MS),
    );
    regenBotJumpFuelIfGrounded(bot, fuelRegenAmount);
    if (advanceBotJump(session, bot, connLog, capture)) {
      continue;
    }

    const target = getPreferredSoloCombatTarget(session, bot);
    if (!target) {
      bot.speedMag = stepBotGroundedSpeedMagTowardTarget(bot.speedMag, 0, Math.max(1, Math.abs(bot.speedMag)), elapsedMs);
      setBotMoveVector(bot, 0, 0);
      sendBotPositionSync(session, bot, capture, 'CMD65_BOT_AI_IDLE');
      continue;
    }

    const targetX = target.x;
    const targetY = target.y;
    const currentBotX = bot.x;
    const currentBotY = bot.y;
    const dx = targetX - currentBotX;
    const dy = targetY - currentBotY;
    const distanceUnits = Math.hypot(dx, dy);
    const distanceMeters = getCombatDisplayDistanceMeters(currentBotX, currentBotY, targetX, targetY);
    const rangeProfile = getBotWeaponRangeProfile(bot);
    const currentRangeFitScore = getWeaponFitScoreForMechAtDistance(
      bot.mechId,
      bot.internalValues,
      distanceMeters,
      weaponSlot => isBotWeaponUsableForRangePlanning(bot, weaponSlot),
    );
    const rangeBufferUnits = BOT_AI_RANGE_BUFFER_METERS * COMBAT_WORLD_UNITS_PER_METER;
    const targetRangeProfile = getWeaponRangeProfileForMech(
      target.mechId,
      target.internalValues,
    );
    const botHealth = bot.health;
    const targetHealth = target.health;
    const durabilityDelta = botHealth - targetHealth;
    const targetThreatRangeUnits = (targetRangeProfile.hasUsableWeapon ? targetRangeProfile.longestRangeMeters : 0)
      * COMBAT_WORLD_UNITS_PER_METER;
    const maxSpeedMag = botMechEntry?.maxSpeedMag ?? 0;
    const walkSpeedMag = botMechEntry?.walkSpeedMag ?? maxSpeedMag;
    const botBehindOnDurability = durabilityDelta < -8;
    const botAheadOnDurability = durabilityDelta > 12;
    let tacticalPreferredRangeMeters = rangeProfile.preferredRangeMeters;
    if (targetRangeProfile.hasUsableWeapon) {
      if (rangeProfile.longestRangeMeters >= targetRangeProfile.longestRangeMeters + 120) {
        tacticalPreferredRangeMeters += BOT_AI_RANGE_ADVANTAGE_BONUS_METERS;
      } else if (
        rangeProfile.shortestRangeMeters <= 270
        && rangeProfile.longestRangeMeters + 60 < targetRangeProfile.longestRangeMeters
      ) {
        tacticalPreferredRangeMeters -= difficultyProfile.rangePressureBonusMeters;
      }
    }
    if (targetHealth <= difficultyProfile.finisherPushHealthThreshold && rangeProfile.shortestRangeMeters <= 270) {
      tacticalPreferredRangeMeters -= difficultyProfile.rangePressureBonusMeters;
    } else if (botBehindOnDurability && rangeProfile.longestRangeMeters >= 450) {
      tacticalPreferredRangeMeters += BOT_AI_RANGE_ADVANTAGE_BONUS_METERS;
    } else if (botAheadOnDurability && rangeProfile.shortestRangeMeters <= 270) {
      tacticalPreferredRangeMeters -= difficultyProfile.rangePressureBonusMeters;
    }
    tacticalPreferredRangeMeters = clampNumber(
      tacticalPreferredRangeMeters,
      BOT_AI_MIN_PREFERRED_RANGE_METERS,
      BOT_AI_MAX_PREFERRED_RANGE_METERS,
    );
    const preferredRangeUnits = tacticalPreferredRangeMeters * COMBAT_WORLD_UNITS_PER_METER;
    const minimumRetreatUnits = Math.max(
      BOT_AI_MIN_PREFERRED_RANGE_METERS * COMBAT_WORLD_UNITS_PER_METER,
      preferredRangeUnits - (rangeBufferUnits * 2),
    );
    const jumpTravelUnits = getBotJumpTravelUnits(bot);
    const canConsiderJump = mechSupportsJumpJets(bot.mechId) && distanceUnits > 0;
    const insideTargetThreatRange = targetThreatRangeUnits > 0
      && distanceUnits <= targetThreatRangeUnits + (BOT_AI_PLAYER_THREAT_BUFFER_METERS * COMBAT_WORLD_UNITS_PER_METER);
    const currentFacing = bot.facing;
    const desiredFacing = getBotFacingAccumulatorTowardTarget(
      currentBotX,
      currentBotY,
      targetX,
      targetY,
      currentFacing,
    );

    if (
      canConsiderJump
      && distanceUnits < minimumRetreatUnits
      && (botBehindOnDurability || rangeProfile.longestRangeMeters >= 450)
    ) {
      const retreatUnits = Math.min(
        jumpTravelUnits,
        Math.max(rangeBufferUnits * 2, Math.round(preferredRangeUnits - distanceUnits + rangeBufferUnits)),
      );
      const landingX = currentBotX - Math.round((dx / distanceUnits) * retreatUnits);
      const landingY = currentBotY - Math.round((dy / distanceUnits) * retreatUnits);
      const landingRangeFitScore = getWeaponFitScoreForMechAtDistance(
        bot.mechId,
        bot.internalValues,
        (distanceUnits + retreatUnits) / COMBAT_WORLD_UNITS_PER_METER,
        weaponSlot => isBotWeaponUsableForRangePlanning(bot, weaponSlot),
      );
      if (
        isMeaningfulJumpFitGain(currentRangeFitScore, landingRangeFitScore)
        && startBotJump(session, bot, connLog, capture, landingX, landingY, 'defensive range reset')
      ) {
        continue;
      }
    }

    if (
      canConsiderJump
      && distanceUnits > preferredRangeUnits + (rangeBufferUnits * 3)
      && rangeProfile.shortestRangeMeters <= 270
    ) {
      const advanceUnits = Math.min(
        jumpTravelUnits,
        Math.max(rangeBufferUnits * 2, Math.round(distanceUnits - preferredRangeUnits)),
      );
      const landingX = currentBotX + Math.round((dx / distanceUnits) * advanceUnits);
      const landingY = currentBotY + Math.round((dy / distanceUnits) * advanceUnits);
      const landingRangeFitScore = getWeaponFitScoreForMechAtDistance(
        bot.mechId,
        bot.internalValues,
        Math.max(0, (distanceUnits - advanceUnits) / COMBAT_WORLD_UNITS_PER_METER),
        weaponSlot => isBotWeaponUsableForRangePlanning(bot, weaponSlot),
      );
      if (
        isMeaningfulJumpFitGain(currentRangeFitScore, landingRangeFitScore)
        && startBotJump(session, bot, connLog, capture, landingX, landingY, 'aggressive range close')
      ) {
        continue;
      }
    }

    let nextBotX = currentBotX;
    let nextBotY = currentBotY;
    const currentSpeedMag = bot.speedMag;
    let nextSpeedMag = currentSpeedMag;
    let moveVectorX = 0;
    let moveVectorY = 0;
    let desiredMotion: -1 | 0 | 1 = 0;
    let speedScale = 0;

    if (distanceUnits > preferredRangeUnits + rangeBufferUnits) {
      desiredMotion = 1;
      speedScale = 1;
    } else if (distanceUnits < minimumRetreatUnits) {
      desiredMotion = -1;
      speedScale = insideTargetThreatRange ? 1 : 0.8;
    } else if (insideTargetThreatRange) {
      if (botBehindOnDurability || rangeProfile.longestRangeMeters >= targetRangeProfile.longestRangeMeters + 90) {
        desiredMotion = -1;
        speedScale = botBehindOnDurability ? 1 : 0.85;
      } else if (
        targetHealth <= difficultyProfile.finisherPushHealthThreshold
        && rangeProfile.shortestRangeMeters <= 270
      ) {
        desiredMotion = 1;
        speedScale = 0.8;
      } else if (rangeProfile.shortestRangeMeters <= 270) {
        desiredMotion = 1;
        speedScale = 0.55;
      } else if (!botAheadOnDurability) {
        desiredMotion = -1;
        speedScale = 0.45;
      }
    } else if (distanceUnits > 0 && rangeProfile.shortestRangeMeters <= 270) {
      desiredMotion = 1;
      speedScale = 0.45;
    }

    let nextFacing = stepFacingAccumulatorToward(
      currentFacing,
      desiredFacing,
      getBotTurnStepUnits(elapsedMs),
    );
    const remainingAimDelta = getBotAimDeltaToTarget(currentBotX, currentBotY, targetX, targetY, nextFacing);
    const canAdvanceOnHeading = Math.abs(remainingAimDelta) <= BOT_FORWARD_ALIGNMENT_LIMIT_UNITS;
    const canReverseOnHeading = Math.abs(remainingAimDelta) <= BOT_TORSO_AIM_LIMIT_UNITS;
    if (
      (desiredMotion > 0 && !canAdvanceOnHeading)
      || (desiredMotion < 0 && !canReverseOnHeading)
    ) {
      desiredMotion = 0;
      speedScale = 0;
      nextFacing = stepFacingAccumulatorToward(currentFacing, desiredFacing, getBotTurnStepUnits(elapsedMs));
    }

    let targetSpeedMag = 0;
    let movementSpeedCap = 0;
    let desiredRangeDelta = Number.POSITIVE_INFINITY;
    if (maxSpeedMag > 0 && desiredMotion !== 0 && speedScale > 0) {
      movementSpeedCap = desiredMotion < 0
        ? Math.max(1, Math.abs(walkSpeedMag))
        : Math.max(1, Math.abs(maxSpeedMag));
      targetSpeedMag = Math.max(
        COMBAT_WORLD_UNITS_PER_METER / 10,
        Math.round(movementSpeedCap * speedScale),
      ) * desiredMotion;
      desiredRangeDelta = desiredMotion > 0
        ? distanceUnits > preferredRangeUnits + rangeBufferUnits
          ? Math.max(COMBAT_WORLD_UNITS_PER_METER, Math.round(distanceUnits - preferredRangeUnits))
          : Number.POSITIVE_INFINITY
        : distanceUnits < minimumRetreatUnits
          ? Math.max(COMBAT_WORLD_UNITS_PER_METER, Math.round(preferredRangeUnits - distanceUnits))
          : Number.POSITIVE_INFINITY;
    }

    nextSpeedMag = stepBotGroundedSpeedMagTowardTarget(
      currentSpeedMag,
      targetSpeedMag,
      Math.max(Math.abs(targetSpeedMag), Math.abs(currentSpeedMag), movementSpeedCap),
      elapsedMs,
    );
    const averageSpeedMag = (currentSpeedMag + nextSpeedMag) / 2;
    if (nextFacing !== currentFacing || averageSpeedMag !== 0) {
      const requestedStepUnits = Math.abs(Math.round(
        signedSpeedMagToMetersPerSecond(averageSpeedMag)
        * (elapsedMs / 1000)
        * COMBAT_WORLD_UNITS_PER_METER,
      ));
      if (requestedStepUnits > 0) {
        const stepUnits = Math.min(
          requestedStepUnits,
          desiredRangeDelta,
        );
        const forwardUnit = getBotForwardUnitVector(nextFacing);
        const motionSign = averageSpeedMag < 0 ? -1 : 1;
        moveVectorX = Math.round(forwardUnit.x * stepUnits * motionSign);
        moveVectorY = Math.round(forwardUnit.y * stepUnits * motionSign);
        nextBotX += moveVectorX;
        nextBotY += moveVectorY;
      }
    }

    bot.x = nextBotX;
    bot.y = nextBotY;
    setBotMoveVector(bot, moveVectorX, moveVectorY);
    bot.z = 0;
    bot.facing = nextFacing;
    bot.speedMag = nextSpeedMag;
    sendBotPositionSync(session, bot, capture, 'CMD65_BOT_AI_POSITION', target);
  }

  syncLegacySoloCombatBotState(session);
}

function stepBotWeaponFire(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') {
    return;
  }
  if (session.combatResultCode !== undefined) {
    return;
  }
  const activeBots = getActiveSoloCombatBots(session);
  if (activeBots.length === 0) {
    syncLegacySoloCombatBotState(session);
    return;
  }
  const playerInternalValuesNow = session.combatPlayerInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES;
  if (isActorDestroyed(playerInternalValuesNow)) {
    syncLegacySoloCombatBotState(session);
    queueCombatResultTransition(
      players,
      session,
      connLog,
      capture,
      COMBAT_RESULT_LOSS,
      'player structurally destroyed',
      PLAYER_RESULT_DELAY_MS,
    );
    return;
  }

  const destroyedBotSlots = new Set<number>();
  for (const bot of activeBots) {
    const difficultyProfile = getConfiguredBotDifficultyProfile(session);
    const botMechId = bot.mechId;
    const botMechEntry = getMechEntryForId(botMechId);
    if (!botMechEntry || bot.health <= 0) {
      continue;
    }

    const target = getPreferredSoloCombatTarget(session, bot);
    if (!target) {
      continue;
    }

    const botX = bot.x;
    const botY = bot.y;
    const botZ = bot.z;
    const targetX = target.x;
    const targetY = target.y;
    const targetZ = target.z;
    const botFacing = bot.facing;
    const rawYaw = getBotAimDeltaToTarget(botX, botY, targetX, targetY, botFacing);
    const rawPitch = getBotPitchToTargetRaw(botX, botY, botZ, targetX, targetY, targetZ);
    if (Math.abs(rawYaw) > BOT_TORSO_AIM_LIMIT_UNITS || Math.abs(rawPitch) > BOT_TORSO_AIM_LIMIT_UNITS) {
      maybeLogBotAimLimit(bot, connLog, botX, botY, botZ, targetX, targetY, targetZ, rawYaw, rawPitch);
      continue;
    }
    const distanceMeters = getCombatDisplayDistanceMeters(botX, botY, targetX, targetY);
    const now = Date.now();
    const currentHeat = bot.heat;
    const heatSinks = Math.max(1, botMechEntry.heatSinks ?? getBotHeatSinkCount(bot));
    const availableShots: BotVolleyCandidateShot[] = [];

    for (let weaponSlot = 0; weaponSlot < botMechEntry.weaponTypeIds.length; weaponSlot += 1) {
      const mountGate = getWeaponMountGateForMech(botMechId, bot.internalValues, weaponSlot);
      if (!mountGate.allowed) continue;

      const weaponName = getWeaponNameForMechSlot(botMechId, weaponSlot);
      const weaponSpec = getWeaponSpecForMechSlot(botMechId, weaponSlot);
      const cooldownGate = getWeaponCooldownGateForState(
        bot.weaponReadyAtBySlot,
        weaponSlot,
        weaponName,
        weaponSpec?.cooldownMs,
        now,
      );
      if (!cooldownGate.allowed) continue;

      const rangeGate = getShotMaxRangeGateForMechSlot(
        botMechId,
        weaponSlot,
        botX,
        botY,
        targetX,
        targetY,
      );
      if (!rangeGate.allowed) continue;

      const ammoGate = peekBotWeaponAmmo(bot, weaponSlot);
      if (!ammoGate.allowed) continue;

      const toHitEstimate = estimateCombatToHit({
        attackerX: botX,
        attackerY: botY,
        attackerFacing: botFacing,
        attackerSpeedMag: bot.speedMag,
        attackerMaxSpeedMag: botMechEntry.maxSpeedMag,
        attackerAirborne: bot.jumpActive === true,
        targetX,
        targetY,
        targetFacing: target.facing,
        targetSpeedMag: target.speedMag,
        targetMaxSpeedMag: target.maxSpeedMag,
        targetAirborne: target.airborne,
        targetMoveVectorX: target.moveVectorX,
        targetMoveVectorY: target.moveVectorY,
        distanceMeters,
        weaponSpec,
        maxRangeMeters: rangeGate.maxRangeMeters,
      }, difficultyProfile);
      const damage = weaponSpec?.damage ?? BOT_FALLBACK_WEAPON_DAMAGE;
      const heat = weaponSpec?.heat ?? 0;
      const expectedDamage = damage * toHitEstimate.chance;

      availableShots.push({
        weaponSlot,
        damage,
        heat,
        weaponName,
        weaponSpec,
        cooldownMs: cooldownGate.cooldownMs,
        maxRangeMeters: rangeGate.maxRangeMeters,
        rangeBand: toHitEstimate.rangeBand,
        efficiency: damage / Math.max(1, heat),
        hitChance: toHitEstimate.chance,
        expectedDamage,
        expectedEfficiency: expectedDamage / Math.max(1, heat),
      });
    }

    if (availableShots.length === 0) {
      continue;
    }

    const presets = buildBotTicPresets(availableShots, currentHeat, heatSinks);
    const selectedPreset = chooseBotTicPreset(
      presets,
      distanceMeters,
      target.health,
      currentHeat,
      heatSinks,
      difficultyProfile,
    );
    if (!selectedPreset || selectedPreset.shots.length === 0) {
      continue;
    }

    const volley: BotVolleyCandidateShot[] = [];
    let firedHeat = 0;
    for (const shot of selectedPreset.shots) {
      const rangeGate = getShotMaxRangeGateForMechSlot(
        botMechId,
        shot.weaponSlot,
        botX,
        botY,
        targetX,
        targetY,
      );
      if (!rangeGate.allowed) continue;
      const ammoGate = consumeBotWeaponAmmo(bot, shot.weaponSlot);
      if (!ammoGate.allowed) continue;
      markBotWeaponSlotFired(bot, shot.weaponSlot, shot.cooldownMs, now);
      volley.push({
        ...shot,
        maxRangeMeters: rangeGate.maxRangeMeters ?? shot.maxRangeMeters,
      });
      firedHeat += shot.heat;
    }

    if (volley.length === 0) {
      continue;
    }
    bot.heat = currentHeat + firedHeat;

    let targetArmorValues = target.kind === 'player'
      ? [...(session.combatPlayerArmorValues ?? DEFAULT_BOT_ARMOR_VALUES)]
      : target.bot?.armorValues ?? [...DEFAULT_BOT_ARMOR_VALUES];
    let targetInternalValues = target.kind === 'player'
      ? [...(session.combatPlayerInternalValues ?? DEFAULT_BOT_INTERNAL_VALUES)]
      : target.bot?.internalValues ?? [...DEFAULT_BOT_INTERNAL_VALUES];
    let targetCriticalStateBytes = target.kind === 'player'
      ? [...(session.combatPlayerCriticalStateBytes ?? createCriticalStateBytes(getMechEntryForSession(session)?.extraCritCount))]
      : target.bot?.criticalStateBytes ?? createCriticalStateBytes(getMechEntryForId(target.mechId)?.extraCritCount);
    let targetHeadArmor = target.kind === 'player'
      ? (session.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE)
      : (target.bot?.headArmor ?? HEAD_ARMOR_VALUE);
    let currentTargetHealth = target.health;

    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_BOT_RESET');
    const shotSummaries: string[] = [];
    let totalDamageUpdates = 0;

    for (const shot of volley) {
      const hitRoll = resolveCombatToHitRoll({
        attackerX: botX,
        attackerY: botY,
        attackerFacing: botFacing,
        attackerSpeedMag: bot.speedMag,
        attackerMaxSpeedMag: botMechEntry.maxSpeedMag,
        attackerAirborne: bot.jumpActive === true,
        targetX,
        targetY,
        targetFacing: target.facing,
        targetSpeedMag: target.speedMag,
        targetMaxSpeedMag: target.maxSpeedMag,
        targetAirborne: target.airborne,
        targetMoveVectorX: target.moveVectorX,
        targetMoveVectorY: target.moveVectorY,
        distanceMeters,
        weaponSpec: shot.weaponSpec,
        maxRangeMeters: shot.maxRangeMeters,
      }, difficultyProfile);
      if (!hitRoll.hit) {
        const missImpact = getMissImpactPoint(
          botX,
          botY,
          targetX,
          targetY,
          targetZ,
          distanceMeters,
        );
        send(
          session.socket,
          buildCmd68ProjectileSpawnPacket(
            {
              sourceSlot: bot.slot,
              weaponSlot: shot.weaponSlot,
              targetRaw: 0,
              targetAttach: 0,
              angleSeedA: 0,
              angleSeedB: 0,
              impactX: missImpact.impactX,
              impactY: missImpact.impactY,
              impactZ: missImpact.impactZ,
            },
            nextSeq(session),
          ),
          capture,
          'CMD68_BOT_PROJECTILE_MISS',
        );
        shotSummaries.push(
          `${shot.weaponSlot}:${shot.weaponName ?? 'unknown'}:miss:target=${target.kind === 'player' ? 'player' : `slot=${target.slot}`}:chance=${Math.round(hitRoll.chance * 100)}:roll=${Math.round(hitRoll.roll * 100)}:band=${hitRoll.rangeBand}:cross=${Math.round(hitRoll.crossingFactor * 100)}:impact=${missImpact.impactX}/${missImpact.impactY}/${missImpact.impactZ}`,
        );
        continue;
      }

      const hitSection = chooseBotAttackSection(
        bot,
        shot.weaponSlot,
        targetArmorValues,
        targetInternalValues,
        targetHeadArmor,
        distanceMeters,
        currentTargetHealth,
      );
      const targetAttach = findRepresentativeCombatAttachmentIdForSection(target.mechId, hitSection);
      const previousInternalValues = [...targetInternalValues];
      send(
        session.socket,
        buildCmd68ProjectileSpawnPacket(
          {
            sourceSlot: bot.slot,
            weaponSlot: shot.weaponSlot,
            targetRaw: target.kind === 'player' ? 10 : target.slot + 1,
            targetAttach: targetAttach === undefined ? 0 : targetAttach + 1,
            angleSeedA: 0,
            angleSeedB: 0,
            impactX: targetX,
            impactY: targetY,
            impactZ: targetZ,
          },
          nextSeq(session),
        ),
        capture,
        'CMD68_BOT_PROJECTILE',
      );
      const damageResult = applyDamageToSection(
        targetArmorValues,
        targetInternalValues,
        hitSection,
        shot.damage,
        targetHeadArmor,
      );
      const postDamageUpdates = collectPostDamageStateUpdates(
        target.mechId,
        targetCriticalStateBytes,
        previousInternalValues,
        targetInternalValues,
        hitSection.internalIndex === 7 && damageResult.updates.some(update => update.damageCode === 0x27),
      );
      targetHeadArmor = damageResult.headArmor;
      const allUpdates = [...damageResult.updates, ...postDamageUpdates.updates];
      for (const update of allUpdates) {
        send(
          session.socket,
          target.kind === 'player'
            ? buildCmd67LocalDamagePacket(update.damageCode, update.damageValue, nextSeq(session))
            : buildCmd66ActorDamagePacket(target.slot, update.damageCode, update.damageValue, nextSeq(session)),
          capture,
          target.kind === 'player' ? 'CMD67_BOT_LOCAL_DAMAGE' : 'CMD66_BOT_REMOTE_DAMAGE',
        );
      }
      if (postDamageUpdates.newlyDestroyedLegs.length > 0 && !isActorDestroyed(targetInternalValues)) {
        sendCombatLegLossCollapse(
          session,
          target.kind === 'player' ? 0 : target.slot,
          connLog,
          `${postDamageUpdates.newlyDestroyedLegs.map(leg => leg.label).join('+')} destroyed`,
          target.kind === 'player' ? 'CMD70_BOT_PLAYER_LEG_COLLAPSE' : 'CMD70_BOT_REMOTE_LEG_COLLAPSE',
          capture,
          session.combatLegLossTransitionMode ?? 'collapse-only',
        );
      }

      currentTargetHealth = getCombatDurability(targetArmorValues, targetInternalValues) + targetHeadArmor;
      totalDamageUpdates += allUpdates.length;
      shotSummaries.push(
        `${shot.weaponSlot}:${shot.weaponName ?? 'unknown'}:${shot.damage}:${hitSection.label}:slot=${bot.slot}:target=${target.kind === 'player' ? 'player' : target.slot}:attach=${targetAttach ?? 'n/a'}:chance=${Math.round(hitRoll.chance * 100)}:roll=${Math.round(hitRoll.roll * 100)}:band=${hitRoll.rangeBand}:cross=${Math.round(hitRoll.crossingFactor * 100)}:health=${currentTargetHealth}:updates=${allUpdates.map(update => `0x${update.damageCode.toString(16)}=${update.damageValue}`).join('/') || 'none'}`,
      );
    }

    if (target.kind === 'player') {
      session.combatPlayerArmorValues = targetArmorValues;
      session.combatPlayerInternalValues = targetInternalValues;
      session.combatPlayerCriticalStateBytes = targetCriticalStateBytes;
      session.combatPlayerHeadArmor = targetHeadArmor;
      session.playerHealth = currentTargetHealth;
    } else if (target.bot) {
      target.bot.armorValues = targetArmorValues;
      target.bot.internalValues = targetInternalValues;
      target.bot.criticalStateBytes = targetCriticalStateBytes;
      target.bot.headArmor = targetHeadArmor;
      target.bot.health = currentTargetHealth;
      if (isActorDestroyed(targetInternalValues)) {
        target.bot.health = 0;
        destroyedBotSlots.add(target.bot.slot);
      }
    }

    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_BOT_CLOSE');
    connLog.info(
      '[world/combat] bot volley: slot=%d side=%d mechId=%d target=%s tic=%s distance=%dm weapons=%s heat=%s expected=%.1f targetHealth=%d updates=%d shots=[%s]',
      bot.slot,
      bot.side,
      botMechId,
      target.kind === 'player' ? 'player' : `slot=${target.slot}/side=${target.side}`,
      selectedPreset.name,
      Math.round(distanceMeters),
      volley.map(shot => shot.weaponSlot).join('/'),
      `${Math.round(currentHeat * 10) / 10}->${Math.round(bot.heat * 10) / 10} risk=${Math.round(selectedPreset.overheatRisk * 100)}`,
      selectedPreset.totalExpectedDamage,
      currentTargetHealth,
      totalDamageUpdates,
      shotSummaries.join(','),
    );

    if (target.kind === 'player' && isActorDestroyed(targetInternalValues)) {
      session.playerHealth = 0;
      syncLegacySoloCombatBotState(session);
      queueCombatResultTransition(
        players,
        session,
        connLog,
        capture,
        COMBAT_RESULT_LOSS,
        (targetInternalValues[7] ?? 0) <= 0 ? 'head destroyed' : 'center torso destroyed',
        PLAYER_RESULT_DELAY_MS,
      );
      return;
    }
  }

  syncLegacySoloCombatBotState(session);
  for (const slot of destroyedBotSlots) {
    const bot = getSoloCombatBotBySlot(session, slot);
    if (!bot) {
      continue;
    }
    sendBotDeathTransition(session, bot, connLog, capture, 'destroyed by bot fire');
  }
  if (getActiveHostileSoloCombatBots(session).length === 0) {
    session.botHealth = 0;
    stopBotCombatActions(session);
    queueCombatResultTransition(
      players,
      session,
      connLog,
      capture,
      COMBAT_RESULT_VICTORY,
      'all hostile solo-combat bots structurally destroyed',
      BOT_RESULT_DELAY_MS,
    );
  }
}

function startBotCombatAi(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.botPositionTimer !== undefined) {
    clearInterval(session.botPositionTimer);
  }
  if (session.botFireTimer !== undefined) {
    clearInterval(session.botFireTimer);
  }

  session.botPositionTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') {
      stopBotCombatActions(session);
      return;
    }
    stepBotMovement(session, connLog, capture);
  }, BOT_AI_TICK_MS);
  session.botPositionTimer.unref();

  session.botFireTimer = setInterval(() => {
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') {
      stopBotCombatActions(session);
      return;
    }
    stepBotWeaponFire(players, session, connLog, capture);
  }, BOT_AI_TICK_MS);
  session.botFireTimer.unref();
}

function stopBotCombatActions(session: ClientSession): void {
  if (session.botPositionTimer !== undefined) {
    clearInterval(session.botPositionTimer);
    session.botPositionTimer = undefined;
  }
  if (session.botFireTimer !== undefined) {
    clearInterval(session.botFireTimer);
    session.botFireTimer = undefined;
  }
}

function sendBotDeathTransition(
  session: ClientSession,
  bot: SoloCombatBotActorState,
  connLog: Logger,
  capture: CaptureLogger,
  reason: string,
): void {
  if (bot.deathTimer !== undefined) {
    clearTimeout(bot.deathTimer);
    bot.deathTimer = undefined;
  }

  // Retail v1.23 death flow uses Cmd70 subcommand 8 to start the collapse and
  // then subcommand 0 to advance the actor through the destruction tail.
  connLog.info('[world/combat] bot destroyed — slot=%d mechId=%d sending collapse transition (%s)', bot.slot, bot.mechId, reason);
  send(
    session.socket,
    buildCmd70ActorTransitionPacket(bot.slot, 8, nextSeq(session)),
    capture,
    'CMD70_BOT_COLLAPSE',
  );

  bot.deathTimer = setTimeout(() => {
    bot.deathTimer = undefined;
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;
    connLog.info('[world/combat] bot death-tail advance: slot=%d mechId=%d (%s)', bot.slot, bot.mechId, reason);
    send(
      session.socket,
      buildCmd70ActorTransitionPacket(bot.slot, 0, nextSeq(session)),
      capture,
      'CMD70_BOT_DEATH_ADVANCE',
    );
  }, 1200);
  bot.deathTimer.unref();
}

function queueCombatResultTransition(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
  resultCode: CombatResultCode,
  reason: string,
  delayMs: number,
): void {
  if (session.combatResultCode !== undefined) {
    connLog.debug(
      '[world/combat] match result already queued/sent (%s) — ignoring duplicate trigger (%s)',
      session.combatResultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss',
      reason,
    );
    return;
  }

  session.combatResultCode = resultCode;
  stopBotCombatActions(session);
  connLog.info(
    '[world/combat] queued match result=%s in %dms (%s)',
    resultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss',
    delayMs,
    reason,
  );

  session.combatResultTimer = setTimeout(() => {
    session.combatResultTimer = undefined;
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;

    const resultLabel = resultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss';
    connLog.info('[world/combat] sending Cmd75/Cmd63 result transition (%s)', resultLabel);
    send(
      session.socket,
      buildCmd75CombatResultPacket(resultCode, nextSeq(session)),
      capture,
      `CMD75_RESULT_${resultLabel.toUpperCase()}`,
    );
    send(
      session.socket,
      buildCmd63ArenaSceneInitPacket(nextSeq(session)),
      capture,
      'CMD63_RESULT_SCENE',
    );

    if (session.combatWorldRestoreTimer !== undefined) {
      clearTimeout(session.combatWorldRestoreTimer);
      session.combatWorldRestoreTimer = undefined;
    }
    session.combatWorldRestoreTimer = setTimeout(() => {
      session.combatWorldRestoreTimer = undefined;
      if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;

      connLog.info('[world/combat] restoring world mode after result scene (%s)', resultLabel);
      resetCombatState(session);
      deferWorldSceneRefreshAfterWelcome(
        players,
        session,
        connLog,
        capture,
        'WORLD_WELCOME_AFTER_RESULT',
        resultCode === COMBAT_RESULT_VICTORY
          ? `Combat over: victory. Returned to ${getWorldReturnLocationLabel(session)}.`
          : `Combat over: defeat. Returned to ${getWorldReturnLocationLabel(session)}.`,
        {
          notifyUnreadComstar: true,
          notifyRoomArrival: true,
        },
      );
    }, RESULT_WORLD_RESTORE_DELAY_MS);
    session.combatWorldRestoreTimer.unref();
  }, delayMs);
  session.combatResultTimer.unref();
}

/**
 * Clear all repeating combat timers on a session.
 *
 * Called both from the TCP 'close' handler (cleanup on disconnect) and from
 * the `/fightrestart` handler (cleanup before re-bootstrapping in the same
 * connection).  Idempotent — safe to call multiple times.
 */
export function stopCombatTimers(session: ClientSession): void {
  stopBotCombatActions(session);
  clearSoloCombatBotDeathTimers(session);
  if (session.botDeathTimer !== undefined) {
    clearTimeout(session.botDeathTimer);
    session.botDeathTimer = undefined;
  }
  if (session.combatResultTimer !== undefined) {
    clearTimeout(session.combatResultTimer);
    session.combatResultTimer = undefined;
  }
  if (session.combatWorldRestoreTimer !== undefined) {
    clearTimeout(session.combatWorldRestoreTimer);
    session.combatWorldRestoreTimer = undefined;
  }
  if (session.combatBootstrapTimer !== undefined) {
    clearTimeout(session.combatBootstrapTimer);
    session.combatBootstrapTimer = undefined;
  }
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }
  session.combatJumpActive = undefined;
  if (session.combatJumpFuelRegenTimer !== undefined) {
    clearInterval(session.combatJumpFuelRegenTimer);
    session.combatJumpFuelRegenTimer = undefined;
  }
  if (session.combatLegLossTransitionTimers) {
    for (const timer of session.combatLegLossTransitionTimers) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    session.combatLegLossTransitionTimers = undefined;
  }
  if (session.combatWeaponReadyTimerBySlot) {
    for (const timer of session.combatWeaponReadyTimerBySlot) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    session.combatWeaponReadyTimerBySlot = undefined;
  }
  clearPendingCombatAction0Followup(session);
  session.combatResultCode = undefined;
}

export function resetCombatState(session: ClientSession): void {
  stopCombatTimers(session);
  session.combatInitialized = false;
  session.phase = 'world';
  session.combatBotActors = undefined;
  session.botHealth = undefined;
  session.playerHealth = undefined;
  session.combatX = undefined;
  session.combatY = undefined;
  session.combatFacingRaw = undefined;
  session.combatUpperBodyPitch = undefined;
  session.combatTorsoYaw = undefined;
  session.combatSpeedMag = undefined;
  session.combatBotArmorValues = undefined;
  session.combatBotInternalValues = undefined;
  session.combatBotHeadArmor = undefined;
  session.combatPlayerHeadArmor = undefined;
  session.combatBotCriticalStateBytes = undefined;
  session.combatBotX = undefined;
  session.combatBotY = undefined;
  session.combatBotZ = undefined;
  session.combatBotFacing = undefined;
  session.combatBotSpeedMag = undefined;
  session.combatBotLastMoveAt = undefined;
  session.combatBotLastAimLimitLogAt = undefined;
  session.combatBotMoveVectorX = undefined;
  session.combatBotMoveVectorY = undefined;
  session.combatBotWeaponReadyAtBySlot = undefined;
  session.combatBotAmmoStateValues = undefined;
  session.combatBotHeat = undefined;
  session.combatBotJumpActive = undefined;
  session.combatBotJumpFuel = undefined;
  session.combatBotJumpStartedAt = undefined;
  session.combatBotJumpDurationMs = undefined;
  session.combatBotJumpStartFuel = undefined;
  session.combatBotJumpApexUnits = undefined;
  session.combatBotJumpStartX = undefined;
  session.combatBotJumpStartY = undefined;
  session.combatBotJumpTargetX = undefined;
  session.combatBotJumpTargetY = undefined;
  session.combatBotLastJumpAt = undefined;
  session.combatPlayerArmorValues = undefined;
  session.combatPlayerInternalValues = undefined;
  session.combatPlayerCriticalStateBytes = undefined;
  session.combatRetaliationCursor = undefined;
  session.combatJumpActive = undefined;
  session.combatJumpAltitude = undefined;
  session.combatAltitudeRaw = undefined;
  session.combatJumpFuel = undefined;
  session.combatLastMoveAt = undefined;
  session.combatMoveVectorX = undefined;
  session.combatMoveVectorY = undefined;
  session.combatLastCollisionProbeAt = undefined;
  session.combatLastContactReportAt = undefined;
  session.combatLastJumpLandAt = undefined;
  session.combatLastJumpLandAltitude = undefined;
  session.combatEjectArmed = undefined;
  session.lastCombatFireActionAt = undefined;
  session.combatAction0FollowupTimer = undefined;
  session.combatRequireAction0 = undefined;
  session.combatShotsAccepted = undefined;
  session.combatShotsRejected = undefined;
  session.combatShotsAction0Correlated = undefined;
  session.combatShotsDirectCmd10 = undefined;
  session.combatAction0NoShotCount = undefined;
  session.combatLegLossTransitionMode = undefined;
  session.combatLegLossTransitionTimers = undefined;
  session.combatLastLocalCollapseAt = undefined;
  session.combatLocalDowned = undefined;
  session.combatDeferredLocalCollapsePending = undefined;
  session.combatSuppressLocalCmd65WhileDowned = undefined;
  session.combatCmd73RateProbe = undefined;
  session.combatRecoveryExperimentPending = undefined;
  session.combatWeaponReadyAtBySlot = undefined;
  session.combatWeaponReadyTimerBySlot = undefined;
  session.combatAmmoStateValues = undefined;
}

function getActiveDuelPeer(
  players: PlayerRegistry,
  session: ClientSession,
): ClientSession | undefined {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode !== 'duel' || combatSession.state !== 'active') {
    return undefined;
  }

  const peer = session.combatPeerSessionId ? players.get(session.combatPeerSessionId) : undefined;
  if (!peer || peer.socket.destroyed || peer.phase !== 'combat' || !peer.combatInitialized) {
    return undefined;
  }
  return peer;
}

function getActiveCombatSession(
  players: PlayerRegistry,
  session: ClientSession,
): CombatSession | undefined {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.state !== 'active') {
    return undefined;
  }
  return combatSession;
}

function refreshWorldSceneIfPossible(
  players: PlayerRegistry,
  session: ClientSession | undefined,
  connLog: Logger,
  message: string,
): boolean {
  if (!session || session.phase !== 'world' || !session.worldInitialized || session.socket.destroyed) {
    return false;
  }
  const capture = worldCaptures.get(session.id);
  if (!capture) {
    return false;
  }
  sendSceneRefresh(players, session, connLog, capture, message);
  return true;
}

export function handleArenaReadyToggle(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.phase !== 'world' || !session.worldInitialized || !isArenaRoom(session)) {
    connLog.warn('[world] arena ready toggle ignored outside arena room: phase=%s room=%d',
      session.phase, session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID);
    return;
  }

  const toggleError = getArenaReadyToggleError(session);
  if (toggleError) {
    send(
      session.socket,
      buildCmd3BroadcastPacket(`Cannot toggle READY yet: ${toggleError}.`, nextSeq(session)),
      capture,
      'CMD3_ARENA_READY_ERR',
    );
    return;
  }

  const nextReady = session.worldArenaReady !== true;
  let duelCleared = false;
  if (!nextReady && hasPendingArenaDuelState(session)) {
    clearSessionDuelState(players, session, connLog, 'not ready');
    duelCleared = true;
  }
  session.worldArenaReady = nextReady ? true : undefined;

  const mech = session.selectedMechId !== undefined
    ? WORLD_MECH_BY_ID.get(session.selectedMechId)
    : undefined;
  const chassis = mech ? getMechChassis(mech.typeString) : `Mech ${session.selectedMechId ?? FALLBACK_MECH_ID}`;
  const message = nextReady
    ? `Arena ready set: READY on ${getArenaSideLabel(session.worldArenaSide)} with ${chassis}.`
    : `Arena ready cleared: not ready.${duelCleared ? ' Duel state cleared.' : ''}`;
  sendSceneRefresh(players, session, connLog, capture, message);
  sendArenaStatusList(players, session, connLog, capture);
}

function normalizeDuelStakeValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(DUEL_STAKE_MAX, Math.trunc(value)));
}

export function sendStagedDuelTermsPanel(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode !== 'duel' || combatSession.state !== 'staged') {
    send(
      session.socket,
      buildCmd3BroadcastPacket('No staged duel is ready for duel terms.', nextSeq(session)),
      capture,
      'CMD3_DUEL_TERMS_UNAVAILABLE',
    );
    return;
  }

  const [participantAId, participantBId] = combatSession.participantSessionIds;
  const participantA = players.get(participantAId);
  const participantB = players.get(participantBId);
  const [stakeA, stakeB] = combatSession.duelStakeValues;
  const roomName = getSolarisRoomName(combatSession.worldMapRoomId);

  send(
    session.socket,
    buildCmd17DuelTermsPacket(
      {
        mode:         0,
        participantA: participantA ? getDisplayName(participantA) : 'Pilot A',
        participantB: participantB ? getDisplayName(participantB) : 'Pilot B',
        stakeA,
        stakeB,
        contextA:     roomName,
        contextB:     DEFAULT_SCENE_NAME,
        flagA:        0,
        flagB:        0,
      },
      nextSeq(session),
    ),
    capture,
    'CMD17_DUEL_TERMS',
  );
  connLog.info(
    '[world/duel] opened duel terms panel session=%s viewer="%s" stakes=%d/%d',
    combatSession.id,
    getDisplayName(session),
    stakeA,
    stakeB,
  );
}

export function handleDuelTermsSubmit(
  players: PlayerRegistry,
  session: ClientSession,
  stakeA: number,
  stakeB: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode !== 'duel' || combatSession.state !== 'staged') {
    connLog.warn('[world/duel] cmd15 ignored: no staged duel for "%s"', getDisplayName(session));
    send(
      session.socket,
      buildCmd3BroadcastPacket('No staged duel is active for submitted duel terms.', nextSeq(session)),
      capture,
      'CMD3_DUEL_TERMS_STALE',
    );
    return;
  }

  const normalizedStakeA = normalizeDuelStakeValue(stakeA);
  const normalizedStakeB = normalizeDuelStakeValue(stakeB);
  if (normalizedStakeA !== stakeA || normalizedStakeB !== stakeB) {
    connLog.warn(
      '[world/duel] normalized out-of-range duel stakes for "%s": %d/%d -> %d/%d',
      getDisplayName(session),
      stakeA,
      stakeB,
      normalizedStakeA,
      normalizedStakeB,
    );
  }

  const [participantAId, participantBId] = combatSession.participantSessionIds;
  const participantA = players.get(participantAId);
  const participantB = players.get(participantBId);
  if (participantA && participantB) {
    const balanceError = getDuelStakeBalanceError(
      participantA,
      normalizedStakeA,
      participantB,
      normalizedStakeB,
    );
    if (balanceError) {
      send(
        session.socket,
        buildCmd3BroadcastPacket(`Duel terms rejected: ${balanceError}`, nextSeq(session)),
        capture,
        'CMD3_DUEL_TERMS_FUNDS',
      );
      return;
    }
  }

  combatSession.duelStakeValues = [normalizedStakeA, normalizedStakeB];
  combatSession.duelTermsUpdatedBySessionId = session.id;
  combatSession.duelTermsUpdatedAt = Date.now();
  const summary = `Duel terms updated: ${participantA ? getDisplayName(participantA) : 'Pilot A'}=${normalizedStakeA} cb, ${participantB ? getDisplayName(participantB) : 'Pilot B'}=${normalizedStakeB} cb. Use /duelterms to review or /fight to start.`;

  connLog.info(
    '[world/duel] cmd15 duel terms submit session=%s by="%s" stakes=%d/%d',
    combatSession.id,
    getDisplayName(session),
    normalizedStakeA,
    normalizedStakeB,
  );

  send(
    session.socket,
    buildCmd3BroadcastPacket(summary, nextSeq(session)),
    capture,
    'CMD3_DUEL_TERMS_UPDATED',
  );

  const peer = session.combatPeerSessionId ? players.get(session.combatPeerSessionId) : undefined;
  if (peer && peer.phase === 'world' && peer.worldInitialized && !peer.socket.destroyed) {
    sendToWorldSession(
      peer,
      buildCmd3BroadcastPacket(summary, nextSeq(peer)),
      'CMD3_DUEL_TERMS_UPDATED',
    );
  }
}

function mirrorCombatRemotePosition(
  players: PlayerRegistry,
  session: ClientSession,
  label: string,
): void {
  const combatSession = getActiveCombatSession(players, session);
  if (!combatSession) {
    return;
  }
  for (const viewer of getCombatReadyParticipants(players, combatSession)) {
    if (viewer.id === session.id) {
      continue;
    }
    const slot = getCombatRemoteSlotForViewer(combatSession, viewer, session);
    if (slot === undefined) {
      continue;
    }
    sendToWorldSession(
      viewer,
      buildCmd65PositionSyncPacket(
        {
          slot,
          x:        session.combatX ?? 0,
          y:        session.combatY ?? 0,
          z:        session.combatJumpAltitude ?? 0,
          facing:   getCombatCmd65Facing(session),
          throttle: session.combatUpperBodyPitch ?? 0,
          legVel:   session.combatTorsoYaw ?? 0,
          speedMag: session.combatSpeedMag ?? 0,
        },
        nextSeq(viewer),
      ),
      label,
    );
  }
}

function getCombatCmd65Facing(session: ClientSession): number {
  // Ghidra: client cmd8/cmd9 writes the first trailing type1 field from DAT_004f1d5c
  // (the chassis facing accumulator), not from the preceding type2 altitude field.
  return FACING_ACCUMULATOR_NEUTRAL +
    ((session.combatFacingRaw ?? MOTION_NEUTRAL) - MOTION_NEUTRAL) * MOTION_DIV;
}

function formatProbeAgeMs(ageMs: number | undefined): string {
  if (ageMs === undefined || ageMs < 0) {
    return 'n/a';
  }
  return `${ageMs}ms`;
}

function recordCombatLanding(session: ClientSession, landedFromAltitude: number): void {
  session.combatLastJumpLandAt = Date.now();
  session.combatLastJumpLandAltitude = Math.max(0, landedFromAltitude);
}

function maybeLogCombatContactReport(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  source: string,
  contactActorId: number,
  responseA: number,
  responseB: number,
  responseC: number,
): void {
  const now = Date.now();
  if (
    session.combatLastContactReportAt !== undefined
    && now - session.combatLastContactReportAt < COLLISION_PROBE_LOG_COOLDOWN_MS
  ) {
    return;
  }
  session.combatLastContactReportAt = now;

  const peer = getActiveDuelPeer(players, session);
  const localLandingAgeMs =
    session.combatLastJumpLandAt === undefined ? undefined : now - session.combatLastJumpLandAt;
  const peerLandingAgeMs =
    peer?.combatLastJumpLandAt === undefined ? undefined : now - peer.combatLastJumpLandAt;

  connLog.info(
    '[world/combat] cmd-13 contact report: source=%s local="%s" peer="%s" actorId=%d response=(%d,%d,%d) local=(%d,%d,%d speed=%d pitch=%d torsoYaw=%d) peer=(%d,%d,%d speed=%d pitch=%d torsoYaw=%d) localLand=%s/%d peerLand=%s/%d',
    source,
    getDisplayName(session),
    peer ? getDisplayName(peer) : '(none)',
    contactActorId,
    responseA,
    responseB,
    responseC,
    session.combatX ?? 0,
    session.combatY ?? 0,
    session.combatJumpAltitude ?? 0,
    session.combatSpeedMag ?? 0,
    session.combatUpperBodyPitch ?? 0,
    session.combatTorsoYaw ?? 0,
    peer?.combatX ?? 0,
    peer?.combatY ?? 0,
    peer?.combatJumpAltitude ?? 0,
    peer?.combatSpeedMag ?? 0,
    peer?.combatUpperBodyPitch ?? 0,
    peer?.combatTorsoYaw ?? 0,
    formatProbeAgeMs(localLandingAgeMs),
    session.combatLastJumpLandAltitude ?? 0,
    formatProbeAgeMs(peerLandingAgeMs),
    peer?.combatLastJumpLandAltitude ?? 0,
  );
}

function maybeLogCollisionProbeCandidate(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  source: string,
): void {
  const peer = getActiveDuelPeer(players, session);
  if (!peer || peer.combatResultCode !== undefined) {
    return;
  }

  const localX = session.combatX;
  const localY = session.combatY;
  const peerX = peer.combatX;
  const peerY = peer.combatY;
  if (
    localX === undefined
    || localY === undefined
    || peerX === undefined
    || peerY === undefined
  ) {
    return;
  }

  const localZ = session.combatJumpAltitude ?? 0;
  const peerZ = peer.combatJumpAltitude ?? 0;
  const horizontalDistance = Math.round(Math.hypot(localX - peerX, localY - peerY));
  if (horizontalDistance > COLLISION_PROBE_HORIZONTAL_DISTANCE) {
    return;
  }

  const now = Date.now();
  const localLandingAgeMs =
    session.combatLastJumpLandAt === undefined ? undefined : now - session.combatLastJumpLandAt;
  const peerLandingAgeMs =
    peer.combatLastJumpLandAt === undefined ? undefined : now - peer.combatLastJumpLandAt;
  const landingWindowActive =
    (localLandingAgeMs !== undefined
      && localLandingAgeMs >= 0
      && localLandingAgeMs <= COLLISION_PROBE_LANDING_WINDOW_MS)
    || (peerLandingAgeMs !== undefined
      && peerLandingAgeMs >= 0
      && peerLandingAgeMs <= COLLISION_PROBE_LANDING_WINDOW_MS);

  const verticalDistance = Math.abs(localZ - peerZ);
  const airborneOrLanding =
    localZ > 0
    || peerZ > 0
    || landingWindowActive;
  if (!airborneOrLanding && verticalDistance > COLLISION_PROBE_VERTICAL_TOLERANCE) {
    return;
  }

  const lastProbeAt = Math.max(
    session.combatLastCollisionProbeAt ?? 0,
    peer.combatLastCollisionProbeAt ?? 0,
  );
  if (lastProbeAt > 0 && now - lastProbeAt < COLLISION_PROBE_LOG_COOLDOWN_MS) {
    return;
  }

  session.combatLastCollisionProbeAt = now;
  peer.combatLastCollisionProbeAt = now;

  connLog.info(
    '[world/combat] collision probe candidate: source=%s local="%s" peer="%s" horiz=%d vert=%d local=(%d,%d,%d speed=%d pitch=%d torsoYaw=%d) peer=(%d,%d,%d speed=%d pitch=%d torsoYaw=%d) landingWindow=%s localLand=%s/%d peerLand=%s/%d',
    source,
    getDisplayName(session),
    getDisplayName(peer),
    horizontalDistance,
    verticalDistance,
    localX,
    localY,
    localZ,
    session.combatSpeedMag ?? 0,
    session.combatUpperBodyPitch ?? 0,
    session.combatTorsoYaw ?? 0,
    peerX,
    peerY,
    peerZ,
    peer.combatSpeedMag ?? 0,
    peer.combatUpperBodyPitch ?? 0,
    peer.combatTorsoYaw ?? 0,
    landingWindowActive ? 'yes' : 'no',
    formatProbeAgeMs(localLandingAgeMs),
    session.combatLastJumpLandAltitude ?? 0,
    formatProbeAgeMs(peerLandingAgeMs),
    peer.combatLastJumpLandAltitude ?? 0,
  );
}

function stopSessionActiveCombatLoops(session: ClientSession): void {
  if (session.combatBootstrapTimer !== undefined) {
    clearTimeout(session.combatBootstrapTimer);
    session.combatBootstrapTimer = undefined;
  }
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }
  session.combatJumpActive = false;
  if (session.combatJumpFuelRegenTimer !== undefined) {
    clearInterval(session.combatJumpFuelRegenTimer);
    session.combatJumpFuelRegenTimer = undefined;
  }
}

function clearCombatEjectArm(session: ClientSession, connLog: Logger, reason: string): void {
  if (!session.combatEjectArmed) {
    return;
  }
  session.combatEjectArmed = false;
  connLog.debug('[world/combat] cleared eject arm (%s)', reason);
}

function maybeFinalizeDuelCombatSession(
  players: PlayerRegistry,
  combatSessionId: string,
  participants: readonly ClientSession[],
  connLog: Logger,
): void {
  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'duel') {
    return;
  }
  if (!participants.every(participant => participant.socket.destroyed || participant.phase === 'world')) {
    return;
  }

  for (const participant of participants) {
    if (participant.combatSessionId === combatSessionId) {
      participant.combatSessionId = undefined;
    }
  }
  if (participants.length === 2) {
    const [playerA, playerB] = participants;
    if (playerA.combatPeerSessionId === playerB.id) {
      playerA.combatPeerSessionId = undefined;
    }
    if (playerB.combatPeerSessionId === playerA.id) {
      playerB.combatPeerSessionId = undefined;
    }
  }

  players.removeCombatSession(combatSessionId);
  connLog.info('[world/duel] finalized duel session=%s after combat restore', combatSessionId);
}

function maybeFinalizeArenaCombatSession(
  players: PlayerRegistry,
  combatSessionId: string,
  connLog: Logger,
): void {
  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'arena') {
    return;
  }
  const allRestoredOrGone = combatSession.participantSessionIds.every(participantId => {
    const participant = players.get(participantId);
    return participant === undefined || participant.socket.destroyed || participant.phase === 'world';
  });
  if (!allRestoredOrGone) {
    return;
  }

  for (const participantId of combatSession.participantSessionIds) {
    const participant = players.get(participantId);
    if (participant?.combatSessionId === combatSessionId) {
      participant.combatSessionId = undefined;
    }
  }
  players.removeCombatSession(combatSessionId);
  connLog.info('[world/arena] finalized arena session=%s after combat restore', combatSessionId);
}

function sendArenaParticipantDeathTransition(
  players: PlayerRegistry,
  combatSession: CombatSession,
  eliminated: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  if (combatSession.mode !== 'arena') {
    return;
  }
  if (eliminated.botDeathTimer !== undefined) {
    clearTimeout(eliminated.botDeathTimer);
    eliminated.botDeathTimer = undefined;
  }

  connLog.info(
    '[world/arena] player destroyed — sending collapse transition eliminated="%s" (%s)',
    getDisplayName(eliminated),
    reason,
  );
  for (const viewer of getCombatReadyParticipants(players, combatSession)) {
    const slot = viewer.id === eliminated.id
      ? 0
      : getCombatRemoteSlotForViewer(combatSession, viewer, eliminated);
    if (slot === undefined) {
      continue;
    }
    sendToWorldSession(
      viewer,
      buildCmd70ActorTransitionPacket(slot, 8, nextSeq(viewer)),
      viewer.id === eliminated.id ? 'CMD70_ARENA_LOCAL_COLLAPSE' : 'CMD70_ARENA_REMOTE_COLLAPSE',
    );
  }

  const deathTimer = setTimeout(() => {
    for (const viewer of getCombatReadyParticipants(players, combatSession)) {
      const slot = viewer.id === eliminated.id
        ? 0
        : getCombatRemoteSlotForViewer(combatSession, viewer, eliminated);
      if (slot === undefined) {
        continue;
      }
      sendToWorldSession(
        viewer,
        buildCmd70ActorTransitionPacket(slot, 0, nextSeq(viewer)),
        viewer.id === eliminated.id ? 'CMD70_ARENA_LOCAL_DEATH_ADVANCE' : 'CMD70_ARENA_REMOTE_DEATH_ADVANCE',
      );
    }
    eliminated.botDeathTimer = undefined;
  }, 1200);
  eliminated.botDeathTimer = deathTimer;
  deathTimer.unref();
}

function sendArenaParticipantLegLossCollapse(
  players: PlayerRegistry,
  combatSession: CombatSession,
  collapsed: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  if (combatSession.mode !== 'arena') {
    return;
  }
  for (const viewer of getCombatReadyParticipants(players, combatSession)) {
    const slot = viewer.id === collapsed.id
      ? 0
      : getCombatRemoteSlotForViewer(combatSession, viewer, collapsed);
    if (slot === undefined) {
      continue;
    }
    sendCombatLegLossCollapse(
      viewer,
      slot,
      connLog,
      reason,
      viewer.id === collapsed.id ? 'CMD70_ARENA_LOCAL_LEG_COLLAPSE' : 'CMD70_ARENA_REMOTE_LEG_COLLAPSE',
      undefined,
      collapsed.combatLegLossTransitionMode ?? 'collapse-only',
    );
  }
}

function queueArenaParticipantResultTransition(
  players: PlayerRegistry,
  combatSessionId: string,
  participant: ClientSession,
  connLog: Logger,
  resultCode: CombatResultCode,
  reason: string,
  delayMs: number,
): void {
  if (participant.combatSessionId !== combatSessionId || participant.combatResultCode !== undefined) {
    return;
  }
  participant.combatResultCode = resultCode;
  stopSessionActiveCombatLoops(participant);
  connLog.info(
    '[world/arena] queued participant result=%s pilot="%s" in %dms (%s)',
    resultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss',
    getDisplayName(participant),
    delayMs,
    reason,
  );

  participant.combatResultTimer = setTimeout(() => {
    participant.combatResultTimer = undefined;
    if (participant.socket.destroyed || !participant.socket.writable || participant.phase !== 'combat') {
      maybeFinalizeArenaCombatSession(players, combatSessionId, connLog);
      return;
    }

    const resultLabel = resultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss';
    sendToWorldSession(
      participant,
      buildCmd75CombatResultPacket(resultCode, nextSeq(participant)),
      `CMD75_ARENA_RESULT_${resultLabel.toUpperCase()}`,
    );
    sendToWorldSession(
      participant,
      buildCmd63ArenaSceneInitPacket(nextSeq(participant)),
      'CMD63_ARENA_RESULT_SCENE',
    );

    if (participant.combatWorldRestoreTimer !== undefined) {
      clearTimeout(participant.combatWorldRestoreTimer);
      participant.combatWorldRestoreTimer = undefined;
    }
    participant.combatWorldRestoreTimer = setTimeout(() => {
      participant.combatWorldRestoreTimer = undefined;
      if (participant.socket.destroyed || !participant.socket.writable || participant.phase !== 'combat') {
        maybeFinalizeArenaCombatSession(players, combatSessionId, connLog);
        return;
      }

      resetCombatState(participant);
      participant.duelTermsAvailable = false;
      if (participant.combatSessionId === combatSessionId) {
        participant.combatSessionId = undefined;
      }
      participant.combatPeerSessionId = undefined;
      const participantCapture = worldCaptures.get(participant.id);
      deferWorldSceneRefreshAfterWelcome(
        players,
        participant,
        connLog,
        participantCapture,
        resultCode === COMBAT_RESULT_VICTORY
          ? 'WORLD_WELCOME_AFTER_ARENA_VICTORY'
          : 'WORLD_WELCOME_AFTER_ARENA_LOSS',
        resultCode === COMBAT_RESULT_VICTORY
          ? `Arena combat over: victory. Returned to ${getWorldReturnLocationLabel(participant)}.`
          : `Arena combat over: defeat. Returned to ${getWorldReturnLocationLabel(participant)}.`,
        {
          notifyUnreadComstar: participantCapture !== undefined,
          notifyRoomArrival: true,
          onComplete: () => maybeFinalizeArenaCombatSession(players, combatSessionId, connLog),
        },
      );
    }, RESULT_WORLD_RESTORE_DELAY_MS);
    participant.combatWorldRestoreTimer.unref();
  }, delayMs);
  participant.combatResultTimer.unref();
}

function maybeResolveArenaCombatOutcome(
  players: PlayerRegistry,
  combatSessionId: string,
  connLog: Logger,
  reason: string,
): void {
  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'arena' || combatSession.state === 'completed') {
    return;
  }

  const survivors = getCombatActiveParticipants(players, combatSession);
  if (survivors.length === 0) {
    combatSession.state = 'completed';
    maybeFinalizeArenaCombatSession(players, combatSessionId, connLog);
    return;
  }

  const survivingSides = new Set(survivors.map(participant => participant.worldArenaSide ?? -1));
  if (survivingSides.size > 1) {
    return;
  }

  combatSession.state = 'completed';
  connLog.info(
    '[world/arena] resolving arena outcome session=%s survivors=%s (%s)',
    combatSessionId,
    survivors.map(participant => getDisplayName(participant)).join(', '),
    reason,
  );
  for (const survivor of survivors) {
    queueArenaParticipantResultTransition(
      players,
      combatSessionId,
      survivor,
      connLog,
      COMBAT_RESULT_VICTORY,
      reason,
      PLAYER_RESULT_DELAY_MS,
    );
  }
}

function eliminateArenaCombatParticipant(
  players: PlayerRegistry,
  combatSession: CombatSession,
  participant: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  if (combatSession.mode !== 'arena' || participant.combatResultCode !== undefined) {
    return;
  }
  participant.playerHealth = 0;
  if (participant.combatPlayerArmorValues !== undefined) {
    participant.combatPlayerArmorValues = participant.combatPlayerArmorValues.map(() => 0);
  }
  if (participant.combatPlayerInternalValues !== undefined) {
    participant.combatPlayerInternalValues = participant.combatPlayerInternalValues.map(() => 0);
  }
  participant.combatPlayerHeadArmor = 0;
  sendArenaParticipantDeathTransition(players, combatSession, participant, connLog, reason);
  queueArenaParticipantResultTransition(
    players,
    combatSession.id,
    participant,
    connLog,
    COMBAT_RESULT_LOSS,
    reason,
    BOT_RESULT_DELAY_MS,
  );
  maybeResolveArenaCombatOutcome(players, combatSession.id, connLog, reason);
}

function requestArenaCombatEjection(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  confirmImmediately = false,
): boolean {
  const combatSession = getActiveCombatSession(players, session);
  if (combatSession?.mode !== 'arena') {
    return false;
  }

  if (!confirmImmediately && !session.combatEjectArmed) {
    session.combatEjectArmed = true;
    connLog.info('[world/arena] eject armed for "%s" (awaiting confirm)', getDisplayName(session));
    return true;
  }

  session.combatEjectArmed = false;
  connLog.info('[world/arena] ejection confirmed for "%s"', getDisplayName(session));
  eliminateArenaCombatParticipant(players, combatSession, session, connLog, 'pilot ejected');
  return true;
}

export function handleArenaCombatDisconnect(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): void {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode !== 'arena' || session.phase !== 'combat' || session.combatResultCode !== undefined) {
    return;
  }

  session.playerHealth = 0;
  session.combatResultCode = COMBAT_RESULT_LOSS;
  stopSessionActiveCombatLoops(session);
  sendArenaParticipantDeathTransition(players, combatSession, session, connLog, 'player disconnected');
  maybeResolveArenaCombatOutcome(players, combatSession.id, connLog, 'player disconnected');
}

function sendDuelDeathTransition(
  winner: ClientSession,
  loser: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  if (winner.botDeathTimer !== undefined) {
    clearTimeout(winner.botDeathTimer);
    winner.botDeathTimer = undefined;
  }
  if (loser.botDeathTimer !== undefined) {
    clearTimeout(loser.botDeathTimer);
    loser.botDeathTimer = undefined;
  }

  connLog.info(
    '[world/duel] player destroyed — sending collapse transition winner="%s" loser="%s" (%s)',
    getDisplayName(winner),
    getDisplayName(loser),
    reason,
  );
  if (!winner.socket.destroyed && winner.socket.writable && winner.phase === 'combat') {
    sendToWorldSession(
      winner,
      buildCmd70ActorTransitionPacket(1, 8, nextSeq(winner)),
      'CMD70_DUEL_REMOTE_COLLAPSE',
    );
  }
  if (!loser.socket.destroyed && loser.socket.writable && loser.phase === 'combat') {
    sendToWorldSession(
      loser,
      buildCmd70ActorTransitionPacket(0, 8, nextSeq(loser)),
      'CMD70_DUEL_LOCAL_COLLAPSE',
    );
  }

  const deathTimer = setTimeout(() => {
    if (!winner.socket.destroyed && winner.socket.writable && winner.phase === 'combat') {
      sendToWorldSession(
        winner,
        buildCmd70ActorTransitionPacket(1, 0, nextSeq(winner)),
        'CMD70_DUEL_REMOTE_DEATH_ADVANCE',
      );
    }
    if (!loser.socket.destroyed && loser.socket.writable && loser.phase === 'combat') {
      sendToWorldSession(
        loser,
        buildCmd70ActorTransitionPacket(0, 0, nextSeq(loser)),
        'CMD70_DUEL_LOCAL_DEATH_ADVANCE',
      );
    }
    winner.botDeathTimer = undefined;
    loser.botDeathTimer = undefined;
  }, 1200);
  winner.botDeathTimer = deathTimer;
  loser.botDeathTimer = deathTimer;
  deathTimer.unref();
}

function queueDuelCombatResultTransition(
  players: PlayerRegistry,
  winner: ClientSession,
  loser: ClientSession,
  connLog: Logger,
  reason: string,
  delayMs: number,
): void {
  const combatSessionId = winner.combatSessionId;
  if (!combatSessionId || loser.combatSessionId !== combatSessionId) {
    return;
  }

  const combatSession = players.getCombatSession(combatSessionId);
  if (combatSession?.mode !== 'duel') {
    return;
  }
  if (winner.combatResultCode !== undefined || loser.combatResultCode !== undefined) {
    connLog.debug('[world/duel] result already queued/sent for session=%s — ignoring duplicate (%s)', combatSessionId, reason);
    return;
  }

  combatSession.state = 'completed';
  persistDuelResult(players, winner, loser, connLog, reason);
  settleDuelCbills(players, winner, loser, connLog);
  winner.combatResultCode = COMBAT_RESULT_VICTORY;
  loser.combatResultCode = COMBAT_RESULT_LOSS;
  winner.combatEjectArmed = false;
  loser.combatEjectArmed = false;
  stopSessionActiveCombatLoops(winner);
  stopSessionActiveCombatLoops(loser);
  connLog.info(
    '[world/duel] queued match result winner="%s" loser="%s" in %dms (%s)',
    getDisplayName(winner),
    getDisplayName(loser),
    delayMs,
    reason,
  );

  const participants = [winner, loser] as const;
  const scheduleResult = (
    participant: ClientSession,
    opponent: ClientSession,
    resultCode: CombatResultCode,
  ): void => {
    participant.combatResultTimer = setTimeout(() => {
      participant.combatResultTimer = undefined;
      if (participant.socket.destroyed || !participant.socket.writable || participant.phase !== 'combat') {
        maybeFinalizeDuelCombatSession(players, combatSessionId, participants, connLog);
        return;
      }

      const resultLabel = resultCode === COMBAT_RESULT_VICTORY ? 'victory' : 'loss';
      sendToWorldSession(
        participant,
        buildCmd75CombatResultPacket(resultCode, nextSeq(participant)),
        `CMD75_DUEL_RESULT_${resultLabel.toUpperCase()}`,
      );
      sendToWorldSession(
        participant,
        buildCmd63ArenaSceneInitPacket(nextSeq(participant)),
        'CMD63_DUEL_RESULT_SCENE',
      );

      if (participant.combatWorldRestoreTimer !== undefined) {
        clearTimeout(participant.combatWorldRestoreTimer);
        participant.combatWorldRestoreTimer = undefined;
      }
      participant.combatWorldRestoreTimer = setTimeout(() => {
        participant.combatWorldRestoreTimer = undefined;
        if (participant.socket.destroyed || !participant.socket.writable || participant.phase !== 'combat') {
          maybeFinalizeDuelCombatSession(players, combatSessionId, participants, connLog);
          return;
        }

        resetCombatState(participant);
        participant.duelTermsAvailable = false;
        participant.combatSessionId = undefined;
        participant.combatPeerSessionId = undefined;
        const participantCapture = worldCaptures.get(participant.id);
        deferWorldSceneRefreshAfterWelcome(
          players,
          participant,
          connLog,
          participantCapture,
          `WORLD_WELCOME_AFTER_DUEL_${resultLabel.toUpperCase()}`,
          resultCode === COMBAT_RESULT_VICTORY
            ? `Duel over: victory vs ${getDisplayName(opponent)}. Returned to ${getWorldReturnLocationLabel(participant)}.`
            : `Duel over: defeat vs ${getDisplayName(opponent)}. Returned to ${getWorldReturnLocationLabel(participant)}.`,
          {
            notifyUnreadComstar: participantCapture !== undefined,
            flushPendingDuelSettlement: true,
            notifyRoomArrival: true,
            onComplete: () => maybeFinalizeDuelCombatSession(players, combatSessionId, participants, connLog),
          },
        );
      }, RESULT_WORLD_RESTORE_DELAY_MS);
      participant.combatWorldRestoreTimer.unref();
    }, delayMs);
    participant.combatResultTimer.unref();
  };

  scheduleResult(winner, loser, COMBAT_RESULT_VICTORY);
  scheduleResult(loser, winner, COMBAT_RESULT_LOSS);
}

function requestDuelEjection(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  confirmImmediately = false,
): boolean {
  const duelPeer = getActiveDuelPeer(players, session);
  if (!duelPeer) {
    return false;
  }

  if (!confirmImmediately && !session.combatEjectArmed) {
    session.combatEjectArmed = true;
    connLog.info('[world/duel] eject armed for "%s" (awaiting confirm)', getDisplayName(session));
    return true;
  }

  session.combatEjectArmed = false;
  clearCombatEjectArm(duelPeer, connLog, 'opponent ejected');
  connLog.info('[world/duel] ejection confirmed for "%s"', getDisplayName(session));
  session.playerHealth = 0;
  if (session.combatPlayerArmorValues !== undefined) {
    session.combatPlayerArmorValues = session.combatPlayerArmorValues.map(() => 0);
  }
  if (session.combatPlayerInternalValues !== undefined) {
    session.combatPlayerInternalValues = session.combatPlayerInternalValues.map(() => 0);
  }
  session.combatPlayerHeadArmor = 0;
  sendDuelDeathTransition(duelPeer, session, connLog, 'opponent ejected');
  queueDuelCombatResultTransition(
    players,
    duelPeer,
    session,
    connLog,
    'opponent ejected',
    BOT_RESULT_DELAY_MS,
  );
  return true;
}

export function handleCombatEjectRequest(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  source: string,
): boolean {
  if (session.combatResultCode !== undefined) {
    connLog.debug('[world/combat] %s ignored while result transition is pending', source);
    return true;
  }

  if (requestDuelEjection(players, session, connLog, true)) {
    connLog.info('[world/combat] %s interpreted as confirmed duel ejection', source);
    return true;
  }
  if (requestArenaCombatEjection(players, session, connLog, true)) {
    connLog.info('[world/combat] %s interpreted as confirmed arena ejection', source);
    return true;
  }

  connLog.debug('[world/combat] %s observed outside active duel', source);
  return false;
}

export function handleCombatKeepalivePacket(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): boolean {
  return handleCombatEjectRequest(players, session, connLog, 'type-0x05');
}

function initializeSharedCombatParticipant(
  session: ClientSession,
  spawnX: number,
  spawnY: number,
  connLog: Logger,
): void {
  session.pendingComstarTargetPrompt = false;
  session.pendingHandleChangePrompt = false;
  savePendingIncomingComstarPrompt(session, connLog, 'entering shared combat');
  resetCombatState(session);
  const mechId = session.selectedMechId ?? FALLBACK_MECH_ID;
  const mechEntry = WORLD_MECH_BY_ID.get(mechId);
  const playerCriticalStateBytes = createCriticalStateBytes(mechEntry?.extraCritCount ?? 0);
  session.combatMaxSpeedMag = mechEntry?.maxSpeedMag ?? 0;
  session.combatWalkSpeedMag = mechEntry?.walkSpeedMag ?? 0;
  session.combatX = spawnX;
  session.combatY = spawnY;
  session.combatAltitudeRaw = 0;
  session.combatFacingRaw = MOTION_NEUTRAL;
  session.combatUpperBodyPitch = 0;
  session.combatTorsoYaw = 0;
  session.combatSpeedMag = 0;
  session.combatLastMoveAt = undefined;
  session.combatMoveVectorX = 0;
  session.combatMoveVectorY = 0;
  session.combatJumpAltitude = 0;
  session.combatJumpFuel = JUMP_JET_FUEL_MAX;
  session.combatPlayerArmorValues = [...(mechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
  session.combatPlayerInternalValues = mechEntry !== undefined
    ? mechInternalStateBytes(mechEntry.tonnage)
    : [...DEFAULT_BOT_INTERNAL_VALUES];
  session.combatPlayerCriticalStateBytes = playerCriticalStateBytes;
  session.combatPlayerHeadArmor = HEAD_ARMOR_VALUE;
  session.playerHealth = getCombatDurability(
    session.combatPlayerArmorValues,
    session.combatPlayerInternalValues,
  ) + HEAD_ARMOR_VALUE;
  session.combatVerificationMode = undefined;
  session.combatLegLossTransitionMode = 'collapse-only';
  session.combatRequireAction0 = false;
  session.combatShotsAccepted = 0;
  session.combatShotsRejected = 0;
  session.combatShotsAction0Correlated = 0;
  session.combatShotsDirectCmd10 = 0;
  session.combatAction0NoShotCount = 0;
  session.combatLastLocalCollapseAt = undefined;
  session.combatLocalDowned = false;
  session.combatDeferredLocalCollapsePending = false;
  session.combatSuppressLocalCmd65WhileDowned = false;
  session.combatCmd73RateProbe = false;
  session.combatRecoveryExperimentPending = false;
  session.duelTermsAvailable = false;
  session.phase = 'combat';
}

function startArenaCombatSession(
  players: PlayerRegistry,
  combatSession: CombatSession,
  connLog: Logger,
): boolean {
  if (combatSession.mode !== 'arena') {
    return false;
  }
  const participants = getCombatSessionParticipants(players, combatSession);
  if (participants.length < 2) {
    players.removeCombatSession(combatSession.id);
    return true;
  }
  if (participants.some(participant =>
    participant.socket.destroyed
    || participant.phase !== 'world'
    || !participant.worldInitialized,
  )) {
    for (const participant of participants) {
      if (participant.combatSessionId === combatSession.id) {
        participant.combatSessionId = undefined;
      }
    }
    players.removeCombatSession(combatSession.id);
    return true;
  }

  const spawnPoints = getArenaCombatSpawnPoints(participants);
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const spawn = spawnPoints[index] ?? { x: 0, y: 0 };
    initializeSharedCombatParticipant(participant, spawn.x, spawn.y, connLog);
  }

  for (const participant of participants) {
    notifyRoomDeparture(players, participant, connLog);
    sendToWorldSession(participant, buildCombatWelcomePacket(), 'COMBAT_WELCOME_MMC');
  }

  combatSession.state = 'active';
  combatSession.startedAt = Date.now();
  connLog.info(
    '[world/arena] starting active arena session=%s pilots=%s',
    combatSession.id,
    participants.map(participant => `${getDisplayName(participant)}:${getArenaSideLabel(participant.worldArenaSide)}`).join(', '),
  );

  const bootstrapTimer = setTimeout(() => {
    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index];
      if (
        participant.socket.destroyed ||
        !participant.socket.writable ||
        participant.phase !== 'combat'
      ) {
        continue;
      }

      const localMechId = participant.selectedMechId ?? FALLBACK_MECH_ID;
      const localMechEntry = WORLD_MECH_BY_ID.get(localMechId);
      const localExtraCritCount = localMechEntry?.extraCritCount ?? 0;
      const localCritBytes = Math.max(0, localExtraCritCount + 21);
      const localCriticalStateBytes = createCriticalStateBytes(localExtraCritCount);
      const localAmmoStateValues = getInitialCombatAmmoStateValues(localMechEntry?.ammoBinTypeIds);
      const localCallsign = getDisplayName(participant);
      participant.combatAmmoStateValues = [...localAmmoStateValues];

      sendToWorldSession(
        participant,
        buildCmd72LocalBootstrapPacket(
          {
            scenarioTitle:       `${DEFAULT_SCENE_NAME} Arena`,
            localSlot:           0,
            unknownByte0:        0,
            terrainId:           1,
            terrainResourceId:   0,
            terrainPoints:       [],
            arenaPoints:         [],
            globalA:             COMBAT_GLOBAL_A,
            globalB:             COMBAT_GLOBAL_B,
            globalC:             COMBAT_GLOBAL_C,
            headingBias:         0,
            identity0:           localCallsign.substring(0, 11),
            identity1:           localCallsign.substring(0, 31),
            identity2:           localMechEntry?.typeString ?? '',
            identity3:           participant.allegiance ?? '',
            identity4:           '',
            statusByte:          0,
            initialX:            participant.combatX ?? 0,
            initialY:            participant.combatY ?? 0,
            extraType2Values:    [],
            remainingActorCount: participants.length - 1,
            unknownType1Raw:     MOTION_NEUTRAL,
            mech: {
              mechId:              localMechId,
              critStateExtraCount: localExtraCritCount,
               criticalStateBytes:  localCriticalStateBytes.slice(0, localCritBytes),
               extraStateBytes:     [],
               armorLikeStateBytes: Array<number>(11).fill(0),
               internalStateBytes:  mechInternalStateBytes(localMechEntry?.tonnage ?? 0),
               ammoStateValues:     localAmmoStateValues,
               actorDisplayName:    localCallsign.substring(0, 31),
             },
           },
          nextSeq(participant),
        ),
        'CMD72_ARENA_BOOTSTRAP',
      );
      participant.combatStartAt = Date.now();

      const remotes = getCombatRemoteParticipantsForViewer(players, combatSession, participant);
      remotes.forEach((remote, remoteIndex) => {
        const remoteMechId = remote.selectedMechId ?? FALLBACK_MECH_ID;
        const remoteMechEntry = WORLD_MECH_BY_ID.get(remoteMechId);
        const remoteSlot = remoteIndex + 1;
        const remoteCallsign = getDisplayName(remote);
        const remoteIsTeammate =
          participant.worldArenaSide !== undefined
          && participant.worldArenaSide === remote.worldArenaSide;

        sendToWorldSession(
          participant,
          buildCmd64RemoteActorPacket(
            {
              slot:          remoteSlot,
              actorTypeByte: getCombatRemoteActorTypeByte(remoteIsTeammate),
              identity0:     remoteCallsign.substring(0, 11),
              identity1:     remoteCallsign.substring(0, 31),
              identity2:     remoteMechEntry?.typeString ?? '',
              identity3:     remote.allegiance ?? '',
              identity4:     '',
              statusByte:    0,
              mechId:        remoteMechId,
            },
            nextSeq(participant),
          ),
          'CMD64_ARENA_REMOTE_ACTOR',
        );
      });

      sendToWorldSession(
        participant,
        buildCmd65PositionSyncPacket(
          {
            slot:     0,
            x:        participant.combatX ?? 0,
            y:        participant.combatY ?? 0,
            z:        0,
            facing:   0,
            throttle: 0,
            legVel:   0,
            speedMag: 0,
          },
          nextSeq(participant),
        ),
        'CMD65_ARENA_LOCAL_POSITION',
      );

      remotes.forEach((remote, remoteIndex) => {
        const remoteSlot = remoteIndex + 1;
        sendToWorldSession(
          participant,
          buildCmd65PositionSyncPacket(
            {
              slot:     remoteSlot,
              x:        remote.combatX ?? 0,
              y:        remote.combatY ?? 0,
              z:        remote.combatJumpAltitude ?? 0,
              facing:   getCombatCmd65Facing(remote),
              throttle: remote.combatUpperBodyPitch ?? 0,
              legVel:   remote.combatTorsoYaw ?? 0,
              speedMag: remote.combatSpeedMag ?? 0,
            },
            nextSeq(participant),
          ),
          'CMD65_ARENA_REMOTE_POSITION',
        );
      });

      sendToWorldSession(
        participant,
        buildCmd62CombatStartPacket(nextSeq(participant)),
        'CMD62_ARENA_COMBAT_START',
      );
      participant.combatInitialized = true;
    }
  }, COMBAT_DROP_DELAY_MS);

  for (const participant of participants) {
    participant.combatBootstrapTimer = bootstrapTimer;
  }
  bootstrapTimer.unref();
  return true;
}

export function tryStartStagedDuelCombat(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
): boolean {
  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode !== 'duel') {
    return false;
  }
  if (combatSession.state !== 'staged') {
    connLog.debug('[world/duel] ignoring staged-combat start for session=%s state=%s', combatSession.id, combatSession.state);
    return true;
  }

  const [sessionAId, sessionBId] = combatSession.participantSessionIds;
  const playerA = players.get(sessionAId);
  const playerB = players.get(sessionBId);
  if (!playerA || !playerB) {
    clearSessionDuelState(players, session, connLog, 'participant unavailable');
    return true;
  }
  if (
    playerA.socket.destroyed ||
    playerB.socket.destroyed ||
    playerA.phase !== 'world' ||
    playerB.phase !== 'world' ||
    !playerA.worldInitialized ||
    !playerB.worldInitialized
  ) {
    clearSessionDuelState(players, session, connLog, 'participant unavailable');
    return true;
  }
  if (worldMapByRoomId.get(combatSession.worldMapRoomId)?.type === 'arena') {
    const roomParticipants = getLiveArenaRoomParticipants(players, combatSession.roomId);
    const notReadyPilots = roomParticipants
      .filter(other => !isArenaParticipantReady(other))
      .map(other => getDisplayName(other));
    if (notReadyPilots.length > 0) {
      broadcastArenaReadyRoomNotice(
        players,
        combatSession.roomId,
        `Fight blocked: waiting on ${formatPilotList(notReadyPilots)} to READY.`,
        'CMD3_ARENA_READY_BLOCKED',
      );
      return true;
    }
    if (roomParticipants.length !== 2) {
      broadcastArenaReadyRoomNotice(
        players,
        combatSession.roomId,
        `Fight blocked: room combat currently supports exactly 2 ready pilots. Ready pilots: ${formatPilotList(roomParticipants.map(other => getDisplayName(other)))}.`,
        'CMD3_ARENA_READY_UNSUPPORTED',
      );
      return true;
    }
    if (getSharedArenaSide(playerA, playerB) !== undefined) {
      broadcastArenaReadyRoomNotice(
        players,
        combatSession.roomId,
        `Fight blocked: ${getDisplayName(playerA)} and ${getDisplayName(playerB)} are both on ${getArenaSideLabel(playerA.worldArenaSide)}. Same-side pilots are teammates.`,
        'CMD3_ARENA_READY_SAME_SIDE',
      );
      return true;
    }
  }
  const balanceError = getDuelStakeBalanceError(
    playerA,
    combatSession.duelStakeValues[0],
    playerB,
    combatSession.duelStakeValues[1],
  );
  if (balanceError) {
    for (const participant of [playerA, playerB]) {
      sendToWorldSession(
        participant,
        buildCmd3BroadcastPacket(`Cannot start sanctioned duel: ${balanceError}`, nextSeq(participant)),
        'CMD3_DUEL_START_FUNDS',
      );
    }
    return true;
  }
  const participants = [
    { local: playerA, peer: playerB, localX: 0, localY: 0, remoteX: 0, remoteY: BOT_SPAWN_DISTANCE },
    { local: playerB, peer: playerA, localX: 0, localY: BOT_SPAWN_DISTANCE, remoteX: 0, remoteY: 0 },
  ];

  for (const participant of participants) {
    participant.local.pendingComstarTargetPrompt = false;
    participant.local.pendingHandleChangePrompt = false;
    savePendingIncomingComstarPrompt(participant.local, connLog, 'entering duel combat');
    resetCombatState(participant.local);
    const mechId = participant.local.selectedMechId ?? FALLBACK_MECH_ID;
    const mechEntry = WORLD_MECH_BY_ID.get(mechId);
    const playerCriticalStateBytes = createCriticalStateBytes(mechEntry?.extraCritCount ?? 0);
    participant.local.combatMaxSpeedMag = mechEntry?.maxSpeedMag ?? 0;
    participant.local.combatWalkSpeedMag = mechEntry?.walkSpeedMag ?? 0;
    participant.local.combatX = participant.localX;
    participant.local.combatY = participant.localY;
    participant.local.combatAltitudeRaw = 0;
    participant.local.combatFacingRaw = MOTION_NEUTRAL;
    participant.local.combatUpperBodyPitch = 0;
    participant.local.combatTorsoYaw = 0;
    participant.local.combatSpeedMag = 0;
    participant.local.combatLastMoveAt = undefined;
    participant.local.combatMoveVectorX = 0;
    participant.local.combatMoveVectorY = 0;
    participant.local.combatJumpAltitude = 0;
    participant.local.combatJumpFuel = JUMP_JET_FUEL_MAX;
    participant.local.combatPlayerArmorValues = [...(mechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
    participant.local.combatPlayerInternalValues = mechEntry !== undefined
      ? mechInternalStateBytes(mechEntry.tonnage)
      : [...DEFAULT_BOT_INTERNAL_VALUES];
    participant.local.combatPlayerCriticalStateBytes = playerCriticalStateBytes;
    participant.local.combatPlayerHeadArmor = HEAD_ARMOR_VALUE;
    participant.local.playerHealth = getCombatDurability(
      participant.local.combatPlayerArmorValues,
      participant.local.combatPlayerInternalValues,
    ) + HEAD_ARMOR_VALUE;
    participant.local.combatVerificationMode = undefined;
    participant.local.combatRequireAction0 = false;
    participant.local.combatShotsAccepted = 0;
    participant.local.combatShotsRejected = 0;
    participant.local.combatShotsAction0Correlated = 0;
    participant.local.combatShotsDirectCmd10 = 0;
    participant.local.combatAction0NoShotCount = 0;
    participant.local.combatLastLocalCollapseAt = undefined;
    participant.local.combatLocalDowned = false;
    participant.local.combatDeferredLocalCollapsePending = false;
    participant.local.combatSuppressLocalCmd65WhileDowned = false;
    participant.local.combatCmd73RateProbe = false;
    participant.local.combatRecoveryExperimentPending = false;
    participant.local.duelTermsAvailable = false;
    participant.local.phase = 'combat';
  }

  for (const participant of participants) {
    notifyRoomDeparture(players, participant.local, connLog);
    sendToWorldSession(participant.local, buildCombatWelcomePacket(), 'COMBAT_WELCOME_MMC');
  }

  combatSession.state = 'active';
  combatSession.startedAt = Date.now();
  connLog.info(
    '[world/duel] starting active duel session=%s players="%s" vs "%s"',
    combatSession.id,
    getDisplayName(playerA),
    getDisplayName(playerB),
  );

  const bootstrapTimer = setTimeout(() => {
    for (const participant of participants) {
      if (
        participant.local.socket.destroyed ||
        !participant.local.socket.writable ||
        participant.local.phase !== 'combat'
      ) {
        return;
      }

      const localMechId = participant.local.selectedMechId ?? FALLBACK_MECH_ID;
      const localMechEntry = WORLD_MECH_BY_ID.get(localMechId);
      const localExtraCritCount = localMechEntry?.extraCritCount ?? 0;
      const localCritBytes = Math.max(0, localExtraCritCount + 21);
      const localCriticalStateBytes = createCriticalStateBytes(localExtraCritCount);
      const localAmmoStateValues = getInitialCombatAmmoStateValues(localMechEntry?.ammoBinTypeIds);
      const peerMechId = participant.peer.selectedMechId ?? FALLBACK_MECH_ID;
      const peerMechEntry = WORLD_MECH_BY_ID.get(peerMechId);
      const localCallsign = getDisplayName(participant.local);
      const peerCallsign = getDisplayName(participant.peer);
      participant.local.combatAmmoStateValues = [...localAmmoStateValues];

      sendToWorldSession(
        participant.local,
        buildCmd72LocalBootstrapPacket(
          {
            scenarioTitle:      `${DEFAULT_SCENE_NAME} Duel`,
            localSlot:          0,
            unknownByte0:       0,
            terrainId:          1,
            terrainResourceId:  0,
            terrainPoints:      [],
            arenaPoints:        [],
            globalA:            COMBAT_GLOBAL_A,
            globalB:            COMBAT_GLOBAL_B, // RE: preserves grounded top speed while adding ~50% more jump height than 1600/33
            globalC:            COMBAT_GLOBAL_C,
            headingBias:        0, // RE: Cmd72 type1 seeds DAT_004f4210 (heat path), not jump height
            identity0:          localCallsign.substring(0, 11),
            identity1:          localCallsign.substring(0, 31),
            identity2:          localMechEntry?.typeString ?? '',
            identity3:          participant.local.allegiance ?? '',
            identity4:          '',
            statusByte:         0,
            initialX:           participant.localX,
            initialY:           participant.localY,
            extraType2Values:   [],
            remainingActorCount: 1,
            unknownType1Raw:    MOTION_NEUTRAL,
            mech: {
              mechId:                localMechId,
              critStateExtraCount:   localExtraCritCount,
               criticalStateBytes:    localCriticalStateBytes.slice(0, localCritBytes),
               extraStateBytes:       [],
               armorLikeStateBytes:   Array<number>(11).fill(0),
               internalStateBytes:    mechInternalStateBytes(localMechEntry?.tonnage ?? 0),
               ammoStateValues:       localAmmoStateValues,
               actorDisplayName:      localCallsign.substring(0, 31),
             },
           },
          nextSeq(participant.local),
        ),
        'CMD72_DUEL_BOOTSTRAP',
      );
      participant.local.combatStartAt = Date.now();

      sendToWorldSession(
        participant.local,
        buildCmd64RemoteActorPacket(
          {
            slot:          1,
            actorTypeByte: 0,
            identity0:     peerCallsign.substring(0, 11),
            identity1:     peerCallsign.substring(0, 31),
            identity2:     peerMechEntry?.typeString ?? '',
            identity3:     participant.peer.allegiance ?? '',
            identity4:     '',
            statusByte:    0,
            mechId:        peerMechId,
          },
          nextSeq(participant.local),
        ),
        'CMD64_DUEL_REMOTE_ACTOR',
      );

      sendToWorldSession(
        participant.local,
        buildCmd65PositionSyncPacket(
          {
            slot:     0,
            x:        participant.localX,
            y:        participant.localY,
            z:        0,
            facing:   0,
            throttle: 0,
            legVel:   0,
            speedMag: 0,
          },
          nextSeq(participant.local),
        ),
        'CMD65_DUEL_LOCAL_POSITION',
      );
      sendToWorldSession(
        participant.local,
        buildCmd65PositionSyncPacket(
          {
            slot:     1,
            x:        participant.remoteX,
            y:        participant.remoteY,
            z:        0,
            facing:   0,
            throttle: 0,
            legVel:   0,
            speedMag: 0,
          },
          nextSeq(participant.local),
        ),
        'CMD65_DUEL_REMOTE_POSITION',
      );
      sendToWorldSession(
        participant.local,
        buildCmd62CombatStartPacket(nextSeq(participant.local)),
        'CMD62_DUEL_COMBAT_START',
      );
      participant.local.combatInitialized = true;
    }
  }, COMBAT_DROP_DELAY_MS);
  playerA.combatBootstrapTimer = bootstrapTimer;
  playerB.combatBootstrapTimer = bootstrapTimer;
  bootstrapTimer.unref();
  return true;
}

// ── ComStar messaging ─────────────────────────────────────────────────────────

export function handleComstarTextReply(
  players: PlayerRegistry,
  session: ClientSession,
  dialogId: number,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const clean = text.replace(/\x1b/g, '?').replace(/\s+/g, ' ').trim();

  if (session.pendingHandleChangePrompt && dialogId === 0) {
    const accountId = session.accountId;
    const displayName = clean.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 64);
    if (displayName.length === 0) {
      session.pendingHandleChangePrompt = false;
      send(
        session.socket,
        buildCmd3BroadcastPacket('Handle change cancelled.', nextSeq(session)),
        capture,
        'CMD3_HANDLE_CHANGE_CANCELLED',
      );
      return;
    }
    if (!accountId || !displayName) {
      connLog.warn('[world] invalid handle-change reply');
      send(
        session.socket,
        buildCmd3BroadcastPacket('Invalid handle. Please try again.', nextSeq(session)),
        capture,
        'CMD3_HANDLE_CHANGE_INVALID',
      );
      openHandleChangePrompt(session, connLog, capture);
      return;
    }

    const currentDisplayName = getDisplayName(session);
    if (displayName.toLowerCase() === currentDisplayName.toLowerCase()) {
      session.pendingHandleChangePrompt = false;
      send(
        session.socket,
        buildCmd3BroadcastPacket(`Handle remains ${currentDisplayName}.`, nextSeq(session)),
        capture,
        'CMD3_HANDLE_CHANGE_NOOP',
      );
      return;
    }

    isDisplayNameTaken(displayName)
      .then((taken) => {
        if (taken) {
          connLog.info('[world] handle change rejected: displayName="%s" already taken', displayName);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket('That handle is already taken.', nextSeq(session)),
              capture,
              'CMD3_HANDLE_CHANGE_TAKEN',
            );
            openHandleChangePrompt(session, connLog, capture);
          }
          return;
        }

        updateCharacterDisplayName(accountId, displayName)
          .then(() => {
            session.pendingHandleChangePrompt = false;
            session.displayName = displayName;
            broadcastDisplayNameRefresh(players, session, connLog);
            if (!session.socket.destroyed && session.socket.writable) {
              sendSceneRefresh(players, session, connLog, capture, `Handle changed to ${displayName}.`);
            }
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            session.pendingHandleChangePrompt = false;
            connLog.error('[world] failed to persist handle change: %s', detail);
            if (!session.socket.destroyed && session.socket.writable) {
              send(
                session.socket,
                buildCmd3BroadcastPacket('Handle change failed — please try again.', nextSeq(session)),
                capture,
                'CMD3_HANDLE_CHANGE_FAIL',
              );
            }
          });
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        session.pendingHandleChangePrompt = false;
        connLog.error('[world] failed to validate handle change: %s', detail);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd3BroadcastPacket('Handle change failed — please try again.', nextSeq(session)),
            capture,
            'CMD3_HANDLE_CHANGE_FAIL',
          );
        }
      });
    return;
  }

  if (session.pendingComstarTargetPrompt && dialogId === 0) {
    if (clean.length === 0) {
      session.pendingComstarTargetPrompt = false;
      send(
        session.socket,
        buildCmd3BroadcastPacket('ComStar target entry cancelled.', nextSeq(session)),
        capture,
        'CMD3_COMSTAR_TARGET_CANCELLED',
      );
      return;
    }
    if (!/^\d+$/.test(clean)) {
      connLog.warn('[world] invalid direct ComStar target reply: %j', clean);
      send(
        session.socket,
        buildCmd3BroadcastPacket('Invalid ComStar ID. Please enter digits only.', nextSeq(session)),
        capture,
        'CMD3_COMSTAR_TARGET_INVALID',
      );
      openComstarTargetPrompt(session, connLog, capture);
      return;
    }

    const targetId = Number.parseInt(clean, 10);
    const recipientAccountId =
      targetId > 100_000 && targetId < 900_000 ? targetId - 100_000 : undefined;

    if (recipientAccountId === undefined) {
      connLog.warn('[world] out-of-range direct ComStar target reply: %d', targetId);
      send(
        session.socket,
        buildCmd3BroadcastPacket('ComStar target unavailable.', nextSeq(session)),
        capture,
        'CMD3_COMSTAR_TARGET_MISSING',
      );
      openComstarTargetPrompt(session, connLog, capture);
      return;
    }

    const onlineTarget = findWorldTargetBySelectionId(players, targetId);
    if (onlineTarget) {
      session.pendingComstarTargetPrompt = false;
      connLog.info('[world] direct ComStar target resolved online: target=%d', targetId);
      send(
        session.socket,
        buildCmd37OpenComposePacket(targetId, nextSeq(session)),
        capture,
        'CMD37_OPEN_COMPOSE_DIRECT',
      );
      return;
    }

    findAccountById(recipientAccountId)
      .then((account) => {
        if (!account) {
          connLog.warn('[world] direct ComStar target account not found: target=%d account=%d', targetId, recipientAccountId);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket('ComStar target unavailable.', nextSeq(session)),
              capture,
              'CMD3_COMSTAR_TARGET_MISSING',
            );
            openComstarTargetPrompt(session, connLog, capture);
          }
          return;
        }

        session.pendingComstarTargetPrompt = false;
        connLog.info('[world] direct ComStar target resolved offline: target=%d account=%d', targetId, recipientAccountId);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd37OpenComposePacket(targetId, nextSeq(session)),
            capture,
            'CMD37_OPEN_COMPOSE_DIRECT',
          );
        }
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        session.pendingComstarTargetPrompt = false;
        connLog.error('[world] failed to resolve direct ComStar target: %s', detail);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd3BroadcastPacket('ComStar target lookup failed — please try again.', nextSeq(session)),
            capture,
            'CMD3_COMSTAR_TARGET_FAIL',
          );
        }
      });
    return;
  }

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

  const senderName      = getDisplayName(session);
  const senderComstarId = getComstarId(session);
  const formattedBody   = buildComstarDeliveryText(senderName, clean);
  const senderAccountId = session.accountId;

  const target = findWorldTargetBySelectionId(players, dialogId);
  if (target) {
    const targetName = getDisplayName(target);
    const recipientAccountId = target.accountId;
    if (senderAccountId === undefined || recipientAccountId === undefined) {
      connLog.warn(
        '[world] cmd-21 ComStar online target cannot persist: senderAccId=%s recipientAccId=%s target=%d',
        senderAccountId,
        recipientAccountId,
        dialogId,
      );
      send(
        session.socket,
        buildCmd3BroadcastPacket('ComStar delivery failed — please try again.', nextSeq(session)),
        capture,
        'CMD3_COMSTAR_FAIL',
      );
      return;
    }
    connLog.info(
      '[world] cmd-21 ComStar (online): from="%s" to="%s" target=%d text=%j — persisting first',
      senderName, targetName, dialogId, clean,
    );
    storeMessage(senderAccountId, recipientAccountId, senderComstarId, formattedBody)
      .then((row) => {
        if (!row) {
          connLog.info('[world] ComStar recipient inbox is full: target=%d recipientAccId=%d', dialogId, recipientAccountId);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket('ComStar delivery failed — recipient mailbox is full.', nextSeq(session)),
              capture,
              'CMD3_COMSTAR_MAILBOX_FULL',
            );
          }
          return;
        }
        if (!target.socket.destroyed && target.socket.writable) {
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket(`ComStar sent to ${targetName}.`, nextSeq(session)),
              capture,
              'CMD3_COMSTAR_ACK',
            );
          }
          const canPromptLive = target.phase === 'world' && target.worldInitialized === true;
          if (!canPromptLive) {
            connLog.info('[world] ComStar recipient is busy; leaving message unread for later retrieval');
            markSaved([row.id]).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              connLog.error('[world] failed to save busy-recipient ComStar message: %s', msg);
            });
            return;
          }
          countSavedUnreadMessages(recipientAccountId)
            .then((savedUnreadCount) => {
              if (target.socket.destroyed || !target.socket.writable) return;
              if (savedUnreadCount === 0 && target.pendingIncomingComstarMessageId === undefined) {
                promptIncomingComstarMessage(target, row.id, senderComstarId, row.body, connLog);
                return;
              }
              markSaved([row.id]).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                connLog.error('[world] failed to save queued live ComStar message: %s', msg);
              });
              connLog.info(
                '[world] live ComStar recipient already has saved/pending mail; saving new message for later (savedCount=%d pending=%s)',
                savedUnreadCount,
                target.pendingIncomingComstarMessageId === undefined ? 'false' : 'true',
              );
              sendLiveUnreadComstarNotice(target);
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              connLog.error('[world] failed to query live recipient unread ComStar count: %s', msg);
              markSaved([row.id]).catch((saveErr: unknown) => {
                const detail = saveErr instanceof Error ? saveErr.message : String(saveErr);
                connLog.error('[world] failed to save live ComStar message after count failure: %s', detail);
              });
            });
          return;
        }

        connLog.info('[world] ComStar target disconnected before delivery; saving message for later retrieval');
        markSaved([row.id]).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error('[world] failed to save disconnected-target ComStar message: %s', msg);
        });
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
        connLog.error('[world] failed to persist online ComStar: %s', msg);
        if (!session.socket.destroyed && session.socket.writable) {
          send(
            session.socket,
            buildCmd3BroadcastPacket('ComStar delivery failed — please try again.', nextSeq(session)),
            capture,
            'CMD3_COMSTAR_FAIL',
          );
        }
      });
    return;
  }

  // Recipient is offline (or their session ended between roster fetch and now).
  // comstarId = 100_000 + accountId for authenticated players;
  // 900_000 + worldRosterId for anonymous sessions (cannot persist).
  const recipientAccountId =
    dialogId > 100_000 && dialogId < 900_000 ? dialogId - 100_000 : undefined;

  if (senderAccountId !== undefined && recipientAccountId !== undefined) {
    connLog.info(
      '[world] cmd-21 ComStar (offline): from=%d to account=%d text=%j — persisting',
      senderAccountId, recipientAccountId, clean,
    );
    storeMessage(senderAccountId, recipientAccountId, senderComstarId, formattedBody)
      .then((row) => {
        if (!row) {
          connLog.info('[world] offline ComStar recipient inbox is full: account=%d', recipientAccountId);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd3BroadcastPacket('ComStar delivery failed — recipient mailbox is full.', nextSeq(session)),
              capture,
              'CMD3_COMSTAR_MAILBOX_FULL',
            );
          }
          return;
        }
        markSaved([row.id]).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error('[world] failed to save offline ComStar message: %s', msg);
        });
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

export function handleComstarAccessSelection(
  players: PlayerRegistry,
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    connLog.info('[world] ComStar access menu closed');
    return;
  }

  const selectedItem = GLOBAL_COMSTAR_MENU_ITEMS[selection - 1];
  if (!selectedItem) {
    connLog.warn('[world] ComStar access: selection=%d outside compatibility menu', selection);
    send(
      session.socket,
      buildCmd20Packet(COMSTAR_DIALOG_ID, 2, 'That ComStar option is unavailable from this menu.', nextSeq(session)),
      capture,
      'CMD20_COMSTAR_INVALID',
    );
    return;
  }

  switch (selectedItem.itemId) {
    case 0:
      session.pendingComstarTargetPrompt = false;
      connLog.info('[world] ComStar access: opening send-target chooser');
      sendComstarSendTargetMenu(session, connLog, capture);
      return;

    case 1: {
      connLog.info('[world] ComStar access: receive-message check');
      const recipientAccountId = session.accountId;
      if (recipientAccountId === undefined) {
        send(
          session.socket,
          buildCmd20Packet(COMSTAR_DIALOG_ID, 2, 'No messages waiting.', nextSeq(session)),
          capture,
          'CMD20_COMSTAR_EMPTY',
        );
        return;
      }
      fetchNextSavedUnreadMessage(recipientAccountId)
        .then((msg) => {
          if (!msg) {
            if (!session.socket.destroyed && session.socket.writable) {
              send(
                session.socket,
                buildCmd20Packet(COMSTAR_DIALOG_ID, 2, 'No messages waiting.', nextSeq(session)),
                capture,
                'CMD20_COMSTAR_EMPTY',
              );
            }
            return;
          }
          if (!session.socket.destroyed && session.socket.writable) {
            if (msg.id === session.pendingIncomingComstarMessageId) {
              clearPendingIncomingComstarPrompt(session);
            }
            send(
              session.socket,
              buildCmd36MessageViewPacket(msg.sender_comstar_id, msg.body, nextSeq(session)),
              capture,
              'CMD36_COMSTAR_INBOX',
            );
          }
          markRead([msg.id]).catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            connLog.error('[world] failed to mark terminal ComStar message read: %s', detail);
          });
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          connLog.error('[world] failed to fetch unread ComStar message: %s', detail);
          if (!session.socket.destroyed && session.socket.writable) {
            send(
              session.socket,
              buildCmd20Packet(COMSTAR_DIALOG_ID, 2, 'Unable to retrieve ComStar messages.', nextSeq(session)),
              capture,
              'CMD20_COMSTAR_FAIL',
            );
          }
        });
      return;
    }

    case 2:
      sendNewsCategoryMenu(session, connLog, capture);
      return;

  }
}

export function handleComstarSendTargetSelection(
  players: PlayerRegistry,
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  session.pendingComstarTargetPrompt = false;

  if (selection <= 0) {
    connLog.info('[world] ComStar send-target menu closed');
    return;
  }

  if (selection === 1) {
    openComstarTargetPrompt(session, connLog, capture);
    return;
  }

  if (selection === 2) {
    connLog.info('[world] ComStar send-target: opening all-roster list');
    sendAllRosterList(players, session, connLog, capture);
    return;
  }

  connLog.warn('[world] ComStar send-target: unsupported selection=%d', selection);
}

export function handleComstarIncomingPromptCmd7(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const messageId = session.pendingIncomingComstarMessageId;
  const senderId = session.pendingIncomingComstarSenderId;
  const body = session.pendingIncomingComstarBody;
  if (messageId === undefined || senderId === undefined || body === undefined) {
    return false;
  }

  clearPendingIncomingComstarPrompt(session);

  // Cmd7 prompt replies are 1-based; for this incoming ComStar prompt,
  // selection 1 is the retail client's "Read now" choice.
  if (selection === 1) {
    connLog.info('[world] live ComStar prompt accepted: msgId=%d sender=%d', messageId, senderId);
    send(
      session.socket,
      buildCmd36MessageViewPacket(senderId, body, nextSeq(session)),
      capture,
      'CMD36_COMSTAR_PROMPT_ACCEPT',
    );
    markRead([messageId]).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to mark accepted live ComStar message read: %s', detail);
    });
    return true;
  }

  connLog.info('[world] live ComStar prompt deferred: msgId=%d selection=%d', messageId, selection);
  send(
    session.socket,
    buildCmd3BroadcastPacket('ComStar message saved for later.', nextSeq(session)),
    capture,
    'CMD3_COMSTAR_SAVED',
  );
  markSaved([messageId]).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    connLog.error('[world] failed to save deferred live ComStar message: %s', detail);
  });
  return true;
}

export function handleNewsCategorySelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    connLog.info('[world] news category menu closed');
    return;
  }

  if (selection === 1) {
    showMatchResults(session, connLog, capture);
    return;
  }

  if (selection === 2) {
    showPersonalTierRanking(session, connLog, capture);
    return;
  }

  if (selection === 3) {
    sendTierRankingChooser(session, connLog, capture);
    return;
  }

  if (selection === 4) {
    sendClassRankingChooser(session, connLog, capture);
    return;
  }

  if (selection === 5) {
    fetchLatestPublishedArticle()
      .then((article) => {
        if (!article || session.socket.destroyed || !session.socket.writable) {
          if (!article && !session.socket.destroyed && session.socket.writable) {
            sendNoNewsAvailable(session, capture);
          }
          return;
        }
        sendNewsArticleText(session, article.title, article.summary, article.body, capture);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        connLog.error('[world] failed to fetch general news from category menu: %s', detail);
        if (!session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
      });
    return;
  }

  if (selection === 6) {
    const allegiance = session.allegiance ?? '';
    fetchLatestPublishedArticleForTerm(allegiance)
      .then((article) => {
        if (!article || session.socket.destroyed || !session.socket.writable) {
          if (!article && !session.socket.destroyed && session.socket.writable) {
            sendNoNewsAvailable(session, capture);
          }
          return;
        }
        sendNewsArticleText(session, article.title, article.summary, article.body, capture);
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        connLog.error('[world] failed to fetch house news: %s', detail);
        if (!session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
      });
    return;
  }

  connLog.warn('[world] news category selection unsupported: %d', selection);
}

export function handleNewsgridArticleSelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    session.pendingNewsArticleIds = undefined;
    connLog.info('[world] newsgrid article menu closed');
    return;
  }

  const articleId = session.pendingNewsArticleIds?.[selection - 1];
  if (!articleId) {
    connLog.warn('[world] newsgrid article selection missing: selection=%d', selection);
    session.pendingNewsArticleIds = undefined;
    return;
  }

  fetchPublishedArticleById(articleId)
    .then((article) => {
      if (!article || session.socket.destroyed || !session.socket.writable) {
        session.pendingNewsArticleIds = undefined;
        if (!article && !session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
        return;
      }
      sendNewsArticleText(session, article.title, article.summary, article.body, capture);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to fetch newsgrid article: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

export function handleTierRankingMenuSelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    connLog.info('[world] tier ranking chooser closed');
    return;
  }
  const tierKey = TIER_RANKING_KEYS[selection - 1];
  const tierLabel = tierKey ? TIER_RANKING_LABELS.get(tierKey) : undefined;
  if (!tierKey || !tierLabel) {
    sendNoNewsAvailable(session, capture);
    return;
  }
  showTierRankingList(session, tierKey, tierLabel, connLog, capture);
}

export function handleClassRankingMenuSelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    connLog.info('[world] class ranking chooser closed');
    return;
  }
  const classKey = classKeyFromSelection(selection);
  if (!classKey) {
    sendNoNewsAvailable(session, capture);
    return;
  }
  showClassRankingList(session, classKey, connLog, capture);
}

export function handleRankingResultsSelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    session.worldScrollList = undefined;
    connLog.info('[world] ranking results list closed');
    return;
  }
  const pager = session.worldScrollList;
  const visibleItemIds = pager?.visibleItemIds ?? [];
  if (pager?.hasMore && selection === visibleItemIds.length + 1) {
    handleActiveScrollListMore(session, connLog, capture);
    return;
  }
  const comstarId = visibleItemIds[selection - 1];
  session.worldScrollList = undefined;
  if (!comstarId) {
    connLog.warn('[world] ranking result selection missing: selection=%d', selection);
    return;
  }
  showStandingDetailByComstarId(
    session,
    comstarId,
    connLog,
    capture,
    pager?.kind === 'tier-ranking'
      ? { tierKey: pager.tierKey }
      : pager?.kind === 'class-ranking'
        ? { classKey: pager.classKey }
        : undefined,
  );
}

export function handleActiveScrollListMore(
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const pager = session.worldScrollList;
  if (!pager) {
    connLog.debug('[world] cmd-28 MORE ignored without active scroll shell');
    return;
  }
  if (pager.kind === 'tier-ranking' && pager.tierKey) {
    const tierLabel = TIER_RANKING_LABELS.get(pager.tierKey);
    if (!tierLabel) {
      session.worldScrollList = undefined;
      sendNoNewsAvailable(session, capture);
      return;
    }
    showTierRankingList(session, pager.tierKey, tierLabel, connLog, capture, pager.pageIndex + 1);
    return;
  }
  if (pager.kind === 'class-ranking' && pager.classKey) {
    showClassRankingList(session, pager.classKey, connLog, capture, pager.pageIndex + 1);
    return;
  }
  if (pager.kind === 'match-results') {
    showMatchResults(session, connLog, capture, pager.pageIndex + 1);
    return;
  }
  session.worldScrollList = undefined;
  connLog.warn('[world] cmd-28 MORE ignored for incomplete scroll shell state');
}

export function handleMatchResultsSelection(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (selection <= 0) {
    session.pendingMatchResultIds = undefined;
    session.worldScrollList = undefined;
    connLog.info('[world] Solaris match results menu closed');
    return;
  }
  const pager = session.worldScrollList;
  const visibleItemIds = pager?.visibleItemIds ?? [];
  if (pager?.kind === 'match-results' && pager.hasMore && selection === visibleItemIds.length + 1) {
    showMatchResults(session, connLog, capture, pager.pageIndex + 1);
    return;
  }
  const resultId = visibleItemIds[selection - 1] ?? session.pendingMatchResultIds?.[selection - 1];
  if (!resultId) {
    session.pendingMatchResultIds = undefined;
    session.worldScrollList = undefined;
    connLog.warn('[world] Solaris match result selection missing: selection=%d', selection);
    return;
  }
  session.pendingMatchResultIds = undefined;
  session.worldScrollList = undefined;
  fetchDuelResultById(resultId)
    .then((result) => {
      if (!result || session.socket.destroyed || !session.socket.writable) {
        if (!result && !session.socket.destroyed && session.socket.writable) {
          sendNoNewsAvailable(session, capture);
        }
        return;
      }
      send(
        session.socket,
        buildCmd20Packet(
          COMSTAR_DIALOG_ID,
          2,
          buildMatchResultDetailText({
            roomName: result.room_name,
            winnerDisplayName: result.winner_display_name,
            loserDisplayName: result.loser_display_name,
            winnerStakeCb: result.winner_stake_cb,
            loserStakeCb: result.loser_stake_cb,
            settledTransferCb: result.settled_transfer_cb,
            resultReason: result.result_reason,
          }),
          nextSeq(session),
        ),
        capture,
        'CMD20_MATCH_RESULT_DETAIL',
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      connLog.error('[world] failed to load Solaris match result detail: %s', detail);
      if (!session.socket.destroyed && session.socket.writable) {
        sendNoNewsAvailable(session, capture);
      }
    });
}

// ── Room presence ─────────────────────────────────────────────────────────────

export function nextAvailableBooth(players: PlayerRegistry, roomId: string, excludeId: string): number {
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

export function updateRoomPresenceStatus(
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

export function handleRoomMenuSelection(
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
    sendWorldUiRestore(players, session, connLog, capture, 'room-menu new booth');
    return;
  }

  if (selection === 2) {
    connLog.info('[world] room menu: stand requested');
    updateRoomPresenceStatus(players, session, 5, connLog);
    sendWorldUiRestore(players, session, connLog, capture, 'room-menu stand');
    return;
  }

  const booth = selection - 2;
  if (booth < 1 || booth > 7) {
    connLog.info('[world] room menu: cancel/unsupported selection=%d -> restoring world UI', selection);
    sendWorldUiRestore(players, session, connLog, capture, 'room-menu cancel');
    return;
  }

  const occupied = players.inRoom(session.roomId).some(other =>
    other.id !== session.id &&
    other.phase === 'world' &&
    other.worldInitialized &&
    !other.socket.destroyed &&
    getPresenceStatus(other) === 5 + booth,
  );
  if (!occupied) {
    connLog.info(
      '[world] room menu: booth %d selection has no occupant -> treating as cancel and restoring world UI',
      booth,
    );
    sendWorldUiRestore(players, session, connLog, capture, 'room-menu empty booth/cancel');
    return;
  }

  connLog.info('[world] room menu: join booth %d', booth);
  updateRoomPresenceStatus(players, session, 5 + booth, connLog);
  sendWorldUiRestore(players, session, connLog, capture, 'room-menu join booth');
}

// ── Combat entry ──────────────────────────────────────────────────────────────

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
 *   • headingBias  — 0 (MOTION_NEUTRAL added by encoder); live capture needed.
 *   • globalA/B/C  — current RE-backed pair is `1462 / 39 / 0`, matching the
 *     grounded accel/drag model recovered from `FUN_0042c830` / `FUN_0042cd20`.
 *   • identity2/3  — populated with mech typeString and house allegiance (assumption; live capture needed).
 *   • identity4    — empty; unknown purpose.
 */
export function sendCombatBootstrapSequence(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  maybeApplyForcedCombatVerificationMode(session, connLog, capture);
  session.pendingComstarTargetPrompt = false;
  session.pendingHandleChangePrompt = false;
  savePendingIncomingComstarPrompt(session, connLog, 'entering combat');
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
  const playerCriticalStateBytes = createCriticalStateBytes(extraCritCount);

  // Store per-mech speedMag caps so Cmd8/9 handlers can apply them.
  session.combatMaxSpeedMag  = mechEntry?.maxSpeedMag  ?? 0;
  session.combatWalkSpeedMag = mechEntry?.walkSpeedMag ?? 0;
  const localAmmoStateValues = getInitialCombatAmmoStateValues(mechEntry?.ammoBinTypeIds);
  session.combatAmmoStateValues = [...localAmmoStateValues];
  if (session.combatResultTimer !== undefined) {
    clearTimeout(session.combatResultTimer);
    session.combatResultTimer = undefined;
  }
  session.combatResultCode = undefined;
  if (session.combatJumpTimer !== undefined) {
    clearInterval(session.combatJumpTimer);
    session.combatJumpTimer = undefined;
  }
  if (session.combatJumpFuelRegenTimer !== undefined) {
    clearInterval(session.combatJumpFuelRegenTimer);
    session.combatJumpFuelRegenTimer = undefined;
  }
  session.combatJumpActive = false;
  session.combatJumpAltitude = 0;
  session.combatJumpFuel = JUMP_JET_FUEL_MAX;
  session.combatX = 0;
  session.combatY = 0;
  session.combatAltitudeRaw = 0;
  session.combatFacingRaw = MOTION_NEUTRAL;
  session.combatUpperBodyPitch = 0;
  session.combatTorsoYaw = 0;
  session.combatSpeedMag = 0;
  session.combatLastMoveAt = undefined;
  session.combatMoveVectorX = 0;
  session.combatMoveVectorY = 0;
  session.combatLastCollisionProbeAt = undefined;
  session.combatLastJumpLandAt = undefined;
  session.combatLastJumpLandAltitude = undefined;
  session.botHealth    = BOT_INITIAL_HEALTH;
  const verificationMode = session.combatVerificationMode;
  if (!hasConfiguredSoloCombatHostileBots(session, verificationMode)) {
    send(
      socket,
      buildCmd3BroadcastPacket(
        'Solo bot combat needs at least one bot on an enemy side. Use /botside <slot> <player|enemy|1-8> first.',
        nextSeq(session),
      ),
      capture,
      'CMD3_BOTSIDE_HOSTILE_REQUIRED',
    );
    return;
  }

  notifyRoomDeparture(players, session, connLog);

  // 1. MMC SYNC — plain ARIES packet; no game-frame CRC.
  send(socket, buildCombatWelcomePacket(), capture, 'COMBAT_WELCOME_MMC');

  // Switch phase *before* sending combat game frames so that any inbound
  // frames that arrive immediately use the correct CRC seed.
  session.phase = 'combat';

  if (session.combatBootstrapTimer !== undefined) {
    clearTimeout(session.combatBootstrapTimer);
    session.combatBootstrapTimer = undefined;
  }
  connLog.info('[world] delaying combat bootstrap by %dms so DROP can display', COMBAT_DROP_DELAY_MS);
  session.combatBootstrapTimer = setTimeout(() => {
    session.combatBootstrapTimer = undefined;
    if (session.socket.destroyed || !session.socket.writable || session.phase !== 'combat') return;

    const botCount = getConfiguredSoloCombatBotCount(session, verificationMode);
    const playerSide = getConfiguredSoloCombatPlayerSide(session);
    const botSides = Array.from({ length: botCount }, (_, index) => getConfiguredBotSide(session, index, verificationMode));
    const soloSpawnLayout = getSoloCombatSpawnLayout(botSides, playerSide);
    session.combatX = soloSpawnLayout.playerSpawn.x;
    session.combatY = soloSpawnLayout.playerSpawn.y;

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
        globalA:            COMBAT_GLOBAL_A,
        globalB:            COMBAT_GLOBAL_B,
        globalC:            COMBAT_GLOBAL_C,
        headingBias:        0,      // RE: Cmd72 type1 seeds DAT_004f4210 (heat path), not jump height
        identity0:          callsign.substring(0, 11),
        identity1:          callsign.substring(0, 31),
        identity2:          mechEntry?.typeString ?? '',
        identity3:          session.allegiance   ?? '',
        identity4:          '',
        statusByte:         0,
        initialX:           session.combatX ?? 0,
        initialY:           session.combatY ?? 0,
        extraType2Values:   [],
        remainingActorCount: botCount,
        unknownType1Raw:    MOTION_NEUTRAL,
        mech: {
          mechId,
          critStateExtraCount:  extraCritCount,
          criticalStateBytes:   playerCriticalStateBytes.slice(0, critBytes),
          extraStateBytes:      [],
          armorLikeStateBytes:  Array<number>(11).fill(0),
          // internalStateBytes[i] must be non-zero for each IS slot index i
          // referenced by a weapon (mec[0x8e+slot*2] == i per FUN_0042c200).
          // Indices 4 and 7 are also required non-zero by the IS gate (FUN_0042bb00).
          // Order: [arm, arm, side, side, CT, leg, leg, head] (§23.8, IS lookup RE).
          internalStateBytes:   mechInternalStateBytes(mechEntry?.tonnage ?? 0),
          ammoStateValues:      localAmmoStateValues,
          actorDisplayName:     callsign.substring(0, 31),
        },
      },
      nextSeq(session),
    );

    connLog.info('[world] sending Cmd72 combat bootstrap (mech_id=%d callsign="%s" type=%s allegiance=%s)',
      mechId, callsign, mechEntry?.typeString ?? '?', session.allegiance ?? '?');
    send(socket, cmd72, capture, 'CMD72_COMBAT_BOOTSTRAP');
    session.combatStartAt = Date.now();

    const botSpawnPoints = soloSpawnLayout.botSpawnPoints;
    const botActors = Array.from({ length: botCount }, (_, index) => {
      const spawn = botSpawnPoints[index] ?? { x: 0, y: BOT_AI_SPAWN_DISTANCE };
      return createSoloCombatBotActor(
        session,
        index + 1,
        getConfiguredBotLoadoutId(session, index),
        botSides[index] ?? getConfiguredSoloCombatDefaultEnemySide(session),
        spawn.x,
        spawn.y,
      );
    });
    session.combatBotActors = botActors;
    syncLegacySoloCombatBotState(session);
    session.combatPlayerArmorValues = [...(mechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
    session.combatPlayerInternalValues = mechEntry !== undefined
      ? mechInternalStateBytes(mechEntry.tonnage)
      : [...DEFAULT_BOT_INTERNAL_VALUES];
    session.combatPlayerCriticalStateBytes = playerCriticalStateBytes;
    session.combatPlayerHeadArmor = HEAD_ARMOR_VALUE;
    session.playerHealth = getCombatDurability(
      session.combatPlayerArmorValues,
      session.combatPlayerInternalValues,
    ) + (session.combatPlayerHeadArmor ?? 0);
    session.combatRetaliationCursor = 0;
    for (const bot of botActors) {
      const botMechEntry = WORLD_MECH_BY_ID.get(bot.mechId);
      const botLabel = getSoloCombatBotSlotLabel(bot.slot, bot.side, playerSide);
      const botIsTeammate = bot.side === playerSide;
      const cmd64 = buildCmd64RemoteActorPacket(
        {
          slot:          bot.slot,
          actorTypeByte: getCombatRemoteActorTypeByte(botIsTeammate),
          identity0:     botLabel.substring(0, 11),
          identity1:     botLabel.substring(0, 31),
          identity2:     botMechEntry?.typeString ?? '',
          identity3:     '',
          identity4:     '',
          statusByte:    0,
          mechId:        bot.mechId,
        },
        nextSeq(session),
      );
      send(socket, cmd64, capture, 'CMD64_BOT_ACTOR');
      connLog.info('[world] bot actor: slot=%d side=%d mech_id=%d type=%s x=%d y=%d', bot.slot, bot.side, bot.mechId, botMechEntry?.typeString ?? '?', bot.x, bot.y);
    }

    const cmd65 = buildCmd65PositionSyncPacket(
      {
        slot: 0,
        x: session.combatX ?? 0,
        y: session.combatY ?? 0,
        z: session.combatJumpAltitude ?? 0,
        facing: getCombatCmd65Facing(session),
        throttle: session.combatUpperBodyPitch ?? 0,
        legVel: session.combatTorsoYaw ?? 0,
        speedMag: session.combatSpeedMag ?? 0,
      },
      nextSeq(session),
    );
    send(socket, cmd65, capture, 'CMD65_INITIAL_POSITION');

    for (const bot of botActors) {
      sendBotPositionSync(session, bot, capture, 'CMD65_BOT_POSITION');
    }

    const cmd62 = buildCmd62CombatStartPacket(nextSeq(session));
    send(socket, cmd62, capture, 'CMD62_COMBAT_START');

    session.combatJumpFuelRegenTimer = setInterval(() => {
      if (session.socket.destroyed || !session.socket.writable) return;
      const before = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
      regenJumpFuelIfGrounded(session, JUMP_JET_FUEL_REGEN_PER_TICK);
      const after = session.combatJumpFuel ?? before;
      if (after !== before) {
        connLog.debug('[world/combat] jump fuel regen: %d -> %d', before, after);
      }
    }, JUMP_JET_FUEL_REGEN_INTERVAL_MS);
    session.combatJumpFuelRegenTimer.unref();

    if (verificationMode === 'headtest') {
      // Keep scripted retaliation only for the explicit headtest verifier.
      startForcedRetaliationVerification(
        players,
        session,
        connLog,
        capture,
        mechId,
        mechEntry?.extraCritCount,
        {
          name: 'headtest',
          hitSection: HEAD_RETALIATION_SECTION,
        },
      );
    } else if (verificationMode === 'legtest' || verificationMode === 'legseq' || verificationMode === 'legair' || verificationMode === 'legfull' || verificationMode === 'legrecover' || verificationMode === 'legdefer' || verificationMode === 'legdeferquiet' || verificationMode === 'legdefercmd73') {
      startForcedRetaliationVerification(
        players,
        session,
        connLog,
        capture,
        mechId,
        mechEntry?.extraCritCount,
        {
          name: verificationMode,
          hitSection: LEFT_LEG_RETALIATION_SECTION,
          stopAfterDestroyedLegInternalIndex: LEFT_LEG_RETALIATION_SECTION.internalIndex,
          queueLossOnActorDestroyed: false,
        },
      );
    }
    session.combatVerificationMode = undefined;
    session.combatLegLossTransitionMode = verificationMode === 'legseq'
      ? 'fall-then-collapse'
      : verificationMode === 'legair'
        ? 'airborne-collapse-land'
        : verificationMode === 'legfull'
          ? 'fall-airborne-collapse-land'
          : verificationMode === 'legrecover'
            ? 'fall-collapse-recover'
            : (verificationMode === 'legdefer' || verificationMode === 'legdeferquiet' || verificationMode === 'legdefercmd73')
              ? 'defer-while-airborne'
        : 'collapse-only';
    session.combatRequireAction0 = verificationMode === 'strictfire';
    session.combatShotsAccepted = 0;
    session.combatShotsRejected = 0;
    session.combatShotsAction0Correlated = 0;
    session.combatShotsDirectCmd10 = 0;
    session.combatAction0NoShotCount = 0;
    session.combatLastLocalCollapseAt = undefined;
    session.combatLocalDowned = false;
    session.combatDeferredLocalCollapsePending = false;
    session.combatSuppressLocalCmd65WhileDowned = verificationMode === 'legdeferquiet';
    session.combatCmd73RateProbe = verificationMode === 'legdefercmd73';
    session.combatRecoveryExperimentPending = false;
    if (verificationMode === 'autowin') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: autowin');
        const primaryBot = getSoloCombatBotBySlot(session, 1);
        if (primaryBot) {
          primaryBot.health = 0;
        }
        syncLegacySoloCombatBotState(session);
        send(
          session.socket,
          buildCmd66ActorDamagePacket(1, 1, 999, nextSeq(session)),
          capture,
          'CMD66_VERIFY_AUTOWIN',
        );
        stopBotCombatActions(session);
        if (primaryBot) {
          sendBotDeathTransition(session, primaryBot, connLog, capture, 'verify-autowin');
        }
        queueCombatResultTransition(
          players,
          session,
          connLog,
          capture,
          COMBAT_RESULT_VICTORY,
          'verify-autowin',
          BOT_RESULT_DELAY_MS,
        );
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'autolose') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: autolose');
        session.playerHealth = 0;
        session.combatPlayerHeadArmor = 0;
        session.combatPlayerArmorValues = Array<number>(10).fill(0);
        session.combatPlayerInternalValues = Array<number>(8).fill(0);
        send(
          session.socket,
          buildCmd67LocalDamagePacket(1, 999, nextSeq(session)),
          capture,
          'CMD67_VERIFY_AUTOLOSE',
        );
        if (session.botFireTimer !== undefined) {
          clearInterval(session.botFireTimer);
          session.botFireTimer = undefined;
        }
        queueCombatResultTransition(
          players,
          session,
          connLog,
          capture,
          COMBAT_RESULT_LOSS,
          'verify-autolose',
          PLAYER_RESULT_DELAY_MS,
        );
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'dmglocal' || verificationMode === 'dmgbot') {
      const sendSweep = (): void => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: %s sweep', verificationMode);

        VERIFY_DAMAGE_CODES.forEach((code, idx) => {
          setTimeout(() => {
            if (session.socket.destroyed || !session.socket.writable) return;
            if (verificationMode === 'dmglocal') {
              send(
                session.socket,
                buildCmd67LocalDamagePacket(code, 5, nextSeq(session)),
                capture,
                `CMD67_VERIFY_SWEEP_${code}`,
              );
            } else {
              send(
                session.socket,
                buildCmd66ActorDamagePacket(1, code, 5, nextSeq(session)),
                capture,
                `CMD66_VERIFY_SWEEP_${code}`,
              );
            }
          }, idx * VERIFY_SWEEP_STEP_MS).unref();
        });
      };

      setTimeout(sendSweep, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'strictfire') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: strictfire enforcement mode (ungated cmd10 rejected until recent cmd12/action0)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'headtest') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: head-only retaliation mode (bot Cmd67 hits forced to head until head destruction)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legtest') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg retaliation mode (bot Cmd67 hits forced to left leg until first non-death collapse)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legseq') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg fall-sequence mode (bot Cmd67 hits forced to left leg until first non-death Cmd70 1->8 probe)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legair') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg airborne sequence mode (bot Cmd67 hits forced to left leg until first non-death Cmd70 4->8->6 probe)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legfull') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg full-sequence mode (bot Cmd67 hits forced to left leg until first non-death Cmd70 1->4->8->6 probe)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legrecover') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg recovery mode (bot Cmd67 hits forced to left leg until first non-death Cmd70 1->8->0 probe)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legdefer') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg deferred-collapse mode (bot Cmd67 hits forced to left leg until first local-airborne Cmd70/8-only probe)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legdeferquiet') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info('[world/combat] scripted verification: left-leg deferred-collapse quiet mode (same probe, then suppress local Cmd65 landing/movement echoes after touchdown)');
      }, VERIFY_DELAY_MS).unref();
    } else if (verificationMode === 'legdefercmd73') {
      setTimeout(() => {
        if (session.socket.destroyed || !session.socket.writable) return;
        connLog.info(
          '[world/combat] scripted verification: left-leg deferred-collapse Cmd73 mode (rate probe %d/%d before local fall/recovery transitions)',
          CMD73_RATE_PROBE_A,
          CMD73_RATE_PROBE_B,
        );
      }, VERIFY_DELAY_MS).unref();
    } else {
      startBotCombatAi(players, session, connLog, capture);
    }

    session.combatInitialized = true;
    connLog.info('[world] combat entry complete for "%s"', callsign);
  }, COMBAT_DROP_DELAY_MS);
  session.combatBootstrapTimer.unref();
}

// ── Text commands ─────────────────────────────────────────────────────────────

function findSameRoomDuelTarget(
  players: PlayerRegistry,
  session: ClientSession,
  requestedName: string,
): ClientSession | undefined {
  const normalized = requestedName.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  return players.inRoom(session.roomId).find(other =>
    other.id !== session.id &&
    other.phase === 'world' &&
    other.worldInitialized &&
    !other.socket.destroyed &&
    getDisplayName(other).toLowerCase() === normalized,
  );
}

export function clearSessionDuelState(
  players: PlayerRegistry,
  session: ClientSession,
  connLog: Logger,
  reason: string,
): void {
  const outgoingTargetId = session.outgoingDuelInviteTargetSessionId;
  if (outgoingTargetId) {
    const target = players.get(outgoingTargetId);
    if (target?.pendingDuelInviteFromSessionId === session.id) {
      target.pendingDuelInviteFromSessionId = undefined;
      if (target.phase === 'world' && target.worldInitialized && !target.socket.destroyed) {
        sendToWorldSession(
          target,
          buildCmd3BroadcastPacket(
            `Duel request from ${getDisplayName(session)} cleared: ${reason}.`,
            nextSeq(target),
          ),
          'CMD3_DUEL_REQUEST_CLEARED',
        );
      }
    }
    session.outgoingDuelInviteTargetSessionId = undefined;
  }

  const incomingFromId = session.pendingDuelInviteFromSessionId;
  if (incomingFromId) {
    const challenger = players.get(incomingFromId);
    if (challenger?.outgoingDuelInviteTargetSessionId === session.id) {
      challenger.outgoingDuelInviteTargetSessionId = undefined;
      if (challenger.phase === 'world' && challenger.worldInitialized && !challenger.socket.destroyed) {
        sendToWorldSession(
          challenger,
          buildCmd3BroadcastPacket(
            `Duel request to ${getDisplayName(session)} cleared: ${reason}.`,
            nextSeq(challenger),
          ),
          'CMD3_DUEL_REQUEST_CLEARED',
        );
      }
    }
    session.pendingDuelInviteFromSessionId = undefined;
  }

  const combatSession = players.getCombatSession(session.combatSessionId);
  if (combatSession?.mode === 'duel') {
    const peerId = combatSession.participantSessionIds.find(id => id !== session.id);
    const peer = peerId ? players.get(peerId) : undefined;
    const peerCanReceiveResult = !!peer
      && combatSession.state === 'active'
      && reason === 'player disconnected'
      && peer.phase === 'combat'
      && peer.combatInitialized
      && !peer.socket.destroyed
      && peer.socket.writable;

    if (peerCanReceiveResult && peer) {
      clearCombatEjectArm(peer, connLog, 'opponent disconnected');
      stopSessionActiveCombatLoops(session);
      session.combatEjectArmed = false;
      queueDuelCombatResultTransition(
        players,
        peer,
        session,
        connLog,
        'opponent disconnected',
        PLAYER_RESULT_DELAY_MS,
      );
      connLog.info('[world/duel] disconnect converted to duel result winner="%s" loser="%s"', getDisplayName(peer), getDisplayName(session));
      session.pendingDuelInviteFromSessionId = undefined;
      session.outgoingDuelInviteTargetSessionId = undefined;
      return;
    }

    if (peer) {
      if (peer.combatSessionId === combatSession.id) {
        peer.combatSessionId = undefined;
      }
      if (peer.combatPeerSessionId === session.id) {
        peer.combatPeerSessionId = undefined;
      }
      peer.duelTermsAvailable = false;
      if (combatSession.state === 'active' && peer.phase === 'combat') {
        resetCombatState(peer);
        const peerCapture = worldCaptures.get(peer.id);
        deferWorldSceneRefreshAfterWelcome(
          players,
          peer,
          connLog,
          peerCapture,
          'WORLD_WELCOME_AFTER_DUEL_ABORT',
          `Duel with ${getDisplayName(session)} aborted: ${reason}.`,
          {
            notifyUnreadComstar: peerCapture !== undefined,
            notifyRoomArrival: true,
          },
        );
      } else if (peer.phase === 'world' && peer.worldInitialized && !peer.socket.destroyed) {
        if (!refreshWorldSceneIfPossible(
          players,
          peer,
          connLog,
          `Staged duel with ${getDisplayName(session)} cleared: ${reason}.`,
        )) {
          sendToWorldSession(
            peer,
            buildCmd3BroadcastPacket(
              `Staged duel with ${getDisplayName(session)} cleared: ${reason}.`,
              nextSeq(peer),
            ),
            'CMD3_DUEL_SESSION_CLEARED',
          );
        }
      }
    }
    players.removeCombatSession(combatSession.id);
    connLog.info('[world/duel] cleared duel session=%s state=%s reason=%s', combatSession.id, combatSession.state, reason);
  }

  session.combatSessionId = undefined;
  session.combatPeerSessionId = undefined;
  session.duelTermsAvailable = false;
}

function handleDuelTextCommand(
  players: PlayerRegistry,
  session: ClientSession,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const clean = text.replace(/\x1b/g, '?').trim();
  const lower = clean.toLowerCase();
  const sendLocalNotice = (message: string, label: string): void => {
    send(
      session.socket,
      buildCmd3BroadcastPacket(message, nextSeq(session)),
      capture,
      label,
    );
  };

  if (lower === '/duelstatus') {
    const combatSession = session.combatSessionId
      ? players.getCombatSession(session.combatSessionId)
      : undefined;
    if (combatSession?.mode === 'duel') {
      const peer = session.combatPeerSessionId ? players.get(session.combatPeerSessionId) : undefined;
      const duelStateLabel = combatSession.state === 'active'
        ? 'Active'
        : combatSession.state === 'completed'
          ? 'Completed'
          : 'Staged';
      const localStake = getCombatSessionStakeForParticipant(combatSession, session.id);
      const peerStake = peer ? getCombatSessionStakeForParticipant(combatSession, peer.id) : 0;
      sendLocalNotice(
        `${duelStateLabel} duel with ${peer ? getDisplayName(peer) : 'unknown opponent'}. ` +
        `Stakes: you=${localStake} cb, ${peer ? getDisplayName(peer) : 'opponent'}=${peerStake} cb. ` +
        `Balance=${getSessionCbills(session)} cb.`,
        'CMD3_DUEL_STATUS',
      );
      return true;
    }
    if (session.combatSessionId) {
      session.combatSessionId = undefined;
      session.combatPeerSessionId = undefined;
      session.duelTermsAvailable = false;
    }
    if (session.outgoingDuelInviteTargetSessionId) {
      const target = players.get(session.outgoingDuelInviteTargetSessionId);
      sendLocalNotice(
        `Outgoing duel request pending for ${target ? getDisplayName(target) : 'unknown player'}.`,
        'CMD3_DUEL_STATUS',
      );
      return true;
    }
    if (session.pendingDuelInviteFromSessionId) {
      const challenger = players.get(session.pendingDuelInviteFromSessionId);
      sendLocalNotice(
        `Incoming duel request pending from ${challenger ? getDisplayName(challenger) : 'unknown player'}.`,
        'CMD3_DUEL_STATUS',
      );
      return true;
    }
    sendLocalNotice('No duel request or staged duel is active.', 'CMD3_DUEL_STATUS');
    return true;
  }

  if (lower === '/duelterms') {
    sendStagedDuelTermsPanel(players, session, connLog, capture);
    return true;
  }

  if (lower === '/duelcancel') {
    const hadCombatSession = !!session.combatSessionId;
    if (
      !session.outgoingDuelInviteTargetSessionId &&
      !session.pendingDuelInviteFromSessionId &&
      !session.combatSessionId
    ) {
      sendLocalNotice('No duel request or staged duel to clear.', 'CMD3_DUEL_CANCEL_EMPTY');
      return true;
    }
    clearSessionDuelState(players, session, connLog, 'cancelled');
    if (
      hadCombatSession &&
      refreshWorldSceneIfPossible(players, session, connLog, 'Duel request/session cleared.')
    ) {
      return true;
    }
    sendLocalNotice('Duel request/session cleared.', 'CMD3_DUEL_CANCELLED');
    return true;
  }

  if (lower === '/declineduel') {
    if (!session.pendingDuelInviteFromSessionId) {
      sendLocalNotice('No incoming duel request to decline.', 'CMD3_DUEL_DECLINE_EMPTY');
      return true;
    }
    clearSessionDuelState(players, session, connLog, 'declined');
    sendLocalNotice('Duel request declined.', 'CMD3_DUEL_DECLINED');
    return true;
  }

  if (lower === '/acceptduel') {
    const challenger = session.pendingDuelInviteFromSessionId
      ? players.get(session.pendingDuelInviteFromSessionId)
      : undefined;
    const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
    const mapRoom = worldMapByRoomId.get(currentRoomId);
    if (mapRoom?.type !== 'arena') {
      sendLocalNotice('Duel requests only work in arena rooms.', 'CMD3_DUEL_NOT_ARENA');
      return true;
    }
    if (!challenger || challenger.socket.destroyed || challenger.phase !== 'world' || !challenger.worldInitialized) {
      clearSessionDuelState(players, session, connLog, 'challenger unavailable');
      sendLocalNotice('Duel request expired: challenger is no longer available.', 'CMD3_DUEL_ACCEPT_STALE');
      return true;
    }
    if (challenger.roomId !== session.roomId || challenger.outgoingDuelInviteTargetSessionId !== session.id) {
      clearSessionDuelState(players, session, connLog, 'challenger moved away');
      sendLocalNotice('Duel request expired: challenger is no longer in this arena room.', 'CMD3_DUEL_ACCEPT_STALE');
      return true;
    }
    if (session.combatSessionId || challenger.combatSessionId) {
      sendLocalNotice('A staged duel is already active for one of the players.', 'CMD3_DUEL_ACCEPT_BUSY');
      return true;
    }
    if (getSharedArenaSide(session, challenger) !== undefined) {
      clearSameSideDuelRequest(players, session, challenger, connLog);
      return true;
    }

    const combatSession = players.createDuelCombatSession(challenger, session);
    challenger.outgoingDuelInviteTargetSessionId = undefined;
    session.pendingDuelInviteFromSessionId = undefined;
    assignStagedDuelSession(challenger, session, combatSession.id);
    connLog.info(
      '[world/duel] staged duel session=%s room=%s players="%s" vs "%s"',
      combatSession.id,
      combatSession.roomId,
      getDisplayName(challenger),
      getDisplayName(session),
    );
    const localAcceptMessage =
      `Duel accepted. Staged PvP session ready with ${getDisplayName(challenger)}. Use /duelterms to review stakes or /fight to start.`;
    const peerAcceptMessage =
      `${getDisplayName(session)} accepted your duel. Staged PvP session ready. Use /duelterms to review stakes or /fight to start.`;
    if (!refreshWorldSceneIfPossible(players, session, connLog, localAcceptMessage)) {
      sendLocalNotice(localAcceptMessage, 'CMD3_DUEL_ACCEPTED');
    }
    if (!refreshWorldSceneIfPossible(players, challenger, connLog, peerAcceptMessage)) {
      sendToWorldSession(
        challenger,
        buildCmd3BroadcastPacket(
          peerAcceptMessage,
          nextSeq(challenger),
        ),
        'CMD3_DUEL_ACCEPTED',
      );
    }
    return true;
  }

  const duelMatch = clean.match(/^\/duel\s+(.+)$/i);
  if (!duelMatch) {
    return false;
  }

  const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;
  const mapRoom = worldMapByRoomId.get(currentRoomId);
  if (mapRoom?.type !== 'arena') {
    sendLocalNotice('Duel requests only work in arena rooms.', 'CMD3_DUEL_NOT_ARENA');
    return true;
  }
  if (session.combatSessionId) {
    sendLocalNotice('Clear the current staged duel before sending another challenge.', 'CMD3_DUEL_BUSY');
    return true;
  }
  if (session.outgoingDuelInviteTargetSessionId || session.pendingDuelInviteFromSessionId) {
    sendLocalNotice('Clear the current duel request before sending another challenge.', 'CMD3_DUEL_BUSY');
    return true;
  }

  const requestedName = duelMatch[1].trim();
  const target = findSameRoomDuelTarget(players, session, requestedName);
  if (!target) {
    sendLocalNotice(`No player named "${requestedName}" is standing in this room.`, 'CMD3_DUEL_TARGET_UNKNOWN');
    return true;
  }
  if (target.combatSessionId || target.outgoingDuelInviteTargetSessionId || target.pendingDuelInviteFromSessionId) {
    sendLocalNotice(`${getDisplayName(target)} is already busy with another duel request/session.`, 'CMD3_DUEL_TARGET_BUSY');
    return true;
  }
  if (getSharedArenaSide(session, target) !== undefined) {
    sendLocalNotice(
      `${getDisplayName(target)} is on ${getArenaSideLabel(target.worldArenaSide)}. Same-side pilots are teammates.`,
      'CMD3_DUEL_TARGET_TEAMMATE',
    );
    return true;
  }

  session.outgoingDuelInviteTargetSessionId = target.id;
  target.pendingDuelInviteFromSessionId = session.id;
  connLog.info('[world/duel] challenge sent: from="%s" to="%s"', getDisplayName(session), getDisplayName(target));
  sendLocalNotice(
    `Duel request sent to ${getDisplayName(target)}. They can /acceptduel or /declineduel.`,
    'CMD3_DUEL_SENT',
  );
  sendToWorldSession(
    target,
    buildCmd3BroadcastPacket(
      `${getDisplayName(session)} challenged you to a duel. Type /acceptduel or /declineduel.`,
      nextSeq(target),
    ),
    'CMD3_DUEL_INCOMING',
  );
  return true;
}

const WORLD_COMMAND_HELP_MAX_LINES = 10;

const WORLD_COMMAND_HELP_LINES = [
  'Available chat commands:',
  '/map | /travel - open the Solaris travel map',
  '/mech | /mechbay | /mechs - open the mech picker',
  '/bots | /botcount <1-7> | /botdifficulty <1-5> (/botdiff)',
  '/botside <slot> <player|enemy|1-8> - set bot side/team',
  '/botpick [slot] | /botmech <mech_id> | /botmech <slot> <mech_id>',
  '/fight | /fightrestart - start or restart non-duel combat',
  '/ready | /unready | /notready - arena ready-room status',
  '/duel <pilot> | /acceptduel | /declineduel',
  '/duelstatus | /duelterms | /duelcancel - duel status and stakes',
] as const;

if (WORLD_COMMAND_HELP_LINES.length > WORLD_COMMAND_HELP_MAX_LINES) {
  throw new Error(
    `WORLD_COMMAND_HELP_LINES exceeds the ${WORLD_COMMAND_HELP_MAX_LINES}-line client limit.`,
  );
}

export function sendWorldCommandHelp(
  session: ClientSession,
  capture: CaptureLogger,
): void {
  for (const line of WORLD_COMMAND_HELP_LINES) {
    send(
      session.socket,
      buildCmd3BroadcastPacket(line, nextSeq(session)),
      capture,
      'CMD3_HELP',
    );
  }
}

export function handleWorldTextCommand(
  players: PlayerRegistry,
  session: ClientSession,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const clean = text.replace(/\x1b/g, '?').trim();
  const lower = clean.toLowerCase();
  if (clean.length === 0) {
    connLog.debug('[world] cmd-4 text ignored (empty)');
    return;
  }

  if (lower === '/help') {
    sendWorldCommandHelp(session, capture);
    return;
  }

  if (lower === '/map' || lower === '/travel') {
    sendSolarisTravelMap(session, connLog, capture);
    return;
  }

  if (lower === '/mech' || lower === '/mechbay' || lower === '/mechs') {
    sendMechClassPicker(session, connLog, capture);
    return;
  }

  if (lower === '/ready' || lower === '/unready' || lower === '/notready') {
    if (session.phase !== 'world' || !session.worldInitialized || !isArenaRoom(session)) {
      send(
        session.socket,
        buildCmd3BroadcastPacket('READY commands only work in arena ready rooms.', nextSeq(session)),
        capture,
        'CMD3_ARENA_READY_CMD_INVALID',
      );
      return;
    }
    const wantReady = lower === '/ready';
    if ((session.worldArenaReady === true) === wantReady) {
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          wantReady ? 'Arena ready already set.' : 'Arena ready already clear.',
          nextSeq(session),
        ),
        capture,
        wantReady ? 'CMD3_ARENA_READY_ALREADY_SET' : 'CMD3_ARENA_READY_ALREADY_CLEAR',
      );
      return;
    }
    handleArenaReadyToggle(players, session, connLog, capture);
    return;
  }

  if (handleDuelTextCommand(players, session, clean, connLog, capture)) {
    return;
  }

  // /icons [start] — send a fake scene with 4 exit slots showing icons N, N+1,
  // N+2, N+3.  Used to empirically map icon IDs to their displayed graphics.
  const iconsMatch = clean.match(/^\/icons(?:\s+(\d+))?$/i);
  if (iconsMatch) {
    const base = parseInt(iconsMatch[1] ?? '0', 10);
    connLog.info('[world] /icons test: base=%d', base);
    send(
      session.socket,
      buildCmd4SceneInitPacket(
        {
          sessionFlags:    0x30 | 0x0F,  // all 4 slots enabled
          playerScoreSlot: 0,
          playerMechId:    base,
          opponents: [
            { type: 0, mechId: base },
            { type: 0, mechId: base + 1 },
            { type: 0, mechId: base + 2 },
            { type: 0, mechId: base + 3 },
          ],
          sceneHeader: `Icons ${base}-${base + 3}`,
          sceneDetail: '',
          arenaOptions: [
            { type: 0, label: 'Help' },
            { type: SOLARIS_TRAVEL_ACTION_TYPE, label: 'Travel' },
          ],
        },
        nextSeq(session),
      ),
      capture,
      'CMD4_ICONS_TEST',
    );
    send(
      session.socket,
      buildCmd3BroadcastPacket(
        `N=${base} S=${base+1} E=${base+2} W=${base+3}  (center=${base})  Type /icons ${base+4} for next batch.`,
        nextSeq(session),
      ),
      capture,
      'CMD3_ICONS_LABEL',
    );
    return;
  }

  const line = `${getDisplayName(session)}: ${clean}`;
  connLog.info('[world] cmd-4 text: %s', line);

  if (handleBotMechTextCommand(session, clean, connLog, capture)) {
    return;
  }

  const senderStatus  = getPresenceStatus(session);
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

export function handleBotMechTextCommand(
  session: ClientSession,
  text: string,
  connLog: Logger,
  capture: CaptureLogger,
  options: {
    suppressBroadcast?: boolean;
  } = {},
): boolean {
  const clean = text.replace(/\x1b/g, '?').trim();
  const sendLocalNotice = (message: string, label: string): void => {
    if (!options.suppressBroadcast) {
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          message,
          nextSeq(session),
        ),
        capture,
        label,
      );
    }
  };

  if (/^\/bots$/i.test(clean)) {
    sendLocalNotice(buildBotConfigurationSummary(session), 'CMD3_BOT_CONFIG_SUMMARY');
    return true;
  }

  const botCountMatch = clean.match(/^\/botcount\s+(\d+)$/i);
  if (botCountMatch) {
    const requestedCount = parseInt(botCountMatch[1], 10);
    if (!Number.isFinite(requestedCount) || requestedCount < 1 || requestedCount > MAX_SINGLE_PLAYER_BOT_OPPONENTS) {
      sendLocalNotice(
        `Bot count must be between 1 and ${MAX_SINGLE_PLAYER_BOT_OPPONENTS}.`,
        'CMD3_BOTCOUNT_INVALID',
      );
      return true;
    }
    session.combatBotOpponentCount = requestedCount;
    worldResumeRegistry.save(session);
    connLog.info('[world] /botcount: configured %d bot opponents', requestedCount);
    sendLocalNotice(
      `${buildBotConfigurationSummary(session)} Use /botside <slot> <player|enemy|1-8>, /botpick <slot>, /botmech <slot> <mech_id>, or /botdifficulty <1-5> to change bot setup.`,
      'CMD3_BOTCOUNT_ACK',
    );
    return true;
  }

  const botDifficultyMatch = clean.match(/^\/bot(?:difficulty|diff)\s+(\d+)$/i);
  if (botDifficultyMatch) {
    const requestedDifficulty = parseInt(botDifficultyMatch[1], 10);
    if (!Number.isFinite(requestedDifficulty) || requestedDifficulty < 1 || requestedDifficulty > 5) {
      sendLocalNotice('Bot difficulty must be between 1 and 5.', 'CMD3_BOTDIFFICULTY_INVALID');
      return true;
    }
    session.combatBotDifficultyLevel = clampBotDifficultyLevel(requestedDifficulty);
    worldResumeRegistry.save(session);
    connLog.info('[world] /botdifficulty: configured bot difficulty=%d', session.combatBotDifficultyLevel);
    sendLocalNotice(
      `Bot difficulty set to ${getConfiguredBotDifficultyLevel(session)}/5. ${buildBotConfigurationSummary(session)}`,
      'CMD3_BOTDIFFICULTY_ACK',
    );
    return true;
  }

  const botSideMatch = clean.match(/^\/bot(?:side|team)\s+(\d+)\s+([^\s]+)$/i);
  if (botSideMatch) {
    const requestedSlot = parseInt(botSideMatch[1], 10);
    if (!Number.isFinite(requestedSlot) || requestedSlot < 1 || requestedSlot > MAX_SINGLE_PLAYER_BOT_OPPONENTS) {
      sendLocalNotice(
        `Bot slot must be between 1 and ${MAX_SINGLE_PLAYER_BOT_OPPONENTS}.`,
        'CMD3_BOTSIDE_INVALID_SLOT',
      );
      return true;
    }

    const requestedSideToken = botSideMatch[2].toLowerCase();
    let requestedSide: number | undefined;
    if (requestedSideToken === 'player' || requestedSideToken === 'ally' || requestedSideToken === 'friendly') {
      requestedSide = getConfiguredSoloCombatPlayerSide(session);
    } else if (requestedSideToken === 'enemy' || requestedSideToken === 'opponent' || requestedSideToken === 'hostile') {
      requestedSide = getConfiguredSoloCombatDefaultEnemySide(session);
    } else if (/^\d+$/.test(requestedSideToken)) {
      requestedSide = parseInt(requestedSideToken, 10);
    }

    if (!Number.isFinite(requestedSide) || requestedSide === undefined || requestedSide < MIN_SOLO_COMBAT_SIDE || requestedSide > MAX_SOLO_COMBAT_SIDE) {
      sendLocalNotice(
        `Bot side must be player, enemy, or a side between ${MIN_SOLO_COMBAT_SIDE} and ${MAX_SOLO_COMBAT_SIDE}.`,
        'CMD3_BOTSIDE_INVALID_SIDE',
      );
      return true;
    }

    setConfiguredBotSide(session, requestedSlot - 1, requestedSide);
    worldResumeRegistry.save(session);
    connLog.info('[world] /botside: slot=%d configured side=%d', requestedSlot, requestedSide);
    sendLocalNotice(
      `Bot ${requestedSlot} side set to ${getConfiguredBotSideSummaryLabel(session, requestedSlot - 1)}. ${buildBotConfigurationSummary(session)}`,
      'CMD3_BOTSIDE_ACK',
    );
    return true;
  }

  const botPickMatch = clean.match(/^\/botpick(?:\s+(\d+))?$/i);
  if (botPickMatch) {
    if (session.phase !== 'world') {
      sendLocalNotice('Bot mech picker is only available in world mode.', 'CMD3_BOTPICK_INVALID_PHASE');
      return true;
    }
    const requestedSlot = parseInt(botPickMatch[1] ?? '1', 10);
    if (!Number.isFinite(requestedSlot) || requestedSlot < 1 || requestedSlot > MAX_SINGLE_PLAYER_BOT_OPPONENTS) {
      sendLocalNotice(
        `Bot slot must be between 1 and ${MAX_SINGLE_PLAYER_BOT_OPPONENTS}.`,
        'CMD3_BOTPICK_INVALID_SLOT',
      );
      return true;
    }
    session.combatBotOpponentCount = Math.max(getConfiguredBotOpponentCount(session), requestedSlot);
    worldResumeRegistry.save(session);
    connLog.info('[world] /botpick: opening mech picker for bot slot=%d', requestedSlot);
    sendMechClassPicker(session, connLog, capture, { target: 'bot', botIndex: requestedSlot - 1 });
    return true;
  }

  const botMechSlotMatch = clean.match(/^\/botmech\s+(\d+)\s+(\d+)$/i);
  const botMechSingleMatch = clean.match(/^\/botmech\s+(\d+)$/i);
  if (!botMechSlotMatch && !botMechSingleMatch) {
    return false;
  }

  const requestedSlot = botMechSlotMatch ? parseInt(botMechSlotMatch[1], 10) : 1;
  const requestedId = parseInt((botMechSlotMatch ? botMechSlotMatch[2] : botMechSingleMatch?.[1]) ?? '0', 10);
  if (!Number.isFinite(requestedSlot) || requestedSlot < 1 || requestedSlot > MAX_SINGLE_PLAYER_BOT_OPPONENTS) {
    sendLocalNotice(
      `Bot slot must be between 1 and ${MAX_SINGLE_PLAYER_BOT_OPPONENTS}.`,
      'CMD3_BOTMECH_INVALID_SLOT',
    );
    return true;
  }

  const mechEntry = WORLD_MECH_BY_ID.get(requestedId);
  if (!mechEntry) {
    connLog.warn('[world] /botmech: unknown mech_id=%d slot=%d', requestedId, requestedSlot);
    sendLocalNotice(
      `Unknown mech_id ${requestedId}. Use /mechs to browse available mechs.`,
      'CMD3_BOTMECH_UNKNOWN',
    );
    return true;
  }

  setConfiguredBotLoadoutId(session, requestedSlot - 1, requestedId);
  worldResumeRegistry.save(session);
  connLog.info(
    '[world] /botmech: slot=%d bot mech set to %s (id=%d)',
    requestedSlot,
    mechEntry.typeString,
    requestedId,
  );
  sendLocalNotice(
    `Bot ${requestedSlot} mech set to ${mechEntry.typeString} (id=${requestedId}). ${buildBotConfigurationSummary(session)}`,
    'CMD3_BOTMECH_ACK',
  );
  return true;
}

// ── Map travel ────────────────────────────────────────────────────────────────

export function handleMapTravelReply(
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

  if (worldMapByRoomId.get(selectedRoomId)?.type === 'arena') {
    openArenaReadyRoomMenu(players, session, selectedRoomId, connLog, capture);
    return;
  }

  if (oldRoomId === newRoomId) {
    send(
      session.socket,
      buildCmd3BroadcastPacket(`Already at room ${selectedRoomId}.`, nextSeq(session)),
      capture,
      'CMD3_TRAVEL_ALREADY_THERE',
    );
    return;
  }

  const arenaEntryRejection = getArenaRoomEntryRejection(players, session, selectedRoomId);
  if (arenaEntryRejection) {
    connLog.warn(
      '[world] cmd-10 map reply rejected: target arena room=%d full for callsign="%s"',
      selectedRoomId,
      getDisplayName(session),
    );
    sendSceneRefresh(players, session, connLog, capture, arenaEntryRejection);
    return;
  }

  clearSessionDuelState(players, session, connLog, `left ${getSolarisRoomName(session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID)}`);
  notifyRoomDeparture(players, session, connLog);
  session.roomId = newRoomId;
  setSessionRoomPosition(session, selectedRoomId);
  clearPendingArenaReadyRoomSelection(session);
  session.worldArenaReadyRoomId = undefined;
  session.worldArenaSide = undefined;
  session.worldArenaReady = undefined;
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

export function handleLocationAction(
  players: PlayerRegistry,
  session: ClientSession,
  slot: number,
  targetCached: boolean,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  const currentRoomId = session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID;

  // Resolve exit by compass slot (0=N 1=S 2=E 3=W).  Must use the shared slotted
  // exit helper so slot indices stay aligned with Cmd4 and inter-sector/tram
  // rules are enforced consistently in both render and click paths.
  const targetRoomId = getSolarisRoomSlottedExits(currentRoomId)[slot] ?? undefined;

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

  if (worldMapByRoomId.get(targetRoomId)?.type === 'tram') {
    connLog.info('[world] cmd-23 tram icon: room=%d slot=%d -> opening Solaris map', currentRoomId, slot);
    sendSolarisTravelMap(session, connLog, capture);
    return;
  }

  if (worldMapByRoomId.get(targetRoomId)?.type === 'arena') {
    openArenaReadyRoomMenu(players, session, targetRoomId, connLog, capture);
    return;
  }

  const arenaEntryRejection = getArenaRoomEntryRejection(players, session, targetRoomId);
  if (arenaEntryRejection) {
    connLog.warn(
      '[world] cmd-23 location rejected: target arena room=%d full for callsign="%s"',
      targetRoomId,
      getDisplayName(session),
    );
    sendSceneRefresh(players, session, connLog, capture, arenaEntryRejection);
    return;
  }

  clearSessionDuelState(players, session, connLog, `left ${getSolarisRoomName(currentRoomId)}`);
  notifyRoomDeparture(players, session, connLog);
  session.roomId = mapRoomKey(targetRoomId);
  setSessionRoomPosition(session, targetRoomId);
  clearPendingArenaReadyRoomSelection(session);
  session.worldArenaReadyRoomId = undefined;
  session.worldArenaSide = undefined;
  session.worldArenaReady = undefined;
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

// ── Room arrival / departure notifications ────────────────────────────────────

export function notifyRoomArrival(
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

export function notifyRoomDeparture(
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

export function handleArenaSideSelection(
  players: PlayerRegistry,
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.phase !== 'world' || !session.worldInitialized || !isArenaRoom(session)) {
    connLog.warn('[world] arena side selection ignored outside arena room: phase=%s room=%d',
      session.phase, session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID);
    return;
  }
  if (selection < 1 || selection > 8) {
    send(
      session.socket,
      buildCmd3BroadcastPacket('Arena side selection cancelled.', nextSeq(session)),
      capture,
      'CMD3_ARENA_SIDE_CANCELLED',
    );
    return;
  }

  session.worldArenaSide = selection;
  const readyCleared = session.worldArenaReady === true;
  const duelCleared = hasPendingArenaDuelState(session);
  if (duelCleared) {
    clearSessionDuelState(players, session, connLog, 'side changed');
  }
  session.worldArenaReady = undefined;
  worldResumeRegistry.save(session);
  sendSceneRefresh(
    players,
    session,
    connLog,
    capture,
    `Arena side set: ${getArenaSideLabel(selection)}.${readyCleared ? ' Ready cleared.' : ''}${duelCleared ? ' Duel state cleared.' : ''}`,
  );
  sendArenaStatusList(players, session, connLog, capture);
  sendArenaReadyReminder(session, capture);
  connLog.info(
    '[world] arena side selected: callsign="%s" side=%d room=%d',
    getDisplayName(session),
    selection,
    session.worldMapRoomId ?? DEFAULT_MAP_ROOM_ID,
  );
}

// ── Combat movement / action frames ───────────────────────────────────────────

export function handleCombatMovementFrame(
  players: PlayerRegistry,
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.combatResultCode !== undefined) {
    connLog.debug('[world/combat] cmd8/cmd9 ignored while result transition is pending');
    return;
  }

  clearCombatEjectArm(session, connLog, 'movement input');

  const cmd = payload[2] - 0x21;

  if (cmd === 8) {
    const frame = parseClientCmd8Coasting(payload);
    if (!frame) return;
    const now = Date.now();
    const clientSpeed = frame.speedRaw - MOTION_NEUTRAL;
    const previousX = session.combatX ?? (frame.xRaw - COORD_BIAS);
    const previousY = session.combatY ?? (frame.yRaw - COORD_BIAS);
    const nextPosition = clampAcceptedCombatPosition(
      session,
      frame.xRaw - COORD_BIAS,
      frame.yRaw - COORD_BIAS,
      clientSpeed,
      now,
    );
    session.combatX          = nextPosition.x;
    session.combatY          = nextPosition.y;
    setPlayerMoveVector(session, nextPosition.x - previousX, nextPosition.y - previousY);
    syncCombatAltitudeFromClientFrame(session, frame.altitudeRaw);
    session.combatFacingRaw = frame.facingRaw;
    session.combatLastMoveAt = now;

    if (clientSpeed !== 0) {
      session.combatSpeedMag = nextPosition.speedMag;
      if (nextPosition.clamped) {
        send(
          session.socket,
          buildCmd65PositionSyncPacket(
            {
              slot:     0,
              x:        session.combatX,
              y:        session.combatY,
              z:        getLocalCmd65Altitude(session),
              facing:   getCombatCmd65Facing(session),
              throttle: session.combatUpperBodyPitch ?? 0,
              legVel:   session.combatTorsoYaw ?? 0,
              speedMag: session.combatSpeedMag ?? 0,
            },
            nextSeq(session),
          ),
          capture,
          'CMD65_MOVEMENT_REVERSE_CLAMP',
        );
        connLog.debug(
          '[world/combat] cmd8 reverse clamp: clientSpeed=%d effectiveSpeed=%d elapsed=%dms submitted=%d allowed=%d',
          clientSpeed,
          nextPosition.speedMag,
          nextPosition.elapsedMs ?? 0,
          nextPosition.submittedDistanceUnits ?? 0,
          nextPosition.maxDistanceUnits ?? 0,
        );
      }
      mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_REMOTE_COAST');
      maybeLogCollisionProbeCandidate(players, session, connLog, 'CMD8_COAST');
      connLog.debug(
        '[world/combat] cmd8 coasting: x=%d y=%d altitude=%d facingRaw=%d clientSpeed=%d effectiveSpeed=%d%s',
        session.combatX,
        session.combatY,
        frame.altitudeRaw,
        frame.facingRaw,
        clientSpeed,
        nextPosition.speedMag,
        nextPosition.clamped ? ' -> reverse clamp correction sent' : ' -> no echo (trust local key events)',
      );
      return;
    }

    // clientSpeed === 0 → mech has fully stopped; reset so the next KP8 press
    // is treated as a fresh startup (breaks the trap correctly).
    setPlayerMoveVector(session, 0, 0);
    session.combatSpeedMag  = 0;
    mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_REMOTE_STOP');
    maybeLogCollisionProbeCandidate(players, session, connLog, 'CMD8_STOP');
    connLog.debug(
      '[world/combat] cmd8 coasting: x=%d y=%d altitude=%d facingRaw=%d clientSpeed=0 suppressing echo (stopped)',
      session.combatX, session.combatY, frame.altitudeRaw, frame.facingRaw,
    );
    return;
  }

  if (cmd === 9) {
    const frame = parseClientCmd9Moving(payload);
    if (!frame) return;
    const upperBodyPitch = (frame.upperBodyPitchRaw - MOTION_NEUTRAL) * MOTION_DIV;
    const torsoYaw = (frame.torsoYawRaw - MOTION_NEUTRAL) * MOTION_DIV;

    // iVar5 from FUN_0042c7a0: actual physics speed (+ve=forward, -ve=reverse).
    const clientSpeed = frame.speedRaw - MOTION_NEUTRAL;
    const now = Date.now();
    const previousX = session.combatX ?? (frame.xRaw - COORD_BIAS);
    const previousY = session.combatY ?? (frame.yRaw - COORD_BIAS);
    const nextPosition = clampAcceptedCombatPosition(
      session,
      frame.xRaw - COORD_BIAS,
      frame.yRaw - COORD_BIAS,
      clientSpeed,
      now,
    );
    session.combatX          = nextPosition.x;
    session.combatY          = nextPosition.y;
    setPlayerMoveVector(session, nextPosition.x - previousX, nextPosition.y - previousY);
    syncCombatAltitudeFromClientFrame(session, frame.altitudeRaw);
    session.combatFacingRaw = frame.facingRaw;
    session.combatLastMoveAt = now;

    // Ghidra: Cmd9 writes the two post-neutral type1 fields straight into
    // DAT_004f1f7c / DAT_004f1f7a, so keep them in Cmd65 units with no sign flip.
    const throttle = upperBodyPitch;
    const legVel   = torsoYaw;
    session.combatUpperBodyPitch = throttle;
    session.combatTorsoYaw = legVel;
    session.combatSpeedMag = nextPosition.speedMag;

    if (session.combatSuppressLocalCmd65WhileDowned && session.combatLocalDowned) {
      connLog.debug('[world/combat] cmd9 moving: suppressing local Cmd65 movement echo while local downed verifier is active');
    } else if (nextPosition.clamped) {
      send(
        session.socket,
        buildCmd65PositionSyncPacket(
          {
            slot:     0,
            x:        session.combatX,
            y:        session.combatY,
            z:        getLocalCmd65Altitude(session),
            facing:   getCombatCmd65Facing(session),
            throttle,
            legVel,
            speedMag: session.combatSpeedMag ?? 0,
          },
          nextSeq(session),
        ),
        capture,
        'CMD65_MOVEMENT_CORRECTION',
      );
    }
    const localEchoDetail =
      session.combatSuppressLocalCmd65WhileDowned && session.combatLocalDowned
        ? ' localEcho=suppressed-while-downed'
        : nextPosition.clamped
          ? ` localEcho=correction elapsed=${nextPosition.elapsedMs ?? 0}ms submitted=${nextPosition.submittedDistanceUnits ?? 0} allowed=${nextPosition.maxDistanceUnits ?? 0}`
          : ' localEcho=none';
    connLog.debug(
      '[world/combat] cmd9 moving: altitude=%d facingRaw=%d pitchRaw=%d torsoYawRaw=%d clientSpeed=%d effectiveSpeed=%d pitch=%d torsoYaw=%d%s',
      frame.altitudeRaw,
      frame.facingRaw,
      frame.upperBodyPitchRaw,
      frame.torsoYawRaw,
      clientSpeed,
      nextPosition.speedMag,
      throttle,
      legVel,
      localEchoDetail,
    );
    mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_REMOTE_MOVEMENT');
    maybeLogCollisionProbeCandidate(players, session, connLog, 'CMD9_MOVEMENT');
  }
}

export function handleCombatWeaponFireFrame(
  players: PlayerRegistry,
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.combatResultCode !== undefined) {
    connLog.debug('[world/combat] cmd10 ignored while result transition is pending');
    return;
  }

  clearCombatEjectArm(session, connLog, 'weapon fire');

  const shots = parseClientCmd10WeaponFire(payload);
  if (!shots || shots.length === 0) {
    connLog.warn('[world/combat] cmd-10 weapon fire parse failed (len=%d)', payload.length);
    return;
  }

  const now = Date.now();
  const actionAgeMs = session.lastCombatFireActionAt === undefined
    ? undefined
    : now - session.lastCombatFireActionAt;
  const hasRecentFireAction = actionAgeMs !== undefined && actionAgeMs >= 0 && actionAgeMs <= FIRE_ACTION_WINDOW_MS;
  const firePath = hasRecentFireAction ? 'selected-weapon' : 'direct-cmd10';
  if (session.combatRequireAction0 && !hasRecentFireAction) {
    session.combatShotsRejected = (session.combatShotsRejected ?? 0) + shots.length;
    connLog.debug(
      '[world/combat] cmd10 shot REJECTED: strict action0 gate (no recent cmd12/action0, age=%s records=%d)',
      actionAgeMs === undefined ? 'n/a' : `${actionAgeMs}ms`,
      shots.length,
    );
    return;
  }

  const combatSession = players.getCombatSession(session.combatSessionId);
  const blockedFriendlyShotSummaries: string[] = [];
  const fireableShots = [];
  for (const shot of shots) {
    const mountGate = getWeaponMountGate(session, shot.weaponSlot);
    if (!mountGate.allowed) {
      connLog.info(
        '[world/combat] cmd10 shot REJECTED: weapon slot=%d unavailable (%s)',
        shot.weaponSlot,
        mountGate.reason ?? 'mount unavailable',
      );
      continue;
    }

    const cooldownGate = getWeaponCooldownGate(session, shot.weaponSlot, now);
    if (!cooldownGate.allowed) {
      connLog.info(
        '[world/combat] cmd10 shot REJECTED: weapon slot=%d cooling down (%s remaining=%dms/%dms)',
        shot.weaponSlot,
        cooldownGate.weaponName ?? 'unknown',
        cooldownGate.remainingMs ?? 0,
        cooldownGate.cooldownMs ?? 0,
        );
      continue;
    }

    if (combatSession?.mode === 'arena' && combatSession.state === 'active') {
      const target = getCombatTargetParticipantForViewerSlot(players, combatSession, session, shot.targetSlot);
      const friendlyTarget = !!target
        && !target.socket.destroyed
        && target.phase === 'combat'
        && target.combatSessionId === combatSession.id
        && target.combatResultCode === undefined
        && (target.playerHealth ?? 1) > 0
        && session.worldArenaSide !== undefined
        && session.worldArenaSide === target.worldArenaSide;
      if (friendlyTarget) {
        const { damage: shotDamage, weaponName } = getShotDamage(session, shot.weaponSlot);
        blockedFriendlyShotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:friendly-fire-blocked:${getDisplayName(target)}`,
        );
        continue;
      }
    } else {
      const targetBot = shot.targetSlot <= 0 ? undefined : getSoloCombatBotBySlot(session, shot.targetSlot);
      const friendlyTarget = !!targetBot
        && targetBot.health > 0
        && targetBot.side === getConfiguredSoloCombatPlayerSide(session);
      if (friendlyTarget) {
        const { damage: shotDamage, weaponName } = getShotDamage(session, shot.weaponSlot);
        blockedFriendlyShotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:friendly-fire-blocked:slot=${targetBot.slot}`,
        );
        continue;
      }
    }

    const ammoGate = consumeWeaponAmmo(session, shot.weaponSlot);
    if (!ammoGate.allowed) {
      connLog.info(
        '[world/combat] cmd10 shot REJECTED: weapon slot=%d out of ammo (%s)',
        shot.weaponSlot,
        ammoGate.weaponName ?? 'unknown',
      );
      continue;
    }

    fireableShots.push(shot);
    markWeaponSlotFired(session, shot.weaponSlot, cooldownGate.cooldownMs, now);
  }
  const rejectedWeaponStateShots = shots.length - fireableShots.length;
  session.combatShotsAccepted = (session.combatShotsAccepted ?? 0) + fireableShots.length;
  session.combatShotsRejected = (session.combatShotsRejected ?? 0) + rejectedWeaponStateShots;
  if (hasRecentFireAction) {
    session.combatShotsAction0Correlated = (session.combatShotsAction0Correlated ?? 0) + fireableShots.length;
    connLog.debug(
      '[world/combat] cmd10 %s path: correlated with cmd12/action0 (age=%dms records=%d)',
      firePath,
      actionAgeMs,
      fireableShots.length,
    );
    clearPendingCombatAction0Followup(session);
    session.lastCombatFireActionAt = undefined;
  } else {
    session.combatShotsDirectCmd10 = (session.combatShotsDirectCmd10 ?? 0) + fireableShots.length;
    connLog.debug(
      '[world/combat] cmd10 %s path: no recent cmd12/action0 (age=%s records=%d) — compatible with TIC fire geometry',
      firePath,
      actionAgeMs === undefined ? 'n/a' : `${actionAgeMs}ms`,
      fireableShots.length,
    );
  }
  if (fireableShots.length === 0) {
    if (blockedFriendlyShotSummaries.length > 0) {
      connLog.info(
        '[world/combat] cmd10 friendly fire blocked: firePath=%s records=%d shots=[%s]',
        firePath,
        blockedFriendlyShotSummaries.length,
        blockedFriendlyShotSummaries.join(','),
      );
    }
    return;
  }

  if (combatSession?.mode === 'duel') {
    const duelPeer = getActiveDuelPeer(players, session);
    if (!duelPeer) {
      connLog.debug(
        '[world/combat] duel cmd10 ignored: session=%s state=%s peer unavailable',
        combatSession.id,
        combatSession.state,
      );
      return;
    }

    const duelPeerMechId = duelPeer.selectedMechId ?? FALLBACK_MECH_ID;
    const duelPeerMechEntry = WORLD_MECH_BY_ID.get(duelPeerMechId);
    const duelPeerArmorValues = [...(duelPeer.combatPlayerArmorValues ?? duelPeerMechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
    const duelPeerInternalValues = [...(duelPeer.combatPlayerInternalValues ?? (duelPeerMechEntry ? mechInternalStateBytes(duelPeerMechEntry.tonnage) : DEFAULT_BOT_INTERNAL_VALUES))];
    const duelPeerCriticalStateBytes = [...(duelPeer.combatPlayerCriticalStateBytes ?? createCriticalStateBytes(duelPeerMechEntry?.extraCritCount))];
    let duelPeerHeadArmor = duelPeer.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE;
    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_RESET');
    sendToWorldSession(duelPeer, buildCmd71ResetEffectStatePacket(nextSeq(duelPeer)), 'CMD71_DUEL_REMOTE_RESET');
    const shotSummaries = [...blockedFriendlyShotSummaries];
    let totalDamageUpdates = 0;

    for (const shot of fireableShots) {
      const { damage: shotDamage, weaponName, weaponSpec } = getShotDamage(session, shot.weaponSlot);
      const rangeGate = getShotMaxRangeGate(
        session,
        shot.weaponSlot,
        duelPeer.combatX,
        duelPeer.combatY,
      );
      send(
        session.socket,
        buildCmd68ProjectileSpawnPacket(
          {
            sourceSlot:   0,
            weaponSlot:   shot.weaponSlot,
            targetRaw:    shot.targetSlot < 0 ? 0 : shot.targetSlot + 1,
            targetAttach: shot.targetAttach < 0 ? 0 : shot.targetAttach + 1,
            angleSeedA:   shot.angleSeedA,
            angleSeedB:   shot.angleSeedB,
            impactX:      shot.impactXRaw - COORD_BIAS,
            impactY:      shot.impactYRaw - COORD_BIAS,
            impactZ:      shot.impactZ,
          },
          nextSeq(session),
        ),
        capture,
        'CMD68_PROJECTILE',
      );
      sendToWorldSession(
        duelPeer,
        buildCmd68ProjectileSpawnPacket(
          {
            sourceSlot:   1,
            weaponSlot:   shot.weaponSlot,
            targetRaw:    shot.targetSlot < 0 ? 0 : 10,
            targetAttach: shot.targetAttach < 0 ? 0 : shot.targetAttach + 1,
            angleSeedA:   shot.angleSeedA,
            angleSeedB:   shot.angleSeedB,
            impactX:      shot.impactXRaw - COORD_BIAS,
            impactY:      shot.impactYRaw - COORD_BIAS,
            impactZ:      shot.impactZ,
          },
          nextSeq(duelPeer),
        ),
        'CMD68_DUEL_REMOTE_PROJECTILE',
      );
      if (!rangeGate.allowed) {
        shotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:out-of-range:${Math.round(rangeGate.distanceMeters ?? -1)}/${rangeGate.maxRangeMeters ?? 'n/a'}m`,
        );
        continue;
      }
      const impactContext = buildTargetImpactContext(
        shot.impactXRaw - COORD_BIAS,
        shot.impactYRaw - COORD_BIAS,
        shot.impactZ,
        duelPeer.combatX ?? 0,
        duelPeer.combatY ?? 0,
        duelPeer.combatJumpAltitude ?? 0,
        getCombatCmd65Facing(duelPeer),
      );
      const hitSection = resolveEffectiveHitSection(
        duelPeerMechId,
        shot.targetAttach,
        shot.impactZ,
        duelPeerArmorValues,
        duelPeerInternalValues,
        impactContext,
      );
      const previousInternalValues = [...duelPeerInternalValues];
      const damageResult = applyWeaponDamage(
        weaponSpec,
        shotDamage,
        hitSection,
        shot.weaponSlot,
        shot.targetAttach,
        shot.angleSeedA,
        shot.angleSeedB,
        duelPeerArmorValues,
        duelPeerInternalValues,
        duelPeerHeadArmor,
      );
      const postDamageUpdates = collectPostDamageStateUpdates(
        duelPeerMechId,
        duelPeerCriticalStateBytes,
        previousInternalValues,
        duelPeerInternalValues,
        damageResult.headInternalDamaged,
      );
      duelPeerHeadArmor = damageResult.headArmor;
      const allUpdates = [...damageResult.updates, ...postDamageUpdates.updates];
      for (const update of allUpdates) {
        send(
          session.socket,
          buildCmd66ActorDamagePacket(1, update.damageCode, update.damageValue, nextSeq(session)),
          capture,
          'CMD66_DUEL_REMOTE_DAMAGE',
        );
        sendToWorldSession(
          duelPeer,
          buildCmd67LocalDamagePacket(update.damageCode, update.damageValue, nextSeq(duelPeer)),
          'CMD67_DUEL_LOCAL_DAMAGE',
        );
      }
      if (postDamageUpdates.newlyDestroyedLegs.length > 0 && !isActorDestroyed(duelPeerInternalValues)) {
        const collapseReason = `${postDamageUpdates.newlyDestroyedLegs.map(leg => leg.label).join('+')} destroyed`;
        const transitionMode = duelPeer.combatLegLossTransitionMode ?? 'collapse-only';
        sendCombatLegLossCollapse(session, 1, connLog, collapseReason, 'CMD70_DUEL_REMOTE_LEG_COLLAPSE', capture, transitionMode);
        sendCombatLegLossCollapse(duelPeer, 0, connLog, collapseReason, 'CMD70_DUEL_LOCAL_LEG_COLLAPSE', undefined, transitionMode);
      }

      totalDamageUpdates += allUpdates.length;
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:${summarizeHitSections(damageResult.hitSections)}:mech=${duelPeerMechId}:model=${getCombatModelIdForMechId(duelPeerMechId) ?? 'n/a'}:attach=${shot.targetAttach}:peerHealth=${duelPeer.playerHealth ?? 'n/a'}:headArmor=${duelPeerHeadArmor}:updates=${allUpdates.map(update => `0x${update.damageCode.toString(16)}=${update.damageValue}`).join('/') || 'none'}${getModel13AttachProbeSuffix(duelPeerMechId, shot.targetAttach, impactContext)}`,
      );
    }

    duelPeer.combatPlayerArmorValues = duelPeerArmorValues;
    duelPeer.combatPlayerInternalValues = duelPeerInternalValues;
    duelPeer.combatPlayerCriticalStateBytes = duelPeerCriticalStateBytes;
    duelPeer.combatPlayerHeadArmor = duelPeerHeadArmor;
    duelPeer.playerHealth = getCombatDurability(duelPeerArmorValues, duelPeerInternalValues) + duelPeerHeadArmor;

    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_CLOSE');
    sendToWorldSession(duelPeer, buildCmd71ResetEffectStatePacket(nextSeq(duelPeer)), 'CMD71_DUEL_REMOTE_CLOSE');
    connLog.info(
      '[world/combat] duel cmd10 accepted: firePath=%s attacker="%s" defender="%s" defenderHealth=%d records=%d updates=%d shots=[%s]',
      firePath,
      getDisplayName(session),
      getDisplayName(duelPeer),
      duelPeer.playerHealth,
      fireableShots.length,
      totalDamageUpdates,
      shotSummaries.join(','),
    );

    if (isActorDestroyed(duelPeerInternalValues)) {
      duelPeer.playerHealth = 0;
      const fatalReason = (duelPeerInternalValues[7] ?? 0) <= 0
        ? 'head destroyed'
        : 'center torso destroyed';
      sendDuelDeathTransition(session, duelPeer, connLog, fatalReason);
      queueDuelCombatResultTransition(
        players,
        session,
        duelPeer,
        connLog,
        fatalReason,
        BOT_RESULT_DELAY_MS,
      );
    }
    return;
  }

  if (combatSession?.mode === 'arena' && combatSession.state === 'active') {
    const viewers = getCombatReadyParticipants(players, combatSession);
    if (viewers.length <= 1) {
      connLog.debug('[world/combat] arena cmd10 ignored: session=%s has <=1 ready viewers', combatSession.id);
      return;
    }

    for (const viewer of viewers) {
      sendToWorldSession(viewer, buildCmd71ResetEffectStatePacket(nextSeq(viewer)), 'CMD71_ARENA_RESET');
    }

    const shotSummaries = [...blockedFriendlyShotSummaries];
    let totalDamageUpdates = 0;
    const eliminatedParticipants = new Map<string, ClientSession>();

    for (const shot of fireableShots) {
      const { damage: shotDamage, weaponName, weaponSpec } = getShotDamage(session, shot.weaponSlot);
      const target = getCombatTargetParticipantForViewerSlot(players, combatSession, session, shot.targetSlot);
      const targetActive = !!target
        && !target.socket.destroyed
        && target.phase === 'combat'
        && target.combatSessionId === combatSession.id
        && target.combatResultCode === undefined
        && (target.playerHealth ?? 1) > 0;
      const friendlyTarget = targetActive
        && session.worldArenaSide !== undefined
        && session.worldArenaSide === target.worldArenaSide;

      if (friendlyTarget) {
        shotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:friendly-fire-blocked:${getDisplayName(target)}`,
        );
        continue;
      }

      for (const viewer of viewers) {
        sendToWorldSession(
          viewer,
          buildCmd68ProjectileSpawnPacket(
            {
              sourceSlot:   getCombatSourceSlotForViewer(combatSession, viewer, session),
              weaponSlot:   shot.weaponSlot,
              targetRaw:    getCombatTargetRawForViewer(combatSession, viewer, targetActive ? target : undefined),
              targetAttach: shot.targetAttach < 0 ? 0 : shot.targetAttach + 1,
              angleSeedA:   shot.angleSeedA,
              angleSeedB:   shot.angleSeedB,
              impactX:      shot.impactXRaw - COORD_BIAS,
              impactY:      shot.impactYRaw - COORD_BIAS,
              impactZ:      shot.impactZ,
            },
            nextSeq(viewer),
          ),
          viewer.id === session.id ? 'CMD68_ARENA_LOCAL_PROJECTILE' : 'CMD68_ARENA_REMOTE_PROJECTILE',
        );
      }

      if (!targetActive || !target || eliminatedParticipants.has(target.id)) {
        shotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:no-active-target:${shot.targetSlot}/${shot.targetAttach}`,
        );
        continue;
      }
      const rangeGate = getShotMaxRangeGate(
        session,
        shot.weaponSlot,
        target.combatX,
        target.combatY,
      );
      if (!rangeGate.allowed) {
        shotSummaries.push(
          `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:${getDisplayName(target)}:out-of-range:${Math.round(rangeGate.distanceMeters ?? -1)}/${rangeGate.maxRangeMeters ?? 'n/a'}m`,
        );
        continue;
      }

      const targetMechId = target.selectedMechId ?? FALLBACK_MECH_ID;
      const targetModelId = getCombatModelIdForMechId(targetMechId);
      const targetMechEntry = WORLD_MECH_BY_ID.get(targetMechId);
      const targetArmorValues = [...(target.combatPlayerArmorValues ?? targetMechEntry?.armorLikeMaxValues ?? DEFAULT_BOT_ARMOR_VALUES)];
      const targetInternalValues = [...(target.combatPlayerInternalValues ?? (targetMechEntry ? mechInternalStateBytes(targetMechEntry.tonnage) : DEFAULT_BOT_INTERNAL_VALUES))];
      const targetCriticalStateBytes = [...(target.combatPlayerCriticalStateBytes ?? createCriticalStateBytes(targetMechEntry?.extraCritCount))];
      let targetHeadArmor = target.combatPlayerHeadArmor ?? HEAD_ARMOR_VALUE;
      const impactContext = buildTargetImpactContext(
        shot.impactXRaw - COORD_BIAS,
        shot.impactYRaw - COORD_BIAS,
        shot.impactZ,
        target.combatX ?? 0,
        target.combatY ?? 0,
        target.combatJumpAltitude ?? 0,
        getCombatCmd65Facing(target),
      );
      const hitSection = resolveEffectiveHitSection(
        targetMechId,
        shot.targetAttach,
        shot.impactZ,
        targetArmorValues,
        targetInternalValues,
        impactContext,
      );
      const previousInternalValues = [...targetInternalValues];
      const damageResult = applyWeaponDamage(
        weaponSpec,
        shotDamage,
        hitSection,
        shot.weaponSlot,
        shot.targetAttach,
        shot.angleSeedA,
        shot.angleSeedB,
        targetArmorValues,
        targetInternalValues,
        targetHeadArmor,
      );
      const postDamageUpdates = collectPostDamageStateUpdates(
        targetMechId,
        targetCriticalStateBytes,
        previousInternalValues,
        targetInternalValues,
        damageResult.headInternalDamaged,
      );
      targetHeadArmor = damageResult.headArmor;
      const allUpdates = [...damageResult.updates, ...postDamageUpdates.updates];

      for (const viewer of viewers) {
        if (viewer.id === target.id) {
          for (const update of allUpdates) {
            sendToWorldSession(
              viewer,
              buildCmd67LocalDamagePacket(update.damageCode, update.damageValue, nextSeq(viewer)),
              'CMD67_ARENA_LOCAL_DAMAGE',
            );
          }
          continue;
        }
        const targetSlotForViewer = getCombatRemoteSlotForViewer(combatSession, viewer, target);
        if (targetSlotForViewer === undefined) {
          continue;
        }
        for (const update of allUpdates) {
          sendToWorldSession(
            viewer,
            buildCmd66ActorDamagePacket(targetSlotForViewer, update.damageCode, update.damageValue, nextSeq(viewer)),
            'CMD66_ARENA_REMOTE_DAMAGE',
          );
        }
      }

      totalDamageUpdates += allUpdates.length;
      target.combatPlayerArmorValues = targetArmorValues;
      target.combatPlayerInternalValues = targetInternalValues;
      target.combatPlayerCriticalStateBytes = targetCriticalStateBytes;
      target.combatPlayerHeadArmor = targetHeadArmor;
      target.playerHealth = getCombatDurability(targetArmorValues, targetInternalValues) + targetHeadArmor;
      if (postDamageUpdates.newlyDestroyedLegs.length > 0 && !isActorDestroyed(targetInternalValues)) {
        sendArenaParticipantLegLossCollapse(
          players,
          combatSession,
          target,
          connLog,
          `${getDisplayName(target)} ${postDamageUpdates.newlyDestroyedLegs.map(leg => leg.label).join('+')} destroyed`,
        );
      }
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:${getDisplayName(target)}:${summarizeHitSections(damageResult.hitSections)}:mech=${targetMechId}:model=${targetModelId ?? 'n/a'}:attach=${shot.targetAttach}:health=${target.playerHealth}:updates=${allUpdates.map(update => `0x${update.damageCode.toString(16)}=${update.damageValue}`).join('/') || 'none'}${getModel13AttachProbeSuffix(targetMechId, shot.targetAttach, impactContext)}`,
      );

      if (isActorDestroyed(targetInternalValues)) {
        eliminatedParticipants.set(target.id, target);
      }
    }

    for (const viewer of viewers) {
      sendToWorldSession(viewer, buildCmd71ResetEffectStatePacket(nextSeq(viewer)), 'CMD71_ARENA_CLOSE');
    }

    connLog.info(
      '[world/combat] arena cmd10 accepted: firePath=%s attacker="%s" records=%d updates=%d shots=[%s]',
      firePath,
      getDisplayName(session),
      fireableShots.length,
      totalDamageUpdates,
      shotSummaries.join(','),
    );

    for (const target of eliminatedParticipants.values()) {
      eliminateArenaCombatParticipant(
        players,
        combatSession,
        target,
        connLog,
        `${getDisplayName(target)} destroyed by ${getDisplayName(session)}`,
      );
    }
    return;
  }

  const activeBots = getActiveSoloCombatBots(session);
  if (activeBots.length === 0) {
    connLog.debug('[world/combat] cmd-10 shot ignored — all solo-combat bots already destroyed');
    return;
  }
  const difficultyProfile = getConfiguredBotDifficultyProfile(session);
  const playerSide = getConfiguredSoloCombatPlayerSide(session);

  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_RESET');
  const shotSummaries: string[] = [];
  let totalDamageUpdates = 0;
  const eliminatedBotSlots = new Set<number>();

  for (const shot of fireableShots) {
    const { damage: shotDamage, weaponName, weaponSpec } = getShotDamage(session, shot.weaponSlot);
    const targetBot = shot.targetSlot <= 0 ? undefined : getSoloCombatBotBySlot(session, shot.targetSlot);
    const targetActive = !!targetBot && targetBot.health > 0 && !eliminatedBotSlots.has(targetBot.slot);
    const friendlyTarget = targetActive && targetBot.side === playerSide;
    const targetX = targetBot?.x ?? 0;
    const targetY = targetBot?.y ?? 0;
    const targetZ = targetBot?.z ?? 0;

    if (friendlyTarget) {
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:friendly-fire-blocked:slot=${targetBot.slot}`,
      );
      continue;
    }

    send(
      session.socket,
      buildCmd68ProjectileSpawnPacket(
        {
          sourceSlot:   0,
          weaponSlot:   shot.weaponSlot,
          targetRaw:    shot.targetSlot < 0 ? 0 : shot.targetSlot + 1,
          targetAttach: shot.targetAttach < 0 ? 0 : shot.targetAttach + 1,
          angleSeedA:   shot.angleSeedA,
          angleSeedB:   shot.angleSeedB,
          impactX:      shot.impactXRaw - COORD_BIAS,
          impactY:      shot.impactYRaw - COORD_BIAS,
          impactZ:      shot.impactZ,
        },
        nextSeq(session),
      ),
      capture,
      'CMD68_PROJECTILE',
    );

    if (!targetActive || !targetBot) {
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:no-active-target:${shot.targetSlot}/${shot.targetAttach}`,
      );
      continue;
    }

    const rangeGate = getShotMaxRangeGate(session, shot.weaponSlot, targetX, targetY);
    if (!rangeGate.allowed) {
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:slot=${targetBot.slot}:out-of-range:${Math.round(rangeGate.distanceMeters ?? -1)}/${rangeGate.maxRangeMeters ?? 'n/a'}m`,
      );
      continue;
    }

    const botMechId = targetBot.mechId;
    const botMechEntry = getMechEntryForId(botMechId);
    const botModelId = getCombatModelIdForMechId(botMechId);
    const hitRoll = resolveCombatToHitRoll({
      attackerX: session.combatX ?? 0,
      attackerY: session.combatY ?? 0,
      attackerFacing: getCombatCmd65Facing(session),
      attackerSpeedMag: session.combatSpeedMag,
      attackerMaxSpeedMag: session.combatMaxSpeedMag,
      attackerAirborne: (session.combatJumpAltitude ?? 0) > 0,
      targetX,
      targetY,
      targetFacing: targetBot.facing,
      targetSpeedMag: targetBot.speedMag,
      targetMaxSpeedMag: botMechEntry?.maxSpeedMag,
      targetAirborne: targetBot.jumpActive === true || targetZ > 0,
      targetMoveVectorX: targetBot.moveVectorX,
      targetMoveVectorY: targetBot.moveVectorY,
      distanceMeters: rangeGate.distanceMeters ?? getCombatDisplayDistanceMeters(session.combatX ?? 0, session.combatY ?? 0, targetX, targetY),
      weaponSpec,
      maxRangeMeters: rangeGate.maxRangeMeters,
    }, difficultyProfile);
    if (!hitRoll.hit) {
      shotSummaries.push(
        `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:slot=${targetBot.slot}:miss:${shot.targetSlot}/${shot.targetAttach}:chance=${Math.round(hitRoll.chance * 100)}:roll=${Math.round(hitRoll.roll * 100)}:band=${hitRoll.rangeBand}:cross=${Math.round(hitRoll.crossingFactor * 100)}:bot=${targetX}/${targetY}`,
      );
      continue;
    }

    const impactContext = buildTargetImpactContext(
      shot.impactXRaw - COORD_BIAS,
      shot.impactYRaw - COORD_BIAS,
      shot.impactZ,
      targetX,
      targetY,
      targetZ,
      targetBot.facing,
    );
    const hitSection = resolveEffectiveHitSection(
      botMechId,
      shot.targetAttach,
      shot.impactZ,
      targetBot.armorValues,
      targetBot.internalValues,
      impactContext,
    );
    const previousInternalValues = [...targetBot.internalValues];
    const damageResult = applyWeaponDamage(
      weaponSpec,
      shotDamage,
      hitSection,
      shot.weaponSlot,
      shot.targetAttach,
      shot.angleSeedA,
      shot.angleSeedB,
      targetBot.armorValues,
      targetBot.internalValues,
      targetBot.headArmor,
    );
    const postDamageUpdates = collectPostDamageStateUpdates(
      botMechId,
      targetBot.criticalStateBytes,
      previousInternalValues,
      targetBot.internalValues,
      damageResult.headInternalDamaged,
    );
    targetBot.headArmor = damageResult.headArmor;
    const allUpdates = [...damageResult.updates, ...postDamageUpdates.updates];
    for (const update of allUpdates) {
      send(
        session.socket,
        buildCmd66ActorDamagePacket(targetBot.slot, update.damageCode, update.damageValue, nextSeq(session)),
        capture,
        'CMD66_BOT_DAMAGE',
      );
    }
    if (postDamageUpdates.newlyDestroyedLegs.length > 0 && !isActorDestroyed(targetBot.internalValues)) {
      sendCombatLegLossCollapse(
        session,
        targetBot.slot,
        connLog,
        `${postDamageUpdates.newlyDestroyedLegs.map(leg => leg.label).join('+')} destroyed`,
        'CMD70_BOT_LEG_COLLAPSE',
        capture,
        session.combatLegLossTransitionMode ?? 'collapse-only',
      );
    }

    targetBot.health = getCombatDurability(targetBot.armorValues, targetBot.internalValues) + targetBot.headArmor;
    totalDamageUpdates += allUpdates.length;
    shotSummaries.push(
      `${shot.weaponSlot}:${weaponName ?? 'unknown'}:${shotDamage}:${summarizeHitSections(damageResult.hitSections)}:slot=${targetBot.slot}:mech=${botMechId}:model=${botModelId ?? 'n/a'}:${shot.targetSlot}/${shot.targetAttach}:chance=${Math.round(hitRoll.chance * 100)}:roll=${Math.round(hitRoll.roll * 100)}:cross=${Math.round(hitRoll.crossingFactor * 100)}:bot=${targetX}/${targetY}:headArmor=${targetBot.headArmor}:updates=${allUpdates.map(update => `0x${update.damageCode.toString(16)}=${update.damageValue}`).join('/') || 'none'}${getModel13AttachProbeSuffix(botMechId, shot.targetAttach, impactContext)}`,
    );

    if (isActorDestroyed(targetBot.internalValues)) {
      targetBot.health = 0;
      eliminatedBotSlots.add(targetBot.slot);
    }
  }

  syncLegacySoloCombatBotState(session);
  connLog.info(
    '[world/combat] cmd10 weapon fire accepted: firePath=%s records=%d weaponSlots=%s botHealth=%d updates=%d shots=[%s]',
    firePath,
    fireableShots.length,
    fireableShots.map(shot => shot.weaponSlot).join('/'),
    session.botHealth ?? 0,
    totalDamageUpdates,
    shotSummaries.join(','),
  );
  send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_CLOSE');

  for (const slot of eliminatedBotSlots) {
    const bot = getSoloCombatBotBySlot(session, slot);
    if (!bot) {
      continue;
    }
    sendBotDeathTransition(session, bot, connLog, capture, 'fatal-damage');
  }

  if (getActiveHostileSoloCombatBots(session).length === 0) {
    session.botHealth = 0;
    stopBotCombatActions(session);
    queueCombatResultTransition(
      players,
      session,
      connLog,
      capture,
      COMBAT_RESULT_VICTORY,
      'all hostile solo-combat bots structurally destroyed',
      BOT_RESULT_DELAY_MS,
    );
  }
}

export function handleCombatActionFrame(
  players: PlayerRegistry,
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
  capture: CaptureLogger,
): void {
  if (session.combatResultCode !== undefined) {
    connLog.debug('[world/combat] cmd12 ignored while result transition is pending');
    return;
  }

  const action = parseClientCmd12Action(payload);
  if (!action) {
    connLog.warn('[world/combat] cmd-12 action parse failed (len=%d)', payload.length);
    return;
  }

  if (action.action === 0x11) {
    if (requestDuelEjection(players, session, connLog)) {
      return;
    }
    if (requestArenaCombatEjection(players, session, connLog)) {
      return;
    }
    connLog.debug('[world/combat] cmd-12 action=0x11 (eject) observed outside active shared combat');
    return;
  }

  clearCombatEjectArm(session, connLog, `action ${action.action}`);

  if (action.action === 0) {
    noteCombatAction0Observed(session, connLog, capture);
    connLog.debug('[world/combat] cmd-12 action=0 (recovery/stand-up trigger)');
    // Keep local combat HUD/effects state fresh around the recovery-trigger path.
    send(session.socket, buildCmd71ResetEffectStatePacket(nextSeq(session)), capture, 'CMD71_FIRE_GATE');
    return;
  }

  if (action.action >= 0x16 && action.action <= 0x1f) {
    connLog.debug('[world/combat] cmd-12 select weapon slot=%d (client-local HUD state)', action.action - 0x16);
    return;
  }

  if (action.action === 0x20 || action.action === 0x21) {
    connLog.debug('[world/combat] cmd-12 cycle weapon slot action=0x%s (client-local HUD state)', action.action.toString(16));
    return;
  }

  if (action.action >= 0x23 && action.action <= 0x25) {
    connLog.debug('[world/combat] cmd-12 toggle selected weapon into TIC=%d (client-local HUD state)', action.action - 0x23);
    return;
  }

  if (action.action >= 0xb1 && action.action <= 0xce) {
    const zeroBased = action.action - 0xb1;
    const weaponSlot = Math.floor(zeroBased / 3);
    const ticIndex = zeroBased % 3;
    connLog.debug(
      '[world/combat] cmd-12 HUD TIC toggle weapon slot=%d TIC=%d (client-local HUD state)',
      weaponSlot,
      ticIndex,
    );
    return;
  }

  if (action.action === 4) {
    if (!selectedMechSupportsJumpJets(session)) {
      connLog.info('[world/combat] cmd-12 jump action=4 ignored (selected mech has no jump jets)');
      return;
    }

    const fuel = session.combatJumpFuel ?? JUMP_JET_FUEL_MAX;
    if (
      session.combatJumpActive
      || session.combatJumpTimer !== undefined
      || (session.combatJumpAltitude ?? 0) > 0
    ) {
      connLog.info('[world/combat] cmd-12 jump action=4 ignored (jump already active)');
      return;
    }

    const jumpArc = getSelectedMechJumpArc(session);
    const mirrorDurationMs = getSelectedMechJumpMirrorDurationMs(session);
    session.combatJumpActive = true;
    session.combatJumpAltitude = 0;
    session.combatAltitudeRaw = 0;
    session.combatUpperBodyPitch = 0;
    session.combatTorsoYaw = 0;
    session.combatSpeedMag = 0;
    setPlayerMoveVector(session, 0, 0);
    session.combatJumpFuel = fuel;
    session.combatLastJumpLandAt = undefined;
    session.combatLastJumpLandAltitude = undefined;
    startPeerOnlyJumpMirror(players, session);

    if (fuel <= JUMP_JET_START_FUEL_THRESHOLD) {
      connLog.debug(
        '[world/combat] cmd-12 jump action=4 accepted with stale server fuel snapshot=%d (client owns jump threshold)',
        fuel,
      );
    }

    connLog.info(
      '[world/combat] cmd-12 jump action=4 altitude=%d fuel=%d apex=%d mirrorDurationMs=%d (client-owned local jump, peer-only Cmd65 mirror)',
      session.combatJumpAltitude,
      session.combatJumpFuel,
      jumpArc.apexUnits,
      mirrorDurationMs,
    );
    mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_JUMP_START');
    maybeLogCollisionProbeCandidate(players, session, connLog, 'CMD65_COMBAT_JUMP_START');
    return;
  }

  if (action.action === 6) {
    const landedFromAltitude = session.combatJumpAltitude ?? 0;
    if (!session.combatJumpActive && session.combatJumpTimer === undefined && landedFromAltitude <= 0) {
      connLog.info('[world/combat] cmd-12 jump action=6 ignored (no active jump)');
      return;
    }
    if (session.combatJumpTimer !== undefined) {
      clearInterval(session.combatJumpTimer);
      session.combatJumpTimer = undefined;
    }
    session.combatJumpActive = false;
    session.combatJumpAltitude = 0;
    session.combatAltitudeRaw = 0;
    recordCombatLanding(session, landedFromAltitude);
    if (session.combatDeferredLocalCollapsePending) {
      session.combatDeferredLocalCollapsePending = false;
      session.combatLastLocalCollapseAt = Date.now();
      session.combatLocalDowned = true;
      session.combatRecoveryExperimentPending = true;
      connLog.info(
        '[world/combat] cmd-12 jump action=6 completed pending local deferred collapse (quietCmd65=%s)',
        session.combatSuppressLocalCmd65WhileDowned ? 'yes' : 'no',
      );
    }

    const x = session.combatX ?? 0;
    const y = session.combatY ?? 0;
    const throttle = session.combatUpperBodyPitch ?? 0;
    const legVel = session.combatTorsoYaw ?? 0;
    const speedMag = session.combatSpeedMag ?? 0;

    connLog.info('[world/combat] cmd-12 jump action=6 altitude=0 (client-owned local landing; remote mirror only)');
    mirrorCombatRemotePosition(players, session, 'CMD65_COMBAT_JUMP_LAND');
    maybeLogCollisionProbeCandidate(players, session, connLog, 'CMD65_JUMP_LAND');
    return;
  }

  // Ghidra confirmed: action 0x34 (THROTTLE_UP) calls FUN_004229a0 locally
  // but does NOT call Combat_SendCmd12Action_v123 — so these packets never
  // arrive from the client. Local motion stays driven by the cmd8/cmd9 movement
  // frames, especially the final speedRaw field from FUN_0042c7a0.
  connLog.debug('[world/combat] cmd-12 combat action=%d — no response', action.action);
}

export function handleCombatContactReportFrame(
  players: PlayerRegistry,
  session: ClientSession,
  payload: Buffer,
  connLog: Logger,
): void {
  const report = parseClientCmd13ContactReport(payload);
  if (!report) {
    connLog.warn('[world/combat] cmd-13 contact report parse failed');
    return;
  }

  maybeLogCombatContactReport(
    players,
    session,
    connLog,
    'CMD13_CONTACT',
    report.contactActorId,
    report.responseA,
    report.responseB,
    report.responseC,
  );
}

// ── 3-step mech picker — Cmd7 routing ─────────────────────────────────────────

export function handleMechPickerCmd7(
  players: PlayerRegistry,
  session: ClientSession,
  listId: number,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const clearMechPickerState = () => {
    session.mechPickerStep = undefined;
    session.mechPickerTarget = undefined;
    session.mechPickerTargetBotIndex = undefined;
    session.mechPickerClass = undefined;
    session.mechPickerChassis = undefined;
    session.mechPickerChassisPage = undefined;
  };
  const step = session.mechPickerStep;
  const pickerTarget = session.mechPickerTarget ?? 'player';
  const pickerBotIndex = Math.max(0, Math.min(
    MAX_SINGLE_PLAYER_BOT_OPPONENTS - 1,
    session.mechPickerTargetBotIndex ?? 0,
  ));

  if (step === 'class' && listId === MECH_CLASS_LIST_ID) {
    if (selection <= 0) {
      clearMechPickerState();
      if (pickerTarget === 'bot') {
        sendSceneRefresh(
          players,
          session,
          connLog,
          capture,
          `Bot ${pickerBotIndex + 1} mech selection cancelled.`,
        );
      } else {
        sendSceneRefresh(players, session, connLog, capture, 'Mech selection cancelled.');
      }
      return true;
    }
    const classIndex = selection - 1;
    if (classIndex < 0 || classIndex >= CLASS_KEYS.length) return true;
    sendMechChassisPicker(session, classIndex, connLog, capture);
    return true;
  }

  if (step === 'chassis' && listId === MECH_CHASSIS_LIST_ID) {
    if (selection <= 0) {
      sendMechClassPicker(
        session,
        connLog,
        capture,
        pickerTarget === 'bot' ? { target: 'bot', botIndex: pickerBotIndex } : undefined,
      );
      return true;
    }
    const classIndex  = session.mechPickerClass ?? 0;
    const chassisList = getMechChassisListForClass(classIndex);
    const visible     = chassisList.slice(0, 20);
    const chassis = visible[selection - 1];
    if (!chassis) {
      sendMechClassPicker(
        session,
        connLog,
        capture,
        pickerTarget === 'bot' ? { target: 'bot', botIndex: pickerBotIndex } : undefined,
      );
      return true;
    }
    sendMechVariantPicker(session, chassis, connLog, capture);
    return true;
  }

  if (step === 'variant' && listId === MECH_VARIANT_LIST_ID) {
    if (selection <= 0) {
      sendMechChassisPicker(session, session.mechPickerClass ?? 0, connLog, capture, session.mechPickerChassisPage ?? 0);
      return true;
    }
    const chassis = session.mechPickerChassis ?? '';
    const variants = WORLD_MECHS.filter(mech => getMechChassis(mech.typeString) === chassis);
    const chosen = variants[selection - 1];
    if (!chosen) {
      send(
        session.socket,
        buildCmd3BroadcastPacket('Mech selection invalid. Please try again.', nextSeq(session)),
        capture,
        'CMD3_MECH_SELECT_ERR',
      );
      sendMechClassPicker(
        session,
        connLog,
        capture,
        pickerTarget === 'bot' ? { target: 'bot', botIndex: pickerBotIndex } : undefined,
      );
      return true;
    }

    if (pickerTarget === 'bot') {
      setConfiguredBotLoadoutId(session, pickerBotIndex, chosen.id);
      clearMechPickerState();
      worldResumeRegistry.save(session);
      connLog.info(
        '[world] bot mech selected: callsign="%s" slot=%d mech_id=%d typeString=%s',
        getDisplayName(session),
        pickerBotIndex + 1,
        chosen.id,
        chosen.typeString,
      );
      send(
        session.socket,
        buildCmd3BroadcastPacket(
          `Bot ${pickerBotIndex + 1} mech selected: ${chosen.typeString}. ${buildBotConfigurationSummary(session)}`,
          nextSeq(session),
        ),
        capture,
        'CMD3_BOTMECH_SELECTED',
      );
      send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
      return true;
    }

    session.selectedMechSlot       = chosen.slot;
    session.selectedMechId         = chosen.id;
    clearMechPickerState();
    const arenaRoom = isArenaRoom(session);
    const readyCleared = arenaRoom && session.worldArenaReady === true;
    const duelCleared = arenaRoom && hasPendingArenaDuelState(session);
    if (duelCleared) {
      clearSessionDuelState(players, session, connLog, 'mech changed');
    }
    if (arenaRoom) {
      session.worldArenaReady = undefined;
    }
    worldResumeRegistry.save(session);

    connLog.info('[world] mech selected: callsign="%s" slot=%d id=%d typeString=%s',
      getDisplayName(session), chosen.slot, chosen.id, chosen.typeString);
    if (session.accountId !== undefined) {
      void updateCharacterMech(session.accountId, chosen.id, chosen.slot)
        .then(() => {
          connLog.info(
            '[world] persisted mech selection: accountId=%d slot=%d id=%d typeString=%s',
            session.accountId, chosen.slot, chosen.id, chosen.typeString,
          );
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          connLog.error(
            '[world] failed to persist mech selection: accountId=%d slot=%d id=%d err=%s',
            session.accountId, chosen.slot, chosen.id, msg,
          );
        });
    } else {
      connLog.warn('[world] mech selection not persisted: no accountId on session');
    }
    if (arenaRoom && (readyCleared || duelCleared)) {
      sendSceneRefresh(
        players,
        session,
        connLog,
        capture,
        `Mech selected: ${chosen.typeString}.${readyCleared ? ' Ready cleared.' : ''}${duelCleared ? ' Duel state cleared.' : ''}`,
      );
      sendArenaStatusList(players, session, connLog, capture);
      sendArenaReadyReminder(session, capture);
    } else {
      send(
        session.socket,
        buildCmd3BroadcastPacket(`Mech selected: ${chosen.typeString}`, nextSeq(session)),
        capture,
        'CMD3_MECH_SELECTED',
      );
      if (arenaRoom) {
        sendArenaReadyReminder(session, capture);
      }
      send(session.socket, buildCmd5CursorNormalPacket(nextSeq(session)), capture, 'CMD5_NORMAL');
    }
    return true;
  }

  return false;
}

export function handleMechPickerCmd20(
  session: ClientSession,
  selection: number,
  connLog: Logger,
  capture: CaptureLogger,
): boolean {
  const step = session.mechPickerStep;
  const dialogId = 5;

  if (!step) return false;

  if (step !== 'variant') {
    connLog.info('[world] cmd-20 examine ignored during mech picker step=%s selection=%d', step, selection);
    send(
      session.socket,
      buildCmd20Packet(dialogId, 2, 'Select a mech variant to examine its loadout.', nextSeq(session)),
      capture,
      'CMD20_MECH_PICKER_HINT',
    );
    return true;
  }

  const chassis = session.mechPickerChassis ?? '';
  const variants = WORLD_MECHS.filter(mech => getMechChassis(mech.typeString) === chassis);
  const slot = Math.min(variants.length - 1, Math.max(0, selection));
  const chosen = variants[slot];
  if (!chosen) {
    connLog.warn('[world] cmd-20 examine invalid variant selection=%d chassis=%s', selection, chassis);
    send(
      session.socket,
      buildCmd20Packet(dialogId, 2, 'Select a mech variant to examine its loadout.', nextSeq(session)),
      capture,
      'CMD20_MECH_PICKER_HINT',
    );
    return true;
  }

  const examineText = buildMechExamineText(chosen.typeString, chosen);
  connLog.info('[world] cmd-20 mech picker examine: slot=%d mech_id=%d (%s) → %j',
    slot, chosen.id, chosen.typeString, examineText);
  send(
    session.socket,
    buildCmd20Packet(dialogId, 2, examineText, nextSeq(session)),
    capture,
    'CMD20_STATS',
  );
  return true;
}
