// 409 version_mismatch merge prompt, after the #conflictBackdrop dialog in
// docs/flows/ui/t2-review.html.
//
// WHAT THE 409 ACTUALLY CARRIES. Every version_mismatch site in api/src/rows.ts
// (the tn no-op recheck, the reorder fast path, and the main content PATCH)
// answers `{ error: "version_mismatch", current: fresh }` where `fresh` is
// typed `.first<{ version: number; deleted_at: number | null }>()`. That is the
// whole contract: a version and a tombstone flag. There is NO note/response
// text and NO updated_at in it.
//
// So this dialog takes the "Theirs" CONTENT from a separate re-read of the row,
// not from the 409 body, and shows a loading state until that read lands. If
// the re-read fails there is simply nothing truthful to put in the column —
// the dialog says so and disables "Keep theirs" rather than showing an empty
// box that reads as "the other editor blanked it".
//
// The other editor is never named. Even the full row carries only `updated_by`
// (a numeric user id), no username — see
// docs/flows/05-functional-preview-findings.md §4.7, where the mockup filled
// that gap with a fabricated colleague. That was the worst honesty defect the
// preview drive found.
//
// NOT ONLY NOTE TEXT. A row 409 can come from any patch the queue enqueues —
// note/response text, but also {quote, occurrence}, {verse, ref_raw}, and
// {sort_order}. The dialog therefore renders whatever fields the op actually
// patched (`fields`), and only uses the big two-column text compare when the
// note/response text is the single conflicted field (`textual`). Framing a
// quote swap as "your note text vs theirs" would show an empty "Mine" against
// the server's full note — a fabricated comparison.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

/** One field the conflicting op patched, with both sides' values. */
export interface ConflictFieldView {
  /** Raw patch key, e.g. "quote", "sort_order". */
  field: string;
  /** Human label, already localized by the owner, e.g. "Quote". */
  label: string;
  /**
   * The same label in the sentence-inline form ("quote"). Supplied rather than
   * lower-cased here: casing a translated string is not a portable operation.
   */
  labelLower: string;
  /** What this browser tried to save, rendered as text. */
  mine: string;
  /**
   * The server's current value, from a RE-READ of the row. Null while that
   * read is in flight or if it failed — never sourced from the 409 body,
   * which carries no content.
   */
  theirs: string | null;
}

export interface ReviewConflictDialogProps {
  open: boolean;
  kind: "tn" | "tq";
  /** Exactly the fields the conflicting op patched — never a fixed guess. */
  fields: ConflictFieldView[];
  /** True only when the sole patched field is the row's note/response text. */
  textual: boolean;
  /** True once the re-read row landed, so the "theirs" values are real. */
  theirsLoaded: boolean;
  /** Version being merged against — the 409's, or the re-read's if newer. */
  theirsVersion: number | null;
  /** From the re-read row's `updated_at`. Null omits the age clause. */
  theirsUpdatedAt: number | null;
  loadingTheirs: boolean;
  /** Honest reason the other version can't be shown; disables "Keep theirs". */
  theirsError: string | null;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  onClose: () => void;
}

// ", 2 min ago" from unix seconds; "" when absent or implausible, so the
// heading degrades to a bare "Theirs (v6)" rather than showing a lie.
function agoSuffix(t: TFunction, updatedAt: number | null): string {
  if (updatedAt == null || !Number.isFinite(updatedAt)) return "";
  const secs = Math.floor(Date.now() / 1000) - updatedAt;
  if (secs < 0) return "";
  if (secs < 60) return t("flowReview.conflict.agoJustNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("flowReview.conflict.agoMinutes", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("flowReview.conflict.agoHours", { count: hrs });
  const days = Math.floor(hrs / 24);
  return t("flowReview.conflict.agoDays", { count: days });
}

// "quote", "quote and occurrence", "verse, reference and order" — used only to
// name what actually conflicted, never to characterise the change itself.
function joinLabels(t: TFunction, labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return t("flowReview.common.listAnd", {
    list: labels.slice(0, -1).join(t("flowReview.common.listSeparator")),
    last: labels[labels.length - 1],
  });
}

function ColumnShell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: 1,
        p: 1.25,
        fontSize: "0.85rem",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        textAlign: "start",
      }}
    >
      <Typography
        variant="caption"
        component="h3"
        color="text.secondary"
        sx={{
          display: "block",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          mb: 0.75,
        }}
      >
        {heading}
      </Typography>
      {children}
    </Box>
  );
}

