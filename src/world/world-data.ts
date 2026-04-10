/**
 * World server — static data layer.
 *
 * Mech catalog, room/map loading, session-management constants, and the
 * read-only helper functions that query the loaded data.
 * No protocol or socket dependencies.
 */

import { loadMechs }                                                   from '../data/mechs.js';
import { loadSolarisRooms, WorldRoom, loadWorldMap, WorldMapRoom }     from '../data/maps.js';
import { MECH_STATS }                                                  from '../data/mech-stats.js';
import { CaptureLogger }                                               from '../util/capture.js';

// ── Shared mech catalog ───────────────────────────────────────────────────────
// Loaded once at module import time.  Provides a fallback when a player's
// launch record is absent (e.g. direct connection to world port in tests).
export let WORLD_MECHS: ReturnType<typeof loadMechs>;
try {
  WORLD_MECHS = loadMechs();
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Non-fatal: the world server still starts; FALLBACK_MECH_ID is used instead.
  process.stderr.write(`[world] WARNING: failed to load mechs: ${msg}\n`);
  WORLD_MECHS = [];
}

/** Mech ID used when the player's launch record is missing. */
export const FALLBACK_MECH_ID = WORLD_MECHS.length > 0 ? WORLD_MECHS[0].id : 0;

/** Fast lookup from mech ID to MechEntry (for extraCritCount etc.). */
export const WORLD_MECH_BY_ID = new Map(WORLD_MECHS.map(m => [m.id, m]));

// ── World constants ───────────────────────────────────────────────────────────

export const DEFAULT_MAP_ROOM_ID        = 146; // Solaris Starport
export const DEFAULT_SCENE_NAME         = 'Solaris Arena';

export const ALL_ROSTER_LIST_ID         = 0x3F4;
// 0x3E8 (1000) is reserved by the client for its own local "Personal inquiry on:"
// submenu (FUN_00412980).  Sending Cmd7 with that listId triggers special client
// handling that ignores our payload and uses a garbage internal target_id.  Use
// any non-reserved positive integer instead (see RESEARCH.md §11 avoid-list).
export const INQUIRY_MENU_ID            = 0x3F3;  // 1011 — safe, not in client avoid-list
export const PERSONNEL_LIST_ID          = 0x3F2;
export const PERSONNEL_MORE_ID          = 0x95;
export const SOLARIS_TRAVEL_CONTEXT_ID  = 0xC6;

// ── Per-connection session state ─────────────────────────────────────────────

let _nextWorldRosterId = 1;

/** Allocates the next unique in-memory roster ID for a new world session. */
export function allocateWorldRosterId(): number {
  return _nextWorldRosterId++;
}

/**
 * Per-session CaptureLogger instances.
 * Populated by handleWorldConnection; consumed by sendToWorldSession().
 */
export const worldCaptures = new Map<string, CaptureLogger>();

// ── Solaris room model ────────────────────────────────────────────────────────
// Loaded at startup from SOLARIS.MAP via parseMapFile().  Falls back to a
// hardcoded list when the proprietary map asset is absent so the server still
// starts during development without the full game data.

