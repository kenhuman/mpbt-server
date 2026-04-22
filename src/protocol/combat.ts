/**
 * Combat-server protocol encoder — MPBT Solaris combat (arena) commands.
 *
 * All commands here are server→client and use COMBAT CRC mode
 * (seed 0x0A5C45; DAT_0047d05c == 4 in v1.23 client).
 *
 * ── Naming convention ────────────────────────────────────────────────────────
 * The research labels (Cmd64..Cmd73) follow the convention documented in
 * RESEARCH.md §19.6.1 and are used as-is in exported function names.
 * They ARE the dispatch-table indices.  The relationship is:
 *
 *   wire_byte  = ResearchCmd + 0x21   (e.g. Cmd64 → wire 0x61)
 *   tableIndex = wire_byte  − 0x21   (dispatch slot used by buildGamePacket)
 *   tableIndex = ResearchCmd
 *
 * ── Coordinate encoding ──────────────────────────────────────────────────────
 * World coordinates are stored with a fixed-point centre offset:
 *   wire_type3 = worldCoord + COORD_BIAS    (decode: raw − COORD_BIAS)
 * Altitude (z) is sent as type2 with no bias.
 *
 * ── Motion encoding ──────────────────────────────────────────────────────────
 * type1 motion fields in Cmd65 use a neutral-point bias of MOTION_NEUTRAL.
 * facing has a different base (FACING_BASE); throttle is sign-inverted.
 * See encodeMotion* helpers below.
 *
 * Source of truth: RESEARCH.md §19 (especially §19.6.1).
 * Status annotations:
 *   CONFIRMED — field layout verified by Ghidra or live capture
 *   PARTIAL   — layout inferred from static RE; live capture still needed
 *   ASSUMPTION— field present but purpose/encoding not yet confirmed
 */

import {
  buildGamePacket,
  encodeAsByte,
  encodeB85_1,
  encodeB85_2,
  encodeB85_3,
  encodeString,
} from './game.js';

export const COMBAT_RESULT_VICTORY = 0;
export const COMBAT_RESULT_LOSS = 1;

// ── Constants ─────────────────────────────────────────────────────────────────

/** World-coordinate bias added before type3 encoding. CONFIRMED §19.6.1. */
export const COORD_BIAS = 0x18e4258; // 26,100,312

/** Neutral-point bias for type1 velocity/motion fields. CONFIRMED §19.2. */
export const MOTION_NEUTRAL = 0x0e1c; // 3,612

/**
 * Base for the facing/heading type1 field in Cmd65.
 * CONFIRMED §19.6.1: facing = (raw − 0x0dc2) * 0xb6
 */
const FACING_BASE = 0x0dc2; // 3,522

/** Divisor shared by all motion accumulator fields. CONFIRMED §19.2. */
export const MOTION_DIV = 0xb6; // 182

/**
 * Neutral DAT_004f1d5c value used by the client-side cmd8/cmd9 sender when
 * reconstructing the first trailing type1 motion field.
 * RE/Ghidra: sVar4 = (DAT_004f1d5c - 0x3ffc) / 0xb6; wire = sVar4 + 0x0e1c.
 */
export const FACING_ACCUMULATOR_NEUTRAL = 0x3ffc; // 16,380

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Encode a signed world coordinate as type3 (4 bytes, COORD_BIAS applied). */
function encodeCoordX(v: number): Buffer { return encodeB85_3(v + COORD_BIAS); }
function encodeCoordY(v: number): Buffer { return encodeB85_3(v + COORD_BIAS); }

/** Encode the Cmd65 facing field: raw = facing / MOTION_DIV + FACING_BASE. CONFIRMED §19.6.1. */
function encodeFacing(facing: number): Buffer {
  return encodeB85_1(Math.round(facing / MOTION_DIV) + FACING_BASE);
}

