// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t4-align: the per-verse word-alignment screen, ported from
// docs/flows/ui/t4-align.html.
//
// ── The save decision (the one that matters here) ──────────────────────────
// The MOCKUP disabled Save, and said why: a vanilla preview cannot rebuild a
// valid `\zaln-s/\zaln-e` verseObjects tree from canvas state, so saving would
// erase alignment (docs/flows/05-functional-preview-findings.md).
//
// The APP does not have that problem. web/src/lib/alignment.ts already parses
// the per-verse tree into an editable model and serializes it back
// (parseAlignment / serializeAlignment), and web/src/components/AlignmentPanel
// is the shipped, tested drag aligner over it. So this screen composes the real
// aligner instead of re-implementing a read-only picture of it:
//
//   * Drag canvas view  = <AlignmentPanel>, embedded verbatim. Its props are
//     plain data plus callbacks (no Shell coupling), so it brings its own
//     crash-drafts, ghost suggestions, lexicon tooltips and unalign confirm.
//   * Tap-to-pair view  = <AlignTapView>, this screen's own UI, but every edit
//     goes through the same lib/alignment primitives and the same serializer.
//   * Side-by-side      = <SideBySideAligner>, the app's real dual aligner.
//
// Saves are therefore REAL, and they take the established path: the collateral
// -loss guard (guardBlocksSave), then outbox.enqueueVerse with
// `alignment_intent: "alignment_edit"` + `If-Match` + `X-Source-Generation` —
// exactly what Shell.enqueueVerseSafely does. NOTHING here hand-builds or
// hand-patches verse JSON.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { FlowNav } from "./FlowNav";
import { LockBanner } from "./FlowBanners";
import { AlignTapView } from "./AlignTapView";
import {
  buildSourceIndexMap,
  collectStrongKeys,
  orderDisplayGroups,
  streamWordsOf,
} from "./AlignSourceModel";
import type { FlowScreenContext } from "./types";

import { AlignmentPanel, type AlignmentPanelHandle } from "../AlignmentPanel";
import {
  SideBySideAligner,
  type PanelSlot,
  type ReadingLineHandle,
} from "../SideBySideAligner";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import { useAlignmentSuggestions } from "../../hooks/useAlignmentSuggestions";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { alignmentDrafts, alignmentDraftKey } from "../../sync/alignmentDrafts";
import { isLaneFrozen } from "../../sync/laneFreeze";
import type { ChapterLockedBody, ChapterPayload, TwlRow, VerseDto } from "../../sync/api";
import {
  alignmentPlainText,
  parseAlignment,
  serializeAlignment,
  type AlignmentState,
} from "../../lib/alignment";
import { computeGhosts, dismissedGhostKey, type Ghost } from "../../lib/alignmentSuggest";
import { analyzeAlignmentDelta, guardBlocksSave, lostAlignedWords } from "../../lib/alignmentDelta";
import { buildVerseIndex, concatSourceRange, formatVerseLabel } from "../../lib/verseRange";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionIsRtl, versionLabel } from "../../lib/versionLabels";
import { extractEditableText, extractPlainText, normalizeEditable } from "../../lib/usfm";
import { smartEditVerse } from "../../lib/replace";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface AlignScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

const TARGET = "ULT";
const SECOND = "UST";

// Stable empty list so `twlForVerse` identity doesn't churn AlignmentPanel's
// memos on every render when the slice is missing.
const EMPTY_TWL: TwlRow[] = [];

interface Slice {
  targetVerse: VerseDto | null;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  rangeStart: number;
  rangeEnd: number;
}

// Per-version slice: the target row covering `verse` (which may be a range row
// such as UST 6-9), the source verses that row actually covers, and the TWL
// rows for that span. Mirrors Shell's private buildAlignerSlice — resolving
// through buildVerseIndex is what lets v7 of a 6-9 block find its row.
function buildSlice(
  data: ChapterPayload,
  verse: number,
  bibleVersion: string,
  sourceLane: string,
): Slice {
  const targetVerse = buildVerseIndex(data.verses[bibleVersion])[verse] ?? null;
  const rangeStart = targetVerse?.verse ?? verse;
  const rangeEnd = targetVerse?.verse_end ?? targetVerse?.verse ?? verse;
  const sourceVerse =
    rangeEnd > rangeStart
      ? concatSourceRange(data.verses[sourceLane] ?? {}, rangeStart, rangeEnd)
      : (data.verses[sourceLane]?.[rangeStart] ?? null);
  const twlForVerse = data.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
  return { targetVerse, sourceVerse, twlForVerse, rangeStart, rangeEnd };
}

