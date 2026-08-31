// K.4 original-language reference strip from docs/flows/ui/t6-words.html:
// the verse's source words (UHB Hebrew / UGNT Greek) rendered as tappable
// chips, each opening a small lexicon card for that word's own Strong's
// number. The mockup hand-rolled a viewport-clamped popover; MUI's Popover
// already clamps, so we use it rather than reimplementing `.flip`.
//
// Honest state matters here: the local lexicon table is empty in some
// environments (every /api/lexicon lookup 404s), so a word with no entry says
// so instead of showing an invented gloss.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import { collectSourceWordNodes } from "../../lib/quoteBuilder";
import type { LexiconEntry } from "../../hooks/useLexicon";

// Repo-relative path, not prose — kept out of the locale files so a translation
// can never break the instruction.
export const LEXICON_IMPORT_SCRIPT = "scripts/import-lexicon.mjs";

export interface SourceWord {
  text: string;
  /** Raw Strong's as stored on the \w node — the key useLexicon is called with. */
  strong: string;
  occurrence: number;
  /** 0-based position among the verse's \w tokens. */
  position: number;
}

// Flatten a UHB/UGNT verse's verseObjects to its \w tokens, projected off
// quoteBuilder's shared `collectSourceWordNodes` so this strip's chips and their
// `position` mean exactly what they mean to the picker, the aligner's index maps
// and the highlight matcher (#413). The private walk this replaced descended ANY
// node carrying `children` — broader than the shared rule at one end (it would
// have walked a `\k` keyterm milestone or a footnote's contents into the chip
// list) and its word test accepted any `type:"word"` regardless of tag, so the
// two rules could disagree in both directions.
export function collectSourceWords(verseObjects: unknown[] | null | undefined): SourceWord[] {
  if (!Array.isArray(verseObjects)) return [];
  return collectSourceWordNodes(verseObjects).map(({ node, position }) => ({
    text: String(node["text"] ?? ""),
    strong: String(node["strong"] ?? ""),
    occurrence: parseInt(String(node["occurrence"] ?? "1"), 10) || 1,
    position,
  }));
}

export interface WordsLexiconStripProps {
  words: SourceWord[];
  /** Hebrew source ⇒ the strip reads right-to-left. */
  rtl: boolean;
  label: string;
  /** From useLexicon(strongs) — keyed by the raw Strong's on each word. */
  lexicon: Map<string, LexiconEntry | null>;
}

export function WordsLexiconStrip({ words, rtl, label, lexicon }: WordsLexiconStripProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<{ el: HTMLElement; word: SourceWord } | null>(null);
  const entry = open ? lexicon.get(open.word.strong) ?? null : null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "baseline",
        gap: 1.25,
        flexWrap: "wrap",
        marginBlockEnd: 1.5,
      }}
      aria-label={t("flowVerse.lexStrip.aria")}
    >
      <Typography
        variant="caption"
        sx={{
          flex: "none",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      {words.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
          {t("flowVerse.lexStrip.noWords")}
        </Typography>
      ) : (
        // dir attribute (never a direction flip in sx) — MUI's emotion/stylis
        // RTL plugin inverts declared directions, but the attribute is safe.
        <Box
          dir={rtl ? "rtl" : "ltr"}
          sx={{
            display: "flex",
            gap: 0.75,
            flexWrap: "wrap",
            fontFamily: SCRIPTURE_FONT_STACK,
            fontSize: "1rem",
            textAlign: "start",
          }}
        >
          {words.map((w) => (
            <Box
              key={`${w.position}|${w.text}`}
              component="button"
              type="button"
              onClick={(e: React.MouseEvent<HTMLButtonElement>) =>
                setOpen({ el: e.currentTarget, word: w })
              }
              aria-haspopup="dialog"
              sx={{
                appearance: "none",
                border: "none",
                background: "transparent",
                font: "inherit",
                color: "text.primary",
                cursor: "pointer",
                minHeight: 24,
                paddingBlock: 0.25,
                paddingInline: 0.5,
                borderRadius: 1,
                "&:hover, &:focus-visible": { bgcolor: "action.hover" },
              }}
            >
              {w.text}
            </Box>
          ))}
        </Box>
      )}

      <Popover
        open={Boolean(open)}
        anchorEl={open?.el ?? null}
        onClose={() => setOpen(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 1.25, maxWidth: 280 } } }}
      >
        {open && (
          <Box sx={{ textAlign: "start" }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {open.word.strong || t("flowVerse.lexStrip.noStrongOnWord")}
            </Typography>
            {open.word.strong ? (
              entry ? (
                <>
                  {entry.lemma && (
                    <Typography
                      variant="body2"
                      dir={rtl ? "rtl" : "ltr"}
                      sx={{ fontFamily: SCRIPTURE_FONT_STACK, textAlign: "start" }}
                    >
                      {entry.lemma}
                    </Typography>
                  )}
                  <Typography variant="body2" color="text.secondary">
                    {entry.gloss ?? t("flowVerse.lexStrip.noGlossField")}
                  </Typography>
                  {entry.part_of_speech && (
                    <Typography variant="caption" color="text.secondary" component="div">
                      {entry.part_of_speech}
                    </Typography>
                  )}
                  {entry.definition && (
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {entry.definition}
                    </Typography>
                  )}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  <em>{t("flowVerse.lexStrip.noEntryForStrong")}</em>{" "}
                  {t("flowVerse.lexicon.emptyTable", { script: LEXICON_IMPORT_SCRIPT })}
                </Typography>
              )
            ) : null}
          </Box>
        )}
      </Popover>
    </Box>
  );
}
