-- MPBT Server — initial schema (idempotent: safe to run multiple times)
--
-- accounts: one row per login credential (username + bcrypt password hash).
-- characters: one row per in-game persona (display name + House allegiance).
--             One account → one character for now; extend in M9 for multi-char.

CREATE TABLE IF NOT EXISTS accounts (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Case-insensitive unique username (lower(username) matches lookup in accounts.ts).
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_uq
    ON accounts (lower(username));

CREATE TABLE IF NOT EXISTS characters (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER      UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    display_name VARCHAR(64)  NOT NULL,
    allegiance   VARCHAR(16)  NOT NULL
        CHECK (allegiance IN ('Davion','Steiner','Liao','Marik','Kurita')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast lookup by account (one character per account enforced by UNIQUE above).
CREATE INDEX IF NOT EXISTS characters_account_id_idx ON characters (account_id);

-- Case-insensitive display name uniqueness matches isDisplayNameTaken() in characters.ts.
CREATE UNIQUE INDEX IF NOT EXISTS characters_display_name_lower_idx
    ON characters (lower(display_name));
