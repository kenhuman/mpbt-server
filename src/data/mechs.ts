/**
 * Mech roster loader.
 *
 * Scans mechdata/*.MEC at startup and builds a MechEntry array.
 * The variant designation (e.g. "SDR-5V") comes from the filename.
 *
 * The mech_id (sent as b85(2) in cmd 26) must match the client's internal
 * string table so that MechWin_LookupMechName (FUN_00438280) resolves the
 * correct designation string.  The table is embedded in MPBT.MSG starting
 * at 1-based line index 0x3AE (decimal 942): each line is one variant
 * designation, and the 0-based offset within that block is the mech_id.
 *
 * Confirmed by RE of FUN_00438280 in MPBTWIN.EXE:
 *   FUN_00438280(id) → FUN_00405840(id + 0x3AE)
 *   Valid range: id ∈ [0, 0xA0] (161 entries, matching 161 .MEC files)
 *
 * No mech names are hardcoded in this file.  All strings come from the
 * game's own data files (mechdata/*.MEC filenames and MPBT.MSG).
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { type MechEntry } from '../protocol/game.js';

/** Resolve a path relative to the project root (works for both ts-node and compiled). */
function projectPath(...parts: string[]): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // src/data/mechs.ts  → ../../<rest>   (ts-node, 2 levels up)
  // dist/data/mechs.js → ../../<rest>   (compiled, 2 levels up)
  return path.resolve(__dirname, '../../', ...parts);
}

// ── .MEC decryption ───────────────────────────────────────────────────────────
// MPBTWIN.EXE obfuscates .MEC files with a sliding XOR cipher seeded from the
// mech-name's last 4 characters.
//
// Key facts confirmed by RE:
//   FUN_004427f0  — computes seed from last 4 chars of lowercase mech name
//   FUN_004428a0  — LCG step: temp = state*0xF0F1+1; ROL16(temp)+temp
//   FUN_00442870  — for i in [0..size-4): *(u32*)(buf+i) ^= lcg()
//   extraCritCount — *(int16*)(mechData+0x3c) after decryption
//   Used by  Combat_ReadLocalActorMechState_v123 @ 0x004456c0:
//     reads (extraCritCount + 21) crit bytes when extraCritCount != -21 && >= -20

/** LCG step for the .MEC file cipher. Returns the new 32-bit state. */
function mecLcgStep(state: number): number {
  const temp = ((state * 0xf0f1 + 1) >>> 0);
  const rotated = (((temp << 16) | (temp >>> 16)) >>> 0);
  return ((temp + rotated) >>> 0);
}

/** Derive the 32-bit XOR seed from the last 4 chars of the lowercase mech name. */
function mecSeed(nameLower: string): number {
  const n = nameLower.length;
  if (n < 4) throw new Error(`mech name too short to derive seed: "${nameLower}"`);
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = nameLower.charCodeAt(n - 1 - i);
  return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
}

/**
 * Decrypt a raw .MEC file buffer in place.
 * Applies the sliding 4-byte XOR cipher used by FUN_00442870 in MPBTWIN.EXE.
 *
 * @param buf       Mutable copy of the raw .MEC file bytes (must be ≥ 4 bytes).
 * @param nameLower Lowercase mech name WITHOUT extension (e.g. "anh-1a").
 */
function decryptMec(buf: Buffer, nameLower: string): void {
  let state = mecSeed(nameLower) >>> 0;
  const limit = buf.length - 3;
  for (let i = 0; i < limit; i++) {
    state = mecLcgStep(state);
    const word = buf.readUInt32LE(i);
    buf.writeUInt32LE((word ^ state) >>> 0, i);
  }
}

/**
 * Decrypt a .MEC file and return combat bootstrap/runtime fields in one pass.
 *
 * mec_speed is confirmed by RE of Combat_InitActorRuntimeFromMec_v123 @
 * 0x00433910:
 *   walk speed register     = mec_speed * 300
 *   run/max forward speed   = round(mec_speed * 1.5) * 300
 * extraCritCount is confirmed by RE of Combat_ReadLocalActorMechState_v123 @
 * 0x004456c0.
 *
 * @param mecPath   Absolute path to the .MEC file.
 * @param nameLower Lowercase mech name WITHOUT extension (e.g. "anh-1a").
 */
