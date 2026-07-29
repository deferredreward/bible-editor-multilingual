-- Restore the production editor allowlist. Run this ONLY when rebuilding or
-- re-provisioning the production database (bible_editor) from the migration set.
--
-- Why this is a script and not part of migration 0016: 0016 used to seed these
-- 10 editors, which meant every database created from the migration set got
-- them -- including each new per-org database, where they are unwanted (that is
-- what scripts/prune-seeded-editors.sql cleans up). 0016 now seeds only the
-- admin. Production, however, still depends on user_roles as its real access
-- gate, because prod does not yet have the Door43 org-roles adjustment that
-- supersedes the allowlist, and prod runs with SUPER_ADMINS = ""
-- (api/wrangler.toml [env.production.vars]) so there is no super-admin bypass.
--
-- Consequence: a prod rebuild that only replays migrations would leave these 10
-- accounts unable to sign in at all -- callbackDcsAuth checks user_roles BEFORE
-- upserting into users, so they could not mint a JWT or write. This file is the
-- explicit, reviewable restore step for that path. docs/deploy.md step 1a calls
-- it out in the provisioning runbook.
--
-- Once prod gains org-roles, this file (and the allowlist dependency) can go.
--
-- Usage -- production only, and only on a rebuild:
--   cd api
--   CLOUDFLARE_ACCOUNT_ID=5a3ffd86280d3ed086be76d955829242 \
--     npx wrangler d1 execute bible_editor --remote --env production \
--     --file=../scripts/seed-prod-editor-allowlist.sql

INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES
  ('deferredreward',    'admin'),
  ('christopherrsmith', 'editor'),
  ('Grant_Ailie',       'editor'),
  ('justplainjane47',   'editor'),
  ('pjoakes',           'editor'),
  ('richmahn',          'editor'),
  ('bcameron93',        'editor'),
  ('Carolyn1970',       'editor'),
  ('stephenwunrow',     'editor'),
  ('bethoakes',         'editor'),
  ('jessicaparks',      'editor');
