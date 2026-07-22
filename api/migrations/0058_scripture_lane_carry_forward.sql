-- Selective / "new-only" scripture-lane replacement (issue #94), PR-1 (dormant).
--
-- A replacement stages into a FRESH generation that starts EMPTY: stageBook
-- writes only the books it stages, activation flips the pointer. So a subset
-- stage would leave every un-staged book EMPTY on the new generation — silently
-- deleting the books the user meant to protect (the JOL/MAL trap, 2026-07-22).
--
-- The chosen fix is a per-book CARRY-FORWARD copy: un-selected books have their
-- predecessor-generation verses copied into gen N+1 so activation is lossless.
-- This migration adds the two schema affordances that copy needs, and nothing
-- else — no code path sets `mode` or produces `carried_forward` yet (PR-2 wires
-- startReplacement/routes/UI).
--
--   * a per-book `mode` column ('staged' | 'carry_forward', default 'staged')
--     recording HOW a book reaches the new generation.
--   * a `carried_forward` book status (parallel to 'artifact_ok') for a book
--     whose predecessor content was copied forward rather than re-fetched.
--
-- Widening a CHECK constraint requires the table-rebuild pattern (create _new,
-- INSERT SELECT, drop, rename) already used in 0042/0043. Current columns are
-- those from 0043 (added 'staging' + rebuilt PK) plus `staging_claim_token`
-- from 0045; all are preserved. This table carries no secondary indexes or
-- triggers, so there is nothing to recreate after the rename.

CREATE TABLE scripture_lane_replacement_books_new (
  job_id TEXT NOT NULL REFERENCES scripture_lane_replacement(job_id),
  book TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'staging', 'artifact_ok', 'carried_forward',
    'retryable_error', 'failed', 'absent_authorized'
  )),
  mode TEXT NOT NULL DEFAULT 'staged' CHECK (mode IN ('staged', 'carry_forward')),
  source_owner TEXT,
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  completeness_json TEXT,
  error_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  staging_claim_token TEXT,
  PRIMARY KEY (job_id, book)
);

INSERT INTO scripture_lane_replacement_books_new (
  job_id, book, status, source_owner, source_repo, source_ref,
  source_sha, completeness_json, error_json, updated_at, staging_claim_token
)
SELECT
  job_id, book, status, source_owner, source_repo, source_ref,
  source_sha, completeness_json, error_json, updated_at, staging_claim_token
FROM scripture_lane_replacement_books;

DROP TABLE scripture_lane_replacement_books;
ALTER TABLE scripture_lane_replacement_books_new RENAME TO scripture_lane_replacement_books;
