-- Last-used workspace, persisted so the OAuth callback can land a returning
-- user in the org they last worked in (resolution order: valid be_ws cookie →
-- this column → single org match → prompt). Lives on the SHARED users table
-- (users is shared-DB data; see workspaces.ts's sharedDb) — the same migration
-- set runs against every per-org database, where the mirrored users table
-- simply carries an unused NULL column.
--
-- Nullable on purpose: NULL = "no history", which the callback resolution
-- treats as skip-to-org-matching. Written best-effort (try/catch around the
-- UPDATE) because the worker deploys before migrations apply.

ALTER TABLE users ADD COLUMN last_workspace_slug TEXT;
