/**
 * Mech roster loader.
 *
 * Scans mechdata/*.MEC at startup and builds a MechEntry array from the
 * filenames alone.  The variant designation (e.g. "SDR-5V") comes directly
 * from the filename; the `variant` and `name` fields are left empty so the
 * client resolves the chassis display name via its own internal lookup
 * (MechWin_LookupMechName / FUN_00438280).
 *
 * No mech names are hardcoded here.  When the .MEC binary format is fully
 * reverse-engineered (issue #1) this function can be extended to also parse
 * stats from the file contents.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { type MechEntry } from '../protocol/game.js';

/**
 * Resolve the mechdata directory relative to the project root.
 * Works whether the server is run via ts-node (src/) or compiled (dist/).
 */
function mechDataDir(): string {
  // fileURLToPath correctly handles the Windows /C:/... prefix from import.meta.url
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // src/data/mechs.ts  → ../../mechdata   (ts-node)
  // dist/data/mechs.js → ../../mechdata   (compiled)
  return path.resolve(__dirname, '../../mechdata');
}

/**
 * Load the mech roster from mechdata/*.MEC filenames.
 *
 * Each .MEC file corresponds to one mech variant.  The filename (minus the
 * extension) is used directly as the typeString sent to the client in cmd 26.
 * The client's FUN_00438280 maps typeString → chassis display name, so we
 * do not need to store or transmit that mapping ourselves.
 *
 * @returns Sorted array of MechEntry objects, one per .MEC file found.
 * @throws  If the mechdata directory does not exist.
 */
export function loadMechs(): MechEntry[] {
  const dir = mechDataDir();

  if (!fs.existsSync(dir)) {
    throw new Error(
      `mechdata directory not found at ${dir}.\n` +
      'Copy mechdata/ from your licensed MPBT installation into the project root.',
    );
  }

  const entries = fs.readdirSync(dir)
    .filter(f => f.toUpperCase().endsWith('.MEC'))
    .sort()
    .map<MechEntry>((filename, index) => ({
      id:         index + 1,
      mechType:   0,
      slot:       index,
      typeString: filename.slice(0, -4),   // strip ".MEC"
      variant:    '',                       // empty → client calls MechWin_LookupMechName
      name:       '',                       // empty → no pilot name shown
    }));

  if (entries.length === 0) {
    throw new Error(`No .MEC files found in ${dir}.`);
  }

  return entries;
}
