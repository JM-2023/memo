-- Make the storage format explicit. Existing deployments used the enc1: prefix
-- as their only marker, so this one-time classification preserves those rows;
-- all future writes set content_format directly and may safely store plaintext
-- whose literal content begins with "enc1:".
ALTER TABLE memos ADD COLUMN content_format TEXT NOT NULL DEFAULT 'plain';
ALTER TABLE memos ADD COLUMN mutation_token TEXT NOT NULL DEFAULT '';
-- Immutable create identity/version distinguish a genuine lost-response retry
-- from an unrelated or subsequently edited row that happens to share the id.
ALTER TABLE memos ADD COLUMN creation_token TEXT NOT NULL DEFAULT '';
ALTER TABLE memos ADD COLUMN creation_seq INTEGER NOT NULL DEFAULT 0;
UPDATE memos SET content_format = 'enc1' WHERE substr(content, 1, 5) = 'enc1:' COLLATE BINARY;

-- A stable database-history id lets sleeping clients detect a replaced D1
-- even if the new counter has already grown past their old numeric cursor.
ALTER TABLE sync_counter ADD COLUMN sync_epoch TEXT NOT NULL DEFAULT '';
UPDATE sync_counter SET sync_epoch = lower(hex(randomblob(16))) WHERE id = 1 AND sync_epoch = '';

-- Multi-request tag rewrites use a short renewable lease so two tabs cannot
-- interleave different global rename/remove operations into a mixed result.
CREATE TABLE IF NOT EXISTS tag_operation_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT,
  expires_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);

-- Keyset/sequence scans use the stable entity key to order rows sharing a seq.
CREATE INDEX IF NOT EXISTS idx_memos_seq_id ON memos (seq, id);
CREATE INDEX IF NOT EXISTS idx_tombstones_seq_id ON tombstones (seq, id);
CREATE INDEX IF NOT EXISTS idx_tag_meta_seq_path ON tag_meta (seq, path);
-- Encryption verification/backfill walks only rows that still need work.
CREATE INDEX IF NOT EXISTS idx_memos_content_format_id ON memos (content_format, id);

-- Attachment metadata and binary lookups are always memo-scoped and ordered.
CREATE INDEX IF NOT EXISTS idx_memo_images_memo_ord ON memo_images (memo_id, ord);

-- The composite indexes above fully cover these older single-prefix indexes;
-- retaining both would double B-tree maintenance on every synchronized write.
DROP INDEX IF EXISTS idx_memos_seq;
DROP INDEX IF EXISTS idx_tombstones_seq;
DROP INDEX IF EXISTS idx_tag_meta_seq;
DROP INDEX IF EXISTS idx_memo_images_memo;
