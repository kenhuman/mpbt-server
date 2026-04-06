/**
 * Per-connection player session state.
 */

import type { Socket } from 'net';

export type SessionPhase =
  | 'connected'     // TCP accepted, waiting for first bytes
  | 'auth'          // parsing login packet
  | 'lobby'         // authenticated; about to look up or create character
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
   * House allegiance — one of Davion | Steiner | Liao | Marik | Kurita.
   * Set from the characters table after login, or persisted from cmd-5 during
   * the first-login allegiance-picker wizard (wire format confirmed via RE).
   */
  allegiance?: string;
  /**
   * True once the Cmd4 SceneInit / world init sequence has been sent.
   * Used to distinguish the first cmd-3 (needs full init) from subsequent
   * re-triggers (e.g. post-allegiance-pick) that only need an ack.
   */
  arenaInitialized: boolean;
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

  /** Sessions currently in a given room. */
  inRoom(roomId: string): ClientSession[] {
    return [...this.sessions.values()].filter(s => s.roomId === roomId);
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
