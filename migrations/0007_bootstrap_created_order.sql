-- Cold-start bootstrap pages newest-first by (created_at, id), so its first
-- page is the top of the default feed. The composite key is the keyset cursor
-- and covers every lookup the old single-column index could serve.
CREATE INDEX IF NOT EXISTS idx_memos_created_id ON memos (created_at, id);
DROP INDEX IF EXISTS idx_memos_created;
