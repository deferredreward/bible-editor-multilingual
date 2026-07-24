// The TopBar's single merged "Status" indicator (top-bar redesign, Option
// 1b). Replaces four separate inline chips — SyncStatusBar, PipelineStatusBar,
// BookLintIndicator, VersionIndicator — with one Chip that opens a Popover
// listing all four. The transient toasts/floating panels those components
// own stay alive exactly as before (see the always-mounted, hidden-trigger
// instances rendered by TopBar alongside this component); only their inline
// chips collapse into this one indicator. See docs bundle
// design_handoff_topbar/README.md for the full spec.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Chip, Divider, Popover, Tooltip, Typography } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import EditNoteIcon from "@mui/icons-material/EditNote";
import RefreshIcon from "@mui/icons-material/Refresh";
import { SyncStatusBar, useSyncSummary } from "./SyncStatusBar";
import { PipelineStatusBar, pipelineHasAnything } from "./PipelineStatusBar";
import { BookLintIndicator } from "./BookLintIndicator";
import { useAppVersion } from "../hooks/useAppVersion";
import { pipelineStore } from "../sync/pipelineStore";
import type { PipelineJobRow, BookLintIssue } from "../sync/api";

// Kindle warning accent, matching the other "needs attention" affordances
// (BookLintIndicator, VersionIndicator's update nudge).
const attentionDotSx = {
  position: "absolute" as const,
  top: 2,
  right: 2,
  width: 7,
  height: 7,
  borderRadius: "50%",
  bgcolor: "#E59D33",
  border: "1.5px solid",
  borderColor: "background.paper",
};

interface Props {
  book: string;
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  onGoToIssue: (issue: BookLintIssue) => void;
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  onRequestReload?: () => void;
}

