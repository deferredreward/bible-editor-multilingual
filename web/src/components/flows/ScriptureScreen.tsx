// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t3-scripture: the paired scripture editor, ported from
// docs/flows/ui/t3-scripture.html onto the app's real data + save machinery.
//
// THE ONE THING THAT CHANGES FROM THE MOCKUP: Save is LIVE here.
// The mockup shipped both Save buttons disabled because a vanilla textarea can
// only produce a flat string, and writing `{verseObjects:[{type:"text",…}]}`
// back destroys the verse's whole \zaln alignment tree — and the server guard
// cannot catch total loss (docs/flows/05-functional-preview-findings.md §5.1).
// This screen instead runs the identical path Shell.tsx's saveVerseDraft uses:
//
//   extractEditableText(base.content)        → the diff baseline
//   smartEditVerse(base.content, old, new)   → a real tree, milestones kept
//   analyzeAlignmentDelta + guardBlocksSave  → refuse/confirm collateral loss
//   outbox.enqueueVerse(..., {sourceGeneration}) → If-Match + X-Source-Generation
//
// No verseObjects are ever constructed here by hand, and no plain-text body is
// ever sent. Drafts (IndexedDB) hold unsaved typing; only Save enqueues.
//
// Deliberately NOT ported: the mockup's "Layout" menu. It is local-only chrome
// for the Shell's flexible-layouts feature ("nothing here reaches the server",
// per the mockup's own note) and has no meaning on a standalone flow route.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTranslation } from "react-i18next";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { FlowNav } from "./FlowNav";
import { FlowActionBar } from "./FlowActionBar";
import { FlowStatusChip } from "./FlowStatusChip";
import { LockBanner } from "./FlowBanners";
import { ScriptureLane } from "./ScriptureLane";
import { WordsLexiconStrip, collectSourceWords } from "./WordsLexiconStrip";
import type { FlowScreenContext } from "./types";

import { ChapterBoard } from "../ChapterBoard";
import { VerseHistoryDialog } from "../VerseHistoryDialog";
import { FindReplaceOverlay } from "../FindReplaceOverlay";
import { ExportUsfmButton } from "../ExportUsfmButton";
import type { VerseTile, VerseTileLane } from "../TimelineRail";

import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import type { ChapterState } from "../../hooks/useBook";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { drafts, verseKey, type DraftRecord } from "../../sync/drafts";
import {
  ApiError,
  CHECK_LANES,
  api,
  type ChapterLockedBody,
  type CheckLane,
  type TnRow,
  type VerseDto,
} from "../../sync/api";
import { smartEditVerse } from "../../lib/replace";
import { extractEditableText, extractPlainText, normalizeEditable } from "../../lib/usfm";
import { countUnalignedTargetWords, verseHasUnalignedWork } from "../../lib/alignment";
import {
  analyzeAlignmentDelta,
  guardBlocksSave,
  type AlignmentIntent,
} from "../../lib/alignmentDelta";
import {
  indexLaneChecks,
  laneApplicable,
  laneAttribution,
  laneKey,
  shadeFromCheckers,
  type LaneShade,
} from "../../lib/laneChecks";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionIsRtl, versionLabel } from "../../lib/versionLabels";
import { noteCoveredVerses } from "../../lib/verseRange";

export interface ScriptureScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

// The two editable target lanes the mockup pairs (ULT→GLT, UST→GST). Role codes
// stay ULT/UST everywhere in the data; only the rendered label is per-project.
const TARGET_LANES = ["ULT", "UST"] as const;
type TargetLane = (typeof TARGET_LANES)[number];

// ULT is the "lit" lane and UST the "sim" lane in ProjectConfig.laneState.
const LANE_STATE_KEY: Record<TargetLane, "lit" | "sim"> = { ULT: "lit", UST: "sim" };

// Outbox `fatal` reasons that mean "this lane is mid-replacement", not "your
// edit was wrong". Mirrors the terminal set in sync/outbox.ts's dispatch().
const LANE_REPLACEMENT_REASONS = new Set([
  "lane_replacement_required",
  "lane_replacement_in_progress",
  "source_generation_mismatch",
]);

