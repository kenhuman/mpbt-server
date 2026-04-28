/**
 * MPBT REST API server — modern client adapter.
 *
 * Provides a lightweight HTTP server on API_PORT (default 3000) for the
 * Godot 4 client.  The ARIES TCP protocol (ports 2000/2001) is unaffected.
 *
 * Endpoints:
 *   GET /health  →  { ok: true, version, name }
 */

import * as http from 'http';
import { readFileSync } from 'fs';
import { Logger } from './util/logger.js';

const _pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export function startApiServer(log: Logger, host: string, port: number): http.Server {
  const apiLog = log.child('api');

  const server = http.createServer((req, res) => {
    const pathname = req.url?.split('?')[0] ?? '/';

    if (req.method === 'GET' && pathname === '/health') {
      const body = JSON.stringify({ ok: true, version: _pkg.version, name: 'mpbt-server' });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (err: Error) => {
    apiLog.error('HTTP server error: %s', err.message);
  });

  server.listen(port, host, () => {
    apiLog.info('HTTP server listening on %s:%d', host, port);
  });

  return server;
}
