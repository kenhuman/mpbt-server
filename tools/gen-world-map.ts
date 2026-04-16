#!/usr/bin/env node
/**
 * tools/gen-world-map.ts
 *
 * Generate (or re-generate) world-map.json from SOLARIS.MAP coordinates.
 *
 * Named rooms from SOLARIS.MAP are connected using a minimum-spanning-tree
 * within each sector plus cross-sector edges between close room pairs.
 * Each connection is padded with intermediate "path" rooms spaced ~SCALE_PX
 * apart, giving physical depth: streets, pubs, banks between landmarks.
 *
 * Usage:
 *   node --loader ts-node/esm tools/gen-world-map.ts [options]
 *
 *   --map   PATH   SOLARIS.MAP location (default: searches project dirs)
 *   --scale N      Pixels per room step  (default: 20)
 *   --out   PATH   Output path           (default: <project-root>/world-map.json)
 *
 * After running /icons in-game to identify icon IDs, add entries to
 * FLAVOR_OVERRIDES below and re-run — only the named room type/icon
 * assignments and intermediate-room flavors change; the graph topology is
 * stable across re-runs for the same SOLARIS.MAP.
 */

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseMapFile } from '../src/data/maps.js';

// ── Tunables ──────────────────────────────────────────────────────────────────

const DEFAULT_SCALE     = 20;   // pixels per room step
const MAX_INTRA_DIST    = 200;  // max px for an intra-sector MST edge
const MAX_CROSS_DIST    = 120;  // max px for a cross-sector edge
const GEN_ID_START      = 1000; // generated room IDs start here

// ── Manual overrides ──────────────────────────────────────────────────────────

/**
 * Force-assign ambiguous rooms to a sector.
 * Key: roomId from SOLARIS.MAP.
 */
const SECTOR_OVERRIDES: Record<number, string> = {
  153: 'silesia',    // Lyran Building  — lore says Silesia despite proximity to Montenegro
  165: 'cathay',     // Rivertown       — lore says Cathay
  170: 'blackhills', // Marina          — lore says Black Hills
};

/**
 * Force extra named-room connections regardless of distance.
 * Each pair [a, b] produces a road (with intermediate rooms) between a and b.
 */
const EXTRA_CONNECTIONS: Array<[number, number]> = [
  [146, 6],   // Starport ↔ Black Hills Sector hub
  [146, 1],   // Starport ↔ International Sector hub
];

/**
 * Flavor overrides for generated intermediate rooms on a connection.
 * Key: `${Math.min(a,b)}:${Math.max(a,b)}:${stepIndex}` (step 1 = first intermediate).
 *
 * After running /icons to learn icon IDs, add entries here, e.g.:
 *   '146:169:2': { name: 'The Iron Horse Pub', type: 'bar', icon: 5 },
 */
const FLAVOR_OVERRIDES: Record<string, { name?: string; type?: RoomType; icon?: number }> = {
  // Keyed `${min(a,b)}:${max(a,b)}:${stepIndex}` — overrides name/type/icon for a specific
  // intermediate room on a named connection.  stepIndex 1 = first intermediate from A.
};

/**
 * Icon IDs discovered via /icons survey (IDs 0–54 are unique; 55+ repeat).
 * The mechId field in Cmd4 scenes uses these as the image index.
 */
