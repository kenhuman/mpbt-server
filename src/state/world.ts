/**
 * World state — rooms and connections between them.
 *
 * This is still a stub, but it now uses locations and concepts grounded in the
 * BT-MAN manual instead of a fictional starport.
 *
 * The real game starts players in the International Sector tutorial area and
 * routes them toward tram travel, bars, ComStar facilities, arena entrances,
 * and ready rooms. The actual room graph and protocol are still unknown, so
 * this is a semantic placeholder for future RE work.
 */

export interface Exit {
  direction: 'north' | 'south' | 'east' | 'west';
  description: string;
  targetRoomId: string;
}

export type RoomKind =
  | 'street'
  | 'bar'
  | 'comstar'
  | 'tram'
  | 'arena_foyer'
  | 'ready_room';

export interface Room {
  id: string;
  kind: RoomKind;
  sector: string;
  district: string;
  name: string;
  description: string;
  exits: Exit[];
  /** Session IDs of players currently in this room. */
  players: string[];
}

export class World {
  private rooms = new Map<string, Room>();

  constructor() {
    this.buildStarterWorld();
  }

  private buildStarterWorld(): void {
    // International Sector tutorial plaza — the manual's starting concept.
    this.addRoom({
      id: 'international_sector_plaza',
      kind: 'street',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'International Sector Plaza',
      description:
        'A broad plaza where new MechWarriors get their bearings before heading to the tram, the bar, or the nearby arenas.',
      exits: [
        {
          direction: 'north',
          description: 'the arena concourse',
          targetRoomId: 'arena_concourse',
        },
        {
          direction: 'south',
          description: 'the tram platform',
          targetRoomId: 'tram_platform',
        },
        {
          direction: 'east',
          description: 'a public bar',
          targetRoomId: 'public_bar',
        },
        {
          direction: 'west',
          description: 'a ComStar facility',
          targetRoomId: 'comstar_facility',
        },
      ],
      players: [],
    });

    // A nearby arena entrance and foyer.
    this.addRoom({
      id: 'arena_concourse',
      kind: 'arena_foyer',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'Arena Concourse',
      description:
        'Arena signage and district emblems line the walls. This is where duelists head before entering a ready room.',
      exits: [
        {
          direction: 'south',
          description: 'the plaza',
          targetRoomId: 'international_sector_plaza',
        },
        {
          direction: 'north',
          description: 'the arena ready room',
          targetRoomId: 'arena_ready_room',
        },
      ],
      players: [],
    });

    // Ready room semantics come directly from the manual.
    this.addRoom({
      id: 'arena_ready_room',
      kind: 'ready_room',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'Arena Ready Room',
      description:
        'A preparation room where duelists choose a mech, pick a side, check status, and declare readiness before battle.',
      exits: [
        {
          direction: 'south',
          description: 'the arena concourse',
          targetRoomId: 'arena_concourse',
        },
      ],
      players: [],
    });

    this.addRoom({
      id: 'public_bar',
      kind: 'bar',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'Public Bar',
      description:
        'A crowded Solaris bar with booths, chatter, and a terminal for rankings and ComStar traffic.',
      exits: [
        {
          direction: 'west',
          description: 'the plaza',
          targetRoomId: 'international_sector_plaza',
        },
      ],
      players: [],
    });

    this.addRoom({
      id: 'comstar_facility',
      kind: 'comstar',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'ComStar Facility',
      description:
        'A quiet office where MechWarriors can handle private messages and other terminal-style services.',
      exits: [
        {
          direction: 'east',
          description: 'the plaza',
          targetRoomId: 'international_sector_plaza',
        },
      ],
      players: [],
    });

    this.addRoom({
      id: 'tram_platform',
      kind: 'tram',
      sector: 'International Sector',
      district: 'Tutorial District',
      name: 'Tram Platform',
      description:
        'A monorail platform connecting the districts of Solaris City. The manual describes this as the only way to reach arena districts.',
      exits: [
        {
          direction: 'north',
          description: 'the plaza',
          targetRoomId: 'international_sector_plaza',
        },
      ],
      players: [],
    });
  }

  private addRoom(room: Room): void {
    this.rooms.set(room.id, room);
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  get startRoomId(): string {
    return 'international_sector_plaza';
  }

  movePlayer(sessionId: string, fromRoomId: string, toRoomId: string): boolean {
    const from = this.rooms.get(fromRoomId);
    const to = this.rooms.get(toRoomId);
    if (!from || !to) return false;

    from.players = from.players.filter(id => id !== sessionId);
    to.players.push(sessionId);
    return true;
  }

  addPlayerToRoom(sessionId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && !room.players.includes(sessionId)) {
      room.players.push(sessionId);
    }
  }

  removePlayerFromRoom(sessionId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.players = room.players.filter(id => id !== sessionId);
    }
  }
}
