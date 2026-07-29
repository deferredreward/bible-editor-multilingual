-- Remove the 10 editor rows that 0016 used to seed into every database.
--
-- Why: the migration set runs against EVERY D1 in this project, including each
-- new per-org database (e.g. bible_editor_mltest_dev via DB_MLTEST). That meant
-- a brand-new org started life with 11 allowlisted accounts it never asked for.
-- 0016 has been trimmed to seed only the admin, which fixes future databases;
-- this migration cleans up the ones already created.
--
-- The list is explicit rather than `WHERE role = 'editor'` on purpose: an admin
-- may legitimately have added editors via SQL since 0016 ran, and a blanket
-- delete would revoke them too.
--
-- user_roles is a real access gate — callbackDcsAuth checks it BEFORE upserting
-- into users, so deleting a row revokes that account's ability to mint a JWT.

DELETE FROM user_roles WHERE role = 'editor' AND dcs_username IN (
  'christopherrsmith',
  'Grant_Ailie',
  'justplainjane47',
  'pjoakes',
  'richmahn',
  'bcameron93',
  'Carolyn1970',
  'stephenwunrow',
  'bethoakes',
  'jessicaparks'
);
