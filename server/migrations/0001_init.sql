-- Skin gallery schema, v1.
CREATE TABLE skins (
  author      TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  version     INTEGER NOT NULL DEFAULT 1,
  skin_json   TEXT NOT NULL,                -- normalized skin, without author/version
  scene       TEXT,                         -- scene.svg text or NULL
  downloads   INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,             -- epoch ms
  updated_at  INTEGER NOT NULL,             -- epoch ms
  PRIMARY KEY (author, slug)
);
CREATE INDEX skins_new ON skins (hidden, updated_at DESC, author DESC, slug DESC);
CREATE INDEX skins_popular ON skins (hidden, downloads DESC, updated_at DESC, author DESC, slug DESC);

CREATE TABLE reports (
  author        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  reporter_hash TEXT NOT NULL,              -- sha256(IP_SALT + ip)
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (author, slug, reporter_hash)
);

CREATE TABLE token_cache (
  token_hash TEXT PRIMARY KEY,              -- sha256(token); raw tokens are never stored
  login      TEXT NOT NULL,
  expires_at INTEGER NOT NULL               -- epoch ms
);

CREATE TABLE bans (
  login      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE upload_log (
  login      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX upload_log_login ON upload_log (login, created_at);

-- Download dedupe: one count per salted IP hash per skin per UTC day.
CREATE TABLE download_seen (
  author  TEXT NOT NULL,
  slug    TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day     INTEGER NOT NULL,                 -- floor(epoch ms / 86400000)
  PRIMARY KEY (author, slug, ip_hash, day)
);
CREATE INDEX download_seen_day ON download_seen (day);
