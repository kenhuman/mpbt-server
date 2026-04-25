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

/**
 * Combat-world coordinate scale: the client radar/render path truncates each x/y
 * delta by 100, then runs integer sqrt(dx^2 + dy^2) against the selected
 * 50/100/300/800/2500 radar-range setting. That makes 100 combat world units
 * correspond to 1 displayed meter.
 */
export const COMBAT_WORLD_UNITS_PER_METER = 100;

/** Initial shared remote-actor stand-off distance in combat world units (3000m north). */
export const BOT_SPAWN_DISTANCE = 3_000 * COMBAT_WORLD_UNITS_PER_METER;

/** Initial single-player AI-bot stand-off distance in combat world units (3000m north). */
export const BOT_AI_SPAWN_DISTANCE = BOT_SPAWN_DISTANCE;

/**
 * Fallback per-weapon damage used when the firing mech's weapon loadout is not
 * documented in BT-MAN yet. Chosen to approximate a medium weapon hit.
 */
export const BOT_FALLBACK_WEAPON_DAMAGE = 5;

// ── Jump jets ──────────────────────────────────────────────────────────────────

/**
 * Fallback visible jump apex (meters) when a chassis has jump jets but no
 * documented BT-MAN jump range yet.
 */
export const JUMP_JET_DEFAULT_APEX_METERS = 48;

/** Number of ascent updates before the prototype jump arc peaks. */
export const JUMP_JET_ASCENT_STEPS = 5;

/** Tick interval (ms) for prototype jump-jet altitude updates. */
export const JUMP_JET_TICK_MS = 120;

/**
 * Peer-only jump mirror duration scale. A Jenner's manual/.MEC-aligned 150m jump
 * maps to a ~75m apex and roughly a 5s retail-local airtime in live capture.
 */
export const JUMP_JET_REMOTE_MIRROR_MS_PER_APEX_METER = 67;

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
export const COLLISION_PROBE_HORIZONTAL_DISTANCE = 18 * COMBAT_WORLD_UNITS_PER_METER;

/** Vertical tolerance for grounded overlap probes when neither actor is airborne. */
export const COLLISION_PROBE_VERTICAL_TOLERANCE = Math.round(2.5 * COMBAT_WORLD_UNITS_PER_METER);

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

/** Tick interval (ms) for the live bot-combat movement / fire planner. */
export const BOT_AI_TICK_MS = 250;

/** Cmd72 grounded acceleration scalar (client DAT_004f56b4 / globalA). */
export const COMBAT_GLOBAL_A = 1462;
/** Cmd72 grounded drag offset (client DAT_004f1d24 / globalB). */
export const COMBAT_GLOBAL_B = 39;
/** Cmd72 airborne damping scalar (client DAT_004f5684 / globalC). */
export const COMBAT_GLOBAL_C = 0;

/** Shortest distance band the bot tries to hold while maneuvering. */
export const BOT_AI_MIN_PREFERRED_RANGE_METERS = 90;

/** Long-range standoff cap so bots still close inside the prototype arena. */
export const BOT_AI_MAX_PREFERRED_RANGE_METERS = 360;

/** Slack around the preferred range before the bot switches between hold/advance/retreat. */
export const BOT_AI_RANGE_BUFFER_METERS = 24;

/** Minimum time between deliberate bot jump-jet commits. */
export const BOT_AI_JUMP_COOLDOWN_MS = 2_100;

/** Minimum weapon-fit gain before the bot spends jump fuel on a reposition jump. */
export const BOT_AI_JUMP_RANGE_FIT_GAIN_THRESHOLD = 4;

/** Additional buffer around the player's longest weapon range that still counts as dangerous. */
export const BOT_AI_PLAYER_THREAT_BUFFER_METERS = 60;

/** Heuristic per-band weights used when deciding whether a jump meaningfully improves current weapon fit. */
export const BOT_AI_RANGE_FIT_SHORT_WEIGHT = 1.0;
export const BOT_AI_RANGE_FIT_MEDIUM_WEIGHT = 0.75;
export const BOT_AI_RANGE_FIT_LONG_WEIGHT = 0.45;

/** Additional preferred-range offset when the bot can exploit a range advantage. */
export const BOT_AI_RANGE_ADVANTAGE_BONUS_METERS = 45;

/** Preferred-range compression used when the bot needs to force a closer fight. */
export const BOT_AI_RANGE_PRESSURE_BONUS_METERS = 25;

/** Damaged opponents invite a stronger closing push from short-range loadouts. */
export const BOT_AI_FINISHER_PUSH_HEALTH_THRESHOLD = 24;

/** Heat model: approximate one full heat-sink cycle every few seconds, not every tick. */
export const BOT_AI_HEAT_DISSIPATION_WINDOW_MS = 3_000;

/** TIC-A / TIC-B / TIC-C budgets expressed as multiples of total heat sinks. */
export const BOT_AI_TIC_ALPHA_HEAT_RATIO = 1.2;
export const BOT_AI_TIC_SUSTAIN_HEAT_RATIO = 0.8;
export const BOT_AI_TIC_POKE_HEAT_RATIO = 0.45;

/** Risk caps used when picking between aggressive and cooling volleys. */
export const BOT_AI_TIC_SAFE_OVERHEAT_RISK = 0.55;
export const BOT_AI_TIC_FINISHER_OVERHEAT_RISK = 0.82;

/** Baseline single-shot hit chance before range / motion modifiers. */
export const BOT_TO_HIT_BASE_CHANCE = 0.69;

/** Clamp so the prototype still allows both misses and strong close-range hits. */
export const BOT_TO_HIT_MIN_CHANCE = 0.18;
export const BOT_TO_HIT_MAX_CHANCE = 0.88;

/** Close-range shots are noticeably easier than medium / long-range fire. */
export const BOT_TO_HIT_SHORT_RANGE_BONUS = 0.12;
export const BOT_TO_HIT_MEDIUM_RANGE_BONUS = 0.05;
export const BOT_TO_HIT_LONG_RANGE_MAX_PENALTY = 0.22;

/** Fast-moving attackers and defenders both degrade hit probability. */
export const BOT_TO_HIT_ATTACKER_SPEED_MAX_PENALTY = 0.12;
export const BOT_TO_HIT_TARGET_SPEED_MAX_PENALTY = 0.18;

/** Crossing targets are harder to hit than mechs moving straight in/out. */
export const BOT_TO_HIT_TARGET_CROSSING_MAX_PENALTY = 0.22;

/** Jumping is intentionally harder for both the attacker and defender. */
export const BOT_TO_HIT_ATTACKER_JUMP_PENALTY = 0.08;
export const BOT_TO_HIT_TARGET_JUMP_PENALTY = 0.12;

/** Miss visuals land beside the target instead of always "hitting" center mass. */
export const BOT_MISS_OFFSET_MIN_METERS = 10;
export const BOT_MISS_OFFSET_MAX_METERS = 36;

// ── Scripted verification ────────────────────────────────────────────────────

/** Delay before scripted verification actions run after bootstrap. */
export const VERIFY_DELAY_MS = 1200;

/** Delay between scripted damage sweep packets (ms). */
export const VERIFY_SWEEP_STEP_MS = 700;

/** Damage codes used for quick client-side classifier probing. */
export const VERIFY_DAMAGE_CODES = [1, 2, 8, 16, 32, 64] as const;

