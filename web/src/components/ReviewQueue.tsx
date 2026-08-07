// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t2-review: the Notes/Questions review queue, ported faithfully from
// docs/flows/ui/t2-review.html against the app's real data + save machinery.
// Explicit-Save-only; drafts persist via web/src/sync/drafts.ts; saves go
// through the outbox exactly like NoteCard.tsx.
//
// Three bands, per docs/flows/02-architecture.md D1:
//   phone   (<560)  card-at-a-time + a "This verse" bottom sheet + fixed action bar
//   tablet  (560-899) queue rail + hero work card + COLLAPSIBLE verse context
//   desktop (>=900) queue rail + work card + persistent verse-context column
// The tablet band deliberately does NOT reproduce the mockup's own defect
// (docs/flows/05-functional-preview-findings.md §4.3): the rail is narrower so
// the work card stays the hero, and the verse context is collapsed-not-deleted
// rather than being replaced by the phone affordance.
//
// Chapter locks are NOT uniform (findings §2.7, verified in api/src/rows.ts):
//   PATCH  — tn is EXEMPT (rows.ts `if (kind !== "tn")` before the lock check);
//            tq/twl are locked.
//   DELETE — locked for EVERY kind, tn included ("no carve-out for tn here").
//   POST /api/rows — locked (a run will rearrange the row set when it lands).
//   /validate /preserve /hint /trash /restore — no lock check at all.
// The card disables exactly what the server would actually reject — no more.
// Disabling note editing during a run would block writes the server accepts.
//
// 428 is a client bug, not a merge case (findings §2.3): it means we sent a
// write with no If-Match. It is logged, the chapter is re-read, and the write
// is retried once — the merge prompt is never shown for it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { TopBar } from "./TopBar";
import { QuoteBuilderPopper } from "./QuoteBuilderPopper";
import { collectStrongs } from "./HebrewLine";
import { FlowActionBar } from "./flows/FlowActionBar";
import { LockBanner } from "./flows/FlowBanners";
import { FlowStatusChip } from "./flows/FlowStatusChip";
import { ReviewRail, railItemsFromRows } from "./flows/ReviewRail";
import { ReviewContextPanel } from "./flows/ReviewContextPanel";
import { ReviewSourceStrip } from "./flows/ReviewSourceStrip";
import { ReviewHistoryDialog } from "./flows/ReviewHistoryDialog";
import { ReviewConflictDialog } from "./flows/ReviewConflictDialog";
import { ReviewQuestionsGrid } from "./flows/ReviewQuestionsGrid";
import { useChapter } from "../hooks/useChapter";
import { useLayoutBand } from "../hooks/useLayoutBand";
import { useLexicon } from "../hooks/useLexicon";
import { useNoteTemplates } from "../hooks/useNoteTemplates";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { outbox, onOutboxResult, type OutboxOp } from "../sync/outbox";
import { drafts, rowKey, type DraftRecord } from "../sync/drafts";
import { buildVerseIndex } from "../lib/verseRange";
import { buildTnQuickRequest } from "../lib/tnQuickRequest";
import { buildQuoteFromSelection, selectionFromQuote } from "../lib/quoteBuilder";
import { shortSupport } from "../lib/supportReference";
import type { HighlightKey } from "../lib/highlight";
import { SCRIPTURE_FONT_STACK } from "../theme";
import {
  api,
  ApiError,
  type ChapterLockedBody,
  type TnRow,
  type TqRow,
  type VerseDto,
} from "../sync/api";

type RowKindTQ = "tn" | "tq";
type QueueRow = TnRow | TqRow;

export interface ReviewQueueProps {
  book: string;
  chapter: number;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
}

// TnRow.note / TqRow.response come across with literal "\n" escape sequences
// (see the source TSV format) rather than real newlines.
function unescapeNewlines(text: string | null | undefined): string {
  return (text ?? "").replace(/\\n/g, "\n");
}

// Human labels for the row fields this screen can patch. Anything unmapped
// falls back to the raw column name rather than being silently prettified into
// something that might not match what the API actually changed.
const FIELD_LABELS: Record<string, string> = {
  note: "Note",
  question: "Question",
  response: "Answer",
  quote: "Quote",
  occurrence: "Occurrence",
  verse: "Verse",
  ref_raw: "Reference",
  sort_order: "Order",
};

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

// "quote", "quote and occurrence" — names what conflicted, nothing more.
function joinFieldLabels(labels: string[]): string {
  if (labels.length === 0) return "queued";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// Render any patch/row value as display text. Absent stays "" so the dialog can
// show an explicit "(empty)" rather than a blank box.
function displayFieldValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? unescapeNewlines(value) : String(value);
}

function refFor(book: string, row: QueueRow): string {
  return row.verse === 0 ? `${book} ${row.chapter} intro` : `${book} ${row.chapter}:${row.verse}`;
}

function stateLabel(
  state: TnRow["translation_state"] | TqRow["translation_state"],
): "draft" | "edited" | "validated" {
  return state === "validated" || state === "edited" ? state : "draft";
}

