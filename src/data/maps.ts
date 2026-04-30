/**
 * MPBT .MAP room-record parser.
 *
 * The proprietary map files are not committed. This parser mirrors the leading
 * room-record load performed by MPBTWIN.EXE Map_LoadFile (FUN_004100c0), so M5
 * work can be reproduced against a local licensed installation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface MapBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapAuxFields {
  aux0: number;
  aux1: number;
  aux2: number;
}

export interface MapRoomRecord {
  source: string;
  offset: number;
  roomId: number;
  flags: number;
  bounds: MapBounds;
  aux: MapAuxFields;
  nameLength: number;
  descriptionLength: number;
  name: string;
  description: string;
}

export interface ParsedMapFile {
  path: string;
  source: string;
  roomCount: number;
  rooms: MapRoomRecord[];
  remainingOffset: number;
  remainingBytes: number;
}

function requireBytes(buf: Buffer, offset: number, count: number, label: string, filePath: string): void {
  if (offset + count > buf.length) {
    throw new Error(
      `${path.basename(filePath)}: truncated while reading ${label} at 0x${offset.toString(16)}`,
    );
  }
}

function readCStringField(buf: Buffer, offset: number, length: number, label: string, filePath: string): string {
  if (length < 1) {
    throw new Error(
      `${path.basename(filePath)}: invalid ${label} length ${length} at 0x${offset.toString(16)}`,
    );
  }
  requireBytes(buf, offset, length, label, filePath);
  const raw = buf.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return (nul >= 0 ? raw.subarray(0, nul) : raw).toString('latin1');
}

function readU16(buf: Buffer, offset: number, label: string, filePath: string): number {
  requireBytes(buf, offset, 2, label, filePath);
  return buf.readUInt16LE(offset);
}

/**
 * Parse the leading room-record table from an MPBT .MAP file.
 *
 * Confirmed layout:
 *   [u16 count]
 *   repeated count times:
 *     [u16 room_id]
 *     [u16 flags]
 *     [u16 x1] [u16 y1] [u16 x2] [u16 y2]
 *     [u16 aux0] [u16 aux1] [u16 aux2]
 *     [u16 name_len_including_nul] [name bytes]
 *     [u16 desc_len_including_nul] [description bytes]
 *
 * MPBTWIN.EXE passes bytes after the room table to Picture_ReadFromFile
 * (FUN_00428770). Those trailing bytes are intentionally preserved only as an
 * offset/count until the picture format matters for gameplay.
 */
export function parseMapFile(filePath: string, source = path.basename(filePath).toUpperCase()): ParsedMapFile {
  const buf = fs.readFileSync(filePath);
  let offset = 0;

  const roomCount = readU16(buf, offset, 'room count', filePath);
  offset += 2;

  const rooms: MapRoomRecord[] = [];
  for (let i = 0; i < roomCount; i += 1) {
    const recordOffset = offset;

    const roomId = readU16(buf, offset, 'room id', filePath);
    offset += 2;
    const flags = readU16(buf, offset, 'flags', filePath);
    offset += 2;

    const bounds: MapBounds = {
      x1: readU16(buf, offset, 'x1', filePath),
      y1: readU16(buf, offset + 2, 'y1', filePath),
      x2: readU16(buf, offset + 4, 'x2', filePath),
      y2: readU16(buf, offset + 6, 'y2', filePath),
    };
    offset += 8;

    const aux: MapAuxFields = {
      aux0: readU16(buf, offset, 'aux0', filePath),
      aux1: readU16(buf, offset + 2, 'aux1', filePath),
      aux2: readU16(buf, offset + 4, 'aux2', filePath),
    };
    offset += 6;

    const nameLength = readU16(buf, offset, 'name length', filePath);
    offset += 2;
    const name = readCStringField(buf, offset, nameLength, 'name', filePath);
    offset += nameLength;

    const descriptionLength = readU16(buf, offset, 'description length', filePath);
    offset += 2;
    const description = readCStringField(buf, offset, descriptionLength, 'description', filePath);
    offset += descriptionLength;

    rooms.push({
      source,
      offset: recordOffset,
      roomId,
      flags,
      bounds,
      aux,
      nameLength,
      descriptionLength,
      name,
      description,
    });
  }

  return {
    path: filePath,
    source,
    roomCount,
    rooms,
    remainingOffset: offset,
    remainingBytes: buf.length - offset,
  };
}

// ── World-room abstraction ─────────────────────────────────────────────────

/**
 * A single room entry derived from a parsed MAP file, suitable for use as
 * the server-side room model.
 *
 * NOTE: centreX/centreY are pixel positions on the visual travel-map bitmap
 * used by the client's Cmd43 (Solaris map) UI.  They do NOT encode room-to-room
 * connections — those were server-side data in the original game and have not
 * yet been RE'd.
 */
export interface WorldRoom {
  roomId: number;
  name: string;
  /** Raw flags word from the map record (faction / type; exact semantics TBD). */
  flags: number;
  /**
   * Pixel X position on the visual travel-map bitmap (midpoint of the record's
   * bounding box).  Visual use only — not a navigation coordinate.
   */
  centreX: number;
  /**
   * Pixel Y position on the visual travel-map bitmap (midpoint of the record's
   * bounding box).  Visual use only — not a navigation coordinate.
   */
  centreY: number;
  /** 0-based position in the SOLARIS.MAP room list (used as scene-slot index). */
  sceneIndex: number;
  /** Flavor text from SOLARIS.MAP; empty string when no description is available. */
  description: string;
}