/** Encode the Cmd65 throttle field (sign-inverted): raw = MOTION_NEUTRAL − throttle / MOTION_DIV. CONFIRMED §19.6.1. */
function encodeThrottle(throttle: number): Buffer {
  return encodeB85_1(MOTION_NEUTRAL - Math.round(throttle / MOTION_DIV));
}

/** Encode the Cmd65 leg-velocity field: raw = legVel / MOTION_DIV + MOTION_NEUTRAL. CONFIRMED §19.6.1. */
function encodeLegVel(legVel: number): Buffer {
  return encodeB85_1(Math.round(legVel / MOTION_DIV) + MOTION_NEUTRAL);
}

/** Encode the Cmd65 speed-magnitude field: raw = speedMag + MOTION_NEUTRAL. CONFIRMED §19.6.1. */
function encodeSpeedMag(speedMag: number): Buffer {
  return encodeB85_1(speedMag + MOTION_NEUTRAL);
}

/**
 * Encode a string with a wider length field (up to 222 bytes).
 * Cmd72 allows scenario titles up to 159 bytes (decompiled buffer size);
 * standard encodeString() caps at 84 bytes.
 * Encoding: [len + 0x21] + raw latin1 — identical protocol to encodeString.
 */
function encodeLongString(s: string, maxBytes: number): Buffer {
  const raw = Buffer.from(s, 'latin1').subarray(0, maxBytes);
  if (raw.includes(0x1b)) throw new RangeError('encodeLongString: text must not contain ESC');
  if (raw.length > 222) throw new RangeError(`encodeLongString: string too long (${raw.length} > 222)`);
  return Buffer.concat([Buffer.from([raw.length + 0x21]), raw]);
}

// ── Cmd62 / wire 0x5f / table index 62 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040d7f0 @ 0040d7f0 — All-actors-ready / combat-start.
//
// Wire layout: NO PAYLOAD.
//
// Effect: clears DAT_0047ef60 bit 0x20 (the "waiting for actors" gate that blocks
// SPACEBAR firing and other combat actions).  Also sets bits 0x04 and 0x10, and
// resets _DAT_0047ef70 (expected-actor counter) to 0.
//
// Must be sent after all Cmd64 (actor add) and Cmd65 (initial position) packets
// so the client can transition out of the "waiting" state and allow weapon fire.

/** Build a Cmd62 combat-start signal packet.  No payload.  CONFIRMED. */
export function buildCmd62CombatStartPacket(seq = 0): Buffer {
  return buildGamePacket(62, Buffer.alloc(0), true, seq); // wire 0x5f
}

// ── Cmd63 / wire 0x60 / table index 63 ───────────────────────────────────────
// CONFIRMED — handler FUN_00445870 — combat teardown / result-scene transition.
//
// Wire layout: NO PAYLOAD.
//
// Current v1.23 read from Ghidra:
//   • chooses a `scenes.dat` resource based on DAT_004e16d8 (`VICT` or `LOST`)
//   • tears down combat-local state
//   • transitions out of active combat mode
//
// The preceding result selector is handled by Cmd75.

/** Build a Cmd63 arena-scene-init packet. No payload. CONFIRMED. */
export function buildCmd63ArenaSceneInitPacket(seq = 0): Buffer {
  return buildGamePacket(63, Buffer.alloc(0), true, seq); // wire 0x60
}

// ── Cmd64 / wire 0x61 / table index 64 ───────────────────────────────────────
// CONFIRMED — handler Combat_Cmd64_AddActor_v123 @ 0040d390 — Remote actor add.
//
// Wire layout (confirmed by Ghidra decompile):
//   slot          byte   — external slot ID; client assigns internal slot and
//                          stores reverse-mapping in DAT_00478d98/DAT_00478dc0
//   actorTypeByte byte   — stored at DAT_004f2036 + internalSlot*0x49c; purpose
//                          semantically unconfirmed; use 0 for prototype
//   identity0     str11  — max 11 bytes; trailing digits → actor display index
//   identity1     str31  — max 31 bytes
//   identity2     str39  — max 39 bytes
//   identity3     str15  — max 15 bytes
//   identity4     str31  — max 31 bytes
//   statusByte    byte   — stored at DAT_004f1fe6+slot*0x4ec; purpose unconfirmed
//   mechId        type2  — triggers .MEC load via FUN_00433860
//
// No damage-state block: damage state is initialised from the .MEC file locally
// via Combat_InitDamageStateFromMec_v123, not received from the server.

