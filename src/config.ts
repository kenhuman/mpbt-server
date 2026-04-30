import type { LogLevel } from './util/logger.js';

function readNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      throw new Error(`${name} must be a boolean (1/0, true/false, yes/no, on/off), got "${raw}"`);
  }
}

function readLogLevelEnv(name: string, defaultValue: LogLevel): LogLevel {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }

  throw new Error(`${name} must be one of debug/info/warn/error, got "${raw}"`);
}

// ARIES type-0x05 keepalive interval. 0 disables server-initiated keepalives.
export const ARIES_KEEPALIVE_INTERVAL_MS = readNonNegativeIntEnv(
  'ARIES_KEEPALIVE_INTERVAL_MS',
  30_000,
);

// TCP idle timeout for lobby/world sockets. 0 disables the explicit timeout.
export const SOCKET_IDLE_TIMEOUT_MS = readNonNegativeIntEnv(
  'SOCKET_IDLE_TIMEOUT_MS',
  120_000,
);

// Default to info-level logs during normal play. Protocol reverse-engineering can
// opt back into per-packet debug logging with MPBT_LOG_LEVEL=debug.
export const MPBT_LOG_LEVEL = readLogLevelEnv('MPBT_LOG_LEVEL', 'info');

// Packet hex captures are useful during protocol work, but they add sustained disk
// I/O on every send/receive. Keep them opt-in for regular local playtesting.
export const MPBT_CAPTURE_ENABLED = readBooleanEnv('MPBT_CAPTURE', false);

// REST API server for the modern Godot client. Listens on a separate port from
// the ARIES TCP server. Set API_HOST=0.0.0.0 to expose to LAN clients.
// Port 3002 keeps this separate from mpbt-web (3000) and mpbt-web/api (3001).
export const API_PORT = readNonNegativeIntEnv('API_PORT', 3002);
export const API_HOST = process.env['API_HOST'] ?? '127.0.0.1';
