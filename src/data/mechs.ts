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
  const lines = fs.readFileSync(msgPath, 'latin1').split('\r\n');
  const VARIANT_BASE_1 = 0x3AE; // 1-based line number of id=0 entry
  const map = new Map<string, number>();
  for (let id = 0; id <= 0xA0; id++) {
    const line = lines[VARIANT_BASE_1 + id - 1];
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
      const typeString = filename.slice(0, -4);
      const id = variantIdMap.get(typeString);
      if (id === undefined) {
        throw new Error(
          `No MPBT.MSG entry for mech variant "${typeString}" — ` +
          'verify MPBT.MSG matches the mechdata/ installation.',
        );
      }
      return {
        id,
        mechType: 0,
        slot,
        typeString,
        variant: '', // empty → client uses its own display logic
        name:    '', // empty → client calls MechWin_LookupMechName(id)
      };
    });

  if (entries.length === 0) {
    throw new Error(`No .MEC files found in ${mechDir}.`);
  }

  return entries;
}
