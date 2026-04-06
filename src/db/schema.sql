-- MPBT Server — initial schema (idempotent: safe to run multiple times)
--
-- accounts: one row per login credential (username + bcrypt password hash).
-- characters: one row per in-game persona (display name + House allegiance).
--             One account → one character for now; extend in M9 for multi-char.

CREATE TABLE IF NOT EXISTS accounts (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64)  UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS characters (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    display_name VARCHAR(64)  UNIQUE NOT NULL,
    allegiance   VARCHAR(16)  NOT NULL
        CHECK (allegiance IN ('Davion','Steiner','Liao','Marik','Kurita')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast lookup by account (used by character creation + world-entry path).
CREATE INDEX IF NOT EXISTS characters_account_id_idx ON characters (account_id);
