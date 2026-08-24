// Queue-at-a-glance rail, after .queue-panel / .approve-all-row /
// .add-row-actions / .queue-list in docs/flows/ui/t2-review.html. Shown at
// tablet and desktop; the phone band replaces it with card-to-card nav.
//
// The rail owns no network calls — "Approve all" and "+ Note / + Question"
// report intent upward so the one component that owns the chapter data also
// owns the writes and their honest failure reporting.

import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Alert from "@mui/material/Alert";
import Typography from "@mui/material/Typography";
import type { TnRow, TqRow } from "../../sync/api";

export type ReviewRowState = "draft" | "edited" | "validated";

export interface ReviewRailItem {
  id: string;
  ref: string;
  secondary: string;
  state: ReviewRowState;
  trashed: boolean;
}

export interface ReviewRailProps {
  activeKind: "tn" | "tq";
  items: ReviewRailItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Unapproved counts for BOTH queues — the mockup labels both buttons. */
  unapprovedNotes: number;
  unapprovedQuestions: number;
  onApproveAll: (kind: "tn" | "tq") => void;
  /** Non-null while a sequential approve-all run is in flight. */
  approveProgress: { done: number; total: number } | null;
  /** Honest stop-on-first-failure message from the last run, if any. */
  approveError: string | null;
  onDismissApproveError: () => void;
  onAddRow: (kind: "tn" | "tq") => void;
  addDisabled: boolean;
  addDisabledReason?: string;
  addPending: boolean;
}

export function railItemsFromRows(
  kind: "tn" | "tq",
  rows: Array<TnRow | TqRow>,
  refFor: (row: TnRow | TqRow) => string,
): ReviewRailItem[] {
  return rows.map((row) => {
    const st = row.translation_state;
    return {
      id: row.id,
      ref: refFor(row),
      secondary:
        kind === "tn" ? ((row as TnRow).quote ?? "") : ((row as TqRow).question ?? ""),
      state: st === "validated" || st === "edited" ? st : "draft",
      trashed: kind === "tn" ? (row as TnRow).trashed_at != null : false,
    };
  });
}

export function ReviewRail({
  activeKind,
  items,
  selectedId,
  onSelect,
  unapprovedNotes,
  unapprovedQuestions,
  onApproveAll,
  approveProgress,
  approveError,
  onDismissApproveError,
  onAddRow,
  addDisabled,
  addDisabledReason,
  addPending,
}: ReviewRailProps) {
  const { t } = useTranslation();
  const unapproved = activeKind === "tn" ? unapprovedNotes : unapprovedQuestions;
  const approveLabel =
    activeKind === "tn"
      ? t("flowReview.rail.approveAllNotes", { n: unapprovedNotes })
      : t("flowReview.rail.approveAllQuestions", { n: unapprovedQuestions });
  const addLabel = activeKind === "tn" ? t("flowReview.rail.addNote") : t("flowReview.rail.addQuestion");

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
        position: "sticky",
        top: 8,
        maxHeight: "78vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ p: 1.5, borderBlockEnd: "1px solid", borderColor: "divider" }}>
        <Typography
          variant="caption"
          component="h2"
          color="text.secondary"
          sx={{
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            display: "block",
            mb: 1,
          }}
        >
          {t("common.approveAll")}
        </Typography>
        <Button
          fullWidth
          size="small"
          color="success"
          variant="outlined"
          onClick={() => onApproveAll(activeKind)}
          disabled={unapproved === 0 || approveProgress !== null}
          sx={{ justifyContent: "flex-start", textAlign: "start", minHeight: 44 }}
        >
          {approveLabel}
        </Button>
        {approveProgress && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t("flowReview.rail.approvingProgress", {
                done: approveProgress.done,
                total: approveProgress.total,
              })}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={
                approveProgress.total === 0
                  ? 0
                  : (approveProgress.done / approveProgress.total) * 100
              }
              sx={{ mt: 0.5 }}
            />
          </Box>
        )}
        {approveError && (
          <Alert severity="warning" sx={{ mt: 1 }} onClose={onDismissApproveError}>
            {approveError}
          </Alert>
        )}

        <Box sx={{ display: "flex", gap: 0.75, mt: 1 }}>
          <Button
            fullWidth
            size="small"
            variant="outlined"
            onClick={() => onAddRow(activeKind)}
            disabled={addDisabled || addPending}
            title={addDisabled ? addDisabledReason : undefined}
            sx={{ borderStyle: "dashed", minHeight: 44 }}
          >
            {addPending ? t("flowReview.rail.adding") : addLabel}
          </Button>
        </Box>
      </Box>

      <Box sx={{ overflowY: "auto" }}>
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "start" }}>
            {activeKind === "tn"
              ? t("flowReview.queue.noNotes")
              : t("flowReview.queue.noQuestions")}
          </Typography>
        ) : (
          items.map((item) => (
            <Box
              key={item.id}
              component="button"
              type="button"
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(item.id)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                width: "100%",
                textAlign: "start",
                border: "none",
                borderBlockEnd: "1px solid",
                borderColor: "divider",
                bgcolor: item.id === selectedId ? "action.selected" : "transparent",
                cursor: "pointer",
                p: 1,
                minHeight: 44,
                font: "inherit",
                color: "inherit",
                opacity: item.trashed ? 0.55 : 1,
              }}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{ width: 16, flex: "none", fontSize: "0.65rem", fontWeight: 700, color: "text.secondary" }}
              >
                {activeKind === "tn"
                  ? t("flowReview.rail.badgeNote")
                  : t("flowReview.rail.badgeQuestion")}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    fontWeight={600}
                    noWrap
                    sx={{ textDecoration: item.trashed ? "line-through" : "none", minWidth: 0 }}
                  >
                    {item.ref}
                  </Typography>
                  {item.trashed && (
                    <Box
                      component="span"
                      sx={{
                        flex: "none",
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                        border: "1px solid",
                        borderColor: "divider",
                        borderRadius: 0.5,
                        px: 0.5,
                        lineHeight: 1.6,
                      }}
                    >
                      {t("flowTranslate.status.trashed")}
                    </Box>
                  )}
                </Box>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {item.secondary}
                </Typography>
              </Box>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  bgcolor:
                    item.state === "validated"
                      ? "success.main"
                      : item.state === "edited"
                        ? "primary.main"
                        : "action.disabled",
                }}
              />
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
