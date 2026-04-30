/**
 * CombatWsManager — manages in-memory combat sessions for the Godot client's
 * modern JSON-over-WebSocket combat protocol.
 *
 * Sessions are created when the arena queue fires all-ready (via api.ts) and
 * cleaned up when the match ends, times out, or all players disconnect.
 *
 * Security:
 *   - combat_join validates the username is in the session's slot list.
 *   - First WS to claim a slot wins; subsequent claims with an open WS are
 *     rejected, preventing socket hijacking.
 *   - Server derives winner/loser from session state, never from the payload.
 *
 * Bot AI (solo mode):
 *   - Pursues the human player at BOT_SPEED_FRACTION of max speed.
 *   - Fires every BOT_FIRE_INTERVAL_MS.
 *   - Stops pursuing when either actor health ≤ 0.
 *
 * Fire validation (human player only):
 *   - Cooldown:  min PLAYER_FIRE_COOLDOWN_MS between shots.
 *   - Heat gate: blocked when heat ≥ HEAT_OVERHEAT_THRESHOLD.
 *   - Range:     target must be within MAX_FIRE_RANGE_M.
 *   - Arc:       target must be within ±45° of the attacker's heading.
 *
 * Coordinate convention (matches Godot 4 with default mech orientation):
 *   - Forward vector from heading h = (-sin(h), 0, -cos(h)).
 *   - Bot heading is set so that its forward vector aims at the player.
 */

import { WebSocket } from 'ws';
import { Logger } from '../util/logger.js';
import type { WsBroadcaster } from './ws_broadcaster.js';
import type { ArenaSlot } from './arena-queue.js';
import {
  findCharacterByDisplayName,
  settleDuelStakeTransfer,
} from '../db/characters.js';
import { createDuelResult } from '../db/duel-results.js';

const log = new Logger('combat-ws');

// ─── Tuning constants ─────────────────────────────────────────────────────────

const TICK_MS = 100;
const BOT_FIRE_INTERVAL_MS = 3000;
const HEAT_REGEN_PER_TICK = 1.5;
const WEAPON_HEAT = 10;
const HEAT_OVERHEAT_THRESHOLD = 80;
const BOT_DAMAGE = 8;
const PLAYER_DAMAGE = 10;
const SPAWN_Z = 100;                          // ±Z from origin (m)
const BOT_MAX_SPEED_KPH = 64.8;              // Locust default
const BOT_SPEED_FRACTION = 0.5;
const BOT_MIN_ENGAGE_DIST = 20;              // stop closing in within 20 m
const PLAYER_FIRE_COOLDOWN_MS = 1500;
const MAX_FIRE_RANGE_M = 500;
const FIRE_BEARING_COS = Math.cos(Math.PI / 4); // ±45 °
const PRE_JOIN_TIMEOUT_MS = 30_000;
const SESSION_GC_DELAY_MS = 10_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CombatActor {
  username: string;
  isBot: boolean;
  ws: WebSocket | null;  // null for bots; set on combat_join for humans
  x: number;
  z: number;
  heading: number;       // radians, Y-axis rotation
  health: number;        // 0–100
  heat: number;          // 0–100
  maxSpeedKph: number;
  typeString: string;
  mechId: number;        // 0 for BOT
  lastFireTime: number;
  claimed: boolean;      // true once a WS has joined for this slot
}

