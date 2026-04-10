/**
 * Combat prototype tuning constants.
 *
 * All numeric values that control the scripted single-client combat prototype
 * are centralised here so they can be adjusted without touching the handler
 * logic in world-handlers.ts.
 */

// ── Scripted bot health ───────────────────────────────────────────────────────

/** Server-side HP counter for the scripted single-client bot opponent. */
export const BOT_INITIAL_HEALTH = 100;

/** Prototype damage applied to the scripted bot for each cmd10 fire frame. */
export const BOT_DAMAGE_PER_HIT = 20;

// ── Jump jets ──────────────────────────────────────────────────────────────────

/** Prototype jump-jet altitude echoed through Cmd65 after cmd12/action 4. */
export const JUMP_JET_ALTITUDE = 1200;

/** Altitude step per jump-jet tick for the prototype ascent/descent arc. */
export const JUMP_JET_STEP = 240;

/** Tick interval (ms) for prototype jump-jet altitude updates. */
export const JUMP_JET_TICK_MS = 120;

/** Jump-jet fuel max value (percentage-like integer scale). */
export const JUMP_JET_FUEL_MAX = 100;

/** Jump-jet fuel drained on each ascent/descent tick. */
export const JUMP_JET_FUEL_DRAIN_PER_TICK = 8;

/** Grounded jump-jet fuel regen applied on each movement frame. */
export const JUMP_JET_FUEL_REGEN_PER_FRAME = 2;

/** Passive grounded jump-jet fuel regen interval (ms). */
export const JUMP_JET_FUEL_REGEN_INTERVAL_MS = 500;

/** Passive grounded jump-jet fuel regen amount per interval tick. */
export const JUMP_JET_FUEL_REGEN_PER_TICK = 4;

// ── Weapon fire gate ──────────────────────────────────────────────────────────

/** Max age (ms) for correlating cmd12/action0 to the following cmd10 shot frame. */
export const FIRE_ACTION_WINDOW_MS = 1_000;

// ── Bot retaliation ───────────────────────────────────────────────────────────

/** Interval (ms) at which the scripted bot fires back at the player. */
export const BOT_FIRE_INTERVAL_MS = 3_000;

/** Prototype damage per bot retaliatory shot (Cmd67 damageCode=1, value=10). */
export const BOT_RETALIATION_DAMAGE = 10;

// ── Scripted verification ────────────────────────────────────────────────────

/** Delay before scripted verification actions run after bootstrap. */
export const VERIFY_DELAY_MS = 1200;

/** Delay between scripted damage sweep packets (ms). */
export const VERIFY_SWEEP_STEP_MS = 700;

/** Damage codes used for quick client-side classifier probing. */
export const VERIFY_DAMAGE_CODES = [1, 2, 8, 16, 32, 64] as const;

// ── Movement scaling ──────────────────────────────────────────────────────────

/**
 * KP8 full-forward produces sVar2 ≈ 20 in the client's throttle accumulator.
 * Using 20 as the scale means sVar2=20 → maxSpeedMag (run speed).
 */
export const THROTTLE_RUN_SCALE = 20;