function readMecFields(
  mecPath: string,
  nameLower: string,
): { mecSpeed: number; extraCritCount: number; tonnage: number; armorLikeMaxValues: number[] } {
  const raw = fs.readFileSync(mecPath);
  if (raw.length < 0x3e) {
    throw new Error(`${mecPath}: too short for mec fields (${raw.length} < 0x3e)`);
  }
  const buf = Buffer.from(raw); // mutable copy
  decryptMec(buf, nameLower);
  return {
    mecSpeed:       buf.readUInt16LE(0x16),
    tonnage:        buf.readUInt16LE(0x18),
    extraCritCount: buf.readInt16LE(0x3c),
    armorLikeMaxValues: [
      buf.readUInt16LE(0x1a), // LA
      buf.readUInt16LE(0x1c), // RA
      buf.readUInt16LE(0x1e), // LL
      buf.readUInt16LE(0x20), // RL
      buf.readUInt16LE(0x22), // CT front
      buf.readUInt16LE(0x24), // LT front
      buf.readUInt16LE(0x26), // RT front
      buf.readUInt16LE(0x28), // CT rear
      buf.readUInt16LE(0x2a), // LT rear
      buf.readUInt16LE(0x2c), // RT rear
    ],
  };
}

function walkSpeedMagFromMecSpeed(mecSpeed: number): number {
  return mecSpeed * 300;
}

function maxSpeedMagFromMecSpeed(mecSpeed: number): number {
  const runMpTimes10 = mecSpeed * 15;
  const runMp = Math.floor(runMpTimes10 / 10) + (runMpTimes10 % 10 < 5 ? 0 : 1);
  return runMp * 300;
}

// ── Internal Structure lookup table ──────────────────────────────────────────
//
// Pre-computed from Combat_GetInternalStructureForSection_v123 (0x00433c70).
// Table at 0x0047af7c, stride 0x14, rows 0-20 decoded from Ghidra RE (§23.8).
// Columns per row: [ct, leg, arm, side].  Row = tonnage / 5.
// Section IDs: 0/1 = arms (col 2), 2/3 = sides (col 3), 4 = CT (col 0),
//              5/6 = legs (col 1), 7 = head (always 9).
// Rows 0-1 overlap unrelated data in the binary; rows 2-20 are verified.
const IS_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [ 0,  0,  0,  0], // row 0: 0-4t  (unused — overlaps previous data)
  [ 0,  0,  0,  0], // row 1: 5-9t  (unused — overlaps previous data)
  [ 4,  3,  1,  2], // row 2: 10-14t
  [ 5,  4,  2,  3], // row 3: 15-19t
  [ 6,  5,  3,  4], // row 4: 20-24t
  [ 8,  6,  4,  6], // row 5: 25-29t
  [10,  7,  5,  7], // row 6: 30-34t
  [11,  8,  6,  8], // row 7: 35-39t
  [12, 10,  6, 10], // row 8: 40-44t
  [14, 11,  7, 11], // row 9: 45-49t
  [16, 12,  8, 12], // row 10: 50-54t
  [18, 13,  9, 13], // row 11: 55-59t
  [20, 14, 10, 14], // row 12: 60-64t
  [21, 15, 10, 15], // row 13: 65-69t
  [22, 15, 11, 15], // row 14: 70-74t
  [23, 15, 12, 16], // row 15: 75-79t
  [25, 17, 13, 17], // row 16: 80-84t
  [27, 18, 14, 18], // row 17: 85-89t
  [29, 19, 15, 19], // row 18: 90-94t
  [30, 20, 16, 20], // row 19: 95-99t
  [31, 21, 17, 21], // row 20: 100-104t (Atlas class)
];

/**
 * Compute the 8-byte internal-structure block for Cmd72 from mech tonnage.
 *
 * Replicates `Combat_GetInternalStructureForSection_v123` (0x00433c70) for
 * section IDs 0-7.  Order is [arm, arm, side, side, CT, leg, leg, head].
 *
 * @param tonnage Mech mass in tons (from .MEC offset 0x18).
 * @returns Array of 8 IS values, one per section.
 */