export interface Cmd64RemoteActor {
  slot: number;
  /**
   * Second byte after slot; stored at DAT_004f2036 + internalSlot*0x49c.
   * Semantics unconfirmed — send 0 for prototype.
   */
  actorTypeByte: number;
  /** max 11 bytes — identity string 0; trailing digits → actor display index */
  identity0: string;
  /** max 31 bytes — identity string 1 */
  identity1: string;
  /** max 39 bytes — identity string 2 */
  identity2: string;
  /** max 15 bytes — identity string 3 */
  identity3: string;
  /** max 31 bytes — identity string 4 */
  identity4: string;
  /**
   * Byte stored at DAT_004f1fe6 + slot*0x4ec.
   * Same struct field as Cmd72 statusByte; semantics unconfirmed — send 0.
   */
  statusByte: number;
  /** mech variant id; client loads matching .MEC file */
  mechId: number;
}

/** Build a Cmd64 remote-actor-add packet. CONFIRMED §19.6.1 + Ghidra decompile. */
export function buildCmd64RemoteActorPacket(actor: Cmd64RemoteActor, seq = 0): Buffer {
  const args = Buffer.concat([
    encodeAsByte(actor.slot),
    encodeAsByte(actor.actorTypeByte),
    encodeString(actor.identity0.substring(0, 11)),
    encodeString(actor.identity1.substring(0, 31)),
    encodeString(actor.identity2.substring(0, 39)),
    encodeString(actor.identity3.substring(0, 15)),
    encodeString(actor.identity4.substring(0, 31)),
    encodeAsByte(actor.statusByte),
    encodeB85_2(actor.mechId),
  ]);
  return buildGamePacket(64, args, true, seq); // wire 0x61
}

// ── Cmd65 / wire 0x62 / table index 65 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040d830 — Server→client combat position/motion sync.
//
// Wire layout (after seq+cmd):
//   slot      byte     — actor slot
//   x         type3    — world X; client decodes: raw − COORD_BIAS
//   y         type3    — world Y; client decodes: raw − COORD_BIAS
//   z         type2    — altitude (no bias)
//   facing    type1    — (raw − FACING_BASE) * MOTION_DIV → DAT_004f1d5c
//   throttle  type1    — (MOTION_NEUTRAL − raw) * MOTION_DIV → DAT_004f1f7c
//                          likely upper-body pitch / bend accumulator
//   legVel    type1    — (raw − MOTION_NEUTRAL) * MOTION_DIV → DAT_004f1f7a
//                          likely torso-yaw / upper-body heading offset
//   speedMag  type1    — raw − MOTION_NEUTRAL → DAT_004f20a2 / DAT_004f1d9e
//
// Ghidra assumptions:
//   • Signed direction conventions for facing/throttle/legVel still need live
//     capture to confirm zero-north vs zero-east, and +/− pitch/yaw polarity.

export interface Cmd65PositionSync {
  slot: number;
  /** World X coordinate (centred at 0; server adds COORD_BIAS before encoding). */
  x: number;
  /** World Y coordinate. */
  y: number;
  /** Altitude / Z value (type2, no bias). */
  z: number;
  /** Facing/heading accumulator value (in mech internal units, divided by MOTION_DIV). */
  facing: number;
  /** Cmd65 throttle channel; likely the client's upper-body pitch / bend accumulator. */
  throttle: number;
  /** Cmd65 legVel channel; likely the client's torso-yaw / upper-body heading offset. */
  legVel: number;
  /** Forward/speed magnitude. */
  speedMag: number;
}

