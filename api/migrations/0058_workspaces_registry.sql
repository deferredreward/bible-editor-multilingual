-- Workspace registry — the org-per-D1 roster becomes DATA instead of the
-- `WORKSPACES` env-var JSON (docs/deferred.md item 1; issue #81, PR-1).
--
-- This table lives on the SHARED database (accounts/sessions/lexicon — the one
-- binding present in every deployment, resolved via workspaces.ts's sharedDb).
-- Like every other migration it also runs against each per-org database, where
-- the mirrored copy simply goes unread (only the shared DB's copy is consulted;
-- see readRegistry in workspaces.ts).
--
-- PR-1 is a zero-behavior-change relocation: workspaces.ts now reads the roster
-- from here, FALLING BACK to parsing `WORKSPACES` and then the implicit single
-- default, so a missing/empty table (migration not yet applied, or a fresh
-- deployment) behaves exactly as before. The table is seeded from `WORKSPACES`
-- on first boot when it is empty. PR-1 only ever writes `claimed` rows.
--
-- The `status` column is here NOW even though PR-1 uses only 'claimed', because
-- the spare-pool provisioning model (issue #81, later PRs) pre-provisions empty
-- migrated D1 bindings as `available` rows and claims one on org onboard. Only
-- `claimed` rows are listable workspaces; the rest are lifecycle bookkeeping.
--
-- Nullable columns, deliberately:
--   org           — an `available` spare-pool slot has no org until claimed.
--                   UNIQUE still guarantees at most one workspace per org
--                   (SQLite lets a UNIQUE column hold many NULLs, so any number
--                   of unclaimed slots coexist).
--   label         — a spare slot has no human label until claimed. Every
--                   `claimed` row carries one (parseEntry rejects an empty one).
--   database_uuid — the Cloudflare D1 database id, recorded once dynamic
--                   provisioning (later PR) creates DBs over the HTTP API. For
--                   PR-1's pre-provisioned bindings it stays NULL.
--   export_owner  — optional per-workspace DCS_EXPORT_OWNER override, mirroring
--                   the Workspace.exportOwner field.
--
-- `binding` is the name of the D1 binding on Env that holds this workspace's
-- content (e.g. "DB", "DB_MLTEST"). parseEntry still validates that it resolves
-- to a live D1Database before a row is trusted — that check is the future
-- pool-slot validity gate, so it must keep working on registry-sourced rows.

CREATE TABLE IF NOT EXISTS workspaces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  label          TEXT,
  org            TEXT UNIQUE,
  binding        TEXT NOT NULL,
  database_uuid  TEXT,
  export_owner   TEXT,
  status         TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available', 'claimed', 'provisioning', 'failed', 'retired')),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- listWorkspaces reads `WHERE status = 'claimed' ORDER BY id`; the partial index
-- keeps that lookup cheap once the pool holds many unclaimed/retired rows.
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces (status);
