// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// PackageHubScreen — the book-package navigation hub at #/package/{book}.
// This screen REPLACES the FlowNav pill bar: it is where a translator lands
// after picking a book, and the "Back to {book} package" chevron on every
// work screen points here. It renders no FlowNav, no tabs, no pills — one
// centred column of tappable rows, in the visual language TranslateNotesScreen
// calibrated (same COLUMN_PX, topbar, card tokens, back chevron).
//
// What it shows, and the evidence for every number:
//
//   * The ONLY book-level aggregate the API provides is BookSummary
//     (web/src/sync/api.ts:167-176): per-chapter counts of verses / tn / tq /
//     twl rows, fetched ONCE by useBook's summary fetch (GET /api/chapters/
//     {book}, api.ts:1589-1590; useBook.ts:66-79). Every count on this screen
//     is a sum or a row of that one response — no N+1, no per-chapter fetches.
//
//   * There is NO overall progress bar and NO status chips here, on purpose.
//     Approval state (`translation_state === "validated"`) lives on individual
//     rows inside ChapterPayload (api.ts:156-165) and verse statuses likewise —
//     per-chapter payloads only. Computing "3 of 46 approved" for the book
//     would mean fetching every chapter of every resource, which is exactly
//     the request-per-chapter hammering this screen refuses. A verb or count
//     with no backend is absent, not faked (Benjamin's 2026-08-07 precedent,
//     TranslateQuestionsScreen header). If we want real progress here, the
//     backend needs a book-level rollup — e.g. GET /api/chapters/{book}
//     growing per-chapter `tnValidated` / `tqValidated` / `versesDone` counts.
//
//   * The Words & Articles row carries NO count. BookSummary.twl counts
//     word-LINK rows (occurrences in the text), but the Words screen lists
//     unique tw terms + ta articles (api.getArticles, api.ts:1865-1868) —
//     labelling an occurrence count as if it tallied that list would mislead,
//     and fetching two article lists just for a tally isn't worth it.
//
// Chapter selection: Scripture, Notes and Questions are chapter-scoped
// (#/scripture/{book}/{ch}, #/notes/{book}/{ch}, #/questions/{book}/{ch} —
// App.tsx parseHash:123-155), so tapping one of those rows expands an inline
// chapter list (one open at a time); tapping a chapter navigates. Words &
// Articles is book-scoped (#/words/{book}) and navigates directly — the two
// groups are labelled so the asymmetry reads as intentional. A chapter with
// zero notes/questions renders disabled with an honest "No notes" sub rather
// than linking to an empty queue.
//
// Back chevron → #/home (mirrors TranslateNotesScreen:632-638). Data comes
// from the same one-column plumbing: useBook for the summary, useProjectConfig
// for the "{source} to {target}" sub-line (TranslateNotesScreen:547-549).

import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  ButtonBase,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import type { FlowScreenContext } from "./types";
import { useBook } from "../../hooks/useBook";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { bookName } from "../../lib/bookNames";

export interface PackageHubScreenProps extends FlowScreenContext {
  book: string;
}

// Same one-column reading measure as TranslateNotesScreen (its line 98).
const COLUMN_PX = 480;

// The three chapter-scoped surfaces expand in place; words navigates directly.
type ExpandableSurface = "scripture" | "notes" | "questions";

