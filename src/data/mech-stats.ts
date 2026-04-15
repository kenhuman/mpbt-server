/**
 * BattleMech stat table — game-mechanical data from BT-MAN.
 *
 * Source: BT-MAN.decrypted.txt (official game manual), mech stat tables,
 * pages 40–52.  73 mechs have full documented stats; 4 have partial stats
 * (incomplete BT-MAN extraction); 84 are listed as disabled until their
 * stats are recovered from .MEC file RE (milestone M2+).
 *
 * This file is SEPARATE from src/data/mechs.ts, which handles .MEC-derived
 * protocol IDs.  This file is safe to commit — no proprietary content.
 *
 * Effective range bands (from BT-MAN):
 *   S = within  90 m
 *   M = within 270 m  (includes "between X and 270 m")
 *   L = within 720 m  (450 m / 540 m / 630 m annotations in manual)
 *
 * Armor classes as printed in BT-MAN (light < medium < heavy < assault).
 * These describe relative protection, not chassis weight.
 *
 * When disabled = true: stats are unknown; all numeric fields are null.
 * When disabled = false with null fields: data is partially documented.
 */

import type { MechEntry } from '../protocol/game.js';

export type WeightClass   = 'light' | 'medium' | 'heavy' | 'assault';
export type ArmorClass    = 'light' | 'medium' | 'heavy' | 'assault';
export type EffectiveRange = 'S' | 'M' | 'L';

