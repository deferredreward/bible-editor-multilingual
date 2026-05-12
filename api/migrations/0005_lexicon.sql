-- Hebrew/Aramaic + Greek lexicon for hover tooltips and definition lookups.
-- One row per Strong's number. Populated by scripts/import-lexicon.mjs from
-- the unfoldingWord UHAL and UGL resources on DCS. Re-runnable: the import
-- script begins with DELETE FROM, so the table is the authoritative cache.

CREATE TABLE lexicon_entries (
  strong TEXT PRIMARY KEY,                -- normalized: "H2320", "G1410"
  resource TEXT NOT NULL,                 -- 'uhal' | 'ugl'
  lemma TEXT,                             -- dictionary form (Hebrew / Greek)
  part_of_speech TEXT,
  gloss TEXT,                             -- terse, shown in tooltip
  definition TEXT                         -- longer paragraph
);
CREATE INDEX lexicon_resource ON lexicon_entries(resource);