export const ICON = {
  //  ── World / travel icons ──────────────────────────────────────────────────
  MONORAIL:           0,
  STREET:             1,
  BAR:                2,
  JOIN_PROMPT:        3,
  LUNAR_LANDER:       4,   // starport / launch pad exterior
  FACTION_BANNER:     5,   // dark purple banner with yellow circle
  HQ_RED:             6,   // star+HQ red  (Kurita / generic)
  NEW_MECHS:          7,
  USED_MECHS:         8,
  GALAXY:             9,
  MECH_RETICLE:      10,   // mech with green targeting reticle
  FACTORY:           12,
  LANDING_PAD:       14,   // lunar lander + outer wall / gate
  STREET_2:          15,
  BANK:              16,
  TERMINAL:          17,   // computer / office terminal
  PARK:              18,   // field with trees
  SNOW:              19,
  DESERT:            20,
  POWER_DEVICE:      21,
  ACADEMY:           22,
  STREET_DESERT:     23,
  STREET_UPSCALE:    24,   // pillars, nicer district
  RUINS:             25,   // desert ruins
  PUB:               26,
  ISHIYAMA:          28,
  STEINER:           29,
  FACTORY_2:         30,
  JUNGLE:            31,
  DAVION:            32,
  HQ_BLUE:           34,   // Steiner / Lyran
  HQ_PURPLE:         35,   // Marik / Free Worlds
  HQ_GREEN:          36,   // Liao / Capellan
  HQ_BROWN:          37,   // Davion / FedSuns
  //  ── House emblems ─────────────────────────────────────────────────────────
  EMBLEM_SERPENT:    38,   // red circle + serpent  (Kurita)
  EMBLEM_FIST:       39,   // fist                  (Steiner)
  EMBLEM_SCARAB:     40,   // Egyptian scarab       (Liao)
  EMBLEM_SWORD:      41,   // triangle + sword arm  (Marik)
  EMBLEM_ARROW:      42,   // orange circle + arrow (Davion)
  //  ── Misc / environment ────────────────────────────────────────────────────
  TREETOPS:          43,
  SECURE_DOOR:       44,
  CIVIC_BUILDING:    45,   // large white building / government
  STREET_COASTAL:    46,   // desert / island / waterfront street
  STREET_FUTURISTIC: 47,
  STREET_FUTURISTIC2:48,
  STREET_DESERT2:    49,
  ALLEY:             50,
  ALLEY_FUTURISTIC:  51,
  STREET_BRICK:      52,
  GARAGE:            53,
  SATELLITE:         54,
} as const;

/**
 * Per-room icon overrides for named rooms (roomId from SOLARIS.MAP).
 * Sector hubs use House-aligned HQ star icons.
 */
const NAMED_ROOM_ICONS: Record<number, number> = {
  // ── Sector hubs (IDs 1–6) ──────────────────────────────────────────────────
  1: ICON.HQ_RED,          // International Sector  — neutral / generic
  2: ICON.HQ_RED,          // Kobe Sector           — Kurita/Draconis Combine
  3: ICON.HQ_BLUE,         // Silesia Sector        — Steiner/Lyran Commonwealth
  4: ICON.HQ_PURPLE,       // Montenegro Sector     — Marik/Free Worlds League
  5: ICON.HQ_GREEN,        // Cathay Sector         — Liao/Capellan Confederation
  6: ICON.HQ_BROWN,        // Black Hills Sector    — Davion/Federated Suns
  // ── Named locations ────────────────────────────────────────────────────────
  146: ICON.LUNAR_LANDER,  // Solaris Starport
  147: ICON.ISHIYAMA,      // Ishiyama Arena
  148: ICON.CIVIC_BUILDING,// Government House
  149: ICON.PUB,           // White Lotus (entertainment)
  150: ICON.STREET_COASTAL,// Waterfront
  151: ICON.ALLEY_FUTURISTIC, // Kobe Slums
  152: ICON.STEINER,       // Steiner Stadium
  153: ICON.TERMINAL,      // Lyran Building
  154: ICON.PARK,          // Chahar Park
  155: ICON.STREET_COASTAL,// Riverside
  156: ICON.SECURE_DOOR,   // Black Throne
  157: ICON.FACTORY,       // Factory
  158: ICON.TERMINAL,      // Marik Tower
  159: ICON.STREET,        // Allman
  160: ICON.STREET_COASTAL,// Riverfront
  161: ICON.RUINS,         // Wasteland
  162: ICON.JUNGLE,        // Jungle
  163: ICON.CIVIC_BUILDING,// Chancellor's Quarters
  164: ICON.STREET,        // Middletown
  165: ICON.STREET,        // Rivertown
  166: ICON.ALLEY,         // Maze
  167: ICON.DAVION,        // Davion Arena
  168: ICON.TERMINAL,      // Sortek Building
  169: ICON.PARK,          // Guzman Park
  170: ICON.STREET_COASTAL,// Marina
  171: ICON.TREETOPS,      // Viewpoint (hilltop overview)
};

/**
 * Default icon to use for generated intermediate rooms, keyed by room type.
 * FLAVOR_OVERRIDES can still override per-step.
 */
