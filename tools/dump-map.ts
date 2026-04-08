#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseMapFile } from '../src/data/maps.js';

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
}

function uniqueExisting(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function defaultMapPaths(): string[] {
  const root = projectRoot();
  const candidates = [
    process.env.MPBT_DATA_DIR,
    process.cwd(),
    root,
    path.resolve(root, '..'),
    path.resolve(root, 'research'),
  ].filter((p): p is string => Boolean(p));

  const paths: string[] = [];
  for (const dir of candidates) {
    paths.push(path.join(dir, 'IS.MAP'), path.join(dir, 'SOLARIS.MAP'));
  }
  return uniqueExisting(paths);
}

function roomRange(ids: number[]): string {
  if (ids.length === 0) return '(none)';

  const ranges: string[] = [];
  let start = ids[0];
  let prev = ids[0];
  for (const id of ids.slice(1)) {
    if (id === prev + 1) {
      prev = id;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = id;
    prev = id;
  }
  ranges.push(start === prev ? String(start) : `${start}-${prev}`);
  return ranges.join(', ');
}

const args = process.argv.slice(2);
const showRooms = args.includes('--rooms');
const explicitPaths = args.filter(arg => arg !== '--rooms');
const mapPaths = explicitPaths.length > 0 ? explicitPaths : defaultMapPaths();

if (mapPaths.length === 0) {
  console.error(
    'No map files found. Pass paths explicitly, or set MPBT_DATA_DIR to a directory containing IS.MAP / SOLARIS.MAP.',
  );
  process.exitCode = 1;
} else {
  for (const mapPath of mapPaths) {
    const parsed = parseMapFile(mapPath);
    const ids = parsed.rooms.map(room => room.roomId);
    const first = parsed.rooms[0];
    const last = parsed.rooms[parsed.rooms.length - 1];

    console.log(`${parsed.source}`);
    console.log(`  path: ${parsed.path}`);
    console.log(`  records: ${parsed.rooms.length} (header count ${parsed.roomCount})`);
    console.log(`  room ids: ${roomRange(ids)}`);
    console.log(`  first/last: ${first?.roomId ?? '?'} ${first?.name ?? '?'} / ${last?.roomId ?? '?'} ${last?.name ?? '?'}`);
    console.log(`  trailing bytes: ${parsed.remainingBytes} at 0x${parsed.remainingOffset.toString(16)}`);

    if (showRooms) {
      for (const room of parsed.rooms) {
        const bounds = `${room.bounds.x1},${room.bounds.y1},${room.bounds.x2},${room.bounds.y2}`;
        const aux = `${room.aux.aux0},${room.aux.aux1},${room.aux.aux2}`;
        console.log(
          `  ${room.roomId.toString().padStart(3, ' ')} flags=0x${room.flags.toString(16).padStart(4, '0')} bounds=${bounds} aux=${aux} name=${room.name}`,
        );
      }
    }
  }
}