/** Build a Cmd65 position/motion sync packet. CONFIRMED §19.6.1. */
export function buildCmd65PositionSyncPacket(pos: Cmd65PositionSync, seq = 0): Buffer {
  const args = Buffer.concat([
    encodeAsByte(pos.slot),
    encodeCoordX(pos.x),
    encodeCoordY(pos.y),
    encodeB85_2(pos.z),
    encodeFacing(pos.facing),
    encodeThrottle(pos.throttle),
    encodeLegVel(pos.legVel),
    encodeSpeedMag(pos.speedMag),
  ]);
  return buildGamePacket(65, args, true, seq); // wire 0x62
}

// ── Cmd66 / wire 0x63 / table index 66 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040de50 — Remote actor damage code/value update.
//
// Wire layout:
//   slot        byte  — actor slot (mapped via DAT_00478d98)
//   damageCode  byte  — see Combat_ClassifyDamageCode_v123 (§19.6.1) for ranges
//   damageValue byte  — magnitude for the damage class
//
// The shared helper queues onto the active projectile/effect (Cmd68 context)
// if fewer than 0x14 pairs are already queued; otherwise applies immediately.

/** Build a Cmd66 remote-actor damage update packet. CONFIRMED §19.6.1. */
export function buildCmd66ActorDamagePacket(
  slot: number,
  damageCode: number,
  damageValue: number,
  seq = 0,
): Buffer {
  const args = Buffer.concat([
    encodeAsByte(slot),
    encodeAsByte(damageCode),
    encodeAsByte(damageValue),
  ]);
  return buildGamePacket(66, args, true, seq); // wire 0x63
}

// ── Cmd67 / wire 0x64 / table index 67 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040de80 — Local actor damage code/value update.
//
// Wire layout:
//   damageCode  byte  — same classification as Cmd66
//   damageValue byte
//
// No slot byte; always applies to local actor index 0.
// Also triggers HUD/audio feedback: FUN_004461c0(7), FUN_00422260(..., 100).

/** Build a Cmd67 local-actor damage update packet. CONFIRMED §19.6.1. */
export function buildCmd67LocalDamagePacket(
  damageCode: number,
  damageValue: number,
  seq = 0,
): Buffer {
  const args = Buffer.concat([
    encodeAsByte(damageCode),
    encodeAsByte(damageValue),
  ]);
  return buildGamePacket(67, args, true, seq); // wire 0x64
}

// ── Cmd68 / wire 0x65 / table index 68 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040e390 — Projectile/effect spawn.
//
// Wire layout:
//   sourceSlot    byte   — source actor slot (mapped via DAT_00478d98)
//   weaponSlot    byte   — weapon slot index on source actor
//   targetRaw     byte   — target actor slot + 1 (0 = no target; 10 = local actor)
//   targetAttach  byte   — target attachment site + 1 (0 = no attachment)
//   angleSeedA    type1  — angle seed A (helper recomputes from geometry if target known)
//   angleSeedB    type1  — angle seed B
//   impactX       type3  — fallback impact X (used if target/attachment unresolved)
//   impactY       type3  — fallback impact Y
//   impactZ       type2  — fallback impact Z (altitude)
//
// Sets DAT_00478df8 to the allocated effect id, which Cmd66/67 damage pairs
// may queue onto (up to 0x14 pairs), until Cmd71 clears the context.

export interface Cmd68ProjectileSpawn {
  sourceSlot: number;
  weaponSlot: number;
  /** 0 = no target; 10 = local actor encoding; otherwise target slot + 1. */
  targetRaw: number;
  /** 0 = no attachment; otherwise attach site + 1. */
  targetAttach: number;
  angleSeedA: number;
  angleSeedB: number;
  impactX: number;
  impactY: number;
  impactZ: number;
}

