// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// l1-ai: Lead — run AI pipelines. Port of docs/flows/ui/l1-ai.html. The menu,
// confirm dialog, and 409 "already running" dialog are NOT re-implemented here
// — they're the real, already-tested PipelineMenu (web/src/components/
// PipelineMenu.tsx), which already does mode-gating (isTranslationProject),
// models "Translate questions" as pipelineType "translate" +
// translate.resourceType:"tq" (the real backend shape — see
// docs/flows/05-functional-preview-findings.md §2.13), and shows the real 409
// conflict dialog from the server's `existing` payload.
//
// This file supplies what the mockup's menu doesn't: the book/chapter picker,
// the chapter-locked / drafts-ready banners, the "AI not configured" calm
// state (detected the same side-effect-free way the mockup does — a GET
// against a bogus jobId; GET /api/pipelines/:jobId is gated by BT_API_TOKEN,
// GET /api/pipelines the list is NOT — §2.17), and the two run tables driven
// live off pipelineStore.

import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { LockBanner, ReadyBanner } from "./FlowBanners";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { PipelineMenu } from "../PipelineMenu";
import { pipelineStore, type PipelineJob } from "../../sync/pipelineStore";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import {
  api,
  ApiError,
  type BookListEntry,
  type PipelineErrorKind,
  type PipelineState,
  type PipelineType,
} from "../../sync/api";

export interface AiScreenProps extends FlowScreenContext {}

const DEFAULT_BOOK = "OBA";
const DEFAULT_CHAPTER = 1;

// Real backend enum (api/src/pipelines.ts PIPELINE_TYPES). PipelineJobRow
// carries no resourceType field, so a "translate" job that was actually a tQ
// translate can't be told apart from a tN one here — both get this one
// generic label, matching PipelineStatusBar.tsx's TYPE_LABEL (same
// limitation, same choice, not new).
const TYPE_LABEL: Record<PipelineType, string> = {
  generate: "Generate ULT + UST",
  notes: "Write translation notes",
  tqs: "Write translation questions",
  translate: "Translate chapter",
};

// Friendly PipelineErrorKind copy — mirrors docs/flows/ui/l1-ai.html's
// ERROR_COPY verbatim (same enum, same intent: no bare enum string in front
// of a translator).
const ERROR_COPY: Record<PipelineErrorKind, string> = {
  transient_outage:
    "The AI service had a temporary outage. It should recover on its own — try again in a few minutes.",
  auth_error: "The AI service rejected our credentials. An admin needs to check the BT_API_TOKEN.",
  usage_limit: "This workspace hit its daily AI usage limit. The run will resume automatically tomorrow.",
  sdk_error: "Something went wrong talking to the AI service. Retrying usually fixes this.",
  non_success_result: "The AI service finished but reported a failure. Retry, or check with an admin if it keeps happening.",
  missing_output: "The AI service didn't return any content for this chapter. Retry — if it keeps happening, this chapter may need attention.",
  stale_output: "The AI's draft was based on an older version of this chapter and was rejected to avoid overwriting newer edits. Retry to draft against the current text.",
  interrupted: "This run was interrupted before it finished — likely the server restarted mid-job. Nothing was lost; retry to pick it back up.",
  import_failed: "The finished draft couldn't be imported into the chapter. An admin may need to look at the import log.",
};

function scopeOf(job: PipelineJob): string {
  if (!job.book) return TYPE_LABEL[job.pipeline_type] ?? job.pipeline_type; // article (tw/ta) jobs carry no book/chapter
  return job.start_chapter === job.end_chapter
    ? `${job.book} ${job.start_chapter}`
    : `${job.book} ${job.start_chapter}–${job.end_chapter}`;
}

function timeAgo(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  const deltaMs = Date.now() - unixSeconds * 1000;
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} day(s) ago`;
}

function stateChipKind(state: PipelineState): "ok" | "warn" | "skip" {
  if (state === "done") return "ok";
  if (state === "failed") return "warn";
  return "skip"; // queued / dispatching / running / paused_* / cancelled
}

function progressText(job: PipelineJob): string {
  if (job.state === "queued") {
    return job.queue_position != null ? `#${job.queue_position} in line` : "queued";
  }
  return job.current_status || job.current_skill || job.state;
}

