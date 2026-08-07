// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t2-review: a focused Notes/Questions review queue built from the app's real
// data + save machinery (see docs/flows/ui/t2-review.html for the design this
// mirrors). Explicit-Save-only, drafts persisted via web/src/sync/drafts.ts,
// saves go through the outbox exactly like NoteCard.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { TopBar } from "./TopBar";
import { useChapter } from "../hooks/useChapter";
import { outbox } from "../sync/outbox";
import { drafts, rowKey } from "../sync/drafts";
import { api, ApiError, type TnRow, type TqRow } from "../sync/api";

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

function refFor(book: string, row: QueueRow): string {
  return row.verse === 0 ? `${book} ${row.chapter} intro` : `${book} ${row.chapter}:${row.verse}`;
}

function stateLabel(state: TnRow["translation_state"] | TqRow["translation_state"]): "draft" | "edited" | "validated" {
  return state === "validated" || state === "edited" ? state : "draft";
}

function stateChipColor(state: "draft" | "edited" | "validated"): "default" | "primary" | "success" {
  if (state === "validated") return "success";
  if (state === "edited") return "primary";
  return "default";
}

export function ReviewQueue({ book, chapter, onNavigate }: ReviewQueueProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("lg")); // >=900: rail + work + context
  const isTabletUp = useMediaQuery(theme.breakpoints.up("sm")); // >=560: rail + work

  const { status, data, applyLocalRowPatch, applyLocalRowReplacement } = useChapter(book, chapter);

  const [activeKind, setActiveKind] = useState<RowKindTQ>("tn");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const baselineRef = useRef<string>("");
  const hydratedKeyRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveMessage, setApproveMessage] = useState<string | null>(null);

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
    setApproveMessage(null);
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

  async function handleSave() {
    if (!selectedRow || !hasDiff || saving) return;
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

  async function handleApprove() {
    if (!selectedRow || approving) return;
    setApproving(true);
    setApproveMessage(null);
    try {
      const updated =
        activeKind === "tn"
          ? await api.validateNote(selectedRow.id, book, true)
          : await api.validateQuestion(selectedRow.id, book, true);
      applyLocalRowReplacement(activeKind, updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setApproveMessage("Approve needs an AI draft first — this row hasn't been through the AI pipeline yet.");
      } else {
        setApproveMessage(`Approve failed (${err instanceof ApiError ? err.status : "error"}).`);
      }
    } finally {
      setApproving(false);
    }
  }

  async function handleTogglePreserve() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      const updated = await api.setPreserveNote(row.id, book, !row.preserve);
      applyLocalRowReplacement("tn", updated);
    } catch {
      /* best-effort toggle; row stays as-is on failure */
    }
  }

  async function handleToggleHint() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      const updated = await api.setHintNote(row.id, book, !row.hint);
      applyLocalRowReplacement("tn", updated);
    } catch {
      /* best-effort toggle; row stays as-is on failure */
    }
  }

  function goCard(delta: number) {
    if (rows.length === 0) return;
    const pos = selectedIndex === -1 ? 0 : selectedIndex;
    const next = (pos + delta + rows.length) % rows.length;
    setSelectedId(rows[next].id);
  }

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
          <Alert severity="error">Could not load {book} {chapter}.</Alert>
        </Box>
      </Stack>
    );
  }

  const ultText = selectedRow ? data.verses.ULT?.[selectedRow.verse]?.plain_text ?? null : null;
  const ustText = selectedRow ? data.verses.UST?.[selectedRow.verse]?.plain_text ?? null : null;
  const rowState = selectedRow ? stateLabel(selectedRow.translation_state) : "draft";
  const supportRef = activeKind === "tn" && selectedRow ? (selectedRow as TnRow).support_reference : null;
  const sourceText =
    selectedRow && activeKind === "tn"
      ? unescapeNewlines((selectedRow as TnRow).note)
      : selectedRow
        ? `Q: ${(selectedRow as TqRow).question ?? ""}\nA: ${unescapeNewlines((selectedRow as TqRow).response)}`
        : "";

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
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
          {rows.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {selectedIndex + 1} of {rows.length}
            </Typography>
          )}
        </Stack>

        <Box
          sx={{
            display: "grid",
            gap: 2,
            p: 2,
            maxWidth: 1320,
            mx: "auto",
            gridTemplateColumns: {
              xs: "1fr",
              sm: "240px minmax(0, 1fr)",
              lg: "240px minmax(0, 1fr) 320px",
            },
          }}
        >
          {/* Queue rail — tablet and desktop only */}
          {isTabletUp && (
            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                overflow: "hidden",
                position: "sticky",
                top: 8,
                maxHeight: "70vh",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box sx={{ overflowY: "auto" }}>
                {rows.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                    No {activeKind === "tn" ? "notes" : "questions"} for this chapter.
                  </Typography>
                ) : (
                  rows.map((row) => {
                    const st = stateLabel(row.translation_state);
                    const quote =
                      activeKind === "tn" ? (row as TnRow).quote ?? "" : (row as TqRow).question ?? "";
                    return (
                      <Box
                        key={row.id}
                        component="button"
                        type="button"
                        onClick={() => setSelectedId(row.id)}
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          width: "100%",
                          textAlign: "start",
                          border: "none",
                          borderBottom: 1,
                          borderColor: "divider",
                          bgcolor: row.id === selectedId ? "action.selected" : "transparent",
                          cursor: "pointer",
                          p: 1,
                          font: "inherit",
                          color: "inherit",
                        }}
                      >
                        <Box
                          sx={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            flex: "none",
                            bgcolor:
                              st === "validated"
                                ? "success.main"
                                : st === "edited"
                                  ? "primary.main"
                                  : "action.disabled",
                          }}
                        />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" fontWeight={600} noWrap>
                            {refFor(book, row)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap component="div">
                            {quote}
                          </Typography>
                        </Box>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          )}

          {/* Work card */}
          <Box sx={{ minWidth: 0 }}>
            {!isTabletUp && rows.length > 0 && (
              <Stack direction="row" alignItems="center" justifyContent="center" spacing={2} sx={{ mb: 1.5 }}>
                <Button size="small" onClick={() => goCard(-1)} disabled={rows.length <= 1}>
                  ‹
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {selectedIndex + 1} of {rows.length}
                </Typography>
                <Button size="small" onClick={() => goCard(1)} disabled={rows.length <= 1}>
                  ›
                </Button>
              </Stack>
            )}

            {!selectedRow ? (
              <Alert severity="info">No {activeKind === "tn" ? "notes" : "questions"} for this chapter.</Alert>
            ) : (
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
                  <Typography variant="overline" color="text.secondary">
                    {activeKind === "tn" ? "Translation note" : "Translation question"}
                  </Typography>
                  <Chip
                    size="small"
                    label={rowState}
                    color={stateChipColor(rowState)}
                    variant={rowState === "draft" ? "outlined" : "filled"}
                  />
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    {refFor(book, selectedRow)}
                  </Typography>
                </Stack>

                {supportRef && (
                  <Chip size="small" label={supportRef} sx={{ mb: 1.5 }} />
                )}

                {activeKind === "tn" && (selectedRow as TnRow).quote && (
                  <Typography
                    dir="rtl"
                    sx={{
                      fontFamily: '"Ezra SIL", "SBL Hebrew", serif',
                      fontSize: "1.3rem",
                      textAlign: "start",
                      bgcolor: "action.hover",
                      borderRadius: 1,
                      px: 1.5,
                      py: 1,
                      mb: 1.5,
                    }}
                  >
                    {(selectedRow as TnRow).quote}
                  </Typography>
                )}

                <Box
                  sx={{
                    bgcolor: "action.hover",
                    borderRadius: 1,
                    px: 1.5,
                    py: 1,
                    mb: 1.5,
                    whiteSpace: "pre-wrap",
                    fontSize: "0.9rem",
                  }}
                >
                  {sourceText || <Typography color="text.secondary">(no source text)</Typography>}
                </Box>

                <TextField
                  multiline
                  fullWidth
                  minRows={4}
                  label="Draft"
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
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
                  <Chip size="small" label="Trash" variant="outlined" disabled title="Not wired in this slice" />
                </Stack>

                {approveMessage && (
                  <Alert severity="warning" sx={{ mt: 1.5 }} onClose={() => setApproveMessage(null)}>
                    {approveMessage}
                  </Alert>
                )}

                <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
                  <Button
                    variant="outlined"
                    onClick={handleSave}
                    disabled={!hasDiff || saving}
                    sx={{ flex: 1 }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="contained"
                    color="success"
                    onClick={handleApprove}
                    disabled={approving}
                    sx={{ flex: 1 }}
                  >
                    {approving ? "Approving…" : "Approve"}
                  </Button>
                </Stack>
              </Box>
            )}
          </Box>

          {/* Verse context — desktop only */}
          {isDesktop && selectedRow && (
            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                p: 1.5,
                position: "sticky",
                top: 8,
                maxHeight: "70vh",
                overflowY: "auto",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                This verse
              </Typography>
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  ULT
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ bgcolor: "action.hover", borderRadius: 1, px: 1, py: 0.75, mb: 1.5 }}
                >
                  {ultText ?? <em>No ULT text loaded for this verse.</em>}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  UST
                </Typography>
                <Typography variant="body2" sx={{ bgcolor: "action.hover", borderRadius: 1, px: 1, py: 0.75 }}>
                  {ustText ?? <em>No UST text loaded for this verse.</em>}
                </Typography>
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
