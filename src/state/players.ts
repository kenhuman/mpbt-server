/**
 * Per-connection player session state.
 */

import type { Socket } from 'net';

export type SessionPhase =
  | 'connected'     // TCP accepted, waiting for first bytes
  | 'auth'          // parsing login packet
  | 'lobby'         // authenticated; about to look up or create character
  | 'char-creation' // first-login character creation in progress (callsign + allegiance)
  | 'world'         // in the game world (RPS/arena) after REDIRECT
  | 'combat'        // in a combat arena; client uses combat dispatch table
  | 'closing';      // disconnect in progress

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
  /** True once the combat bootstrap sequence (MMC welcome + Cmd72) has been sent. */
  combatInitialized?: boolean;
  /** Repeating setInterval that sends bot position updates during combat. */
  botPositionTimer?: ReturnType<typeof setInterval>;
  /** Repeating setInterval that sends Cmd67 retaliatory damage to the player during combat. */
  botFireTimer?: ReturnType<typeof setInterval>;
  /** One-shot timeout that advances a dead bot from fall animation into wreck state. */
  botDeathTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that sends the combat match result / result-scene transition. */
  combatResultTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that returns the client from the result scene back to world mode. */
  combatWorldRestoreTimer?: ReturnType<typeof setTimeout>;
  /** One-shot timeout that delays Cmd72+ combat bootstrap so DROP can display first. */
  combatBootstrapTimer?: ReturnType<typeof setTimeout>;
  /** Repeating setInterval that drives prototype jump-jet ascent/descent updates. */
  combatJumpTimer?: ReturnType<typeof setInterval>;
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
   * Stable per-connection roster identifier used by world presence packets
   * (Cmd10/Cmd11/Cmd12/Cmd13). This is distinct from accountId and only needs to be
   * unique within the current server process.
   */
  worldRosterId?: number;
  /**
   * Current room-presence state byte used by Cmd10/Cmd11 updates.
   * 5 = standing, 6..12 = booth 1..7.
   */
  worldPresenceStatus?: number;
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

  /** Optional scripted combat verification mode consumed on the next /fight bootstrap. */
  combatVerificationMode?: 'autowin' | 'autolose' | 'dmglocal' | 'dmgbot' | 'strictfire' | 'headtest';

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
  /** Last raw heading value from client Cmd8/9. */
  combatHeadingRaw?: number;
  /** Last decoded throttle velocity echoed in Cmd65 responses. */
  combatThrottle?: number;
  /** Last decoded leg velocity echoed in Cmd65 responses. */
  combatLegVel?: number;
  /** Current speedMag echoed in Cmd65 responses. */
  combatSpeedMag?: number;
  /**
   * Prototype jump-jet altitude echoed in Cmd65 responses.
   * This is a server-side estimate only; real fuel/arc physics remain unknown.
   */
  combatJumpAltitude?: number;
  /** Prototype jump-jet fuel percentage (0..100). */
  combatJumpFuel?: number;
  /** Timestamp (ms) of the last cmd12/action 0 fire trigger frame from client. */
  lastCombatFireActionAt?: number;
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
   * Order matches Cmd66 class-2 internal codes 0x20..0x27.
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
  /**
   * Server-side remaining local-armor values for the player.
   * Order matches Cmd66/67 class-1 codes 0x15..0x1e.
   */
  combatPlayerArmorValues?: number[];
  /**
   * Server-side remaining local internal-structure values for the player.
   * Order matches Cmd66/67 class-2 internal codes 0x20..0x27.
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
}

export class PlayerRegistry {
  private sessions = new Map<string, ClientSession>();

  add(session: ClientSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): ClientSession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  all(): ClientSession[] {
    return [...this.sessions.values()];
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
