/**
 * Packet capture logger.
 *
 * Every raw packet received from a client is written to:
 *   captures/<timestamp>_<session-id>.txt
 *
 * Format per entry:
 *   === RECV offset=<N> len=<N> time=<ISO> ===
 *   <hex dump>
 *   <blank line>
 *
 * This is the primary tool for figuring out the ARIES wire protocol.
 * Keep this running while you try different client behaviours and study
 * the resulting capture files in a hex editor.
 */

import * as fs from 'fs';
import * as path from 'path';
import { hexDump } from '../protocol/aries.js';

const CAPTURE_DIR = path.join(process.cwd(), 'captures');

export class CaptureLogger {
  private stream: fs.WriteStream;
  private packetIndex = 0;

  constructor(sessionId: string) {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    const filename = `${Date.now()}_${sessionId}.txt`;
    this.stream = fs.createWriteStream(path.join(CAPTURE_DIR, filename), {
      flags: 'w',
      encoding: 'utf8',
    });
    this.stream.write(
      `# MPBT ARIES capture — session ${sessionId}\n` +
      `# Started: ${new Date().toISOString()}\n` +
      `# Direction: C→S = client to server\n\n`,
    );
  }

  logRecv(payload: Buffer, streamOffset: number): void {
    const header =
      `=== RECV #${this.packetIndex++} offset=${streamOffset} len=${payload.length} ` +
      `time=${new Date().toISOString()} ===\n`;
    this.stream.write(header + hexDump(payload) + '\n\n');
  }

  logSend(payload: Buffer, label?: string): void {
    const labelSuffix = label ? ` label=${label}` : '';
    const header =
      `=== SEND #${this.packetIndex++}${labelSuffix} len=${payload.length} ` +
      `time=${new Date().toISOString()} ===\n`;
    this.stream.write(header + hexDump(payload) + '\n\n');
  }

  close(): void {
    this.stream.write(`# Session ended: ${new Date().toISOString()}\n`);
    this.stream.end();
  }
}
