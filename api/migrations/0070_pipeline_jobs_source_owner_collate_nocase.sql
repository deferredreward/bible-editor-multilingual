-- Case-insensitive pipeline_jobs.source_owner (issue #306, final deferred item;
-- follow-up to 0068 / 0069).
--
-- 0069 finished the org/owner NOCASE sweep for book_resource_syncs.source_owner,
-- article_units.source_org and scripture_export_baselines.owner, but deliberately
-- left pipeline_jobs.source_owner BINARY (see 0069's header note). Reason for the
-- deferral: pipeline_jobs is the only #306 column whose table carries an INBOUND
-- foreign key -- pending_imports.job_id REFERENCES pipeline_jobs(job_id)
-- (migration 0009) -- and pipeline_jobs has never been rebuilt, so a DROP/rebuild
-- has to account for that child FK.
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
-- FOREIGN KEY handling -- why this migration rebuilds TWO tables:
--
-- SQLite's official table-rebuild recipe (lang_altertable.html #7) says to wrap
-- the rebuild in PRAGMA foreign_keys = OFF, because dropping a referenced parent
-- performs an implicit DELETE that trips the inbound FK. That recipe CANNOT be
-- used on D1, for two independent reasons, both verified against workerd's D1
-- (miniflare) by driving this file through wrangler's own statement splitter:
--
--   * D1 runs with foreign_keys ON and IGNORES `PRAGMA foreign_keys = OFF`.
--     The statement reports success, but a read-back still returns 1 and FK
--     enforcement still bites -- even outside any explicit transaction.
--     (Cloudflare documents defer_foreign_keys as the only available lever.)
--   * `wrangler d1 migrations apply` sends the whole file as ONE transaction
--     (locally via D1's batch(); remotely as a single multi-statement /query),
--     and PRAGMA foreign_keys is a no-op inside a transaction anyway.
--
-- PRAGMA defer_foreign_keys does not rescue it either: deferring moves the check
-- to COMMIT, but the parent DROP's implicit DELETE increments the deferred
-- violation counter and re-creating the parent under the same name does not
-- decrement it, so the COMMIT still fails (asserted in the accompanying test).
--
-- The prior rebuilds in this repo (0043, 0044, 0068, 0069) needed no FK handling
-- not because enforcement was off, but because none of those tables had an
-- INBOUND foreign key -- there was no child row for the parent DROP to orphan.
--
-- So instead of disabling enforcement, this migration never violates it: the
-- child (pending_imports) is rebuilt alongside the parent, pointed at the new
-- parent BEFORE either old table is dropped. Order matters:
--
--   1. build pipeline_jobs_v2 (NOCASE) and copy every row,
--   2. build pending_imports_v2 REFERENCING pipeline_jobs_v2 and copy every row
--      (its parents already exist in _v2, so the copy satisfies the FK),
--   3. DROP pending_imports  -- nothing references it, so no FK to violate,
--   4. DROP pipeline_jobs    -- now childless, so its implicit DELETE is clean,
--   5. RENAME pipeline_jobs_v2 -> pipeline_jobs. With FKs ON, SQLite rewrites
--      REFERENCES clauses that name the renamed table, so pending_imports_v2's
--      clause becomes REFERENCES "pipeline_jobs"(job_id) automatically,
--   6. RENAME pending_imports_v2 -> pending_imports,
--   7. recreate every index on both tables.
--
-- No row is ever orphaned, PRAGMA foreign_key_check is clean afterwards, and FK
-- enforcement is never disabled (nor relied upon to be). pending_imports keeps
-- its INTEGER PRIMARY KEY AUTOINCREMENT and its `id` values are copied
-- explicitly, so existing pending_imports.id references stay valid.
--
-- The effective pre-0070 shapes reproduced below are: pipeline_jobs = the 0008
-- CREATE plus every later ADD COLUMN in add-order (0011, 0012, 0014, 0020, 0026,
-- 0030, 0035, 0043, 0044), with COLLATE NOCASE added to source_owner only;
-- pending_imports = migration 0009 verbatim (never altered since). All four
-- pipeline_jobs indexes (0008 x2, 0014, 0026) and both pending_imports indexes
-- (0009, including the PARTIAL one) are recreated after the renames.

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

-- The child, rebuilt against the NEW parent so every copied row's FK resolves.
-- Shape is migration 0009 verbatim, except the REFERENCES target (which the
-- rename below rewrites back to pipeline_jobs).
DROP TABLE IF EXISTS pending_imports_v2;
CREATE TABLE pending_imports_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL REFERENCES pipeline_jobs_v2(job_id),
  kind            TEXT    NOT NULL,
  book            TEXT    NOT NULL,
  chapter         INTEGER NOT NULL,
  verse           INTEGER NOT NULL,
  bible_version   TEXT,
  payload_json    TEXT    NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at     INTEGER,
  accepted_by     INTEGER REFERENCES users(id),
  rejected_at     INTEGER,
  rejected_by     INTEGER REFERENCES users(id)
);

INSERT INTO pending_imports_v2 (
  id, job_id, kind, book, chapter, verse, bible_version, payload_json,
  created_at, accepted_at, accepted_by, rejected_at, rejected_by
)
  SELECT
    id, job_id, kind, book, chapter, verse, bible_version, payload_json,
    created_at, accepted_at, accepted_by, rejected_at, rejected_by
    FROM pending_imports;

DROP TABLE pending_imports;
DROP TABLE pipeline_jobs;
ALTER TABLE pipeline_jobs_v2 RENAME TO pipeline_jobs;
ALTER TABLE pending_imports_v2 RENAME TO pending_imports;

-- Recreate all four pipeline_jobs indexes exactly as before the rebuild.
CREATE INDEX pipeline_jobs_user_state     ON pipeline_jobs(user_id, state, updated_at DESC);
CREATE INDEX pipeline_jobs_scope          ON pipeline_jobs(book, start_chapter, pipeline_type, state);
CREATE INDEX pipeline_jobs_user_unnotified ON pipeline_jobs(user_id, notified_user_at, updated_at DESC);
CREATE INDEX pipeline_jobs_queue          ON pipeline_jobs(state, priority DESC, created_at ASC);

-- ...and both pending_imports indexes from 0009, including the partial one.
CREATE INDEX pending_imports_job   ON pending_imports(job_id);
CREATE INDEX pending_imports_scope ON pending_imports(book, chapter, kind)
  WHERE accepted_at IS NULL AND rejected_at IS NULL;