/** Hardcoded fallback used when SOLARIS.MAP is not present. */
export const SOLARIS_FALLBACK_ROOMS: WorldRoom[] = [
  { roomId: 146, name: 'Solaris Starport',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 0 },
  { roomId: 147, name: 'Ishiyama Arena',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 1 },
  { roomId: 148, name: 'Government House',        flags: 0, centreX: 0, centreY: 0, sceneIndex: 2 },
  { roomId: 149, name: 'White Lotus',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 3 },
  { roomId: 150, name: 'Waterfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 4 },
  { roomId: 151, name: 'Kobe Slums',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 5 },
  { roomId: 152, name: 'Steiner Stadium',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 6 },
  { roomId: 153, name: 'Lyran Building',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 7 },
  { roomId: 154, name: 'Chahar Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 8 },
  { roomId: 155, name: 'Riverside',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 9 },
  { roomId: 156, name: 'Black Throne',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 10 },
  { roomId: 157, name: 'Factory',                 flags: 0, centreX: 0, centreY: 0, sceneIndex: 11 },
  { roomId: 158, name: 'Marik Tower',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 12 },
  { roomId: 159, name: 'Allman',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 13 },
  { roomId: 160, name: 'Riverfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 14 },
  { roomId: 161, name: 'Wasteland',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 15 },
  { roomId: 162, name: 'Jungle',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 16 },
  { roomId: 163, name: "Chancellor's Quarters",   flags: 0, centreX: 0, centreY: 0, sceneIndex: 17 },
  { roomId: 164, name: 'Middletown',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 18 },
  { roomId: 165, name: 'Rivertown',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 19 },
  { roomId: 166, name: 'Maze',                    flags: 0, centreX: 0, centreY: 0, sceneIndex: 20 },
  { roomId: 167, name: 'Davion Arena',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 21 },
  { roomId: 168, name: 'Sortek Building',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 22 },
  { roomId: 169, name: 'Guzman Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 23 },
  { roomId: 170, name: 'Marina',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 24 },
  { roomId: 171, name: 'Viewpoint',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 25 },
  { roomId: 1,   name: 'International Sector',    flags: 0, centreX: 0, centreY: 0, sceneIndex: 26 },
  { roomId: 2,   name: 'Kobe Sector',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 27 },
  { roomId: 3,   name: 'Silesia Sector',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 28 },
  { roomId: 4,   name: 'Montenegro Sector',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 29 },
  { roomId: 5,   name: 'Cathay Sector',           flags: 0, centreX: 0, centreY: 0, sceneIndex: 30 },
  { roomId: 6,   name: 'Black Hills Sector',      flags: 0, centreX: 0, centreY: 0, sceneIndex: 31 },
];

let solarisRooms: WorldRoom[];
try {
  const loaded = loadSolarisRooms();
  if (loaded) {
    solarisRooms = loaded;
    process.stderr.write(`[world] loaded ${loaded.length} rooms from SOLARIS.MAP\n`);
  } else {
    solarisRooms = SOLARIS_FALLBACK_ROOMS;
    process.stderr.write('[world] WARNING: SOLARIS.MAP not found — using hardcoded room list\n');
  }
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[world] WARNING: failed to parse SOLARIS.MAP: ${msg}\n`);
  solarisRooms = SOLARIS_FALLBACK_ROOMS;
}

export const SOLARIS_ROOM_BY_ID = new Map<number, WorldRoom>(
  solarisRooms.map(room => [room.roomId, room]),
);

// ── World map (navigation graph from world-map.json) ─────────────────────────

export let worldMapByRoomId = new Map<number, WorldMapRoom>();
try {
  const worldMap = loadWorldMap();
  if (worldMap) {
    worldMapByRoomId = new Map(worldMap.rooms.map(r => [r.roomId, r]));
    process.stderr.write(`[world] loaded world-map.json (${worldMap.rooms.length} rooms)\n`);
  } else {
    process.stderr.write('[world] WARNING: world-map.json not found — using provisional linear topology\n');
  }
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[world] WARNING: failed to parse world-map.json: ${msg}\n`);
}

// Extend SOLARIS_ROOM_BY_ID with synthetic WorldRoom entries for any generated
// rooms in world-map.json (roomId >= 1000) that are not in SOLARIS.MAP.
// This ensures getSolarisRoomName()/getSolarisSceneIndex() return correct data
// for intermediate rooms rather than falling back to DEFAULT_MAP_ROOM_ID.
let _nextSynthSceneIndex = SOLARIS_ROOM_BY_ID.size;
for (const [id, mapRoom] of worldMapByRoomId) {
  if (!SOLARIS_ROOM_BY_ID.has(id)) {
    SOLARIS_ROOM_BY_ID.set(id, {
      roomId:     id,
      name:       mapRoom.name ?? `Room ${id}`,
      flags:      0,
      centreX:    0,
      centreY:    0,
      sceneIndex: _nextSynthSceneIndex++,
    });
  }
}

// ── Room helper functions ─────────────────────────────────────────────────────

export function getSolarisRoomInfo(roomId: number): WorldRoom {
  return SOLARIS_ROOM_BY_ID.get(roomId) ?? SOLARIS_ROOM_BY_ID.get(DEFAULT_MAP_ROOM_ID)!;
}

export function getSolarisSceneIndex(roomId: number): number {
  return getSolarisRoomInfo(roomId).sceneIndex;
}

export function getSolarisRoomName(roomId: number): string {
  return getSolarisRoomInfo(roomId).name;
}

export function uniqueRoomIds(roomIds: number[]): number[] {
  return [...new Set(roomIds)].filter(roomId => SOLARIS_ROOM_BY_ID.has(roomId));
}

/**
 * Return up to 4 exit room IDs for a given room.
 *
 * SOLARIS.MAP stores pixel positions on the visual travel-map bitmap and
 * room descriptions.  It does NOT encode room-to-room connections.
 * IS.MAP similarly stores star-system positions on the IS overview bitmap.
 * Neither file contains a navigation graph.
 *
 * The original server's room connection table has not yet been RE'd.
 * Until it is, use a provisional linear topology: room 146 is the Solaris
 * hub, each room connects back to the hub and to its immediate neighbours
 * in the loaded room list, with sector-row links for Solaris district rooms.
 */
export function getSolarisRoomExits(roomId: number): number[] {
  // Use world-map.json if loaded.
  const mapRoom = worldMapByRoomId.get(roomId);
  if (mapRoom) {
    const { north, south, east, west } = mapRoom.exits;
    // Slot order: 0=N 1=S 2=E 3=W.  Skip nulls (no exit in that direction).
    return [north, south, east, west].filter((id): id is number => id !== null);
  }

  // Provisional linear topology fallback.
  if (roomId === 146) return [147, 152, 157, 162];

  const index = solarisRooms.findIndex(r => r.roomId === roomId);
  const exits = [146];

  if (index > 0) exits.push(solarisRooms[index - 1].roomId);
  if (index >= 0 && index < solarisRooms.length - 1) exits.push(solarisRooms[index + 1].roomId);

  if (roomId >= 147 && roomId <= 171) {
    const sectorOffset = Math.floor((roomId - 147) / 5);
    exits.push(solarisRooms[26 + Math.min(sectorOffset, 5)].roomId);
  }

  return uniqueRoomIds(exits).filter(exit => exit !== roomId).slice(0, 4);
}

/**
 * Return the Cmd4 location icon ID (mechId) for a room.
 * Uses the icon field from world-map.json if present; falls back to sceneIndex.
 */
export function getSolarisRoomIcon(roomId: number): number {
  const mapRoom = worldMapByRoomId.get(roomId);
  if (mapRoom?.icon !== null && mapRoom?.icon !== undefined) return mapRoom.icon;
  return getSolarisSceneIndex(roomId);
}

// ── Mech picker constants ─────────────────────────────────────────────────────

/** Cmd26 listId for the weight-class picker (step 1). */
export const MECH_CLASS_LIST_ID   = 0x20;
/** Cmd26 listId for the chassis picker (step 2). */
export const MECH_CHASSIS_LIST_ID = 0x3e;

/** Display labels for each weight class (slot 0..3). */
export const CLASS_LABELS = ['Light', 'Medium', 'Heavy', 'Assault'] as const;
/** Uppercase keys used to filter MECH_STATS by weight class. */
export const CLASS_KEYS   = ['LIGHT', 'MEDIUM', 'HEAVY', 'ASSAULT'] as const;

/** Static fallback chassis name map for mechs that may not appear in MECH_STATS. */
export const CHASSIS_BY_PREFIX: Record<string, string> = {
  ACM: 'Arachne', ADR: 'Adder', ANH: 'Annihilator', AS7: 'Atlas',
  BLR: 'BattleMaster', BNC: 'Banshee', BS1: 'Black Hawk',
  BT:  'BattleMaster', C3I: 'C3I Upgrade', CAT: 'Catapult',
  CBR: 'Cobra', CLN: 'Clan Nova', CLR: 'Clint', CN9: 'Centurion',
  COM: 'Commando', CPN: 'Capellan', CTF: 'Cataphract', CTS: 'Centurion',
  DRG: 'Dragon', DV8: 'Dervish', DW: 'Dire Wolf', EBJ: 'Ebon Jaguar',
  ENF: 'Enforcer', EXC: 'Excalibur', FLS: 'Flashman', FRB: 'Firebee',
  GHR: 'Grasshopper', GLG: 'Galahad', GRF: 'Griffin', HBK: 'Hunchback',
  HCT: 'Hatchetman', HGN: 'Highlander', HM:  'Hammer', HNT: 'Huntsman',
  HPT: 'Hellspawn', HSN: 'Hussar', HTM: 'Hatamoto', HVT: 'Heavy',
  IIC: 'IIC', JM6: 'Jagermech', JR7: 'Jenner', JVN: 'Javelin',
  KGC: 'King Crab', KTO: 'Kintaro', LCT: 'Locust', LGB: 'Longbow',
  MAD: 'Marauder', MDG: 'Mad Dog', MDD: 'Mad Dog', MLX: 'Mist Lynx',
  MNS: 'Mauler', MNT: 'Mantis', MON: 'Mongoose', MRM: 'Marauder IIC',
  NVA: 'Nova', ONI: 'Ontos', OSR: 'Osiris', PNT: 'Panther',
  PPC: 'PPCer', PRT: 'Praetorian', PTR: 'Penetrator', RFL: 'Rifleman',
  RGR: 'Ranger', RJX: 'Rjin', RVN: 'Raven', SDR: 'Spider',
  SHD: 'Shadow Hawk', SHK: 'Shrike', SMN: 'Summoner', SRM: 'Srm',
  STK: 'Stalker', STO: 'Stormcrow', STR: 'Striker', SVN: 'Savannah Master',
  TBT: 'Trebuchet', THG: 'Thug', TIM: 'Timber Wolf', TOR: 'Talon',
  UM:  'Urbanmech', VLK: 'Vulkan', VMN: 'Vulcan', VND: 'Vindicator',
  VPR: 'Viper', VP:  'Viper', WAR: 'Warhammer', WHM: 'Warhammer',
  WLF: 'Wolf Trap', WOL: 'Wolfhound', WSP: 'Wasp', YMN: 'Yeoman',
  ZZZ: 'Test Mech',
};

export const PREFIX_TO_CHASSIS = new Map<string, string>();
for (const [typeString, stat] of MECH_STATS.entries()) {
  if (stat.disabled) continue;
  const prefix = typeString.slice(0, typeString.indexOf('-'));
  if (prefix && !PREFIX_TO_CHASSIS.has(prefix)) {
    PREFIX_TO_CHASSIS.set(prefix, stat.name);
  }
}

/** Return the canonical chassis name for a mech typeString, e.g. "JR7-1X" -> "Jenner". */
export function getMechChassis(typeString: string): string {
  const stat = MECH_STATS.get(typeString);
  if (stat && !stat.disabled) return stat.name;
  const hyphen = typeString.indexOf('-');
  const prefix = hyphen > 0 ? typeString.slice(0, hyphen) : typeString;
  return PREFIX_TO_CHASSIS.get(prefix) ?? CHASSIS_BY_PREFIX[prefix] ?? prefix;
}

/** Convert maxSpeedMag back to displayed kph, matching the client's mec_speed scale. */
export function mechKph(maxSpeedMag: number): number {
  return Math.round(maxSpeedMag * 16.2 / 450);
}

// ── Per-session world position ────────────────────────────────────────────────

/**
 * Update the session's world position from the given room's data.
 *
 * Sets worldMapRoomId, worldX (centreX), worldY (centreY), and worldZ (0).
 *
 * Call this on every room transition:
 *   - initial spawn (handleWorldLogin, DEFAULT_MAP_ROOM_ID)
 *   - Cmd43 map-UI travel reply  (handleMapTravelReply)
 *   - Cmd23 compass-exit navigation (handleLocationAction)
 *
 * NOTE: In RPS/world mode there is no confirmed server→client position wire
 * packet separate from Cmd65 (which is combat-only, RESEARCH.md §19.6.1).
 * The client receives its scene position via Cmd4 playerScoreSlot on every
 * room entry.  worldX/Y/Z are server-side bookkeeping for roster display,
 * future multiplayer broadcasts, and combat spawn positioning.
 */
export function setSessionRoomPosition(
  session: { worldMapRoomId?: number; worldX?: number; worldY?: number; worldZ?: number },
  roomId: number,
): void {
  // Always assign the caller's roomId directly so that generated rooms
  // (IDs ≥ 1000, in world-map.json but not in SOLARIS_ROOM_BY_ID) are
  // correctly tracked.  getSolarisRoomInfo may fall back to DEFAULT_MAP_ROOM_ID
  // when roomId is unknown; centreX/Y from the fallback are acceptable
  // placeholder coords, but worldMapRoomId must be the real room.
  const room = getSolarisRoomInfo(roomId);
  session.worldMapRoomId = roomId;
  session.worldX         = room.centreX;
  session.worldY         = room.centreY;
  session.worldZ         = 0;
}
