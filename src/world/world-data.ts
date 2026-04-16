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
export const COMSTAR_SEND_TARGET_MENU_ID = 0x3F1;
export const NEWS_CATEGORY_MENU_ID      = 0x3F0;
export const NEWSGRID_ARTICLE_LIST_ID   = 0x3EF;
export const TIER_RANKING_CHOOSER_LIST_ID = 0x3EE;
export const CLASS_RANKING_CHOOSER_LIST_ID = 0x3ED;
export const TIER_RANKING_RESULTS_LIST_ID = 0x3EC;
export const CLASS_RANKING_RESULTS_LIST_ID = 0x3EB;
export const MATCH_RESULTS_MENU_LIST_ID  = 0x3EA;
export const COMSTAR_ACCESS_MENU_ID     = 0x3E9;
export const ARENA_SIDE_MENU_ID         = 0x3F6;
export const ARENA_STATUS_LIST_ID       = 0x3F5;
export const ARENA_READY_ROOM_MAX_PARTICIPANTS = 8;
export const PERSONNEL_MORE_ID          = 0x95;
export const SOLARIS_TRAVEL_CONTEXT_ID  = 0xC6;
export const COMSTAR_ACCESS_ACTION_TYPE = 0x08;
export const ARENA_SIDE_ACTION_TYPE     = 0x09;
export const ARENA_STATUS_ACTION_TYPE   = 0x0A;

// Keep the always-available ComStar button on the smallest retail-GUI-safe surface.
// Deeper news and ranking flows stay reachable from the News Grid submenu.
export const GLOBAL_COMSTAR_MENU_ITEMS = [
  { itemId: 0, text: 'Send a ComStar message' },
  { itemId: 1, text: 'Receive a ComStar message' },
  { itemId: 2, text: 'Check News Grid' },
] as const;

export const COMSTAR_SEND_TARGET_MENU_ITEMS = [
  'Search by Comstar ID',
  'All Personnel Online',
] as const;

export const NEWS_CATEGORY_MENU_ITEMS = [
  'Solaris Match Results',
  'View Personal Tier Rankings',
  'Tier Rankings',
  'Class Rankings',
  'General news',
  'House news',
] as const;

export const TIER_RANKING_CHOOSER_ITEMS = [
  { itemId: 0, text: 'Unranked' },
  { itemId: 1, text: 'Novice' },
  { itemId: 2, text: 'Amateur' },
  { itemId: 3, text: 'Professional' },
  { itemId: 4, text: 'Veteran' },
  { itemId: 5, text: 'Master' },
  { itemId: 6, text: 'BattleMaster' },
  { itemId: 7, text: 'Champion' },
] as const;

export const CLASS_RANKING_CHOOSER_ITEMS = [
  { itemId: 0, text: 'Light' },
  { itemId: 1, text: 'Medium' },
  { itemId: 2, text: 'Heavy' },
  { itemId: 3, text: 'Assault' },
] as const;