function projectRoot(): string {
  // __dirname equiv: src/data/ → ../../ = project root
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, '../../');
}

function findMapFile(filename: string): string | undefined {
  const root = projectRoot();
  const dirs = [
    process.env['MPBT_DATA_DIR'],
    root,
    process.cwd(),
    path.resolve(root, '..'),
    path.resolve(root, 'research'),
  ].filter((d): d is string => Boolean(d));

  for (const dir of dirs) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Load the SOLARIS.MAP room table and return it as an ordered WorldRoom array.
 *
 * Returns `null` if SOLARIS.MAP cannot be found — callers should warn and fall
 * back to a hardcoded room list so the server still starts without the
 * proprietary assets.
 *
 * Throws if the file is found but fails to parse (data corruption).
 *
 * @param filePath  Optional explicit path; omit to search default locations.
 */
export function loadSolarisRooms(filePath?: string): WorldRoom[] | null {
  const resolved = filePath ?? findMapFile('SOLARIS.MAP');
  if (!resolved) return null;

  const parsed = parseMapFile(resolved, 'SOLARIS.MAP');
  return parsed.rooms.map((room, index): WorldRoom => ({
    roomId:     room.roomId,
    name:       room.name,
    flags:      room.flags,
    centreX:    (room.bounds.x1 + room.bounds.x2) / 2,
    centreY:    (room.bounds.y1 + room.bounds.y2) / 2,
    sceneIndex: index,
    description: room.description,
  }));
}

// ── World map (navigation graph) ───────────────────────────────────────────

/**
 * Room type tags used in world-map.json.
 * bar | arena | hub | terminal | bank | street | sector | path
 */
export type RoomType = 'bar' | 'arena' | 'hub' | 'terminal' | 'bank' | 'street' | 'sector' | 'path' | 'tram' | 'park' | 'stub';

/** One entry from world-map.json, representing navigation data for a single room. */
export interface WorldMapRoom {
  roomId: number;
  /** Human-readable room name (_name or name field from the JSON). */
  name?: string;
  /**
   * Optional retail Solaris room id to use when a synthetic room needs a
   * client-safe scene anchor. When omitted, the server may infer one from the
   * graph at runtime.
   */
  sceneRoomId?: number;
  /** Room-description text for the lower world scene header line, when known. */
  description?: string;
  sector: string;
  type: RoomType;
  /**
   * Location icon ID sent in Cmd4 mechId field.
   * null = not yet known; server falls back to the room's retail scene anchor.
   */
  icon: number | null;
  /**
   * True for stock Solaris rooms whose name/description metadata originates in
   * the retail client's SOLARIS.MAP file and is mirrored into world-map.json.
   */
  clientMapDescription?: boolean;
  /** Cardinal exits.  null = no exit in that direction.  Values are roomIds. */
  exits: {
    north: number | null;
    south: number | null;
    east:  number | null;
    west:  number | null;
  };
}

/** Parsed world-map.json. */
export interface WorldMap {
  rooms: WorldMapRoom[];
}

/**
 * Load world-map.json from the project root (or MPBT_DATA_DIR).
 *
 * Returns `null` if the file is absent — callers fall back to provisional
 * linear topology.  Throws if the file exists but is malformed JSON.
 */
export function loadWorldMap(filePath?: string): WorldMap | null {
  const resolved = filePath ?? findMapFile('world-map.json');
  if (!resolved) return null;

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as { rooms?: unknown };
  if (!Array.isArray(parsed.rooms)) {
    throw new Error('world-map.json: "rooms" must be an array');
  }

  const rooms: WorldMapRoom[] = (parsed.rooms as Record<string, unknown>[]).map((r, i) => {
    if (typeof r['roomId'] !== 'number') {
      throw new Error(`world-map.json: rooms[${i}] missing numeric roomId`);
    }
    const exits = (r['exits'] ?? {}) as Record<string, unknown>;
    return {
      roomId: r['roomId'] as number,
      name:   typeof r['_name'] === 'string' ? r['_name'] as string
              : typeof r['name']  === 'string' ? r['name']  as string
              : undefined,
      sceneRoomId: typeof r['_sceneRoomId'] === 'number' ? r['_sceneRoomId'] as number
                 : typeof r['sceneRoomId']  === 'number' ? r['sceneRoomId']  as number
                 : undefined,
      description: typeof r['description'] === 'string' ? r['description'] as string : undefined,
      sector: String(r['sector'] ?? ''),
      type:   String(r['type']   ?? 'street') as RoomType,
      icon:   typeof r['icon'] === 'number' ? r['icon'] as number : null,
      clientMapDescription: r['clientMapDescription'] === true,
      exits: {
        north: typeof exits['north'] === 'number' ? exits['north'] as number : null,
        south: typeof exits['south'] === 'number' ? exits['south'] as number : null,
        east:  typeof exits['east']  === 'number' ? exits['east']  as number : null,
        west:  typeof exits['west']  === 'number' ? exits['west']  as number : null,
      },
    };
  });

  return { rooms };
}