const TYPE_ICONS: Record<RoomType, number> = {
  bar:      ICON.PUB,
  arena:    ICON.FACTORY_2,
  hub:      ICON.LUNAR_LANDER,
  terminal: ICON.TERMINAL,
  bank:     ICON.BANK,
  street:   ICON.STREET,
  sector:   ICON.HQ_RED,
  path:     ICON.STREET,
};

// ── Types ─────────────────────────────────────────────────────────────────────

type RoomType = 'bar' | 'arena' | 'hub' | 'terminal' | 'bank' | 'street' | 'sector' | 'path';
type Dir      = 'north' | 'south' | 'east' | 'west';

interface Coords { id: number; cx: number; cy: number; }

interface NamedRoom extends Coords {
  name: string;
  description: string;
  flags: number;
  aux0: number; aux1: number; aux2: number;
  sceneIndex: number;
  sector: string;
  type: RoomType;
}

interface OutputRoom {
  roomId:     number;
  _name:      string;
  description?: string;
  sector:     string;
  type:       RoomType;
  icon:       number | null;
  clientMapDescription?: true;
  _inferred?: true;
  exits: { north: number|null; south: number|null; east: number|null; west: number|null };
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function euclidean(a: Coords, b: Coords): number {
  return Math.hypot(b.cx - a.cx, b.cy - a.cy);
}

const OPPOSITE: Record<Dir, Dir> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Return directions ordered by closeness to the A→B angle.
 * Primary is the dominant axis; secondary is the other axis; then their opposites.
 * Used to find a free direction pair at both endpoints before committing.
 */
function dirPriority(from: Coords, to: Coords): Dir[] {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const primary  : Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'east' : 'west')  : (dy >= 0 ? 'south' : 'north');
  const secondary: Dir = Math.abs(dx) >= Math.abs(dy) ? (dy >= 0 ? 'south' : 'north') : (dx >= 0 ? 'east' : 'west');
  return [primary, secondary, OPPOSITE[primary], OPPOSITE[secondary]];
}

// ── Room-type inference ───────────────────────────────────────────────────────

const SECTOR_HUB_IDS = new Set([1, 2, 3, 4, 5, 6]);
const STARPORT_ID    = 146;

function inferType(id: number, name: string): RoomType {
  if (id === STARPORT_ID)      return 'hub';
  if (SECTOR_HUB_IDS.has(id)) return 'sector';
  const n = name.toLowerCase();
  if (n.includes('arena') || n.includes('stadium') || n.includes('jungle') || n.includes('factory'))
    return 'arena';
  if (n.includes('building') || n.includes('house') || n.includes('tower') ||
      n.includes('quarters') || n.includes('terminal'))
    return 'terminal';
  if (n.includes('waterfront') || n.includes('riverside') || n.includes('marina') ||
      n.includes('lotus') || n.includes('pub') || n.includes('bar'))
    return 'bar';
  return 'street';
}

// ── MST (Prim's from hub) ─────────────────────────────────────────────────────

function buildMST(hubId: number, rooms: NamedRoom[], maxDist: number): Array<[number, number]> {
  const byId  = new Map(rooms.map(r => [r.id, r]));
  const inTree = new Set<number>([hubId]);
  const edges: Array<[number, number]> = [];

  while (inTree.size < rooms.length) {
    let bestDist = Infinity;
    let bestEdge: [number, number] = [-1, -1];

    for (const aid of inTree) {
      const a = byId.get(aid)!;
      for (const b of rooms) {
        if (inTree.has(b.id)) continue;
        const d = euclidean(a, b);
        if (d < bestDist && d <= maxDist) {
          bestDist = d;
          bestEdge = [aid, b.id];
        }
      }
    }

    if (bestEdge[0] === -1) break;   // remaining rooms unreachable within maxDist
    edges.push(bestEdge);
    inTree.add(bestEdge[1]);
  }
  return edges;
}

// ── Cross-sector edges ────────────────────────────────────────────────────────

