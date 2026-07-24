-- Stash for the manual role a Door43 team signal overwrote (teams-win
-- precedence, api/src/dcsTeams.ts). When team sync takes over a
-- source='manual' row it records the prior manual role here; when the team
-- signal later disappears (user removed from the team — or the team renamed/
-- deleted, which looks identical), the row is RESTORED to
-- (role=manual_role, source='manual') instead of deleted. Without this stash,
-- a team rename/deletion would wipe every formerly-manual grant org-wide.
-- Rows with manual_role NULL are pure team creations and still delete on
-- signal loss. An admin PUT takes manual ownership (source='manual') and
-- clears the stash.
--
-- NULL for every existing row: nothing has been stashed yet. Team sync
-- statements reference this column, so between deploying the worker and
-- applying this migration team sync no-ops harmlessly (same failure window
-- migration 0055 documented; syncTeamRoleForUser swallows the D1 error).

ALTER TABLE user_roles ADD COLUMN manual_role TEXT
  CHECK (manual_role IN ('admin', 'editor') OR manual_role IS NULL);