// Source word-token count of one row — used only to offset the side-by-side
// panels into the shared strip's union span. Mirrors Shell's countSourceWords.
function countSourceWords(row: VerseDto | undefined): number {
  const verseObjects = (row?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  let n = 0;
  const walk = (nodes: unknown[]) => {
    for (const x of nodes ?? []) {
      const o = x as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") n++;
      else if (o["type"] === "milestone" || (o["type"] === "section" && o["tag"] === "d"))
        walk((o["children"] as unknown[] | undefined) ?? []);
    }
  };
  walk(verseObjects ?? []);
  return n;
}

function verseObjectsOf(v: VerseDto | null): unknown[] | null {
  const vo = (v?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

interface PendingLoss {
  ref: string;
  lostWords: string[];
  commit: () => void;
}

// `me` is part of the shared flow-screen contract but unused here (identity is
// not shown on this screen); `onNavigate` likewise — verse movement stays on
// this screen by moving the hash, rather than jumping to the editor.
export default function AlignScreen({ role, book, chapter, verse }: AlignScreenProps) {
  const theme = useTheme();
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560
  const isDesktop = useMediaQuery(theme.breakpoints.up("md")); // >=900

  const { status, data, applyLocalVerse } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  // Viewers must not be able to start a save. Below the UI, alignmentDrafts.set
  // early-returns and outbox.enqueueVerse no-ops for a viewer, so an ungated
  // screen applies the change locally, clears the draft, and looks saved while
  // the work is silently dropped. Same gate ScriptureScreen uses.
  const canEdit = role === "admin" || role === "editor";

  const sourceLane = isHebrewBook(book) ? "UHB" : "UGNT";
  const sourceRtl = sourceLane === "UHB";
  const targetRtl = versionIsRtl(projectConfig, TARGET);
  const targetLabel = versionLabel(projectConfig, TARGET);

  const slice = useMemo<Slice | null>(
    () => (data ? buildSlice(data, verse, TARGET, sourceLane) : null),
    [data, verse, sourceLane],
  );
  const targetVerse = slice?.targetVerse ?? null;
  const sourceVerse = slice?.sourceVerse ?? null;
  const twlForVerse = slice?.twlForVerse ?? EMPTY_TWL;

  // ── interaction mode (form-factor policy, docs/flows/04-mobile-alignment) ──
  // <560 tap only · 560–899 tap default · >=900 drag default, both toggleable.
  const [modeChoice, setModeChoice] = useState<"drag" | "tap" | null>(null);
  useEffect(() => {
    setModeChoice(null); // band change resets to the band's default
  }, [isDesktop, isTabletUp]);
  const mode: "drag" | "tap" = !isTabletUp ? "tap" : (modeChoice ?? (isDesktop ? "drag" : "tap"));

  // ── tap-to-pair state, over the SAME parsed model the drag canvas uses ────
  const sourceVerseObjects = useMemo(() => verseObjectsOf(sourceVerse), [sourceVerse]);
  const computedInitial = useMemo<AlignmentState | null>(() => {
    const vo = verseObjectsOf(targetVerse);
    return vo ? parseAlignment(vo, sourceVerseObjects) : null;
  }, [targetVerse, sourceVerseObjects]);

  const [tapState, setTapState] = useState<AlignmentState | null>(computedInitial);
  const tapStateRef = useRef(tapState);
  useEffect(() => {
    tapStateRef.current = tapState;
  });

  const draftKey = alignmentDraftKey(book, chapter, verse, TARGET);

  // Reset to the freshly parsed baseline whenever the verse/content changes,
  // then re-hydrate a crash-saved alignment draft for this verse. Same store,
  // same key and the same three guards the drag canvas uses (AlignmentPanel),
  // so an unsaved edit survives a reload and carries between the two modes.
  useEffect(() => {
    setTapState(computedInitial);
    if (!computedInitial || !targetVerse) return;
    const baseVersion = targetVerse.version;
    const baseGen = targetVerse.source_generation;
    let cancelled = false;
    void alignmentDrafts.get(draftKey).then((rec) => {
      if (cancelled || !rec) return;
      if (rec.quarantined || isLaneFrozen(TARGET)) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      if (rec.expectedVersion !== baseVersion) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      if (rec.sourceGeneration == null || (baseGen != null && rec.sourceGeneration !== baseGen)) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      if (tapStateRef.current !== computedInitial) return; // user already edited
      const vo = (rec.content as { verseObjects?: unknown[] }).verseObjects;
      if (!Array.isArray(vo)) return;
      setTapState(parseAlignment(vo, sourceVerseObjects));
    });
    return () => {
      cancelled = true;
    };
  }, [computedInitial, targetVerse, draftKey, sourceVerseObjects]);

  const tapDirty = tapState !== null && tapState !== computedInitial;

  // Persist in-progress tap edits (debounced) so a crash doesn't lose them.
  useEffect(() => {
    if (!tapDirty || !tapState || !targetVerse) return;
    const baseVersion = targetVerse.version;
    const gen = targetVerse.source_generation;
    const t = setTimeout(() => {
      void alignmentDrafts.set(
        draftKey,
        { verseObjects: serializeAlignment(tapState) },
        baseVersion,
        { sourceGeneration: gen },
      );
    }, 400);
    return () => clearTimeout(t);
  }, [tapState, tapDirty, targetVerse, draftKey]);

  // ── suggestions (real: same scorer the drag canvas + eval harness use) ────
  const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);
  const strongKeys = useMemo(
    () => collectStrongKeys(tapState, sourceVerse),
    [tapState, sourceVerse],
  );
  const lexiconMap = useLexicon(strongKeys.strongs);
  const suggestions = useAlignmentSuggestions(TARGET, strongKeys.keys);
  const displayCards = useMemo(
    () => orderDisplayGroups(tapState, sourceIndexMap),
    [tapState, sourceIndexMap],
  );
  const streamWords = useMemo(() => streamWordsOf(tapState), [tapState]);
  const [dismissedGhosts, setDismissedGhosts] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedGhosts(new Set());
  }, [verse]);
  const ghosts = useMemo(
    () => computeGhosts(displayCards, streamWords, suggestions, dismissedGhosts),
    [displayCards, streamWords, suggestions, dismissedGhosts],
  );
  const handleDismissGhost = useCallback(
    (ghost: Ghost) => {
      const g = displayCards.find((x) => x.id === ghost.groupId);
      if (!g) return;
      const key = dismissedGhostKey(g, ghost.text);
      setDismissedGhosts((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    },
    [displayCards],
  );

  // ── chrome state ──────────────────────────────────────────────────────────
  const [dragDirty, setDragDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lock, setLock] = useState<ChapterLockedBody | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);
  const [refPanelOpen, setRefPanelOpen] = useState(false);
  const [sbsOpen, setSbsOpen] = useState(false);

  const panelRef = useRef<AlignmentPanelHandle | null>(null);
  const dualLeftRef = useRef<AlignmentPanelHandle | null>(null);
  const dualRightRef = useRef<AlignmentPanelHandle | null>(null);
  const dualLeftReadingRef = useRef<ReadingLineHandle | null>(null);
  const dualRightReadingRef = useRef<ReadingLineHandle | null>(null);
  // Unsaved work inside the side-by-side dialog: alignment drags in either
  // panel, and reading-text edits in either ReadingLine. Both live only in
  // memory/DOM until an explicit save, so closing or re-targeting the dialog
  // without a gate discards them silently. Mirrors Shell.tsx (2101-2144).
  const [dualLeftDirty, setDualLeftDirty] = useState(false);
  const [dualRightDirty, setDualRightDirty] = useState(false);
  const [dualLeftReadingDirty, setDualLeftReadingDirty] = useState(false);
  const [dualRightReadingDirty, setDualRightReadingDirty] = useState(false);
  const [pendingDualAction, setPendingDualAction] = useState<{ run: () => void } | null>(null);
  const dualDirty =
    dualLeftDirty || dualRightDirty || dualLeftReadingDirty || dualRightReadingDirty;
  // Full-page unloads (reload / tab close / external nav) bypass the in-app
  // gate below, so they get the browser's own confirm while work is unsaved.
  useUnsavedGuard(dualDirty);

  // Reactive lock banner. An alignment save ships through the outbox, so its
  // 409 `chapter_locked` arrives as an outbox result, not a throw here. The
  // banner therefore always reflects a real server body (pipeline + start
  // time) — never a guessed editor name.
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "locked") return;
      if (op.target.kind !== "verse" || op.target.book !== book) return;
      setLock(result.lockBody);
    });
  }, [book]);

  // ── the save path ─────────────────────────────────────────────────────────
  // Identical in shape to Shell.enqueueVerseSafely: guard, then enqueue with
  // the alignment_edit intent and the row's source generation. alignment_edit
  // is the one intent the collateral-loss guard exempts (re-aligning legitimately
  // changes sources) — the call stays so a future intent change can't silently
  // bypass the guard.
  const enqueueAlignment = useCallback(
    (row: VerseDto, bibleVersion: string, content: unknown, plain: string, expectedVersion: number) => {
      if (!canEdit) {
        setNotice("You have view-only access to this project — alignment changes can't be saved.");
        return;
      }
      const delta = analyzeAlignmentDelta(row.content, content);
      if (guardBlocksSave(delta, "alignment_edit")) {
        setNotice("Save blocked: this change would de-align words it didn't touch.");
        return;
      }
      void outbox.enqueueVerse(
        book,
        chapter,
        row.verse,
        bibleVersion,
        expectedVersion,
        { content, plain_text: plain, alignment_intent: "alignment_edit" },
        { sourceGeneration: row.source_generation },
      );
      applyLocalVerse({ ...row, content, plain_text: plain } as VerseDto);
    },
    [book, chapter, applyLocalVerse, canEdit],
  );

  const confirmUnalignFor = useCallback(
    (row: VerseDto | null, bibleVersion: string) => (lostWords: string[], commit: () => void) =>
      setPendingLoss({
        ref: `${book} ${chapter}:${row?.verse ?? verse} ${bibleVersion}`,
        lostWords,
        commit,
      }),
    [book, chapter, verse],
  );

  const handlePanelSave = useCallback(
    (content: unknown, plain: string, expectedVersion: number) => {
      if (!targetVerse) return;
      enqueueAlignment(targetVerse, TARGET, content, plain, expectedVersion);
    },
    [targetVerse, enqueueAlignment],
  );

  // Tap-mode save. serializeAlignment + alignmentPlainText are the library's
  // own writers — the same two the drag panel calls — so the \zaln tree is
  // rebuilt by the tested code path, never assembled here.
  const handleTapSave = useCallback(() => {
    if (!canEdit) {
      setNotice("You have view-only access to this project — alignment changes can't be saved.");
      return;
    }
    if (!tapState || !targetVerse) return;
    const content = { verseObjects: serializeAlignment(tapState) };
    const plain = alignmentPlainText(tapState);
    const commit = () => {
      enqueueAlignment(targetVerse, TARGET, content, plain, targetVerse.version);
      void alignmentDrafts.clear(draftKey);
    };
    const lost = lostAlignedWords(targetVerse.content, content);
    if (lost.length > 0) {
      setPendingLoss({ ref: `${book} ${chapter}:${targetVerse.verse} ${TARGET}`, lostWords: lost, commit });
      return;
    }
    commit();
  }, [canEdit, tapState, targetVerse, enqueueAlignment, draftKey, book, chapter]);

  const handleTapReset = useCallback(() => {
    setTapState(computedInitial);
    void alignmentDrafts.clear(draftKey);
  }, [computedInitial, draftKey]);

  // ── side-by-side (real dual aligner) ──────────────────────────────────────
  const ustSlice = useMemo<Slice | null>(
    () => (data ? buildSlice(data, verse, SECOND, sourceLane) : null),
    [data, verse, sourceLane],
  );

  // Reading-line save inside the dual aligner: scripture text edits go through
  // smartEditVerse (the alignment-preserving edit engine), never a plain-text
  // body. Mirrors Shell.saveVerseDraft, including its no-op guard and the
  // text_edit confirm when the engine can't keep every word aligned.
  const handleSaveReading = useCallback(
    (bibleVersion: string, plain: string, base: VerseDto) => {
      if (!canEdit) {
        setNotice("You have view-only access to this project — verse text can't be saved.");
        return;
      }
      // Same baseline the reading line itself renders from, so the no-op guard
      // compares like with like.
      const oldEditable = extractEditableText(base.content);
      if (oldEditable === normalizeEditable(plain)) return;
      const result = smartEditVerse(base.content, oldEditable, plain);
      const newPlainText = extractPlainText(result.content);
      const enqueueText = (intent: "text_edit" | "alignment_edit") => {
        void outbox.enqueueVerse(
          book,
          chapter,
          base.verse,
          bibleVersion,
          base.version,
          { content: result.content, plain_text: newPlainText, alignment_intent: intent },
          { sourceGeneration: base.source_generation },
        );
        applyLocalVerse({ ...base, content: result.content, plain_text: newPlainText } as VerseDto);
      };
      const delta = analyzeAlignmentDelta(base.content, result.content);
      if (guardBlocksSave(delta, "text_edit")) {
        // Same choice Shell makes: don't discard the translator's text — offer
        // the confirm, and on "Save anyway" re-enqueue as alignment_edit (the
        // only guard-exempt intent, mirrored server-side in verses.ts).
        setPendingLoss({
          ref: `${book} ${chapter}:${base.verse} ${bibleVersion}`,
          lostWords: delta.unexpectedLosses.map((l) => l.text),
          commit: () => enqueueText("alignment_edit"),
        });
        return;
      }
      enqueueText("text_edit");
    },
    [book, chapter, applyLocalVerse, canEdit],
  );

  const dualProps = useMemo(() => {
    if (!data || !slice || !ustSlice) return null;
    if (!slice.targetVerse && !ustSlice.targetVerse) return null;
    const rangeStart = Math.min(slice.rangeStart, ustSlice.rangeStart);
    const rangeEnd = Math.max(slice.rangeEnd, ustSlice.rangeEnd);
    const byStart = data.verses[sourceLane] ?? {};
    const unionSource =
      rangeEnd > rangeStart
        ? concatSourceRange(byStart, rangeStart, rangeEnd)
        : (byStart[rangeStart] ?? null);
    const offsetFor = (ownStart: number) => {
      let off = 0;
      for (let v = rangeStart; v < ownStart; v++) off += countSourceWords(byStart[v]);
      return off;
    };
    const saveFor = (bibleVersion: string, row: VerseDto | null) =>
      (content: unknown, plain: string, expectedVersion: number) => {
        if (!row) return;
        enqueueAlignment(row, bibleVersion, content, plain, expectedVersion);
      };
    const left: PanelSlot = {
      bibleVersion: TARGET,
      verse: slice.targetVerse,
      sourceVerse: slice.sourceVerse,
      twlForVerse: slice.twlForVerse,
      posOffset: offsetFor(slice.rangeStart),
      onSave: saveFor(TARGET, slice.targetVerse),
      onConfirmUnalign: confirmUnalignFor(slice.targetVerse, TARGET),
      onDirtyChange: setDualLeftDirty,
      panelRef: dualLeftRef,
      onReadingDirtyChange: setDualLeftReadingDirty,
      readingRef: dualLeftReadingRef,
    };
    const right: PanelSlot = {
      bibleVersion: SECOND,
      verse: ustSlice.targetVerse,
      sourceVerse: ustSlice.sourceVerse,
      twlForVerse: ustSlice.twlForVerse,
      posOffset: offsetFor(ustSlice.rangeStart),
      onSave: saveFor(SECOND, ustSlice.targetVerse),
      onConfirmUnalign: confirmUnalignFor(ustSlice.targetVerse, SECOND),
      onDirtyChange: setDualRightDirty,
      panelRef: dualRightRef,
      onReadingDirtyChange: setDualRightReadingDirty,
      readingRef: dualRightReadingRef,
    };
    const labelVerse = slice.targetVerse ?? ustSlice.targetVerse;
    return {
      sourceVerse: unionSource,
      twlForVerse: data.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd),
      vref: `${book} ${chapter}:${labelVerse ? formatVerseLabel(labelVerse) : verse}`,
      left,
      right,
    };
  }, [data, slice, ustSlice, sourceLane, book, chapter, verse, enqueueAlignment, confirmUnalignFor]);

  // ── verse navigation (stays on this screen; the route drives `verse`) ─────
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.[TARGET] ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);
  const verseIdx = verseNums.indexOf(verse);
  const prevVerse = verseIdx > 0 ? verseNums[verseIdx - 1] : null;
  const nextVerse = verseIdx >= 0 && verseIdx < verseNums.length - 1 ? verseNums[verseIdx + 1] : null;
  const goVerse = (n: number | null) => {
    if (n == null) return;
    location.hash = `#/align/${book}/${chapter}/${n}`;
  };

  // ── the side-by-side unsaved gate (ported from Shell.tsx 2126-2178) ───────
  // Anything that leaves or re-targets the dual aligner asks first when either
  // panel holds unsaved drags or reading-text edits.
  const requestDualAction = (run: () => void) => {
    if (dualDirty) setPendingDualAction({ run });
    else run();
  };
  const requestCloseDual = () => requestDualAction(() => setSbsOpen(false));
  const dualNavTo = (n: number | null) => requestDualAction(() => goVerse(n));
  const resolveDualAction = (choice: "save" | "discard") => {
    const action = pendingDualAction;
    setPendingDualAction(null);
    // Only touch the dirty side(s): save() enqueues a PATCH unconditionally, so
    // calling it on a clean panel bumps that row's version for nothing (and can
    // 409 against a concurrent editor).
    if (choice === "discard") {
      if (dualLeftDirty) dualLeftRef.current?.discard();
      if (dualRightDirty) dualRightRef.current?.discard();
      if (dualLeftReadingDirty) dualLeftReadingRef.current?.discard();
      if (dualRightReadingDirty) dualRightReadingRef.current?.discard();
      action?.run();
      return;
    }
    // Reading-line edits are plain text — synchronous, no unalign confirm.
    if (dualLeftReadingDirty) dualLeftReadingRef.current?.save();
    if (dualRightReadingDirty) dualRightReadingRef.current?.save();
    // Each alignment panel may defer behind the unalign confirm, so CHAIN them:
    // the close/nav runs only once both have actually committed, and at most one
    // confirm is ever open (the right panel's opens after the left resolves, so
    // a second setPendingLoss can't clobber the first pending commit). A cancel
    // anywhere in the chain stops the close entirely.
    const finish = () => action?.run();
    const saveRight = () => {
      if (dualRightDirty && dualRightRef.current) dualRightRef.current.save(finish);
      else finish();
    };
    if (dualLeftDirty && dualLeftRef.current) dualLeftRef.current.save(saveRight);
    else saveRight();
  };

  const dirty = mode === "drag" ? dragDirty : tapDirty;

  // ── render ────────────────────────────────────────────────────────────────
  if (status === "idle" || status === "loading" || status === "retrying") {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="align" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ p: 2, maxWidth: 1180, marginInline: "auto", width: "100%" }}>
          <Skeleton variant="text" width={220} height={38} />
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
          <Skeleton variant="rounded" height={260} sx={{ mt: 2 }} />
        </Box>
      </Stack>
    );
  }

  if (status === "error" || !data) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="align" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ p: 2, maxWidth: 1180, marginInline: "auto", width: "100%" }}>
          <Alert severity="error">
            Could not load {book} {chapter}. Check your connection and try again.
          </Alert>
        </Box>
      </Stack>
    );
  }

  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        flexWrap: "wrap",
        marginBlockEnd: 1.5,
      }}
    >
      <Button
        onClick={() => goVerse(prevVerse)}
        disabled={prevVerse == null}
        startIcon={<ChevronLeftIcon />}
        sx={{ minHeight: 44 }}
      >
        Prev
      </Button>
      <Typography component="h1" sx={{ fontSize: 18, fontWeight: 700, color: "primary.main" }}>
        {book} {chapter}:{targetVerse ? formatVerseLabel(targetVerse) : verse} · {targetLabel}
      </Typography>
      <Button
        onClick={() => goVerse(nextVerse)}
        disabled={nextVerse == null}
        endIcon={<ChevronRightIcon />}
        sx={{ minHeight: 44 }}
      >
        Next
      </Button>
      <Box sx={{ flex: 1 }} />
      <Button
        variant="outlined"
        onClick={() => setSbsOpen(true)}
        disabled={!dualProps}
        title={dualProps ? undefined : "No ULT or UST content for this verse to compare."}
        sx={{ minHeight: 44 }}
      >
        Side-by-side
      </Button>
    </Box>
  );

  const noTarget = !targetVerse;
  const noSource = !sourceVerse;
  // ULT is the "lit" lane in ProjectConfig.laneState. `pendingTarget`
  // (pending_target_json) is the signal that actually drives the verse 409
  // gate — the only evidence this screen has that a replacement is underway.
  const targetLanePending = Boolean(projectConfig?.laneState?.lit?.pendingTarget);

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <FlowNav current="align" book={book} chapter={chapter} verse={verse} role={role} />
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 2,
          maxWidth: 1180,
          marginInline: "auto",
          width: "100%",
        }}
      >
        {header}

        {lock && (
          <Box sx={{ marginBlockEnd: 2 }}>
            <LockBanner pipelineType={lock.pipelineType} startedAt={lock.startedAt} />
          </Box>
        )}

        {!canEdit && (
          <Alert severity="info" sx={{ marginBlockEnd: 2 }}>
            You have view-only access to this project, so alignment is read-only here — pairings
            can be inspected but not changed or saved.
          </Alert>
        )}

        {noTarget || noSource ? (
          <Alert severity="info" sx={{ marginBlockEnd: 2 }}>
            {noTarget
              ? // Only a real pending signal earns replacement wording. Absent
                // that, an empty target lane is simply undrafted — which is the
                // normal state of a translation-mode workspace.
                targetLanePending
                ? `${targetLabel} is awaiting a source replacement — a lane in that state is omitted from the chapter payload entirely, so there is nothing to align until the replacement lands.`
                : `No ${targetLabel} text exists for ${book} ${chapter}:${verse} in this workspace. That is normal in a translation-mode workspace whose target lanes have not been drafted yet — there is nothing to align until it is drafted.`
              : `There is no ${sourceLane} source text for ${book} ${chapter}:${verse}, so alignment can't be anchored to original-language words.`}
          </Alert>
        ) : (
          <>
            {/* mode toggle — hidden below 560, where drag isn't offered at all */}
            {isTabletUp && (
              <Box
                role="group"
                aria-label="Alignment interaction mode"
                sx={{ display: "flex", gap: 1, flexWrap: "wrap", marginBlockEnd: 1.5 }}
              >
                <Button
                  variant={mode === "drag" ? "contained" : "outlined"}
                  aria-pressed={mode === "drag"}
                  disabled={mode !== "drag" && dirty}
                  onClick={() => setModeChoice("drag")}
                  sx={{ minHeight: 44 }}
                >
                  Drag canvas
                </Button>
                <Button
                  variant={mode === "tap" ? "contained" : "outlined"}
                  aria-pressed={mode === "tap"}
                  disabled={mode !== "tap" && dirty}
                  onClick={() => setModeChoice("tap")}
                  sx={{ minHeight: 44 }}
                >
                  Tap mode (keyboard accessible)
                </Button>
                {dirty && (
                  <Typography variant="caption" sx={{ alignSelf: "center", color: "text.secondary" }}>
                    Save or reset your unsaved alignment before switching modes.
                  </Typography>
                )}
              </Box>
            )}
            {!isTabletUp && (
              <Typography
                variant="caption"
                sx={{ display: "block", color: "text.secondary", marginBlockEnd: 1.5 }}
              >
                The drag canvas needs a larger screen. Tap-to-pair below does everything it
                does — tap a word, then tap where it belongs.
              </Typography>
            )}

            {/* reference panel — the verse's own saved \zaln groups, read-only.
                This environment has no separate "unfoldingWord canonical"
                snapshot to compare against, so rather than invent one the panel
                shows the real current alignment, and says so. */}
            <Box sx={{ marginBlockEnd: 2 }}>
              <Button
                variant="outlined"
                onClick={() => setRefPanelOpen((v) => !v)}
                aria-expanded={refPanelOpen}
                aria-controls="align-ref-panel"
                sx={{ minHeight: 44 }}
              >
                Reference — saved {targetLabel} alignment
              </Button>
              {refPanelOpen && (
                <Box
                  id="align-ref-panel"
                  sx={{
                    marginBlockStart: 1,
                    bgcolor: "action.hover",
                    border: "1px dashed",
                    borderColor: "divider",
                    borderRadius: "12px",
                    padding: 1.75,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ display: "block", fontStyle: "italic", color: "text.secondary", mb: 1 }}
                  >
                    Read-only — the alignment currently saved on the server for this verse,
                    shown for comparison. Unsaved edits are not reflected here.
                  </Typography>
                  <Box
                    role="list"
                    dir={sourceRtl ? "rtl" : "ltr"}
                    sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}
                  >
                    {orderDisplayGroups(computedInitial, sourceIndexMap).map((g) => (
                      <Box
                        key={g.id}
                        role="listitem"
                        sx={{
                          bgcolor: "background.paper",
                          border: "1px solid",
                          borderColor: "divider",
                          borderRadius: "9px",
                          paddingBlock: 0.75,
                          paddingInline: 1.25,
                        }}
                      >
                        <Box sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: 14 }}>
                          {g.source.map((s) => s.content ?? "").join(" ")}
                        </Box>
                        <Box
                          dir={targetRtl ? "rtl" : "ltr"}
                          sx={{ fontSize: 11, color: "text.secondary", marginBlockStart: "2px" }}
                        >
                          {g.targets.length
                            ? g.targets.map((t) => t.text).join(" ")
                            : "(unaligned)"}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>

            {/* ── the aligner ─────────────────────────────────────────────── */}
            {mode === "drag" ? (
              <Box
                sx={{
                  minHeight: 420,
                  display: "flex",
                  flexDirection: "column",
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: "12px",
                  overflow: "hidden",
                }}
              >
                <AlignmentPanel
                  // Fresh mount per target so the panel's state is seeded
                  // synchronously for the right verse (the stale-state race
                  // ResourceColumn's key comment describes).
                  key={`${TARGET}:${chapter}:${verse}`}
                  ref={panelRef}
                  book={book}
                  chapter={chapter}
                  verseNum={verse}
                  bibleVersion={TARGET}
                  verse={targetVerse}
                  sourceVerse={sourceVerse}
                  sourceLabel={sourceLane}
                  twlForVerse={twlForVerse}
                  onSave={handlePanelSave}
                  onConfirmUnalign={confirmUnalignFor(targetVerse, TARGET)}
                  onCancel={() => setModeChoice("tap")}
                  hideCancel
                  onDirtyChange={setDragDirty}
                  onOpenDual={dualProps ? () => setSbsOpen(true) : undefined}
                />
              </Box>
            ) : tapState ? (
              <>
                <AlignTapView
                  // Fresh mount per verse: the view's own local state (the
                  // selection, and the skipped-suggestion set whose ids are
                  // groupId+text and therefore per-verse-parse) must not carry
                  // across a verse change. Mirrors the dismissedGhosts reset
                  // this screen does above.
                  key={`tap:${chapter}:${verse}`}
                  state={tapState}
                  onChange={setTapState}
                  canEdit={canEdit}
                  sourceIndexMap={sourceIndexMap}
                  sourceRtl={sourceRtl}
                  targetRtl={targetRtl}
                  ghosts={ghosts}
                  onDismissGhost={handleDismissGhost}
                />
                <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {tapDirty ? "1 unsaved alignment change set" : "No unsaved changes"}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Button onClick={handleTapReset} disabled={!tapDirty} sx={{ minHeight: 44 }}>
                    Reset
                  </Button>
                  <Button
                    variant="contained"
                    onClick={handleTapSave}
                    disabled={!tapDirty || !canEdit}
                    sx={{ minHeight: 44, fontWeight: 700 }}
                  >
                    Save alignment
                  </Button>
                </Box>
              </>
            ) : (
              <Alert severity="info">
                This verse has no parsable {targetLabel} content to align.
              </Alert>
            )}
          </>
        )}
      </Box>

      {/* real dual aligner — two AlignmentPanels over one shared source */}
      {dualProps && (
        <SideBySideAligner
          open={sbsOpen}
          onClose={requestCloseDual}
          book={book}
          chapter={chapter}
          verseNum={verse}
          vref={dualProps.vref}
          sourceLabel={sourceLane}
          sourceVerse={dualProps.sourceVerse}
          twlForVerse={dualProps.twlForVerse}
          lexiconMap={lexiconMap}
          left={dualProps.left}
          right={dualProps.right}
          onSaveReading={handleSaveReading}
          onPrevVerse={prevVerse != null ? () => dualNavTo(prevVerse) : undefined}
          onNextVerse={nextVerse != null ? () => dualNavTo(nextVerse) : undefined}
        />
      )}

      {/* save-or-discard gate for the side-by-side dialog */}
      <Dialog open={pendingDualAction !== null} onClose={() => setPendingDualAction(null)}>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The side-by-side aligner has unsaved work — alignment changes, verse text, or both.
            Save it before leaving, or discard it.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDualAction(null)} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button color="error" onClick={() => resolveDualAction("discard")} sx={{ minHeight: 44 }}>
            Discard
          </Button>
          <Button
            variant="contained"
            onClick={() => resolveDualAction("save")}
            sx={{ minHeight: 44 }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* unalign confirm — the same gate Shell puts in front of the aligner */}
      <Dialog open={pendingLoss !== null} onClose={() => setPendingLoss(null)}>
        <DialogTitle>Words will be left unaligned</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            Saving {pendingLoss?.ref} leaves {pendingLoss?.lostWords.length} previously aligned
            word{pendingLoss?.lostWords.length === 1 ? "" : "s"} with no original-language link:
            <Box component="p" sx={{ fontWeight: 700, marginBlockStart: 1 }}>
              {pendingLoss?.lostWords.slice(0, 12).join(", ")}
              {(pendingLoss?.lostWords.length ?? 0) > 12 ? " …" : ""}
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingLoss(null)} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              pendingLoss?.commit();
              setPendingLoss(null);
            }}
            sx={{ minHeight: 44 }}
          >
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice ?? ""}
      />
    </Stack>
  );
}
