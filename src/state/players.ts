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
  | 'closing';      // disconnect in progress

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
   * House allegiance chosen during character creation: one of
   * Davion | Steiner | Liao | Marik | Kurita.
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
