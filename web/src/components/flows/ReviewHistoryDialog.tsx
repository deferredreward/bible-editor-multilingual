// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Kind-aware row history for the review queue, after the #histBackdrop dialog
// in docs/flows/ui/t2-review.html.
//
// Why not reuse NoteHistoryDialog.tsx: that component hard-codes
// `api.getRowHistory("tn", …)` (NoteHistoryDialog.tsx:89) and its restore path
// speaks the note card's snapshot shape. The review queue runs both tn and tq
// through the same card, so it needs the kind threaded through. Everything
// else — the endpoint, the RowHistoryEntry shape, the "hide revert phantoms"
// rule — is the same contract.

import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { api, ApiError, type RowHistoryEntry } from "../../sync/api";

export interface ReviewHistoryDialogProps {
  open: boolean;
  kind: "tn" | "tq";
  rowId: string;
  book: string;
  /** The row's live version — the If-Match expectation for a restore. */
  currentVersion: number;
  /** tn only: the row is in the visible trash and can be restored. */
  trashed: boolean;
  onClose: () => void;
  /** Restore the row out of the trash (tn only). */
  onRestoreFromTrash?: () => void;
  /**
   * Re-apply an older version's text. Only the edited field travels
   * (`note` for tn, `response` for tq) — the dialog says so rather than
   * implying a whole-row revert.
   */
  onUseVersion: (text: string, fromVersion: number) => void;
}

const fmtTime = (epochSec: number) => new Date(epochSec * 1000).toLocaleString();

function userLabel(e: RowHistoryEntry): string {
  if (!e.user) return "system";
  return e.user.full_name || e.user.username || `user #${e.user.id}`;
}

export function ReviewHistoryDialog({
  open,
  kind,
  rowId,
  book,
  currentVersion,
  trashed,
  onClose,
  onRestoreFromTrash,
  onUseVersion,
}: ReviewHistoryDialogProps) {
  const [entries, setEntries] = useState<RowHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    api
      .getRowHistory(kind, rowId, book)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Could not load history (${e instanceof ApiError ? e.status : "error"}).`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, rowId, book]);

  const field = kind === "tn" ? "note" : "response";
  // Revert phantoms carry a snapshot identical to the version they restored —
  // the server marks them so the list doesn't show the same text twice.
  const shown = (entries ?? []).filter((e) => e.restored_from_version == null);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{kind === "tn" ? "Note history" : "Question history"}</DialogTitle>
      <DialogContent dividers>
        {trashed && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              onRestoreFromTrash ? (
                <Button size="small" onClick={onRestoreFromTrash}>
                  Restore
                </Button>
              ) : undefined
            }
          >
            This note is in the trash.
          </Alert>
        )}
        {error && <Alert severity="warning">{error}</Alert>}
        {!error && entries === null && (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {entries !== null && shown.length === 0 && !error && (
          <Typography variant="body2" color="text.secondary">
            No recorded versions for this row.
          </Typography>
        )}
        {shown
          .slice()
          .reverse()
          .map((e) => {
            const snapshotText = e.snapshot[field];
            const restorable =
              e.version !== currentVersion && typeof snapshotText === "string";
            return (
              <Box
                key={e.version}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 1,
                  borderBlockEnd: "1px solid",
                  borderColor: "divider",
                  textAlign: "start",
                }}
              >
                <Typography variant="body2" fontWeight={700} sx={{ width: 40, flex: "none" }}>
                  v{e.version}
                </Typography>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">{e.action}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {userLabel(e)} · {fmtTime(e.created_at)}
                  </Typography>
                </Box>
                {restorable && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ flex: "none", minHeight: 44 }}
                    onClick={() => onUseVersion(snapshotText as string, e.version)}
                  >
                    Switch to v{e.version}
                  </Button>
                )}
              </Box>
            );
          })}
        {shown.length > 0 && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
            Switching restores this version&apos;s {field} text only — quote, support
            reference and flags stay as they are now.
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