/** Build a Cmd68 projectile/effect spawn packet. CONFIRMED §19.6.1. */
export function buildCmd68ProjectileSpawnPacket(p: Cmd68ProjectileSpawn, seq = 0): Buffer {
  const args = Buffer.concat([
    encodeAsByte(p.sourceSlot),
    encodeAsByte(p.weaponSlot),
    encodeAsByte(p.targetRaw),
    encodeAsByte(p.targetAttach),
    encodeB85_1(p.angleSeedA),
    encodeB85_1(p.angleSeedB),
    encodeCoordX(p.impactX),
    encodeCoordY(p.impactY),
    encodeB85_2(p.impactZ),
  ]);
  return buildGamePacket(68, args, true, seq); // wire 0x65
}

// ── Cmd69 / wire 0x66 / table index 69 ───────────────────────────────────────
// PARTIAL — handler FUN_0040e570 — Impact/effect at coordinate.
//
// Wire layout (from static RE):
//   actorSlot     byte   — actor slot (mapped via DAT_00478d98)
//   skipByte      byte   — consumed but not used
//   targetRaw     byte   — same encoding as Cmd68 targetRaw
//   targetAttach  byte   — same encoding as Cmd68 targetAttach
//   impactX       type3
//   impactY       type3
//   impactZ       type2
//
// Triggers impact audio/visual helpers; does NOT apply mech damage state.
//
// Ghidra assumptions:
//   • skipByte purpose unknown; send 0 until live capture clarifies.

export interface Cmd69ImpactAtCoord {
  actorSlot: number;
  targetRaw: number;
  targetAttach: number;
  impactX: number;
  impactY: number;
  impactZ: number;
}

/** Build a Cmd69 impact/effect-at-coordinate packet. PARTIAL §19.6.1. */
export function buildCmd69ImpactAtCoordPacket(p: Cmd69ImpactAtCoord, seq = 0): Buffer {
  const args = Buffer.concat([
    encodeAsByte(p.actorSlot),
    encodeAsByte(0),           // skipByte — purpose ASSUMPTION: send 0
    encodeAsByte(p.targetRaw),
    encodeAsByte(p.targetAttach),
    encodeCoordX(p.impactX),
    encodeCoordY(p.impactY),
    encodeB85_2(p.impactZ),
  ]);
  return buildGamePacket(69, args, true, seq); // wire 0x66
}

// ── Cmd70 / wire 0x67 / table index 70 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040e700 — Actor animation/status transition.
//
// Wire layout:
//   slot        byte  — actor slot
//   subcommand  byte  — handled by the client as:
//                         0 → stand/resume dispatch; defaults to FUN_0043b440, but
//                              routes to the destruction-tail helpers when the current
//                              anim state is already 7/8/9/10
//                         1 → FUN_0043b470 fall animation (clears actor +0x35e)
//                         4 → remote-only airborne/jump-state helper via FUN_0043b3e0;
//                              paired with local cmd12/action 4
//                         6 → landing resolution; after the remote position path updates
//                              descent state, this either calls FUN_0043b400 to stand or
//                              consumes the deferred-collapse bit and re-enters the same
//                              collapse path as subcommand 8
//                         8 → immediate collapse when grounded, or deferred collapse when
//                              the actor is still airborne; grounded path drives
//                              FUN_0043b4a0, sets actor +0x35e, and zeros motion state
//
// Ghidra assumptions:
//   • Exact retail trigger for the deferred-collapse/support gate still needs capture.

/** Build a Cmd70 actor animation/status transition packet. CONFIRMED §19.6.1. */
export function buildCmd70ActorTransitionPacket(
  slot: number,
  subcommand: number,
  seq = 0,
): Buffer {
  const args = Buffer.concat([
    encodeAsByte(slot),
    encodeAsByte(subcommand),
  ]);
  return buildGamePacket(70, args, true, seq); // wire 0x67
}

