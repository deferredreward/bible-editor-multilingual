-- Scripture lane generations: lit/sim (ULT/UST) rows are keyed by
-- source_generation. Active generation is a small pointer on scripture_lane_state;
-- staging writes N+1 without touching active rows; activation flips the pointer.

-- Per-lane authoritative state (NOT served from the 60s project-config cache
-- for generation / locks / write guards / export fencing).
CREATE TABLE scripture_lane_state (
  lane TEXT PRIMARY KEY CHECK (lane IN ('lit', 'sim')),
  active_generation INTEGER NOT NULL DEFAULT 1,
  next_generation INTEGER NOT NULL DEFAULT 2,  -- next FREE generation to allocate
  active_config_json TEXT NOT NULL,
  config_revision INTEGER NOT NULL DEFAULT 1,
  replacement_job_id TEXT,
  exports_blocked INTEGER NOT NULL DEFAULT 0,
  replacement_required INTEGER NOT NULL DEFAULT 0,
  pending_target_json TEXT,  -- mandatory AVD/NAV target when replacement_required
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE scripture_lane_replacement (
  job_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK (lane IN ('lit', 'sim')),
  generation INTEGER NOT NULL,
  predecessor_generation INTEGER NOT NULL,
  predecessor_config_hash TEXT NOT NULL,
  pending_config_json TEXT NOT NULL,
  required_books_json TEXT NOT NULL,  -- frozen DISTINCT book list
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'staging', 'ready', 'completed', 'failed', 'cancelled'
  )),
  lease_owner TEXT,
  lease_fencing_token TEXT,
  lease_heartbeat_at INTEGER,
  error_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  UNIQUE (lane, generation)
);

CREATE TABLE scripture_lane_replacement_books (
  job_id TEXT NOT NULL REFERENCES scripture_lane_replacement(job_id),
  book TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'artifact_ok', 'retryable_error', 'failed', 'absent_authorized'
  )),
  source_owner TEXT,
  source_repo TEXT,
  source_ref TEXT,
  source_sha TEXT,
  completeness_json TEXT,  -- bytes / verse counts / content-length evidence
  error_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (job_id, book)
);

-- Export leases with renewable fencing tokens.
CREATE TABLE scripture_export_leases (
  lease_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL CHECK (lane IN ('lit', 'sim')),
  fencing_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'released', 'abandoned')),
  holder TEXT,
  heartbeat_at INTEGER NOT NULL,
  abandoned_at INTEGER,
  grace_until INTEGER,  -- abandoned + grace >= max Worker/DCS commit lifetime
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX scripture_export_leases_lane ON scripture_export_leases(lane, status);

-- Export-target freshness baselines (v1 coincides with source when source==export).
CREATE TABLE scripture_export_baselines (
  lane TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  book TEXT NOT NULL,
  base_sha TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (lane, owner, repo, base_ref, book)
);

-- Rebuild verses with source_generation in the PK.
CREATE TABLE verses_new (
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  bible_version TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  content_json TEXT NOT NULL,
  plain_text TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  verse_end INTEGER,
  created_by_job_id TEXT,
  PRIMARY KEY (book, chapter, verse, bible_version, source_generation)
);

INSERT INTO verses_new (
  book, chapter, verse, bible_version, source_generation,
  content_json, plain_text, version, updated_by, updated_at, verse_end, created_by_job_id
)
SELECT
  book, chapter, verse, bible_version, 1,
  content_json, plain_text, version, updated_by, updated_at, verse_end, NULL
FROM verses;

DROP TABLE verses;
ALTER TABLE verses_new RENAME TO verses;
CREATE INDEX verses_chapter ON verses(book, chapter, bible_version, source_generation);
CREATE INDEX verses_range_lookup
  ON verses (book, chapter, bible_version, source_generation, verse, verse_end);

-- book_usfm_meta: generation-scoped
CREATE TABLE book_usfm_meta_new (
  book TEXT NOT NULL,
  bible_version TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  headers_json TEXT NOT NULL,
  created_by_job_id TEXT,
  PRIMARY KEY (book, bible_version, source_generation)
);

INSERT INTO book_usfm_meta_new (book, bible_version, source_generation, headers_json, created_by_job_id)
SELECT book, bible_version, 1, headers_json, NULL FROM book_usfm_meta;

DROP TABLE book_usfm_meta;
ALTER TABLE book_usfm_meta_new RENAME TO book_usfm_meta;

-- book_resource_syncs: generation + full source identity
CREATE TABLE book_resource_syncs_new (
  book TEXT NOT NULL,
  resource TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  source_owner TEXT NOT NULL DEFAULT 'unfoldingWord',
  source_repo TEXT,
  source_ref TEXT NOT NULL DEFAULT 'master',
  source_sha TEXT,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  origin TEXT NOT NULL,
  PRIMARY KEY (book, resource, source_generation, source_owner, source_ref)
);

INSERT INTO book_resource_syncs_new (
  book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, synced_at, origin
)
SELECT book, resource, 1, COALESCE(source_org, 'unfoldingWord'), NULL, 'master', source_sha, synced_at, origin
FROM book_resource_syncs;

DROP TABLE book_resource_syncs;
ALTER TABLE book_resource_syncs_new RENAME TO book_resource_syncs;

-- Stamp edit_log for verse rows with generation 1 (legacy).
-- New column is nullable for pre-migration / non-verse rows.
ALTER TABLE edit_log ADD COLUMN source_generation INTEGER;

-- Activation atomicity: completing a job is only legal when the lane already
-- points at that job's generation (pointer flip happened first in the same txn).
-- Flipping the pointer is only legal when the matching job is ready with the
-- expected fencing token (enforced in the UPDATE WHERE … EXISTS). If a split
-- brain would remain, RAISE(ABORT) rolls back the whole transaction.
CREATE TRIGGER trg_activation_job_completed
AFTER UPDATE OF status ON scripture_lane_replacement
WHEN NEW.status = 'completed' AND OLD.status IS NOT 'completed'
BEGIN
  SELECT RAISE(ABORT, 'activation_invariant_job_completed_without_pointer')
  WHERE NOT EXISTS (
    SELECT 1 FROM scripture_lane_state s
    WHERE s.lane = NEW.lane
      AND s.active_generation = NEW.generation
      AND s.replacement_job_id IS NULL
  );
END;

CREATE TRIGGER trg_activation_pointer_flip
AFTER UPDATE OF active_generation ON scripture_lane_state
WHEN NEW.active_generation IS NOT OLD.active_generation
BEGIN
  -- After a pointer flip, there must be a ready-or-just-completed job for that
  -- generation, OR this is a bootstrap (generation stays 1) — reject orphan flips.
  SELECT RAISE(ABORT, 'activation_invariant_pointer_without_job')
  WHERE NEW.active_generation <> 1
    AND NOT EXISTS (
      SELECT 1 FROM scripture_lane_replacement j
      WHERE j.lane = NEW.lane
        AND j.generation = NEW.active_generation
        AND j.status IN ('ready', 'completed')
    );
END;

-- Seed lane state from current project_config preset after migrate.
-- Application code (ensureLaneState) also upserts; this gives empty DBs a row.
-- Actual AVD/NAV / replacement_required decisions are applied by the worker
-- on first ensureLaneState call (needs COUNT of verses).
