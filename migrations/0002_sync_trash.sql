-- Seamless sync: every write bumps a global monotonically increasing `seq`
-- (from sync_counter), so clients pull increments with GET /api/sync?since=N.
-- Hard deletes leave an id-only tombstone so other devices can drop the row.
ALTER TABLE memos ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memos_seq ON memos (seq);

CREATE TABLE IF NOT EXISTS sync_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL
);
INSERT OR IGNORE INTO sync_counter (id, n) VALUES (1, 0);

-- Backfill existing rows with distinct seqs in insertion order.
UPDATE memos SET seq = rowid WHERE seq = 0;
UPDATE sync_counter SET n = (SELECT COALESCE(MAX(seq), 0) FROM memos) WHERE id = 1;

CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tombstones_seq ON tombstones (seq);