export function mechInternalStateBytes(tonnage: number): number[] {
  const group = Math.min(IS_TABLE.length - 1, Math.floor(tonnage / 5));
  const row = IS_TABLE[group] ?? ([0, 0, 0, 0] as const);
  const [ct, leg, arm, side] = row;
  // Section 0 = arm, 1 = arm, 2 = side, 3 = side, 4 = CT, 5 = leg, 6 = leg, 7 = head
  return [arm, arm, side, side, ct, leg, leg, 9];
}

// ── MPBT.MSG variant table ────────────────────────────────────────────────────

/**
 * Parse MPBT.MSG to build a typeString → mech_id map.
 *
 * MPBT.MSG is a plain-text file with one string per CRLF-terminated line
 * (1-based indexing).  Lines 0x3AE–0x44E (942–1102) are the mech variant
 * designations: the 0-based offset within that range is the mech_id that
 * FUN_00438280 expects.
 *
 * @throws If MPBT.MSG is not found.
 */
function loadVariantIdMap(): Map<string, number> {
  const msgPath = projectPath('MPBT.MSG');
  if (!fs.existsSync(msgPath)) {
    throw new Error(
      `MPBT.MSG not found at ${msgPath}.\n` +
      'Copy MPBT.MSG from your licensed MPBT installation into the project root.',
    );
  }
  const raw = fs.readFileSync(msgPath, 'latin1');
  const lines = raw.split(/\r?\n/);
  const VARIANT_BASE_1 = 0x3AE; // 1-based line number of id=0 entry
  const VARIANT_LAST_1  = VARIANT_BASE_1 + 0xA0; // last required line (id=0xA0)
  if (lines.length < VARIANT_LAST_1) {
    throw new Error(
      `MPBT.MSG too short: need at least ${VARIANT_LAST_1} lines for the full variant table, ` +
      `but only ${lines.length} found. Check file integrity / line endings.`,
    );
  }
  const map = new Map<string, number>();
  for (let id = 0; id <= 0xA0; id++) {
    const line = lines[VARIANT_BASE_1 + id - 1]?.trim().toUpperCase();
    if (line) map.set(line, id);
  }
  return map;
}

/**
 * Load the mech roster from mechdata/*.MEC filenames.
 *
 * The mech_id for each entry is looked up from MPBT.MSG so the client's
 * name-resolution function (FUN_00438280) receives the correct index.
 * The variant and name fields are sent empty — the client handles display.
 *
 * @returns Sorted array of MechEntry objects, one per .MEC file found.
 * @throws  If mechdata/ or MPBT.MSG is missing, or a .MEC file has no
 *          matching entry in MPBT.MSG.
 */
export function loadMechs(): MechEntry[] {
  const mechDir = projectPath('mechdata');
  if (!fs.existsSync(mechDir)) {
    throw new Error(
      `mechdata directory not found at ${mechDir}.\n` +
      'Copy mechdata/ from your licensed MPBT installation into the project root.',
    );
  }

  const variantIdMap = loadVariantIdMap();

  const entries = fs.readdirSync(mechDir)
    .filter(f => f.toUpperCase().endsWith('.MEC'))
    .sort()
    .map<MechEntry>((filename, slot) => {
      const typeString = filename.slice(0, -4).trim().toUpperCase();
      const id = variantIdMap.get(typeString);
      if (id === undefined) {
        throw new Error(
          `No MPBT.MSG entry for mech variant "${typeString}" — ` +
          'verify MPBT.MSG matches the mechdata/ installation.',
        );
      }
      const mecPath = path.join(mechDir, filename);
      const { mecSpeed, extraCritCount, tonnage, armorLikeMaxValues } =
        readMecFields(mecPath, typeString.toLowerCase());
      return {
        id,
        mechType: 0,
        slot,
        typeString,
        variant: '', // empty → client uses its own display logic
        name:    '', // empty → client calls MechWin_LookupMechName(id)
        walkSpeedMag: walkSpeedMagFromMecSpeed(mecSpeed),
        maxSpeedMag:  maxSpeedMagFromMecSpeed(mecSpeed),
        extraCritCount,
        tonnage,
        armorLikeMaxValues,
      };
    });

  if (entries.length === 0) {
    throw new Error(`No .MEC files found in ${mechDir}.`);
  }

  return entries;
}