function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function StatusIndicator({
  book,
  flagIssues,
  flagCount,
  escalateCount,
  onGoToIssue,
  onNavigate,
  onRequestReload,
}: Props) {
  const { t } = useTranslation();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const { pending, conflicts, failed, effectivelyOffline, draftCount } = useSyncSummary();
  const { current, updateAvailable } = useAppVersion();

  // Light read of the shared pipeline job list purely to pick the outer
  // chip's attention dot and the popover's idle-state fallback text —
  // PipelineStatusBar (embedded below) owns the actual interactive detail.
  // `pipelineHasAnything` is PipelineStatusBar's own render gate, imported so
  // this component's "No AI pipelines running" idle text can't disagree with
  // whether the embedded bar actually shows something.
  const [jobs, setJobs] = useState<PipelineJobRow[]>([]);
  useEffect(() => pipelineStore.subscribe(setJobs), []);
  // "Idle" (drives the plain "No AI pipelines running" line) means the
  // embedded bar would render nothing at all — including a recently-done run.
  const pipelineIdle = !pipelineHasAnything(jobs);
  // The amber attention dot is narrower: only in-flight or failed runs warrant
  // it. A merely recently-*done* job is surfaced (the popover shows it) but
  // isn't "needs attention" — so exclude `done` here even though it counts
  // toward `!pipelineIdle`.
  const pipelineNeedsAttention = jobs.some(
    (j) =>
      j.state === "running" ||
      j.state === "dispatching" ||
      j.state === "queued" ||
      j.state === "paused_for_outage" ||
      j.state === "paused_for_usage_limit" ||
      j.state === "failed",
  );

  const needsAttention = flagCount > 0 || draftCount > 0 || pipelineNeedsAttention || updateAvailable;

  let icon = <CloudDoneIcon sx={{ fontSize: 17 }} />;
  let label = t("topbar.status.savedLabel");
  let colorSx: Record<string, unknown> = { color: "#3F9CA0", borderColor: "#70C9CC" };
  if (conflicts.length > 0) {
    icon = <WarningAmberIcon sx={{ fontSize: 17 }} />;
    label = t("topbar.status.conflictsLabel", { count: conflicts.length });
    colorSx = { color: "warning.main", borderColor: "warning.main" };
  } else if (failed.length > 0) {
    icon = <ErrorOutlineIcon sx={{ fontSize: 17 }} />;
    label = t("topbar.status.failedLabel", { count: failed.length });
    colorSx = { color: "error.main", borderColor: "error.main" };
  } else if (effectivelyOffline) {
    icon = <CloudQueueIcon sx={{ fontSize: 17 }} />;
    label = t("topbar.status.offlineLabel");
    colorSx = { color: "#E59D33", borderColor: "#E59D33" };
  } else if (pending > 0) {
    icon = <CloudQueueIcon sx={{ fontSize: 17 }} />;
    label = t("topbar.status.savingLabel", { count: pending });
    colorSx = { color: "primary.main", borderColor: "primary.main" };
  } else if (draftCount > 0) {
    // Unsaved local typing (stashed in IndexedDB but not yet Saved). Mirrors
    // the old inline SyncStatusBar's amber "N unsaved" chip — without this the
    // merged indicator reads a misleading green "Saved" while edits are still
    // pending a Save click.
    icon = <EditNoteIcon sx={{ fontSize: 17 }} />;
    label = `${draftCount} ${t("sync.unsaved")}`;
    colorSx = { color: "#E59D33", borderColor: "#E59D33" };
  }

  return (
    <>
      <Box sx={{ position: "relative", display: "inline-flex" }}>
        <Chip
          icon={icon}
          label={label}
          size="small"
          variant="outlined"
          clickable
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{ ...colorSx, "& .MuiChip-icon": { color: "inherit" } }}
        />
        {needsAttention && <Box sx={attentionDotSx} />}
      </Box>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        <Typography
          variant="caption"
          sx={{
            display: "block",
            px: 1.75,
            pt: 1,
            pb: 0.5,
            fontWeight: 700,
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            color: "text.disabled",
          }}
        >
          {t("topbar.status.title")}
        </Typography>

        {/* Save state — a plain sentence in the common "all clear" case, the
            real interactive chip(s) when something needs a decision or there
            are unsaved drafts (draftCount>0 routes here so the embedded bar
            shows its clickable "N unsaved" jump chip). */}
        {conflicts.length === 0 &&
        failed.length === 0 &&
        !effectivelyOffline &&
        pending === 0 &&
        draftCount === 0 ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 1.75, py: 1 }}>
            <CloudDoneIcon sx={{ fontSize: 18, color: "#3F9CA0" }} />
            <Typography variant="body2">{t("topbar.status.allSaved")}</Typography>
          </Box>
        ) : (
          <Box sx={{ px: 1.75, py: 1 }}>
            <SyncStatusBar onNavigate={onNavigate} hideFloating />
          </Box>
        )}

        {/* AI pipelines — same pattern: plain sentence when idle, the real
            interactive chip + job list when there's something to show. */}
        {pipelineIdle ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 1.75, py: 1 }}>
            <AutoAwesomeIcon sx={{ fontSize: 18, color: "text.disabled" }} />
            <Typography variant="body2" color="text.secondary">
              {t("topbar.status.noPipelines")}
            </Typography>
          </Box>
        ) : (
          <Box sx={{ px: 1.75, py: 1 }}>
            <PipelineStatusBar />
          </Box>
        )}

        {/* Lint — silent when the book is clean, matching BookLintIndicator's
            own "nothing to clean up, stay out of the way" behavior. */}
        {flagCount > 0 && (
          <BookLintIndicator
            variant="row"
            book={book}
            flagIssues={flagIssues}
            flagCount={flagCount}
            escalateCount={escalateCount}
            onGoToIssue={onGoToIssue}
          />
        )}

        <Divider />
        {updateAvailable ? (
          <Tooltip title={t("sync.updateAvailableTooltip")}>
            <Box
              component="button"
              onClick={() => (onRequestReload ? onRequestReload() : window.location.reload())}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                width: "100%",
                border: "none",
                background: "transparent",
                textAlign: "left",
                cursor: "pointer",
                font: "inherit",
                color: "#E59D33",
                px: 1.75,
                py: 0.75,
              }}
            >
              <RefreshIcon sx={{ fontSize: 16 }} />
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {t("sync.updateAvailable")}
              </Typography>
            </Box>
          </Tooltip>
        ) : (
          current.commit !== "unknown" && (
            <Typography
              variant="caption"
              sx={{
                display: "block",
                px: 1.75,
                py: 0.75,
                fontFamily: "monospace",
                fontSize: 11,
                color: "text.disabled",
              }}
              title={formatBuiltAt(current.builtAt)}
            >
              {t("topbar.status.buildUpToDate", { commit: current.commit })}
            </Typography>
          )
        )}
      </Popover>
    </>
  );
}
