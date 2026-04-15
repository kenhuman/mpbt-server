/**
 * Solaris ranking compatibility model.
 *
 * The retail SCentEx formula is still not RE-proven. This module keeps the
 * persisted duel history and tier/class UI coherent using a bounded,
 * retail-shaped approximation that accounts for outcome, damage swing, and a
 * coarse mech-class effectiveness difference.
 */

import type { CharacterRow } from '../db/characters.js';
import type { DuelResultRow } from '../db/duel-results.js';
import { WORLD_MECH_BY_ID, getMechWeightClass } from './world-data.js';

export type SolarisTierKey =
  | 'UNRANKED'
  | 'NOVICE'
  | 'AMATEUR'
  | 'PROFESSIONAL'
  | 'VETERAN'
  | 'MASTER'
  | 'BATTLEMASTER'
  | 'CHAMPION';

export type SolarisClassKey = 'LIGHT' | 'MEDIUM' | 'HEAVY' | 'ASSAULT';

export interface SolarisStanding {
  accountId: number;
  displayName: string;
  allegiance: string;
  comstarId: number;
  score: number;
  wins: number;
  losses: number;
  matches: number;
  ratioText: string;
  tierKey: SolarisTierKey;
  tierLabel: string;
  overallRank: number;
  tierRank: number;
}

type MutableStanding = Omit<SolarisStanding, 'ratioText' | 'tierKey' | 'tierLabel' | 'overallRank' | 'tierRank'>;

type ParticipantView = {
  accountId: number;
  fallbackName: string;
  mechId: number;
  remainingHealth: number;
  maxHealth: number;
  won: boolean;
};

const CLASS_ORDER: Record<SolarisClassKey, number> = {
  LIGHT: 0,
  MEDIUM: 1,
  HEAVY: 2,
  ASSAULT: 3,
};

const TIER_BANDS: Array<{ key: Exclude<SolarisTierKey, 'UNRANKED'>; label: string; minScore: number }> = [
  { key: 'CHAMPION', label: 'Champion', minScore: 7000 },
  { key: 'BATTLEMASTER', label: 'BattleMaster', minScore: 5000 },
  { key: 'MASTER', label: 'Master', minScore: 3500 },
  { key: 'VETERAN', label: 'Veteran', minScore: 2500 },
  { key: 'PROFESSIONAL', label: 'Professional', minScore: 1800 },
  { key: 'AMATEUR', label: 'Amateur', minScore: 1300 },
  { key: 'NOVICE', label: 'Novice', minScore: 0 },
];

function ensureStanding(
  standings: Map<number, MutableStanding>,
  characters: Map<number, CharacterRow>,
  accountId: number,
  fallbackName: string,
): MutableStanding {
  let standing = standings.get(accountId);
  if (standing) return standing;
  const character = characters.get(accountId);
  standing = {
    accountId,
    displayName: character?.display_name ?? fallbackName,
    allegiance: character?.allegiance ?? 'Unaffiliated',
    comstarId: 100000 + accountId,
    score: 0,
    wins: 0,
    losses: 0,
    matches: 0,
  };
  standings.set(accountId, standing);
  return standing;
}

function currentScore(standing: MutableStanding): number {
  return standing.matches > 0 ? standing.score : 1000;
}

function clampPct(remaining: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, remaining / max));
}

function classBias(ownMechId: number, opponentMechId: number): number {
  const ownClass = getMechWeightClass(WORLD_MECH_BY_ID.get(ownMechId) ?? { typeString: '', tonnage: 0 });
  const opponentClass = getMechWeightClass(WORLD_MECH_BY_ID.get(opponentMechId) ?? { typeString: '', tonnage: 0 });
  if (!ownClass || !opponentClass) return 0;
  return (CLASS_ORDER[opponentClass] - CLASS_ORDER[ownClass]) * 75;
}

