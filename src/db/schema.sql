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

-- messages: ComStar DMs sent between players.
-- Delivered to online recipients immediately; stored here when recipient is offline.
-- delivered_at is set once the message has been written to the recipient's socket.
CREATE TABLE IF NOT EXISTS messages (
    id                   SERIAL PRIMARY KEY,
    sender_account_id    INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient_account_id INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- Sender's comstarId (= 100000 + accountId) used as the dialogId in Cmd36
    -- so the recipient can reply.
    sender_comstar_id    INTEGER      NOT NULL,
    -- Full formatted delivery text: "ComStar message from <name>\<body>"
    -- Already encoded by buildComstarDeliveryText(); ready to pass to Cmd36.
    body                 TEXT         NOT NULL,
    sent_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    delivered_at         TIMESTAMPTZ           -- NULL until written to recipient's socket
);

-- Fast lookup: pending messages for a given recipient (most common query).
CREATE INDEX IF NOT EXISTS messages_recipient_undelivered_idx
    ON messages (recipient_account_id)
    WHERE delivered_at IS NULL;
