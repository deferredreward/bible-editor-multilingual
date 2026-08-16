// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// TranslateNotesScreen — the translation-notes queue, rebuilt faithfully to the
// approved "Translation Notes — Titus 1" mockup (the design-direction reset).
//
// Translation-primary by construction: the translator is turning an English
// translationNote into their language, so the TARGET DRAFT is the centrepiece
// and everything else on the screen is read-only context for it. There are
// exactly three verbs — Approve / Not needed / Redo — and no authoring chrome:
// no preserve, no hint, no TCM/SH chips, no reorder / insert / retarget, no
// debug row ids, no quote builder, no history dialog. Those belong to the
// authoring surfaces (ReviewQueue, NoteCard), not to a translator's screen.
//
// ── 2026-08-10 responsive layouts (Benjamin) ────────────────────────────────
//
// Below md (900px) nothing changed: one centred column (the mockup's phone
// shell) with the viewport-fixed action bar — that simplicity IS the phone
// design. At md+ the screen becomes master-detail after TranslateWordsScreen's
// precedent (the desk-class primitives in docs/mockups/desktop-first/
// _design.css): a scrollable list pane (340-380px) showing the note queue as
// rows (verse ref · quote-or-note preview · status chip) on the inline-start
// side, and a panel-chromed detail pane holding the same card stack, both
// inside a 1440px centred desk. Selecting a row moves the SAME queue cursor
// the phone's Prev/Next drives — one cursor, two representations — and the
// action bar goes sticky at the pane's bottom instead of viewport-fixed
// (pinned there by margin-block-start:auto when the content is short).
// Logical properties only; the grid column order itself flips under RTL.
//
// ── 2026-08-10 markup round (Benjamin) ──────────────────────────────────────
//
// * List rows preview the TARGET note — the live draft for the open card,
//   else the row's saved target text, else the English source note's first
//   line — NEVER the original-language quote (Hebrew in a one-line preview
//   reads as noise on OT books). Markdown chrome (#, **) is stripped so
//   intro rows stop reading as "# Zechariah 1 General Notes".
// * Prev/Next also live in the topbar as compact icon chevrons (both
//   widths), sharing the card stack's cursor and disabled logic, flipped
//   under RTL per the scripture screen's scaleX pattern.
// * A horizontal touch-swipe on the card stack (phone column and the wide
//   detail pane scroller) pages the same cursor via useSwipeNav — disabled
//   on the done view, direction-mapped to the TARGET language's direction.
//
// ── 2026-08-10 article-type round (Benjamin) ────────────────────────────────
//
// Each note's tA article type ("metaphor", "merism", …) is derived from the
// row's support_reference (last path segment; category prefix stripped for
// the label, full slug kept as the tooltip) and shown as a quiet read-only
// pill on the list rows and in the draft card's header. A compact type
// filter (MUI Select: "All types" plus the types present in THIS chapter's
// queue, with counts) narrows both the list pane and the Prev/Next / swipe /
// advance traversal by mapping cursor movement through a derived index list
// over the frozen queue — the queue itself is never mutated, and with no
// filter active every traversal path is byte-equivalent to before. Filter
// state is component-local and resets on chapter change.
//
// Data + save machinery is the proven plumbing, unchanged:
//   * rows + verses            → useChapter
//   * English source note      → useSourceNotes (published en_tn TSV, keyed by
//                                row id) — the row's OWN `note` is the TARGET
//   * every keystroke          → drafts store (IndexedDB), restored on mount,
//                                cleared by the outbox once the server confirms
//   * saves                    → outbox.enqueueRow with If-Match + baseline
//   * Approve                  → api.validateNote
//   * Not needed               → api.trashNote (the existing tn soft-trash,
//                                relabelled; the row stays recoverable)
//   * Redo                     → api.tnQuick
//
// Chapter locks (verified in api/src/rows.ts, findings §2.7): tn PATCH is
// lock-EXEMPT, and /validate + /trash have no lock check at all. So every write
// this screen makes is accepted while a run is in flight — the lock banner is
// informational here and gates nothing. Disabling anything would block writes
// the server accepts.
//
// 409 handling is deliberately minimal: a banner that says another editor
// changed the row, with a reload affordance. The full merge dialog stays on
// the authoring screen.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CheckIcon from "@mui/icons-material/Check";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { unescapeNewlines, waitForOp } from "./translateShared";
import { useSwipeNav } from "./useSwipeNav";
import type { FlowScreenContext } from "./types";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useSourceNotes } from "../../hooks/useSourceNotes";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { resolveSourceRef } from "../../lib/sourceRef";
import { buildVerseIndex } from "../../lib/verseRange";
import { buildTnQuickRequest } from "../../lib/tnQuickRequest";
import { extractTargetSelectionText } from "../../lib/highlight";
import { isHebrewBook } from "../../lib/sourceSearch";
import { drafts, rowKey } from "../../sync/drafts";
import { onOutboxResult, outbox } from "../../sync/outbox";
import {
  api,
  ApiError,
  type ChapterLockedBody,
  type TnRow,
  type TqRow,
  type VerseDto,
} from "../../sync/api";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateNotesScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  // Optional deep-link verse (e.g. from the Books "Continue" card). Seeds the
  // queue cursor once, on mount/chapter change, to the first queue entry at
  // or after this verse — never re-seeks on later renders or re-navigation
  // within the same chapter.
  verse?: number;
}

// A card is terminal in exactly two ways — the two verbs that finish it.
// "Edited" is a chip, not a terminal state: editing a draft does not approve it,
// and pretending otherwise would report progress the server does not have.
type CardStatus = "approved" | "skipped";

// Content width. The mockup is a 430px phone shell; 480 keeps the same one-column
// reading measure while giving desktop a little more room for long notes.
const COLUMN_PX = 480;

