-- Morphology-conditioned alignment memory. For each (bible, source Strong's,
-- morph class), how often each target English surface aligned to it — i.e.
-- align_freq split by the source occurrence's morphology. `morph_class` is the
-- full head-morpheme feature string from x-morph (e.g. 'Ncmsc' = noun common
-- masculine singular CONSTRUCT, 'Ncmsa' = absolute), '' when none. Words only;
-- multi-word phrases stay strong-only in align_freq.
--
-- /api/align/suggest interpolates P(surface | strong, morph) here with the
-- strong-only P(surface | strong) from align_freq:
--   conf = λ·P(s|strong,morph) + (1-λ)·P(s|strong),  λ = n_sm / (n_sm + K)
-- so morphology-dependent rendering (construct "land of" vs absolute "the
-- land", number, verb stem) ranks correctly, backing off to strong-only where
-- a (strong, morph) cell is thin. Held-out eval (JOS/NAM/ACT): precision@1
-- 60.1 -> 61.7, function-word false-positives 6.7 -> 6.1, vs the strong-only blend.
--
-- Precomputed offline by scripts/train-aligner.mjs (emits `DELETE FROM
-- align_freq_morph;` first, so re-upload is a clean refresh). The composite PK
-- doubles as the lookup index: the endpoint filters `WHERE bible = ? AND strong
-- IN (...)`, riding the leftmost (bible, strong) columns.
CREATE TABLE align_freq_morph (
  bible TEXT NOT NULL,        -- 'ult' | 'ust'
  strong TEXT NOT NULL,       -- normalized Strong's, e.g. 'H7225'
  morph_class TEXT NOT NULL,  -- head-morpheme feature string, e.g. 'Ncmsc'; '' if none
  surface TEXT NOT NULL,      -- lowercased target surface word
  count INTEGER NOT NULL,     -- times this (strong, morph_class -> surface) alignment occurs
  PRIMARY KEY (bible, strong, morph_class, surface)
);