function verseObjectsOf(dto: VerseDto | undefined | null): unknown[] | null {
  const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

export default function ScriptureScreen({ role, me, book, chapter, verse }: ScriptureScreenProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  // System bands only (web/src/lib/layoutBands.ts): tablet=560, md=900. The
  // mockup restructured at an off-system 820px; the plan corrects that.
  // >=900: lanes pair up and the chapter chrome (Find / Export / Copy / Board)
  // sits inline. Below that the lanes stack and that chrome moves to the fixed
  // FlowActionBar, which renders only under 900 — so it never duplicates.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));

  const {
    status,
    data,
    error,
    applyLocalVerse,
    applyLocalVerseStatus,
    applyLocalLaneCheck,
  } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  const [lock, setLock] = useState<ChapterLockedBody | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingLane, setSavingLane] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [history, setHistory] = useState<{ bibleVersion: string; currentVersion: number } | null>(
    null,
  );
  const [visibleLanes, setVisibleLanes] = useState<Record<TargetLane, boolean>>({
    ULT: true,
    UST: true,
  });
  const [enabledCheckLanes, setEnabledCheckLanes] = useState<CheckLane[]>([...CHECK_LANES]);
  const [pendingBulk, setPendingBulk] = useState<{ lane: CheckLane; checked: boolean; verses: number[] } | null>(
    null,
  );
  // A save that would collaterally unalign untouched words. Mirrors Shell's
  // pendingAlignmentLoss confirm: the translator's typing is NOT discarded —
  // "Save anyway" re-enqueues under the one guard-exempt intent.
  const [pendingLoss, setPendingLoss] = useState<{
    ref: string;
    lostWords: string[];
    commit: () => void;
  } | null>(null);
  // Per-lane replacement notice, from either shape of the dual behaviour
  // (findings §2.9): chapter GET silently omits the lane, verse-scoped calls
  // 409 `lane_replacement_required`.
  const [laneReplacement, setLaneReplacement] = useState<Record<string, string>>({});

  const sourceIsHebrew = isHebrewBook(book);
  const sourceLane = sourceIsHebrew ? "UHB" : "UGNT";
  const sourceLabel = versionLabel(projectConfig, sourceLane);

  const sourceDto = data?.verses?.[sourceLane]?.[verse] ?? null;
  const sourceWords = useMemo(() => collectSourceWords(verseObjectsOf(sourceDto)), [sourceDto]);
  const strongs = useMemo(
    () => sourceWords.map((w) => w.strong).filter((s) => s.length > 0),
    [sourceWords],
  );
  const lexicon = useLexicon(strongs);

  // The source lane is present even when a target lane is omitted mid-
  // replacement, so it anchors "which verses exist"; ULT is the fallback.
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);

  // --- unsaved reminder --------------------------------------------------
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => drafts.subscribe(setDraftList), []);
  const unsavedHere = useMemo(
    () =>
      draftList.filter(
        (d) =>
          !d.quarantined &&
          d.meta.kind === "verse" &&
          d.meta.book === book &&
          d.meta.chapter === chapter,
      ).length,
    [draftList, book, chapter],
  );

  // --- reactive chapter lock + lane-replacement signals --------------------
  // Saves leave through the outbox, so their 409s never reach a local catch —
  // they arrive as outbox results. Both banners are built from real server
  // bodies, never a guess (and never an editor's name: the lock body carries a
  // pipeline, not a person).
  useEffect(() => {
    return onOutboxResult((op, result) => {
      const target = op.target;
      if (target.kind === "verse" && target.book === book) {
        if (result.kind === "fatal" && LANE_REPLACEMENT_REASONS.has(result.reason)) {
          setLaneReplacement((prev) => ({ ...prev, [target.bibleVersion]: result.reason }));
        } else if (result.kind === "fatal") {
          setNotice(`Save failed for ${target.bibleVersion} (${result.reason}).`);
        } else if (result.kind === "conflict") {
          setNotice(
            `${book} ${target.chapter}:${target.verse} ${target.bibleVersion} changed on the server — resolve the conflict from the sync bar.`,
          );
        }
      }
      if (
        result.kind === "locked" &&
        (target.kind === "verse" || target.kind === "verse_status" || target.kind === "lane_check") &&
        target.book === book
      ) {
        setLock(result.lockBody);
      }
    });
  }, [book]);

  // --- save path (identical to Shell.saveVerseDraft) -----------------------

  const enqueueVerseSafely = useCallback(
    (
      base: VerseDto,
      bibleVersion: string,
      content: unknown,
      plainText: string,
      intent: AlignmentIntent,
      onConfirmedApply?: () => void,
    ): boolean => {
      const delta = analyzeAlignmentDelta(base.content, content);
      // The enforced predicate lives in guardBlocksSave — never narrow it here
      // (the narrowing is exactly what let collateral alignment loss ship once).
      if (guardBlocksSave(delta, intent)) {
        const lost = delta.unexpectedLosses.map((l) => l.text);
        if (intent === "text_edit") {
          setPendingLoss({
            ref: `${book} ${chapter}:${verse} ${bibleVersion}`,
            lostWords: lost,
            commit: () => {
              void outbox.enqueueVerse(
                book,
                chapter,
                verse,
                bibleVersion,
                base.version,
                { content, plain_text: plainText, alignment_intent: "alignment_edit" },
                { sourceGeneration: base.source_generation },
              );
              onConfirmedApply?.();
            },
          });
          return false;
        }
        const sample = lost.slice(0, 3).join(", ");
        setNotice(
          `Can't preserve alignment on ${book} ${chapter}:${verse} ${bibleVersion} — not saved${
            sample ? ` (affected: ${sample})` : ""
          }.`,
        );
        return false;
      }
      void outbox.enqueueVerse(
        book,
        chapter,
        verse,
        bibleVersion,
        base.version,
        { content, plain_text: plainText, alignment_intent: intent },
        { sourceGeneration: base.source_generation },
      );
      return true;
    },
    [book, chapter, verse],
  );

  const handleSaveLane = useCallback(
    (bibleVersion: string, plain: string) => {
      const base = data?.verses?.[bibleVersion]?.[verse];
      if (!base) return;
      const key = verseKey(book, chapter, verse, bibleVersion);
      const oldEditable = extractEditableText(base.content);
      // No-op guard: a save with no real change must not bump the version. Also
      // clear the stranded keystroke draft, or the "unsaved" reminder lingers
      // over text that matches the server.
      if (oldEditable === normalizeEditable(plain)) {
        void drafts.clear(key);
        return;
      }
      setSavingLane(bibleVersion);
      const result = smartEditVerse(base.content, oldEditable, plain);
      // Editing a word's text unaligns that word by design; the editor shows
      // plain text, so say so rather than letting it be discovered later.
      const before = countUnalignedTargetWords(
        (base.content as { verseObjects?: unknown[] } | null)?.verseObjects,
      );
      const after = countUnalignedTargetWords(
        (result.content as { verseObjects?: unknown[] } | null)?.verseObjects,
      );
      if (after - before > 0) {
        setNotice(
          `${after - before} word(s) in ${book} ${chapter}:${verse} ${bibleVersion} are now unaligned — re-align them on the Align screen.`,
        );
      }
      const newPlainText = extractPlainText(result.content);
      const newDto = { ...base, plain_text: newPlainText, content: result.content } as VerseDto;
      const applyLocal = () => applyLocalVerse(newDto);
      const enqueued = enqueueVerseSafely(
        base,
        bibleVersion,
        result.content,
        newPlainText,
        "text_edit",
        applyLocal,
      );
      // The outbox IS the durable commit — once the op is queued the button
      // stops spinning even if the network is down. The draft stays until the
      // real 200 clears it, so the "unsaved" reminder remains truthful.
      setSavingLane(null);
      if (!enqueued) return;
      applyLocal();
    },
    [data, verse, book, chapter, applyLocalVerse, enqueueVerseSafely],
  );

  // Restore from the history dialog: the stored tree is re-saved verbatim
  // (alignment included) under the one guard-exempt intent — no smartEditVerse
  // pass, because there is no text diff, just a deliberate full-tree swap.
  const handleRestore = useCallback(
    (bibleVersion: string, content: unknown, plainText: string | null) => {
      const base = data?.verses?.[bibleVersion]?.[verse];
      if (!base) return;
      const newPlainText = plainText ?? extractPlainText(content);
      if (!enqueueVerseSafely(base, bibleVersion, content, newPlainText, "alignment_edit")) return;
      void drafts.clear(verseKey(book, chapter, verse, bibleVersion));
      applyLocalVerse({ ...base, plain_text: newPlainText, content } as VerseDto);
    },
    [data, verse, book, chapter, applyLocalVerse, enqueueVerseSafely],
  );

  // --- verse done toggle ---------------------------------------------------
  const doneNow = Boolean(data?.verseStatuses.find((s) => s.verse === verse)?.done);
  const canEditRole = role === "admin" || role === "editor";

  function toggleDone() {
    if (!canEditRole) return;
    applyLocalVerseStatus(verse, !doneNow);
    void outbox.enqueueVerseStatus(book, chapter, verse, !doneNow);
  }

  // --- chapter board tiles -------------------------------------------------
  const meUserId = me?.userId ?? null;
  const laneIndex = useMemo(
    () => indexLaneChecks(data?.verseLaneChecks ?? []),
    [data],
  );
  const versesWithTn = useMemo(() => {
    const s = new Set<number>();
    for (const r of data?.tn ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [data]);
  const versesWithTq = useMemo(() => {
    const s = new Set<number>();
    for (const r of data?.tq ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [data]);

  const tiles = useMemo<VerseTile[]>(() => {
    if (!data) return [];
    const sourceByVerse = data.verses[sourceLane] ?? {};
    const buildLanes = (v: number): VerseTileLane[] =>
      CHECK_LANES.map((lane) => {
        const applicable = laneApplicable(lane, versesWithTn.has(v), versesWithTq.has(v));
        const checkers = laneIndex.get(laneKey(v, lane));
        const shade: LaneShade = applicable ? shadeFromCheckers(checkers, meUserId) : "open";
        const title = `${t(`lanes.${lane}`)} — ${
          applicable ? laneAttribution(checkers, meUserId, t) : t("shell.nothingToCheck")
        }`;
        return { lane, shade, applicable, title };
      });
    return verseNums.map((v) => {
      const srcVo = verseObjectsOf(sourceByVerse[v]);
      const unaligned = TARGET_LANES.some((bv) => {
        const vo = verseObjectsOf(data.verses[bv]?.[v]);
        return vo ? verseHasUnalignedWork(vo, srcVo) : false;
      });
      return { verse: v, has: unaligned, lanes: buildLanes(v) };
    });
  }, [data, verseNums, sourceLane, versesWithTn, versesWithTq, laneIndex, meUserId, t]);

  function toggleCheckLane(v: number, lane: CheckLane) {
    if (meUserId == null || !canEditRole) return;
    const checkers = laneIndex.get(laneKey(v, lane));
    const next = !checkers?.includes(meUserId);
    applyLocalLaneCheck(v, lane, meUserId, next);
    void outbox.enqueueLaneCheck(book, chapter, v, lane, next);
  }

  // "All" only REQUESTS the bulk change; nothing is written until confirmed.
  function requestBulk(lane: CheckLane) {
    if (meUserId == null || !canEditRole) return;
    const applicableVerses = tiles
      .filter((tile) => tile.lanes.find((l) => l.lane === lane)?.applicable)
      .map((tile) => tile.verse);
    if (applicableVerses.length === 0) return;
    const allMine = applicableVerses.every((v) =>
      laneIndex.get(laneKey(v, lane))?.includes(meUserId),
    );
    setPendingBulk({ lane, checked: !allMine, verses: applicableVerses });
  }

  function commitBulk() {
    const bulk = pendingBulk;
    setPendingBulk(null);
    if (!bulk || meUserId == null) return;
    for (const v of bulk.verses) {
      applyLocalLaneCheck(v, bulk.lane, meUserId, bulk.checked);
      void outbox.enqueueLaneCheck(book, chapter, v, bulk.lane, bulk.checked);
    }
  }

  // --- verse history -------------------------------------------------------
  // Pre-flight the verse-scoped GET ourselves so the OTHER shape of the
  // lane-replacement condition (a 409 rather than a silent omission) is named
  // honestly instead of surfacing as a raw error string inside the dialog.
  // Cost: the dialog re-fetches on open, so a successful path issues the GET
  // twice. History opens are rare; naming the lane state is worth one request.
  async function openHistory(bibleVersion: string) {
    const base = data?.verses?.[bibleVersion]?.[verse];
    if (!base) return;
    try {
      await api.getVerseHistory(book, chapter, verse, bibleVersion);
      setHistory({ bibleVersion, currentVersion: base.version });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const code = (e.body as { error?: string } | null)?.error;
        if (code && LANE_REPLACEMENT_REASONS.has(code)) {
          setLaneReplacement((prev) => ({ ...prev, [bibleVersion]: code }));
          return;
        }
      }
      setNotice(`Could not load history for ${bibleVersion} (${String(e)}).`);
    }
  }

  // --- find/replace --------------------------------------------------------
  // FindReplaceOverlay is written against useBook's chapter cache; this screen
  // holds exactly one chapter, so it is handed a single-entry map. Replacement
  // still flows through smartReplaceVerse (inside the overlay) and then this
  // screen's own guarded enqueue — no new body format.
  const frChapters = useMemo<Map<number, ChapterState>>(() => {
    const m = new Map<number, ChapterState>();
    if (data) m.set(chapter, { kind: "ready", data });
    return m;
  }, [data, chapter]);

  const textLockedVersions = useMemo(() => {
    const s = new Set<string>();
    for (const bv of TARGET_LANES) {
      if (projectConfig?.laneState?.[LANE_STATE_KEY[bv]]?.config.textReadOnly) s.add(bv);
    }
    return s;
  }, [projectConfig]);

  // --- lane derivation -----------------------------------------------------
  function laneInfo(bv: TargetLane) {
    const laneState = projectConfig?.laneState?.[LANE_STATE_KEY[bv]] ?? null;
    const rows = data?.verses?.[bv];
    // Shape A of the dual behaviour: the chapter read silently drops a lane
    // pending replacement. Distinguish "lane omitted entirely" from "this verse
    // has no row" so the banner is only claimed when it is actually true.
    const laneOmitted = Boolean(data) && (!rows || Object.keys(rows).length === 0);
    // `pendingTarget` (pending_target_json) is what actually drives the verse
    // 409 gate. `replacementRequired` is deliberately NOT read here: it only
    // controls chapter-read filtering, its observable effect IS `laneOmitted`,
    // and GET /api/project-config can set it as a side effect (findings §2.9a)
    // — reading it would disable a lane whose rows are right there and writable.
    const pendingFromConfig = Boolean(laneState?.pendingTarget);
    // Shape B: a 409 seen on a verse-scoped call or an outbox save.
    const pendingFromServer = Boolean(laneReplacement[bv]);
    const pending = pendingFromConfig || pendingFromServer || laneOmitted;
    const textReadOnly = Boolean(laneState?.config.textReadOnly);
    return { laneState, rows, laneOmitted, pending, textReadOnly };
  }

  // --- render --------------------------------------------------------------

  if (status === "loading" || status === "retrying" || (status === "idle" && !data)) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="scripture" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ maxWidth: 1000, marginInline: "auto", width: "100%", p: 2 }}>
          <Skeleton variant="text" width={180} height={38} />
          <Skeleton variant="rectangular" height={44} sx={{ mt: 2, borderRadius: 1 }} />
          <Box
            sx={{
              display: "grid",
              gap: 2,
              mt: 2,
              gridTemplateColumns: isDesktop ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)",
            }}
          >
            <Skeleton variant="rectangular" height={260} sx={{ borderRadius: 1.5 }} />
            <Skeleton variant="rectangular" height={260} sx={{ borderRadius: 1.5 }} />
          </Box>
        </Box>
      </Stack>
    );
  }

  if (status === "error" || !data) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="scripture" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ p: 3 }}>
          <Alert severity="error">
            Could not load {book} {chapter}
            {error ? ` (${error})` : ""}. Scripture can&rsquo;t be shown until the chapter loads.
          </Alert>
        </Box>
      </Stack>
    );
  }

  const shownLanes = TARGET_LANES.filter((bv) => visibleLanes[bv]);
  const activeLaneForBar = shownLanes[0] ?? null;

  function goVerse(delta: number) {
    if (verseNums.length === 0) return;
    let idx = verseNums.indexOf(verse);
    if (idx === -1) idx = 0;
    const next = Math.max(0, Math.min(verseNums.length - 1, idx + delta));
    if (verseNums[next] === verse) return;
    location.hash = `#/scripture/${book}/${chapter}/${verseNums[next]}`;
  }

  async function copyChapter() {
    const rows = data?.verses?.ULT;
    const lines: string[] = [];
    if (rows) {
      for (const v of verseNums) {
        const row = rows[v];
        if (row?.plain_text) lines.push(`${v}. ${row.plain_text}`);
      }
    }
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard isn't available in this browser — nothing copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setNotice(`Copied ${lines.length} verse(s) (ULT) to the clipboard.`);
    } catch {
      setNotice("Copy to clipboard failed.");
    }
  }

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <FlowNav current="scripture" book={book} chapter={chapter} verse={verse} role={role} />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Box
          sx={{
            maxWidth: 1000,
            marginInline: "auto",
            paddingInline: 2,
            paddingBlockStart: 2,
            paddingBlockEnd: isDesktop ? 4 : 14,
          }}
        >
          {/* nav strip */}
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5, flexWrap: "wrap" }}>
            <IconButton
              aria-label="Previous verse"
              onClick={() => goVerse(-1)}
              disabled={verseNums.length === 0 || verse === verseNums[0]}
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              {book} {chapter}:{verse}
            </Typography>
            <IconButton
              aria-label="Next verse"
              onClick={() => goVerse(1)}
              disabled={verseNums.length === 0 || verse === verseNums[verseNums.length - 1]}
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <ChevronRightIcon />
            </IconButton>
            <Box sx={{ flex: 1 }} />
            {unsavedHere > 0 && <FlowStatusChip kind="warn" label={`${unsavedHere} unsaved`} />}
            {isDesktop && (
              <>
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => setFindOpen(true)}>
                  Find/Replace
                </Button>
                <ExportUsfmButton
                  book={book}
                  chapter={chapter}
                  enabledVersions={[...TARGET_LANES, sourceLane]}
                  chapterVersesFor={(version) => Object.values(data?.verses?.[version] ?? {})}
                />
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => void copyChapter()}>
                  Copy Chapter
                </Button>
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => setBoardOpen(true)}>
                  Chapter board
                </Button>
              </>
            )}
          </Stack>

          {/* status row */}
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2, flexWrap: "wrap" }}>
            <FormControlLabel
              control={<Switch checked={doneNow} onChange={toggleDone} disabled={!canEditRole} />}
              label="Verse marked done"
              sx={{ marginInlineEnd: 0 }}
            />
            {TARGET_LANES.map((bv) => (
              <FormControlLabel
                key={bv}
                control={
                  <Checkbox
                    checked={visibleLanes[bv]}
                    onChange={(e) => setVisibleLanes((p) => ({ ...p, [bv]: e.target.checked }))}
                  />
                }
                label={`Show ${versionLabel(projectConfig, bv)}`}
                sx={{ marginInlineEnd: 0 }}
              />
            ))}
          </Stack>

          {lock && (
            <Box sx={{ mb: 2 }}>
              <LockBanner pipelineType={lock.pipelineType} startedAt={lock.startedAt ?? null} />
            </Box>
          )}

          {!canEditRole && (
            <Alert severity="info" sx={{ mb: 2 }}>
              You have view-only access to this project, so the verse editors are read-only.
            </Alert>
          )}

          <WordsLexiconStrip
            words={sourceWords}
            rtl={sourceIsHebrew}
            label={sourceLabel}
            lexicon={lexicon}
          />

          {/* paired lanes */}
          <Box
            sx={{
              display: "grid",
              gap: 2,
              alignItems: "start",
              // Two lanes side by side only at >=900. Below that the pair
              // stacks: at 560-900 a paired scripture column is unreadable.
              gridTemplateColumns:
                isDesktop && shownLanes.length > 1 ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)",
            }}
          >
            {shownLanes.map((bv) => {
              const info = laneInfo(bv);
              const base = info.rows?.[verse] ?? null;
              const editable = base ? extractEditableText(base.content) : "";
              const laneDisplay = versionLabel(projectConfig, bv);
              let disabledReason: string | null = null;
              if (info.pending) {
                disabledReason = `${laneDisplay} is awaiting a source replacement. The chapter read omits a lane in this state and verse reads answer 409 lane_replacement_required, so editing is off until the replacement lands.`;
              } else if (info.textReadOnly) {
                disabledReason = `${laneDisplay} is configured text-read-only in this project — alignment may still be editable on the Align screen.`;
              } else if (!canEditRole) {
                disabledReason = "View-only access.";
              } else if (!base) {
                disabledReason = `No ${laneDisplay} row exists for this verse.`;
              }
              return (
                <Box key={bv}>
                  {info.pending && (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      {laneDisplay} lane pending replacement
                      {laneReplacement[bv] ? ` (server said: ${laneReplacement[bv]})` : ""}
                      {info.laneOmitted && !laneReplacement[bv]
                        ? " — the chapter payload contains no rows for this lane"
                        : ""}
                      .
                    </Alert>
                  )}
                  <ScriptureLane
                    book={book}
                    chapter={chapter}
                    verse={verse}
                    bibleVersion={bv}
                    laneLabel={laneDisplay}
                    base={base}
                    editableBaseline={editable}
                    sourceText={sourceDto?.plain_text ?? null}
                    sourceRtl={versionIsRtl(projectConfig, sourceLane)}
                    sourceLabel={sourceLabel}
                    targetRtl={versionIsRtl(projectConfig, bv)}
                    canEdit={canEditRole && !info.pending && !info.textReadOnly && Boolean(base)}
                    disabledReason={disabledReason}
                    saving={savingLane === bv}
                    onSave={(plain) => handleSaveLane(bv, plain)}
                    onAlign={() => {
                      location.hash = `#/align/${book}/${chapter}/${verse}`;
                    }}
                  />
                  <Button
                    size="small"
                    sx={{ mt: 0.5, minHeight: 44 }}
                    disabled={!base}
                    onClick={() => void openHistory(bv)}
                  >
                    Verse history ({laneDisplay})
                  </Button>
                </Box>
              );
            })}
            {shownLanes.length === 0 && (
              <Alert severity="info">
                Both lanes are hidden. Re-enable one with the checkboxes above.
              </Alert>
            )}
          </Box>
        </Box>
      </Box>

      {/* <900: the chrome actions move into the fixed bar (nothing renders >=900). */}
      <FlowActionBar>
        <Button variant="outlined" onClick={() => setFindOpen(true)}>
          Find
        </Button>
        <Button variant="outlined" onClick={() => setBoardOpen(true)}>
          Board
        </Button>
        <Button
          variant="outlined"
          disabled={!activeLaneForBar}
          onClick={() => activeLaneForBar && void openHistory(activeLaneForBar)}
        >
          History
        </Button>
      </FlowActionBar>

      <ChapterBoard
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        book={book}
        chapter={chapter}
        tiles={tiles}
        canCheck={canEditRole && meUserId != null}
        onToggle={toggleCheckLane}
        onBulkToggle={requestBulk}
        enabledLanes={enabledCheckLanes}
        onToggleLaneVisible={(lane) =>
          setEnabledCheckLanes((prev) =>
            prev.includes(lane) ? prev.filter((l) => l !== lane) : [...prev, lane],
          )
        }
      />

      {history && (
        <VerseHistoryDialog
          open
          book={book}
          chapter={chapter}
          verseNum={verse}
          bibleVersion={history.bibleVersion}
          currentVersion={history.currentVersion}
          onClose={() => setHistory(null)}
          onUseVersion={(content, plainText) => {
            handleRestore(history.bibleVersion, content, plainText);
            setHistory(null);
          }}
        />
      )}

      <FindReplaceOverlay
        open={findOpen}
        onClose={() => setFindOpen(false)}
        book={book}
        activeChapter={chapter}
        chapters={frChapters}
        chapterList={[chapter]}
        onLoadChapter={() => {
          /* single-chapter scope: nothing else to load on this screen */
        }}
        enabledVersions={[...TARGET_LANES]}
        onReplaceVerse={(ch, verseNum, bibleVersion, newContent, newPlainText, base) => {
          if (ch !== chapter || verseNum !== verse) {
            // The overlay can target any verse in scope, but this screen's
            // guarded enqueue is pinned to the active verse — move there first
            // rather than writing to a verse the user isn't looking at.
            setNotice(
              `Replacement targets ${book} ${ch}:${verseNum}; open that verse to apply it here.`,
            );
            return;
          }
          const delta = analyzeAlignmentDelta(base.content, newContent);
          if (guardBlocksSave(delta, "find_replace")) {
            const sample = delta.unexpectedLosses.slice(0, 3).map((l) => l.text).join(", ");
            setNotice(
              `Replace would unalign untouched words in ${book} ${ch}:${verseNum} ${bibleVersion} — not saved${
                sample ? ` (affected: ${sample})` : ""
              }.`,
            );
            return;
          }
          void outbox.enqueueVerse(
            book,
            ch,
            verseNum,
            bibleVersion,
            base.version,
            { content: newContent, plain_text: newPlainText, alignment_intent: "find_replace" },
            { sourceGeneration: base.source_generation },
          );
          applyLocalVerse({ ...base, plain_text: newPlainText, content: newContent } as VerseDto);
        }}
        onReplaceNote={(row: TnRow, newNote: string) => {
          void outbox.enqueueRow("tn", row.id, row.version, { note: newNote }, { book });
        }}
        onScrollToMatch={(match) => {
          if (match && match.verse !== verse) {
            location.hash = `#/scripture/${book}/${chapter}/${match.verse}`;
          }
        }}
        onQueryChange={() => {
          /* this screen paints no inline find marks */
        }}
        searchNotes={() => data?.tn ?? []}
        onScrollToNoteMatch={(_ch, v) => {
          if (v !== verse) location.hash = `#/scripture/${book}/${chapter}/${v}`;
        }}
        onNoteQueryChange={() => {
          /* note cards aren't rendered on this screen */
        }}
        onActiveNoteMatchChange={() => {
          /* note cards aren't rendered on this screen */
        }}
        textLockedVersions={textLockedVersions}
      />

      <Dialog open={Boolean(pendingLoss)} onClose={() => setPendingLoss(null)}>
        <DialogTitle>This save would unalign words it didn&rsquo;t touch</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Saving {pendingLoss?.ref} drops the alignment on{" "}
            {pendingLoss?.lostWords.length ?? 0} word(s)
            {pendingLoss && pendingLoss.lostWords.length > 0
              ? `: ${pendingLoss.lostWords.slice(0, 6).join(", ")}`
              : ""}
            . Your typing is kept either way — saving anyway leaves those words for you to re-align
            on the Align screen.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingLoss(null)} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            sx={{ minHeight: 44 }}
            onClick={() => {
              pendingLoss?.commit();
              setPendingLoss(null);
              setSavingLane(null);
            }}
          >
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(pendingBulk)} onClose={() => setPendingBulk(null)}>
        <DialogTitle>{pendingBulk?.checked ? "Check" : "Clear"} the whole chapter?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This {pendingBulk?.checked ? "adds" : "removes"} your check on the{" "}
            {pendingBulk?.lane} lane for {pendingBulk?.verses.length ?? 0} verse(s) in {book}{" "}
            {chapter}.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingBulk(null)} sx={{ minHeight: 44 }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={commitBulk} sx={{ minHeight: 44 }}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={8000}
        onClose={() => setNotice(null)}
        message={notice ?? ""}
      />
    </Stack>
  );
}