function applyResult(
  standing: MutableStanding,
  opponentStanding: MutableStanding,
  self: ParticipantView,
  opponent: ParticipantView,
): void {
  const ownScore = currentScore(standing);
  const opponentScore = currentScore(opponentStanding);
  const effectiveOpponent = opponentScore + classBias(self.mechId, opponent.mechId);
  const expected = 1 / (1 + Math.pow(10, (effectiveOpponent - ownScore) / 400));
  const inflictedPct = 1 - clampPct(opponent.remainingHealth, opponent.maxHealth);
  const sustainedPct = 1 - clampPct(self.remainingHealth, self.maxHealth);
  const damageSwing = inflictedPct - sustainedPct;
  const outcome = self.won ? 1 : 0;
  const delta = Math.round((220 * (outcome - expected)) + (damageSwing * 140));

  if (standing.matches === 0) {
    standing.score = 1000;
  }
  standing.score = Math.max(0, standing.score + delta);
  standing.matches += 1;
  if (self.won) standing.wins += 1;
  else standing.losses += 1;
}

function tierForStanding(matches: number, score: number): { key: SolarisTierKey; label: string } {
  if (matches <= 0) {
    return { key: 'UNRANKED', label: 'Unranked' };
  }
  for (const band of TIER_BANDS) {
    if (score >= band.minScore) {
      return { key: band.key, label: band.label };
    }
  }
  return { key: 'NOVICE', label: 'Novice' };
}

function finalizeStandings(standings: MutableStanding[]): SolarisStanding[] {
  const ranked = standings
    .slice()
    .sort((a, b) =>
      (b.score - a.score)
      || (b.wins - a.wins)
      || (a.losses - b.losses)
      || a.displayName.localeCompare(b.displayName));

  const tierCounts = new Map<SolarisTierKey, number>();
  return ranked.map((standing, index) => {
    const tier = tierForStanding(standing.matches, standing.score);
    const tierRank = (tierCounts.get(tier.key) ?? 0) + 1;
    tierCounts.set(tier.key, tierRank);
    return {
      ...standing,
      ratioText: `${standing.wins}/${standing.losses}`,
      tierKey: tier.key,
      tierLabel: tier.label,
      overallRank: index + 1,
      tierRank,
    };
  });
}

export function computeSolarisStandings(
  results: DuelResultRow[],
  characters: CharacterRow[],
  classFilter?: SolarisClassKey,
): SolarisStanding[] {
  const standings = new Map<number, MutableStanding>();
  const characterMap = new Map(characters.map(character => [character.account_id, character]));

  if (!classFilter) {
    for (const character of characters) {
      ensureStanding(standings, characterMap, character.account_id, character.display_name);
    }
  }

  for (const result of results) {
    const winnerView: ParticipantView = {
      accountId: result.winner_account_id,
      fallbackName: result.winner_display_name,
      mechId: result.winner_mech_id,
      remainingHealth: result.winner_remaining_health,
      maxHealth: result.winner_max_health,
      won: true,
    };
    const loserView: ParticipantView = {
      accountId: result.loser_account_id,
      fallbackName: result.loser_display_name,
      mechId: result.loser_mech_id,
      remainingHealth: result.loser_remaining_health,
      maxHealth: result.loser_max_health,
      won: false,
    };

    const winnerClass = getMechWeightClass(WORLD_MECH_BY_ID.get(result.winner_mech_id) ?? { typeString: '', tonnage: 0 });
    const loserClass = getMechWeightClass(WORLD_MECH_BY_ID.get(result.loser_mech_id) ?? { typeString: '', tonnage: 0 });
    const includeWinner = !classFilter || winnerClass === classFilter;
    const includeLoser = !classFilter || loserClass === classFilter;
    if (!includeWinner && !includeLoser) continue;

    const winnerStanding = ensureStanding(standings, characterMap, result.winner_account_id, result.winner_display_name);
    const loserStanding = ensureStanding(standings, characterMap, result.loser_account_id, result.loser_display_name);

    if (includeWinner) {
      applyResult(winnerStanding, loserStanding, winnerView, loserView);
    }
    if (includeLoser) {
      applyResult(loserStanding, winnerStanding, loserView, winnerView);
    }
  }

  const finalized = finalizeStandings([...standings.values()]);
  return classFilter
    ? finalized.filter(standing => standing.matches > 0)
    : finalized;
}

export function findStandingByComstarId(
  standings: SolarisStanding[],
  comstarId: number,
): SolarisStanding | undefined {
  return standings.find(standing => standing.comstarId === comstarId);
}
