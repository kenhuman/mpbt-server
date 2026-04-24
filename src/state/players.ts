/**
 * Per-connection player session state.
 */

import { randomUUID } from 'crypto';
import type { Socket } from 'net';

export type SessionPhase =
  | 'connected'     // TCP accepted, waiting for first bytes
  | 'auth'          // parsing login packet
  | 'lobby'         // authenticated; about to look up or create character
  | 'char-creation' // first-login character creation in progress (callsign + allegiance)
  | 'world'         // in the game world (RPS/arena) after REDIRECT
  | 'combat'        // in a combat arena; client uses combat dispatch table
  | 'closing';      // disconnect in progress

interface CombatSessionBase {
  /** Unique combat-session ID for a staged or active PvP match. */
  id: string;
  /** Combat mode this shared session represents. */
  mode: 'duel' | 'arena';
  /** Server-side room key where the duel was staged. */
  roomId: string;
  /** World-map room ID where the duel was staged. */
  worldMapRoomId: number;
  /** World-session IDs participating in the shared combat session. */
  participantSessionIds: string[];
  /** Current lifecycle state of the duel session. */
  state: 'staged' | 'active' | 'completed';
  /** Creation timestamp in ms since epoch. */
  createdAt: number;
  /** Start timestamp once combat bootstrap begins. */
  startedAt?: number;
}

export interface DuelCombatSession extends CombatSessionBase {
  mode: 'duel';
  /** The two world-session IDs participating in the duel. */
  participantSessionIds: [string, string];
  /** Shared duel stake values in participant order [A, B]. */
  duelStakeValues: [number, number];
  /** Most recent participant who submitted duel terms. */
  duelTermsUpdatedBySessionId?: string;
  /** Timestamp of the most recent duel-terms submission. */
  duelTermsUpdatedAt?: number;
}

export interface ArenaCombatSession extends CombatSessionBase {
  mode: 'arena';
}

export type CombatSession = DuelCombatSession | ArenaCombatSession;

export interface WorldScrollListState {
  /** Active paged result-list id echoed back through cmd-7 row selection. */
  listId: number;
  /** Server-side source of the currently open paged result list. */
  kind: 'tier-ranking' | 'class-ranking' | 'match-results';
  /** Zero-based page index currently shown in the client list. */
  pageIndex: number;
  /** Rows requested per page. */
  pageSize: number;
  /** Visible heading line embedded into the current list. */
  title: string;
  /** Item ids backing the currently visible selection rows in order. */
  visibleItemIds?: number[];
  /** True when the current page appends a trailing "More..." row. */
  hasMore?: boolean;
  /** Tier filter for tier-ranking shells. */
  tierKey?: 'UNRANKED' | 'NOVICE' | 'AMATEUR' | 'PROFESSIONAL' | 'VETERAN' | 'MASTER' | 'BATTLEMASTER' | 'CHAMPION';
  /** Weight-class filter for class-ranking shells. */
  classKey?: 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'ASSAULT';
}

/**
 * NOTE — cross-session writes and CaptureLogger:
 *
 * The `send()` helper in server.ts takes `(socket, buf, capture, label)` and
 * assumes the socket and capture logger belong to the same session.  For
 * fan-out / cross-session writes (room broadcasts, ComStar delivery) there is
 * no per-session CaptureLogger stored here, so those writes use
 * `other.socket.write()` directly with an explicit `socket.destroyed` guard.
 *
 * If full cross-session capture logging is needed in a future milestone, the
 * fix is to add a `capture: CaptureLogger` field to this interface so that any
 * caller can use `send(other.socket, buf, other.capture, label)`.  Until then,
 * direct writes for fan-out are intentional — do not change them to use the
 * *calling* session's CaptureLogger, as that logs the packet to the wrong file.
 */
