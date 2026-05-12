// Shared tooltip body for hovering Hebrew/Greek source words. Used by both
// the aligner (verse strip + alignment-card source rows) and the main
// scripture UHB display. Falls back to lemma/POS from the USFM \w
// attributes when the UHAL/UGL row is missing a gloss/definition; says so
// explicitly when we have no entry at all.

import { Box } from "@mui/material";
import type { SourceWord } from "../lib/alignment";
import type { LexiconEntry } from "../hooks/useLexicon";

interface Props {
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint?: string | null;
}

export function SourceTooltipBody({ source, lex, twHint }: Props) {
  const lemma = lex?.lemma || source.lemma || "—";
  const pos = lex?.part_of_speech || source.morph || "—";
  return (
    <Box sx={{ fontSize: 12, maxWidth: 280, lineHeight: 1.45 }}>
      <Box sx={{ fontFamily: '"Times New Roman","SBL Hebrew",serif', fontSize: 16, mb: 0.25 }}>
        {lemma}
      </Box>
      <Box sx={{ opacity: 0.85 }}>
        {source.strong || "—"} · {pos}
      </Box>
      {lex?.gloss && <Box sx={{ mt: 0.5, fontWeight: 600 }}>{lex.gloss}</Box>}
      {lex?.definition && <Box sx={{ mt: 0.25, opacity: 0.9 }}>{lex.definition}</Box>}
      {!lex?.gloss && !lex?.definition && (
        <Box sx={{ mt: 0.5, opacity: 0.55, fontStyle: "italic" }}>
          no lexicon entry — stub in source resource
        </Box>
      )}
      {twHint && <Box sx={{ mt: 0.5 }}>tw: {twHint}</Box>}
    </Box>
  );
}
