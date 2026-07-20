-- Door43 teams as role source (read-side).
--
-- `user_roles` now holds two kinds of row:
--   'manual'   — granted by an admin through /api/admin/users (the existing
--                behaviour; every pre-existing row is one of these).
--   'dcs_team' — derived from Door43 team membership at OAuth callback and
--                re-synced on every login (api/src/dcsTeams.ts).
--
-- The distinction exists so team sync can revoke what it granted without ever
-- clobbering an admin's manual grant. Existing rows all become 'manual', which
-- is accurate — every row predating this migration was typed in by an admin.
-- Teams can still PROMOTE such a user (editor -> admin); they just can't demote
-- or delete one. See syncTeamRole in api/src/dcsTeams.ts.
--
-- `synced_at` is the unix time this row was last confirmed against Door43, used
-- by /api/auth/refresh to re-check a stale team role without hitting DCS on
-- every request. NULL on manual rows (never team-checked) and on rows carried
-- over by this migration.

ALTER TABLE user_roles ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE user_roles ADD COLUMN synced_at INTEGER;
