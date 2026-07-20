-- Door43 teams as role source (read-side).
--
-- `user_roles` now holds two kinds of row:
--   'manual'   — granted by an admin through /api/admin/users (the existing
--                behaviour; every pre-existing row is one of these).
--   'dcs_team' — derived from Door43 team membership at OAuth callback and
--                re-synced on every login (api/src/dcsTeams.ts).
--
-- The distinction exists so team sync can revoke what it granted without ever
-- clobbering an admin's manual grant.

ALTER TABLE user_roles ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
