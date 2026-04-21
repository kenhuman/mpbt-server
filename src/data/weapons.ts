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
  heat?: number;
  cooldownMs?: number;
  shortRangeMeters?: number;
  mediumRangeMeters?: number;
  longRangeMeters?: number;
  maxRangeMeters?: number;
}

export type WeaponRangeBand = 'short' | 'medium' | 'long' | 'out-of-range';

// Range bands follow the tabletop S/M/L weapon table reflected in
// screenshots\weapon-ranges.png. Families omitted from that screenshot retain the
// same standard tabletop S/M/L values used across their weapon line (for example
// SRM-2/4/6 -> 90/180/270m and LRM-5/10/15/20 -> 210/420/630m). These are band
// caps only, not a minimum-fire gate: point-blank overlap shots stay legal.
const WEAPON_SPECS: readonly WeaponSpec[] = [
  // Type id 0 is strongly constrained to the flamer family by the roster fit on
  // FS9-H / FLE-4 / WSP-1D and related variants. BT-MAN gives its delay/range,
  // and MPBTWIN.EXE.c helper FUN_0043b3f0 embeds a 17-entry damage-potential
  // table where the non-missile families match direct per-shot damage while the
  // missile rows track average cluster damage. That lifts flamer to direct
  // damage=3 without forcing a broader missile damage reinterpretation here.
  // Flamers share the same S/M/L band caps as Machine Guns in retail play.
  { typeId: 0, name: 'Flamer', damage: 3, heat: 3, cooldownMs: 3_000, shortRangeMeters: 30, mediumRangeMeters: 60, longRangeMeters: 90, maxRangeMeters: 90 },
  { typeId: 1, name: 'Machine Gun', damage: 2, heat: 0, cooldownMs: 0, shortRangeMeters: 30, mediumRangeMeters: 60, longRangeMeters: 90, maxRangeMeters: 90 },
  { typeId: 2, name: 'Small Laser', damage: 3, heat: 1, cooldownMs: 1_000, shortRangeMeters: 30, mediumRangeMeters: 60, longRangeMeters: 90, maxRangeMeters: 90 },
  { typeId: 3, name: 'Medium Laser', damage: 5, heat: 3, cooldownMs: 3_000, shortRangeMeters: 90, mediumRangeMeters: 180, longRangeMeters: 270, maxRangeMeters: 270 },
  { typeId: 4, name: 'Large Laser', damage: 8, heat: 8, cooldownMs: 8_000, shortRangeMeters: 150, mediumRangeMeters: 300, longRangeMeters: 450, maxRangeMeters: 450 },
  { typeId: 5, name: 'Particle Projector Cannon', damage: 10, heat: 10, cooldownMs: 10_000, shortRangeMeters: 180, mediumRangeMeters: 360, longRangeMeters: 540, maxRangeMeters: 540 },
  { typeId: 6, name: 'Autocannon/2', damage: 2, heat: 1, cooldownMs: 1_000, shortRangeMeters: 240, mediumRangeMeters: 480, longRangeMeters: 720, maxRangeMeters: 720 },
  { typeId: 7, name: 'Autocannon/5', damage: 5, heat: 1, cooldownMs: 1_000, shortRangeMeters: 180, mediumRangeMeters: 360, longRangeMeters: 540, maxRangeMeters: 540 },
  { typeId: 8, name: 'Autocannon/10', damage: 10, heat: 3, cooldownMs: 3_000, shortRangeMeters: 120, mediumRangeMeters: 240, longRangeMeters: 360, maxRangeMeters: 360 },
  { typeId: 9, name: 'Autocannon/20', damage: 20, heat: 7, cooldownMs: 7_000, shortRangeMeters: 90, mediumRangeMeters: 180, longRangeMeters: 270, maxRangeMeters: 270 },
  { typeId: 10, name: 'SRM-2', damage: 4, heat: 2, cooldownMs: 2_000, shortRangeMeters: 90, mediumRangeMeters: 180, longRangeMeters: 270, maxRangeMeters: 270 },
  { typeId: 11, name: 'SRM-4', damage: 8, heat: 3, cooldownMs: 3_000, shortRangeMeters: 90, mediumRangeMeters: 180, longRangeMeters: 270, maxRangeMeters: 270 },
  { typeId: 12, name: 'SRM-6', damage: 12, heat: 4, cooldownMs: 4_000, shortRangeMeters: 90, mediumRangeMeters: 180, longRangeMeters: 270, maxRangeMeters: 270 },
  { typeId: 13, name: 'LRM-5', damage: 5, heat: 2, cooldownMs: 2_000, shortRangeMeters: 210, mediumRangeMeters: 420, longRangeMeters: 630, maxRangeMeters: 630 },
  { typeId: 14, name: 'LRM-10', damage: 10, heat: 4, cooldownMs: 4_000, shortRangeMeters: 210, mediumRangeMeters: 420, longRangeMeters: 630, maxRangeMeters: 630 },
  { typeId: 15, name: 'LRM-15', damage: 15, heat: 5, cooldownMs: 5_000, shortRangeMeters: 210, mediumRangeMeters: 420, longRangeMeters: 630, maxRangeMeters: 630 },
  { typeId: 16, name: 'LRM-20', damage: 20, heat: 6, cooldownMs: 6_000, shortRangeMeters: 210, mediumRangeMeters: 420, longRangeMeters: 630, maxRangeMeters: 630 },
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

export function getWeaponLongRangeMeters(spec: WeaponSpec | undefined): number | undefined {
  return spec?.longRangeMeters ?? spec?.maxRangeMeters;
}

export function getWeaponRangeBandForDistance(
  spec: WeaponSpec | undefined,
  distanceMeters: number | undefined,
): WeaponRangeBand | undefined {
  if (spec === undefined || distanceMeters === undefined) {
    return undefined;
  }

  const longRangeMeters = getWeaponLongRangeMeters(spec);
  if (longRangeMeters === undefined) {
    return undefined;
  }
  if (spec.shortRangeMeters !== undefined && distanceMeters <= spec.shortRangeMeters) {
    return 'short';
  }
  if (spec.mediumRangeMeters !== undefined && distanceMeters <= spec.mediumRangeMeters) {
    return 'medium';
  }
  return distanceMeters <= longRangeMeters ? 'long' : 'out-of-range';
}
