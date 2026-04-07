/**
 * Launch registry — bridges the lobby server and world server.
 *
 * When a player confirms mech selection and the lobby sends REDIRECT, it calls
 * launchRegistry.record() to store the pending launch keyed by username.
 * The world server calls launchRegistry.consume() on the new TCP connection to
 * retrieve and remove the entry.
 *
 * Singleton module: both server.ts and server-world.ts import the same instance.
 */

export interface PendingLaunch {
  /** Database account row ID, when the launch came from an authenticated lobby session. */
  accountId?: number;
  /** Character callsign shown in world UI. */
  displayName?: string;
  /** House allegiance selected during character creation. */
  allegiance?: string;
  /** Selected mech ID (from MechEntry.id — the MPBT.MSG variant table index). */
  mechId: number;
  /** Selected mech slot (0-based sort position in the mech list). */
  mechSlot: number;
  /** Mech designation string (e.g. "AS7-D"). */
  mechTypeString: string;
}

class LaunchRegistry {
  private readonly pending = new Map<string, PendingLaunch>();

  /**
   * Record a pending world launch for the given player.
   * Called by the lobby server immediately before sending REDIRECT.
   */
  record(username: string, launch: PendingLaunch): void {
    this.pending.set(username.toLowerCase(), launch);
  }

  /**
   * Consume (retrieve and remove) the pending launch for the given player.
   * Called by the world server after the player's LOGIN packet is validated.
   * Returns undefined if no pending launch entry exists.
   */
  consume(username: string): PendingLaunch | undefined {
    const key = username.toLowerCase();
    const value = this.pending.get(key);
    if (value !== undefined) this.pending.delete(key);
    return value;
  }

  get count(): number {
    return this.pending.size;
  }
}

/** Singleton shared between lobby and world servers (same Node.js process). */
export const launchRegistry = new LaunchRegistry();
