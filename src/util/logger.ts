/**
 * Simple structured logger.
 * Writes timestamped lines to stdout; optionally mirrors to a file.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(
    private readonly prefix: string = '',
    private readonly minLevel: LogLevel = 'debug',
    logFile?: string,
  ) {
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      this.stream = fs.createWriteStream(logFile, { flags: 'a' });
    }
  }

  private write(level: LogLevel, fmt: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    // Basic printf-style formatting for %s, %d, %j
    let msg = fmt.replace(/%([sdj])/g, (_, spec) => {
      const arg = args.shift();
      if (spec === 'd') return String(Number(arg));
      if (spec === 'j') return JSON.stringify(arg);
      return String(arg);
    });
    if (args.length) msg += ' ' + args.map(a => String(a)).join(' ');

    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${msg}`;
    console.log(line);
    this.stream?.write(line + '\n');
  }

  debug(fmt: string, ...args: unknown[]): void { this.write('debug', fmt, ...args); }
  info(fmt:  string, ...args: unknown[]): void { this.write('info',  fmt, ...args); }
  warn(fmt:  string, ...args: unknown[]): void { this.write('warn',  fmt, ...args); }
  error(fmt: string, ...args: unknown[]): void { this.write('error', fmt, ...args); }

  child(subPrefix: string): Logger {
    const c = new Logger(
      this.prefix ? `${this.prefix}:${subPrefix}` : subPrefix,
      this.minLevel,
    );
    c.stream = this.stream; // share the parent's write stream
    return c;
  }

  close(): void {
    this.stream?.end();
  }
}