interface CombatSession {
  arenaId: string;
  mode: 'solo' | 'pvp';
  actors: Map<string, CombatActor>;
  tick: number;
  state: 'waiting' | 'active' | 'ended';
  tickTimer: ReturnType<typeof setInterval> | null;
  preJoinTimer: ReturnType<typeof setTimeout> | null;
  botLastFireTime: number;
  humanJoinedCount: number;
  expectedHumanCount: number;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class CombatWsManager {
  private readonly _sessions = new Map<string, CombatSession>();

  init(broadcaster: WsBroadcaster): void {
    broadcaster.registerMessageHandler((ws, raw) => this._handleRaw(ws, raw));
  }

  /**
   * Create a new combat session immediately after arena_match_launch.
   * Slots contain all human players; the bot is added automatically for solo.
   */
  startSession(arenaId: string, mode: 'solo' | 'pvp', slots: ArenaSlot[]): void {
    if (this._sessions.has(arenaId)) {
      log.warn('startSession called for existing arenaId=%s — ignored', arenaId);
      return;
    }

    const actors = new Map<string, CombatActor>();

    slots.forEach((slot, i) => {
      actors.set(slot.username, {
        username: slot.username,
        isBot: false,
        ws: null,
        x: 0,
        z: i === 0 ? -SPAWN_Z : SPAWN_Z,
        heading: i === 0 ? 0 : Math.PI,  // face each other
        health: 100,
        heat: 0,
        maxSpeedKph: 64.8,                // TODO: derive from mech stats
        typeString: slot.typeString,
        mechId: slot.mechId,
        lastFireTime: 0,
        claimed: false,
      });
    });

    if (mode === 'solo') {
      actors.set('BOT', {
        username: 'BOT',
        isBot: true,
        ws: null,
        x: 0,
        z: SPAWN_Z,
        heading: Math.PI,  // faces toward player spawn (z = -SPAWN_Z)
        health: 100,
        heat: 0,
        maxSpeedKph: BOT_MAX_SPEED_KPH,
        typeString: 'Locust',
        mechId: 0,
        lastFireTime: 0,
        claimed: true,
      });
    }

    const preJoinTimer = setTimeout(() => {
      const session = this._sessions.get(arenaId);
      if (!session || session.state !== 'waiting') return;
      log.warn('arena %s: pre-join timeout — cancelling session', arenaId);
      this._endSession(session, null, null);
    }, PRE_JOIN_TIMEOUT_MS);

    const session: CombatSession = {
      arenaId,
      mode,
      actors,
      tick: 0,
      state: 'waiting',
      tickTimer: null,
      preJoinTimer,
      botLastFireTime: Date.now() + 2000,  // 2 s grace before first bot shot
      humanJoinedCount: 0,
      expectedHumanCount: slots.length,
    };

    this._sessions.set(arenaId, session);
    log.info('combat session created: arenaId=%s mode=%s players=%d', arenaId, mode, slots.length);
  }

  // ─── Incoming message dispatch ─────────────────────────────────────────────

  private _handleRaw(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;

    const m = msg as Record<string, unknown>;
    const type = typeof m['type'] === 'string' ? m['type'] : '';

    if (!['combat_join', 'combat_input', 'combat_fire', 'combat_leave'].includes(type)) return;

    const arenaId = typeof m['arenaId'] === 'string' ? m['arenaId'] : '';
    if (!arenaId) return;

    // Username is validated against the slot list — not used for routing.
    const username = typeof m['username'] === 'string' ? m['username'] : '';
    if (!username) return;

    switch (type) {
      case 'combat_join':  this._handleJoin(ws, arenaId, username);  break;
      case 'combat_input': this._handleInput(arenaId, username, m);  break;
      case 'combat_fire':  this._handleFire(arenaId, username);       break;
      case 'combat_leave': this._handleLeave(arenaId, username);      break;
    }
  }

  private _handleJoin(ws: WebSocket, arenaId: string, username: string): void {
    const session = this._sessions.get(arenaId);
    if (!session) {
      log.warn('combat_join: unknown session arenaId=%s username=%s', arenaId, username);
      return;
    }
    if (session.state === 'ended') return;

    const actor = session.actors.get(username);
    if (!actor || actor.isBot) {
      log.warn('combat_join: username=%s not a human slot in arenaId=%s', username, arenaId);
      return;
    }

    // Reject if another open connection already holds this slot.
    if (actor.claimed && actor.ws && actor.ws.readyState === WebSocket.OPEN) {
      log.warn('combat_join: slot already claimed username=%s arenaId=%s', username, arenaId);
      return;
    }

    actor.ws = ws;
    actor.claimed = true;

    // Disconnect = surrender.
    ws.once('close', () => {
      log.info('WS closed during combat: username=%s arenaId=%s', username, arenaId);
      this._handleLeave(arenaId, username);
    });

    session.humanJoinedCount++;
    log.info('combat_join: username=%s arenaId=%s (%d/%d)',
      username, arenaId, session.humanJoinedCount, session.expectedHumanCount);

    // Send immediate snapshot so client can initialise from server state.
    this._sendToActor(actor, 'combat_snapshot', this._buildSnapshot(session));

    // Start the tick loop when all expected humans have joined.
    if (session.humanJoinedCount >= session.expectedHumanCount && session.state === 'waiting') {
      if (session.preJoinTimer) {
        clearTimeout(session.preJoinTimer);
        session.preJoinTimer = null;
      }
      session.state = 'active';
      session.tickTimer = setInterval(() => this._tick(session), TICK_MS);
      log.info('combat session active: arenaId=%s', arenaId);
    }
  }

  private _handleInput(arenaId: string, username: string, m: Record<string, unknown>): void {
    const session = this._sessions.get(arenaId);
    if (!session || session.state !== 'active') return;

    const actor = session.actors.get(username);
    if (!actor || actor.isBot) return;

    const x = typeof m['x'] === 'number' ? m['x'] : null;
    const z = typeof m['z'] === 'number' ? m['z'] : null;
    const heading = typeof m['heading'] === 'number' ? m['heading'] : null;

    if (x !== null) actor.x = x;
    if (z !== null) actor.z = z;
    if (heading !== null) actor.heading = heading;
  }

  private _handleFire(arenaId: string, username: string): void {
    const session = this._sessions.get(arenaId);
    if (!session || session.state !== 'active') return;

    const attacker = session.actors.get(username);
    if (!attacker || attacker.isBot) return;

    const now = Date.now();
    if (now - attacker.lastFireTime < PLAYER_FIRE_COOLDOWN_MS) return;
    if (attacker.heat >= HEAT_OVERHEAT_THRESHOLD) return;

    // Any other actor is the target.
    const target = Array.from(session.actors.values()).find(a => a.username !== username);
    if (!target) return;

    const dx = target.x - attacker.x;
    const dz = target.z - attacker.z;
    const dist = Math.hypot(dx, dz);

    if (dist > MAX_FIRE_RANGE_M) return;

    // Forward vector from heading h = (-sin(h), 0, -cos(h)).
    const fwdX = -Math.sin(attacker.heading);
    const fwdZ = -Math.cos(attacker.heading);
    const dot = (fwdX * dx + fwdZ * dz) / (dist || 1);
    if (dot < FIRE_BEARING_COS) return;

    attacker.lastFireTime = now;
    attacker.heat = Math.min(100, attacker.heat + WEAPON_HEAT);
    target.health = Math.max(0, target.health - PLAYER_DAMAGE);

    this._broadcastToSession(session, 'combat_hit', {
      arenaId,
      attacker: username,
      target: target.username,
      damage: PLAYER_DAMAGE,
      health: target.health,
    });

    if (target.health <= 0) {
      this._endSession(session, username, target.username);
    }
  }

  private _handleLeave(arenaId: string, username: string): void {
    const session = this._sessions.get(arenaId);
    if (!session || session.state === 'ended') return;

    log.info('combat_leave/surrender: username=%s arenaId=%s', username, arenaId);

    // Leaving player loses; the other human (or BOT) wins.
    const winner = Array.from(session.actors.values())
      .find(a => a.username !== username && !a.isBot)?.username ?? 'BOT';

    this._endSession(session, winner, username);
  }

  // ─── Tick loop ─────────────────────────────────────────────────────────────

  private _tick(session: CombatSession): void {
    if (session.state !== 'active') return;

    const botActor = session.actors.get('BOT');
    const humanActors = Array.from(session.actors.values()).filter(a => !a.isBot);
    const primaryHuman = humanActors[0];

    if (botActor && primaryHuman) {
      const dx = primaryHuman.x - botActor.x;
      const dz = primaryHuman.z - botActor.z;
      const dist = Math.hypot(dx, dz);

      if (dist > BOT_MIN_ENGAGE_DIST) {
        const speed = (botActor.maxSpeedKph * BOT_SPEED_FRACTION / 3.6) * (TICK_MS / 1000);
        // Set heading so that forward vector (-sin(h), 0, -cos(h)) = normalize(dx, dz).
        botActor.heading = Math.atan2(-dx, -dz);
        botActor.x += (dx / dist) * speed;
        botActor.z += (dz / dist) * speed;
      }

      const now = Date.now();
      if (now - session.botLastFireTime >= BOT_FIRE_INTERVAL_MS) {
        session.botLastFireTime = now;
        primaryHuman.health = Math.max(0, primaryHuman.health - BOT_DAMAGE);

        this._broadcastToSession(session, 'combat_hit', {
          arenaId: session.arenaId,
          attacker: 'BOT',
          target: primaryHuman.username,
          damage: BOT_DAMAGE,
          health: primaryHuman.health,
        });

        if (primaryHuman.health <= 0) {
          this._endSession(session, 'BOT', primaryHuman.username);
          return;
        }
      }
    }

    for (const actor of session.actors.values()) {
      actor.heat = Math.max(0, actor.heat - HEAT_REGEN_PER_TICK);
    }

    this._broadcastToSession(session, 'combat_snapshot', this._buildSnapshot(session));
    session.tick++;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private _buildSnapshot(session: CombatSession): object {
    return {
      arenaId: session.arenaId,
      tick: session.tick,
      actors: Array.from(session.actors.values()).map(a => ({
        username: a.username,
        x: a.x,
        z: a.z,
        heading: a.heading,
        health: a.health,
        heat: a.heat,
        isBot: a.isBot,
        typeString: a.typeString,
      })),
    };
  }

  private _endSession(
    session: CombatSession,
    winner: string | null,
    loser: string | null,
  ): void {
    if (session.state === 'ended') return;

    const wasActive = session.state === 'active';
    session.state = 'ended';

    if (session.tickTimer) {
      clearInterval(session.tickTimer);
      session.tickTimer = null;
    }
    if (session.preJoinTimer) {
      clearTimeout(session.preJoinTimer);
      session.preJoinTimer = null;
    }

    log.info('combat ended: arenaId=%s winner=%s loser=%s', session.arenaId, winner, loser);

    this._broadcastToSession(session, 'combat_end', {
      arenaId: session.arenaId,
      winner,
      loser,
      mode: session.mode,
    });

    // Only persist ranked results for PvP matches that reached active state.
    if (wasActive && session.mode === 'pvp' && winner && loser && winner !== 'BOT' && loser !== 'BOT') {
      this._persistResult(session, winner, loser).catch(err =>
        log.error('failed to persist combat result arenaId=%s: %s', session.arenaId, err),
      );
    }

    setTimeout(() => this._sessions.delete(session.arenaId), SESSION_GC_DELAY_MS);
  }

  private async _persistResult(
    session: CombatSession,
    winner: string,
    loser: string,
  ): Promise<void> {
    const [winnerChar, loserChar] = await Promise.all([
      findCharacterByDisplayName(winner),
      findCharacterByDisplayName(loser),
    ]);
    if (!winnerChar || !loserChar) {
      log.warn('_persistResult: character not found for arenaId=%s winner=%s loser=%s', session.arenaId, winner, loser);
      return;
    }

    const winnerActor = session.actors.get(winner);
    const loserActor  = session.actors.get(loser);
    if (!winnerActor || !loserActor) return;

    const STAKE_CB = 250;
    const safeStake = Math.min(STAKE_CB, loserChar.cbills);

    // ON CONFLICT DO NOTHING makes the insert idempotent; only settle cbills
    // when the row is freshly inserted to avoid double-transfers on replay.
    const inserted = await createDuelResult({
      combatSessionId:       session.arenaId,
      worldMapRoomId:        0,
      roomName:              'Arena',
      winnerAccountId:       winnerChar.account_id,
      loserAccountId:        loserChar.account_id,
      winnerDisplayName:     winner,
      loserDisplayName:      loser,
      winnerComstarId:       100000 + winnerChar.account_id,
      loserComstarId:        100000 + loserChar.account_id,
      winnerMechId:          winnerActor.mechId,
      loserMechId:           loserActor.mechId,
      winnerStakeCb:         safeStake,
      loserStakeCb:          safeStake,
      winnerRemainingHealth: winnerActor.health,
      winnerMaxHealth:       100,
      loserRemainingHealth:  0,
      loserMaxHealth:        100,
      resultReason:          'combat_ws_defeat',
    });

    if (!inserted) {
      // Row already existed — skip settlement to prevent double transfer.
      log.warn('_persistResult: duplicate insert skipped for arenaId=%s', session.arenaId);
      return;
    }

    if (safeStake > 0) {
      try {
        await settleDuelStakeTransfer(winnerChar.account_id, loserChar.account_id, safeStake);
        log.info('cbills settled: arenaId=%s winner=%s +%d loser=%s -%d',
          session.arenaId, winner, safeStake, loser, safeStake);
      } catch (err) {
        log.error('cbills settlement failed arenaId=%s: %s', session.arenaId, err);
      }
    }
  }

  private _broadcastToSession(session: CombatSession, type: string, data: object): void {
    const msg = JSON.stringify({ type, ...data });
    for (const actor of session.actors.values()) {
      if (!actor.isBot && actor.ws && actor.ws.readyState === WebSocket.OPEN) {
        actor.ws.send(msg);
      }
    }
  }

  private _sendToActor(actor: CombatActor, type: string, data: object): void {
    if (actor.ws && actor.ws.readyState === WebSocket.OPEN) {
      actor.ws.send(JSON.stringify({ type, ...data }));
    }
  }
}

export const combatWsManager = new CombatWsManager();
