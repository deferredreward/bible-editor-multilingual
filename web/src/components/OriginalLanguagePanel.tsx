// Content-only, read-only panel body for a Flexible-layout region showing the
// original-language (UHB Hebrew / UGNT Greek) text of the active chapter.
// This is an EXTRACTION of the "original" line rendering ScriptureColumn
// already does in its stacked-mode body (HebrewLine + highlightsFor) — no new
// rendering or data-fetching is introduced here. The panel's own header bar
// (PanelChrome) supplies the title; this component owns only the body.

import { memo, useMemo } from "react";
import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import type { TwlRow, VerseDto } from "../sync/api";
import type { LexiconEntry } from "../hooks/useLexicon";
import { HebrewLine } from "./HebrewLine";
import { highlightsFor, type ReorderHighlight } from "../lib/highlight";
import { buildVerseIndex } from "../lib/verseRange";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionIsRtl } from "../lib/versionLabels";

// Stable empty-Map identity so passing "no lexicon yet" never defeats a
// memoized child that compares lexiconMap by reference.
const EMPTY_LEXICON: Map<string, LexiconEntry | null> = new Map();

interface Props {
  book: string;
  chapter: number;
  versesByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  reorderHighlight: ReorderHighlight | null;
  lexiconMap: Map<string, LexiconEntry | null> | null;
  twl: TwlRow[];
  /** Which original to show; defaults to whichever the chapter has (UHB preferred). */
  resource?: "uhb" | "ugnt";
  onSelectVerse: (v: number) => void;
}

function OriginalLanguagePanelInner({
  versesByVersion,
  verseNumbers,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  lexiconMap,
  twl,
  resource,
  onSelectVerse,
}: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();

  const roleCode: "UHB" | "UGNT" =
    resource === "ugnt"
      ? "UGNT"
      : resource === "uhb"
        ? "UHB"
        : versesByVersion["UHB"]
          ? "UHB"
          : "UGNT";

  const index = useMemo(
    () => buildVerseIndex(versesByVersion[roleCode]),
    [versesByVersion, roleCode],
  );

  if (!versesByVersion[roleCode]) {
    return (
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1 }}>
        <Typography color="text.secondary" variant="body2">
          {t("panelBody.noOriginal")}
        </Typography>
      </Box>
    );
  }

  const rtl = versionIsRtl(cfg, roleCode);
  const lexMap = lexiconMap ?? EMPTY_LEXICON;

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", scrollbarGutter: "stable", px: 2, py: 1 }}>
      {verseNumbers.map((v) => {
        const vObj = index[v];
        if (!vObj) return null;
        const isActive = v === activeVerse;

        let hl, prevHl, nextHl;
        if (isActive) {
          const ro = reorderHighlight;
          const aQuote = ro?.movedQuote ?? activeNoteQuote;
          const aOcc = ro?.movedQuote ? ro.movedOccurrence : activeNoteOccurrence;
          hl = highlightsFor(roleCode, vObj.content, aQuote, aOcc);
          prevHl = ro?.prevQuote ? highlightsFor(roleCode, vObj.content, ro.prevQuote, ro.prevOccurrence) : undefined;
          nextHl = ro?.nextQuote ? highlightsFor(roleCode, vObj.content, ro.nextQuote, ro.nextOccurrence) : undefined;
        }

        return (
          <Box
            key={v}
            role="button"
            tabIndex={0}
            onClick={() => onSelectVerse(v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectVerse(v);
              }
            }}
            sx={{
              display: "flex",
              gap: 1,
              alignItems: "baseline",
              px: 1,
              py: 0.5,
              mb: 0.5,
              borderRadius: 0.5,
              cursor: "pointer",
              bgcolor: isActive ? "action.selected" : undefined,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: "1.5em" }}>
              {v === 0 ? "" : v}
            </Typography>
            <Box
              dir={rtl ? "rtl" : "ltr"}
              sx={{
                flex: 1,
                fontSize: `calc(21px * var(--be-reading-scale, 1))`,
                lineHeight: 1.5,
                textAlign: "start",
                fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
              }}
            >
              <HebrewLine
                verseObjects={(vObj.content as { verseObjects?: unknown[] } | null)?.verseObjects}
                lexiconMap={lexMap}
                twl={twl}
                verseNum={v}
                highlights={hl}
                prevHighlights={prevHl}
                nextHighlights={nextHl}
                fallbackText={vObj.plain_text ?? ""}
              />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Memo comparator: compare only identity-stable DATA props. `onSelectVerse` is
// deliberately EXCLUDED — Shell passes a fresh closure each render, and
// comparing it would defeat the memo (mirrors areScriptureColumnPropsEqual in
// ScriptureColumn.tsx). Any newly-read prop must be added here too.
function areOriginalLanguagePanelPropsEqual(a: Props, b: Props): boolean {
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.versesByVersion === b.versesByVersion &&
    a.verseNumbers === b.verseNumbers &&
    a.activeVerse === b.activeVerse &&
    a.activeNoteQuote === b.activeNoteQuote &&
    a.activeNoteOccurrence === b.activeNoteOccurrence &&
    a.reorderHighlight === b.reorderHighlight &&
    a.lexiconMap === b.lexiconMap &&
    a.twl === b.twl &&
    a.resource === b.resource
  );
}

export const OriginalLanguagePanel = memo(OriginalLanguagePanelInner, areOriginalLanguagePanelPropsEqual);
