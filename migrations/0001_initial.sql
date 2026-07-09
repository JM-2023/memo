-- Single-user memo app. Settings hold the passcode hash + session generation.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memos (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memos_created ON memos (created_at);
CREATE INDEX IF NOT EXISTS idx_memos_deleted ON memos (deleted_at);

-- Images are stored inline in D1 (base64), compressed client-side to stay
-- well under D1 value-size limits. `ord` preserves attachment order.
CREATE TABLE IF NOT EXISTS memo_images (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memo_images_memo ON memo_images (memo_id);
