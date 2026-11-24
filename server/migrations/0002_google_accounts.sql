-- Switch sign-in from GitHub to Google ID tokens. No user uploads existed, so
-- the GitHub-keyed tables are dropped rather than migrated.
DROP TABLE IF EXISTS token_cache;

DROP TABLE IF EXISTS bans;
CREATE TABLE bans (
  sub_hash   TEXT PRIMARY KEY,              -- HMAC-SHA256(Google sub, IP_SALT), hex
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

DROP TABLE IF EXISTS upload_log;
CREATE TABLE upload_log (
  sub_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX upload_log_sub ON upload_log (sub_hash, created_at);

-- One row per account that has claimed a handle (the public author name).
CREATE TABLE accounts (
  sub_hash   TEXT PRIMARY KEY,              -- HMAC-SHA256(Google sub, IP_SALT), hex; raw sub is never stored
  handle     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE handle_log (
  sub_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX handle_log_sub ON handle_log (sub_hash, created_at);
