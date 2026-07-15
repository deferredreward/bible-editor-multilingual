-- Stamp pipeline jobs with the scripture-lane generation (and optional source
-- identity) they were started against, so a mid-run replacement activation
-- cannot silently land AI verse applies onto a new generation.
-- Nullable: pre-migration rows and non-scripture pipelines (notes/tqs/translate)
-- leave these NULL; applyVerseUpdate only enforces the match when set.

ALTER TABLE pipeline_jobs ADD COLUMN source_generation INTEGER;
ALTER TABLE pipeline_jobs ADD COLUMN source_owner TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN source_repo TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN source_ref TEXT;

-- Per-book staging lock for concurrent stageBook workers. 'staging' means a
-- Worker has claimed the book and is mid-fetch/insert; CAS UPDATE … RETURNING
-- serializes concurrent attempts. Rebuild to widen the CHECK constraint.
CREATE TABLE scripture_lane_replacement_books_new (
  job_id TEXT NOT NULL REFERENCES scripture_lane_replacement(job_id),
  book TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'staging', 'artifact_ok', 'retryable_error', 'failed', 'absent_authorized'
  )),
  source_owner TEXT,
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  completeness_json TEXT,
  error_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (job_id, book)
);

INSERT INTO scripture_lane_replacement_books_new (
  job_id, book, status, source_owner, source_repo, source_ref,
  source_sha, completeness_json, error_json, updated_at
)
SELECT
  job_id, book, status, source_owner, source_repo, source_ref,
  source_sha, completeness_json, error_json, updated_at
FROM scripture_lane_replacement_books;

DROP TABLE scripture_lane_replacement_books;
ALTER TABLE scripture_lane_replacement_books_new RENAME TO scripture_lane_replacement_books;