export interface ClientSession {
  /** Unique session ID (UUID). */
  id: string;
  /** Authenticated username (empty until auth completes). */
  username: string;
  /** Session ID of a newer connection that is replacing this one, if any. */
  replacedBySessionId?: string;
  /** True when reconnect handoff already persisted the old world snapshot. */
  skipWorldResumeSave?: boolean;
  /** Current lifecycle phase. */
  phase: SessionPhase;
  /** Current room ID in the world. */
  roomId: string;
  /** Underlying TCP socket. */
  socket: Socket;
  /** Wall-clock time of connection. */
  connectedAt: Date;
  /**
   * Byte offset in the incoming stream — used by logging to correlate
   * packet captures with stream positions.
   */
  bytesReceived: number;
  /** True once the mech list (cmd 26) has been sent to the client. */
  mechListSent: boolean;
  /** True once we sent the server cmd-7 confirm dialog; awaiting user's choice. */
  awaitingMechConfirm: boolean;
  /** Server→client sequence number 0..41, incremented per game frame. */
  serverSeq: number;
  /** True once the world init sequence has been sent in response to the first world cmd-3. */
  worldInitialized?: boolean;
  /** True while a server-initiated world keepalive ping is awaiting a type-0x05 response. */
  worldKeepalivePending?: boolean;
  /** True once the combat bootstrap sequence (MMC welcome + Cmd72) has been sent. */
  combatInitialized?: boolean;
  /** Repeating setInterval that sends bot position updates during combat. */
  botPositionTimer?: ReturnType<typeof setInterval>;
  /** Repeating setInterval that advances the bot's fire / decision loop during combat. */
  botFireTimer?: ReturnType<typeof setInterval>;
  /** One-shot timeout that advances a dead bot from fall animation into wreck state. */
  botDeathTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that sends the combat match result / result-scene transition. */
  combatResultTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that returns the client from the result scene back to world mode. */
  combatWorldRestoreTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that delays Cmd72+ combat bootstrap so DROP can display first. */
  combatBootstrapTimer?: ReturnType<typeof setTimeout>;
  /** Peer-only jump mirror loop handle; cleared during combat reset if present. */
  combatJumpTimer?: ReturnType<typeof setInterval>;
  /**
   * True after cmd12/action 4 until cmd12/action 6 or combat reset.
   * Jump ownership is client-side; the server tracks airborne state/fuel only.
   */
  combatJumpActive?: boolean;
  /** Repeating setInterval that regenerates jump-jet fuel while grounded. */
  combatJumpFuelRegenTimer?: ReturnType<typeof setInterval>;
  /** Aggregate scripted bot durability for logging and simple win gating. */
  botHealth?: number;
  /**
   * Server-side approximation of the player's remaining IS health.
   * Recomputed from the player's per-section armor/internal values after each
   * bot retaliation tick. Used for high-level logging and summary only.
   */
  playerHealth?: number;
  /**
   * World presence identifier used by Cmd10/Cmd11/Cmd12/Cmd13.
   * Authenticated world sessions prefer `100000 + accountId` so client-side
   * personnel/ranking header lookups can align with ComStar IDs; pre-auth and
   * fallback sessions use an in-memory unique ID instead.
   */
  worldRosterId?: number;
  /**
   * Current room-presence state byte used by Cmd10/Cmd11 updates.
   * 5 = standing, 6..12 = booth 1..7.
   */
  worldPresenceStatus?: number;
  /**
   * Arena ready-room side selection (1..8) when the player has explicitly picked
   * a side. Undefined means no side is currently selected for this room.
   */
  worldArenaSide?: number;
  /**
   * Arena ready-room READY toggle. Undefined/false means not ready.
   * This is intentionally ephemeral and does not persist across reconnects.
   */
  worldArenaReady?: boolean;
  /**
   * Arena ready-room identifier within the current arena.
   * Persisted across reconnects so players return to the same staging room.
   */
  worldArenaReadyRoomId?: number;
  /**
   * Pending ready-room choices shown in the current arena-entry menu.
   * Stored in display order so Cmd7 selections can be resolved safely.
   */
  pendingArenaReadyRoomChoices?: number[];
  /**
   * Pending arena-room selection target while the menu is open.
   */
  pendingArenaReadyRoomArenaId?: number;
  /**
   * Current map room/location identifier from IS.MAP / SOLARIS.MAP.
   * This is separate from roomId, which is a server-side grouping key.
   */
  worldMapRoomId?: number;
  /**
   * Current world X coordinate (centreX from SOLARIS.MAP for the player's
   * current room, or 0 for generated rooms not in SOLARIS.MAP).  Set via
   * setSessionRoomPosition() on every room transition so server-side position
   * is always current.
   *
   * In RPS/world (social) mode there is no confirmed server→client position
   * wire packet distinct from Cmd65 (which is combat-only per RESEARCH.md
   * §19.6.1).  The client's scene position is communicated via Cmd4
   * playerScoreSlot (= room sceneIndex) on every room entry.  worldX/Y/Z are
   * server-side bookkeeping used for roster location display, future
   * multiplayer broadcasts, and combat spawn positioning.
   */
  worldX?: number;
  /** Current world Y coordinate (centreY of the current room). */
  worldY?: number;
  /** Current world Z / altitude.  Always 0 in travel-world mode. */
  worldZ?: number;
  /**
   * Most recent world inquiry target, used to page follow-up record requests
   * such as Cmd7(0x95, 2) after Cmd14_PersonnelRecord.
   */
  worldInquiryTargetId?: number;
  /** Current personnel-record page number for the active inquiry target. */
  worldInquiryPage?: number;
  /** True while a terminal/global ComStar send flow is waiting for a typed ComStar ID. */
  pendingComstarTargetPrompt?: boolean;
  /** True while terminal Change Handle is waiting for a typed replacement handle. */
  pendingHandleChangePrompt?: boolean;
  /** Latest Newsgrid article ids shown to the client for follow-up selection. */
  pendingNewsArticleIds?: number[];
  /** Latest persisted duel-result ids shown in the Solaris match results menu. */
  pendingMatchResultIds?: number[];
  /** Active paged Cmd45 scroll-list shell state for Solaris ranking pages. */
  worldScrollList?: WorldScrollListState;
  /** Pending unread ComStar message id for the current live yes/no prompt. */
  pendingIncomingComstarMessageId?: number;
  /** Sender ComStar id to use if the live prompt is accepted. */
  pendingIncomingComstarSenderId?: number;
  /** Full persisted Cmd36-ready body for the pending live prompt. */
  pendingIncomingComstarBody?: string;
  /**
   * Mech ID selected in the lobby and used to initialize the world arena.
   * Set on world-server sessions (via launchRegistry.consume); undefined on lobby sessions.
   */
  selectedMechId?: number;
  /**
   * 0-based mech slot (sort position) for the selected mech.
   * Set on world-server sessions; undefined on lobby sessions.
   */
  selectedMechSlot?: number;
  /** Session ID of the player who most recently challenged this player to a duel. */
  pendingDuelInviteFromSessionId?: string;
  /** Session ID of the player this session has challenged to a duel. */
  outgoingDuelInviteTargetSessionId?: string;
  /** Shared PvP combat-session ID once a duel has been staged or started. */
  combatSessionId?: string;
  /** Opponent session ID for the staged or active PvP combat session. */
  combatPeerSessionId?: string;
  /** True only while the world scene should advertise the staged-duel terms action. */
  duelTermsAvailable?: boolean;

