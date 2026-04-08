-- MPBT Server — initial schema (idempotent: safe to run multiple times)
--
-- accounts: one row per login credential (username + bcrypt password hash).
-- characters: one row per in-game persona (display name + House allegiance).
--             One account → one character for now; extend in M9 for multi-char.

CREATE TABLE IF NOT EXISTS accounts (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email         VARCHAR(255),
    is_admin      BOOLEAN      NOT NULL DEFAULT FALSE,
    suspended     BOOLEAN      NOT NULL DEFAULT FALSE,
    banned        BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email     VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned    BOOLEAN NOT NULL DEFAULT FALSE;

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

-- articles: news and announcements published on the website.
CREATE TABLE IF NOT EXISTS articles (
    id           SERIAL PRIMARY KEY,
    slug         VARCHAR(128) NOT NULL,
    title        VARCHAR(255) NOT NULL,
    summary      TEXT         NOT NULL,
    body         TEXT         NOT NULL,
    author_id    INTEGER               REFERENCES accounts(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_uq ON articles (slug);
CREATE INDEX         IF NOT EXISTS articles_published_at_idx ON articles (published_at DESC);

-- Fast lookup: pending messages for a given recipient (most common query).
CREATE INDEX IF NOT EXISTS messages_recipient_undelivered_idx
    ON messages (recipient_account_id, sent_at, id)
    WHERE delivered_at IS NULL;
