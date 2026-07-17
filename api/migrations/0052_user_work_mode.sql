-- Adds:
--  * work_mode — per-user Translate/Author view toggle (PR C). NULL = no
--    stored preference; the client derives an effective default from the
--    active project's translationSource rather than defaulting this column.
--  * dcs_orgs_json / dcs_orgs_fetched_at — cached DCS org membership for this
--    user (JSON array of org logins), refreshed best-effort on OAuth sign-in.
--    NULL/NULL = never successfully fetched (distinct from a fetch that
--    legitimately returned zero orgs, which stores '[]' + a fresh timestamp).
ALTER TABLE users ADD COLUMN work_mode TEXT CHECK (work_mode IN ('translate','author'));
ALTER TABLE users ADD COLUMN dcs_orgs_json TEXT;
ALTER TABLE users ADD COLUMN dcs_orgs_fetched_at INTEGER;