export interface MechStats {
  /** Variant designation — matches .MEC filename without extension, uppercase. */
  designation: string;
  /** Full chassis name.  Empty string when not documented. */
  name: string;
  weightClass: WeightClass;
  tonnage: number | null;
  maxSpeedKph: number | null;
  armor: ArmorClass | null;
  /** Maximum jump distance in meters; null = no jump jets or unknown. */
  jumpMeters: number | null;
  /** Weapon loadout as listed in BT-MAN.  Empty array when unknown. */
  armament: string[];
  effectiveRange: EffectiveRange | null;
  /**
   * true  → stats unknown; fill from .MEC RE (M2+).
   * false → at least partial stats are available.
   */
  disabled: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a fully-documented entry. */
function known(
  designation: string,
  name: string,
  weightClass: WeightClass,
  tonnage: number,
  maxSpeedKph: number,
  armor: ArmorClass,
  jumpMeters: number | null,
  armament: string[],
  effectiveRange: EffectiveRange,
): MechStats {
  return { designation, name, weightClass, tonnage, maxSpeedKph, armor,
           jumpMeters, armament, effectiveRange, disabled: false };
}

/** Build a stub for a mech whose stats are not yet documented. */
function stub(designation: string, weightClass: WeightClass): MechStats {
  return { designation, name: '', weightClass, tonnage: null,
           maxSpeedKph: null, armor: null, jumpMeters: null,
           armament: [], effectiveRange: null, disabled: true };
}

// ─── stat table ──────────────────────────────────────────────────────────────
// Ordered alphabetically by designation to match mechdata/ directory listing.
// All 161 .MEC files are represented.

const ENTRIES: MechStats[] = [

  // ── ANH ──────────────────────────────────────────────────────────────────
  stub('ANH-1A',    'assault'),   // Annihilator — not in BT-MAN

  // ── ARC ──────────────────────────────────────────────────────────────────
  stub('ARC-2K',    'heavy'),     // Archer — not in BT-MAN
  stub('ARC-2R',    'heavy'),
  stub('ARC-2S',    'heavy'),
  stub('ARC-2W',    'heavy'),

  // ── AS7 ──────────────────────────────────────────────────────────────────
  known('AS7-D', 'Atlas', 'assault', 100, 54, 'assault', null,
        ['Autocannon/20', 'LRM-20', 'SRM-6', 'Medium Laser', 'Medium Laser',
         'Medium Laser', 'Medium Laser'],
        'M'),
  stub('AS7-S',     'assault'),

  // ── ASN ──────────────────────────────────────────────────────────────────
  stub('ASN-101',   'medium'),    // Assassin — not in BT-MAN
  stub('ASN-21',    'medium'),

  // ── AWS ──────────────────────────────────────────────────────────────────
  stub('AWS-8Q',    'assault'),   // Awesome — not in BT-MAN
  known('AWS-8R', 'Awesome', 'assault', 80, 54, 'assault', null,
        ['LRM-15', 'LRM-15', 'Large Laser', 'Small Laser'],
        'L'),
  known('AWS-8T', 'Awesome', 'assault', 80, 54, 'assault', null,
        ['LRM-15', 'LRM-15', 'Large Laser', 'Large Laser', 'Small Laser'],
        'L'),
  known('AWS-8V', 'Awesome', 'assault', 80, 54, 'assault', null,
        ['Particle Projector Cannon', 'Large Laser', 'LRM-15', 'Small Laser'],
        'L'),

  // ── BJ ───────────────────────────────────────────────────────────────────
  known('BJ-1', 'Blackjack', 'medium', 45, 64.8, 'medium', 120,
        ['Autocannon/2', 'Autocannon/2', 'Medium Laser', 'Medium Laser',
         'Medium Laser', 'Medium Laser'],
        'M'),
  stub('BJ-1DB',    'medium'),
  stub('BJ-1DC',    'medium'),

  // ── BLR ──────────────────────────────────────────────────────────────────
  known('BLR-1D', 'Battlemaster', 'assault', 85, 64.8, 'assault', null,
        ['Particle Projector Cannon', 'Medium Laser', 'Medium Laser',
         'Medium Laser', 'Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),
  stub('BLR-1G',    'assault'),

  // ── BNC ──────────────────────────────────────────────────────────────────
  stub('BNC-3E',    'assault'),   // Banshee — not in BT-MAN
  known('BNC-3M', 'Banshee', 'assault', 95, 64.8, 'assault', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'Medium Laser', 'Medium Laser'],
        'M'),
  known('BNC-3Q', 'Banshee', 'assault', 95, 64.8, 'assault', null,
        ['Autocannon/20', 'Small Laser'],
        'M'),
  known('BNC-3S', 'Banshee', 'assault', 95, 54, 'assault', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'Autocannon/10', 'SRM-6',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser',
         'Small Laser', 'Small Laser'],
        'M'),

  // ── CDA ──────────────────────────────────────────────────────────────────
  stub('CDA-2A',    'medium'),    // Cicada — not in BT-MAN
  stub('CDA-2B',    'medium'),

  // ── CGR ──────────────────────────────────────────────────────────────────
  known('CGR-1A1', 'Charger', 'assault', 80, 86.4, 'medium', null,
        ['Small Laser', 'Small Laser', 'Small Laser', 'Small Laser', 'Small Laser'],
        'S'),
  stub('CGR-1L',    'assault'),

  // ── CLNT ─────────────────────────────────────────────────────────────────
  stub('CLNT-1-2',  'medium'),    // Clint — not in BT-MAN
  stub('CLNT-1-4',  'medium'),

  // ── CN9 ──────────────────────────────────────────────────────────────────
  known('CN9-A', 'Centurion', 'medium', 50, 64.8, 'medium', null,
        ['Autocannon/10', 'LRM-10', 'Medium Laser', 'Medium Laser'],
        'M'),
  known('CN9-AH', 'Centurion', 'medium', 50, 64.8, 'medium', null,
        ['LRM-10', 'Autocannon/20'],
        'M'),
  stub('CN9-AL',    'medium'),

  // ── COM ──────────────────────────────────────────────────────────────────
  known('COM-2D', 'Commando', 'light', 25, 97.2, 'light', null,
        ['SRM-6', 'SRM-4', 'Medium Laser'],
        'M'),
  stub('COM-3A',    'light'),

  // ── CP10 ─────────────────────────────────────────────────────────────────
  stub('CP10-HQ',   'assault'),   // Cyclops — not in BT-MAN
  known('CP10-Q', 'Cyclops', 'assault', 90, 64.8, 'assault', null,
        ['LRM-10', 'LRM-10', 'Medium Laser', 'Medium Laser', 'Medium Laser', 'SRM-4'],
        'L'),
  known('CP10-Z', 'Cyclops', 'assault', 90, 64.8, 'medium', null,
        ['Autocannon/20', 'LRM-10', 'SRM-4', 'Medium Laser', 'Medium Laser'],
        'M'),

  // ── CPLT ─────────────────────────────────────────────────────────────────
  // BT-MAN typo: "CLPT-C1" — canonical is CPLT-C1.
  known('CPLT-C1', 'Catapult', 'heavy', 65, 64.8, 'medium', 120,
        ['LRM-15', 'LRM-15',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'L'),
  // BT-MAN armor field printed as "armor" (typo) — interpreted as 'medium'.
  known('CPLT-C4', 'Catapult', 'heavy', 65, 64.8, 'medium', 120,
        ['LRM-20', 'LRM-20', 'Small Laser', 'Small Laser'],
        'L'),
  known('CPLT-K2', 'Catapult', 'heavy', 65, 64.8, 'heavy', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'Medium Laser', 'Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),

  // ── CRD ──────────────────────────────────────────────────────────────────
  known('CRD-3D', 'Crusader', 'heavy', 65, 64.8, 'heavy', null,
        ['LRM-15', 'LRM-15', 'SRM-4', 'SRM-4', 'Medium Laser', 'Medium Laser'],
        'L'),
  stub('CRD-3K',    'heavy'),
  known('CRD-3L', 'Crusader', 'heavy', 65, 64.8, 'heavy', 120,
        ['LRM-10', 'LRM-10', 'SRM-4', 'SRM-4',
         'Medium Laser', 'Medium Laser', 'Machine Gun', 'Machine Gun'],
        'L'),
  known('CRD-3R', 'Crusader', 'heavy', 65, 64.8, 'heavy', null,
        ['LRM-15', 'LRM-15', 'SRM-6', 'SRM-6',
         'Medium Laser', 'Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),
  stub('CRD-4D',    'heavy'),
  known('CRD-4K', 'Crusader', 'heavy', 65, 64.8, 'heavy', null,
        ['LRM-10', 'LRM-10', 'SRM-6', 'SRM-6', 'Medium Laser', 'Medium Laser'],
        'L'),

  // ── DRG ──────────────────────────────────────────────────────────────────
  stub('DRG-1C',    'heavy'),     // Dragon — not in BT-MAN
  known('DRG-1N', 'Dragon', 'heavy', 60, 86.4, 'medium', null,
        ['LRM-10', 'Autocannon/5', 'Medium Laser', 'Medium Laser'],
        'L'),

  // ── DV ───────────────────────────────────────────────────────────────────
  known('DV-6M', 'Dervish', 'medium', 55, 86.4, 'medium', 150,
        ['LRM-10', 'LRM-10', 'Medium Laser', 'Medium Laser', 'SRM-2', 'SRM-2'],
        'L'),

  // ── ENF ──────────────────────────────────────────────────────────────────
  known('ENF-4R', 'Enforcer', 'medium', 50, 64.8, 'medium', 120,
        ['Autocannon/10', 'Large Laser'],
        'L'),

  // ── FFL ──────────────────────────────────────────────────────────────────
  stub('FFL-4A',    'light'),     // not in BT-MAN

  // ── FLC ──────────────────────────────────────────────────────────────────
  stub('FLC-4N',    'light'),     // not in BT-MAN

  // ── FLE ──────────────────────────────────────────────────────────────────
  stub('FLE-15',    'light'),     // not in BT-MAN
  stub('FLE-4',     'light'),

  // ── FS9 ──────────────────────────────────────────────────────────────────
  stub('FS9-H',     'light'),     // Firestarter — not in BT-MAN
  stub('FS9-M',     'light'),

  // ── GHR ──────────────────────────────────────────────────────────────────
  known('GHR-5H', 'Grasshopper', 'heavy', 70, 64.8, 'heavy', 120,
        ['Large Laser', 'LRM-5',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'L'),

  // ── GOL ──────────────────────────────────────────────────────────────────
  stub('GOL-1H',    'heavy'),     // Goliath — not in BT-MAN

  // ── GRF ──────────────────────────────────────────────────────────────────
  stub('GRF-1DS',   'medium'),    // Griffin variant — not in BT-MAN
  known('GRF-1N', 'Griffin', 'medium', 55, 86.4, 'medium', 150,
        ['Particle Projector Cannon', 'LRM-10'],
        'L'),
  known('GRF-1S', 'Griffin', 'medium', 55, 86.4, 'medium', 150,
        ['LRM-5', 'Large Laser', 'Medium Laser', 'Medium Laser'],
        'L'),

  // ── HBK ──────────────────────────────────────────────────────────────────
  known('HBK-4G', 'Hunchback', 'medium', 50, 64.8, 'medium', null,
        ['Autocannon/20', 'Medium Laser', 'Medium Laser', 'Small Laser'],
        'M'),
  known('HBK-4H', 'Hunchback', 'medium', 50, 64.8, 'medium', null,
        ['Autocannon/10', 'Medium Laser', 'Medium Laser',
         'Medium Laser', 'Medium Laser', 'Small Laser'],
        'M'),
  known('HBK-4J', 'Hunchback', 'medium', 50, 64.8, 'medium', null,
        ['LRM-10', 'LRM-10',
         'Medium Laser', 'Medium Laser', 'Medium Laser',
         'Medium Laser', 'Medium Laser', 'Small Laser'],
        'L'),
  known('HBK-4N', 'Hunchback', 'medium', 50, 64.8, 'medium', null,
        ['LRM-5', 'LRM-5', 'Autocannon/5',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser',
         'Small Laser'],
        'L'),
  stub('HBK-4P',    'medium'),    // Hunchback variant — not in BT-MAN
  known('HBK-4SP', 'Hunchback', 'medium', 50, 64.8, 'medium', null,
        ['SRM-6', 'SRM-6',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser',
         'Small Laser'],
        'S'),

  // ── HCT ──────────────────────────────────────────────────────────────────
  stub('HCT-3F',    'light'),     // Hatchetman — not in BT-MAN
  stub('HCT-NH',    'light'),

  // ── HER ──────────────────────────────────────────────────────────────────
  stub('HER-2M',    'heavy'),     // Hermes II — not in BT-MAN
  stub('HER-2S',    'heavy'),

  // ── HNT ──────────────────────────────────────────────────────────────────
  stub('HNT-151',   'medium'),    // Huntsman — not in BT-MAN

  // ── HOP ──────────────────────────────────────────────────────────────────
  stub('HOP-4C',    'medium'),    // Hopper — not in BT-MAN

  // ── IMP ──────────────────────────────────────────────────────────────────
  stub('IMP-2E',    'assault'),   // Imp — not in BT-MAN

  // ── JM6 ──────────────────────────────────────────────────────────────────
  known('JM6-A', 'JagerMech', 'heavy', 65, 64.8, 'medium', null,
        ['Autocannon/2', 'Autocannon/2', 'LRM-15', 'LRM-15',
         'Medium Laser', 'Medium Laser'],
        'L'),
  known('JM6-S', 'JagerMech', 'heavy', 65, 64.8, 'light', null,
        ['Autocannon/2', 'Autocannon/2', 'Autocannon/5', 'Autocannon/5',
         'Medium Laser', 'Medium Laser'],
        'M'),

  // ── JR7 ──────────────────────────────────────────────────────────────────
  known('JR7-D', 'Jenner', 'light', 35, 118.8, 'light', 150,
        ['SRM-4', 'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'M'),
  stub('JR7-F',     'light'),     // Jenner variant — not in BT-MAN

  // ── JVN ──────────────────────────────────────────────────────────────────
  known('JVN-10F', 'Javelin', 'light', 30, 97.2, 'light', 180,
        ['Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'M'),
  known('JVN-10N', 'Javelin', 'light', 30, 97.2, 'light', 180,
        ['SRM-6', 'SRM-6'],
        'M'),

  // ── LCT ──────────────────────────────────────────────────────────────────
  stub('LCT-1E',    'light'),     // Locust variant — not in BT-MAN
  stub('LCT-1L',    'light'),
  known('LCT-1M', 'Locust', 'light', 20, 129.6, 'light', null,
        ['LRM-5', 'LRM-5', 'Medium Laser'],
        'M'),
  known('LCT-1S', 'Locust', 'light', 20, 129.6, 'light', null,
        ['SRM-2', 'SRM-2', 'Medium Laser'],
        'M'),
  known('LCT-1V', 'Locust', 'light', 20, 129.6, 'light', null,
        ['Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),

  // ── MAD ──────────────────────────────────────────────────────────────────
  stub('MAD-3D',    'assault'),   // Marauder — not in BT-MAN
  stub('MAD-3L',    'assault'),
  stub('MAD-3M',    'assault'),
  stub('MAD-3R',    'assault'),
  stub('MAD-4A',    'assault'),

  // ── ON1 ──────────────────────────────────────────────────────────────────
  // data incomplete — tonnage/speed missing from BT-MAN extraction; cross-reference .MEC RE
  {
    designation: 'ON1-K', name: 'Orion', weightClass: 'heavy',
    tonnage: null, maxSpeedKph: null, armor: null, jumpMeters: null,
    armament: ['LRM-15', 'Autocannon/10', 'SRM-4', 'Medium Laser', 'Medium Laser'],
    effectiveRange: 'L', disabled: false,
  },
  known('ON1-V', 'Orion', 'heavy', 75, 64.8, 'heavy', null,
        ['Autocannon/10', 'LRM-15', 'Medium Laser', 'Medium Laser', 'SRM-4', 'SRM-4'],
        'L'),
  known('ON1-VA', 'Orion', 'heavy', 75, 64.8, 'assault', null,
        ['Autocannon/10', 'Medium Laser', 'Medium Laser', 'SRM-4', 'SRM-4'],
        'M'),

  // ── OSR ──────────────────────────────────────────────────────────────────
  known('OSR-2C', 'Ostroc', 'heavy', 60, 86.4, 'medium', null,
        ['Large Laser', 'Large Laser', 'SRM-4', 'Medium Laser', 'Medium Laser'],
        'M'),
  stub('OSR-2D',    'heavy'),
  stub('OSR-2L',    'heavy'),
  stub('OSR-2M',    'heavy'),

  // ── OTL ──────────────────────────────────────────────────────────────────
  stub('OTL-4D',    'heavy'),     // Ostsol variant — not in BT-MAN
  known('OTL-4F', 'Ostsol', 'heavy', 60, 86.4, 'medium', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon'],
        'L'),

  // ── OTT ──────────────────────────────────────────────────────────────────
  stub('OTT-7J',    'medium'),    // Ostscout — not in BT-MAN

  // ── PNT ──────────────────────────────────────────────────────────────────
  stub('PNT-9R',    'medium'),    // Panther — not in BT-MAN

  // ── PXH ──────────────────────────────────────────────────────────────────
  known('PXH-1', 'Phoenix Hawk', 'medium', 45, 97.2, 'medium', 180,
        ['Large Laser', 'Medium Laser', 'Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),
  stub('PXH-1D',    'medium'),
  stub('PXH-1K',    'medium'),

  // ── QKD ──────────────────────────────────────────────────────────────────
  stub('QKD-4G',    'medium'),    // Quickdraw — not in BT-MAN
  stub('QKD-4H',    'medium'),

  // ── RFL ──────────────────────────────────────────────────────────────────
  known('RFL-3C', 'Rifleman', 'heavy', 60, 64.8, 'medium', null,
        ['Autocannon/10', 'Autocannon/10', 'Medium Laser', 'Medium Laser'],
        'M'),
  known('RFL-3N', 'Rifleman', 'heavy', 60, 64.8, 'medium', null,
        ['Large Laser', 'Large Laser', 'Autocannon/5', 'Autocannon/5',
         'Medium Laser', 'Medium Laser'],
        'M'),
  stub('RFL-4D',    'heavy'),

  // ── RVN ──────────────────────────────────────────────────────────────────
  stub('RVN-1X',    'light'),     // Raven — not in BT-MAN

  // ── SCP ──────────────────────────────────────────────────────────────────
  stub('SCP-1N',    'medium'),    // Scorpion — not in BT-MAN

  // ── SDR ──────────────────────────────────────────────────────────────────
  stub('SDR-5D',    'light'),     // Spider variant — not in BT-MAN
  known('SDR-5K', 'Spider', 'light', 30, 129.6, 'light', 180,
        ['Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),
  known('SDR-5V', 'Spider', 'light', 30, 129.6, 'light', 240,
        ['Medium Laser', 'Medium Laser'],
        'M'),

  // ── SHD ──────────────────────────────────────────────────────────────────
  stub('SHD-2D',    'medium'),    // Shadow Hawk variant — not in BT-MAN
  stub('SHD-2D2',   'medium'),
  known('SHD-2H', 'Shadow Hawk', 'medium', 55, 86.4, 'medium', 90,
        ['Autocannon/5', 'LRM-5', 'Medium Laser', 'SRM-2'],
        'L'),
  stub('SHD-2K',    'medium'),

  // ── SHG ──────────────────────────────────────────────────────────────────
  stub('SHG-2E',    'assault'),   // Shogun — not in BT-MAN

  // ── STG ──────────────────────────────────────────────────────────────────
  known('STG-3G', 'Stinger', 'light', 20, 97.2, 'light', 180,
        ['Medium Laser', 'Medium Laser'],
        'M'),
  known('STG-3R', 'Stinger', 'light', 20, 97.2, 'light', 180,
        ['Medium Laser', 'Machine Gun', 'Machine Gun'],
        'S'),

  // ── STK ──────────────────────────────────────────────────────────────────
  known('STK-3F', 'Stalker', 'assault', 85, 54, 'heavy', null,
        ['LRM-15', 'LRM-15', 'Large Laser', 'Large Laser',
         'SRM-6', 'SRM-6',
         'Medium Laser', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'L'),
  stub('STK-3H',    'assault'),
  stub('STK-4N',    'assault'),
  stub('STK-4P',    'assault'),

  // ── TBT ──────────────────────────────────────────────────────────────────
  known('TBT-5J', 'Trebuchet', 'medium', 50, 86.4, 'medium', 150,
        ['LRM-15', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'L'),
  known('TBT-5N', 'Trebuchet', 'medium', 50, 86.4, 'medium', null,
        ['LRM-15', 'LRM-15', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
        'L'),
  // data incomplete — tonnage/speed missing from BT-MAN extraction; cross-reference .MEC RE
  {
    designation: 'TBT-5S', name: 'Trebuchet', weightClass: 'medium',
    tonnage: null, maxSpeedKph: null, armor: 'medium', jumpMeters: null,
    armament: ['SRM-6', 'SRM-6', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
    effectiveRange: 'M', disabled: false,
  },

  // ── TDR ──────────────────────────────────────────────────────────────────
  known('TDR-5S', 'Thunderbolt', 'heavy', 65, 64.8, 'heavy', null,
        ['Large Laser', 'LRM-15', 'Medium Laser', 'Medium Laser', 'Medium Laser',
         'SRM-2', 'Machine Gun', 'Machine Gun'],
        'L'),
  stub('TDR-5SE',   'heavy'),
  stub('TDR-5SS',   'heavy'),

  // ── UM ───────────────────────────────────────────────────────────────────
  known('UM-R60', 'UrbanMech', 'light', 30, 32.4, 'light', 60,
        ['Autocannon/10', 'Small Laser'],
        'S'),
  stub('UM-R60L',   'light'),

  // ── VL ───────────────────────────────────────────────────────────────────
  stub('VL-2T',     'medium'),    // Vulcan — not in BT-MAN
  stub('VL-5T',     'medium'),

  // ── VLK ──────────────────────────────────────────────────────────────────
  known('VLK-QA', 'Valkyrie', 'light', 30, 86.4, 'light', 150,
        ['LRM-10', 'Medium Laser'],
        'L'),
  stub('VLK-QD',    'light'),

  // ── VND ──────────────────────────────────────────────────────────────────
  known('VND-1AA', 'Vindicator', 'medium', 45, 86.4, 'light', 150,
        ['Particle Projector Cannon', 'LRM-5', 'Medium Laser', 'Small Laser'],
        'L'),
  known('VND-1R', 'Vindicator', 'medium', 45, 64.8, 'medium', 120,
        ['Particle Projector Cannon', 'LRM-5', 'Medium Laser'],
        'L'),

  // ── VTR ──────────────────────────────────────────────────────────────────
  stub('VTR-9A',    'assault'),   // Victor variant — not in BT-MAN
  known('VTR-9A1', 'Victor', 'assault', 80, 64.8, 'medium', 120,
        ['Autocannon/20', 'Medium Laser', 'Medium Laser', 'SRM-4',
         'Machine Gun', 'Machine Gun'],
        'S'),
  known('VTR-9B', 'Victor', 'assault', 80, 64.8, 'heavy', 120,
        ['Autocannon/20', 'SRM-4', 'Medium Laser', 'Medium Laser'],
        'M'),
  stub('VTR-9D',    'assault'),
  known('VTR-9S', 'Victor', 'assault', 80, 64.8, 'medium', 120,
        ['Autocannon/20', 'Medium Laser', 'Medium Laser', 'SRM-6'],
        'M'),

  // ── WHM ──────────────────────────────────────────────────────────────────
  known('WHM-6D', 'Warhammer', 'heavy', 70, 64.8, 'assault', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'Medium Laser', 'Medium Laser', 'Small Laser', 'Small Laser'],
        'S'),
  known('WHM-6K', 'Warhammer', 'heavy', 70, 64.8, 'medium', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'SRM-6', 'Medium Laser', 'Medium Laser', 'Small Laser', 'Small Laser'],
        'S'),
  stub('WHM-6L',    'heavy'),
  known('WHM-6R', 'Warhammer', 'heavy', 70, 64.8, 'medium', null,
        ['Particle Projector Cannon', 'Particle Projector Cannon',
         'SRM-6', 'Medium Laser', 'Medium Laser',
         'Small Laser', 'Small Laser', 'Machine Gun', 'Machine Gun'],
        'S'),

  // ── WLF ──────────────────────────────────────────────────────────────────
  stub('WLF-1',     'medium'),    // Wolfhound — not in BT-MAN

  // ── WSP ──────────────────────────────────────────────────────────────────
  known('WSP-1A', 'Wasp', 'light', 20, 97.2, 'light', 180,
        ['Medium Laser', 'SRM-2'],
        'M'),
  stub('WSP-1D',    'light'),     // Wasp variant — not in BT-MAN
  known('WSP-1K', 'Wasp', 'light', 20, 97.2, 'light', 180,
        ['Medium Laser', 'Machine Gun'],
        'S'),
  stub('WSP-1L',    'light'),
  stub('WSP-1S',    'light'),
  known('WSP-1W', 'Wasp', 'light', 20, 97.2, 'light', 180,
        ['Small Laser', 'Small Laser', 'Small Laser',
         'Small Laser', 'Small Laser', 'Small Laser'],
        'S'),

  // ── WTH ──────────────────────────────────────────────────────────────────
  // data incomplete — tonnage/speed missing from BT-MAN extraction; cross-reference .MEC RE
  {
    designation: 'WTH-1', name: 'Whitworth', weightClass: 'medium',
    tonnage: null, maxSpeedKph: null, armor: null, jumpMeters: null,
    armament: ['LRM-10', 'LRM-10', 'Medium Laser', 'Medium Laser', 'Medium Laser'],
    effectiveRange: 'L', disabled: false,
  },
  stub('WTH-1S',    'medium'),

  // ── WVR ──────────────────────────────────────────────────────────────────
  // data incomplete — tonnage/speed missing from BT-MAN extraction; cross-reference .MEC RE
  {
    designation: 'WVR-6K', name: 'Wolverine', weightClass: 'medium',
    tonnage: null, maxSpeedKph: null, armor: null, jumpMeters: null,
    armament: ['Large Laser', 'Medium Laser', 'Medium Laser', 'SRM-6', 'Small Laser'],
    effectiveRange: 'S', disabled: false,
  },
  stub('WVR-6M',    'medium'),
  stub('WVR-6R',    'medium'),

  // ── ZEU ──────────────────────────────────────────────────────────────────
  known('ZEU-6S', 'Zeus', 'assault', 80, 64.8, 'heavy', null,
        ['Large Laser', 'LRM-15', 'Autocannon/5', 'Medium Laser', 'Medium Laser'],
        'L'),
  stub('ZEU-6T',    'assault'),
];

// ─── exports ─────────────────────────────────────────────────────────────────

/** Lookup table keyed by uppercase designation (matches .MEC filename). */
export const MECH_STATS: ReadonlyMap<string, MechStats> =
  new Map(ENTRIES.map(e => [e.designation, e]));

type RuntimeMechSummary = Pick<MechEntry, 'tonnage' | 'maxSpeedMag' | 'jumpJetCount'>;

function runtimeMaxSpeedKph(mech: RuntimeMechSummary | undefined): number | null {
  if (!mech || mech.maxSpeedMag <= 0) return null;
  return Math.round(mech.maxSpeedMag * 16.2 / 450);
}

/**
 * Build the compact mech-stats text shown in the examine dialog (Cmd20).
 *
 * Line separator is `\x5c` (backslash) — lobby dialog line-break character
 * per FUN_00433310 RE.  0x1B is stripped to prevent CRC encoding failure.
 *
 * @param typeString  Uppercase variant designation, e.g. "ANH-1A".
 * @param runtimeMech Optional `.MEC`-derived runtime data for variants whose
 *                    manual entry is partial or missing.
 */
export function buildMechExamineText(typeString: string, runtimeMech?: RuntimeMechSummary): string {
  const SEP      = '\x5c';
  const sanitize = (s: string) => s.replace(/\x1b/g, '');
  const stats    = MECH_STATS.get(typeString);

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const safeType = sanitize(typeString);
  const safeName = stats?.name ? sanitize(stats.name) : '';
  const title = safeName ? `${safeType}  ${safeName}` : safeType;
  const weightClass = stats?.weightClass ? sanitize(cap(stats.weightClass)) : '';
  const tonnage = stats?.tonnage ?? runtimeMech?.tonnage ?? null;
  const maxSpeedKph = stats?.maxSpeedKph ?? runtimeMaxSpeedKph(runtimeMech);
  const specParts: string[] = [];
  if (weightClass) specParts.push(weightClass);
  if (tonnage != null) specParts.push(`${tonnage}T`);
  if (maxSpeedKph != null) specParts.push(`${maxSpeedKph}kph`);
  if (stats?.jumpMeters != null) {
    specParts.push(`Jump:${stats.jumpMeters}m`);
  } else if ((runtimeMech?.jumpJetCount ?? 0) > 0) {
    specParts.push(`Jump Jets:${runtimeMech?.jumpJetCount}`);
  }
  const specs = specParts.join('  ');
  const arms  = Array.isArray(stats?.armament) && stats.armament.length > 0
    ? sanitize(stats.armament.join(' '))
    : '';

  const lines = [title];
  if (specs) lines.push(specs);
  if (arms)  lines.push(arms);
  const full = lines.join(SEP);
  // Safety: cap at 84 bytes (display buffer limit observed in FUN_00431f10).
  return Buffer.byteLength(full, 'latin1') <= 84
    ? full
    : Buffer.from(full, 'latin1').subarray(0, 84).toString('latin1');
}
