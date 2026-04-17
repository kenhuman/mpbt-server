/**
 * Combat prototype tuning constants.
 *
 * All numeric values that control the scripted single-client combat prototype
 * are centralised here so they can be adjusted without touching the handler
 * logic in world-handlers.ts.
 */

// ── Scripted combat durability ────────────────────────────────────────────────

/** Baseline server-side durability counter used for simple bot/player estimates. */
export const BOT_INITIAL_HEALTH = 100;

/** Initial bot stand-off distance in combat world units (100m north). */
export const BOT_SPAWN_DISTANCE = 100_000;

/**
 * Fallback per-weapon damage used when the firing mech's weapon loadout is not
 * documented in BT-MAN yet. Chosen to approximate a medium weapon hit.
 */
export const BOT_FALLBACK_WEAPON_DAMAGE = 5;

// ── Jump jets ──────────────────────────────────────────────────────────────────

/** Combat-world coordinate scale: 1000 units = 1 meter. */
export const COMBAT_WORLD_UNITS_PER_METER = 1_000;

/**
 * Fallback visible jump apex (meters) when a chassis has jump jets but no
 * documented BT-MAN jump range yet.
 */
export const JUMP_JET_DEFAULT_APEX_METERS = 48;

/** Number of ascent updates before the prototype jump arc peaks. */
export const JUMP_JET_ASCENT_STEPS = 5;

/** Tick interval (ms) for prototype jump-jet altitude updates. */
export const JUMP_JET_TICK_MS = 120;

/** Jump-jet fuel max value; client caps DAT_004f21a2 at 0x78 (120). */
export const JUMP_JET_FUEL_MAX = 120;

/** Client requires fuel > 0x32 (50) before it emits cmd12/action 4. */
export const JUMP_JET_START_FUEL_THRESHOLD = 50;

/** Jump-jet fuel drained on each ascent/descent tick. */
export const JUMP_JET_FUEL_DRAIN_PER_TICK = 8;

/** Passive grounded jump-jet fuel regen interval (ms); client updates fuel continuously. */
export const JUMP_JET_FUEL_REGEN_INTERVAL_MS = 100;

/** Passive grounded jump-jet fuel regen amount per interval tick; client adds dt*10/100. */
export const JUMP_JET_FUEL_REGEN_PER_TICK = 10;

// ── Collision-damage research probes ───────────────────────────────────────────

/** Horizontal distance (combat world units) considered "close contact" for probe logging. */
export const COLLISION_PROBE_HORIZONTAL_DISTANCE = 18_000;

/** Vertical tolerance for grounded overlap probes when neither actor is airborne. */
export const COLLISION_PROBE_VERTICAL_TOLERANCE = 2_500;

/** Cooldown between repeated collision-candidate probe logs for the same duel pair. */
export const COLLISION_PROBE_LOG_COOLDOWN_MS = 1_500;

/** Landing events inside this window are tagged as possible jump-impact candidates. */
export const COLLISION_PROBE_LANDING_WINDOW_MS = 1_000;

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
