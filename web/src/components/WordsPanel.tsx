// WordsPanel — the translationWords (TWL) resource panel.
//
// `WordsPanelBody` is the content-only render of the Words view: a SectionHead,
// the WordsTable (per-verse or whole-chapter grouped), and the per-verse
// TwlSuggestions block. It owns NO state and NO scroll container — the caller
// provides the derived rows + callbacks and positions it inside a scroll body.
// This is the single source of truth shared by BOTH the classic tabbed
// ResourceColumn (which renders it inside its shared scroll body) and the
// standalone stacked layout panel (which wraps it in its own scroll body).
//
// The JSX here is lifted verbatim from ResourceColumn's `activeResourceTab ===
// "words"` block so the classic Words tab stays byte-identical.

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Box, Typography } from "@mui/material";
import type { TwlRow, TwlSuggestion } from "../sync/api";
import { WordsTable, type WordDropPosition } from "./WordsTable";
import { TwlSuggestions } from "./TwlSuggestions";
import { SectionHead, VerseGroupHead, type ResourceCheckoff } from "./resourcePanelShared";

export interface WordsPanelBodyProps {
  book: string;
  chapter: number;
  activeVerse: number;
  // Derived, ordered rows (canonical TWL order). `twlGroups` non-null ⇒ pinned
  // whole-chapter view (grouped by verse); null ⇒ active-verse-only view using
  // `twlForVerse`.
  twlForVerse: TwlRow[];
  twlGroups: Array<[number, TwlRow[]]> | null;
  totalTwl: number;
  pinned: boolean;
  onTogglePin: () => void;
  onWordCreate: () => void;
  locked?: boolean;
  checkoff?: ResourceCheckoff;
  // WordsTable wiring
  activeWordId: string | null;
  onWordSave: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onWordFocus: (row: TwlRow) => void;
  onWordReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  onWordHoverPreview?: (id: string | null) => void;
  onWordTranslateQuote?: (row: TwlRow, english: string) => string | null;
  onWordGloss?: (row: TwlRow) => string;
  twlRowAlternatives?: Map<string, string[]>;
  quoteBuildActiveWordId?: string | null;
  quoteBuildSelectionCount?: number;
  onStartWordQuoteBuild?: (wordId: string) => void;
  // TwlSuggestions wiring (per-verse, unpinned only). Hidden when
  // onAddTwlSuggestion is absent.
  onAddTwlSuggestion?: (suggestion: TwlSuggestion, chosenArticleId: string) => void;
  isTwlSuggestionExcluded?: (suggestion: TwlSuggestion) => boolean;
  onTwlSuggestions?: (suggestions: TwlSuggestion[]) => void;
  twlBlockedArticleIds?: (suggestion: TwlSuggestion, candidateIds?: string[]) => Set<string>;
  twlFiltersReady?: boolean;
}

export function WordsPanelBody({
  book,
  chapter,
  activeVerse,
  twlForVerse,
  twlGroups,
  totalTwl,
  pinned,
  onTogglePin,
  onWordCreate,
  locked,
  checkoff,
  activeWordId,
  onWordSave,
  onWordDelete,
  onWordFocus,
  onWordReorder,
  onWordHoverPreview,
  onWordTranslateQuote,
  onWordGloss,
  twlRowAlternatives,
  quoteBuildActiveWordId,
  quoteBuildSelectionCount,
  onStartWordQuoteBuild,
  onAddTwlSuggestion,
  isTwlSuggestionExcluded,
  onTwlSuggestions,
  twlBlockedArticleIds,
  twlFiltersReady,
}: WordsPanelBodyProps) {
  const { t } = useTranslation();
  const wordsTable = (rows: TwlRow[]) => (
    <WordsTable
      rows={rows}
      activeId={activeWordId}
      onSave={onWordSave}
      onDelete={onWordDelete}
      onFocus={onWordFocus}
      onReorder={onWordReorder}
      onHoverPreview={onWordHoverPreview}
      locked={locked}
      onTranslateQuote={onWordTranslateQuote}
      onWordGloss={onWordGloss}
      suggestionAlternatives={twlRowAlternatives}
      activeQuoteBuildId={quoteBuildActiveWordId}
      quoteBuildSelectionCount={quoteBuildSelectionCount}
      onStartQuoteBuild={onStartWordQuoteBuild}
    />
  );
  return (
    // Flex column filling the scroll viewport so the suggestions block
    // (mt:auto) is pushed to the bottom even when the Words list is short.
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <SectionHead
        title={t("shell.words")}
        count={totalTwl}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onAdd={onWordCreate}
        sticky
        hideAdd={locked}
        lane="tw"
        checkoff={checkoff}
      />
      {twlGroups ? (
        twlGroups.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            {t("shell.noWordsInChapter")}
          </Typography>
        ) : (
          twlGroups.map(([verse, rows]) => (
            <Fragment key={`twl-${verse}`}>
              <VerseGroupHead verse={verse} active={verse === activeVerse} section="words" />
              {wordsTable(rows)}
            </Fragment>
          ))
        )
      ) : (
        wordsTable(twlForVerse)
      )}
      {/* Per-verse suggestions — only in the active-verse (unpinned) view.
          refreshKey is the verse's current link set so adding/removing a
          link re-scans and drops/recovers it. */}
      {!twlGroups && onAddTwlSuggestion && (
        // Pin the suggestions to the bottom of the scroll viewport: mt:auto
        // pushes it to the bottom of the flex column (so it stays there even
        // when the Words list is short), and sticky bottom:-8 keeps it pinned
        // while scrolling a long list. mx/px:2 + pb:1 extend the paper
        // background; bottom:-8 sits it flush against the scroll body's py:1.
        <Box
          sx={{
            mt: "auto",
            position: "sticky",
            bottom: -8,
            zIndex: 1,
            bgcolor: "background.paper",
            mx: -2,
            px: 2,
            pb: 1,
            boxShadow: "0 -6px 8px -6px rgba(0,0,0,0.12)",
          }}
        >
          <TwlSuggestions
            book={book}
            chapter={chapter}
            verse={activeVerse}
            refreshKey={twlForVerse.map((r) => `${r.tw_link ?? ""}|${r.orig_words ?? ""}|${r.occurrence ?? 1}`).join("~")}
            onAdd={onAddTwlSuggestion}
            isExcluded={isTwlSuggestionExcluded}
            onSuggestions={onTwlSuggestions}
            blockedArticleIds={twlBlockedArticleIds}
            filtersReady={twlFiltersReady}
            locked={locked}
            paused={!!checkoff && checkoff.applicable("tw") && checkoff.shade("tw") !== "open"}
          />
        </Box>
      )}
    </Box>
  );
}