export default function AiScreen({ role, me, onNavigate }: AiScreenProps) {
  const theme = useTheme();
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560: table rather than stacked cards

  const book = me?.lastBook || DEFAULT_BOOK;
  const chapter = me?.lastChapter || DEFAULT_CHAPTER;
  const verse = me?.lastVerse || 1;

  const cfg = useProjectConfig();
  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : "Workspace";

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState(false);
  const [pickedBook, setPickedBook] = useState<string>("");
  const [chapterInput, setChapterInput] = useState(String(chapter));
  const pickedChapter = Math.max(1, parseInt(chapterInput, 10) || 1);

  const [jobs, setJobs] = useState<PipelineJob[]>([]);
  const [jobsUnavailable, setJobsUnavailable] = useState(false);
  const [aiDisabled, setAiDisabled] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  // Real book list — GET /api/books returns only books actually imported into
  // this workspace. Defaults to the user's last book once loaded, if it's one
  // of the imported ones; otherwise the first imported book.
  useEffect(() => {
    let cancelled = false;
    api
      .getBooks()
      .then((res) => {
        if (cancelled) return;
        setBooks(res.books);
        setPickedBook((prev) => {
          if (prev) return prev;
          if (res.books.some((b) => b.book === book)) return book;
          return res.books[0]?.book ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) setBooksError(true);
      });
    return () => {
      cancelled = true;
    };
    // book is only used as a one-time default seed, not a live dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pipelines are gated `requireEditor` server-side — a viewer gets a 403.
  // Treat that as "not visible for your role", not an error, and skip the
  // rest of the AI machinery for that role.
  useEffect(() => {
    if (role === "viewer") {
      setJobsUnavailable(true);
      return;
    }
    setJobsUnavailable(false);
    return pipelineStore.subscribe(setJobs);
  }, [role]);

  // Real, side-effect-free detection of the "AI not configured" state: GET
  // /api/pipelines/:jobId is gated by the same BT_API_TOKEN check as start —
  // a bogus id is safe to probe because the route is read-only and 503s
  // before any existence check (verified live, see 05-functional-preview-
  // findings.md §2.17). GET /api/pipelines (the list above) is NOT gated, so
  // the runs table keeps working either way.
  useEffect(() => {
    if (role === "viewer") return;
    let cancelled = false;
    api
      .pipelineStatus("__availability_probe__")
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          const body = err.body as { error?: string } | undefined;
          if (body?.error === "pipeline_api_disabled") setAiDisabled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Drafts-ready banner for the currently-picked scope.
  useEffect(() => {
    if (!pickedBook || role === "viewer") {
      setPendingCount(0);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getPendingImports(pickedBook, pickedChapter, controller.signal)
        .then((res) => {
          if (!cancelled) setPendingCount(res.items.length);
        })
        .catch(() => {
          if (!cancelled) setPendingCount(0);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pickedBook, pickedChapter, role]);

  // Chapter-locked banner for the currently-picked scope: a running/
  // dispatching job whose range covers it.
  const lockingJob = useMemo(
    () =>
      jobs.find(
        (j) =>
          j.book === pickedBook &&
          pickedChapter >= j.start_chapter &&
          pickedChapter <= j.end_chapter &&
          (j.state === "running" || j.state === "dispatching"),
      ) ?? null,
    [jobs, pickedBook, pickedChapter],
  );

  const failedCount = jobs.filter((j) => j.state === "failed").length;
  const dismissableJobs = jobs.filter(
    (j) => j.state === "done" || j.state === "failed" || j.state === "cancelled",
  );

  async function handleRetry(job: PipelineJob) {
    if (aiDisabled || retrying) return;
    setRetrying(job.job_id);
    const sessionKey = `retry-${job.pipeline_type}-${Date.now()}`;
    try {
      await pipelineStore.start({
        pipelineType: job.pipeline_type,
        ...(job.book ? { book: job.book, startChapter: job.start_chapter, endChapter: job.end_chapter } : {}),
        sessionKey,
      });
      setNotice(`Retry queued for ${scopeOf(job)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setAiDisabled(true);
        setNotice("AI not configured — retry unavailable");
      } else if (e instanceof ApiError && e.status === 409) {
        setNotice("Already running or queued elsewhere");
      } else {
        setNotice("Could not retry — try again");
      }
    } finally {
      setRetrying(null);
    }
  }

  async function handleCancel(job: PipelineJob) {
    if (cancelling) return; // no double-submit while a cancel is in flight
    setCancelling(job.job_id);
    try {
      const res = await pipelineStore.cancel(job.job_id);
      if (!res.ok) setNotice("Couldn't cancel — it already started running.");
    } catch {
      // pipelineStore.cancel only handles 409 itself; 403/404/5xx/network
      // rethrow and must not become an unhandled rejection with a silent no-op.
      setNotice("Couldn't cancel — try again");
    } finally {
      setCancelling(null);
    }
  }

  function handleDismiss(job: PipelineJob) {
    pipelineStore.dismiss(job.job_id);
  }

  async function handleRefresh() {
    await pipelineStore.reload();
  }

  function handleDismissAll() {
    if (dismissableJobs.length === 0) return;
    pipelineStore.dismissResolved();
  }

  if (role === "viewer") {
    return (
      <AdminDesk current="ai">
        <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
          <AdminPageHeader eyebrow={eyebrow} title="AI studio" />
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            AI pipeline status isn't visible for your role.
          </Typography>
        </Box>
      </AdminDesk>
    );
  }

  return (
    <AdminDesk current="ai">
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
        <AdminPageHeader
          eyebrow={eyebrow}
          title="AI studio"
          subtitle="Bulk-draft a chapter's ULT/UST, translation notes, or translation questions. A run locks the chapter for editing while it's in progress."
        />

      <Stack spacing={1} sx={{ mb: 2 }}>
        {aiDisabled && (
          <Alert severity="info" icon={<AutoAwesomeIcon fontSize="small" />}>
            <Typography sx={{ fontWeight: 700, fontSize: "0.9rem" }}>AI not configured</Typography>
            <Typography variant="body2" sx={{ mt: 0.25 }}>
              An admin needs to set <code>BT_API_TOKEN</code> for this workspace before AI pipelines
              can run. This isn't an error — the feature is simply off until then. Job status reads
              (Details/Retry below) are disabled too, so those actions are turned off rather than
              left to fail on click.
            </Typography>
          </Alert>
        )}
        {lockingJob && (
          <LockBanner
            pipelineType={lockingJob.pipeline_type}
            startedAt={lockingJob.created_at}
          />
        )}
        {pendingCount > 0 && (
          <ReadyBanner count={pendingCount} onReview={() => onNavigate(pickedBook, pickedChapter, verse)} />
        )}
        {jobsUnavailable && (
          <Typography variant="caption" color="text.secondary">
            AI run status isn't visible for your role.
          </Typography>
        )}
      </Stack>

      <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" sx={{ mb: 2.5 }}>
        <Box sx={{ minWidth: 140 }}>
          <Typography variant="caption" component="label" htmlFor="ai-pick-book" sx={{ display: "block", mb: 0.5, color: "text.secondary" }}>
            Book
          </Typography>
          {books === null && !booksError ? (
            <Skeleton variant="rounded" width={140} height={40} />
          ) : (
            <Select
              id="ai-pick-book"
              size="small"
              value={pickedBook}
              onChange={(e) => setPickedBook(e.target.value)}
              displayEmpty
              sx={{ minWidth: 140 }}
              disabled={booksError || (books?.length ?? 0) === 0}
            >
              {books && books.length > 0 ? (
                books.map((b) => (
                  <MenuItem key={b.book} value={b.book}>
                    {b.book}
                  </MenuItem>
                ))
              ) : (
                <MenuItem value="">{booksError ? "Couldn't load books" : "No books imported"}</MenuItem>
              )}
            </Select>
          )}
        </Box>
        <TextField
          label="Chapter"
          size="small"
          value={chapterInput}
          onChange={(e) => setChapterInput(e.target.value.replace(/[^\d]/g, ""))}
          sx={{ width: 90 }}
          inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
        />
        {pickedBook ? (
          <PipelineMenu
            book={pickedBook}
            chapter={pickedChapter}
            onMessage={setNotice}
            onImported={() => {
              void api
                .getPendingImports(pickedBook, pickedChapter)
                .then((res) => setPendingCount(res.items.length))
                .catch(() => {});
            }}
          />
        ) : (
          <Tooltip title="Pick a book first">
            <span>
              <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon fontSize="small" />} disabled>
                AI
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      <Box
        sx={{
          bgcolor: "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          boxShadow: 1,
          mb: 2.5,
          overflow: "hidden",
        }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="h6" sx={{ fontSize: "1rem" }}>
            Runs — this workspace
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
            Single global bot slot — one job runs at a time; the rest queue in priority order.
            Foreign jobs (started by someone else in this workspace) are read-only here. Other
            workspaces' runs are never shown — the API scopes jobs to your workspace and this UI
            does not aggregate across workspaces.
          </Typography>
        </Box>

        {jobsUnavailable ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              AI run status isn't visible for your role.
            </Typography>
          </Box>
        ) : jobs.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No runs in this workspace right now.
            </Typography>
          </Box>
        ) : isTabletUp ? (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Type</TableCell>
                  <TableCell>Scope</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>Progress</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell>Requested by</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((job) => (
                  <JobRow
                    key={job.job_id}
                    job={job}
                    me={me}
                    aiDisabled={aiDisabled}
                    retrying={retrying === job.job_id}
                    cancelling={cancelling === job.job_id}
                    onRetry={() => void handleRetry(job)}
                    onCancel={() => void handleCancel(job)}
                    onDismiss={() => handleDismiss(job)}
                  />
                ))}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <Stack divider={<Box sx={{ borderBottom: 1, borderColor: "divider" }} />}>
            {jobs.map((job) => (
              <JobCard
                key={job.job_id}
                job={job}
                me={me}
                aiDisabled={aiDisabled}
                retrying={retrying === job.job_id}
                cancelling={cancelling === job.job_id}
                onRetry={() => void handleRetry(job)}
                onCancel={() => void handleCancel(job)}
                onDismiss={() => handleDismiss(job)}
              />
            ))}
          </Stack>
        )}

        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}
        >
          <Typography variant="caption" color="text.secondary">
            {jobsUnavailable
              ? ""
              : `${jobs.length} job${jobs.length === 1 ? "" : "s"}${failedCount ? ` — ${failedCount} needs attention` : ""}`}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" onClick={() => void handleRefresh()} disabled={jobsUnavailable}>
            Refresh
          </Button>
          <Button size="small" onClick={handleDismissAll} disabled={jobsUnavailable || dismissableJobs.length === 0}>
            Dismiss all
          </Button>
        </Stack>
      </Box>

      <Box
        sx={{
          bgcolor: "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          boxShadow: 1,
          overflow: "hidden",
        }}
      >
        <Box sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ fontSize: "1rem" }}>
            API-triggered runs
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Future: pipelines will also be startable and queryable via API tokens, for automation
            outside this UI.
          </Typography>
        </Box>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}>
          <Typography variant="caption" color="text.secondary">
            Not built yet
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="No backend for API tokens exists yet">
            <span>
              <Button size="small" disabled>
                Manage API tokens
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <Snackbar open={Boolean(notice)} autoHideDuration={6000} onClose={() => setNotice(null)} message={notice ?? ""} />
      </Box>
    </AdminDesk>
  );
}

interface JobRowProps {
  job: PipelineJob;
  me: FlowScreenContext["me"];
  aiDisabled: boolean;
  retrying: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

function isMine(job: PipelineJob, me: FlowScreenContext["me"]): boolean {
  return me != null && job.user_id === me.userId;
}

function requestedByLabel(job: PipelineJob, me: FlowScreenContext["me"]): string {
  if (isMine(job, me)) return "You";
  return `requested by ${job.started_by_username || "someone else"}`;
}

function JobRow({ job, me, aiDisabled, retrying, cancelling, onRetry, onCancel, onDismiss }: JobRowProps) {
  const mine = isMine(job, me);
  return (
    <TableRow hover>
      <TableCell>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {TYPE_LABEL[job.pipeline_type] ?? job.pipeline_type}
        </Typography>
      </TableCell>
      <TableCell>{scopeOf(job)}</TableCell>
      <TableCell>
        <FlowStatusChip kind={stateChipKind(job.state)} label={job.state} />
      </TableCell>
      <TableCell sx={{ minWidth: 160 }}>
        {job.state === "failed" ? (
          <Box>
            <Typography
              variant="caption"
              sx={{ textDecoration: "line-through", color: "text.secondary", display: "block" }}
            >
              {job.error_kind ?? "unknown_error"}
            </Typography>
            <Typography variant="caption" color="warning.main" sx={{ display: "block" }}>
              {(job.error_kind && ERROR_COPY[job.error_kind]) || `Unrecognized error: ${job.error_kind}`}
            </Typography>
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {progressText(job)}
          </Typography>
        )}
      </TableCell>
      <TableCell>
        <Typography variant="caption" color="text.secondary">
          {timeAgo(job.created_at)}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="caption" color="text.secondary">
          {requestedByLabel(job, me)}
        </Typography>
      </TableCell>
      <TableCell>
        <JobRowActions
          job={job}
          mine={mine}
          aiDisabled={aiDisabled}
          retrying={retrying}
          cancelling={cancelling}
          onRetry={onRetry}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </TableCell>
    </TableRow>
  );
}

function JobRowActions({
  job,
  mine,
  aiDisabled,
  retrying,
  cancelling,
  onRetry,
  onCancel,
  onDismiss,
}: {
  job: PipelineJob;
  mine: boolean;
  aiDisabled: boolean;
  retrying: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap">
      {job.state === "queued" && mine && (
        <Button
          size="small"
          onClick={onCancel}
          disabled={cancelling}
          startIcon={cancelling ? <CircularProgress size={12} /> : undefined}
        >
          Cancel
        </Button>
      )}
      {job.state === "failed" && mine && (
        <>
          <Tooltip
            title={
              aiDisabled
                ? "AI not configured"
                : job.pipeline_type === "translate"
                  ? "Can't retry a translate run — the job row doesn't record which resource type (ULT/UST) it drafted"
                  : ""
            }
          >
            <span>
              <Button
                size="small"
                onClick={onRetry}
                disabled={aiDisabled || retrying || job.pipeline_type === "translate"}
                startIcon={retrying ? <CircularProgress size={12} /> : undefined}
              >
                Retry
              </Button>
            </span>
          </Tooltip>
          <Button size="small" color="inherit" onClick={onDismiss}>
            Dismiss
          </Button>
        </>
      )}
      {(job.state === "cancelled" || job.state === "done") && (
        <Button size="small" color="inherit" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </Stack>
  );
}

function JobCard({ job, me, aiDisabled, retrying, cancelling, onRetry, onCancel, onDismiss }: JobRowProps) {
  const mine = isMine(job, me);
  return (
    <Box sx={{ p: 1.75 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {TYPE_LABEL[job.pipeline_type] ?? job.pipeline_type}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {scopeOf(job)} · {timeAgo(job.created_at)} · {requestedByLabel(job, me)}
          </Typography>
        </Box>
        <FlowStatusChip kind={stateChipKind(job.state)} label={job.state} />
      </Stack>
      <Box sx={{ mt: 1 }}>
        {job.state === "failed" ? (
          <Typography variant="caption" color="warning.main">
            {(job.error_kind && ERROR_COPY[job.error_kind]) || `Unrecognized error: ${job.error_kind}`}
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {progressText(job)}
          </Typography>
        )}
      </Box>
      <Box sx={{ mt: 1 }}>
        <JobRowActions
          job={job}
          mine={mine}
          aiDisabled={aiDisabled}
          retrying={retrying}
          cancelling={cancelling}
          onRetry={onRetry}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </Box>
    </Box>
  );
}
