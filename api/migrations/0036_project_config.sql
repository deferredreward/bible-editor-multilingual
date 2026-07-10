-- Per-project source configuration (multilingual). One row per database —
-- the tenancy model is one D1 per language project (FEASIBILITY §4 Option A).
-- `preset` names a code-defined preset in api/src/projectConfig.ts;
-- `overrides_json` optionally overrides individual fields. Absence of the
-- row (or the table, pre-migration) means the en-unfoldingword default,
-- which reproduces the previously hardcoded unfoldingWord/en_* behavior.
CREATE TABLE IF NOT EXISTS project_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  preset TEXT NOT NULL,
  overrides_json TEXT,
  updated_at INTEGER NOT NULL
);

-- Watermarks (book_resource_syncs, 0028) were previously implicitly keyed to
-- the unfoldingWord source org. Record the org each SHA was observed under so
-- a project whose config points elsewhere doesn't trust a stale watermark.
-- Reads treat a mismatched source_org as "no watermark" (fresh import).
ALTER TABLE book_resource_syncs ADD COLUMN source_org TEXT NOT NULL DEFAULT 'unfoldingWord';
