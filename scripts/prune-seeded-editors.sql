-- Remove the 10 editor rows that migration 0016 used to seed into every database.
--
-- NOT A MIGRATION, deliberately. Run this by hand, per database, and never
-- against production.
--
-- Background: 0016 seeded 1 admin + 10 editors. The migration set runs against
-- EVERY D1 in this project, including each new per-org database (e.g.
-- bible_editor_mltest_dev via DB_MLTEST), so a brand-new org started life with
-- 11 allowlisted accounts it never asked for. 0016 has since been trimmed to
-- seed only the admin, which fixes every database created from here on; this
-- file cleans up the databases that already exist.
--
-- Why not a migration: user_roles is a real access gate — callbackDcsAuth checks
-- it BEFORE upserting into users, so deleting a row revokes that account's
-- ability to mint a JWT and write. PRODUCTION (bible_editor) still depends on
-- this allowlist as its access control, because prod does not yet have the
-- Door43 org-roles adjustment that supersedes it. A migration runs everywhere
-- by definition and would therefore lock those editors out of prod. Once prod
-- gets org-roles, this can be applied there too — or promoted to a migration.
--
-- The usernames are listed explicitly rather than `WHERE role = 'editor'` so any
-- editor an admin legitimately added via SQL since 0016 ran survives.
--
-- Usage (dev databases only — a plain --remote targets dev):
--   cd api
--   CLOUDFLARE_ACCOUNT_ID=5a3ffd86280d3ed086be76d955829242 \
--     npx wrangler d1 execute bible_editor_mltest_dev --remote \
--     --file=../scripts/prune-seeded-editors.sql

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
