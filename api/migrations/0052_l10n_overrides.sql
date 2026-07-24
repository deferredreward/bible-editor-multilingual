-- UI-string localization overrides (Localization tab in the Preferences panel).
-- The interface strings ship as static per-language JSON bundled into the app at
-- build time (web/src/i18n/locales/*.json). This table is a server-side "fast
-- lane" layered on top of those bundles at startup: an admin edits a string in
-- their language, it saves here, and every user on that language picks it up on
-- next load — no rebuild. Edits are periodically exported to a drop-in locale
-- JSON and folded back into the bundled files via PR; once shipped, the matching
-- override row is redundant and can be cleared.
--
-- One row per language. overrides_json is a nested {namespace:{key:"text"}} bag
-- (same shape react-i18next's addResourceBundle deep-merges over the base). The
-- version column drives If-Match optimistic concurrency exactly like
-- translation_prefs (0040): first write sends If-Match: 0, thereafter the UPDATE
-- bumps version guarded on the expected value.
CREATE TABLE l10n_overrides (
  lang           TEXT PRIMARY KEY,                        -- UI language code (en, ar, es, …)
  overrides_json TEXT    NOT NULL DEFAULT '{}',           -- nested {ns:{key:"text"}} override bag
  version        INTEGER NOT NULL DEFAULT 1,              -- If-Match CAS
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by     INTEGER REFERENCES users(id)
);
