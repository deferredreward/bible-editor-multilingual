-- Case-insensitive pipeline_jobs.source_owner (issue #306, final deferred item;
-- follow-up to 0068 / 0069).
--
-- 0069 finished the org/owner NOCASE sweep for book_resource_syncs.source_owner,
-- article_units.source_org and scripture_export_baselines.owner, but deliberately
-- left pipeline_jobs.source_owner BINARY (see 0069's header note). Reason for the
-- deferral: pipeline_jobs is the only #306 column whose table carries an INBOUND
-- foreign key -- pending_imports.job_id REFERENCES pipeline_jobs(job_id)
-- (migration 0009) -- and pipeline_jobs has never been rebuilt, so a DROP/rebuild
-- has to account for that child FK. This migration handles it as its own PR so the
-- FK / parent-drop interaction can be reviewed and validated against real D1.
--
-- source_owner is a plain non-key stamp -- not in the PK, not in any index (added
-- by 0043) -- so NOCASE has no uniqueness implication: no case-variant duplicate
-- can exist to collide on the rebuilt table, so (unlike 0068/0069's PK columns) NO
-- preflight guard is needed. Why NOCASE anyway: the value is a DCS owner name,
-- which DCS treats case-insensitively and applyVerseUpdate already compares
-- case-insensitively; a BINARY column leaves a seam for a future raw-string
-- compare (or a watermark lookup keyed on it) to reintroduce the casing bug.
-- Declaring NOCASE closes it at the storage layer, matching 0068/0069.
--
-- FOREIGN KEY handling: the standard SQLite table-rebuild (CREATE _v2 ->
-- INSERT SELECT -> DROP old -> RENAME) drops pipeline_jobs while pending_imports
-- still references it. With foreign-key enforcement ON, the implicit row-DELETE of
-- that DROP trips the inbound FK. This is exactly the case SQLite's official
-- "making other kinds of table schema changes" recipe covers by disabling FK
-- enforcement around the rebuild (lang_altertable.html #7), so we lead with
-- PRAGMA foreign_keys = OFF. Notes on why this is the right/safe choice here:
--   * D1 migrations run with foreign_keys OFF by default -- which is why every
--     prior rebuild in this repo (0043, 0044, 0068, 0069) needed no FK handling
--     at all -- so on the deployed path this pragma is a no-op and the rebuild is
--     no riskier than those. The pragma is defensive belt-and-suspenders for any
--     runner that applies statements in autocommit with FKs enabled: as the first
--     statement it flips enforcement off connection-wide before the DROP.
--   * PRAGMA defer_foreign_keys is deliberately NOT used: it defers immediate
--     constraint checks to COMMIT but does not stop the parent-DROP's implicit
--     DELETE from failing, so it does not solve this case (verified in the
--     accompanying test).
--   * source_owner values are copied verbatim, so no pending_imports.job_id is
--     ever orphaned; a PRAGMA foreign_key_check after the rebuild is clean (also
--     asserted in the test). Callers/D1 restore their own foreign_keys state after
--     the migration file, exactly as the SQLite recipe prescribes.
-- The one arrangement this cannot rescue -- a runner that wraps the whole file in
-- a single transaction AND has FKs ON (PRAGMA foreign_keys is a no-op inside a
-- transaction) -- is not how D1 applies migrations; this is the FK/parent-drop
-- interaction flagged on #306 for confirmation against real D1 before applying.
--
-- The effective pre-0070 shape reproduced below is the 0008 CREATE plus every
-- later ADD COLUMN in add-order (0011, 0012, 0014, 0020, 0026, 0030, 0035, 0043,
-- 0044) -- verified against those files -- with COLLATE NOCASE added to
-- source_owner. All four indexes (0008 x2, 0014, 0026) are recreated after the
-- rename.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS pipeline_jobs_v2;
CREATE TABLE pipeline_jobs_v2 (
  job_id          TEXT    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  pipeline_type   TEXT    NOT NULL,
  book            TEXT    NOT NULL,
  start_chapter   INTEGER NOT NULL,
  end_chapter     INTEGER NOT NULL,
  session_key     TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  current_skill   TEXT,
  current_status  TEXT,
  error_kind      TEXT,
  error_message   TEXT,
  output_json     TEXT,
  raw_status_json TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_polled_at  INTEGER,
  follow_up_options TEXT,
  follow_up_job_id  TEXT,
  follow_up_chain   TEXT,
  notified_user_at  INTEGER,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  upstream_job_id   TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  options_json      TEXT,
  staged_at         INTEGER,
  import_claimed_at INTEGER,
  source_generation INTEGER,
  source_owner      TEXT COLLATE NOCASE,
  source_repo       TEXT,
  source_ref        TEXT,
  source_stamps_json TEXT
);

INSERT INTO pipeline_jobs_v2 (
  job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
  state, current_skill, current_status, error_kind, error_message, output_json,
  raw_status_json, created_at, updated_at, last_polled_at, follow_up_options,
  follow_up_job_id, follow_up_chain, notified_user_at, attempt_count,
  upstream_job_id, priority, options_json, staged_at, import_claimed_at,
  source_generation, source_owner, source_repo, source_ref, source_stamps_json
)
  SELECT
    job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
    state, current_skill, current_status, error_kind, error_message, output_json,
    raw_status_json, created_at, updated_at, last_polled_at, follow_up_options,
    follow_up_job_id, follow_up_chain, notified_user_at, attempt_count,
    upstream_job_id, priority, options_json, staged_at, import_claimed_at,
    source_generation, source_owner, source_repo, source_ref, source_stamps_json
    FROM pipeline_jobs;

DROP TABLE pipeline_jobs;
ALTER TABLE pipeline_jobs_v2 RENAME TO pipeline_jobs;

-- Recreate all four indexes exactly as before the rebuild.
CREATE INDEX pipeline_jobs_user_state     ON pipeline_jobs(user_id, state, updated_at DESC);
CREATE INDEX pipeline_jobs_scope          ON pipeline_jobs(book, start_chapter, pipeline_type, state);
CREATE INDEX pipeline_jobs_user_unnotified ON pipeline_jobs(user_id, notified_user_at, updated_at DESC);
CREATE INDEX pipeline_jobs_queue          ON pipeline_jobs(state, priority DESC, created_at ASC);
