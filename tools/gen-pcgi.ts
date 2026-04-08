/**
 * gen-pcgi — generate a play.pcgi launch file for MPBTWIN.EXE.
 *
 * Usage:
 *   npm run gen-pcgi -- [options]
 *
 * Options:
 *   --server  <host>|<host:port>   Server address (default: 127.0.0.1:2000)
 *   --user    <name>               Login username  (default: Player)
 *   --pass    <password>           Login password  (default: password)
 *   --email   <address>            Login email     (default: player@mpbt.local)
 *   --out     <path>               Output path     (default: ../play.pcgi)
 *
 * play.pcgi format (confirmed by INITAR.DLL RE):
 *   [launch]
 *   product = <port>          ← _atoi() → SetProductCode(port) → htons(port)
 *   server = <host:port>      ← connection target
 *   ServiceIdent = BATTLETECH ← constant, read by FUN_* in INITAR.DLL
 *   AuthServ = g              ← constant
 *
 *   [identification]
 *   user=<name>
 *   password=<pass>
 *   email=<email>
 *
 * The game deletes play.pcgi after reading it, so this script must be
 * re-run (or MPBT.bat re-executed) before each launch.
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Argument parser ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[argv[i].slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const serverArg = args['server'] ?? '127.0.0.1:2000';
const user      = args['user']   ?? 'Player';
const pass      = args['pass']   ?? 'password';
const email     = args['email']  ?? 'player@mpbt.local';
const outPath   = resolve(args['out'] ?? resolve(__dirname, '../..', 'play.pcgi'));

// Extract host and port from the server argument ("host" or "host:port").
const colonIdx = serverArg.lastIndexOf(':');
const host = colonIdx === -1 ? serverArg : serverArg.slice(0, colonIdx);
const port = colonIdx === -1 ? 2000       : parseInt(serverArg.slice(colonIdx + 1), 10);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`[gen-pcgi] Invalid port in server argument: "${serverArg}"`);
  process.exit(1);
}

const serverFull = `${host}:${port}`;

// ── Generate ──────────────────────────────────────────────────────────────────

const content = [
  '[launch]',
  `product = ${port}`,
  `server = ${serverFull}`,
  'ServiceIdent = BATTLETECH',
  'AuthServ = g',
  '',
  '[identification]',
  `user=${user}`,
  `password=${pass}`,
  `email=${email}`,
  '',
].join('\r\n');

writeFileSync(outPath, content, 'ascii');
console.log(`[gen-pcgi] Wrote ${outPath}`);
console.log(`           server=${serverFull}  user=${user}  email=${email}`);
