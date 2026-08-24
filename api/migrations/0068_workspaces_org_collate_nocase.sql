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
