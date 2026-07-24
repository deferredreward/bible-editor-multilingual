-- Note-template translation (mirrors article_units, migration 0039/0050). The
-- English note templates currently live in a read-only Google Sheet proxy
-- (noteTemplates.ts); this makes them a translatable, version-tracked D1
-- resource. Sheet columns: A=support reference, B=type, C=note template body,
-- D=stable id (e.g. 'figs-metaphor-01'). templateSync.ts diffs the sheet
-- against this table on a schedule; templates.ts exposes translate/approve
-- routes mirroring articles.ts. English serving (GET /api/note-templates)
-- is untouched by this migration — it still reads the sheet directly.
CREATE TABLE template_units (
  template_id TEXT PRIMARY KEY,       -- sheet column D (or a positional fallback id)
  support_ref TEXT NOT NULL,          -- sheet column A
  sheet_order INTEGER,                -- position within the sheet, for stable ordering
  type TEXT,                          -- sheet column B
  source_md TEXT NOT NULL,            -- sheet column C (English template body)
  source_hash TEXT NOT NULL,          -- sha256 hex of source_md, for change detection
  -- 'sheet' rows come from the Google Sheet diff (templateSync.ts); 'builtin'
  -- rows are the two hardcoded frontend quick-fill templates (TCM, buildSH in
  -- web/src/lib/noteTemplates.ts) that don't live in the sheet at all. Kept
  -- distinct so the sheet-diff soft-delete pass (anything in the DB but not in
  -- the current sheet rows) never touches built-ins — they're planned and
  -- applied as a separate set in syncTemplates.
  origin TEXT NOT NULL DEFAULT 'sheet' CHECK (origin IN ('sheet', 'builtin')),
  target_md TEXT,                     -- the translation (NULL = not started)
  translation_state TEXT,             -- NULL | 'ai_draft' | 'edited' | 'validated'
  draft_meta_json TEXT,               -- translate-report entry; may carry stale_source flag
  pre_draft_json TEXT,                -- last published {target_md}, snapshotted at draft apply
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);
CREATE INDEX template_units_support_ref ON template_units(support_ref);
CREATE INDEX template_units_state ON template_units(translation_state) WHERE translation_state IS NOT NULL;

-- Append-only English-source revision history (no unique constraint on hash —
-- sheet text can revert to a prior value and each occurrence is a real event).
CREATE TABLE template_source_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_md TEXT NOT NULL,
  support_ref TEXT NOT NULL,
  type TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX template_source_history_unit ON template_source_history(template_id, id);

-- Single-row sync bookkeeping (cron gate + manual-trigger result surface).
CREATE TABLE template_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_at INTEGER,
  last_result_json TEXT
);
