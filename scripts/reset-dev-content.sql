-- Clean-slate reset of DEV D1 — wipes all book/package/pipeline/project data
-- but KEEPS the lexicon (lexicon_entries, tw_articles), the migration ledger
-- (d1_migrations), and auth (users, sessions, user_roles). article_units is
-- NOT kept lexicon data — since migration 0050 it is org-scoped project data
-- (populated per-org from a book's imported notes) and counted by the
-- project_not_empty guard (api/src/projectConfigApply.ts hasLiveProjectData),
-- so it must be wiped along with the rest of the project for onboarding to
-- restart cleanly.
--
-- After this runs, project_config is empty → the app is back at the
-- "no project configured" onboarding entry point.
--
-- Usage (from api/):
--   Local:  npx wrangler d1 execute bible_editor_dev --local  --file ../scripts/reset-dev-content.sql
--   Remote: npx wrangler d1 execute bible_editor_dev --remote --file ../scripts/reset-dev-content.sql
--
-- SAFETY: bible_editor_dev is the DEV database only. Never point this at prod
-- (bible_editor / --env production).

-- Children before parents (FK-safe).
DELETE FROM scripture_lane_replacement_books;
DELETE FROM scripture_lane_replacement;
DELETE FROM scripture_lane_state;
DELETE FROM scripture_export_leases;
DELETE FROM scripture_export_baselines;

DELETE FROM verses;
DELETE FROM verse_statuses;
DELETE FROM verse_lane_checks;

DELETE FROM tn_rows;
DELETE FROM tq_rows;
DELETE FROM twl_rows;
DELETE FROM twl_deleted_rows;
DELETE FROM twl_unlinked_words;

DELETE FROM book_imports;
DELETE FROM book_import_locks;
DELETE FROM book_usfm_meta;
DELETE FROM book_resource_syncs;
DELETE FROM pending_imports;

DELETE FROM pipeline_jobs;
DELETE FROM export_snapshots;
DELETE FROM context_export_results;

DELETE FROM article_units;
DELETE FROM article_fetch_state;

DELETE FROM align_freq;
DELETE FROM align_freq_morph;

DELETE FROM terminology;
DELETE FROM translation_prefs;
DELETE FROM edit_log;
DELETE FROM system_alerts;

DELETE FROM project_config;
