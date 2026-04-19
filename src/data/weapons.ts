/**
 * Retail weapon-family data recovered from `.MEC` weapon type IDs plus BT-MAN.
 *
 * The documented roster constrains the v1.23 `.MEC` ids 1..16 to the standard
 * 3025 weapon families below. Combat stat handling should prefer these runtime
 * ids over `MECH_STATS.armament`, because many variants still lack full BT-MAN
 * armament text even though their `.MEC` weapon ids are present.
 */

export interface WeaponSpec {
  typeId: number;
  name: string;
  damage?: number;
  cooldownMs?: number;
  maxRangeMeters?: number;
}

const WEAPON_SPECS: readonly WeaponSpec[] = [
  // Type id 0 is strongly constrained to the flamer family by the roster fit on
  // FS9-H / FLE-4 / WSP-1D and related variants. BT-MAN gives its delay/range,
  // and MPBTWIN.EXE.c helper FUN_0043b3f0 embeds a 17-entry damage-potential
  // table where the non-missile families match direct per-shot damage while the
  // missile rows track average cluster damage. That lifts flamer to direct
  // damage=3 without forcing a broader missile damage reinterpretation here.
  { typeId: 0, name: 'Flamer', damage: 3, cooldownMs: 3_000, maxRangeMeters: 90 },
  { typeId: 1, name: 'Machine Gun', damage: 2, cooldownMs: 0, maxRangeMeters: 90 },
  { typeId: 2, name: 'Small Laser', damage: 3, cooldownMs: 1_000, maxRangeMeters: 90 },
  { typeId: 3, name: 'Medium Laser', damage: 5, cooldownMs: 3_000, maxRangeMeters: 270 },
  { typeId: 4, name: 'Large Laser', damage: 8, cooldownMs: 8_000, maxRangeMeters: 450 },
  { typeId: 5, name: 'Particle Projector Cannon', damage: 10, cooldownMs: 10_000, maxRangeMeters: 540 },
  { typeId: 6, name: 'Autocannon/2', damage: 2, cooldownMs: 1_000, maxRangeMeters: 720 },
  { typeId: 7, name: 'Autocannon/5', damage: 5, cooldownMs: 1_000, maxRangeMeters: 540 },
  { typeId: 8, name: 'Autocannon/10', damage: 10, cooldownMs: 3_000, maxRangeMeters: 450 },
  { typeId: 9, name: 'Autocannon/20', damage: 20, cooldownMs: 7_000, maxRangeMeters: 270 },
  { typeId: 10, name: 'SRM-2', damage: 4, cooldownMs: 2_000, maxRangeMeters: 270 },
  { typeId: 11, name: 'SRM-4', damage: 8, cooldownMs: 3_000, maxRangeMeters: 270 },
  { typeId: 12, name: 'SRM-6', damage: 12, cooldownMs: 4_000, maxRangeMeters: 270 },
  { typeId: 13, name: 'LRM-5', damage: 5, cooldownMs: 2_000, maxRangeMeters: 630 },
  { typeId: 14, name: 'LRM-10', damage: 10, cooldownMs: 4_000, maxRangeMeters: 630 },
  { typeId: 15, name: 'LRM-15', damage: 15, cooldownMs: 5_000, maxRangeMeters: 630 },
  { typeId: 16, name: 'LRM-20', damage: 20, cooldownMs: 6_000, maxRangeMeters: 630 },
] as const;

const WEAPON_SPEC_BY_TYPE_ID = new Map<number, WeaponSpec>(
  WEAPON_SPECS.map(spec => [spec.typeId, spec]),
);

const WEAPON_SPEC_BY_NAME = new Map<string, WeaponSpec>(
  WEAPON_SPECS.map(spec => [spec.name, spec]),
);

export function getWeaponSpecByTypeId(typeId: number | undefined): WeaponSpec | undefined {
  return typeId === undefined ? undefined : WEAPON_SPEC_BY_TYPE_ID.get(typeId);
}

export function getWeaponSpecByName(name: string | undefined): WeaponSpec | undefined {
  return name === undefined ? undefined : WEAPON_SPEC_BY_NAME.get(name);
}

export function getWeaponNameByTypeId(typeId: number | undefined): string | undefined {
  return getWeaponSpecByTypeId(typeId)?.name;
}
