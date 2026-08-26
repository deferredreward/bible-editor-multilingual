-- Case-insensitive org/owner columns at the schema level (issue #306, follow-up
-- to #307 / migration 0068).
--
-- 0068 made workspaces.org UNIQUE COLLATE NOCASE (the tenancy-critical column).
-- This migration finishes the remaining org/owner columns #306 called out, using
-- the same _v2 → INSERT SELECT → DROP → RENAME rebuild idiom (SQLite cannot ALTER
-- a column's collation in place):
--
--   * book_resource_syncs.source_owner        (in the composite PK)
--   * article_units.source_org                (plain, non-key column)
--   * scripture_export_baselines.owner        (in the composite PK)
--
-- Why NOCASE: these values are DCS org/owner names, which DCS treats as
-- case-insensitive, and the app already compares them case-insensitively. Storing
-- BINARY-collated columns leaves a seam where a future raw-string compare (or a
-- PK/watermark lookup keyed on one of these columns) re-introduces the casing bug.
-- Declaring NOCASE closes it at the storage layer.
--
-- NOTE on the issue's column list: #306 named `book_resource_syncs.source_org`,
-- but that column was RENAMED to `source_owner` in 0042_scripture_lanes.sql (and
-- the table rebuilt again in 0044). `source_owner` is the current column, so it is
-- the real target here. The current shapes reproduced below are the 0044 form
-- (book_resource_syncs), 0039 + 0049 + 0050 (article_units), and 0042
-- (scripture_export_baselines) — verified against those files.
--
-- DEFERRED (intentionally): pipeline_jobs.source_owner. Unlike the three tables
-- here, pipeline_jobs is referenced by an INBOUND foreign key
-- (pending_imports.job_id REFERENCES pipeline_jobs(job_id), migration 0009) and
-- has never been rebuilt, so a DROP-and-rebuild of it is materially riskier than
-- the tables above and than 0068's workspaces rebuild — and no migration in this
-- repo has ever managed foreign_keys around a rebuild. source_owner there is a
-- plain non-key stamp (no uniqueness impact), so leaving it BINARY is safe for
-- now; give it its own PR that can validate the FK/parent-drop interaction against
-- real D1. Tracked on #306.

-- =====================================================================
-- 1. book_resource_syncs.source_owner  (COLLATE NOCASE; it sits in the PK)
-- =====================================================================
-- PREFLIGHT (same rationale as 0068's): source_owner is part of the composite PK
-- (book, resource, source_generation, source_owner, source_repo, source_ref), so
-- NOCASE on it changes PK uniqueness. If the table already holds two rows that
-- differ ONLY by the case of source_owner (otherwise-identical PK), the rebuild's
-- INSERT ... SELECT would trip the new PK with a bare "UNIQUE constraint failed"
-- and leave the DB unmigratable. Deduplicating is a data decision, not something a
-- migration should guess — so fail LOUDLY and early instead. The INSERT selects one
-- row per colliding group; empty on a clean table (no-op), and on a collision the
-- named CHECK aborts and its NAME is the operator-facing error.
DROP TABLE IF EXISTS _0069_bookres_preflight;
CREATE TABLE _0069_bookres_preflight (
  k TEXT,
  CONSTRAINT abort_0069_duplicate_cased_source_owner_in_book_resource_syncs_resolve_manually CHECK (0)
);
INSERT INTO _0069_bookres_preflight (k)
  SELECT MIN(book) FROM book_resource_syncs
   GROUP BY book, resource, source_generation, source_owner COLLATE NOCASE, source_repo, source_ref
  HAVING COUNT(*) > 1;
DROP TABLE _0069_bookres_preflight;

DROP TABLE IF EXISTS book_resource_syncs_v2;
CREATE TABLE book_resource_syncs_v2 (
  book TEXT NOT NULL,
  resource TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 1,
  source_owner TEXT NOT NULL DEFAULT 'unfoldingWord' COLLATE NOCASE,
  source_repo TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT 'master',
  source_sha TEXT,
  synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  origin TEXT NOT NULL,
  PRIMARY KEY (book, resource, source_generation, source_owner, source_repo, source_ref)
);
INSERT INTO book_resource_syncs_v2 (
  book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, synced_at, origin
)
  SELECT book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, synced_at, origin
    FROM book_resource_syncs;
DROP TABLE book_resource_syncs;
ALTER TABLE book_resource_syncs_v2 RENAME TO book_resource_syncs;

-- =====================================================================
-- 2. article_units.source_org  (COLLATE NOCASE; plain non-key column)
-- =====================================================================
-- source_org is not part of any PK or index, so NOCASE here has no uniqueness
-- implication and needs no preflight. Current shape = 0039 CREATE + pre_draft_json
-- (0049) + source_org/source_repo (0050), appended in that order. The two partial
-- indexes from 0039 are recreated after the rename.
DROP TABLE IF EXISTS article_units_v2;
CREATE TABLE article_units_v2 (
  resource TEXT NOT NULL,
  path TEXT NOT NULL,
  article_id TEXT NOT NULL,
  part TEXT NOT NULL DEFAULT 'body',
  source_md TEXT NOT NULL,
  source_sha TEXT,
  target_md TEXT,
  translation_state TEXT,
  draft_meta_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  pre_draft_json TEXT,
  source_org TEXT COLLATE NOCASE,
  source_repo TEXT,
  PRIMARY KEY (resource, path)
);
INSERT INTO article_units_v2 (
  resource, path, article_id, part, source_md, source_sha, target_md, translation_state,
  draft_meta_json, version, updated_by, updated_at, deleted_at, pre_draft_json, source_org, source_repo
)
  SELECT
    resource, path, article_id, part, source_md, source_sha, target_md, translation_state,
    draft_meta_json, version, updated_by, updated_at, deleted_at, pre_draft_json, source_org, source_repo
    FROM article_units;
DROP TABLE article_units;
ALTER TABLE article_units_v2 RENAME TO article_units;
CREATE INDEX article_units_article ON article_units(resource, article_id) WHERE deleted_at IS NULL;
CREATE INDEX article_units_state ON article_units(resource, translation_state) WHERE translation_state IS NOT NULL;

-- =====================================================================
-- 3. scripture_export_baselines.owner  (COLLATE NOCASE; it sits in the PK)
-- =====================================================================
-- owner is part of the composite PK (lane, owner, repo, base_ref, book), so — like
-- book_resource_syncs above — a case-variant duplicate would trip the rebuilt PK.
-- Same named-preflight guard.
DROP TABLE IF EXISTS _0069_baselines_preflight;
CREATE TABLE _0069_baselines_preflight (
  k TEXT,
  CONSTRAINT abort_0069_duplicate_cased_owner_in_scripture_export_baselines_resolve_manually CHECK (0)
);
INSERT INTO _0069_baselines_preflight (k)
  SELECT MIN(lane) FROM scripture_export_baselines
   GROUP BY lane, owner COLLATE NOCASE, repo, base_ref, book
  HAVING COUNT(*) > 1;
DROP TABLE _0069_baselines_preflight;

DROP TABLE IF EXISTS scripture_export_baselines_v2;
CREATE TABLE scripture_export_baselines_v2 (
  lane TEXT NOT NULL,
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  book TEXT NOT NULL,
  base_sha TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (lane, owner, repo, base_ref, book)
);
INSERT INTO scripture_export_baselines_v2 (lane, owner, repo, base_ref, book, base_sha, updated_at)
  SELECT lane, owner, repo, base_ref, book, base_sha, updated_at
    FROM scripture_export_baselines;
DROP TABLE scripture_export_baselines;
ALTER TABLE scripture_export_baselines_v2 RENAME TO scripture_export_baselines;