  /** Optional scripted combat verification mode consumed on the next /fight bootstrap. */
  combatVerificationMode?: 'autowin' | 'autolose' | 'dmglocal' | 'dmgbot' | 'strictfire' | 'headtest' | 'legtest' | 'legseq' | 'legair' | 'legfull' | 'legrecover' | 'legdefer' | 'legdeferquiet' | 'legdefercmd73';

  /**
   * Pending mech slot chosen in the mech-select dialog, held until the
   * player confirms their selection (cmd-7 confirm reply).
   */
  pendingMechSlot?: number;

  // ── Combat positional state (updated by Cmd8/9 movement frames) ──────────

  /** Last decoded world X coordinate from client Cmd8/9. */
  combatX?: number;
  /** Last decoded world Y coordinate from client Cmd8/9. */
  combatY?: number;
  /** Last raw altitude/type2 field from client Cmd8/9. */
  combatAltitudeRaw?: number;
  /** Last raw facing-accumulator field from client Cmd8/9. */
  combatFacingRaw?: number;
  /** Last decoded Cmd65 upper-body pitch/bend channel. */
  combatUpperBodyPitch?: number;
  /** Last decoded Cmd65 torso-yaw / upper-body heading-offset channel. */
  combatTorsoYaw?: number;
  /** Current speedMag echoed in Cmd65 responses. */
  combatSpeedMag?: number;
  /** Timestamp (ms) when the server last accepted a cmd8/cmd9 position update. */
  combatLastMoveAt?: number;
  /** Most recent accepted local movement delta on X for crossing-shot estimation. */
  combatMoveVectorX?: number;
  /** Most recent accepted local movement delta on Y for crossing-shot estimation. */
  combatMoveVectorY?: number;
  /** Nominal airborne altitude used for peer sync / collision logging only. */
  combatJumpAltitude?: number;
  /** Prototype jump-jet fuel percentage (0..100). */
  combatJumpFuel?: number;
  /** Timestamp of the most recent collision-candidate probe log for this actor. */
  combatLastCollisionProbeAt?: number;
  /** Timestamp of the most recent decoded client cmd13 combat contact report log. */
  combatLastContactReportAt?: number;
  /** Timestamp of the most recent local jump landing transition. */
  combatLastJumpLandAt?: number;
  /** Altitude immediately before the most recent local jump landing transition. */
  combatLastJumpLandAltitude?: number;
  /** True after the first-stage eject control is armed; a second eject request confirms ejection. */
  combatEjectArmed?: boolean;
  /** Timestamp (ms) of the last cmd12/action 0 frame from client. */
  lastCombatFireActionAt?: number;
  /** One-shot timer that logs when a cmd12/action0 frame has no nearby cmd10 follow-up. */
  combatAction0FollowupTimer?: ReturnType<typeof setTimeout>;
  /** Whether the current combat session requires recent cmd12/action0 before cmd10 fire. */
  combatRequireAction0?: boolean;
  /** Count of cmd10 weapon-fire frames accepted in the current combat session. */
  combatShotsAccepted?: number;
  /** Count of cmd10 weapon-fire frames rejected by the current combat policy. */
  combatShotsRejected?: number;
  /** Count of cmd10 shots that arrived shortly after cmd12/action0. */
  combatShotsAction0Correlated?: number;
  /** Count of direct cmd10 shots that arrived without a recent cmd12/action0. */
  combatShotsDirectCmd10?: number;
  /** Count of cmd12/action0 frames that had no cmd10 follow-up inside the normal fire window. */
  combatAction0NoShotCount?: number;
  /** Active non-death leg-loss Cmd70 transition mode for the current combat session. */
  combatLegLossTransitionMode?: 'collapse-only' | 'fall-then-collapse' | 'airborne-collapse-land' | 'fall-airborne-collapse-land' | 'fall-collapse-recover' | 'defer-while-airborne';
  /** Delayed Cmd70 timers queued for non-death leg-loss transition probes. */
  combatLegLossTransitionTimers?: Array<ReturnType<typeof setTimeout> | undefined>;
  /** Timestamp (ms) when the server most recently sent a local non-death collapse Cmd70/8. */
  combatLastLocalCollapseAt?: number;
  /** True while the server still considers the local actor downed after a non-death collapse. */
  combatLocalDowned?: boolean;
  /** True after an airborne local Cmd70/8 probe, until the client reports action6 landing. */
  combatDeferredLocalCollapsePending?: boolean;
  /** Research verifier: suppress local Cmd65 echoes while the local downed latch is active. */
  combatSuppressLocalCmd65WhileDowned?: boolean;
  /** Research verifier: send opt-in Cmd73 rate/bias probes around local fall and recovery transitions. */
  combatCmd73RateProbe?: boolean;
  /** True while a no-shot cmd12/action0 may still be acknowledged as local stand-up recovery. */
  combatRecoveryExperimentPending?: boolean;
  /** Per-weapon-slot wall-clock time (Date.now ms) when the slot becomes fireable again. */
  combatWeaponReadyAtBySlot?: number[];
  /** Per-weapon-slot one-shot timer that restores local HUD weapon-ready state after cooldown. */
  combatWeaponReadyTimerBySlot?: Array<ReturnType<typeof setTimeout> | undefined>;
  /** Current local ammo-bin state for the active mech, indexed by .MEC ammo-bin order. */
  combatAmmoStateValues?: number[];
  /**
   * Mech ID override for the scripted bot opponent.  Set via `/botmech <id>`;
   * used instead of the player's own mech when bootstrapping combat.
   */
  combatBotMechId?: number;
  /** Wall-clock timestamp (Date.now()) when the current combat bootstrap was sent. */
  combatStartAt?: number;
  /** Per-mech run/max speedMag cap (round(mec_speed * 1.5) * 300), set at combat bootstrap. */
  combatMaxSpeedMag?: number;
  /** Per-mech walk speedMag (mec_speed * 300), set at combat bootstrap. */
  combatWalkSpeedMag?: number;
  /**
   * Server-side remaining remote-armor values for the scripted bot.
   * Order matches Cmd66 class-1 armor-like codes 0x15..0x1e.
   */
  combatBotArmorValues?: number[];
  /**
   * Server-side remaining remote internal-structure values for the scripted bot.
   * Order matches Cmd72 / Cmd66 class-2 internal codes 0x20..0x27:
   * LA, RA, LT, RT, CT, LL, RL, Head.
   */
  combatBotInternalValues?: number[];
  /**
    * Server-side tracked remote critical/system states for the scripted bot.
     * Indexes match Cmd66 class-0 damage codes (0x00..), with at least the base
     * 0x15 critical slots retained so head systems can be updated consistently.
    */
  combatBotCriticalStateBytes?: number[];
  /** Server-side remaining head armor for the scripted bot (RE-backed hardcoded value 9). */
  combatBotHeadArmor?: number;
  /** Current remote bot X coordinate mirrored through Cmd65 slot 1 updates. */
  combatBotX?: number;
  /** Current remote bot Y coordinate mirrored through Cmd65 slot 1 updates. */
  combatBotY?: number;
  /** Current remote bot Z / altitude mirrored through Cmd65 slot 1 updates. */
  combatBotZ?: number;
  /** Current remote bot facing accumulator mirrored through Cmd65 slot 1 updates. */
  combatBotFacing?: number;
  /** Current remote bot speedMag mirrored through Cmd65 slot 1 updates. */
  combatBotSpeedMag?: number;
  /** Timestamp (ms) when the server last advanced the bot movement tick. */
  combatBotLastMoveAt?: number;
  /** Most recent server-side bot movement delta X, used for combat motion / to-hit evaluation. */
  combatBotMoveVectorX?: number;
  /** Most recent server-side bot movement delta Y, used for combat motion / to-hit evaluation. */
  combatBotMoveVectorY?: number;
  /** Per-weapon-slot ready-at wall-clock values for the bot's current mech. */
  combatBotWeaponReadyAtBySlot?: number[];
  /** Current remote bot ammo-bin state for the active bot mech. */
  combatBotAmmoStateValues?: number[];
  /** Bot-only rolling heat estimate used for TIC / volley selection. */
  combatBotHeat?: number;
  /** Timestamp (ms) of the most recent bot aim-limit diagnostic log. */
  combatBotLastAimLimitLogAt?: number;
  /** True while the bot is traversing a jump-jet arc. */
  combatBotJumpActive?: boolean;
  /** Current bot jump-jet fuel snapshot (same 0..120 scale as the player mirror). */
  combatBotJumpFuel?: number;
  /** Wall-clock timestamp when the current bot jump arc started. */
  combatBotJumpStartedAt?: number;
  /** Duration in ms for the current bot jump arc. */
  combatBotJumpDurationMs?: number;
  /** Starting fuel value used to decay bot jump fuel across the active arc. */
  combatBotJumpStartFuel?: number;
  /** Jump apex in combat-world units for the current bot arc. */
  combatBotJumpApexUnits?: number;
  /** Bot jump arc starting X coordinate. */
  combatBotJumpStartX?: number;
  /** Bot jump arc starting Y coordinate. */
  combatBotJumpStartY?: number;
  /** Bot jump arc landing-target X coordinate. */
  combatBotJumpTargetX?: number;
  /** Bot jump arc landing-target Y coordinate. */
  combatBotJumpTargetY?: number;
  /** Wall-clock timestamp of the last bot jump start, used to prevent jump spam. */
  combatBotLastJumpAt?: number;
  /**
   * Server-side remaining local-armor values for the player.
   * Order matches Cmd66/67 class-1 codes 0x15..0x1e.
   */
  combatPlayerArmorValues?: number[];
  /**
   * Server-side remaining local internal-structure values for the player.
   * Order matches Cmd72 / Cmd66 / Cmd67 class-2 internal codes 0x20..0x27:
   * LA, RA, LT, RT, CT, LL, RL, Head.
   */
  combatPlayerInternalValues?: number[];
  /**
   * Server-side tracked local critical/system states for the player.
   * Indexes match Cmd67 class-0 damage codes (0x00..), with the head-related
   * sensor/life-support slots mirrored from client evidence.
    */
  combatPlayerCriticalStateBytes?: number[];
  /** Server-side remaining head armor for the player (RE-backed hardcoded value 9). */
  combatPlayerHeadArmor?: number;
  /** Last queued/sent combat result code (0 = victory, 1 = loss). */
  combatResultCode?: 0 | 1;
  /**
   * Round-robin cursor for choosing the next retaliation hit section while the
   * local actor still has multiple intact sections.
   */
  combatRetaliationCursor?: number;
  /**
   * True while a KP5 stopping intent is inferred from clientSpeed trend in Cmd9.
   * When set, the Cmd65 echo sends speedMag=0 so actor+0x372 is driven to 0 by
   * every echo cycle — not just the brief window between key-event callbacks.
   * This allows physics drag to fully decelerate the mech.
   * Cleared when clientSpeed rises again (new KP8 acceleration) or when the
   * mech fully stops and Cmd8 reports clientSpeed=0.
   */
  combatIntentStop?: boolean;

