import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  type LanePublicState,
  type LaneReplacementJobResponse,
  type LaneReplacementBook,
} from "../sync/api";
import { refreshProjectConfig } from "../hooks/useProjectConfig";

// Known lane error codes (mirrors PreferencesWorkspace's LaneCard). Codes may
// carry a `:detail` suffix (e.g. lane_busy:sim); split tolerates that.
const LANE_ERROR_CODES = new Set([
  "replacement_already_active",
  "lane_lease_held",
  "confirmation_required",
  "lane_replacement_required",
  "job_not_found",
  "job_not_ready",
  "export_lease_held",
  "export_lease_grace",
  "activation_cas_failed",
]);

function laneErrorMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  raw: string,
): string {
  const sep = raw.indexOf(":");
  const code = sep === -1 ? raw : raw.slice(0, sep);
  const book = sep === -1 ? undefined : raw.slice(sep + 1);
  if (LANE_ERROR_CODES.has(code)) {
    return t(`preferences.scriptureLanes.errors.${code}`, book !== undefined ? { book } : undefined);
  }
  return raw;
}

function rawError(e: unknown): string {
  return e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
}

// Step 4b — "Finish replacing a lane's text". Extracted from LaneCard's job
// driver so the wizard and Preferences share one implementation. For a
// quarantined lane it stages the pendingTarget source (laneStartReplacement),
// polls per-book progress, offers retry/waive per book, and — once ready —
// exposes an EXPLICIT Activate. Never auto-activates (owner decision): nothing
// changes for editors until Activate is pressed.
export function LaneReplacementDriver({
  lane,
  label,
  laneState,
}: {
  lane: "lit" | "sim";
  label: string;
  laneState: LanePublicState;
}) {
  const { t } = useTranslation();
  const [starting, setStarting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [busyBook, setBusyBook] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<LaneReplacementJobResponse | null>(null);

  const replacementJobId = laneState.replacementJobId ?? null;
  const pendingTarget = laneState.pendingTarget;

  // Poll the job while one runs so per-book staging + readiness stay live.
  // Stops on a terminal status and refreshes the shared config (which clears
  // replacementJobId, so the poll won't re-arm).
  useEffect(() => {
    if (!replacementJobId) {
      setJob(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await api.laneGetJob(lane, replacementJobId);
        if (cancelled) return;
        setJob(res);
        const s = res.job.status;
        if (s === "completed" || s === "cancelled" || s === "failed") {
          await refreshProjectConfig().catch(() => {});
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lane, replacementJobId]);

  const handleStart = async () => {
    if (!pendingTarget) return;
    setStarting(true);
    setError(null);
    try {
      // The mandatory pending target carries the correct source/export/locks for
      // the new generation — stage exactly it (confirm:true).
      await api.laneStartReplacement(lane, pendingTarget, true);
      await refreshProjectConfig().catch(() => {});
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setStarting(false);
    }
  };

  const handleActivate = async () => {
    if (!replacementJobId) return;
    setActivating(true);
    setError(null);
    try {
      // A fresh fencing UUID per activation guards against a split-brain export
      // completing a stale render after the flip.
      await api.laneActivate(lane, replacementJobId, crypto.randomUUID());
      await refreshProjectConfig().catch(() => {});
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setActivating(false);
    }
  };

  const handleRetryBook = async (book: string) => {
    if (!replacementJobId) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneRetryBook(lane, replacementJobId, book);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setBusyBook(null);
    }
  };

  const handleWaiveBook = async (book: string) => {
    if (!replacementJobId) return;
    if (!window.confirm(t("preferences.scriptureLanes.confirmWaiveBook", { book }))) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneWaiveBook(lane, replacementJobId, book, true);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setBusyBook(null);
    }
  };

  const jobStatus = job?.job.status;
  const jobBooks: LaneReplacementBook[] = job?.books ?? [];
  const pendingBooks = jobBooks.filter(
    (b) => b.status !== "artifact_ok" && b.status !== "absent_authorized",
  );

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {label}
          </Typography>
          {pendingTarget && (
            <Chip size="small" label={`${pendingTarget.source.owner}/${pendingTarget.source.repo}`} />
          )}
        </Stack>

        <Typography variant="body2" color="text.secondary">
          {t("setup.replacementIntro")}
        </Typography>

        {!replacementJobId && (
          <Box>
            <Button variant="contained" onClick={handleStart} disabled={starting || !pendingTarget}>
              {starting ? <CircularProgress size={16} color="inherit" /> : t("setup.replacementStart")}
            </Button>
          </Box>
        )}

        {replacementJobId && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              {jobStatus !== "ready" && <CircularProgress size={16} />}
              <Typography variant="body2">
                {jobStatus
                  ? t(`preferences.scriptureLanes.jobStatus.${jobStatus}`)
                  : t("preferences.scriptureLanes.jobRunning")}
              </Typography>
              {jobStatus === "ready" && (
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleActivate}
                  disabled={activating}
                >
                  {activating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.activate")}
                </Button>
              )}
            </Stack>

            {jobBooks.length > 0 && (
              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  {t("preferences.scriptureLanes.booksProgress", {
                    done: jobBooks.length - pendingBooks.length,
                    total: jobBooks.length,
                  })}
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {jobBooks.map((b) => {
                    const retryable = b.status === "retryable_error" || b.status === "failed";
                    const color =
                      b.status === "artifact_ok"
                        ? "success"
                        : retryable
                          ? "error"
                          : b.status === "absent_authorized"
                            ? "default"
                            : "warning";
                    return (
                      <Tooltip
                        key={b.book}
                        title={
                          retryable
                            ? t("preferences.scriptureLanes.bookRetryHint", { book: b.book })
                            : `${b.book}: ${b.status}`
                        }
                      >
                        <Chip
                          size="small"
                          color={color}
                          variant={b.status === "artifact_ok" ? "filled" : "outlined"}
                          label={busyBook === b.book ? `${b.book}…` : b.book}
                          onClick={retryable && busyBook !== b.book ? () => void handleRetryBook(b.book) : undefined}
                          onDelete={retryable && busyBook !== b.book ? () => void handleWaiveBook(b.book) : undefined}
                        />
                      </Tooltip>
                    );
                  })}
                </Box>
              </Stack>
            )}
          </Stack>
        )}

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