// ── Cmd71 / wire 0x68 / table index 71 ───────────────────────────────────────
// CONFIRMED — handler FUN_0040eae0 — Reset current projectile/effect globals.
//
// No wire arguments.  Sets DAT_00478df8 and DAT_00478dfc to −1, clearing
// the effect context used by Cmd66/67 queued damage pairs.
// Bracket Cmd68..Cmd66/67 sequences with Cmd71 to close the effect context.

/** Build a Cmd71 reset-effect-state packet. CONFIRMED §19.6.1. */
export function buildCmd71ResetEffectStatePacket(seq = 0): Buffer {
  return buildGamePacket(71, Buffer.alloc(0), true, seq); // wire 0x68
}

// ── Cmd72 / wire 0x69 / table index 72 ───────────────────────────────────────
// PARTIAL — handler Combat_Cmd72_InitLocalActor_v123 @ 00445110 — Local bootstrap.
//
// This is the first packet sent to a connecting combat client.  It seeds all
// local actor state and must precede Cmd64 remote-actor adds.
//
// Full field flow: RESEARCH.md §19.6.1, Combat_Cmd72_InitLocalActor_v123.
//
// Status of previously-assumed fields (all confirmed by Ghidra decompile):
//   • 5 identity strings (max 11/31/39/15/31) — CONFIRMED same layout as Cmd64.
//   • unknownByte0: read via FUN_00401a60() and result DISCARDED by client;
//     it is a protocol filler byte — safe to send 0.
//   • statusByte: stored at DAT_004f1fe6 — same struct offset as in Cmd64.
//   • globalA/B/C (three type2 values at DAT_004f56b4, DAT_004f1d24, DAT_004f5684):
//     shared throttle/jump gravity, grounded drag offset, airborne damping.
//   • headingBias type1 → client stores (raw − 0xe1c); seeds DAT_004f4210 heat bias.
//   • extraType2Values: count byte + N type2 values; send [] for prototype.
//   • remainingActorCount → DAT_0047ef70; if 0 → sets DAT_0047ef60 |= 4.
//   • unknownType1Raw: send MOTION_NEUTRAL (0xe1c) as raw for prototype.

export interface Cmd72TerrainPoint {
  x: number;
  y: number;
  z: number;
}

export interface Cmd72ArenaPoint {
  x: number;
  y: number;
}

export interface Cmd72MechDamageState {
  /** Mech variant id; client loads matching .MEC file. */
  mechId: number;
  /**
   * From .MEC offset 0x3c (signed).  Determines length of criticalStateBytes:
   *   if (count >= -20 && count !== -21) → emit 0x15 + count critical bytes.
   * Safe prototype default: 0.
   */
  critStateExtraCount: number;
  criticalStateBytes: number[];   // length === Math.max(0, 0x15 + critStateExtraCount) when emitted
  extraStateBytes: number[];
  armorLikeStateBytes: number[];  // exactly 11
  internalStateBytes: number[];   // exactly 8
  /** Each value encoded as type1 (encodeB85_1, 2 bytes each). */
  ammoStateValues: number[];
  /** max 31 bytes */
  actorDisplayName: string;
}