export const ARENA_SIDE_MENU_ITEMS = [
  'Side 1',
  'Side 2',
  'Side 3',
  'Side 4',
  'Side 5',
  'Side 6',
  'Side 7',
  'Side 8',
] as const;

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
  { roomId: 146, name: 'Solaris Starport',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 0,  description: '' },
  { roomId: 147, name: 'Ishiyama Arena',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 1,  description: '' },
  { roomId: 148, name: 'Government House',        flags: 0, centreX: 0, centreY: 0, sceneIndex: 2,  description: '' },
  { roomId: 149, name: 'White Lotus',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 3,  description: '' },
  { roomId: 150, name: 'Waterfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 4,  description: '' },
  { roomId: 151, name: 'Kobe Slums',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 5,  description: '' },
  { roomId: 152, name: 'Steiner Stadium',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 6,  description: '' },
  { roomId: 153, name: 'Lyran Building',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 7,  description: '' },
  { roomId: 154, name: 'Chahar Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 8,  description: '' },
  { roomId: 155, name: 'Riverside',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 9,  description: '' },
  { roomId: 156, name: 'Black Throne',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 10, description: '' },
  { roomId: 157, name: 'Factory',                 flags: 0, centreX: 0, centreY: 0, sceneIndex: 11, description: '' },
  { roomId: 158, name: 'Marik Tower',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 12, description: '' },
  { roomId: 159, name: 'Allman',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 13, description: '' },
  { roomId: 160, name: 'Riverfront',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 14, description: '' },
  { roomId: 161, name: 'Wasteland',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 15, description: '' },
  { roomId: 162, name: 'Jungle',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 16, description: '' },
  { roomId: 163, name: "Chancellor's Quarters",   flags: 0, centreX: 0, centreY: 0, sceneIndex: 17, description: '' },
  { roomId: 164, name: 'Middletown',              flags: 0, centreX: 0, centreY: 0, sceneIndex: 18, description: '' },
  { roomId: 165, name: 'Rivertown',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 19, description: '' },
  { roomId: 166, name: 'Maze',                    flags: 0, centreX: 0, centreY: 0, sceneIndex: 20, description: '' },
  { roomId: 167, name: 'Davion Arena',            flags: 0, centreX: 0, centreY: 0, sceneIndex: 21, description: '' },
  { roomId: 168, name: 'Sortek Building',         flags: 0, centreX: 0, centreY: 0, sceneIndex: 22, description: '' },
  { roomId: 169, name: 'Guzman Park',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 23, description: '' },
  { roomId: 170, name: 'Marina',                  flags: 0, centreX: 0, centreY: 0, sceneIndex: 24, description: '' },
  { roomId: 171, name: 'Viewpoint',               flags: 0, centreX: 0, centreY: 0, sceneIndex: 25, description: '' },
  { roomId: 1,   name: 'International Sector',    flags: 0, centreX: 0, centreY: 0, sceneIndex: 26, description: '' },
  { roomId: 2,   name: 'Kobe Sector',             flags: 0, centreX: 0, centreY: 0, sceneIndex: 27, description: '' },
  { roomId: 3,   name: 'Silesia Sector',          flags: 0, centreX: 0, centreY: 0, sceneIndex: 28, description: '' },
  { roomId: 4,   name: 'Montenegro Sector',       flags: 0, centreX: 0, centreY: 0, sceneIndex: 29, description: '' },
  { roomId: 5,   name: 'Cathay Sector',           flags: 0, centreX: 0, centreY: 0, sceneIndex: 30, description: '' },
  { roomId: 6,   name: 'Black Hills Sector',      flags: 0, centreX: 0, centreY: 0, sceneIndex: 31, description: '' },
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
      roomId:      id,
      name:        mapRoom.name ?? `Room ${id}`,
      flags:       0,
      centreX:     0,
      centreY:     0,
      sceneIndex:  _nextSynthSceneIndex++,
      description: '',
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

export function usesClientMapDescription(roomId: number): boolean {
  return worldMapByRoomId.get(roomId)?.clientMapDescription === true;
}

export function getSolarisRoomDescription(roomId: number): string {
  return SOLARIS_ROOM_BY_ID.get(roomId)?.description ?? '';
}

export function getSolarisSceneHeaderText(roomId: number): string {
  const name = getSolarisRoomName(roomId);
  if (usesClientMapDescription(roomId)) return name;
  const desc = getSolarisRoomDescription(roomId);
  return desc ? `${name}\x5c${desc}` : name;
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

/** Cmd26 listId/typeFlag for the weight-class picker (step 1). */
export const MECH_CLASS_LIST_ID   = 0x00;
/** Cmd26 listId/typeFlag for the chassis picker (step 2). */
export const MECH_CHASSIS_LIST_ID = 0x00;
/** Cmd26 listId/typeFlag for the variant picker (step 3). */
export const MECH_VARIANT_LIST_ID = 0x00;
/** Cmd26 can safely carry at most 20 rows; reserve one row for the "More…" pagination entry. */
export const MECH_CHASSIS_PAGE_SIZE = 19;
export const MECH_CLASS_FOOTER = 'Choose a mech class:';
export const MECH_CHASSIS_FOOTER = 'Choose a mech:';
export const MECH_VARIANT_FOOTER = 'Select or examine a mech:';

/** Display labels for each weight class (slot 0..3). */
export const CLASS_LABELS = ['Light', 'Medium', 'Heavy', 'Assault'] as const;
/** Uppercase keys used to filter MECH_STATS by weight class. */
export const CLASS_KEYS   = ['LIGHT', 'MEDIUM', 'HEAVY', 'ASSAULT'] as const;
type MechWeightClass = typeof CLASS_KEYS[number];

type CanonicalMechCatalogEntry = {
  chassis: string;
  weightClass: MechWeightClass;
};

/**
 * Canonical chassis/class catalog derived from BT-MAN.PDF Appendix III and the
 * MPBT.MSG mech string table. Keys may be either a full variant designation
 * (for exact overrides like MAD-4A) or a chassis prefix (e.g. "JR7").
 *
 * A few variants shipped in MPBT.MSG are omitted from the manual's Appendix
 * III. Those still use the game's own chassis strings when present in MSG; the
 * HNT-151 variant is the one remaining local-source gap, so it is normalized by
 * designation as Hornet.
 */
export const CANONICAL_MECH_CATALOG: Record<string, CanonicalMechCatalogEntry> = {
  LCT:     { chassis: 'Locust',       weightClass: 'LIGHT'   },
  STG:     { chassis: 'Stinger',      weightClass: 'LIGHT'   },
  WSP:     { chassis: 'Wasp',         weightClass: 'LIGHT'   },
  COM:     { chassis: 'Commando',     weightClass: 'LIGHT'   },
  JVN:     { chassis: 'Javelin',      weightClass: 'LIGHT'   },
  SDR:     { chassis: 'Spider',       weightClass: 'LIGHT'   },
  UM:      { chassis: 'UrbanMech',    weightClass: 'LIGHT'   },
  VLK:     { chassis: 'Valkyrie',     weightClass: 'LIGHT'   },
  JR7:     { chassis: 'Jenner',       weightClass: 'LIGHT'   },
  PNT:     { chassis: 'Panther',      weightClass: 'LIGHT'   },
  FLE:     { chassis: 'Flea',         weightClass: 'LIGHT'   },
  FLC:     { chassis: 'Falcon',       weightClass: 'LIGHT'   },
  FFL:     { chassis: 'Firefly',      weightClass: 'LIGHT'   },
  FS9:     { chassis: 'Firestarter',  weightClass: 'LIGHT'   },
  HNT:     { chassis: 'Hornet',       weightClass: 'LIGHT'   },
  OTT:     { chassis: 'Ostscout',     weightClass: 'LIGHT'   },
  RVN:     { chassis: 'Raven',        weightClass: 'LIGHT'   },
  WLF:     { chassis: 'Wolfhound',    weightClass: 'LIGHT'   },

  ASN:     { chassis: 'Assassin',     weightClass: 'MEDIUM'  },
  CDA:     { chassis: 'Cicada',       weightClass: 'MEDIUM'  },
  WTH:     { chassis: 'Whitworth',    weightClass: 'MEDIUM'  },
  BJ:      { chassis: 'Blackjack',    weightClass: 'MEDIUM'  },
  PXH:     { chassis: 'Phoenix Hawk', weightClass: 'MEDIUM'  },
  VND:     { chassis: 'Vindicator',   weightClass: 'MEDIUM'  },
  CLNT:    { chassis: 'Clint',        weightClass: 'MEDIUM'  },
  CN9:     { chassis: 'Centurion',    weightClass: 'MEDIUM'  },
  ENF:     { chassis: 'Enforcer',     weightClass: 'MEDIUM'  },
  HBK:     { chassis: 'Hunchback',    weightClass: 'MEDIUM'  },
  TBT:     { chassis: 'Trebuchet',    weightClass: 'MEDIUM'  },
  DV:      { chassis: 'Dervish',      weightClass: 'MEDIUM'  },
  GRF:     { chassis: 'Griffin',      weightClass: 'MEDIUM'  },
  HCT:     { chassis: 'Hatchetman',   weightClass: 'MEDIUM'  },
  HER:     { chassis: 'Hermes II',    weightClass: 'MEDIUM'  },
  HOP:     { chassis: 'Hoplite',      weightClass: 'MEDIUM'  },
  SCP:     { chassis: 'Scorpion',     weightClass: 'MEDIUM'  },
  SHD:     { chassis: 'Shadow Hawk',  weightClass: 'MEDIUM'  },
  VL:      { chassis: 'Vulcan',       weightClass: 'MEDIUM'  },

  WVR:     { chassis: 'Wolverine',    weightClass: 'HEAVY'   },
  DRG:     { chassis: 'Dragon',       weightClass: 'HEAVY'   },
  OSR:     { chassis: 'Ostroc',       weightClass: 'HEAVY'   },
  OTL:     { chassis: 'Ostsol',       weightClass: 'HEAVY'   },
  QKD:     { chassis: 'Quickdraw',    weightClass: 'HEAVY'   },
  RFL:     { chassis: 'Rifleman',     weightClass: 'HEAVY'   },
  CPLT:    { chassis: 'Catapult',     weightClass: 'HEAVY'   },
  CRD:     { chassis: 'Crusader',     weightClass: 'HEAVY'   },
  JM6:     { chassis: 'JagerMech',    weightClass: 'HEAVY'   },
  TDR:     { chassis: 'Thunderbolt',  weightClass: 'HEAVY'   },
  ARC:     { chassis: 'Archer',       weightClass: 'HEAVY'   },
  GHR:     { chassis: 'Grasshopper',  weightClass: 'HEAVY'   },
  WHM:     { chassis: 'Warhammer',    weightClass: 'HEAVY'   },
  MAD:     { chassis: 'Marauder',     weightClass: 'HEAVY'   },
  ON1:     { chassis: 'Orion',        weightClass: 'HEAVY'   },

  AWS:     { chassis: 'Awesome',      weightClass: 'ASSAULT' },
  CGR:     { chassis: 'Charger',      weightClass: 'ASSAULT' },
  GOL:     { chassis: 'Goliath',      weightClass: 'ASSAULT' },
  VTR:     { chassis: 'Victor',       weightClass: 'ASSAULT' },
  ZEU:     { chassis: 'Zeus',         weightClass: 'ASSAULT' },
  BLR:     { chassis: 'BattleMaster', weightClass: 'ASSAULT' },
  SHG:     { chassis: 'Shogun',       weightClass: 'ASSAULT' },
  STK:     { chassis: 'Stalker',      weightClass: 'ASSAULT' },
  CP10:    { chassis: 'Cyclops',      weightClass: 'ASSAULT' },
  BNC:     { chassis: 'Banshee',      weightClass: 'ASSAULT' },
  ANH:     { chassis: 'Annihilator',  weightClass: 'ASSAULT' },
  AS7:     { chassis: 'Atlas',        weightClass: 'ASSAULT' },
  IMP:     { chassis: 'Imp',          weightClass: 'ASSAULT' },
  'MAD-4A': { chassis: 'Marauder II', weightClass: 'ASSAULT' },
};

function getMechPrefix(typeString: string): string {
  const hyphen = typeString.indexOf('-');
  return (hyphen > 0 ? typeString.slice(0, hyphen) : typeString).toUpperCase();
}

function getCanonicalMechCatalogEntry(typeString: string): CanonicalMechCatalogEntry | undefined {
  const key = typeString.toUpperCase();
  return CANONICAL_MECH_CATALOG[key] ?? CANONICAL_MECH_CATALOG[getMechPrefix(key)];
}

/** Return the canonical chassis name for a mech typeString, e.g. "JR7-1X" -> "Jenner". */
export function getMechChassis(typeString: string): string {
  const canonical = getCanonicalMechCatalogEntry(typeString);
  if (canonical) return canonical.chassis;

  const stat = MECH_STATS.get(typeString);
  if (stat && !stat.disabled) return stat.name;

  return getMechPrefix(typeString);
}

/** Classify a mech entry into one of the four weight classes. */
export function getMechWeightClass(mech: { typeString: string; tonnage?: number }): MechWeightClass | undefined {
  const canonical = getCanonicalMechCatalogEntry(mech.typeString);
  if (canonical) return canonical.weightClass;

  const stat = MECH_STATS.get(mech.typeString);
  if (stat) {
    return stat.weightClass.toUpperCase() as MechWeightClass;
  }

  const tons = mech.tonnage ?? 0;
  if (tons > 0 && tons <= 35) return 'LIGHT';
  if (tons >= 40 && tons <= 55) return 'MEDIUM';
  if (tons >= 60 && tons <= 75) return 'HEAVY';
  if (tons >= 80) return 'ASSAULT';
  return undefined;
}

/** Return sorted chassis names for the chosen weight-class index. */
export function getMechChassisListForClass(classIndex: number): string[] {
  const classKey = CLASS_KEYS[classIndex] as string | undefined;
  const seenChassis = new Set<string>();
  const chassisList: string[] = [];
  for (const mech of WORLD_MECHS) {
    if (classKey && getMechWeightClass(mech) !== classKey) continue;
    const chassis = getMechChassis(mech.typeString);
    if (!seenChassis.has(chassis)) {
      seenChassis.add(chassis);
      chassisList.push(chassis);
    }
  }
  chassisList.sort((a, b) => a.localeCompare(b));
  return chassisList;
}

const CLASS_REPRESENTATIVE_TYPES = [
  'LCT-1V',
  'HBK-4G',
  'MAD-3R',
  'AS7-D',
] as const;

/** Return one representative mech entry for the given weight class index. */
export function getRepresentativeMechForClass(classIndex: number) {
  const classKey = CLASS_KEYS[classIndex] as string | undefined;
  if (!classKey) return undefined;

  const preferredType = CLASS_REPRESENTATIVE_TYPES[classIndex];
  const preferred = preferredType
    ? WORLD_MECHS.find(mech => mech.typeString === preferredType)
    : undefined;
  if (preferred) return preferred;

  return WORLD_MECHS.find(mech => getMechWeightClass(mech) === classKey);
}

/** Return one representative mech entry for the given chassis name. */
export function getRepresentativeMechForChassis(chassis: string) {
  return WORLD_MECHS.find(mech => getMechChassis(mech.typeString) === chassis);
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
