-- tW / tA translatable markdown articles (FEASIBILITY Phase 4; design in
-- docs/design/tw-ta-translation-modules.md §1). One row per markdown FILE, keyed
-- by repo-relative path — so the translate pipeline's path-keyed id round-trip
-- (bp-assistant articles envelope: the in-repo path is the stable identity) and
-- export are both a direct path→target_md mapping.
--
-- path / article_id conventions match the bot's deriveArticleId:
--   tW: path 'bible/kt/god.md'            → article_id 'kt/god'          (part 'body')
--   tA: path 'translate/figs-aside/01.md' → article_id 'translate/figs-aside' (part 'body')
--       'translate/figs-aside/title.md'   → same article_id, part 'title'
--       'translate/figs-aside/sub-title.md' → same article_id, part 'sub-title'
--
-- translation_state mirrors tn_rows/tq_rows (NULL | ai_draft | edited | validated).
-- NULL for the English root project (authoring, not translating) so the English
-- workflow is untouched. Never DELETEd by the importer — target_md is precious.
CREATE TABLE article_units (
  resource TEXT NOT NULL,            -- 'tw' | 'ta'
  path TEXT NOT NULL,                -- repo-relative markdown path (the round-trip id)
  article_id TEXT NOT NULL,          -- grouping key: 'kt/god', 'translate/figs-aside'
  part TEXT NOT NULL DEFAULT 'body', -- 'body' | 'title' | 'sub-title'
  source_md TEXT NOT NULL,           -- English markdown, refreshed on reimport
  source_sha TEXT,                   -- DCS blob sha of source_md at import (stale-detection)
  target_md TEXT,                    -- the translation (NULL = not started)
  translation_state TEXT,            -- NULL | 'ai_draft' | 'edited' | 'validated'
  draft_meta_json TEXT,              -- translate-report entry (confidence/violations); NULL if none
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (resource, path)
);
CREATE INDEX article_units_article ON article_units(resource, article_id) WHERE deleted_at IS NULL;
CREATE INDEX article_units_state ON article_units(resource, translation_state) WHERE translation_state IS NOT NULL;
