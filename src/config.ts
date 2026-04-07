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
