#!/usr/bin/env node

import { loadMechs } from '../src/data/mechs.js';
import {
  getWeaponLongRangeMeters,
  getWeaponSpecByTypeId,
  type WeaponSpec,
} from '../src/data/weapons.js';

function mechKph(speedMag: number): number {
  return Math.round((speedMag * 16.2 / 450) * 10) / 10;
}

function kphToMetersPerSecond(speedKph: number): number {
  return speedKph / 3.6;
}

function parseArgs(argv: string[]): {
  attacker: string;
  defender: string;
  startDistanceMeters: number;
} {
  const positional: string[] = [];
  let startDistanceMeters = 1_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--start' && i + 1 < argv.length) {
      startDistanceMeters = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  return {
    attacker: positional[0] ?? 'BJ-1',
    defender: positional[1] ?? positional[0] ?? 'BJ-1',
    startDistanceMeters,
  };
}

function uniqueWeaponSpecs(typeIds: readonly number[]): WeaponSpec[] {
  const seen = new Set<number>();
  const specs: WeaponSpec[] = [];
  for (const typeId of typeIds) {
    if (seen.has(typeId)) continue;
    seen.add(typeId);
    const spec = getWeaponSpecByTypeId(typeId);
    if (spec) specs.push(spec);
  }
  return specs.sort((a, b) => {
    const aLong = getWeaponLongRangeMeters(a) ?? 0;
    const bLong = getWeaponLongRangeMeters(b) ?? 0;
    return bLong - aLong || a.name.localeCompare(b.name);
  });
}

function formatMeters(value: number | undefined): string {
  return value === undefined ? '-' : `${value}m`;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return 'never';
  if (value <= 0) return 'now';
  return `${value.toFixed(1)}s`;
}

function timeToReachBand(
  startDistanceMeters: number,
  bandDistanceMeters: number | undefined,
  closingSpeedMetersPerSecond: number,
): number {
  if (bandDistanceMeters === undefined) return Number.POSITIVE_INFINITY;
  if (startDistanceMeters <= bandDistanceMeters) return 0;
  if (closingSpeedMetersPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return (startDistanceMeters - bandDistanceMeters) / closingSpeedMetersPerSecond;
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isFinite(args.startDistanceMeters) || args.startDistanceMeters <= 0) {
  console.error(`[forward-range-physics] Invalid --start distance: ${args.startDistanceMeters}`);
  process.exit(1);
}

const mechs = loadMechs();
const attacker = mechs.find(mech => mech.typeString === args.attacker);
const defender = mechs.find(mech => mech.typeString === args.defender);

if (!attacker || !defender) {
  console.error(
    `[forward-range-physics] Unknown mech designation: attacker=${args.attacker} defender=${args.defender}`,
  );
  process.exit(1);
}

const attackerRunKph = mechKph(attacker.maxSpeedMag);
const attackerWalkKph = mechKph(attacker.walkSpeedMag);
const defenderRunKph = mechKph(defender.maxSpeedMag);
const defenderWalkKph = mechKph(defender.walkSpeedMag);

const scenarios = [
  {
    name: 'forward vs static',
    closingSpeedMetersPerSecond: kphToMetersPerSecond(attackerRunKph),
  },
  {
    name: 'forward vs full reverse',
    // Current server cmd9 echo path allows signed speed magnitude up to ±maxSpeedMag.
    closingSpeedMetersPerSecond: Math.max(0, kphToMetersPerSecond(attackerRunKph - defenderRunKph)),
  },
  {
    name: 'forward vs walk reverse',
    // Reference case: if reverse were capped near walk speed, forward pressure wins.
    closingSpeedMetersPerSecond: Math.max(0, kphToMetersPerSecond(attackerRunKph - defenderWalkKph)),
  },
] as const;

console.log(`[forward-range-physics] attacker=${attacker.typeString} defender=${defender.typeString}`);
console.log(
  `[forward-range-physics] start=${args.startDistanceMeters}m attacker walk/run=${attackerWalkKph}/${attackerRunKph}kph defender walk/run=${defenderWalkKph}/${defenderRunKph}kph`,
);
for (const scenario of scenarios) {
  console.log(
    `[forward-range-physics] scenario="${scenario.name}" closeRate=${scenario.closingSpeedMetersPerSecond.toFixed(2)}m/s`,
  );
}

console.log('');
console.log('Weapon bands from attacker loadout:');
for (const spec of uniqueWeaponSpecs(attacker.weaponTypeIds)) {
  const times = scenarios.map(scenario => {
    const longTime = timeToReachBand(
      args.startDistanceMeters,
      getWeaponLongRangeMeters(spec),
      scenario.closingSpeedMetersPerSecond,
    );
    const mediumTime = timeToReachBand(
      args.startDistanceMeters,
      spec.mediumRangeMeters,
      scenario.closingSpeedMetersPerSecond,
    );
    const shortTime = timeToReachBand(
      args.startDistanceMeters,
      spec.shortRangeMeters,
      scenario.closingSpeedMetersPerSecond,
    );
    return `${scenario.name}: L=${formatSeconds(longTime)} M=${formatSeconds(mediumTime)} S=${formatSeconds(shortTime)}`;
  });
  console.log(
    `- ${spec.name.padEnd(26)} bands=${formatMeters(spec.shortRangeMeters)}/${formatMeters(spec.mediumRangeMeters)}/${formatMeters(getWeaponLongRangeMeters(spec))} | ${times.join(' | ')}`,
  );
}
