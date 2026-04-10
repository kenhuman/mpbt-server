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
 *   walk speed register = mec_speed * 300
 *   run/max forward speed register = round(mec_speed * 1.5) * 300
 * extraCritCount is confirmed by RE of Combat_ReadLocalActorMechState_v123 @
 * 0x004456c0.
 *
 * @param mecPath   Absolute path to the .MEC file.
 * @param nameLower Lowercase mech name WITHOUT extension (e.g. "anh-1a").
 */
function readMecFields(mecPath: string, nameLower: string): { mecSpeed: number; extraCritCount: number } {
  const raw = fs.readFileSync(mecPath);
  if (raw.length < 0x3e) {
    throw new Error(`${mecPath}: too short for mec fields (${raw.length} < 0x3e)`);
  }
  const buf = Buffer.from(raw); // mutable copy
  decryptMec(buf, nameLower);
  return {
    mecSpeed:       buf.readUInt16LE(0x16),
    extraCritCount: buf.readInt16LE(0x3c),
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
      const { mecSpeed, extraCritCount } = readMecFields(mecPath, typeString.toLowerCase());
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
      };
    });

  if (entries.length === 0) {
    throw new Error(`No .MEC files found in ${mechDir}.`);
  }

  return entries;
}
