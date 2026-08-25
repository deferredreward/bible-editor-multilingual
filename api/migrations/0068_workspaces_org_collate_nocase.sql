-- Make workspaces.org case-insensitive at the schema level (issue #306).
--
-- workspaces.org (0058) is `TEXT UNIQUE` with the default BINARY collation, so
-- the UNIQUE index would accept BOTH `bsoj` and `BSOJ` as distinct rows even
-- though they are the same DCS org. That UNIQUE constraint is the one-org-per-
-- workspace tenancy guard, so a duplicate-cased claim is a tenancy hazard, not
-- a cosmetic one. SQLite cannot ALTER a column's collation in place, so rebuild
-- the table (the same _v2 → INSERT SELECT → DROP → RENAME idiom used by
-- 0061_book_source_ranges.sql) with `org TEXT UNIQUE COLLATE NOCASE`.
--
-- Everything else is copied byte-for-byte from 0058: same columns, defaults,
-- status CHECK, AUTOINCREMENT PK, and the idx_workspaces_status partial-lookup
-- index. Multi-NULL org is preserved (SQLite lets a UNIQUE column hold many
-- NULLs regardless of collation), so unclaimed spare-pool slots still coexist.
--
-- NOTE: the other org/owner columns called out in #306
-- (book_resource_syncs.source_org/.source_owner, article_units.source_org,
-- scripture_export_baselines.owner, pipeline_jobs.source_owner) are intentionally
-- LEFT for a follow-up: each needs its full current post-migration schema
-- reproduced exactly, and none carries a tenancy-critical UNIQUE constraint the
-- way workspaces.org does. The one-time data normalization of existing mis-cased
-- rows (project_config / scripture_lane_state) is also deferred — it touches prod
-- tenancy data and needs explicit per-environment go-ahead (see #306).

-- PREFLIGHT (issue #306, codex review of #307). The rebuild below copies every
-- row into a table whose `org` is UNIQUE COLLATE NOCASE, so if this registry
-- ALREADY holds a case-variant pair -- exactly the state this migration exists
-- to prevent -- the INSERT ... SELECT trips the new constraint and 0068 aborts
-- with a bare "UNIQUE constraint failed" and no indication of which orgs are at
-- fault. Deploy runs migrations before deploying, so that leaves the database
-- unmigratable until an operator resolves it by hand.
--
-- Deliberately NOT auto-deduplicated: two claimed slots under the same org are
-- live tenancy data (each may already hold a different tenant's translation
-- work), and picking a loser is a per-environment human decision -- see the
-- Deferred section of #307 and the data-normalization note in #306.
--
-- So: fail LOUDLY and early instead. The INSERT below selects one row per
-- offending org group; when there are none it inserts nothing and this is a
-- no-op. When there are any, CHECK (0) aborts the migration and the error names
-- this table, which names the problem. Resolve the duplicates (retire or
-- re-point the losing slot), then re-run the migration.
DROP TABLE IF EXISTS _0068_preflight;
CREATE TABLE _0068_preflight (
  org TEXT,
  -- Named, because SQLite's failure message quotes the CONSTRAINT NAME (an
  -- anonymous `CHECK (0)` reports only "CHECK constraint failed: 0"). The name
  -- IS the error message the operator will see in the deploy log.
  CONSTRAINT abort_0068_duplicate_cased_org_in_workspaces_resolve_manually CHECK (0)
);
INSERT INTO _0068_preflight (org)
  SELECT MIN(org) FROM workspaces
   WHERE org IS NOT NULL
   GROUP BY org COLLATE NOCASE
  HAVING COUNT(*) > 1;
DROP TABLE _0068_preflight;

-- Idempotent retry: a previous run that aborted at the INSERT below (or at the
-- preflight, once that is fixed) may have left workspaces_v2 behind, which
-- would make the re-run fail on CREATE TABLE instead of on the real problem.
DROP TABLE IF EXISTS workspaces_v2;
CREATE TABLE workspaces_v2 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  label          TEXT,
  org            TEXT UNIQUE COLLATE NOCASE,
  binding        TEXT NOT NULL,
  database_uuid  TEXT,
  export_owner   TEXT,
  status         TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available', 'claimed', 'provisioning', 'failed', 'retired')),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO workspaces_v2 (id, slug, label, org, binding, database_uuid, export_owner, status, created_at, updated_at)
  SELECT id, slug, label, org, binding, database_uuid, export_owner, status, created_at, updated_at FROM workspaces;

DROP TABLE workspaces;
ALTER TABLE workspaces_v2 RENAME TO workspaces;

CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces (status);