function verseObjectsOf(v: VerseDto | undefined): unknown[] | null {
  if (!v) return null;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// tA article type, derived from the row's support reference:
// "rc://*/ta/man/translate/figs-metaphor" → slug "figs-metaphor". The display
// label strips the category prefix and reads hyphens as spaces —
// "figs-metaphor" → "metaphor", "writing-newevent" → "newevent",
// "grammar-connect-logic-result" → "connect logic result". The full slug
// stays available as the tooltip (2026-08-10 article-type round).
function typeSlugOf(supportReference: string | null | undefined): string | null {
  if (!supportReference) return null;
  const seg = supportReference.split("/").filter(Boolean).pop();
  return seg || null;
}

function typeLabelOf(slug: string): string {
  return slug.replace(/^(?:figs|translate|writing|grammar)-/, "").replace(/-/g, " ");
}

interface LaneProps {
  label: string;
  text: string | null;
  selection: string;
  labelFontFamily: string | undefined;
  mark: (text: string | null, selection: string) => ReactNode;
}

// Read-only scripture reference lane (ULT/UST) above a note card, with the
// note's quote highlighted via `mark`.
//
// Hoisted to module scope (2026-08-16, nested-component audit, issue #172):
// declaring this inside TranslateNotesScreen's body gave it a new function
// identity on every parent render, so React remounted the whole subtree on
// every hub/screen re-render rather than just when its own props changed.
// `theme.typography.fontFamily` and the `mark` highlighter are now explicit
// props instead of closed-over values, following the QaPair hoist pattern in
// TranslateQuestionsScreen.tsx.
function Lane({ label, text, selection, labelFontFamily, mark }: LaneProps) {
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: "9px",
        paddingBlock: 1.25,
        paddingInline: 1.5,
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.03rem",
        lineHeight: 1.55,
        "& + &": { mt: 1 },
      }}
    >
      <Box
        component="span"
        sx={{
          display: "block",
          fontFamily: labelFontFamily,
          fontSize: "0.656rem",
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "text.secondary",
          mb: 0.375,
        }}
      >
        {label}
      </Box>
      {text ? (
        mark(text, selection)
      ) : (
        <Box component="em" sx={{ color: "text.secondary", fontSize: "0.875rem" }}>
          No {label} text exists for this verse in this workspace. That is normal in a
          translation-mode workspace whose target lanes have not been drafted yet.
        </Box>
      )}
    </Box>
  );
}

