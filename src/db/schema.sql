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
    cbills       INTEGER      NOT NULL DEFAULT 100000,
    mech_id      INTEGER,
    mech_slot    INTEGER,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE characters ADD COLUMN IF NOT EXISTS cbills    INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mech_id   INTEGER;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS mech_slot INTEGER;
ALTER TABLE characters ALTER COLUMN cbills SET DEFAULT 100000;

-- Fast lookup by account (one character per account enforced by UNIQUE above).
CREATE INDEX IF NOT EXISTS characters_account_id_idx ON characters (account_id);

-- Case-insensitive display name uniqueness matches isDisplayNameTaken() in characters.ts.
CREATE UNIQUE INDEX IF NOT EXISTS characters_display_name_lower_idx
    ON characters (lower(display_name));

-- messages: ComStar DMs sent between players.
-- Persisted for both online and offline delivery so the terminal "Receive a
-- ComStar message" flow can read from the same inbox.
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
    delivered_at         TIMESTAMPTZ,          -- NULL until shown to the recipient client
    saved_at             TIMESTAMPTZ,          -- NULL until explicitly deferred/saved for terminal retrieval
    read_at              TIMESTAMPTZ           -- NULL until explicitly read/consumed
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;

-- articles: news and announcements published on the website.
CREATE TABLE IF NOT EXISTS articles (
    id           SERIAL PRIMARY KEY,
    slug         VARCHAR(128) NOT NULL,
    title        VARCHAR(255) NOT NULL,
    summary      TEXT         NOT NULL,
    body         TEXT         NOT NULL,
    author_id    INTEGER               REFERENCES accounts(id) ON DELETE SET NULL,
    published    BOOLEAN      NOT NULL DEFAULT TRUE,
    published_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE articles ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_uq ON articles (slug);
CREATE INDEX         IF NOT EXISTS articles_published_at_idx ON articles (published_at DESC);

-- Fast lookup: pending messages for a given recipient (most common query).
CREATE INDEX IF NOT EXISTS messages_recipient_undelivered_idx
    ON messages (recipient_account_id, sent_at, id)
    WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_recipient_unread_idx
    ON messages (recipient_account_id, sent_at, id)
    WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS messages_recipient_saved_unread_idx
    ON messages (recipient_account_id, sent_at, id)
    WHERE saved_at IS NOT NULL AND read_at IS NULL;

-- persisted Solaris duel outcomes used for ranking/result terminal flows.
CREATE TABLE IF NOT EXISTS duel_results (
    id                      SERIAL PRIMARY KEY,
    combat_session_id       VARCHAR(64)  NOT NULL UNIQUE,
    world_map_room_id       INTEGER      NOT NULL,
    room_name               VARCHAR(128) NOT NULL,
    winner_account_id       INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    loser_account_id        INTEGER      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    winner_display_name     VARCHAR(64)  NOT NULL,
    loser_display_name      VARCHAR(64)  NOT NULL,
    winner_comstar_id       INTEGER      NOT NULL,
    loser_comstar_id        INTEGER      NOT NULL,
    winner_mech_id          INTEGER      NOT NULL,
    loser_mech_id           INTEGER      NOT NULL,
    winner_stake_cb         INTEGER      NOT NULL DEFAULT 0,
    loser_stake_cb          INTEGER      NOT NULL DEFAULT 0,
    settled_transfer_cb     INTEGER      NOT NULL DEFAULT 0,
    winner_balance_cb       INTEGER      NOT NULL DEFAULT 0,
    loser_balance_cb        INTEGER      NOT NULL DEFAULT 0,
    winner_remaining_health INTEGER      NOT NULL,
    winner_max_health       INTEGER      NOT NULL,
    loser_remaining_health  INTEGER      NOT NULL,
    loser_max_health        INTEGER      NOT NULL,
    result_reason           VARCHAR(128) NOT NULL,
    completed_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE duel_results ADD COLUMN IF NOT EXISTS winner_stake_cb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duel_results ADD COLUMN IF NOT EXISTS loser_stake_cb  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duel_results ADD COLUMN IF NOT EXISTS settled_transfer_cb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duel_results ADD COLUMN IF NOT EXISTS winner_balance_cb   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duel_results ADD COLUMN IF NOT EXISTS loser_balance_cb    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS duel_results_completed_at_idx
    ON duel_results (completed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS duel_results_winner_account_idx
    ON duel_results (winner_account_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS duel_results_loser_account_idx
    ON duel_results (loser_account_id, completed_at DESC);