function buildCrossSectorEdges(
  sectorRooms: Map<string, NamedRoom[]>,
  maxDist: number,
): Array<[number, number]> {
  const sectors = [...sectorRooms.keys()];
  const edges: Array<[number, number]> = [];
  const added  = new Set<string>();

  for (let i = 0; i < sectors.length; i++) {
    for (let j = i + 1; j < sectors.length; j++) {
      const ra = sectorRooms.get(sectors[i])!;
      const rb = sectorRooms.get(sectors[j])!;

      let bestDist = Infinity;
      let bestEdge: [number, number] = [-1, -1];
      for (const a of ra) {
        for (const b of rb) {
          const d = euclidean(a, b);
          if (d < bestDist) { bestDist = d; bestEdge = [a.id, b.id]; }
        }
      }
      if (bestEdge[0] !== -1 && bestDist <= maxDist) {
        const key = `${Math.min(...bestEdge)}:${Math.max(...bestEdge)}`;
        if (!added.has(key)) { edges.push(bestEdge); added.add(key); }
      }
    }
  }
  return edges;
}

// ── Connection builder ────────────────────────────────────────────────────────

function buildConnections(
  allEdges:    Array<[number, number]>,
  coordsById:  Map<number, Coords>,
  outputById:  Map<number, OutputRoom>,
  scale:       number,
): void {
  let nextId = GEN_ID_START;

  // Populate nextId past any already-generated rooms
  for (const id of outputById.keys()) {
    if (id >= GEN_ID_START) nextId = Math.max(nextId, id + 1);
  }

  const dedupeKey = (a: number, b: number) => `${Math.min(a,b)}:${Math.max(a,b)}`;
  const seen = new Set<string>();

  for (const [aId, bId] of allEdges) {
    const key = dedupeKey(aId, bId);
    if (seen.has(key)) continue;
    seen.add(key);

    const ac = coordsById.get(aId);
    const bc = coordsById.get(bId);
    if (!ac || !bc) {
      process.stderr.write(`WARNING: missing coords for edge ${aId}↔${bId}, skipping\n`);
      continue;
    }

    // Pre-check: find a direction pair where BOTH endpoints have a free slot.
    // This avoids creating orphan intermediate rooms that can't be linked back.
    const aRoom = outputById.get(aId)!;
    const bRoom = outputById.get(bId)!;
    let dir : Dir | null = null;
    let back: Dir | null = null;
    for (const d of dirPriority(ac, bc)) {
      const opp = OPPOSITE[d];
      if (aRoom.exits[d] === null && bRoom.exits[opp] === null) {
        dir  = d;
        back = opp;
        break;
      }
    }
    if (!dir || !back) {
      const an = aRoom._name;
      const bn = bRoom._name;
      process.stderr.write(`WARNING: no free direction pair for edge ${aId}(${an})↔${bId}(${bn}), skipping\n`);
      continue;
    }

    const d     = euclidean(ac, bc);
    const steps = Math.max(1, Math.round(d / scale));

    // Build chain: aId ↔ [I₁ ↔ … ↔ Iₙ₋₁] ↔ bId
    let prevId = aId;

    for (let i = 1; i < steps; i++) {
      const t   = i / steps;
      const cx  = Math.round(ac.cx + t * (bc.cx - ac.cx));
      const cy  = Math.round(ac.cy + t * (bc.cy - ac.cy));
      const genId = nextId++;

      const flavorKey = `${Math.min(aId,bId)}:${Math.max(aId,bId)}:${i}`;
      const flavor    = FLAVOR_OVERRIDES[flavorKey] ?? {};

      const aRoom     = outputById.get(aId)!;
      const genRoom: OutputRoom = {
        roomId:    genId,
        _name:     flavor.name ?? 'Street',
        sector:    aRoom.sector,
        type:      flavor.type ?? 'street',
        icon:      flavor.icon ?? TYPE_ICONS[flavor.type ?? 'street'] ?? null,
        _inferred: true,
        exits:     { north: null, south: null, east: null, west: null },
      };
      outputById.set(genId, genRoom);
      coordsById.set(genId, { id: genId, cx, cy });

      setExit(outputById, prevId, dir,  genId);
      setExit(outputById, genId,  back, prevId);
      prevId = genId;
    }

    // Final link → bId
    setExit(outputById, prevId, dir,  bId);
    setExit(outputById, bId,    back, prevId);
  }
}

