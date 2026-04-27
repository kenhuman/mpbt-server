/**
 * World reconnect snapshot registry.
 *
 * Stores the last known world-room context for an authenticated player so a
 * later lobby -> world redirect can restore them to the same room instead of
 * always dropping them back at the default spawn.
 */

import type { ClientSession } from './players.js';
import type { BotDifficultyLevel } from '../world/combat-config.js';

export interface PendingWorldResume {
  accountId?: number;
  username: string;
  displayName?: string;
  allegiance?: string;
  cbills?: number;
  worldMapRoomId?: number;
  worldArenaSide?: number;
  worldArenaReadyRoomId?: number;
  selectedMechId?: number;
  selectedMechSlot?: number;
  combatBotOpponentCount?: number;
  combatBotLoadoutIds?: number[];
  combatBotSides?: number[];
  combatBotDifficultyLevel?: BotDifficultyLevel;
  pendingDuelSettlementNotice?: string;
}

type ResumeSnapshotSource = Pick<
  ClientSession,
  'accountId'
  | 'username'
  | 'displayName'
  | 'allegiance'
  | 'cbills'
  | 'worldMapRoomId'
  | 'worldArenaSide'
  | 'worldArenaReadyRoomId'
  | 'selectedMechId'
  | 'selectedMechSlot'
  | 'combatBotOpponentCount'
  | 'combatBotLoadoutIds'
  | 'combatBotSides'
  | 'combatBotDifficultyLevel'
  | 'pendingDuelSettlementNotice'
>;

function normalizeUsername(username: string | undefined): string {
  return username?.trim().toLowerCase() ?? '';
}

class WorldResumeRegistry {
  private readonly byAccountId = new Map<number, PendingWorldResume>();
  private readonly byUsername = new Map<string, PendingWorldResume>();

  save(source: ResumeSnapshotSource): void {
    const username = normalizeUsername(source.username);
    if (
      source.accountId === undefined
      && source.worldMapRoomId === undefined
      && !source.pendingDuelSettlementNotice
    ) {
      return;
    }

    const resume: PendingWorldResume = {
      accountId: source.accountId,
      username,
      displayName: source.displayName,
      allegiance: source.allegiance,
      cbills: source.cbills,
      worldMapRoomId: source.worldMapRoomId,
      worldArenaSide: source.worldArenaSide,
      worldArenaReadyRoomId: source.worldArenaReadyRoomId,
      selectedMechId: source.selectedMechId,
      selectedMechSlot: source.selectedMechSlot,
      combatBotOpponentCount: source.combatBotOpponentCount,
      combatBotLoadoutIds: source.combatBotLoadoutIds ? [...source.combatBotLoadoutIds] : undefined,
      combatBotSides: source.combatBotSides ? [...source.combatBotSides] : undefined,
      combatBotDifficultyLevel: source.combatBotDifficultyLevel,
      pendingDuelSettlementNotice: source.pendingDuelSettlementNotice,
    };

    if (source.accountId !== undefined) {
      this.byAccountId.set(source.accountId, resume);
    }
    if (username) {
      this.byUsername.set(username, resume);
    }
  }

  consume(accountId: number | undefined, username: string | undefined): PendingWorldResume | undefined {
    const usernameKey = normalizeUsername(username);
    const resume = accountId !== undefined
      ? this.byAccountId.get(accountId) ?? (usernameKey ? this.byUsername.get(usernameKey) : undefined)
      : (usernameKey ? this.byUsername.get(usernameKey) : undefined);
    if (!resume) return undefined;

    if (resume.accountId !== undefined) {
      this.byAccountId.delete(resume.accountId);
    }
    if (usernameKey) {
      this.byUsername.delete(usernameKey);
    }
    if (resume.username) {
      this.byUsername.delete(resume.username);
    }

    return resume;
  }
}

export const worldResumeRegistry = new WorldResumeRegistry();