export function ReviewConflictDialog({
  open,
  kind,
  fields,
  textual,
  theirsLoaded,
  theirsVersion,
  theirsUpdatedAt,
  loadingTheirs,
  theirsError,
  onKeepMine,
  onKeepTheirs,
  onClose,
}: ReviewConflictDialogProps) {
  const { t } = useTranslation();
  const theirsMeta =
    theirsVersion == null
      ? null
      : `v${theirsVersion}${agoSuffix(t, theirsUpdatedAt)}`;
  const theirsHeading =
    theirsMeta == null
      ? t("flowReview.conflict.theirs")
      : t("flowReview.conflict.theirsWithMeta", { meta: theirsMeta });

  const canKeepTheirs = !loadingTheirs && theirsError == null && theirsLoaded;
  const keepTheirsReason = loadingTheirs
    ? t("flowReview.conflict.stillLoadingTheirs")
    : !canKeepTheirs
      ? t("flowReview.conflict.theirsUnreadable")
      : "";

  const title = textual
    ? kind === "tn"
      ? t("flowReview.conflict.titleNote")
      : t("flowReview.conflict.titleQuestion")
    : fields.length > 0
      ? t("flowReview.conflict.titleFields", {
          fields: joinLabels(
            t,
            fields.map((f) => f.labelLower),
          ),
        })
      : t("flowReview.conflict.titleRow");

  // Rendered inside a ColumnShell: real text, an explicit "(empty)", or the
  // honest reason there is nothing to show. Never a blank box.
  function theirsBody(value: string | null): ReactNode {
    if (loadingTheirs) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="caption" color="text.secondary">
            {t("flowReview.conflict.loadingTheirs")}
          </Typography>
        </Box>
      );
    }
    if (theirsError != null) {
      return (
        <Typography variant="caption" color="text.secondary">
          {theirsError}
        </Typography>
      );
    }
    if (value == null) {
      return (
        <Typography variant="caption" color="text.secondary">
          {t("flowReview.conflict.theirsUnavailable")}
        </Typography>
      );
    }
    return value === "" ? <Box component="em">{t("flowReview.conflict.empty")}</Box> : value;
  }

  const twoColumn = {
    display: "grid",
    gap: 1.25,
    gridTemplateColumns: { xs: "1fr", tablet: "1fr 1fr" },
  } as const;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, textAlign: "start" }}>
          {textual
            ? t("flowReview.conflict.bodyTextual")
            : t("flowReview.conflict.bodyFields")}
        </Typography>
        {textual ? (
          <Box sx={twoColumn}>
            <ColumnShell heading={t("flowReview.conflict.mine")}>
              {fields[0]?.mine || <Box component="em">{t("flowReview.conflict.empty")}</Box>}
            </ColumnShell>
            <ColumnShell heading={theirsHeading}>
              {theirsBody(fields[0]?.theirs ?? null)}
            </ColumnShell>
          </Box>
        ) : fields.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            {t("flowReview.conflict.unidentified")}
          </Typography>
        ) : (
          <Box sx={{ display: "grid", gap: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: "start" }}>
              {t("flowReview.conflict.theirVersionLine", {
                meta: theirsMeta ?? t("flowReview.conflict.unknownVersion"),
              })}
            </Typography>
            {fields.map((f) => (
              <Box key={f.field}>
                <Typography
                  variant="caption"
                  component="h3"
                  sx={{ display: "block", fontWeight: 700, mb: 0.5, textAlign: "start" }}
                >
                  {f.label}
                </Typography>
                <Box sx={twoColumn}>
                  <ColumnShell heading={t("flowReview.conflict.mine")}>
                    {f.mine || <Box component="em">{t("flowReview.conflict.empty")}</Box>}
                  </ColumnShell>
                  <ColumnShell heading={t("flowReview.conflict.theirs")}>
                    {theirsBody(f.theirs)}
                  </ColumnShell>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Tooltip title={keepTheirsReason}>
          <span>
            <Button
              variant="outlined"
              onClick={onKeepTheirs}
              disabled={!canKeepTheirs}
              sx={{ minHeight: 44 }}
            >
              {textual
                ? t("flowReview.conflict.keepTheirs")
                : t("flowReview.conflict.discardMine")}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={theirsVersion == null ? t("flowReview.conflict.noServerVersion") : ""}
        >
          <span>
            <Button
              variant="contained"
              color="success"
              onClick={onKeepMine}
              disabled={theirsVersion == null}
              sx={{ minHeight: 44 }}
            >
              {t("flowReview.conflict.keepMine")}
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}