function verseObjectsOf(v: VerseDto | undefined): unknown[] | null {
  if (!v) return null;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// Single-use midpoint placement for "insert note after this one". Shell.tsx
// has an equivalent private helper; it isn't exported, and this screen needs
// only the "after" case.
function sortOrderAfter(list: QueueRow[], refId: string): number {
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) return ((list[list.length - 1]?.sort_order ?? list.length * 100) + 100);
  const targetSort = list[idx].sort_order ?? (idx + 1) * 100;
  const nextSort = list[idx + 1]?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

export function ReviewQueue({ book, chapter, onNavigate }: ReviewQueueProps) {
  const { band } = useLayoutBand();
  const isPhone = band === "phone";
  const isDesktop = band === "desktop";

  const projectConfig = useProjectConfig();
  const isAuthoringMode = projectConfig?.mode === "authoring";
  const templateMap = useNoteTemplates();

  const {
    status,
    data,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
  } = useChapter(book, chapter);

  const [activeKind, setActiveKind] = useState<RowKindTQ>("tn");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const baselineRef = useRef<string>("");
  const hydratedKeyRef = useRef<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const quoteButtonRef = useRef<HTMLButtonElement | null>(null);
  const templateButtonRef = useRef<HTMLButtonElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeSeverity, setNoticeSeverity] = useState<"info" | "warning">("info");
  const [approveAllProgress, setApproveAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [approveAllError, setApproveAllError] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);
  const [draftRecords, setDraftRecords] = useState<DraftRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [gridView, setGridView] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [templateAnchor, setTemplateAnchor] = useState<HTMLElement | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteKeys, setQuoteKeys] = useState<Set<HighlightKey>>(() => new Set());
  const [retargetOpen, setRetargetOpen] = useState(false);
  const [retargetValue, setRetargetValue] = useState("");
  // The 409 body carries ONLY { version, deleted_at } (api/src/rows.ts) — no
  // content, no updated_at. `serverVersion` is everything we learn from it;
  // the row itself has to be re-read (conflictRow) before we can show or adopt
  // "theirs".
  const [conflict, setConflict] = useState<{ op: OutboxOp; serverVersion: number | null } | null>(null);
  const [conflictRow, setConflictRow] = useState<TnRow | TqRow | null>(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  // One 428 retry per row, ever. A second means the bug is structural, not a
  // race, and looping on it would just churn the network.
  const retried428Ref = useRef<Set<string>>(new Set());

  const say = useCallback((message: string, severity: "info" | "warning" = "info") => {
    setNotice(message);
    setNoticeSeverity(severity);
  }, []);

  const rows = useMemo<QueueRow[]>(() => {
    if (!data) return [];
    const list: QueueRow[] = activeKind === "tn" ? data.tn : data.tq;
    return [...list].sort((a, b) => a.verse - b.verse || ((a.sort_order ?? 0) - (b.sort_order ?? 0)));
  }, [data, activeKind]);

  // Keep the selection valid for the active queue — pick the first row when
  // nothing is selected, the selection belonged to the other queue, or the
  // row disappeared (e.g. a peer deleted it).
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((r) => r.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const selectedIndex = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const fieldName = activeKind === "tn" ? "note" : "response";
  const contentOf = (row: QueueRow): string =>
    unescapeNewlines(activeKind === "tn" ? (row as TnRow).note : (row as TqRow).response);

  // Hydrate the editor when the selection changes: prefer a persisted draft
  // (unsaved typing from this browser), fall back to the row's own content.
  useEffect(() => {
    if (!selectedRow) return;
    const key = rowKey(activeKind, book, selectedRow.id);
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    const fallback = contentOf(selectedRow);
    baselineRef.current = fallback;
    setDraftValue(fallback);
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== key) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      const patchVal = payload?.patch?.[fieldName];
      if (typeof patchVal === "string") setDraftValue(unescapeNewlines(patchVal));
      const baselineVal = payload?.baseline?.[fieldName];
      if (typeof baselineVal === "string") baselineRef.current = unescapeNewlines(baselineVal);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow?.id, activeKind, book]);

  const hasDiff = draftValue !== baselineRef.current;

  // Stash every keystroke to the drafts store (explicit-Save-only: this never
  // triggers a network write on its own). Cleared automatically by drafts.ts
  // once the outbox confirms a save.
  useEffect(() => {
    if (!selectedRow) return;
    const key = rowKey(activeKind, book, selectedRow.id);
    if (draftValue !== baselineRef.current) {
      void drafts.set(
        key,
        { patch: { [fieldName]: draftValue }, baseline: { [fieldName]: baselineRef.current } },
        selectedRow.version,
        {
          kind: "row",
          rowKind: activeKind,
          id: selectedRow.id,
          book,
          chapter: selectedRow.chapter,
          verse: selectedRow.verse,
        },
      );
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftValue, selectedRow?.id, selectedRow?.version, activeKind, book]);

  // ── "N unsaved" across the whole queue ────────────────────────────────────
  useEffect(() => drafts.subscribe(setDraftRecords), []);
  const chapterDrafts = useMemo(
    () =>
      draftRecords.filter(
        (r) =>
          !r.quarantined &&
          r.meta.kind === "row" &&
          (r.meta.rowKind === "tn" || r.meta.rowKind === "tq") &&
          r.meta.book === book &&
          r.meta.chapter === chapter,
      ),
    [draftRecords, book, chapter],
  );

  function goToFirstUnsaved() {
    const first = chapterDrafts[0];
    if (!first || first.meta.kind !== "row") return;
    const kind = first.meta.rowKind === "tq" ? "tq" : "tn";
    setActiveKind(kind);
    setSelectedId(first.meta.id);
    // The Save button may not exist yet on this render (band/queue switch);
    // focusing on the next frame is enough to land on it once it does.
    requestAnimationFrame(() => saveButtonRef.current?.focus());
  }

  // ── outbox reconciliation: 409 merge, chapter lock, 428 client bug ────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row") return;
        if (op.target.book !== book) return;
        if (op.target.rowKind !== "tn" && op.target.rowKind !== "tq") return;

        if (result.kind === "ok") {
          setChapterLock(null);
          return;
        }
        if (result.kind === "conflict") {
          // All the 409 gives us is the version. Open the prompt immediately so
          // the user isn't left wondering why Save went quiet, then re-read the
          // row to fill in what "theirs" actually says.
          const currentBody = result.current as { version?: unknown } | null | undefined;
          const serverVersion =
            currentBody && typeof currentBody.version === "number" ? currentBody.version : null;
          const rowKind = op.target.rowKind as RowKindTQ;
          const id = op.target.id;
          setConflict({ op, serverVersion });
          setConflictRow(null);
          setConflictError(null);
          setConflictLoading(true);
          void (async () => {
            try {
              // There is a GET /api/rows/:kind/:id route (rows.ts:320) but no
              // client method for it in sync/api.ts, so the chapter read is the
              // available way to get the full row.
              const fresh = await api.getChapter(book, chapter);
              const list: QueueRow[] = rowKind === "tn" ? fresh.tn : fresh.tq;
              const row = list.find((r) => r.id === id) ?? null;
              setConflictRow(row);
              if (!row) {
                setConflictError(
                  "That row is no longer in this chapter — the other editor may have deleted it.",
                );
              }
            } catch (e) {
              setConflictError(
                `Couldn't read the other editor's version (${e instanceof ApiError ? e.status : "error"}).`,
              );
            } finally {
              setConflictLoading(false);
            }
          })();
          return;
        }
        if (result.kind === "locked") {
          setChapterLock(result.lockBody);
          return;
        }
        if (result.kind === "fatal" && result.reason === "http 428") {
          // Client bug, never a merge prompt (findings §2.3): log it, re-read
          // the row, retry the same write once against the fresh version. The
          // re-read is a direct GET rather than useChapter's refetch because we
          // need the fresh version value here, not on a later render.
          console.error(
            "[ReviewQueue] 428 precondition_required: a row write left without an If-Match header",
            { rowKind: op.target.rowKind, id: op.target.id, patch: op.patch },
          );
          const rowKind = op.target.rowKind as RowKindTQ;
          const id = op.target.id;
          const patch = op.patch;
          // Carry the original op's baseline through the retry — dropping it
          // would disable the 409 auto-heal tier (sync/rowConflict.ts) on the
          // re-sent write.
          const baseline = op.baseline;
          const retryKey = `${rowKind}:${id}`;
          if (retried428Ref.current.has(retryKey)) {
            say("A save was rejected twice for a missing precondition — it was not retried again.", "warning");
            return;
          }
          retried428Ref.current.add(retryKey);
          void (async () => {
            try {
              const fresh = await api.getChapter(book, chapter);
              const list: QueueRow[] = rowKind === "tn" ? fresh.tn : fresh.tq;
              const row = list.find((r) => r.id === id);
              if (!row) return;
              await outbox.enqueueRow(rowKind, id, row.version, patch, {
                book,
                ...(baseline !== undefined ? { baseline } : {}),
              });
              await refetch();
            } catch {
              say("A save was rejected for a missing precondition and could not be retried.", "warning");
            }
          })();
          return;
        }
        if (result.kind === "fatal") {
          say(`A save failed (${result.reason}) and is parked in the failed-ops queue.`, "warning");
        }
      }),
    [book, chapter, refetch, say],
  );

  // ── lock gating (findings §2.7 — the lock is NOT uniform) ─────────────────
  const locked = chapterLock !== null;
  const saveLocked = locked && activeKind === "tq"; // tn PATCH is lock-exempt
  // DELETE has NO exemption for any kind — rows.ts runs the lock check before
  // every delete ("no carve-out for tn here"). Gate it exactly like a tq save.
  const deleteLocked = locked;
  const createLocked = locked; // POST /api/rows is locked
  const lockReasonSave = "Chapter is locked by an AI run — question edits are rejected until it finishes";
  const lockReasonDelete = "Chapter is locked by an AI run — deletes are rejected for every kind";
  const lockReasonCreate = "Chapter is locked by an AI run — new rows are rejected until it finishes";

  // ── source-language lane (drives the quote strip's label + direction) ─────
  const hasHebrewSource = Boolean(data?.verses?.UHB);
  const sourceLabel = hasHebrewSource ? "Hebrew" : "Greek";
  const sourceDir: "ltr" | "rtl" = hasHebrewSource ? "rtl" : "ltr";

  const sourceIndex = useMemo(
    () => buildVerseIndex(data?.verses?.UHB ?? data?.verses?.UGNT),
    [data?.verses],
  );
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);

  const uhbStrongs = useMemo(() => {
    const set = new Set<string>();
    const byVerse = data?.verses?.UHB ?? data?.verses?.UGNT;
    if (byVerse) {
      for (const v of Object.values(byVerse)) {
        const objs = verseObjectsOf(v);
        if (objs) for (const s of collectStrongs(objs)) set.add(s);
      }
    }
    return [...set];
  }, [data?.verses]);
  const lexiconMap = useLexicon(uhbStrongs);

  const sourceVo = selectedRow ? verseObjectsOf(sourceIndex[selectedRow.verse]) : null;
  const ultVo = selectedRow ? verseObjectsOf(ultIndex[selectedRow.verse]) : null;
  const ustVo = selectedRow ? verseObjectsOf(ustIndex[selectedRow.verse]) : null;

  // ── writes ────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!selectedRow || !hasDiff || saving || saveLocked) return;
    setSaving(true);
    try {
      const patch = { [fieldName]: draftValue };
      const baseline = { [fieldName]: baselineRef.current };
      applyLocalRowPatch(activeKind, selectedRow.id, patch as Partial<TnRow & TqRow>);
      await outbox.enqueueRow(activeKind, selectedRow.id, selectedRow.version, patch, { book, baseline });
      baselineRef.current = draftValue;
    } finally {
      setSaving(false);
    }
  }

  function handleUndo() {
    if (!selectedRow || !hasDiff) return;
    setDraftValue(baselineRef.current);
    say("Reverted to the last value loaded from the server.");
  }

  async function handleApprove() {
    if (!selectedRow || approving) return;
    setApproving(true);
    setNotice(null);
    try {
      const updated =
        activeKind === "tn"
          ? await api.validateNote(selectedRow.id, book, true)
          : await api.validateQuestion(selectedRow.id, book, true);
      applyLocalRowReplacement(activeKind, updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say("Approve needs an AI draft first — this row hasn't been through the AI pipeline yet.", "warning");
      } else {
        say(`Approve failed (${err instanceof ApiError ? err.status : "error"}).`, "warning");
      }
    } finally {
      setApproving(false);
    }
  }

  // Sequential per-row validate calls — there is no bulk-validate endpoint.
  // Stops at the first failure and reports exactly how far it got.
  async function handleApproveAll(kind: RowKindTQ) {
    if (!data || approveAllProgress) return;
    const source: QueueRow[] = kind === "tn" ? data.tn : data.tq;
    // Trashed notes are excluded on purpose: validating one would promote a row
    // the editor has already thrown away into the nightly context-repo export's
    // few-shot set (api/src/rows.ts:943). tq has no trashed_at, so the guard is
    // a no-op there.
    const list = source.filter(
      (r) => r.translation_state !== "validated" && (r as TnRow).trashed_at == null,
    );
    setApproveAllError(null);
    if (list.length === 0) return;
    setApproveAllProgress({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      try {
        const updated =
          kind === "tn"
            ? await api.validateNote(row.id, book, true)
            : await api.validateQuestion(row.id, book, true);
        applyLocalRowReplacement(kind, updated);
        setApproveAllProgress({ done: i + 1, total: list.length });
      } catch (err) {
        const st = err instanceof ApiError ? err.status : "error";
        const extra =
          st === 404 ? " That row has no AI draft to approve yet." : st === 409 ? " The chapter may be locked by an AI run." : "";
        setApproveAllError(
          `Stopped at ${refFor(book, row)} — approve failed (${st}).${extra} ${i} of ${list.length} approved; the rest were not attempted.`,
        );
        break;
      }
    }
    setApproveAllProgress(null);
  }

  async function handleAddRow(kind: RowKindTQ) {
    if (createLocked || addPending) return;
    setAddPending(true);
    const verse = selectedRow?.verse ?? 1;
    const ref_raw = verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`;
    try {
      const body: Record<string, unknown> =
        kind === "tn"
          ? { book, chapter, verse, ref_raw, note: "" }
          : { book, chapter, verse, ref_raw, question: "", response: "" };
      const created = await api.createRow<TnRow | TqRow>(kind, body);
      applyLocalRowInsert(kind, created);
      setActiveKind(kind);
      setSelectedId(created.id);
      say(kind === "tn" ? "New note added." : "New question added.");
    } catch (err) {
      say(`Could not add (${err instanceof ApiError ? err.status : "error"}).`, "warning");
    } finally {
      setAddPending(false);
    }
  }

  // tq is a hard DELETE (F.3); tn gets the visible, restorable trash (F.1).
  async function handleDeleteQuestion(row: TqRow) {
    if (deleteLocked) return;
    applyLocalRowDelete("tq", row.id);
    await outbox.enqueueDeleteRow("tq", row.id, row.version, book);
    say(`Deleted ${refFor(book, row)}.`);
  }

  async function handleToggleTrash() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      const updated = row.trashed_at != null
        ? await api.restoreNote(row.id, book)
        : await api.trashNote(row.id, book);
      applyLocalRowReplacement("tn", updated);
      say(row.trashed_at != null ? "Restored from trash." : "Moved to trash.");
    } catch (err) {
      say(`Could not change trash state (${err instanceof ApiError ? err.status : "error"}).`, "warning");
    }
  }

  async function handleSetPreserve(value: boolean) {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      applyLocalRowReplacement("tn", await api.setPreserveNote(row.id, book, value));
    } catch {
      say("Could not change Preserve.", "warning");
    }
  }

  function handleTogglePreserve() {
    if (!selectedRow || activeKind !== "tn") return;
    void handleSetPreserve(!(selectedRow as TnRow).preserve);
  }

  async function handleToggleHint() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      applyLocalRowReplacement("tn", await api.setHintNote(row.id, book, !row.hint));
    } catch {
      say("Could not toggle Hint.", "warning");
    }
  }

  // ── tn-only chrome: reorder / insert-after / retarget ─────────────────────
  const verseSiblings = useMemo(
    () => (selectedRow ? rows.filter((r) => r.verse === selectedRow.verse) : []),
    [rows, selectedRow],
  );
  const siblingPos = selectedRow ? verseSiblings.findIndex((r) => r.id === selectedRow.id) : -1;

  function reorderBlockedReason(delta: -1 | 1): string | null {
    if (activeKind !== "tn") return "Reordering applies to notes only";
    if (!selectedRow || siblingPos < 0) return "No note selected";
    const other = verseSiblings[siblingPos + delta];
    if (!other) return delta === -1 ? "Already first in this verse" : "Already last in this verse";
    if (selectedRow.sort_order == null || other.sort_order == null) {
      return "These notes have no sort order recorded yet — reorder needs one on both";
    }
    return null;
  }

  async function handleReorder(delta: -1 | 1) {
    if (!selectedRow || reorderBlockedReason(delta)) return;
    const other = verseSiblings[siblingPos + delta];
    const a = selectedRow.sort_order as number;
    const b = other.sort_order as number;
    // sort_order-only patches are last-write-wins; the outbox auto-heals a 409
    // on them rather than raising a merge prompt (see outbox.ts).
    applyLocalRowPatch("tn", selectedRow.id, { sort_order: b } as Partial<TnRow & TqRow>);
    applyLocalRowPatch("tn", other.id, { sort_order: a } as Partial<TnRow & TqRow>);
    // baseline = each row's pre-swap sort_order, so a 409 raised by an unrelated
    // field can auto-heal (sync/rowConflict.ts) instead of prompting.
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, { sort_order: b }, {
      book,
      baseline: { sort_order: a },
    });
    await outbox.enqueueRow("tn", other.id, other.version, { sort_order: a }, {
      book,
      baseline: { sort_order: b },
    });
    say("Moved — sort order swapped.");
  }

  async function handleInsertAfter() {
    if (!selectedRow || activeKind !== "tn" || createLocked) return;
    const ref_raw = selectedRow.verse === 0 ? `${chapter}:intro` : `${chapter}:${selectedRow.verse}`;
    try {
      const created = await api.createRow<TnRow>("tn", {
        book,
        chapter,
        verse: selectedRow.verse,
        ref_raw,
        note: "",
        sort_order: sortOrderAfter(verseSiblings, selectedRow.id),
      });
      applyLocalRowInsert("tn", created, { afterId: selectedRow.id });
      setSelectedId(created.id);
      say("Note inserted after this one.");
    } catch (err) {
      say(`Could not insert (${err instanceof ApiError ? err.status : "error"}).`, "warning");
    }
  }

  async function handleRetarget() {
    if (!selectedRow || activeKind !== "tn") return;
    const verse = Number.parseInt(retargetValue, 10);
    if (!Number.isFinite(verse) || verse < 0) {
      say("Enter a verse number in this chapter.", "warning");
      return;
    }
    setRetargetOpen(false);
    const ref_raw = verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`;
    const patch = { verse, ref_raw };
    const baseline = { verse: selectedRow.verse, ref_raw: selectedRow.ref_raw };
    applyLocalRowPatch("tn", selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, patch, { book, baseline });
    say(`Retargeted to ${book} ${chapter}:${verse}.`);
  }

  // ── draft toolbar: Suggest (tn-quick) + Template ──────────────────────────
  const suggestBlockedReason = (() => {
    if (activeKind !== "tn") return "AI suggestions are wired for notes only";
    if (!selectedRow) return "No note selected";
    const row = selectedRow as TnRow;
    if (!row.support_reference) return "Pick a support reference first — the AI request is keyed by it";
    if (!row.quote) return "Add a quote first — the AI request needs the phrase to explain";
    return null;
  })();

  async function handleSuggest() {
    if (!data || !selectedRow || activeKind !== "tn" || suggestBlockedReason) return;
    setSuggesting(true);
    try {
      const built = buildTnQuickRequest(selectedRow as TnRow, data);
      if (!built.ok) {
        const msg =
          built.error.reason === "missing_ult_verse"
            ? "ULT verse text unavailable for this verse."
            : built.error.reason === "missing_ust_verse"
              ? "UST verse text unavailable for this verse."
              : built.error.reason === "hebrew_not_found"
                ? "Couldn't match this quote to the ULT alignment — copy the support phrase exactly from ULT."
                : "AI prerequisites missing.";
        say(msg, "warning");
        return;
      }
      const res = await api.tnQuick(built.request);
      setDraftValue(res.note);
      say(
        res.warnings.length > 0
          ? `AI draft inserted — not saved. ${res.warnings.join(" ")}`
          : "AI draft inserted into the editor — click Save to keep it.",
        res.warnings.length > 0 ? "warning" : "info",
      );
    } catch (err) {
      say(`AI suggestion failed (${err instanceof ApiError ? err.status : "error"}).`, "warning");
    } finally {
      setSuggesting(false);
    }
  }

  const templateVariants =
    activeKind === "tn" && selectedRow && (selectedRow as TnRow).support_reference
      ? (templateMap[shortSupport((selectedRow as TnRow).support_reference as string)] ?? [])
      : [];

  function applyTemplate(bodyMd: string) {
    setTemplateAnchor(null);
    setDraftValue((prev) => (prev.trim().length === 0 ? bodyMd : `${prev}\n\n${bodyMd}`));
    say("Template inserted into the editor — click Save to keep it.");
  }

  // ── quote builder ─────────────────────────────────────────────────────────
  function openQuoteBuilder() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    setQuoteKeys(selectionFromQuote(sourceVo, row.quote, row.occurrence));
    setQuoteOpen(true);
  }

  async function commitQuote() {
    if (!selectedRow || activeKind !== "tn") return;
    const built = buildQuoteFromSelection(sourceVo, quoteKeys);
    setQuoteOpen(false);
    if (!built) {
      say("No source words selected — the quote was left unchanged.", "warning");
      return;
    }
    const row = selectedRow as TnRow;
    const patch = { quote: built.quote, occurrence: built.occurrence };
    const baseline = { quote: row.quote, occurrence: row.occurrence };
    applyLocalRowPatch("tn", selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, patch, { book, baseline });
    say("Quote rebuilt from the source words.");
  }

  // ── history restore ───────────────────────────────────────────────────────
  async function handleUseVersion(text: string, fromVersion: number) {
    if (!selectedRow) return;
    setHistoryOpen(false);
    const patch = { [fieldName]: text };
    applyLocalRowPatch(activeKind, selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow(activeKind, selectedRow.id, selectedRow.version, patch, {
      book,
      baseline: { [fieldName]: baselineRef.current },
      restoredFromVersion: fromVersion,
    });
    baselineRef.current = text;
    setDraftValue(text);
  }

  // ── 409 merge resolution ──────────────────────────────────────────────────
  // "Mine" comes from our own outbox op. "Theirs" comes from the RE-READ row
  // (conflictRow) — never from the 409 body, which carries only version +
  // deleted_at.
  //
  // A row 409 can arrive for ANY patch this screen enqueues, not just the note
  // text: {quote, occurrence}, {verse, ref_raw} and {sort_order} all go through
  // the same outbox. So the conflicted fields are read off the op's own patch
  // rather than assumed to be note/response.
  const conflictTarget = conflict && conflict.op.target.kind === "row" ? conflict.op.target : null;
  const conflictTextField = conflictTarget?.rowKind === "tq" ? "response" : "note";
  const conflictKeys = conflict ? Object.keys(conflict.op.patch) : [];
  // "Textual" = the note/response text is the ONLY thing that conflicted. Only
  // then is the big two-column text compare (and resetting the editor) honest.
  const isTextConflict =
    conflictKeys.length === 1 && conflictKeys[0] === conflictTextField;
  const conflictTheirs: string | null = conflictRow
    ? unescapeNewlines(
        conflictTextField === "response"
          ? (conflictRow as TqRow).response
          : (conflictRow as TnRow).note,
      )
    : null;
  const conflictFields = conflict
    ? conflictKeys.map((field) => {
        const theirsRaw = conflictRow
          ? (conflictRow as unknown as Record<string, unknown>)[field]
          : undefined;
        return {
          field,
          label: fieldLabel(field),
          mine: displayFieldValue(conflict.op.patch[field]),
          theirs: conflictRow ? displayFieldValue(theirsRaw) : null,
        };
      })
    : [];
  // Prefer the re-read row's version: if a third write landed between the 409
  // and our read, resolving against the older number would just 409 again.
  const conflictVersion = conflictRow?.version ?? conflict?.serverVersion ?? null;

  function closeConflict() {
    setConflict(null);
    setConflictRow(null);
    setConflictError(null);
    setConflictLoading(false);
  }

  async function keepMine() {
    if (!conflict || conflictVersion == null) {
      closeConflict();
      return;
    }
    await outbox.resolveConflict(conflict.op.id, conflictVersion);
    closeConflict();
    say("Kept your version — re-sending it against the server's current version.");
  }

  async function keepTheirs() {
    // Requires the re-read row: without it we do not know what "theirs" is,
    // and adopting an unknown value would be a guess. The dialog disables the
    // button in that state; this is the matching guard.
    if (!conflict || !conflictRow) return;
    const op = conflict.op;
    const theirsText = conflictTheirs ?? "";
    const textual = isTextConflict;
    await outbox.drop(op.id);
    if (op.target.kind === "row") {
      const kind = op.target.rowKind === "tq" ? "tq" : "tn";
      applyLocalRowReplacement(kind, conflictRow);
      // The drafts store and the editor state belong to the note/response text
      // ONLY. Clearing them for a quote / retarget / reorder conflict would
      // throw away unsaved typing that had nothing to do with the conflict.
      if (textual) {
        void drafts.clear(rowKey(op.target.rowKind, book, op.target.id));
        if (selectedRow?.id === op.target.id && activeKind === kind) {
          baselineRef.current = theirsText;
          setDraftValue(theirsText);
        }
      }
    }
    closeConflict();
    say(
      textual
        ? "Kept their version — your edit was discarded."
        : `Discarded your ${joinFieldLabels(conflictFields.map((f) => f.label.toLowerCase()))} change — the row now shows the server's values. Anything unsaved in the draft box was left alone.`,
    );
  }

  function goCard(delta: number) {
    if (rows.length === 0) return;
    const pos = selectedIndex === -1 ? 0 : selectedIndex;
    setSelectedId(rows[(pos + delta + rows.length) % rows.length].id);
  }

  // ── render gates (every hook above this line, unconditionally) ────────────
  if (status === "idle" || status === "loading") {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }}>
          <CircularProgress />
        </Stack>
      </Stack>
    );
  }
  if (status === "error" || !data) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
        <Box sx={{ p: 3 }}>
          <Alert severity="error">
            Could not load {book} {chapter}.
          </Alert>
        </Box>
      </Stack>
    );
  }

  const unapprovedNotes = data.tn.filter((r) => r.translation_state !== "validated").length;
  const unapprovedQuestions = data.tq.filter((r) => r.translation_state !== "validated").length;
  const rowState = selectedRow ? stateLabel(selectedRow.translation_state) : "draft";
  const isTrashed = activeKind === "tn" && selectedRow ? (selectedRow as TnRow).trashed_at != null : false;
  const chipKind = isTrashed ? "trashed" : rowState === "validated" ? "approved" : rowState;
  const ultText = selectedRow ? (ultIndex[selectedRow.verse]?.plain_text ?? null) : null;
  const ustText = selectedRow ? (ustIndex[selectedRow.verse]?.plain_text ?? null) : null;
  const verseTwl = selectedRow ? data.twl.filter((w) => w.verse === selectedRow.verse) : [];
  const sourceText =
    selectedRow && activeKind === "tq"
      ? `Q: ${(selectedRow as TqRow).question ?? ""}`
      : null;

  const showGrid = isAuthoringMode && activeKind === "tq" && gridView;
  const contextBody = (
    <ReviewContextPanel ultText={ultText} ustText={ustText} twl={verseTwl} sourceDir={sourceDir} />
  );

  const railBlock = (
    <ReviewRail
      activeKind={activeKind}
      items={railItemsFromRows(activeKind, rows, (r) => refFor(book, r))}
      selectedId={selectedId}
      onSelect={setSelectedId}
      unapprovedNotes={unapprovedNotes}
      unapprovedQuestions={unapprovedQuestions}
      onApproveAll={handleApproveAll}
      approveProgress={approveAllProgress}
      approveError={approveAllError}
      onDismissApproveError={() => setApproveAllError(null)}
      onAddRow={handleAddRow}
      addDisabled={createLocked}
      addDisabledReason={lockReasonCreate}
      addPending={addPending}
    />
  );

  const actionButtons = (
    <>
      <Button variant="outlined" onClick={handleUndo} disabled={!hasDiff} sx={{ flex: 1, minHeight: 44 }}>
        Undo
      </Button>
      <Tooltip title={saveLocked ? lockReasonSave : ""}>
        <span style={{ flex: 1, display: "flex" }}>
          <Button
            ref={saveButtonRef}
            variant="outlined"
            onClick={handleSave}
            disabled={!hasDiff || saving || saveLocked}
            sx={{ flex: 1, minHeight: 44 }}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </span>
      </Tooltip>
      <Button
        variant="contained"
        color="success"
        onClick={handleApprove}
        disabled={approving}
        sx={{ flex: 1, minHeight: 44 }}
      >
        {approving ? "Approving…" : "Approve"}
      </Button>
    </>
  );

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: isPhone ? 12 : 0 }}>
        {chapterLock && (
          <Box sx={{ px: 2, pt: 1.5 }}>
            <LockBanner
              pipelineType={chapterLock.pipelineType}
              startedAt={chapterLock.startedAt}
              // "Mark notes to keep" SETS preserve — it never un-sets it. The
              // banner's job is to save the note from the sweep, and /preserve
              // is lock-exempt so it works while the run is still going.
              onMarkKeep={
                activeKind === "tn" && selectedRow && !(selectedRow as TnRow).preserve
                  ? () => void handleSetPreserve(true)
                  : undefined
              }
            />
          </Box>
        )}

        <Stack sx={{ px: 2, pt: 2 }} direction="row" alignItems="center" spacing={2} flexWrap="wrap">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={activeKind}
            onChange={(_e, val: RowKindTQ | null) => {
              if (val) setActiveKind(val);
            }}
          >
            <ToggleButton value="tn">Notes</ToggleButton>
            <ToggleButton value="tq">Questions</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {notice && (
          <Box sx={{ px: 2, pt: 1.5 }}>
            <Alert severity={noticeSeverity} onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          </Box>
        )}

        <Box
          sx={{
            display: "grid",
            gap: 2,
            p: 2,
            maxWidth: 1320,
            mx: "auto",
            alignItems: "start",
            gridTemplateColumns: isDesktop
              ? "240px minmax(0, 1fr) 320px"
              : band === "tablet"
                ? // Deliberately narrower than the mockup's 220px/0.85fr rail:
                  // findings §4.3 measured that at 43% of a 560px viewport,
                  // leaving the hero card ~296px. 180px keeps the work card the
                  // hero D1 asks for.
                  "180px minmax(0, 1fr)"
                : "minmax(0, 1fr)",
          }}
        >
          {!isPhone && railBlock}

          {/* Work column */}
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1.25 }}>
              <Typography variant="body2" fontWeight={600} color="text.secondary">
                {rows.length === 0
                  ? "0 of 0"
                  : `${selectedIndex + 1} of ${rows.length}`}
              </Typography>
              {chapterDrafts.length > 0 && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`${chapterDrafts.length} unsaved`}
                  onClick={goToFirstUnsaved}
                  title="Go to the first unsaved edit and focus Save"
                />
              )}
              <Box sx={{ flex: 1 }} />
              {!isDesktop && (
                <Button size="small" variant="outlined" onClick={() => (isPhone ? setSheetOpen(true) : setContextOpen((v) => !v))}>
                  This verse
                </Button>
              )}
              {isAuthoringMode && activeKind === "tq" && (
                <Button
                  size="small"
                  variant="outlined"
                  aria-pressed={gridView}
                  onClick={() => setGridView((v) => !v)}
                >
                  {gridView ? "Card view" : "Grid view"}
                </Button>
              )}
              <Button
                size="small"
                variant="outlined"
                onClick={() => setHistoryOpen(true)}
                disabled={!selectedRow}
              >
                History
              </Button>
            </Stack>

            {isPhone && rows.length > 0 && (
              <Stack direction="row" alignItems="center" justifyContent="center" spacing={2} sx={{ mb: 1.5 }}>
                <Button size="small" onClick={() => goCard(-1)} disabled={rows.length <= 1} aria-label="Previous card">
                  ‹
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {selectedIndex + 1} of {rows.length}
                </Typography>
                <Button size="small" onClick={() => goCard(1)} disabled={rows.length <= 1} aria-label="Next card">
                  ›
                </Button>
              </Stack>
            )}

            {showGrid && (
              <ReviewQuestionsGrid
                rows={rows as TqRow[]}
                refFor={(r) => refFor(book, r)}
                locked={locked}
                onSaveRow={(row, patch) => {
                  applyLocalRowPatch("tq", row.id, patch as Partial<TnRow & TqRow>);
                  void outbox.enqueueRow("tq", row.id, row.version, patch, {
                    book,
                    baseline: { question: row.question ?? "", response: row.response ?? "" },
                  });
                }}
                onDeleteRow={(row) => void handleDeleteQuestion(row)}
              />
            )}

            {!selectedRow ? (
              <Alert severity="info">
                No {activeKind === "tn" ? "notes" : "questions"} for this chapter.
              </Alert>
            ) : (
              <Box
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 2,
                  bgcolor: "background.paper",
                  opacity: isTrashed ? 0.75 : 1,
                }}
              >
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
                  <Typography variant="overline" color="text.secondary">
                    {activeKind === "tn" ? "Translation note" : "Translation question"}
                  </Typography>
                  <FlowStatusChip kind={chipKind} />
                  <Typography variant="caption" color="text.secondary">
                    {refFor(book, selectedRow)}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  {activeKind === "tn" && (
                    <Stack direction="row" spacing={0.5}>
                      {([-1, 1] as const).map((delta) => {
                        const reason = reorderBlockedReason(delta);
                        return (
                          <Tooltip key={delta} title={reason ?? (delta === -1 ? "Move up" : "Move down")}>
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={reason !== null}
                                onClick={() => void handleReorder(delta)}
                                aria-label={delta === -1 ? "Move up" : "Move down"}
                                sx={{ minWidth: 44, minHeight: 44 }}
                              >
                                {delta === -1 ? "↑" : "↓"}
                              </Button>
                            </span>
                          </Tooltip>
                        );
                      })}
                      <Tooltip title={createLocked ? lockReasonCreate : "Insert note after this one"}>
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={createLocked}
                            onClick={() => void handleInsertAfter()}
                            aria-label="Insert note after this one"
                            sx={{ minWidth: 44, minHeight: 44 }}
                          >
                            +
                          </Button>
                        </span>
                      </Tooltip>
                      <Tooltip title="Retarget verse reference">
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => {
                              setRetargetValue(String(selectedRow.verse));
                              setRetargetOpen(true);
                            }}
                            aria-label="Retarget verse reference"
                            sx={{ minWidth: 44, minHeight: 44 }}
                          >
                            ⟳
                          </Button>
                        </span>
                      </Tooltip>
                    </Stack>
                  )}
                </Stack>

                {activeKind === "tn" && (
                  <ReviewSourceStrip
                    label={sourceLabel}
                    dir={sourceDir}
                    quote={(selectedRow as TnRow).quote}
                    occurrence={(selectedRow as TnRow).occurrence}
                    supportReference={(selectedRow as TnRow).support_reference}
                    onBuildFromSource={sourceVo ? openQuoteBuilder : undefined}
                    buildDisabledReason={
                      sourceVo
                        ? "Pick source words to rebuild this note's quote"
                        : `No ${sourceLabel} verse loaded for this chapter — nothing to build a quote from`
                    }
                    buildButtonRef={quoteButtonRef}
                  />
                )}

                {sourceText && (
                  <Box
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: 1,
                      paddingInline: 1.5,
                      paddingBlock: 1,
                      mb: 1.5,
                      whiteSpace: "pre-wrap",
                      fontSize: "0.9rem",
                      textAlign: "start",
                      fontFamily: SCRIPTURE_FONT_STACK,
                    }}
                  >
                    {sourceText}
                  </Box>
                )}

                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
                  <Tooltip title={suggestBlockedReason ?? "Draft this note with AI"}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={suggestBlockedReason !== null || suggesting}
                        onClick={() => void handleSuggest()}
                        sx={{ borderRadius: 999, minHeight: 44 }}
                      >
                        {suggesting ? "Drafting…" : "✨ Suggest"}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip
                    title={
                      activeKind !== "tn"
                        ? "Templates are keyed by a note's support reference"
                        : templateVariants.length === 0
                          ? "No template recorded for this support reference"
                          : "Insert a curated template"
                    }
                  >
                    <span>
                      <Button
                        ref={templateButtonRef}
                        size="small"
                        variant="outlined"
                        disabled={templateVariants.length === 0}
                        onClick={(e) => setTemplateAnchor(e.currentTarget)}
                        sx={{ borderRadius: 999, minHeight: 44 }}
                      >
                        Template
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>

                <TextField
                  multiline
                  fullWidth
                  minRows={4}
                  label="Draft"
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  disabled={saveLocked}
                  inputProps={{ "data-dirty": hasDiff ? "true" : "false" }}
                />

                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
                  <Chip
                    size="small"
                    label="Preserve"
                    variant={activeKind === "tn" && (selectedRow as TnRow).preserve ? "filled" : "outlined"}
                    color={activeKind === "tn" && (selectedRow as TnRow).preserve ? "primary" : "default"}
                    onClick={activeKind === "tn" ? handleTogglePreserve : undefined}
                    disabled={activeKind !== "tn"}
                    title={activeKind !== "tn" ? "Preserve only applies to notes" : undefined}
                  />
                  <Chip
                    size="small"
                    label="Hint"
                    variant={activeKind === "tn" && (selectedRow as TnRow).hint ? "filled" : "outlined"}
                    color={activeKind === "tn" && (selectedRow as TnRow).hint ? "primary" : "default"}
                    onClick={activeKind === "tn" ? handleToggleHint : undefined}
                    disabled={activeKind !== "tn"}
                    title={activeKind !== "tn" ? "Hint only applies to notes" : undefined}
                  />
                  {activeKind === "tn" ? (
                    <Chip
                      size="small"
                      label={isTrashed ? "Restore" : "Trash"}
                      variant={isTrashed ? "filled" : "outlined"}
                      onClick={handleToggleTrash}
                      title={
                        isTrashed
                          ? "Bring this note back out of the trash"
                          : "Move this note to the visible, restorable trash"
                      }
                    />
                  ) : (
                    <Chip
                      size="small"
                      label="Delete"
                      color="error"
                      variant="outlined"
                      disabled={deleteLocked}
                      onClick={
                        deleteLocked ? undefined : () => void handleDeleteQuestion(selectedRow as TqRow)
                      }
                      title={
                        deleteLocked
                          ? lockReasonDelete
                          : "Questions are deleted outright — there is no question trash"
                      }
                    />
                  )}
                </Stack>

                {!isPhone && (
                  <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
                    {actionButtons}
                  </Stack>
                )}
              </Box>
            )}

            {/* Tablet: verse context stays available, collapsed — it is NOT
                replaced by the phone sheet (findings §4.3). */}
            {band === "tablet" && selectedRow && (
              <Collapse in={contextOpen}>
                <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, mt: 2 }}>
                  <Typography variant="overline" color="text.secondary">
                    This verse
                  </Typography>
                  <Box sx={{ mt: 1 }}>{contextBody}</Box>
                </Box>
              </Collapse>
            )}
          </Box>

          {/* Desktop: persistent verse-context column */}
          {isDesktop && selectedRow && (
            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                p: 1.5,
                position: "sticky",
                top: 8,
                maxHeight: "78vh",
                overflowY: "auto",
                bgcolor: "background.paper",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                This verse
              </Typography>
              <Box sx={{ mt: 1 }}>{contextBody}</Box>
            </Box>
          )}
        </Box>
      </Box>

      {isPhone && selectedRow && <FlowActionBar>{actionButtons}</FlowActionBar>}

      {/* Phone: "This verse" bottom sheet — read-only context, never a second
          work surface (D1). */}
      <Drawer anchor="bottom" open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <Box sx={{ p: 2, maxHeight: "78vh", overflowY: "auto" }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            This verse — read-only context
          </Typography>
          {contextBody}
        </Box>
      </Drawer>

      <Menu anchorEl={templateAnchor} open={Boolean(templateAnchor)} onClose={() => setTemplateAnchor(null)}>
        {templateVariants.map((t, i) => (
          <MenuItem key={`${t.type}-${i}`} onClick={() => applyTemplate(t.body)} sx={{ maxWidth: 420 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600}>
                {t.type}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {t.body}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </Menu>

      {selectedRow && (
        <ReviewHistoryDialog
          open={historyOpen}
          kind={activeKind}
          rowId={selectedRow.id}
          book={book}
          currentVersion={selectedRow.version}
          trashed={isTrashed}
          onClose={() => setHistoryOpen(false)}
          onRestoreFromTrash={
            isTrashed
              ? () => {
                  setHistoryOpen(false);
                  void handleToggleTrash();
                }
              : undefined
          }
          onUseVersion={(text, from) => void handleUseVersion(text, from)}
        />
      )}

      <ReviewConflictDialog
        open={conflict !== null}
        kind={conflictTextField === "response" ? "tq" : "tn"}
        fields={conflictFields}
        textual={isTextConflict}
        theirsLoaded={conflictRow !== null}
        theirsVersion={conflictVersion}
        // From the re-read row. The 409 body has no updated_at at all.
        theirsUpdatedAt={conflictRow?.updated_at ?? null}
        loadingTheirs={conflictLoading}
        theirsError={conflictError}
        onKeepMine={() => void keepMine()}
        onKeepTheirs={() => void keepTheirs()}
        onClose={closeConflict}
      />

      <Dialog open={retargetOpen} onClose={() => setRetargetOpen(false)}>
        <DialogTitle>Retarget verse reference</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            type="number"
            margin="dense"
            label={`Verse number within ${book} ${chapter}`}
            value={retargetValue}
            onChange={(e) => setRetargetValue(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetargetOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleRetarget()}>
            Retarget
          </Button>
        </DialogActions>
      </Dialog>

      {selectedRow && activeKind === "tn" && (
        <QuoteBuilderPopper
          open={quoteOpen}
          anchorEl={quoteButtonRef.current}
          book={book}
          chapter={chapter}
          verse={selectedRow.verse}
          uhbVerseObjects={sourceVo}
          ultVerseObjects={ultVo}
          ustVerseObjects={ustVo}
          lexiconMap={lexiconMap}
          selectedKeys={quoteKeys}
          onToggleKey={(key) =>
            setQuoteKeys((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onSelectKeys={(keys) =>
            setQuoteKeys((prev) => {
              const next = new Set(prev);
              for (const k of keys) next.add(k);
              return next;
            })
          }
          onCancel={() => setQuoteOpen(false)}
          onCommit={() => void commitQuote()}
        />
      )}
    </Stack>
  );
}
