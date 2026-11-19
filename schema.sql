-- 手書きノート 公開版 データベース定義（Cloudflare D1）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,          -- トークンの SHA-256（トークンそのものは保存しない）
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_failures (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures(key, at);
CREATE TABLE IF NOT EXISTS docs (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT,
  note TEXT,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(owner, kind);
CREATE INDEX IF NOT EXISTS docs_note ON docs(owner, note);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blobs_owner ON blobs(owner);
CREATE TABLE IF NOT EXISTS blob_chunks (     -- R2 を使わないときの画像本体
  id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (id, idx)
);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