  // ── 3-step mech picker state ──────────────────────────────────────────────

  /** Which step of the mech-picker dialog the player is on. */
  mechPickerStep?: 'class' | 'chassis' | 'variant';
  /** Weight-class index (0=Light, 1=Medium, 2=Heavy, 3=Assault) chosen in step 1. */
  mechPickerClass?: number;
  /** Chassis name (e.g. "Jenner") chosen in step 2. */
  mechPickerChassis?: string;
  /** Page offset for the chassis picker when a weight class has more than 19 rows. */
  mechPickerChassisPage?: number;

  // ── Persistence fields (set after DB lookup / character creation) ─────────

  /** Database account row ID; set after successful login & DB auth. */
  accountId?: number;
  /**
   * Character display name (callsign shown to other players and in Cmd4).
   * Set from the characters table after login; also set at end of char creation.
   * Falls back to `username` if not yet populated (pre-character-creation sessions).
   */
  displayName?: string;
  /**
   * House allegiance — one of Davion | Steiner | Liao | Marik | Kurita.
   * Set from the characters table after login, or persisted from cmd-5 during
   * the first-login allegiance-picker wizard (wire format confirmed via RE).
   */
  allegiance?: string;
  /** Persisted C-Bill balance loaded from the character row and updated after duel settlement. */
  cbills?: number;
  /** Pending one-line sanctioned-duel settlement notice to show once the player is back in world. */
  pendingDuelSettlementNotice?: string;
}