export interface Cmd72LocalBootstrap {
  /** Scenario/arena title; max 159 bytes (truncated to 159 if longer). */
  scenarioTitle: string;
  /** Server slot for the local player (mapped to DAT_00478d98[slot] = 0). */
  localSlot: number;
  /** ASSUMPTION: purpose unknown; send 0 until captured. */
  unknownByte0: number;
  /** Terrain set identifier; passed to Combat_SelectTerrainFileSet_v123. */
  terrainId: number;
  /** Terrain resource id (type2). */
  terrainResourceId: number;
  /** List of terrain interest points (coordinates decoded with COORD_BIAS). */
  terrainPoints: Cmd72TerrainPoint[];
  /** List of arena interest points; only first 10 are read by client. */
  arenaPoints: Cmd72ArenaPoint[];
  /** Shared throttle/jump gravity scale (DAT_004f56b4), encoded as type2. */
  globalA: number;
  /** Ground-only drag offset (DAT_004f1d24), encoded as type2. */
  globalB: number;
  /** Airborne damping scalar (DAT_004f5684), encoded as type2. */
  globalC: number;
  /** Heat-bias seed (DAT_004f4210), encoded as type1. */
  headingBias: number;
  /** max 11 bytes; trailing digits parsed into actor display id */
  identity0: string;
  /** max 31 bytes */
  identity1: string;
  /** max 39 bytes */
  identity2: string;
  /** max 15 bytes */
  identity3: string;
  /** max 31 bytes */
  identity4: string;
  /** ASSUMPTION: purpose unknown; send 0. */
  statusByte: number;
  initialX: number;
  initialY: number;
  /** If set, client reads additional bounds coordinates. */
  boundsX?: number;
  boundsY?: number;
  /** ASSUMPTION: currently unlabeled type2 values; use [] for prototype. */
  extraType2Values: number[];
  /**
   * Number of remaining (remote) actors to expect.
   * If 0, client sets DAT_0047ef60 |= 4.
   */
  remainingActorCount: number;
  /** ASSUMPTION: type1 value; send MOTION_NEUTRAL (0xe1c) as raw for prototype. */
  unknownType1Raw: number;
  mech: Cmd72MechDamageState;
}

/** Build a Cmd72 local-combat-bootstrap packet. PARTIAL §19.6.1. */
export function buildCmd72LocalBootstrapPacket(opts: Cmd72LocalBootstrap, seq = 0): Buffer {
  const parts: Buffer[] = [];

  // Scenario title (max 159 bytes per decompiled buffer size)
  parts.push(encodeLongString(opts.scenarioTitle, 159));

  parts.push(encodeAsByte(opts.localSlot));
  parts.push(encodeAsByte(opts.unknownByte0));
  parts.push(encodeAsByte(opts.terrainId));

  // Combat_ReadTerrainPointList_v123
  parts.push(encodeB85_2(opts.terrainResourceId));
  parts.push(encodeAsByte(opts.terrainPoints.length));
  for (const pt of opts.terrainPoints) {
    parts.push(encodeCoordX(pt.x));
    parts.push(encodeCoordY(pt.y));
    parts.push(encodeB85_2(pt.z));
  }

  // Combat_ReadArenaPointList_v123
  parts.push(encodeAsByte(opts.arenaPoints.length));
  for (const pt of opts.arenaPoints) {
    parts.push(encodeCoordX(pt.x));
    parts.push(encodeCoordY(pt.y));
  }

  // Three type2 globals: throttle/jump gravity, grounded drag, airborne damping.
  parts.push(encodeB85_2(opts.globalA));
  parts.push(encodeB85_2(opts.globalB));
  parts.push(encodeB85_2(opts.globalC));

  // Heat-bias seed as type1 with MOTION_NEUTRAL offset.
  parts.push(encodeB85_1(opts.headingBias + MOTION_NEUTRAL));

  // Five identity strings
  parts.push(encodeLongString(opts.identity0.substring(0, 11), 11));
  parts.push(encodeLongString(opts.identity1.substring(0, 31), 31));
  parts.push(encodeLongString(opts.identity2.substring(0, 39), 39));
  parts.push(encodeLongString(opts.identity3.substring(0, 15), 15));
  parts.push(encodeLongString(opts.identity4.substring(0, 31), 31));

  parts.push(encodeAsByte(opts.statusByte));

  parts.push(encodeCoordX(opts.initialX));
  parts.push(encodeCoordY(opts.initialY));

  if (opts.boundsX !== undefined && opts.boundsY !== undefined) {
    parts.push(encodeAsByte(1)); // boundsFlag
    parts.push(encodeCoordX(opts.boundsX));
    parts.push(encodeCoordY(opts.boundsY));
  } else {
    parts.push(encodeAsByte(0)); // boundsFlag
  }

  // Unlabeled extra type2 values
  parts.push(encodeAsByte(opts.extraType2Values.length));
  for (const v of opts.extraType2Values) {
    parts.push(encodeB85_2(v));
  }

  parts.push(encodeAsByte(opts.remainingActorCount));
  parts.push(encodeB85_1(opts.unknownType1Raw)); // caller should pass MOTION_NEUTRAL for prototype

  // Combat_ReadLocalActorMechState_v123
  const m = opts.mech;
  const emitCritBytes =
    m.critStateExtraCount >= -20 && m.critStateExtraCount !== -21;
  const critCount = emitCritBytes ? 0x15 + m.critStateExtraCount : 0;

  parts.push(encodeB85_2(m.mechId));

  if (emitCritBytes) {
    const critBytes = m.criticalStateBytes.slice(0, critCount);
    for (const b of critBytes) parts.push(encodeAsByte(b));
  }

  parts.push(encodeAsByte(m.extraStateBytes.length));
  for (const b of m.extraStateBytes) parts.push(encodeAsByte(b));

  if (m.armorLikeStateBytes.length !== 11) {
    throw new RangeError('Cmd72: armorLikeStateBytes must be exactly 11 bytes');
  }
  for (const b of m.armorLikeStateBytes) parts.push(encodeAsByte(b));

  if (m.internalStateBytes.length !== 8) {
    throw new RangeError('Cmd72: internalStateBytes must be exactly 8 bytes');
  }
  for (const b of m.internalStateBytes) parts.push(encodeAsByte(b));

  parts.push(encodeAsByte(m.ammoStateValues.length));
  for (const v of m.ammoStateValues) parts.push(encodeB85_1(v));

  parts.push(encodeLongString(m.actorDisplayName.substring(0, 31), 31));

  return buildGamePacket(72, Buffer.concat(parts), true, seq); // wire 0x69
}

