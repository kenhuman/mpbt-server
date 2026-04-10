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
  /** Scripted bot hit points for the current single-client combat prototype. */
  botHealth?: number;
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
  /** Per-mech speedMag cap (mec_speed * 450), set at combat bootstrap. */
  combatMaxSpeedMag?: number;

  // ── 3-step mech picker state ──────────────────────────────────────────────

  /** Which step of the mech-picker dialog the player is on. */
  mechPickerStep?: 'class' | 'chassis' | 'variant';
  /** Weight-class index (0=Light, 1=Medium, 2=Heavy, 3=Assault) chosen in step 1. */
  mechPickerClass?: number;
  /** Chassis name (e.g. "Jenner") chosen in step 2. */
  mechPickerChassis?: string;
  /** Page offset for the chassis picker when a weight class has more than 20 rows. */
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