export class PlayerRegistry {
  private sessions = new Map<string, ClientSession>();
  private combatSessions = new Map<string, CombatSession>();

  add(session: ClientSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): ClientSession | undefined {
    return this.sessions.get(id);
  }

  getCombatSession(id: string | undefined): CombatSession | undefined {
    if (!id) return undefined;
    return this.combatSessions.get(id);
  }

  findCombatSessionByParticipant(sessionId: string): CombatSession | undefined {
    return [...this.combatSessions.values()].find(session =>
      session.participantSessionIds.includes(sessionId),
    );
  }

  createDuelCombatSession(sessionA: ClientSession, sessionB: ClientSession): DuelCombatSession {
    const combatSession: DuelCombatSession = {
      id:                  randomUUID(),
      mode:                'duel',
      roomId:              sessionA.roomId,
      worldMapRoomId:      sessionA.worldMapRoomId ?? sessionB.worldMapRoomId ?? 0,
      participantSessionIds: [sessionA.id, sessionB.id],
      state:               'staged',
      createdAt:           Date.now(),
      duelStakeValues:     [0, 0],
    };
    this.combatSessions.set(combatSession.id, combatSession);
    return combatSession;
  }

  createArenaCombatSession(participants: readonly ClientSession[]): ArenaCombatSession {
    if (participants.length < 2) {
      throw new Error('arena combat sessions require at least two participants');
    }
    const combatSession: ArenaCombatSession = {
      id:                    randomUUID(),
      mode:                  'arena',
      roomId:                participants[0].roomId,
      worldMapRoomId:        participants[0].worldMapRoomId ?? 0,
      participantSessionIds: participants.map(participant => participant.id),
      state:                 'active',
      createdAt:             Date.now(),
    };
    this.combatSessions.set(combatSession.id, combatSession);
    return combatSession;
  }