export default function TranslateNotesScreen({ book, chapter, verse }: TranslateNotesScreenProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // --hl from docs/flows/ui/_tokens.css: the quote highlight in scripture, and
  // the ground the "Edited" chip and the tap-to-edit hover share.
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  // .ref in the mockup: Ocean in light, Cultivate in dark.
  const REF_COLOR = dark ? "#70C9CC" : "#014263";
  const { ok, skip } = theme.palette.flows;
  // md+ (>=900px, the words screen's breakpoint): master-detail side by side
  // instead of the phone's single centred column (2026-08-10, header).
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  // Directional chevrons follow the UI direction (TranslateScriptureScreen's
  // pattern) — MUI does not flip icons under RTL by itself.
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || "Target";
  const litLabel = projectConfig?.litLabel || "ULT";
  const simLabel = projectConfig?.simLabel || "UST";

  // The English source note lives in the PUBLISHED source repo, not in D1: in a
  // translation-mode workspace the row's own `note` IS the target being drafted
  // (useSourceNotes.ts:4-7 says this for the tQ twin, and ResourceColumn.tsx:326-338
  // wires the tN case exactly this way). Null projection = no tN source
  // configured → the English card degrades to a plain statement rather than
  // showing the target text twice.
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tn"),
    [projectConfig],
  );
  const sourceNotes = useSourceNotes(translationMode ? book : null, sourceProjection);

  const { status, data, refetch, applyLocalRowPatch, applyLocalRowReplacement } = useChapter(
    book,
    chapter,
  );
  // Chapter count for "Continue to chapter N+1" — summary only; the per-chapter
  // payloads stay lazy.
  const { summary } = useBook(book, true);
  const chapterCount = summary?.chapters.length ?? null;

  // ── queue ────────────────────────────────────────────────────────────────
  // Frozen once per chapter so the denominator ("3 of 8") and the progress bar
  // stay stable: approving a card, or moving one to the trash, must not
  // renumber the queue under the translator's hands.
  const chapterKey = `${book}:${chapter}`;
  const [queue, setQueue] = useState<{ key: string; ids: string[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<"cards" | "done">("cards");
  const [reviewing, setReviewing] = useState(false);
  // Article-type filter (slug, e.g. "figs-metaphor"); null = show everything.
  // Session-local, reset on chapter change (2026-08-10 article-type round).
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.book !== book || data.chapter !== chapter) return;
    if (queue?.key === chapterKey) return;
    const ordered = [...data.tn]
      .filter((r) => r.trashed_at == null)
      .sort((a, b) => a.verse - b.verse || (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const seed: Record<string, CardStatus> = {};
    for (const r of ordered) if (r.translation_state === "validated") seed[r.id] = "approved";
    const firstOpen = ordered.findIndex((r) => !seed[r.id]);
    setQueue({ key: chapterKey, ids: ordered.map((r) => r.id) });
    setStatuses(seed);
    setEditedIds(new Set());
    if (verse != null) {
      // A verse past the last note's verse has no >= match (-1); clamp to the
      // last card instead of falling back to index 0, which would jump to the
      // top of the chapter instead of near where the user asked to look.
      const seekIdx = ordered.findIndex((r) => r.verse >= verse);
      setCursor(seekIdx < 0 ? (ordered.length > 0 ? ordered.length - 1 : 0) : seekIdx);
    } else {
      setCursor(firstOpen < 0 ? 0 : firstOpen);
    }
    // A deep-linked verse always lands on the card view, even if every note
    // in the chapter is already approved — "done" would otherwise discard
    // the requested verse.
    setView(verse != null ? "cards" : ordered.length > 0 && firstOpen < 0 ? "done" : "cards");
    setReviewing(false);
    setTypeFilter(null);
    // `verse` deliberately not a dep beyond this — the `queue?.key === chapterKey`
    // guard above already limits this effect to once per mount/chapter change,
    // which is exactly the seek-once semantics wanted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, book, chapter, queue, chapterKey]);

  const rowById = useMemo(() => {
    const m = new Map<string, TnRow>();
    for (const r of data?.tn ?? []) m.set(r.id, r);
    return m;
  }, [data]);

  const queueIds = queue?.key === chapterKey ? queue.ids : null;
  const total = queueIds?.length ?? 0;
  const currentId = queueIds && cursor < queueIds.length ? queueIds[cursor] : null;
  const row = currentId ? (rowById.get(currentId) ?? null) : null;
  const statusedCount = queueIds ? queueIds.filter((id) => statuses[id]).length : 0;

  // ── article-type filter (2026-08-10) ─────────────────────────────────────
  // Distinct types present in THIS chapter's queue, with counts — the filter
  // menu is built from what is actually here, never a global taxonomy.
  const typeOptions = useMemo(() => {
    if (!queueIds) return [];
    const counts = new Map<string, { label: string; count: number }>();
    for (const id of queueIds) {
      const slug = typeSlugOf(rowById.get(id)?.support_reference);
      if (!slug) continue;
      const entry = counts.get(slug);
      if (entry) entry.count += 1;
      else counts.set(slug, { label: typeLabelOf(slug), count: 1 });
    }
    return [...counts.entries()]
      .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [queueIds, rowById]);

  // The filtered traversal: an ascending index list over the FROZEN queue —
  // the queue itself is never mutated. Every cursor movement while a filter
  // is active maps through this list; with no filter the original code paths
  // run untouched (byte-equivalent behavior).
  const visibleIdx = useMemo(() => {
    if (!queueIds || !typeFilter) return [];
    const out: number[] = [];
    queueIds.forEach((id, i) => {
      if (typeSlugOf(rowById.get(id)?.support_reference) === typeFilter) out.push(i);
    });
    return out;
  }, [queueIds, typeFilter, rowById]);

  // Applying a filter the current card doesn't match snaps the cursor to the
  // first matching card (an empty match set renders the empty state instead).
  // A filter whose type vanished from the queue (refetch) clears itself.
  useEffect(() => {
    if (!typeFilter || !queueIds) return;
    if (!typeOptions.some((o) => o.slug === typeFilter)) {
      setTypeFilter(null);
      return;
    }
    if (visibleIdx.length === 0) return;
    if (!visibleIdx.includes(cursor)) setCursor(visibleIdx[0]);
  }, [typeFilter, typeOptions, visibleIdx, cursor, queueIds]);

  // ── editor state ─────────────────────────────────────────────────────────
  const [draftValue, setDraftValue] = useState("");
  const baselineRef = useRef("");
  const hydratedKeyRef = useRef<string | null>(null);
  // The row key the stash effect has actually caught up with. Declared (and
  // updated) after the stash effect below, so during a row-change commit it
  // still holds the *outgoing* row's key while the stash effect runs — see
  // the guard there and issue #167.
  const stashedKeyRef = useRef<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  // Phone focus mode (2026-08-15, mobile polish): with the on-screen keyboard
  // up there is almost no room, so an active edit on a narrow viewport hides
  // the surrounding chrome (topbar, action bar, Prev/Next, type filter) and
  // leaves only the scripture/source context cards, the editor, and its Done
  // button. Wide/desktop behavior is untouched — this is always false there.
  const focusMode = !wide && editing;
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInputRef = useRef<HTMLTextAreaElement>(null);

  const [busy, setBusy] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);
  // Sticky once the server tells us the AI proxy isn't configured — there is no
  // capability flag to read up front, so the first 503 is how we learn.
  const [aiUnavailable, setAiUnavailable] = useState<string | null>(null);

  const say = useCallback((text: string, severity: "info" | "warning" = "warning") => {
    setNotice({ text, severity });
  }, []);

  // Hydrate the editor on card change: a persisted draft (unsaved typing from
  // this browser) wins over the row's own content.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tn", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (hydratedKeyRef.current === nonceKey) return;
    hydratedKeyRef.current = nonceKey;
    const fallback = unescapeNewlines(row.note);
    baselineRef.current = fallback;
    setDraftValue(fallback);
    setEditing(false);
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== nonceKey) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      const patchVal = payload?.patch?.note;
      if (typeof patchVal === "string") setDraftValue(unescapeNewlines(patchVal));
      const baselineVal = payload?.baseline?.note;
      if (typeof baselineVal === "string") baselineRef.current = unescapeNewlines(baselineVal);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id, book, reloadNonce]);

  const hasDiff = draftValue !== baselineRef.current;

  // Stash every keystroke. Nothing leaves the browser here — the draft store is
  // what makes "no save on blur, no save on unmount" safe.
  //
  // Guarded against a same-commit race (issue #167): on a row change, the
  // hydration effect above runs first and synchronously repoints baselineRef
  // at the *new* row, but draftValue in this closure is still the *outgoing*
  // row's text until the pending setDraftValue(fallback) flushes on the next
  // render. Without the guard, this effect would read that stale draftValue
  // against the already-swapped baseline and stash the old card's text under
  // the new row's key. stashedKeyRef (updated by the effect below, declared
  // after this one) still holds the outgoing row's key during this exact
  // commit, so the mismatch skips the write; the next commit — once
  // draftValue has actually caught up — runs this effect again with a
  // consistent (row, draftValue) pair.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tn", book, row.id);
    if (stashedKeyRef.current !== key) return;
    if (draftValue !== baselineRef.current) {
      void drafts.set(
        key,
        { patch: { note: draftValue }, baseline: { note: baselineRef.current } },
        row.version,
        { kind: "row", rowKind: "tn", id: row.id, book, chapter: row.chapter, verse: row.verse },
      );
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftValue, row?.id, row?.version, book]);

  useEffect(() => {
    stashedKeyRef.current = row ? rowKey("tn", book, row.id) : null;
  }, [row?.id, book]);

  useUnsavedGuard(hasDiff);

  // Entering edit mode focuses the textarea without letting the browser's own
  // autoFocus scroll fire mid-keyboard-open (which, combined with the
  // same-frame height change on phones, loses the user's place); we drive the
  // scroll ourselves, a frame later, once layout has settled. On wide/desktop
  // layouts we only reveal the editor if it's actually off-screen (matching
  // the old autoFocus behavior); on phone we center it, then re-center once
  // more when the on-screen keyboard finishes opening (visualViewport
  // 'resize'), since that resize can happen after our first scroll.
  useEffect(() => {
    if (!editing) return;
    editorInputRef.current?.focus({ preventScroll: true });
    const raf = requestAnimationFrame(() => {
      editorContainerRef.current?.scrollIntoView({ block: wide ? "nearest" : "center" });
    });
    let vv: VisualViewport | undefined;
    let onResize: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!wide) {
      vv = window.visualViewport ?? undefined;
      if (vv) {
        onResize = () => {
          editorContainerRef.current?.scrollIntoView({ block: "center" });
          vv?.removeEventListener("resize", onResize!);
        };
        vv.addEventListener("resize", onResize);
        timeout = setTimeout(() => {
          vv?.removeEventListener("resize", onResize!);
        }, 1500);
      }
    }
    return () => {
      cancelAnimationFrame(raf);
      if (vv && onResize) vv.removeEventListener("resize", onResize);
      if (timeout) clearTimeout(timeout);
    };
  }, [editing, wide]);

  // ── outbox reconciliation ────────────────────────────────────────────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row" || op.target.rowKind !== "tn" || op.target.book !== book) {
          return;
        }
        if (result.kind === "ok") {
          setChapterLock(null);
          return;
        }
        if (result.kind === "locked") {
          setChapterLock(result.lockBody);
          return;
        }
        // Only a settled conflict is a question for the user: the outbox
        // auto-heals the healable ones and still notifies listeners.
        if (result.kind === "conflict" && op.status === "conflict") {
          setConflictNotice(
            "Another editor changed this note while you were working on it. Your version was not saved.",
          );
        }
      }),
    [book],
  );

  // ── scripture context ────────────────────────────────────────────────────
  const sourceByVerse = data?.verses?.UHB ?? data?.verses?.UGNT;
  const sourceIndex = useMemo(() => buildVerseIndex(sourceByVerse), [sourceByVerse]);
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);

  const hebrew = isHebrewBook(book);
  const sourceLabel = hebrew ? "Hebrew" : "Greek";
  const sourceDir: "ltr" | "rtl" = hebrew ? "rtl" : "ltr";

  const sourceVo = row ? verseObjectsOf(sourceIndex[row.verse]) : null;
  const ultVerse = row ? ultIndex[row.verse] : undefined;
  const ustVerse = row ? ustIndex[row.verse] : undefined;
  const ultText = ultVerse?.plain_text ?? null;
  const ustText = ustVerse?.plain_text ?? null;

  // The mockup highlights the note's phrase inside both scripture lanes. The
  // phrase is derived from the row's original-language quote through the same
  // alignment lookup the classic editor highlights with — never guessed.
  const rowQuote = row?.quote ?? null;
  const rowOccurrence = row?.occurrence ?? 1;
  const ultSelection = useMemo(() => {
    const vo = verseObjectsOf(ultVerse);
    if (!rowQuote || !vo) return "";
    return extractTargetSelectionText(vo, rowQuote, rowOccurrence, sourceVo ?? undefined);
  }, [ultVerse, rowQuote, rowOccurrence, sourceVo]);
  const ustSelection = useMemo(() => {
    const vo = verseObjectsOf(ustVerse);
    if (!rowQuote || !vo) return "";
    return extractTargetSelectionText(vo, rowQuote, rowOccurrence, sourceVo ?? undefined);
  }, [ustVerse, rowQuote, rowOccurrence, sourceVo]);

  const mark = useCallback(
    (text: string | null, selection: string): ReactNode => {
      if (!text) return null;
      if (!selection) return text;
      const idx = text.indexOf(selection);
      if (idx < 0) return text;
      return (
        <>
          {text.slice(0, idx)}
          <Box
            component="mark"
            sx={{ background: HL, color: "inherit", borderRadius: "3px", paddingInline: "2px" }}
          >
            {selection}
          </Box>
          {text.slice(idx + selection.length)}
        </>
      );
    },
    [HL],
  );

  const englishNote = row ? (sourceNotes.get(row.id)?.note ?? null) : null;

  // ── navigation between cards ─────────────────────────────────────────────
  const nextUnstatused = useCallback(
    (from: number, table: Record<string, CardStatus>): number => {
      if (!queueIds) return -1;
      if (typeFilter) {
        // Same cycle — start just after `from`, wrap, check `from` itself
        // last — restricted to the filtered index list.
        const n = visibleIdx.length;
        if (n === 0) return -1;
        const after = visibleIdx.findIndex((i) => i > from);
        const start = after < 0 ? 0 : after;
        for (let k = 0; k < n; k++) {
          const idx = visibleIdx[(start + k) % n];
          if (!table[queueIds[idx]]) return idx;
        }
        return -1;
      }
      for (let i = 1; i <= queueIds.length; i++) {
        const idx = (from + i) % queueIds.length;
        if (!table[queueIds[idx]]) return idx;
      }
      return -1;
    },
    [queueIds, typeFilter, visibleIdx],
  );

  const advanceAfter = useCallback(
    (id: string, next: CardStatus) => {
      if (!queueIds) return;
      const table = { ...statuses, [id]: next };
      if (reviewing) {
        if (typeFilter) {
          const nxt = visibleIdx.find((i) => i > cursor);
          if (nxt === undefined) setView("done");
          else setCursor(nxt);
          return;
        }
        if (cursor >= queueIds.length - 1) setView("done");
        else setCursor(cursor + 1);
        return;
      }
      const nxt = nextUnstatused(cursor, table);
      if (nxt === -1) {
        // Filtered set exhausted while the wider chapter still has open
        // cards: hold position rather than show the (untrue) chapter-complete
        // view. Without a filter this condition is never taken.
        if (typeFilter && queueIds.some((qid) => !table[qid])) return;
        setView("done");
      } else setCursor(nxt);
    },
    [queueIds, statuses, reviewing, cursor, nextUnstatused, typeFilter, visibleIdx],
  );

  // Free navigation — one cursor, four drivers: the card stack's Prev/Next,
  // the topbar chevrons, list-row clicks (md+), and touch swipes. With a type
  // filter active, movement maps through visibleIdx; without one, the
  // original clamp arithmetic runs untouched.
  const goPrev = useCallback(() => {
    if (!typeFilter) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    setCursor((c) => {
      let target = c;
      for (const i of visibleIdx) {
        if (i >= c) break;
        target = i;
      }
      return target;
    });
  }, [typeFilter, visibleIdx]);
  const goNext = useCallback(() => {
    if (!typeFilter) {
      setCursor((c) => Math.min(total - 1, c + 1));
      return;
    }
    setCursor((c) => visibleIdx.find((i) => i > c) ?? c);
  }, [typeFilter, visibleIdx, total]);

  // Disabled logic for every Prev/Next affordance — reduces to the original
  // expressions (cursor === 0 / cursor >= total - 1) when no filter is active.
  const canPrev = typeFilter ? visibleIdx.some((i) => i < cursor) : cursor > 0;
  const canNext = typeFilter ? visibleIdx.some((i) => i > cursor) : cursor < total - 1;

  // Swipe pages in the TARGET language's reading order (the content being
  // paged), not the UI chrome's — the words screen derives direction the same
  // way. Disabled on the done view: there is no card there to page.
  const targetRtl = projectConfig?.direction === "rtl";
  const swipe = useSwipeNav({
    onPrev: goPrev,
    onNext: goNext,
    enabled: view === "cards" && total > 0 && !focusMode,
    rtl: targetRtl,
  });

  // ── writes ───────────────────────────────────────────────────────────────
  // Save-then-validate, in that order and awaited: /validate does not carry a
  // version, so a PATCH that landed after it would demote the row straight back
  // to 'edited' server-side. The outbox stays the only thing that talks to
  // /api/rows — we just wait for its result before approving.
  async function saveDraft(target: TnRow): Promise<boolean> {
    const patch = { note: draftValue };
    const baseline = { note: baselineRef.current };
    applyLocalRowPatch("tn", target.id, patch as Partial<TnRow & TqRow>);
    const op = await outbox.enqueueRow("tn", target.id, target.version, patch, { book, baseline });
    const result = await waitForOp(op.id);
    if (result === null) {
      say("Your edit is queued but the server hasn't confirmed it yet — it was not approved.");
      return false;
    }
    if (result.kind !== "ok") {
      if (result.kind === "conflict") {
        setConflictNotice(
          "Another editor changed this note while you were working on it. Your version was not saved.",
        );
      } else if (result.kind === "locked") {
        setChapterLock(result.lockBody);
        say("An AI run is rewriting this chapter — your edit was dropped rather than overwritten.");
      } else {
        say(`Saving this note failed (${result.reason}). It was not approved.`);
      }
      return false;
    }
    baselineRef.current = draftValue;
    setEditedIds((prev) => new Set(prev).add(target.id));
    return true;
  }

  async function handleApprove() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (hasDiff && !(await saveDraft(row))) return;
      const updated = await api.validateNote(row.id, book, true);
      applyLocalRowReplacement("tn", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "approved" }));
      setEditing(false);
      setToast("Approved");
      advanceAfter(row.id, "approved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say("Approve needs a draft first — this note hasn't been through the AI pipeline yet.");
      } else {
        say(`Approve failed (${err instanceof ApiError ? err.status : "error"}).`);
      }
    } finally {
      setBusy(false);
    }
  }

  // "Not needed" is the existing tn soft-trash, relabelled: the card leaves the
  // queue but the row stays recoverable for the team's later review (and the
  // nightly job is what finally tombstones it).
  async function handleNotNeeded() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.trashNote(row.id, book);
      applyLocalRowReplacement("tn", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "skipped" }));
      setEditing(false);
      setToast("Marked not needed");
      advanceAfter(row.id, "skipped");
    } catch (err) {
      say(`Could not set this aside (${err instanceof ApiError ? err.status : "error"}).`);
    } finally {
      setBusy(false);
    }
  }

  const redoBlockedReason = (() => {
    if (aiUnavailable) return aiUnavailable;
    if (!row) return "No note selected.";
    if (!row.support_reference) {
      return "Redo needs a support reference on this note — the AI request is keyed by it.";
    }
    if (!row.quote) return "Redo needs a quote on this note — the AI needs the phrase to explain.";
    return null;
  })();

  async function handleRedo() {
    if (!row || !data || redoing || redoBlockedReason) return;
    setRedoing(true);
    setNotice(null);
    try {
      const built = buildTnQuickRequest(row, data);
      if (!built.ok) {
        say(
          built.error.reason === "missing_ult_verse"
            ? `No ${litLabel} text for this verse — the AI has nothing to work from.`
            : built.error.reason === "missing_ust_verse"
              ? `No ${simLabel} text for this verse — the AI has nothing to work from.`
              : built.error.reason === "hebrew_not_found"
                ? `Couldn't match this note's quote to the ${litLabel} alignment.`
                : "This note is missing something the AI needs.",
        );
        return;
      }
      const res = await api.tnQuick(built.request);
      setDraftValue(res.note);
      setEditing(false);
      setToast("New draft ready");
      if (res.warnings.length > 0) say(res.warnings.join(" "), "info");
    } catch (err) {
      const code =
        err instanceof ApiError && err.body && typeof err.body === "object" && "error" in err.body
          ? String((err.body as { error?: unknown }).error)
          : "";
      if (
        code === "tn_quick_disabled" ||
        code === "anthropic_api_key_missing" ||
        (err instanceof ApiError && err.status === 503)
      ) {
        // Calm and specific: this workspace simply has no AI drafting yet.
        // Nothing else on the screen is affected.
        setAiUnavailable("AI drafting isn't set up for this workspace yet.");
      } else {
        say(`Couldn't get a new draft (${err instanceof ApiError ? err.status : "error"}).`);
      }
    } finally {
      setRedoing(false);
    }
  }

  function reloadRow() {
    setConflictNotice(null);
    void refetch().then(() => setReloadNonce((n) => n + 1));
  }

  // ── render gates (every hook above this line, unconditionally) ───────────
  if (status === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="error">
          Could not load {book} {chapter}.
        </Alert>
      </Box>
    );
  }
  if (!data || !queueIds) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
        <CircularProgress />
      </Stack>
    );
  }

  const done = view === "done";
  const approvedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && !editedIds.has(id),
  ).length;
  const editedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && editedIds.has(id),
  ).length;
  const skippedCount = queueIds.filter((id) => statuses[id] === "skipped").length;

  const cardStatus = row ? statuses[row.id] : undefined;
  const chip: { kind: FlowStatusKind; label: string } =
    cardStatus === "approved"
      ? { kind: "approved", label: "Approved" }
      : cardStatus === "skipped"
        ? { kind: "skip", label: "Not needed" }
        : hasDiff || row?.translation_state === "edited"
          ? { kind: "edited", label: "Edited" }
          : { kind: "draft", label: "Draft" };

  const aiDrafted = row?.translation_state === "ai_draft" || row?.latest_source === "ai_pipeline";
  const nextChapter = chapter + 1;
  const hasNextChapter = chapterCount === null ? true : nextChapter <= chapterCount;

  const sub = translationMode
    ? `${book} ${chapter} · ${(projectConfig?.translationSource?.languageCode ?? "en").toUpperCase()} to ${targetLabel}`
    : `${book} ${chapter} · ${targetLabel}`;

  // "N of M" — while a type filter is active, position and count are within
  // the filtered set and the type label is appended ("3 of 12 · metaphor");
  // with no filter this is character-for-character the original string.
  const filteredPos = typeFilter ? visibleIdx.indexOf(cursor) : -1;
  const headerCount = typeFilter
    ? `${
        done
          ? visibleIdx.length
          : visibleIdx.length === 0
            ? 0
            : Math.max(1, filteredPos + 1)
      } of ${visibleIdx.length} · ${typeLabelOf(typeFilter)}`
    : done
      ? `${total} of ${total}`
      : `${Math.min(cursor + 1, total)} of ${total}`;

  // The current card's article type (detail header pill).
  const rowTypeSlug = row ? typeSlugOf(row.support_reference) : null;

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
      : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
    paddingBlock: 1.75,
    paddingInline: 2,
    textAlign: "start" as const,
  };

  const labelSx = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    fontSize: "0.6875rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    mb: 1,
  };

  // Quiet read-only pill naming the note's tA article type ("metaphor",
  // "merism", …). Full slug rides the title attribute. Muted chip language
  // (skip.soft/skip.ink) — deliberately NOT a FlowStatusChip: this is
  // classification, not status. textTransform/letterSpacing are reset so the
  // pill reads normally inside the uppercase labelSx header row.
  const typePill = (slug: string) => (
    <Box
      component="span"
      title={slug}
      sx={{
        flex: "none",
        maxWidth: 120,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        bgcolor: skip.soft,
        color: skip.ink,
        borderRadius: 999,
        fontSize: "0.6875rem",
        fontWeight: 600,
        lineHeight: 1.6,
        paddingInline: 1,
        paddingBlock: 0.25,
        textTransform: "none",
        letterSpacing: 0,
      }}
    >
      {typeLabelOf(slug)}
    </Box>
  );

  // Compact article-type filter — list-pane header on wide, above the cards
  // on phone. Options are the types present in this chapter's queue, with
  // counts. data-no-swipe: a drag on the select must never page the queue.
  const typeFilterControl =
    typeOptions.length > 0 ? (
      <Box data-no-swipe>
        <Select
          size="small"
          fullWidth
          displayEmpty
          value={typeFilter ?? ""}
          onChange={(e) => {
            const v = e.target.value as string;
            setTypeFilter(v === "" ? null : v);
          }}
          aria-label="Filter notes by type"
          sx={{ borderRadius: "10px", fontSize: "0.875rem", bgcolor: "background.paper" }}
        >
          <MenuItem value="">All types</MenuItem>
          {typeOptions.map((o) => (
            <MenuItem key={o.slug} value={o.slug} title={o.slug}>
              {o.label} ({o.count})
            </MenuItem>
          ))}
        </Select>
      </Box>
    ) : null;

  // Everything inside the reading column — identical at every width; only the
  // container differs (phone: the centred column; md+: the detail pane).
  const detailBody = (
    <>
        {chapterLock && (
          // Informational only: tn PATCH is lock-exempt and /validate + /trash
          // have no lock check, so nothing on this screen is blocked.
          <LockBanner
            pipelineType={chapterLock.pipelineType}
            startedAt={chapterLock.startedAt}
          />
        )}

        {conflictNotice && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={reloadRow}>
                Reload note
              </Button>
            }
          >
            {conflictNotice}
          </Alert>
        )}

        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

        {total === 0 ? (
          <Alert severity="info">No translation notes in {`${book} ${chapter}`}.</Alert>
        ) : done ? (
          <Box sx={{ ...cardSx, textAlign: "center", paddingBlock: 4.5 }}>
            <Box
              component="svg"
              width="96"
              height="96"
              viewBox="0 0 96 96"
              aria-hidden="true"
              sx={{ mx: "auto", display: "block" }}
            >
              <circle cx="48" cy="48" r="46" fill={ok.soft} />
              <circle cx="48" cy="48" r="36" fill={ok.main} />
              <path
                d="M33 49 L44 60 L64 37"
                fill="none"
                stroke="#fff"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Box>
            <Typography component="h2" sx={{ fontSize: "1.375rem", fontWeight: 700, mt: 1.5 }}>
              {book} {chapter} notes complete
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {approvedCount} approved · {editedCount} edited · {skippedCount} not needed
            </Typography>
            <Stack spacing={1}>
              <Button
                variant="contained"
                disabled={!hasNextChapter}
                onClick={() => {
                  location.hash = `#/notes/${book}/${nextChapter}`;
                }}
                sx={{
                  minHeight: 52,
                  borderRadius: "12px",
                  fontWeight: 700,
                  bgcolor: INSPIRE,
                  color: "#06293B",
                  "&:hover": { bgcolor: INSPIRE_DEEP },
                }}
              >
                {hasNextChapter
                  ? `Continue to chapter ${nextChapter}`
                  : `${book} is complete — no chapter ${nextChapter}`}
              </Button>
              <Button
                onClick={() => {
                  setReviewing(true);
                  setCursor(0);
                  setView("cards");
                }}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                Review again
              </Button>
            </Stack>
          </Box>
        ) : typeFilter && visibleIdx.length === 0 ? (
          <Alert severity="info">
            No “{typeLabelOf(typeFilter)}” notes in {book} {chapter}. Choose “All types” to keep
            going.
          </Alert>
        ) : !row ? (
          <Box sx={cardSx}>
            <Typography variant="body2" color="text.secondary">
              This note is no longer in the chapter — another editor may have removed it.
            </Typography>
            <Button
              sx={{ mt: 1 }}
              onClick={() => setCursor((c) => Math.min(c + 1, total - 1))}
              disabled={cursor >= total - 1}
            >
              Next note
            </Button>
          </Box>
        ) : (
          <>
            {/* original-language quote strip */}
            {row.quote && (
              <Stack direction="row" alignItems="baseline" spacing={1.25} sx={{ paddingInline: 0.25 }}>
                <Typography
                  component="p"
                  sx={{
                    flex: "none",
                    fontSize: "0.656rem",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    m: 0,
                  }}
                >
                  {sourceLabel}
                </Typography>
                <Typography
                  component="p"
                  dir={sourceDir}
                  sx={{
                    fontFamily: SCRIPTURE_FONT_STACK,
                    fontSize: "1.0625rem",
                    m: 0,
                    minWidth: 0,
                    textAlign: "start",
                  }}
                >
                  {row.quote}
                </Typography>
              </Stack>
            )}

            {/* scripture */}
            <Box sx={cardSx}>
              <Typography
                sx={{ fontSize: "0.875rem", fontWeight: 700, color: REF_COLOR, mb: 0.75 }}
              >
                {row.verse === 0
                  ? `${book} ${row.chapter} intro`
                  : `${book} ${row.chapter}:${row.verse}`}
              </Typography>
              <Lane
                label={litLabel}
                text={ultText}
                selection={ultSelection}
                labelFontFamily={theme.typography.fontFamily}
                mark={mark}
              />
              <Lane
                label={simLabel}
                text={ustText}
                selection={ustSelection}
                labelFontFamily={theme.typography.fontFamily}
                mark={mark}
              />
            </Box>

            {/* English source note */}
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                English note
              </Typography>
              {englishNote ? (
                <Typography
                  sx={{ fontSize: "0.97rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}
                >
                  {unescapeNewlines(englishNote)}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {translationMode
                    ? sourceProjection
                      ? "The English source for this note isn't available — it may have been added here rather than translated from the published notes."
                      : "No English source repository is configured for notes, so there is nothing to compare against."
                    : "This workspace authors notes in English rather than translating them, so there is no separate source."}
                </Typography>
              )}
            </Box>

            {/* target draft — the centrepiece */}
            <Box ref={editorContainerRef} sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                {targetLabel} draft{aiDrafted ? " · AI" : ""}
                <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 0.75 }}>
                  {/* read-only article type — classification, not a verb */}
                  {rowTypeSlug && typePill(rowTypeSlug)}
                  <FlowStatusChip kind={chip.kind} label={chip.label} />
                </Box>
              </Typography>

              {editing ? (
                <>
                  <TextField
                    inputRef={editorInputRef}
                    multiline
                    fullWidth
                    minRows={4}
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    // Target draft reads in the target language's direction, not
                    // the UI chrome's — dir attribute + start-alignment, never an
                    // sx `direction` (stylis inverts it under an RTL UI; PR #53).
                    inputProps={{ dir: targetRtl ? "rtl" : "ltr" }}
                    sx={{
                      "& .MuiOutlinedInput-root": {
                        bgcolor: "action.hover",
                        borderRadius: "9px",
                        fontSize: "0.97rem",
                        lineHeight: 1.55,
                      },
                      "& .MuiOutlinedInput-notchedOutline": {
                        borderWidth: "1.5px",
                        borderColor: INSPIRE,
                      },
                    }}
                  />
                  <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                    <Button
                      onClick={() => {
                        setEditing(false);
                        if (hasDiff) setToast("Draft updated");
                      }}
                      sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                    >
                      Done
                    </Button>
                  </Stack>
                </>
              ) : (
                <>
                  <Box
                    role="button"
                    tabIndex={0}
                    // dir follows the target language so an RTL draft aligns and
                    // orders correctly (see the editor TextField above; PR #53).
                    dir={targetRtl ? "rtl" : "ltr"}
                    onClick={() => setEditing(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditing(true);
                      }
                    }}
                    sx={{
                      cursor: "text",
                      borderRadius: "6px",
                      paddingBlock: 0.25,
                      paddingInline: 0.5,
                      marginBlock: -0.25,
                      marginInline: -0.5,
                      fontSize: "0.97rem",
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                      textAlign: "start",
                      "&:hover": { background: HL },
                    }}
                  >
                    {draftValue.trim().length > 0 ? (
                      draftValue
                    ) : (
                      <Box component="em" sx={{ color: "text.secondary" }}>
                        Nothing drafted yet — tap to write this note in {targetLabel}.
                      </Box>
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                    Tap the text to edit
                  </Typography>
                </>
              )}

              {aiUnavailable && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                  {aiUnavailable}
                </Typography>
              )}
            </Box>

            {/* previous / next — hidden in phone focus mode (keyboard-up
                editing) so the editor gets the room */}
            {!focusMode && (
              <Stack direction="row" justifyContent="space-between" spacing={1.25}>
                <Button
                  startIcon={<ChevronLeftIcon />}
                  disabled={!canPrev}
                  onClick={goPrev}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  Previous
                </Button>
                <Button
                  endIcon={<ChevronRightIcon />}
                  disabled={!canNext}
                  onClick={goNext}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  Next
                </Button>
              </Stack>
            )}
          </>
        )}
    </>
  );

  // List preview: first non-empty line, with markdown chrome stripped (leading
  // #s, ** pairs) so intro notes don't read "# Zechariah 1 General Notes".
  const previewLine = (raw: string): string =>
    (raw.split("\n").find((l) => l.trim()) ?? "")
      .replace(/^#{1,6}\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

  // One list-pane row (md+ only): verse ref · one-line preview · status chip.
  // Selecting a row moves the SAME cursor the phone's Prev/Next drives.
  const listRow = (id: string, idx: number) => {
    const r = rowById.get(id);
    if (!r) {
      return (
        <Box key={id} sx={{ ...cardSx, opacity: 0.72, paddingBlock: 1.25 }}>
          <Typography variant="body2" color="text.secondary">
            This note is no longer in the chapter.
          </Typography>
        </Box>
      );
    }
    const st = statuses[id];
    const typeSlug = typeSlugOf(r.support_reference);
    const rowChip: { kind: FlowStatusKind; label: string } =
      st === "approved"
        ? { kind: "approved", label: "Approved" }
        : st === "skipped"
          ? { kind: "skip", label: "Not needed" }
          : (id === currentId && hasDiff) || r.translation_state === "edited"
            ? { kind: "edited", label: "Edited" }
            : { kind: "draft", label: "Draft" };
    const isSelected = !done && idx === cursor;
    // Preview the TARGET text — what the translator wrote (their live draft
    // for the open card, else the row's saved note), falling back to the
    // English source note. NEVER the quote: Hebrew/Greek in a one-line
    // preview reads as noise (2026-08-10 markup round).
    const targetText = id === currentId ? draftValue : unescapeNewlines(r.note);
    const sourceNote = sourceNotes.get(id)?.note;
    const preview =
      previewLine(targetText) || (sourceNote ? previewLine(unescapeNewlines(sourceNote)) : "");
    return (
      <Box
        key={id}
        component="button"
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => {
          setCursor(idx);
          setView("cards");
        }}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          width: "100%",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          paddingBlock: 1.25,
          ...(isSelected
            ? { borderColor: INSPIRE, bgcolor: alpha(INSPIRE, dark ? 0.12 : 0.06) }
            : {}),
          "&:hover": { borderColor: INSPIRE },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>
            {r.verse === 0 ? `${r.chapter} intro` : `${r.chapter}:${r.verse}`}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            dir="auto"
            sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {preview || "Nothing drafted yet"}
          </Typography>
        </Box>
        {typeSlug && typePill(typeSlug)}
        <FlowStatusChip kind={rowChip.kind} label={rowChip.label} />
        <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary", flex: "none" }} />
      </Box>
    );
  };

  // Action bar — the three verbs. Phone: fixed to the viewport bottom; md+:
  // anchored inside the detail pane (sticky at its bottom, pinned there by
  // margin-block-start:auto when the content is short — the words screen's
  // pane pattern).
  const actionBar =
    !done && total > 0 && row ? (
        <Box
          component="footer"
          // Guard the verbs from the swipe surface: a horizontal drag that
          // starts on Approve / Not needed / Redo must never page the queue.
          data-no-swipe
          sx={
            wide
              ? {
                  position: "sticky",
                  insetBlockEnd: 0,
                  zIndex: 10,
                  marginBlockStart: "auto",
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
              : {
                  position: "fixed",
                  insetBlockEnd: 0,
                  insetInline: 0,
                  zIndex: theme.zIndex.appBar,
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
          }
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              maxWidth: wide ? "none" : COLUMN_PX,
              mx: "auto",
              paddingInline: wide ? 2.5 : 2,
              paddingBlockStart: 1.5,
              paddingBlockEnd: wide ? 1.5 : "calc(12px + env(safe-area-inset-bottom))",
            }}
          >
            <Button
              variant="outlined"
              disabled={redoBlockedReason !== null || redoing || busy}
              title={redoBlockedReason ?? "Ask the AI for a fresh draft"}
              onClick={() => void handleRedo()}
              startIcon={
                <AutoAwesomeIcon
                  sx={
                    redoing
                      ? { animation: "be-spin 0.8s linear infinite", "@keyframes be-spin": { to: { transform: "rotate(360deg)" } } }
                      : undefined
                  }
                />
              }
              sx={{
                flex: 1,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                color: ACCENT,
                borderColor: INSPIRE,
                borderWidth: "1.5px",
              }}
            >
              Redo
            </Button>
            <Button
              disabled={busy || redoing}
              onClick={() => void handleNotNeeded()}
              sx={{
                flex: 1,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                bgcolor: skip.soft,
                color: skip.ink,
                "&:hover": { bgcolor: skip.soft },
              }}
            >
              Not needed
            </Button>
            <Button
              disabled={busy || redoing}
              onClick={() => void handleApprove()}
              startIcon={<CheckIcon />}
              sx={{
                flex: 1.4,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                bgcolor: ok.main,
                color: "#fff",
                "&:hover": { bgcolor: ok.main, filter: "brightness(0.95)" },
              }}
            >
              Approve
            </Button>
          </Stack>
        </Box>
    ) : null;

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        textAlign: "start",
        ...(wide
          ? { display: "flex", flexDirection: "column", overflow: "hidden" }
          : { overflowY: "auto" }),
      }}
    >
      {/* topbar (at md+ the root doesn't scroll, so sticky is simply inert).
          Hidden in phone focus mode — an active edit on a narrow viewport
          gets the keyboard-constrained screen to itself. */}
      {!focusMode && (
      <Box
        sx={{
          position: "sticky",
          insetBlockStart: 0,
          zIndex: 20,
          flex: "none",
          bgcolor: "background.paper",
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <IconButton
              aria-label={`Back to the ${book} package`}
              onClick={() => {
                location.hash = `#/package/${book}`;
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                Translation Notes
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {sub}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {headerCount}
            </Typography>
            {/* compact prev/next — same cursor and disabled logic as the card
                stack's Prev/Next; chevrons flip under RTL (the scripture
                screen's scaleX pattern). 2026-08-10 markup round. */}
            <IconButton
              size="small"
              aria-label="Previous note"
              disabled={done || !canPrev}
              onClick={goPrev}
              sx={{ flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Next note"
              disabled={done || !canNext}
              onClick={goNext}
              sx={{ flex: "none" }}
            >
              <ChevronRightIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
          </Stack>
          <Box
            sx={{
              height: 4,
              borderRadius: "2px",
              bgcolor: skip.soft,
              mt: 1.25,
              overflow: "hidden",
            }}
          >
            <Box
              sx={{
                height: "100%",
                borderRadius: "2px",
                bgcolor: INSPIRE,
                transition: "width 0.35s ease",
                width: total === 0 ? "0%" : `${(statusedCount / total) * 100}%`,
              }}
            />
          </Box>
        </Box>
      </Box>
      )}

      {wide ? (
        /* desk (the words screen's md+ pattern): 1440px centred grid — the
           note queue as a scrollable list pane on the inline-start side, the
           card stack in a panel-chromed detail pane. Grid column order follows
           the document direction, so this is RTL-safe as-is. */
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            maxWidth: 1440,
            mx: "auto",
            display: "grid",
            gridTemplateColumns: "minmax(340px, 380px) minmax(0, 1fr)",
            gap: 2.5,
            paddingInline: 2,
            paddingBlockStart: 1.5,
            paddingBlockEnd: 2,
          }}
        >
          {/* list pane */}
          <Box
            sx={{
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1.25,
              paddingInline: 0.25,
              paddingBlockEnd: 2,
            }}
          >
            {typeFilterControl}
            {total === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mx: 0.25 }}>
                No translation notes in {book} {chapter}.
              </Typography>
            ) : typeFilter && visibleIdx.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mx: 0.25 }}>
                No “{typeLabelOf(typeFilter)}” notes in {book} {chapter}.
              </Typography>
            ) : typeFilter ? (
              visibleIdx.map((i) => listRow(queueIds[i], i))
            ) : (
              queueIds.map(listRow)
            )}
          </Box>
          {/* detail pane */}
          <Box
            sx={{
              minHeight: 0,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: "14px",
              overflow: "hidden",
            }}
          >
            <Box
              {...swipe}
              sx={{
                height: "100%",
                minHeight: 0,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box
                sx={{
                  width: "100%",
                  flex: "none",
                  paddingInline: 2.5,
                  paddingBlockStart: 2,
                  paddingBlockEnd: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.5,
                }}
              >
                {detailBody}
              </Box>
              {actionBar}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box
          {...swipe}
          sx={{
            maxWidth: COLUMN_PX,
            mx: "auto",
            paddingInline: 2,
            paddingBlockStart: 2,
            // room for the fixed action bar — collapsed in phone focus mode,
            // where the action bar itself is hidden
            paddingBlockEnd: done ? 4 : focusMode ? 2 : 15,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
          }}
        >
          {!done && total > 0 && !focusMode && typeFilterControl}
          {detailBody}
        </Box>
      )}
      {!wide && !focusMode && actionBar}

      <Snackbar
        open={toast !== null}
        message={toast ?? ""}
        autoHideDuration={1400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: 96 }}
      />
    </Box>
  );
}
