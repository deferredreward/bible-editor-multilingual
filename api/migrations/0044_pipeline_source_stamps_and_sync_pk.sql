-- Per-lane pipeline source stamps (dual-lane generate may use divergent
-- lit/sim identities) + include source_repo in the book_resource_syncs PK.

ALTER TABLE pipeline_jobs ADD COLUMN source_stamps_json TEXT;

-- Watermark identity must include source_repo: same owner+ref across different
-- repos (e.g. en_ult → ar_avd) must not share a skip/freshness watermark.
CREATE TABLE book_resource_syncs_new (
  book TEXT NOT NULL,
  resource TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  source_owner TEXT NOT NULL DEFAULT 'unfoldingWord',
  source_repo TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT 'master',
  source_sha TEXT,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  origin TEXT NOT NULL,
  PRIMARY KEY (book, resource, source_generation, source_owner, source_repo, source_ref)
);

INSERT INTO book_resource_syncs_new (
  book, resource, source_generation, source_owner, source_repo, source_ref,
  source_sha, synced_at, origin
)
SELECT
  book, resource, source_generation, source_owner,
  COALESCE(source_repo, ''), source_ref,
  source_sha, synced_at, origin
FROM book_resource_syncs;

DROP TABLE book_resource_syncs;
ALTER TABLE book_resource_syncs_new RENAME TO book_resource_syncs;
