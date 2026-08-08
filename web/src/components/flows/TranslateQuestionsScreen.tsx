// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// TranslateQuestionsScreen — the translationQuestions queue, built to the
// approved "Translate Questions — Titus 1" mockup and following the patterns
// TranslateNotesScreen established (drafts store, save-then-validate, frozen
// queue, edited-as-chip, one centred column at every width).
//
// What differs from the notes screen, and why:
//
//   * TWO target fields per row — `question` and `response`. Each is tapped and
//     edited independently, but they share ONE drafts record (the tq draft key
//     rowKey("tq", book, id) is already shared with ReviewQueue's grid + card,
//     and its payload is a patch carrying whichever of the two fields is dirty).
//     Both fields also share one status chip, because Approve/Not-needed are
//     decisions about the row, not about a field.
//
//   * NO quote highlight in the scripture card. tq rows carry a quote column in
//     the TSV, but the mockup deliberately shows plain ULT/UST here: the
//     translator is comparing a whole question to a whole verse, not a phrase.
//
//   * NO "Not needed" verb, unlike the notes screen. Questions are meant to get
//     CHANGED, not dropped — the goal is full coverage, so a question the
//     translator dislikes is fixed by editing the target text and then approving
//     it. There is exactly one verb: Approve. (This is also the only
//     honest option in the API: tq has POST /rows/tq/:id/validate
//     (api/src/rows.ts:1174) but NO trash/restore — those are tn-only
//     (rows.ts:1220, :1233) — and TqRow has no `trashed_at` field at all
//     (web/src/sync/api.ts:59-82). There is nothing a skip could write.)
//
//   * NO "Redo" button (hidden per Benjamin, 2026-08-07 — it shipped disabled,
//     and a permanently disabled verb earns no screen space). There is no
//     synchronous tq drafting endpoint (no tq-quick analogue of api.tnQuick);
//     questions ARE re-draftable, but only via an async chapter-scoped
//     `translate` pipeline job (Shell.tsx — pipelineStore.start with
//     { pipelineType: "translate", translate: { resourceType: "tq", rowIds } }).
//     If users ask for per-question redo, bring the button back wired to that.
//
//   * Chapter lock: unlike tn, tq PATCH is NOT lock-exempt (api/src/rows.ts:597
//     — the carve-out covers tn only), so a save during an AI run comes back 409
//     locked and is dropped rather than overwritten. /validate IS lock-exempt
//     (rows.ts:1173). The banner therefore says something real here.
//
// 409 handling is deliberately minimal, as on the notes screen: a banner saying
// another editor changed the row, with a reload affordance.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CheckIcon from "@mui/icons-material/Check";

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { unescapeNewlines, waitForOp } from "./translateShared";
import type { FlowScreenContext } from "./types";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useSourceQuestions } from "../../hooks/useSourceQuestions";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { resolveSourceRef } from "../../lib/sourceRef";
import { buildVerseIndex } from "../../lib/verseRange";
import { drafts, rowKey } from "../../sync/drafts";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { api, ApiError, type ChapterLockedBody, type TqRow } from "../../sync/api";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateQuestionsScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
}

// A card finishes exactly one way: approved. "Edited" is a chip, not a terminal
// state — editing a draft does not approve it.
type CardStatus = "approved";

// The two editable target fields on a tq row.
type Field = "question" | "response";
const FIELDS: Field[] = ["question", "response"];

// Content width — the mockup's 430px phone shell, given a little more room.
const COLUMN_PX = 480;

