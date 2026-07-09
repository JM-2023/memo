-- Tag metadata: per-path pin state (and room for future decorations).
-- Rows are upserted, never deleted — a row with pinned_at = NULL still
-- carries its seq, which is how an un-pin (or a rename moving the pin away)
-- propagates to other devices through /api/sync.
CREATE TABLE IF NOT EXISTS tag_meta (
  path TEXT PRIMARY KEY,
  pinned_at TEXT,
  updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tag_meta_seq ON tag_meta (seq);
