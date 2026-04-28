/**
 * In-memory presence store — tracks which room each player is currently in.
 *
 * Not persisted to DB; cleared on server restart.  Sufficient for M4 local
 * play; WebSocket push updates replace polling in a later milestone.
 */

export class PresenceStore {
  /** roomId → set of display-name strings currently in that room. */
  private readonly _map = new Map<number, Set<string>>();

  /**
   * Move `username` to `roomId`.  Removes the player from their previous
   * room automatically.
   */
  travel(username: string, roomId: number): void {
    this._removeUser(username);
    let occupants = this._map.get(roomId);
    if (!occupants) {
      occupants = new Set();
      this._map.set(roomId, occupants);
    }
    occupants.add(username);
  }

  /** Ordered list of usernames currently in a specific room. */
  getRoomOccupants(roomId: number): string[] {
    return [...(this._map.get(roomId) ?? [])].sort();
  }

  /**
   * Snapshot of all rooms that have at least one occupant.
   * Rooms with no occupants are omitted.
   */
  getAll(): Array<{ roomId: number; occupants: string[] }> {
    const out: Array<{ roomId: number; occupants: string[] }> = [];
    for (const [roomId, occupants] of this._map) {
      if (occupants.size > 0) {
        out.push({ roomId, occupants: [...occupants].sort() });
      }
    }
    return out;
  }

  /** Remove a player from whichever room they are in (e.g. on disconnect). */
  remove(username: string): void {
    this._removeUser(username);
  }

  private _removeUser(username: string): void {
    for (const [roomId, occupants] of this._map) {
      if (occupants.has(username)) {
        occupants.delete(username);
        if (occupants.size === 0) this._map.delete(roomId);
        return;
      }
    }
  }
}

export const presenceStore = new PresenceStore();
