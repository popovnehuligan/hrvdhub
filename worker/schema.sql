-- HOROVOD · Вишлист on Cloudflare D1. Safe to run again (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS wishes (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,        -- the wish as JSON, without votes
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS votes (  -- one row per heart, so two people voting at once never lose a vote
  wish_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT,
  at TEXT,
  PRIMARY KEY (wish_id, user_id)
);
CREATE TABLE IF NOT EXISTS props (key TEXT PRIMARY KEY, value TEXT);  -- settings: GROUP_CHAT_ID, TOPIC_ID, …
CREATE TABLE IF NOT EXISTS rids (rid TEXT PRIMARY KEY, wish_id TEXT, at TEXT);  -- retried saves
