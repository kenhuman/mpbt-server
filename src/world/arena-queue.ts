/**
 * In-memory arena staging queue.
 *
 * Tracks which players are waiting for an arena match, their selected mech,
 * and their ready status.  Not persisted to DB; clears on server restart.
 *
 * The queue uses the player's display_name (X-Username) as the identifier,
 * consistent with the rest of the mpbt-server REST API.
 *
 * Launch semantics:
 *   - Any queue size ≥ 1 may launch when all slots are ready.
 *   - A single-player launch is a solo-vs-bot practice match.
 *   - A multi-player launch is a PvP match.
 *   - After launch, pendingMatch is set so late-joining WS clients can
 *     recover the launch event; the queue is cleared.
 */

export interface ArenaSlot {
  username: string;
  mechId: number;
  typeString: string;
  joinedAt: number;
  ready: boolean;
}

export interface PendingMatch {
  arenaId: string;
  slots: ArenaSlot[];
  launchedAt: number;
}

class ArenaQueue {
  private _slots: ArenaSlot[] = [];
  private _pendingMatch: PendingMatch | null = null;

  /**
   * Join the queue.  If the player is already in the queue, their mech is
   * updated and ready is reset to false (mech change voids readiness).
   */
  join(username: string, mechId: number, typeString: string): ArenaSlot {
    const existing = this._slots.find((s) => s.username === username);
    if (existing) {
      if (existing.mechId !== mechId || existing.typeString !== typeString) {
        existing.mechId = mechId;
        existing.typeString = typeString;
        existing.ready = false;
      }
      return existing;
    }
    const slot: ArenaSlot = {
      username,
      mechId,
      typeString,
      joinedAt: Date.now(),
      ready: false,
    };
    this._slots.push(slot);
    return slot;
  }

  /** Remove the player from the queue. Returns true if they were queued. */
  leave(username: string): boolean {
    const idx = this._slots.findIndex((s) => s.username === username);
    if (idx < 0) return false;
    this._slots.splice(idx, 1);
    return true;
  }

  /**
   * Set the ready state for a player.
   * Returns the updated slot, or null if the player is not in the queue.
   */
  setReady(username: string, ready: boolean): ArenaSlot | null {
    const slot = this._slots.find((s) => s.username === username);
    if (!slot) return null;
    slot.ready = ready;
    return slot;
  }

  getAll(): ArenaSlot[] {
    return [...this._slots];
  }

  getSlot(username: string): ArenaSlot | undefined {
    return this._slots.find((s) => s.username === username);
  }

  /** True when there is at least one queued player and all are ready. */
  isAllReady(): boolean {
    return this._slots.length > 0 && this._slots.every((s) => s.ready);
  }

  /**
   * Record a pending match launch.  Clears the queue so players can re-queue
   * after the match; pendingMatch is retained for WS reconnect recovery.
   */
  recordLaunch(arenaId: string): PendingMatch {
    const match: PendingMatch = {
      arenaId,
      slots: [...this._slots],
      launchedAt: Date.now(),
    };
    this._pendingMatch = match;
    this._slots = [];
    return match;
  }

  /**
   * The most recently launched match, if any.  Cleared when a new player
   * joins (i.e. after the match ends and players return to queue).
   */
  get pendingMatch(): PendingMatch | null {
    return this._pendingMatch;
  }

  /** Clear a stale pending match (e.g. when a new queue cycle begins). */
  clearPendingMatch(): void {
    this._pendingMatch = null;
  }
}

export const arenaQueue = new ArenaQueue();