export default function PackageHubScreen({ book }: PackageHubScreenProps) {
  const theme = useTheme();
  const { skip } = theme.palette.flows;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || "Target";

  const { summary, summaryStatus } = useBook(book, true);

  const [open, setOpen] = useState<ExpandableSurface | null>(null);

  // BookSummary includes a chapter-0 entry for book front matter (intro tn
  // rows, 0 verses — verified against GET /api/chapters/ZEC: ids 0–14 for a
  // 14-chapter book). The hub shows real chapters only: intro rows are not
  // reachable through the chapter-scoped translate screens, so counting them
  // here would advertise work this screen can't open.
  const realChapters = useMemo(
    () => (summary?.chapters ?? []).filter((c) => c.chapter >= 1),
    [summary],
  );

  const totals = useMemo(() => {
    let verses = 0;
    let tn = 0;
    let tq = 0;
    for (const c of realChapters) {
      verses += c.verses;
      tn += c.tn;
      tq += c.tq;
    }
    return { chapters: realChapters.length, verses, tn, tq };
  }, [realChapters]);

  const name = bookName(book);
  const sub = translationMode
    ? `Book package · ${(projectConfig?.translationSource?.languageCode ?? "en").toUpperCase()} to ${targetLabel}`
    : `Book package · ${targetLabel}`;

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow:
      theme.palette.mode === "dark"
        ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
        : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
  };

  const sectionHeadSx = {
    display: "flex",
    alignItems: "baseline",
    gap: 1,
    marginBlockStart: 1.25,
    marginInline: 0.25,
  };

  const sectionTitleSx = {
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    m: 0,
  };

  // One tappable surface row: title + sub + chevron, the artifact's .listitem
  // translated to MUI. `expanded` rotates the chevron; `disabled` rows state
  // their reason in the sub instead of pretending to lead anywhere.
  function SurfaceRow({
    title,
    subText,
    onClick,
    expanded,
    expandable,
    disabled,
  }: {
    title: string;
    subText: string;
    onClick: () => void;
    expanded?: boolean;
    expandable?: boolean;
    disabled?: boolean;
  }) {
    return (
      <ButtonBase
        onClick={onClick}
        disabled={disabled}
        aria-expanded={expandable ? expanded : undefined}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          width: "100%",
          textAlign: "start",
          justifyContent: "flex-start",
          paddingBlock: 1.5,
          paddingInline: 1.75,
          opacity: disabled ? 0.55 : 1,
          "&:hover": disabled ? undefined : { borderColor: "#31ADE3" },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem", m: 0 }}>{title}</Typography>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
            {subText}
          </Typography>
        </Box>
        <ChevronRightIcon
          fontSize="small"
          sx={{
            color: "text.secondary",
            flex: "none",
            transition: "transform 0.15s ease",
            transform: expanded ? "rotate(90deg)" : "none",
          }}
        />
      </ButtonBase>
    );
  }

  // Inline chapter list under an expanded surface row. Every entry is a row
  // from the one BookSummary response; `count === 0` disables the entry.
  function ChapterList({
    countOf,
    unit,
    href,
  }: {
    countOf: (c: { verses: number; tn: number; tq: number }) => number;
    unit: string;
    href: (chapter: number) => string;
  }) {
    return (
      <Stack spacing={0.75} sx={{ paddingInlineStart: 2, paddingBlockStart: 0.75 }}>
        {realChapters.map((c) => {
          const n = countOf(c);
          const empty = n === 0;
          return (
            <ButtonBase
              key={c.chapter}
              disabled={empty}
              onClick={() => {
                location.hash = href(c.chapter);
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                width: "100%",
                textAlign: "start",
                justifyContent: "flex-start",
                bgcolor: "action.hover",
                borderRadius: "9px",
                paddingBlock: 1,
                paddingInline: 1.5,
                opacity: empty ? 0.55 : 1,
              }}
            >
              <Typography sx={{ fontWeight: 600, fontSize: "0.9rem", flex: "none" }}>
                Chapter {c.chapter}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
                {empty ? `No ${unit}` : `${n} ${unit}`}
              </Typography>
              {!empty && (
                <ChevronRightIcon
                  fontSize="small"
                  sx={{ color: "text.secondary", flex: "none" }}
                />
              )}
            </ButtonBase>
          );
        })}
      </Stack>
    );
  }

  const toggle = (id: ExpandableSurface) => setOpen((cur) => (cur === id ? null : id));

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      {/* topbar */}
      <Box
        sx={{
          position: "sticky",
          insetBlockStart: 0,
          zIndex: 20,
          bgcolor: "background.paper",
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ maxWidth: COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <IconButton
              aria-label={`Leave ${name} package`}
              onClick={() => {
                location.hash = "#/home";
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                {name}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {sub}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            {summaryStatus === "ready" && (
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: "text.secondary",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {totals.chapters} {totals.chapters === 1 ? "chapter" : "chapters"}
              </Typography>
            )}
          </Stack>
          {/* No progress bar: the API has no book-level approval rollup, and a
              bar with no data behind it would be an invented number. */}
        </Box>
      </Box>

      <Box
        sx={{
          maxWidth: COLUMN_PX,
          mx: "auto",
          paddingInline: 2,
          paddingBlockStart: 1,
          paddingBlockEnd: 4,
          display: "flex",
          flexDirection: "column",
          gap: 1.25,
        }}
      >
        {summaryStatus === "error" ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            Could not load {name}.
          </Alert>
        ) : summaryStatus !== "ready" ? (
          <Stack alignItems="center" justifyContent="center" sx={{ paddingBlock: 8 }}>
            <CircularProgress />
          </Stack>
        ) : (
          <>
            <Box sx={sectionHeadSx}>
              <Typography component="h2" sx={sectionTitleSx}>
                Chapter by chapter
              </Typography>
            </Box>

            <SurfaceRow
              title="Scripture"
              subText={`${totals.chapters} ${totals.chapters === 1 ? "chapter" : "chapters"} · ${totals.verses} verses`}
              expandable
              expanded={open === "scripture"}
              onClick={() => toggle("scripture")}
            />
            {open === "scripture" && (
              <ChapterList
                countOf={(c) => c.verses}
                unit="verses"
                href={(ch) => `#/scripture/${book}/${ch}`}
              />
            )}

            <SurfaceRow
              title="Notes"
              subText={totals.tn === 0 ? `No notes in ${name}` : `${totals.tn} notes`}
              expandable
              expanded={open === "notes"}
              disabled={totals.tn === 0}
              onClick={() => toggle("notes")}
            />
            {open === "notes" && (
              <ChapterList
                countOf={(c) => c.tn}
                unit="notes"
                href={(ch) => `#/notes/${book}/${ch}`}
              />
            )}

            <SurfaceRow
              title="Questions"
              subText={totals.tq === 0 ? `No questions in ${name}` : `${totals.tq} questions`}
              expandable
              expanded={open === "questions"}
              disabled={totals.tq === 0}
              onClick={() => toggle("questions")}
            />
            {open === "questions" && (
              <ChapterList
                countOf={(c) => c.tq}
                unit="questions"
                href={(ch) => `#/questions/${book}/${ch}`}
              />
            )}

            <Box sx={sectionHeadSx}>
              <Typography component="h2" sx={sectionTitleSx}>
                Whole book
              </Typography>
            </Box>

            <SurfaceRow
              title="Words & Articles"
              subText="Key terms and academy articles"
              onClick={() => {
                location.hash = `#/words/${book}`;
              }}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