  removeCombatSession(id: string | undefined): void {
    if (!id) return;
    this.combatSessions.delete(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  all(): ClientSession[] {
    return [...this.sessions.values()];
  }

  /** First non-destroyed session already authenticated for the given account. */
  findActiveSessionByAccountId(accountId: number, excludeId?: string): ClientSession | undefined {
    return this.all().find(session =>
      session.id !== excludeId &&
      session.accountId === accountId &&
      session.phase !== 'closing' &&
      session.replacedBySessionId === undefined &&
      !session.socket.destroyed,
    );
  }

  /** Sessions currently in a given room. */
  inRoom(roomId: string): ClientSession[] {
    return this.all().filter(s => s.roomId === roomId);
  }

  /** World sessions that are currently live and initialized. */
  worldSessions(): ClientSession[] {
    return this.all().filter(
      session => session.phase === 'world' &&
        session.worldInitialized &&
        !session.socket.destroyed,
    );
  }

  /** Broadcast raw bytes to all sessions in a room except the sender. */
  broadcastToRoom(roomId: string, data: Buffer, excludeId: string): void {
    for (const session of this.inRoom(roomId)) {
      if (session.id !== excludeId && !session.socket.destroyed) {
        session.socket.write(data);
      }
    }
  }

  get count(): number {
    return this.sessions.size;
  }
}