function setExit(
  outputById: Map<number, OutputRoom>,
  roomId: number,
  dir:    Dir,
  target: number,
): void {
  const room = outputById.get(roomId);
  if (!room) return;
  if (room.exits[dir] !== null) {
    process.stderr.write(
      `WARNING: exit conflict — room ${roomId} (${room._name}) already has ${dir} exit; ` +
      `skipping ${target}\n`,
    );
    return;
  }
  room.exits[dir] = target;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function findSolarisMap(): string | undefined {
  const toolDir  = path.dirname(fileURLToPath(import.meta.url));
  const projRoot = path.resolve(toolDir, '..');
  const candidates = [
    process.env['MPBT_DATA_DIR'] && path.join(process.env['MPBT_DATA_DIR'], 'SOLARIS.MAP'),
    path.join(projRoot, 'SOLARIS.MAP'),
    path.join(projRoot, 'research', 'SOLARIS.MAP'),
    path.join(projRoot, '..', 'client-1.06', 'SOLARIS.MAP'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find(p => fs.existsSync(p));
}

function main(): void {
  // Parse CLI args
  const argv  = process.argv.slice(2);
  let mapPath: string | undefined;
  let outPath: string | undefined;
  let scale   = DEFAULT_SCALE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map'  ) mapPath = argv[++i];
    if (argv[i] === '--out'  ) outPath = argv[++i];
    if (argv[i] === '--scale') scale   = parseInt(argv[++i], 10);
  }

  if (!Number.isFinite(scale) || scale <= 0 || !Number.isInteger(scale)) {
    process.stderr.write(`ERROR: --scale must be a positive integer (got: ${scale})\n`);
    process.exit(1);
  }

  mapPath ??= findSolarisMap();
  if (!mapPath) {
    process.stderr.write('ERROR: SOLARIS.MAP not found. Use --map PATH\n');
    process.exit(1);
  }

  const toolDir  = path.dirname(fileURLToPath(import.meta.url));
  const projRoot = path.resolve(toolDir, '..');
  outPath ??= path.join(projRoot, 'world-map.json');

  process.stderr.write(`Using SOLARIS.MAP: ${mapPath}\n`);
  process.stderr.write(`Scale: ${scale}px per step\n`);
  process.stderr.write(`Output: ${outPath}\n\n`);

  // ── Parse SOLARIS.MAP ────────────────────────────────────────────────────────
  const parsed = parseMapFile(mapPath);

  // Sector hubs keyed by name
  const sectorHubCoords: Record<string, Coords> = {};
  const SECTOR_HUB_MAP: Record<number, string> = {
    1: 'international', 2: 'kobe', 3: 'silesia',
    4: 'montenegro',    5: 'cathay', 6: 'blackhills',
    146: 'international',  // Starport belongs to International zone
  };

  const namedRooms: NamedRoom[] = parsed.rooms.map((r, idx) => {
    const cx = Math.round((r.bounds.x1 + r.bounds.x2) / 2);
    const cy = Math.round((r.bounds.y1 + r.bounds.y2) / 2);
    return {
      id: r.roomId, name: r.name, description: r.description,
      cx, cy,
      flags: r.flags,
      aux0: r.aux.aux0, aux1: r.aux.aux1, aux2: r.aux.aux2,
      sceneIndex: idx,
      sector: '',       // filled below
      type: inferType(r.roomId, r.name),
    };
  });

  // Save hub coords
  for (const room of namedRooms) {
    const sector = SECTOR_HUB_MAP[room.id];
    if (sector) sectorHubCoords[sector] = room;
  }

  // ── Assign rooms to sectors ──────────────────────────────────────────────────
  const sectorList = Object.keys(sectorHubCoords);

  for (const room of namedRooms) {
    if (SECTOR_OVERRIDES[room.id]) {
      room.sector = SECTOR_OVERRIDES[room.id];
      continue;
    }
    if (SECTOR_HUB_MAP[room.id]) {
      room.sector = SECTOR_HUB_MAP[room.id];
      continue;
    }
    // Nearest sector hub
    let best = sectorList[0];
    let bestDist = Infinity;
    for (const sec of sectorList) {
      const d = euclidean(room, sectorHubCoords[sec]);
      if (d < bestDist) { bestDist = d; best = sec; }
    }
    room.sector = best;
  }

  // Summarise sector assignments
  const bySector = new Map<string, NamedRoom[]>();
  for (const room of namedRooms) {
    if (!bySector.has(room.sector)) bySector.set(room.sector, []);
    bySector.get(room.sector)!.push(room);
  }
  for (const [sec, rooms] of bySector) {
    process.stderr.write(`  ${sec.padEnd(15)} ${rooms.map(r => r.name).join(', ')}\n`);
  }
  process.stderr.write('\n');

  // ── Build edge list ──────────────────────────────────────────────────────────
  const allEdges: Array<[number, number]> = [];
  const edgeSet  = new Set<string>();

  function addEdge(a: number, b: number): void {
    const key = `${Math.min(a,b)}:${Math.max(a,b)}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    allEdges.push([a, b]);
  }

  // Intra-sector MST
  for (const [sec, rooms] of bySector) {
    const hubId = rooms.find(r => SECTOR_HUB_MAP[r.id] === sec)?.id ?? rooms[0].id;
    const mst   = buildMST(hubId, rooms, MAX_INTRA_DIST);
    for (const [a, b] of mst) addEdge(a, b);
    process.stderr.write(`  MST ${sec}: ${mst.length} edges\n`);
  }

  // Cross-sector edges
  const crossEdges = buildCrossSectorEdges(bySector, MAX_CROSS_DIST);
  for (const [a, b] of crossEdges) addEdge(a, b);
  process.stderr.write(`  Cross-sector: ${crossEdges.length} edges\n`);

  // Extra forced connections
  for (const [a, b] of EXTRA_CONNECTIONS) addEdge(a, b);
  process.stderr.write(`  Extra forced: ${EXTRA_CONNECTIONS.length} edges\n`);
  process.stderr.write(`  Total edges: ${allEdges.length}\n\n`);

  // ── Initialise output rooms ──────────────────────────────────────────────────
  const outputById  = new Map<number, OutputRoom>();
  const coordsById  = new Map<number, Coords>();

  for (const room of namedRooms) {
    outputById.set(room.id, {
      roomId: room.id,
      _name:  room.name,
      description: room.description || undefined,
      sector: room.sector,
      type:   room.type,
      icon:   NAMED_ROOM_ICONS[room.id] ?? null,
      clientMapDescription: true,
      exits:  { north: null, south: null, east: null, west: null },
    });
    coordsById.set(room.id, room);
  }

  // ── Build connections (adds intermediate rooms) ──────────────────────────────
  buildConnections(allEdges, coordsById, outputById, scale);

  // ── Serialise ────────────────────────────────────────────────────────────────
  const namedCount = namedRooms.length;
  const genCount   = outputById.size - namedCount;
  process.stderr.write(`Generated ${genCount} intermediate rooms (${outputById.size} total)\n`);

  // Sort: named rooms first (by roomId), then generated
  const sorted = [
    ...[...outputById.values()].filter(r => r.roomId < GEN_ID_START).sort((a,b)=>a.roomId-b.roomId),
    ...[...outputById.values()].filter(r => r.roomId >= GEN_ID_START).sort((a,b)=>a.roomId-b.roomId),
  ];

  const output = {
    _comment: [
      'MPBT Solaris VII world map — generated by tools/gen-world-map.ts.',
      'Named rooms (roomId < 1000) are from SOLARIS.MAP.',
      'Intermediate rooms (roomId >= 1000) are generated; edit FLAVOR_OVERRIDES in the script to set name/type/icon.',
      `Scale: ${scale}px per step.  Re-run the script to regenerate after changing overrides or scale.`,
    ],
    _schema: {
      type: 'bar | arena | hub | terminal | bank | street | sector | path',
      icon: 'Cmd4 mechId for the location icon; null = not yet known (falls back to sceneIndex).',
      description: 'Optional lower scene-header text, mirrored from SOLARIS.MAP for stock rooms.',
      clientMapDescription: 'true for stock Solaris rooms whose name/description metadata comes from local SOLARIS.MAP.',
      _inferred: 'true on intermediate rooms generated by the script.',
      exits: 'roomId or null for each compass direction.',
    },
    rooms: sorted,
  };

  const json = JSON.stringify(output, null, 2);
  fs.writeFileSync(outPath, json, 'utf8');
  process.stderr.write(`Wrote ${outPath}\n`);
}

main();
