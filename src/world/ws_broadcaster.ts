/**
 * WsBroadcaster — attaches a WebSocket server to the existing HTTP server on
 * port 3002.  Handles the upgrade handshake at path `/ws` and broadcasts
 * JSON events to all connected clients.
 *
 * On every new connection an initial `presence_update` snapshot is sent so
 * late-joiners and re-connectors get current state without waiting for the
 * next travel event.
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { presenceStore } from './presence.js';
import { arenaQueue } from './arena-queue.js';

export class WsBroadcaster {
  private readonly _wss = new WebSocketServer({ noServer: true });
  private _attached = false;
  private readonly _messageHandlers: Array<(ws: WebSocket, raw: string) => void> = [];

  /**
   * Register a handler that is called for every incoming WebSocket message.
   * Multiple handlers may be registered; each receives the same (ws, raw) pair.
   * Handlers must not throw — errors are swallowed to protect the WS loop.
   */
  registerMessageHandler(handler: (ws: WebSocket, raw: string) => void): void {
    this._messageHandlers.push(handler);
  }

  attach(server: http.Server): void {
    if (this._attached) return;
    this._attached = true;

    server.on('upgrade', (req, socket, head) => {
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname === '/ws') {
        this._wss.handleUpgrade(req, socket, head, (ws) => {
          this._wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this._wss.on('connection', (ws) => {
      // Send immediate snapshots so late-joiners/re-connectors get current state.
      ws.send(
        JSON.stringify({ type: 'presence_update', rooms: presenceStore.getAll() }),
      );
      ws.send(
        JSON.stringify({ type: 'arena_queue_update', slots: arenaQueue.getAll() }),
      );
      const pm = arenaQueue.pendingMatch;
      if (pm) {
        ws.send(
          JSON.stringify({
            type: 'arena_match_launch',
            arenaId: pm.arenaId,
            slots: pm.slots,
            launchedAt: pm.launchedAt,
            mode: pm.slots.length === 1 ? 'solo' : 'pvp',
          }),
        );
      }

      // Route incoming messages to registered handlers.
      ws.on('message', (data) => {
        const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        for (const handler of this._messageHandlers) {
          try { handler(ws, raw); } catch { /* handler errors must not crash the WS loop */ }
        }
      });
    });
  }

  broadcast(type: string, data: object): void {
    const msg = JSON.stringify({ type, ...data });
    for (const client of this._wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }
}

export const wsBroadcaster = new WsBroadcaster();