export default function TranslateQuestionsScreen({
  book,
  chapter,
}: TranslateQuestionsScreenProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // --hl from docs/flows/ui/_tokens.css: the ground the "Edited" chip and the
  // tap-to-edit hover share.
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  // .ref in the mockup: Ocean in light, Cultivate in dark.
  const REF_COLOR = dark ? "#70C9CC" : "#014263";
  const { ok, skip } = theme.palette.flows;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || "Target";
  const litLabel = projectConfig?.litLabel || "ULT";
  const simLabel = projectConfig?.simLabel || "UST";
  const sourceLangLabel = (
    projectConfig?.translationSource?.languageCode ?? "en"
  ).toUpperCase();

  // The English source question/answer live in the PUBLISHED source repo, not in
  // D1: in a translation-mode workspace the row's OWN question/response ARE the
  // target being drafted (useSourceQuestions.ts:3-7; ResourceColumn.tsx:376-380
  // wires it exactly this way). Null projection = no tQ source configured → the
  // source lines degrade to a plain statement rather than echoing the target.
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tq"),
    [projectConfig],
  );
  const sourceQuestions = useSourceQuestions(translationMode ? book : null, sourceProjection);

  const { status, data, refetch, applyLocalRowPatch, applyLocalRowReplacement } = useChapter(
    book,
    chapter,
  );
  const { summary } = useBook(book, true);
  const chapterCount = summary?.chapters.length ?? null;

  // ── queue ────────────────────────────────────────────────────────────────
  // Frozen once per chapter so the denominator ("3 of 8") and the progress bar
  // stay stable while the translator works.
  const chapterKey = `${book}:${chapter}`;
  const [queue, setQueue] = useState<{ key: string; ids: string[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<"cards" | "done">("cards");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!data || data.book !== book || data.chapter !== chapter) return;
    if (queue?.key === chapterKey) return;
    const ordered = [...data.tq].sort(
      (a, b) => a.verse - b.verse || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    const seed: Record<string, CardStatus> = {};
    for (const r of ordered) if (r.translation_state === "validated") seed[r.id] = "approved";
    const firstOpen = ordered.findIndex((r) => !seed[r.id]);
    setQueue({ key: chapterKey, ids: ordered.map((r) => r.id) });
    setStatuses(seed);
    setEditedIds(new Set());
    setCursor(firstOpen < 0 ? 0 : firstOpen);
    setView(ordered.length > 0 && firstOpen < 0 ? "done" : "cards");
    setReviewing(false);
  }, [data, book, chapter, queue, chapterKey]);

  const rowById = useMemo(() => {
    const m = new Map<string, TqRow>();
    for (const r of data?.tq ?? []) m.set(r.id, r);
    return m;
  }, [data]);

  const queueIds = queue?.key === chapterKey ? queue.ids : null;
  const total = queueIds?.length ?? 0;
  const currentId = queueIds && cursor < queueIds.length ? queueIds[cursor] : null;
  const row = currentId ? (rowById.get(currentId) ?? null) : null;
  const statusedCount = queueIds ? queueIds.filter((id) => statuses[id]).length : 0;

  // ── editor state ─────────────────────────────────────────────────────────
  // One value + one baseline per field; one drafts record for the pair.
  const [values, setValues] = useState<Record<Field, string>>({ question: "", response: "" });
  const baselineRef = useRef<Record<Field, string>>({ question: "", response: "" });
  const hydratedKeyRef = useRef<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editingField, setEditingField] = useState<Field | null>(null);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);

  const say = useCallback((text: string, severity: "info" | "warning" = "warning") => {
    setNotice({ text, severity });
  }, []);

  // Hydrate both fields on card change: a persisted draft (unsaved typing from
  // this browser) wins over the row's own content.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tq", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (hydratedKeyRef.current === nonceKey) return;
    hydratedKeyRef.current = nonceKey;
    const fallback: Record<Field, string> = {
      question: unescapeNewlines(row.question),
      response: unescapeNewlines(row.response),
    };
    baselineRef.current = { ...fallback };
    setValues(fallback);
    setEditingField(null);
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== nonceKey) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      if (!payload) return;
      const nextValues = { ...fallback };
      const nextBaseline = { ...fallback };
      for (const f of FIELDS) {
        const patchVal = payload.patch?.[f];
        if (typeof patchVal === "string") nextValues[f] = unescapeNewlines(patchVal);
        const baselineVal = payload.baseline?.[f];
        if (typeof baselineVal === "string") nextBaseline[f] = unescapeNewlines(baselineVal);
      }
      baselineRef.current = nextBaseline;
      setValues(nextValues);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id, book, reloadNonce]);

  const dirtyFields = FIELDS.filter((f) => values[f] !== baselineRef.current[f]);
  const hasDiff = dirtyFields.length > 0;

  // Stash every keystroke. Nothing leaves the browser here — the draft store is
  // what makes "no save on blur, no save on unmount" safe. Only the dirty fields
  // go into the patch, matching the shape ReviewQueue writes under this key
  // (ReviewQueue.tsx:390-422) so the two never mis-read each other's records.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tq", book, row.id);
    const patch: Record<string, string> = {};
    const baseline: Record<string, string> = {};
    for (const f of FIELDS) {
      if (values[f] === baselineRef.current[f]) continue;
      patch[f] = values[f];
      baseline[f] = baselineRef.current[f];
    }
    if (Object.keys(patch).length > 0) {
      void drafts.set(key, { patch, baseline }, row.version, {
        kind: "row",
        rowKind: "tq",
        id: row.id,
        book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, row?.id, row?.version, book]);

  useUnsavedGuard(hasDiff);

  // ── outbox reconciliation ────────────────────────────────────────────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row" || op.target.rowKind !== "tq" || op.target.book !== book) {
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
            "Another editor changed this question while you were working on it. Your version was not saved.",
          );
        }
      }),
    [book],
  );

  // ── scripture context ────────────────────────────────────────────────────
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);
  const ultText = row ? (ultIndex[row.verse]?.plain_text ?? null) : null;
  const ustText = row ? (ustIndex[row.verse]?.plain_text ?? null) : null;

  const sourceQuestion = row ? (sourceQuestions.get(row.id) ?? null) : null;

  // ── navigation between cards ─────────────────────────────────────────────
  const nextUnstatused = useCallback(
    (from: number, table: Record<string, CardStatus>): number => {
      if (!queueIds) return -1;
      for (let i = 1; i <= queueIds.length; i++) {
        const idx = (from + i) % queueIds.length;
        if (!table[queueIds[idx]]) return idx;
      }
      return -1;
    },
    [queueIds],
  );

  const advanceAfter = useCallback(
    (id: string, next: CardStatus) => {
      if (!queueIds) return;
      const table = { ...statuses, [id]: next };
      if (reviewing) {
        if (cursor >= queueIds.length - 1) setView("done");
        else setCursor(cursor + 1);
        return;
      }
      const nxt = nextUnstatused(cursor, table);
      if (nxt === -1) setView("done");
      else setCursor(nxt);
    },
    [queueIds, statuses, reviewing, cursor, nextUnstatused],
  );

  // ── writes ───────────────────────────────────────────────────────────────
  // Save-then-validate, in that order and awaited: /validate does not carry a
  // version, so a PATCH that landed after it would demote the row straight back
  // to 'edited' server-side. The outbox stays the only thing that talks to
  // /api/rows — we just wait for its result before approving.
  async function saveDraft(target: TqRow): Promise<boolean> {
    const patch: { question?: string; response?: string } = {};
    const baseline: Record<string, string> = {};
    for (const f of FIELDS) {
      if (values[f] === baselineRef.current[f]) continue;
      patch[f] = values[f];
      baseline[f] = baselineRef.current[f];
    }
    if (Object.keys(patch).length === 0) return true;
    applyLocalRowPatch("tq", target.id, patch);
    const op = await outbox.enqueueRow("tq", target.id, target.version, patch, { book, baseline });
    const result = await waitForOp(op.id);
    if (result === null) {
      say("Your edit is queued but the server hasn't confirmed it yet — it was not approved.");
      return false;
    }
    if (result.kind !== "ok") {
      if (result.kind === "conflict") {
        setConflictNotice(
          "Another editor changed this question while you were working on it. Your version was not saved.",
        );
      } else if (result.kind === "locked") {
        setChapterLock(result.lockBody);
        say("An AI run is rewriting this chapter — your edit was dropped rather than overwritten.");
      } else {
        say(`Saving this question failed (${result.reason}). It was not approved.`);
      }
      return false;
    }
    baselineRef.current = { ...values };
    setEditedIds((prev) => new Set(prev).add(target.id));
    return true;
  }

  async function handleApprove() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (hasDiff && !(await saveDraft(row))) return;
      const updated = await api.validateQuestion(row.id, book, true);
      applyLocalRowReplacement("tq", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "approved" }));
      setEditingField(null);
      setToast("Approved");
      advanceAfter(row.id, "approved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say("Approve needs a draft first — this question hasn't been through the AI pipeline yet.");
      } else {
        say(`Approve failed (${err instanceof ApiError ? err.status : "error"}).`);
      }
    } finally {
      setBusy(false);
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
  // Approved-as-is vs approved-after-editing. Every question ends in one of the
  // two, so the pair sums to the total.
  const approvedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && !editedIds.has(id),
  ).length;
  const editedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && editedIds.has(id),
  ).length;

  // One chip for the row — both fields share it, because the decision is about
  // the row and not about a field.
  function chipFor(id: string, rowForChip: TqRow | null, dirty: boolean) {
    const s = statuses[id];
    if (s === "approved") return { kind: "approved" as FlowStatusKind, label: "Approved" };
    if (dirty || rowForChip?.translation_state === "edited" || editedIds.has(id)) {
      return { kind: "edited" as FlowStatusKind, label: "Edited" };
    }
    const aiDrafted =
      rowForChip?.translation_state === "ai_draft" || rowForChip?.latest_source === "ai_pipeline";
    return { kind: "draft" as FlowStatusKind, label: aiDrafted ? "AI draft" : "Draft" };
  }

  const chip = row ? chipFor(row.id, row, hasDiff) : { kind: "draft" as FlowStatusKind, label: "Draft" };

  const nextChapter = chapter + 1;
  const hasNextChapter = chapterCount === null ? true : nextChapter <= chapterCount;

  const sub = translationMode
    ? `${book} ${chapter} · ${sourceLangLabel} to ${targetLabel}`
    : `${book} ${chapter} · ${targetLabel}`;

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

  const langTagSx = {
    display: "block",
    fontSize: "0.656rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    m: 0,
  };

  function Lane({ label, text }: { label: string; text: string | null }) {
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
        <Box component="span" sx={{ ...langTagSx, fontFamily: theme.typography.fontFamily, mb: 0.375 }}>
          {label}
        </Box>
        {text ?? (
          <Box component="em" sx={{ color: "text.secondary", fontSize: "0.875rem" }}>
            No {label} text exists for this verse in this workspace. That is normal in a
            translation-mode workspace whose target lanes have not been drafted yet.
          </Box>
        )}
      </Box>
    );
  }

  // One field pair: the source line (quiet, read-only) directly above the
  // target line (normal ink, tap-to-edit) — grouped by FIELD, so the eye never
  // crosses a language boundary between two different fields.
  function QaPair({ field, sourceText }: { field: Field; sourceText: string | null }) {
    const value = values[field];
    const editing = editingField === field;
    return (
      <Box>
        <Box
          sx={{
            bgcolor: "action.hover",
            borderRadius: "9px",
            paddingBlock: 1,
            paddingInline: 1.25,
            mb: 1,
          }}
        >
          <Box component="span" sx={langTagSx}>
            {sourceLangLabel}
          </Box>
          {sourceText ? (
            <Typography
              sx={{ color: "text.secondary", fontSize: "0.94rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}
            >
              {sourceText}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {translationMode
                ? sourceProjection
                  ? "No published source for this question — it may have been added here rather than translated."
                  : "No source repository is configured for questions, so there is nothing to compare against."
                : "This workspace authors questions rather than translating them, so there is no separate source."}
            </Typography>
          )}
        </Box>

        <Box>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
            <Box component="span" sx={langTagSx}>
              {targetLabel}
            </Box>
            <Box sx={{ ml: "auto" }}>
              <FlowStatusChip kind={chip.kind} label={chip.label} />
            </Box>
          </Stack>

          {editing ? (
            <>
              <TextField
                autoFocus
                multiline
                fullWidth
                minRows={3}
                value={value}
                onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
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
                    setEditingField(null);
                    if (value !== baselineRef.current[field]) setToast("Draft updated");
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
                onClick={() => setEditingField(field)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditingField(field);
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
                  "&:hover": { background: HL },
                }}
              >
                {value.trim().length > 0 ? (
                  value
                ) : (
                  <Box component="em" sx={{ color: "text.secondary" }}>
                    Nothing drafted yet — tap to write this in {targetLabel}.
                  </Box>
                )}
              </Box>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                Tap the text to edit
              </Typography>
            </>
          )}
        </Box>
      </Box>
    );
  }

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
              aria-label={`Leave ${book} ${chapter} questions`}
              onClick={() => {
                location.hash = "#/home";
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                Translation Questions
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
              {done ? `${total} of ${total}` : `${Math.min(cursor + 1, total)} of ${total}`}
            </Typography>
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

      <Box
        sx={{
          maxWidth: COLUMN_PX,
          mx: "auto",
          paddingInline: 2,
          paddingBlockStart: 2,
          // room for the fixed action bar
          paddingBlockEnd: done ? 4 : 15,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        {chapterLock && (
          // Unlike notes, tq PATCH is NOT lock-exempt: saves are refused with a
          // 409 while a run holds the chapter. Approve still lands.
          <LockBanner pipelineType={chapterLock.pipelineType} startedAt={chapterLock.startedAt} />
        )}

        {conflictNotice && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={reloadRow}>
                Reload question
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
          <Alert severity="info">No translation questions in {`${book} ${chapter}`}.</Alert>
        ) : done ? (
          <>
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
                {book} {chapter} questions reviewed
              </Typography>
              <Typography variant="body2" color="text.secondary">
                All {total} questions are approved.
              </Typography>
            </Box>

            <Stack direction="row" spacing={1.25}>
              {[
                { n: approvedCount, label: "Approved as-is", color: ok.main },
                { n: editedCount, label: "Edited", color: ACCENT },
                { n: total, label: "Total", color: theme.palette.text.secondary },
              ].map((s) => (
                <Box key={s.label} sx={{ ...cardSx, flex: 1, textAlign: "center", paddingInline: 0.75 }}>
                  <Typography
                    component="b"
                    sx={{
                      display: "block",
                      fontSize: "1.5rem",
                      lineHeight: 1.15,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: s.color,
                    }}
                  >
                    {s.n}
                  </Typography>
                  <Typography
                    component="span"
                    sx={{ fontSize: "0.75rem", fontWeight: 600, color: "text.secondary", whiteSpace: "nowrap" }}
                  >
                    {s.label}
                  </Typography>
                </Box>
              ))}
            </Stack>

            <Stack spacing={1.25}>
              {queueIds.map((id, i) => {
                const r = rowById.get(id) ?? null;
                const c = chipFor(id, r, false);
                return (
                  <Box
                    key={id}
                    component="button"
                    onClick={() => {
                      setReviewing(true);
                      setCursor(i);
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
                      "&:hover": { borderColor: INSPIRE },
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>
                        {r ? (r.verse === 0 ? `${book} ${chapter} intro` : `${book} ${chapter}:${r.verse}`) : id}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {unescapeNewlines(r?.question) || "—"}
                      </Typography>
                    </Box>
                    <FlowStatusChip kind={c.kind} label={c.label} />
                  </Box>
                );
              })}
            </Stack>

            <Stack spacing={1} sx={{ mt: 0.5 }}>
              <Button
                variant="contained"
                disabled={!hasNextChapter}
                onClick={() => {
                  location.hash = `#/questions/${book}/${nextChapter}`;
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
          </>
        ) : !row ? (
          <Box sx={cardSx}>
            <Typography variant="body2" color="text.secondary">
              This question is no longer in the chapter — another editor may have removed it.
            </Typography>
            <Button
              sx={{ mt: 1 }}
              onClick={() => setCursor((c) => Math.min(c + 1, total - 1))}
              disabled={cursor >= total - 1}
            >
              Next question
            </Button>
          </Box>
        ) : (
          <>
            {/* scripture — no quote highlight: tq is a whole-verse question */}
            <Box sx={cardSx}>
              <Typography sx={{ fontSize: "0.875rem", fontWeight: 700, color: REF_COLOR, mb: 0.75 }}>
                {row.verse === 0
                  ? `${book} ${row.chapter} intro`
                  : `${book} ${row.chapter}:${row.verse}`}
              </Typography>
              <Lane label={litLabel} text={ultText} />
              <Lane label={simLabel} text={ustText} />
            </Box>

            {/* question */}
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                Question
              </Typography>
              <QaPair field="question" sourceText={sourceQuestion?.question ?? null} />
            </Box>

            {/* expected answer */}
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                Expected answer
              </Typography>
              <QaPair field="response" sourceText={sourceQuestion?.response ?? null} />
            </Box>

            {/* previous / next */}
            <Stack direction="row" justifyContent="space-between" spacing={1.25}>
              <Button
                startIcon={<ChevronLeftIcon />}
                disabled={cursor === 0}
                onClick={() => setCursor((c) => Math.max(0, c - 1))}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                Previous
              </Button>
              <Button
                endIcon={<ChevronRightIcon />}
                disabled={cursor >= total - 1}
                onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                Next
              </Button>
            </Stack>
          </>
        )}
      </Box>

      {/* fixed action bar — the one verb, at every width */}
      {!done && total > 0 && row && (
        <Box
          component="footer"
          sx={{
            position: "fixed",
            insetBlockEnd: 0,
            insetInline: 0,
            zIndex: theme.zIndex.appBar,
            bgcolor: "background.paper",
            borderBlockStart: "1px solid",
            borderColor: "divider",
          }}
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              maxWidth: COLUMN_PX,
              mx: "auto",
              paddingInline: 2,
              paddingBlockStart: 1.5,
              paddingBlockEnd: "calc(12px + env(safe-area-inset-bottom))",
            }}
          >
            <Button
              disabled={busy}
              onClick={() => void handleApprove()}
              startIcon={<CheckIcon />}
              sx={{
                flex: 1,
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
      )}

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