// ── Cmd73 / wire 0x6a / table index 73 ───────────────────────────────────────
// PARTIAL — handler FUN_0040e2f0 — Actor rate/bias-field update.
//
// Wire layout:
//   slot   byte  — actor slot
//   rateA  byte  — stored as (value − 0x2a) * 0x38e → per-actor field at ~DAT_004f202a
//   rateB  byte  — stored as (value − 0x2a) * 0x38e → per-actor field at ~DAT_004f202e
// Also sets _DAT_00478df4 = 1.
//
// Ghidra assumptions:
//   • Exact combat meaning of rateA/rateB still needs dynamic capture.
//   • The raw wire values here are the un-decoded bytes the client reads;
//     the client transforms them internally.

/** Build a Cmd73 actor-rate/bias-field update packet. PARTIAL §19.6.1. */
export function buildCmd73ActorRatePacket(
  slot: number,
  rateA: number,
  rateB: number,
  seq = 0,
): Buffer {
  const args = Buffer.concat([
    encodeAsByte(slot),
    encodeAsByte(rateA),
    encodeAsByte(rateB),
  ]);
  return buildGamePacket(73, args, true, seq); // wire 0x6a
}

// ── Cmd75 / wire 0x6c / table index 75 ───────────────────────────────────────
// CONFIRMED — handler FUN_00445820 — combat match result selector.
//
// Wire layout:
//   result  byte  — 0 = `VICT`, 1 = `LOST`
//
// Current v1.23 read from Ghidra:
//   • stores the byte in DAT_004e16d8
//   • calls FUN_00449c00() to enter the pending result path
//   • should be followed by Cmd63 to load the selected `scenes.dat` result scene

/** Build a Cmd75 combat result selector packet. CONFIRMED by Ghidra. */
export function buildCmd75CombatResultPacket(
  result: 0 | 1,
  seq = 0,
): Buffer {
  return buildGamePacket(75, encodeAsByte(result), true, seq); // wire 0x6c
}
