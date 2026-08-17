// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// AdminWorkflowScreen — the redesigned admin "Workflow" screen, rendered inside
// the coordinator-owned AdminDesk chrome (route #/admin/workflow). Desktop-first
// per Benjamin's 2026-08-10 direction, translated from the published mockup
// artifact "Workflow · unfoldingWord Admin" into the MUI/sx idiom the flow
// screens use (TranslateNotesScreen is the token reference; Panel / table sx
// mirror AdminTeamScreen.tsx:170-272, the first desk screen to translate the
// artifact's .panel/.dtable primitives).
//
// ── What shipped vs. the mockup (honesty rule: Today only) ──────────────────
//
// The artifact tiers its five sections Today / Phase 2 / Later. Only the three
// "Today" sections are wired to real data; the 8-step rail is kept as
// explicitly DESCRIPTIVE chrome (see below). Verb → endpoint evidence:
//
//   * Pipeline job list    → pipelineStore.subscribe (web/src/sync/pipelineStore.ts:295)
//                            backed by GET /api/pipelines (api/src/pipelines.ts:1545,
//                            requireEditor; active+queued visible to all, terminal
//                            rows owner-scoped, foreign rows sanitized :1616-1626).
//                            The store polls every 120s (pipelineStore.ts:33,:210);
//                            Refresh calls pipelineStore.reload().
//   * Cancel a queued job  → pipelineStore.cancel (pipelineStore.ts:402) →
//                            POST /api/pipelines/:id/cancel (api/src/pipelines.ts:1671).
//                            Server accepts ONLY state === "queued" (:1684-1686)
//                            and only the owner's job, so the button renders only
//                            for own queued rows (same gate as ObserveScreen.tsx:767).
//   * Lane state (source, textReadOnly, alignmentWritable, pendingTarget,
//     replacement job id)  → api.getProjectConfig (web/src/sync/api.ts:1625) →
//                            GET /api/project-config (api/src/projectConfigRoutes.ts:28);
//                            laneState overlay from api/src/scriptureLane.ts:943-954.
//                            Fetched FRESH here (not useProjectConfig) because
//                            lanePatch CAS-checks configRevision — the hook's
//                            localStorage cache would hand us a stale revision.
//   * Text read-only /
//     alignment writable   → api.lanePatch (web/src/sync/api.ts:2238) →
//                            PATCH /api/project-config/lanes/:lane
//                            (api/src/scriptureLaneRoutes.ts:374, requireAdmin,
//                            409 config_revision_mismatch :393-398, 409 lane_frozen
//                            :402). Behind a confirm dialog — flipping textReadOnly
//                            blocks/unblocks every scripture edit in the lane
//                            (assertLaneWritable, api/src/scriptureLane.ts:422-430).
//   * Replacement job view → api.laneGetJob (web/src/sync/api.ts:2192) →
//                            GET /api/project-config/lanes/:lane/replacements/:jobId
//                            (api/src/scriptureLaneRoutes.ts:217). Polled at 5s only
//                            while reserved/staging (BooksLanePanel.tsx:190-218 is
//                            the 3s precedent; this is a monitoring desk, not the
//                            staging driver, so it polls a little slower).
//   * Activate replacement → api.laneActivate (web/src/sync/api.ts:2232) →
//                            POST .../replacements/:jobId/activate
//                            (api/src/scriptureLaneRoutes.ts:282, requireAdmin).
//                            Enabled only on status === "ready", behind a confirm
//                            dialog with an explicit acknowledgement checkbox —
//                            the existing surfaces fire it bare (BooksLanePanel.tsx:305),
//                            but source activation swaps what translators read, so
//                            this screen adds the confirm step deliberately.
//                            Fencing token = crypto.randomUUID(), same as
//                            BooksLanePanel.tsx:305.
//   * Export history       → GET /api/exports?limit=12 (api/src/exports.ts:83,
//                            requireAdmin), via api.exportsList(12).
//   * Run export now       → POST /api/exports/run (api/src/exports.ts:37,
//                            requireAdmin, 202 {id,status} :72; manual runs leave
//                            validateAndMerge unset — no auto-merge — unlike the
//                            05:30 cron, api/src/index.ts:388). Behind a confirm
//                            dialog. Double-submit within the same second collides
//                            into the server's 409 workflow_create_failed
//                            (deterministic workflowRunId, exports.ts:18-20).
//   * Check run status     → GET /api/exports/instance/:id (api/src/exports.ts:114)
//                            — only valid for the id just returned by /run;
//                            export_snapshots rows don't store instance ids
//                            (ObserveScreen.tsx:714-720 documents the same gap).
//
// Omitted from the mockup, and why:
//   * The 8 steps' package counts, current-step highlighting, and click-to-
//     configure — there is NO step-state model anywhere in the API (the
//     ObserveScreen header's "Workflow stages → no backend" note, docs/flows/
//     02-architecture.md D2). The rail renders as labeled DESCRIPTIVE chrome
//     with zero counts rather than fake ones.
//   * Step settings panel  — Phase 2 in the artifact ("nothing here is enforced
//     by the app yet"); proposal panels must not ship inert.
//   * Pipeline "Retry"     — NO retry endpoint exists in api/src (verified:
//     the only pipeline "retry" anywhere is AiScreen.tsx:246-269 fabricating a
//     fresh POST /api/pipelines/start with a new sessionKey, which can't retry
//     translate jobs). Hidden here rather than faked; future wiring = the same
//     re-submission AiScreen does, or a real retry route.
//   * Pipeline "Rows touched" column — no such field on PipelineJobRow
//     (api.ts:1386-1434); output_json isn't parsed into row counts (Phase 1,
//     pipelineStore.ts:15-16). Progress (current_status/skill, queue position)
//     is shown instead — that data is real.
//   * "Stage replacement" form (URL input, per-book keep/replace, Stage button)
//     — the endpoints exist (laneValidate/laneAffectedBooks/laneStartReplacement)
//     but the full guarded flow (verify URL → affected-books diff → per-book
//     checklist → ack) already ships in PreferencesWorkspace.tsx:534-628 and
//     BooksLanePanel.tsx:228-305. Duplicating a THIRD copy of the most dangerous
//     admin flow in the app was judged conservative-wrong; this screen links the
//     reader to where staging starts and shows the resulting job honestly.
//     Future: extract a shared LaneReplacementDriver-style component (note the
//     existing web/src/components/LaneReplacementDriver.tsx is dead code — never
//     rendered) and mount it here.
//   * Cancel / Back out / per-book Retry / Waive on the replacement job —
//     real endpoints (scriptureLaneRoutes.ts:228-359) but they belong to the
//     staging driver surfaces above; this desk shows state and offers only the
//     one verb a "ready" job is waiting for (Activate).
//   * "Hold publishing while final validation is open" switch — the artifact
//     itself labels it Phase 2 ("saves a preference with no effect today").
//     No preference endpoint for it exists; omitted, not faked.
//
// RTL: logical properties only (paddingInline/Block, borderBlockEnd,
// marginInlineStart, textAlign:start). Wide tables sit in their own
// overflow-x:auto wrapper so the page body never scrolls horizontally.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  Snackbar,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import RefreshIcon from "@mui/icons-material/Refresh";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader, workspaceEyebrow } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { pipelineStore, type PipelineJob } from "../../sync/pipelineStore";
import {
  api,
  ApiError,
  type ExportSnapshot,
  type LanePublicState,
  type LaneReplacementJobResponse,
  type PipelineState,
  type PipelineType,
  type ProjectConfig,
} from "../../sync/api";

export interface AdminWorkflowScreenProps extends FlowScreenContext {}

const INSPIRE = "#31ADE3";
const INSPIRE_DEEP = "#1B84B8";
const OCEAN = "#014263";

// ── formatting helpers ───────────────────────────────────────────────────────

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

function fmtDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Real backend enum labels — mirrors AiScreen.tsx:65-70 (same limitation
// documented there: PipelineJobRow carries no resourceType, so every
// "translate" job gets the one generic label).
const TYPE_LABEL: Record<PipelineType, string> = {
  generate: "Generate ULT + UST",
  notes: "Write translation notes",
  tqs: "Write translation questions",
  translate: "Translate chapter",
};

function scopeOf(job: PipelineJob): string {
  if (!job.book) return "Articles"; // article (tw/ta) translate jobs carry no book/chapter
  return job.start_chapter === job.end_chapter
    ? `${job.book} ${job.start_chapter}`
    : `${job.book} ${job.start_chapter}–${job.end_chapter}`;
}

function stateChipKind(state: PipelineState): "ok" | "warn" | "skip" {
  if (state === "done") return "ok";
  if (state === "failed") return "warn";
  return "skip"; // queued / dispatching / running / paused_* / cancelled
}

const STATE_LABEL: Record<PipelineState, string> = {
  queued: "Queued",
  dispatching: "Dispatching",
  running: "Running",
  paused_for_outage: "Paused · outage",
  paused_for_usage_limit: "Paused · usage limit",
  failed: "Failed",
  cancelled: "Cancelled",
  done: "Done",
};

function progressText(job: PipelineJob): string {
  if (job.state === "queued") {
    return job.queue_position != null ? `#${job.queue_position} in line` : "queued";
  }
  return job.current_status || job.current_skill || job.state;
}

// ── the 8 steps (descriptive only — no backend state, see header) ───────────

const STEPS: Array<{ name: string; blurb: string }> = [
  { name: "Draft", blurb: "AI or a translator produces the first pass of every content type." },
  { name: "Peer check", blurb: "A second translator reads the draft against the source." },
  { name: "Source check", blurb: "Checked back against the original-language text." },
  { name: "Align", blurb: "Target words are linked to the original-language words." },
  { name: "Translate resources", blurb: "Notes, Word links, Questions, and referenced articles." },
  { name: "Harmonize", blurb: "Terms and style reconciled across the whole package." },
  { name: "Final validation", blurb: "Nothing publishes with untranslated referenced articles." },
  { name: "Publish", blurb: "The package ships downstream for community checking." },
];

// ── shared chrome (Panel / table sx — mirrors AdminTeamScreen.tsx:170-272) ──

function Panel({
  title,
  chip,
  sub,
  topAction,
  flush,
  children,
  foot,
}: {
  title: string;
  chip?: ReactNode;
  sub?: string;
  topAction?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      component="section"
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        boxShadow: dark
          ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
          : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
        overflow: "hidden",
        mb: 2,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1.5,
          paddingInline: 2,
          paddingBlock: 1.5,
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          {title}
        </Typography>
        {chip}
        {topAction && <Box sx={{ marginInlineStart: "auto" }}>{topAction}</Box>}
        {sub && (
          <Typography variant="body2" color="text.secondary" sx={{ width: "100%", mt: 0.25 }}>
            {sub}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: flush ? 0 : 2 }}>{children}</Box>
      {foot && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.5,
            paddingInline: 2,
            paddingBlock: 1.25,
            borderBlockStart: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
            fontSize: "0.8125rem",
            color: "text.secondary",
          }}
        >
          {foot}
        </Box>
      )}
    </Box>
  );
}

const thSx = {
  position: "sticky" as const,
  insetBlockStart: 0,
  zIndex: 2,
  bgcolor: "action.hover",
  textAlign: "start" as const,
  fontSize: "0.6875rem",
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase" as const,
  color: "text.secondary",
  paddingBlock: 1.125,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  whiteSpace: "nowrap" as const,
};

const tdSx = {
  paddingBlock: 1.375,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  verticalAlign: "middle" as const,
};

// Key/value definition rows (the artifact's .kv).
function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 0.8fr) minmax(0, 1.6fr)",
        gap: "6px 14px",
        fontSize: "0.875rem",
        m: 0,
      }}
    >
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ color: "text.secondary" }}>
            {k}
          </Box>
          <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere" }}>
            {v}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// Lane replacement lifecycle strip (the artifact's .lifecycle). Renders the
// four forward states; failed/cancelled render as a chip instead (they aren't
// positions on the forward path).
const LIFECYCLE_STEPS = ["reserved", "staging", "ready", "completed"] as const;

function LifecycleStrip({ status }: { status: string }) {
  const theme = useTheme();
  const { ok, skip } = theme.palette.flows;
  const curIdx = (LIFECYCLE_STEPS as readonly string[]).indexOf(status);
  if (curIdx === -1) {
    return <FlowStatusChip kind="warn" label={`Replacement ${status}`} />;
  }
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}>
      {LIFECYCLE_STEPS.map((s, i) => {
        const done = i < curIdx;
        const current = i === curIdx;
        return (
          <Box key={s} sx={{ display: "flex", alignItems: "center" }}>
            {i > 0 && (
              <Box
                sx={{
                  width: 24,
                  height: 2,
                  bgcolor: i <= curIdx ? ok.ink : "divider",
                  marginInline: 0.75,
                  flex: "none",
                }}
              />
            )}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  flex: "none",
                  bgcolor: done ? ok.ink : current ? INSPIRE : "background.paper",
                  border: "2px solid",
                  borderColor: done ? ok.ink : current ? INSPIRE : skip.ink,
                }}
              />
              <Typography
                component="span"
                sx={{
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  color: current ? INSPIRE_DEEP : "text.secondary",
                }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Terminal-OK book statuses during a replacement (api/src/scriptureLaneReplacement.ts:585-589).
const BOOK_OK_STATUSES = new Set(["artifact_ok", "carried_forward", "absent_authorized"]);
const BOOK_FAILED_STATUSES = new Set(["retryable_error", "failed"]);

// ── screen ───────────────────────────────────────────────────────────────────

type LaneKey = "lit" | "sim";
const LANES: LaneKey[] = ["lit", "sim"];

export default function AdminWorkflowScreen({ role, me }: AdminWorkflowScreenProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";

  const isAdmin = role === "admin";

  // ── state ──
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<PipelineJob[]>([]);
  const [pipelineRefreshing, setPipelineRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const [laneJobs, setLaneJobs] = useState<Partial<Record<LaneKey, LaneReplacementJobResponse>>>({});
  const [laneBusy, setLaneBusy] = useState<LaneKey | null>(null);

  const [snapshots, setSnapshots] = useState<ExportSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [runInfo, setRunInfo] = useState<{ id: string; status: string } | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [instanceStatus, setInstanceStatus] = useState<string | null>(null);

  // Confirm dialogs — every mutating verb on this screen goes through one.
  const [confirmToggle, setConfirmToggle] = useState<{
    lane: LaneKey;
    field: "textReadOnly" | "alignmentWritable";
    next: boolean;
  } | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<{ lane: LaneKey; jobId: string } | null>(null);
  const [activateAck, setActivateAck] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);

  const [msg, setMsg] = useState<string | null>(null);

  // ── loads ──

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.getProjectConfig();
      setCfg(res.config);
      setCfgError(null);
    } catch (e) {
      setCfgError(e instanceof ApiError ? `Config load failed (HTTP ${e.status})` : "Config load failed");
    }
  }, []);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await api.exportsList(12);
      setSnapshots(res.snapshots);
      setSnapshotsError(null);
    } catch (e) {
      setSnapshots(null);
      setSnapshotsError(
        e instanceof ApiError && e.status === 403
          ? "Export history is admin-only."
          : "Failed to load export history.",
      );
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadConfig();
    void loadSnapshots();
  }, [isAdmin, loadConfig, loadSnapshots]);

  // Live pipeline jobs: the store handles list + 120s polling + visibility.
  useEffect(() => {
    if (!isAdmin) return;
    return pipelineStore.subscribe(setJobs);
  }, [isAdmin]);

  // Replacement job fetch + slow poll while a lane is staging.
  const litJobId = cfg?.laneState?.lit.replacementJobId ?? null;
  const simJobId = cfg?.laneState?.sim.replacementJobId ?? null;
  useEffect(() => {
    if (!isAdmin) return;
    const targets: Array<{ lane: LaneKey; jobId: string }> = [];
    if (litJobId) targets.push({ lane: "lit", jobId: litJobId });
    if (simJobId) targets.push({ lane: "sim", jobId: simJobId });
    if (targets.length === 0) {
      setLaneJobs({});
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fetchAll = async () => {
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            return [t.lane, await api.laneGetJob(t.lane, t.jobId)] as const;
          } catch {
            return [t.lane, null] as const; // transient / 404 — leave prior value
          }
        }),
      );
      if (!alive) return;
      let stillMoving = false;
      for (const [, res] of results) {
        if (res && (res.job.status === "reserved" || res.job.status === "staging")) stillMoving = true;
      }
      setLaneJobs((prev) => {
        const next = { ...prev };
        for (const [lane, res] of results) {
          if (res) next[lane] = res;
        }
        return next;
      });
      if (!stillMoving && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    void fetchAll();
    timer = setInterval(() => void fetchAll(), 5000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [isAdmin, litJobId, simJobId]);

  // ── verbs ──

  const handleCancelJob = async (job: PipelineJob) => {
    setCancelling(job.job_id);
    try {
      const res = await pipelineStore.cancel(job.job_id);
      setMsg(res.ok ? "Job cancelled." : `Too late to cancel — the job is already ${res.state ?? "moving"}.`);
    } catch (e) {
      setMsg(e instanceof ApiError ? `Cancel failed (HTTP ${e.status})` : "Cancel failed");
    } finally {
      setCancelling(null);
    }
  };

  const handleToggleConfirmed = async () => {
    if (!confirmToggle || !cfg?.laneState) return;
    const { lane, field, next } = confirmToggle;
    const state = cfg.laneState[lane];
    setLaneBusy(lane);
    try {
      const patch = field === "textReadOnly" ? { textReadOnly: next } : { alignmentWritable: next };
      const res = await api.lanePatch(lane, state.configRevision, patch);
      setCfg((prev) =>
        prev?.laneState ? { ...prev, laneState: { ...prev.laneState, [lane]: res.laneState } } : prev,
      );
      setMsg(
        field === "textReadOnly"
          ? next
            ? "Text is now read-only for this lane."
            : "Text editing re-enabled for this lane."
          : next
            ? "Alignment editing enabled for this lane."
            : "Alignment is now read-only for this lane.",
      );
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      if (body?.error === "config_revision_mismatch") {
        setMsg("Lane settings changed elsewhere — reloaded the latest state; try again.");
        await loadConfig();
      } else if (body?.error === "lane_frozen") {
        setMsg("This lane is frozen for a replacement — settings can't change until it settles.");
      } else {
        setMsg(e instanceof ApiError ? `Update failed (HTTP ${e.status})` : "Update failed");
      }
    } finally {
      setLaneBusy(null);
      setConfirmToggle(null);
    }
  };

  const handleActivateConfirmed = async () => {
    if (!confirmActivate) return;
    const { lane, jobId } = confirmActivate;
    setLaneBusy(lane);
    try {
      // Fencing token guards a split-brain export completing a stale render
      // after the flip (api.ts:2230-2231); same pattern as BooksLanePanel.tsx:305.
      await api.laneActivate(lane, jobId, crypto.randomUUID());
      setMsg("Replacement activated — the lane now reads from the new source.");
      await loadConfig();
      try {
        const res = await api.laneGetJob(lane, jobId);
        setLaneJobs((prev) => ({ ...prev, [lane]: res }));
      } catch {
        /* job row may already be settled/pruned — config reload is the truth */
      }
    } catch (e) {
      setMsg(e instanceof ApiError ? `Activate failed (HTTP ${e.status})` : "Activate failed");
    } finally {
      setLaneBusy(null);
      setConfirmActivate(null);
      setActivateAck(false);
    }
  };

  const handleRunConfirmed = async () => {
    setRunBusy(true);
    try {
      const res = await api.exportsRun();
      setRunInfo(res);
      setInstanceStatus(null);
      setMsg(`Export queued (run ${res.id}).`);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      setMsg(
        body?.error === "workflow_create_failed"
          ? "An export run with this id already exists — wait a moment and try again."
          : e instanceof ApiError
            ? `Export start failed (HTTP ${e.status})`
            : "Export start failed",
      );
    } finally {
      setRunBusy(false);
      setConfirmRun(false);
    }
  };

  const handleCheckInstance = async () => {
    if (!runInfo) return;
    try {
      const res = await api.exportsInstance(runInfo.id);
      const s = res.status as { status?: string } | null;
      setInstanceStatus(typeof s?.status === "string" ? s.status : JSON.stringify(res.status));
    } catch {
      setInstanceStatus("status lookup failed");
    }
  };

  // ── derived ──

  const jobCounts = useMemo(() => {
    const c = { running: 0, queued: 0, paused: 0, failed: 0, done: 0 };
    for (const j of jobs) {
      if (j.state === "running" || j.state === "dispatching") c.running += 1;
      else if (j.state === "queued") c.queued += 1;
      else if (j.state === "paused_for_outage" || j.state === "paused_for_usage_limit") c.paused += 1;
      else if (j.state === "failed") c.failed += 1;
      else if (j.state === "done") c.done += 1;
    }
    return c;
  }, [jobs]);

  const lastCommitted = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return null;
    return snapshots.reduce((a, b) => (b.committed_at > a.committed_at ? b : a));
  }, [snapshots]);

  if (!isAdmin) {
    return (
      <AdminDesk current="workflow">
        <Alert severity="info">Workflow is admin-only. Your current role is {role}.</Alert>
      </AdminDesk>
    );
  }

  // ── lane card ──

  const laneCard = (lane: LaneKey) => {
    if (!cfg?.laneState) return null;
    const state: LanePublicState = cfg.laneState[lane];
    const label =
      state.config.label || (lane === "lit" ? cfg.litLabel || "Literal" : cfg.simLabel || "Simplified");
    const src = state.config.source;
    const pending = state.pendingTarget;
    const job = laneJobs[lane]?.job ?? null;
    const books = laneJobs[lane]?.books ?? [];
    const okBooks = books.filter((b) => BOOK_OK_STATUSES.has(b.status));
    const failedBooks = books.filter((b) => BOOK_FAILED_STATUSES.has(b.status));
    const busy = laneBusy === lane;
    const frozen = state.replacementJobId != null;

    return (
      <Box
        key={lane}
        sx={{
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "9px",
          p: 2,
          minWidth: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <Typography sx={{ fontWeight: 700, fontSize: "0.95rem" }}>{label}</Typography>
          <Typography component="span" sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
            {lane === "lit" ? "literal lane" : "simplified lane"}
          </Typography>
          {state.replacementRequired && <FlowStatusChip kind="warn" label="Replacement required" />}
          {frozen && <FlowStatusChip kind="edited" label="Replacement in progress" />}
        </Box>

        <Kv
          rows={[
            ["Current source", `${src.owner}/${src.repo} @ ${src.ref}`],
            [
              "Export target",
              state.config.export
                ? `${state.config.export.owner}/${state.config.export.repo} (base ${state.config.export.baseRef})`
                : "— (no export configured)",
            ],
            ...(pending
              ? ([
                  [
                    "Staged target",
                    `${pending.source.owner}/${pending.source.repo} @ ${pending.source.ref}`,
                  ],
                ] as Array<[string, ReactNode]>)
              : []),
          ]}
        />

        {/* Lane write toggles — real server enforcement (scriptureLane.ts:422-430). */}
        <Box sx={{ mt: 1.5 }}>
          {(
            [
              {
                field: "textReadOnly" as const,
                label: "Text read-only",
                help: "Blocks new edits to this lane's scripture text.",
                on: state.config.textReadOnly,
              },
              {
                field: "alignmentWritable" as const,
                label: "Alignment writable",
                help: "Lets translators keep aligning while the text is locked.",
                on: state.config.alignmentWritable,
              },
            ]
          ).map((row) => (
            <Box
              key={row.field}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1.5,
                paddingBlock: 1,
                borderBlockStart: "1px solid",
                borderColor: "divider",
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.875rem", fontWeight: 600 }}>{row.label}</Typography>
                <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{row.help}</Typography>
              </Box>
              <Tooltip
                title={
                  frozen
                    ? "Locked while a replacement is in progress"
                    : `Click to turn ${row.on ? "off" : "on"} (asks to confirm)`
                }
              >
                <Box component="span" sx={{ display: "inline-flex" }}>
                  <Switch
                    size="small"
                    checked={row.on}
                    disabled={busy || frozen}
                    onChange={() => setConfirmToggle({ lane, field: row.field, next: !row.on })}
                    inputProps={{ "aria-label": `${row.label} — ${label}` }}
                  />
                </Box>
              </Tooltip>
            </Box>
          ))}
        </Box>

        {/* Replacement job status — read-only view + the one verb a ready job waits for. */}
        {job && (
          <Box sx={{ mt: 1.5, paddingBlockStart: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
            <Typography
              sx={{
                fontSize: "0.72rem",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "text.secondary",
                mb: 1,
              }}
            >
              Staged replacement · generation {job.generation}
            </Typography>
            <LifecycleStrip status={job.status} />
            {books.length > 0 && (
              <Typography sx={{ fontSize: "0.8125rem", color: "text.secondary", mt: 1 }}>
                {okBooks.length}/{books.length} books staged
                {failedBooks.length > 0 && (
                  <>
                    {" · "}
                    <Box component="span" sx={{ color: theme.palette.flows.warn.ink, fontWeight: 600 }}>
                      failed: {failedBooks.map((b) => b.book).join(", ")}
                    </Box>
                  </>
                )}
              </Typography>
            )}
            <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", mt: 0.5 }}>
              {job.status === "ready"
                ? "Ready to activate — the lane will switch to the new source."
                : job.status === "staging" || job.status === "reserved"
                  ? "Staging — retry, waive, cancel, and back-out live on the Books screen's lane panel."
                  : job.status === "completed"
                    ? "This replacement is complete."
                    : "This replacement needs attention on the Books screen's lane panel."}
            </Typography>
            {job.status === "ready" && (
              <Button
                variant="contained"
                size="small"
                disabled={busy}
                onClick={() => setConfirmActivate({ lane, jobId: job.job_id })}
                sx={{ mt: 1.25, bgcolor: theme.palette.flows.ok.ink, fontWeight: 700 }}
              >
                Activate…
              </Button>
            )}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <AdminDesk current="workflow">
      <AdminPageHeader
        eyebrow={workspaceEyebrow(cfg)}
        title="Workflow"
        subtitle="How book packages move from draft to publish, and the machinery underneath them."
      />

      {/* ── The 8 steps — descriptive chrome only (no step-state backend) ── */}
      <Panel
        title="The 8 steps"
        chip={<FlowStatusChip kind="skip" label="Descriptive" />}
        sub="Every book package — literal and simplified text, translationNotes, Word links, Questions, and every referenced translationWords / translationAcademy article — moves through these steps in order. The app doesn't track step state yet, so this rail describes the model without pretending to measure it."
        foot={
          <Typography variant="caption">
            No live counts here on purpose — there's no step-state data to show, and fake numbers would
            be worse than none.
          </Typography>
        }
      >
        <Box
          role="list"
          aria-label="Workflow steps"
          sx={{ display: "flex", gap: 1.25, overflowX: "auto", paddingBlockEnd: 0.5 }}
        >
          {STEPS.map((s, i) => (
            <Box
              key={s.name}
              role="listitem"
              sx={{
                flex: "none",
                minWidth: 172,
                maxWidth: 210,
                border: "1.5px solid",
                borderColor: "divider",
                bgcolor: "action.hover",
                borderRadius: "14px",
                paddingBlock: 1.5,
                paddingInline: 1.625,
                display: "flex",
                flexDirection: "column",
                gap: 0.5,
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                  aria-hidden
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    bgcolor: dark ? INSPIRE_DEEP : OCEAN,
                    color: "#fff",
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {i + 1}
                </Box>
                <Typography sx={{ fontSize: "0.9rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
                  {s.name}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{s.blurb}</Typography>
            </Box>
          ))}
        </Box>
        <Typography sx={{ mt: 1.5, fontSize: "0.8125rem", color: "text.secondary" }}>
          There is deliberately no community-check step here — that happens downstream, outside this
          tool, once a package is published. And a package isn't done just because the text is drafted:
          it isn't finished until every referenced article is also translated.
        </Typography>
      </Panel>

      {/* ── AI pipeline — live jobs from the shared store ── */}
      <Panel
        title="AI pipeline"
        chip={<FlowStatusChip kind="ok" label="Live" />}
        sub="Per-chapter AI jobs across this workspace — everyone's active and queued runs, plus your own recent finished ones. Refreshes itself every two minutes."
        topAction={
          <Button
            size="small"
            startIcon={pipelineRefreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
            disabled={pipelineRefreshing}
            onClick={() => {
              setPipelineRefreshing(true);
              void pipelineStore.reload().finally(() => setPipelineRefreshing(false));
            }}
          >
            Refresh
          </Button>
        }
        flush
        foot={
          <>
            <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {jobCounts.running} running · {jobCounts.queued} queued · {jobCounts.paused} paused ·{" "}
              {jobCounts.failed} failed · {jobCounts.done} done
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Typography variant="caption">
              Retrying a failed run lives on the AI screen; only your own queued jobs can be cancelled.
            </Typography>
          </>
        }
      >
        {jobs.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No pipeline jobs right now. Runs started from the editor (or the AI screen) appear here.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={thSx}>Scope</TableCell>
                  <TableCell sx={thSx}>Type</TableCell>
                  <TableCell sx={thSx}>State</TableCell>
                  <TableCell sx={thSx}>Progress</TableCell>
                  <TableCell sx={thSx}>Started</TableCell>
                  <TableCell sx={thSx}>Requested by</TableCell>
                  <TableCell sx={thSx} />
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((j) => {
                  const mine = me != null && j.user_id === me.userId;
                  return (
                    <TableRow key={j.job_id} hover>
                      <TableCell sx={{ ...tdSx, fontWeight: 600, whiteSpace: "nowrap" }}>
                        {scopeOf(j)}
                      </TableCell>
                      <TableCell sx={tdSx}>{TYPE_LABEL[j.pipeline_type] ?? j.pipeline_type}</TableCell>
                      <TableCell sx={tdSx}>
                        <FlowStatusChip kind={stateChipKind(j.state)} label={STATE_LABEL[j.state] ?? j.state} />
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary", maxWidth: 260 }}>
                        <Typography variant="body2" noWrap title={progressText(j)}>
                          {progressText(j)}
                        </Typography>
                        {j.state === "failed" && j.error_kind && (
                          <Typography
                            variant="caption"
                            sx={{ color: theme.palette.flows.warn.ink, display: "block" }}
                          >
                            {j.error_kind}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, whiteSpace: "nowrap", color: "text.secondary" }}>
                        {timeAgo(j.created_at)}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary" }}>
                        {mine ? "You" : (j.started_by_username ?? "—")}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, whiteSpace: "nowrap" }}>
                        {j.state === "queued" && mine && (
                          <Button
                            size="small"
                            color="warning"
                            disabled={cancelling === j.job_id}
                            onClick={() => void handleCancelJob(j)}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Panel>

      {/* ── Scripture source — real lane state, conservative verbs ── */}
      <Panel
        title="Scripture source"
        chip={<FlowStatusChip kind="ok" label="Live" />}
        sub="Where each scripture lane's text comes from, its write locks, and any staged source replacement. Starting a replacement (with its per-book checklist) lives on the Books screen's lane panel and in Preferences → Setup — this desk shows the state and offers Activate when a job is ready."
        foot={
          <>
            <Typography variant="caption">
              {cfg?.laneState
                ? [
                    cfg.laneState.lit.replacementJobId ? "Literal lane has a replacement in flight" : null,
                    cfg.laneState.sim.replacementJobId ? "Simplified lane has a replacement in flight" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No replacement in flight"
                : "—"}
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Typography variant="caption">Source swaps are guarded — every change here asks first</Typography>
          </>
        }
      >
        {cfgError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void loadConfig()}>
                Retry
              </Button>
            }
          >
            {cfgError}
          </Alert>
        ) : !cfg ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : !cfg.laneState ? (
          <Alert severity="info">
            This server didn't report per-lane state (older API response) — lane sources and locks
            can't be shown here.
          </Alert>
        ) : (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" },
              gap: 2,
              alignItems: "start",
            }}
          >
            {LANES.map((lane) => laneCard(lane))}
          </Box>
        )}
      </Panel>

      {/* ── Publishing — nightly export, real history, manual run ── */}
      <Panel
        title="Publishing"
        chip={<FlowStatusChip kind="ok" label="Live" />}
        sub="The nightly export renders the database to TSV + USFM and commits to a Door43 branch. History below is real; the schedule is configuration (api/wrangler.toml crons), not live data — there's no endpoint that lists registered crons."
        foot={
          <>
            <Typography variant="caption">
              {lastCommitted
                ? `Latest commit: ${lastCommitted.book} · ${lastCommitted.resource} — ${fmtDateTime(lastCommitted.committed_at)}`
                : snapshotsError
                  ? "History unavailable"
                  : "No export history yet"}
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Typography variant="caption">Exports run automatically at 05:30 UTC</Typography>
          </>
        }
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 2 }}>
          <Button variant="contained" size="small" disabled={runBusy} onClick={() => setConfirmRun(true)}>
            Run export now…
          </Button>
          {runInfo && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                Run {runInfo.id} — {instanceStatus ?? runInfo.status}
              </Typography>
              <Link component="button" type="button" variant="caption" onClick={() => void handleCheckInstance()}>
                Check status
              </Link>
              <Link component="button" type="button" variant="caption" onClick={() => void loadSnapshots()}>
                Reload history
              </Link>
            </>
          )}
        </Box>

        {snapshotsError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void loadSnapshots()}>
                Retry
              </Button>
            }
          >
            {snapshotsError}
          </Alert>
        ) : snapshots === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : snapshots.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No export snapshots recorded yet — the first nightly run (or a manual run) will appear here.
          </Typography>
        ) : (
          <Box sx={{ overflowX: "auto", border: "1px solid", borderColor: "divider", borderRadius: "9px" }}>
            <Table size="small" sx={{ minWidth: 640 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={thSx}>Book · resource</TableCell>
                  <TableCell sx={thSx}>State</TableCell>
                  <TableCell sx={{ ...thSx, textAlign: "end" }}>Rows</TableCell>
                  <TableCell sx={thSx}>Branch</TableCell>
                  <TableCell sx={thSx}>Committed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {snapshots.map((s) => {
                  const bad = Boolean(s.error || s.pr_error);
                  return (
                    <TableRow key={s.id} hover>
                      <TableCell sx={{ ...tdSx, fontWeight: 600, whiteSpace: "nowrap" }}>
                        {s.book} · {s.resource}
                      </TableCell>
                      <TableCell sx={tdSx}>
                        <FlowStatusChip kind={bad ? "warn" : "ok"} label={bad ? "Needs attention" : "Committed"} />
                        {bad && (
                          <Typography
                            variant="caption"
                            sx={{ display: "block", color: theme.palette.flows.warn.ink, maxWidth: 320, overflowWrap: "anywhere" }}
                          >
                            {s.error ?? s.pr_error}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, textAlign: "end", fontVariantNumeric: "tabular-nums" }}>
                        {s.rows_exported}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary", whiteSpace: "nowrap" }}>
                        {s.branch ?? "—"}
                        {s.pr_number != null ? ` · PR #${s.pr_number}` : ""}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary", whiteSpace: "nowrap" }}>
                        {fmtDateTime(s.committed_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Panel>

      {/* ── confirm dialogs ── */}

      <Dialog open={confirmToggle != null} onClose={() => setConfirmToggle(null)}>
        <DialogTitle>
          {confirmToggle?.field === "textReadOnly"
            ? confirmToggle.next
              ? "Make text read-only?"
              : "Re-enable text editing?"
            : confirmToggle?.next
              ? "Enable alignment editing?"
              : "Make alignment read-only?"}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirmToggle?.field === "textReadOnly"
              ? confirmToggle.next
                ? "Translators will be blocked from editing this lane's scripture text (the server enforces this on every save)."
                : "Translators will be able to edit this lane's scripture text again."
              : confirmToggle?.next
                ? "Translators will be able to edit word alignments in this lane."
                : "Translators will be blocked from editing word alignments in this lane."}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmToggle(null)}>Keep as is</Button>
          <Button variant="contained" disabled={laneBusy != null} onClick={() => void handleToggleConfirmed()}>
            Apply
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={confirmActivate != null}
        onClose={() => {
          setConfirmActivate(null);
          setActivateAck(false);
        }}
      >
        <DialogTitle>Activate the staged source?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            The {confirmActivate?.lane === "sim" ? "simplified" : "literal"} lane switches to the new
            source immediately for every staged book. Books that were carried forward keep their current
            text. This is the point of no easy return — backing out afterwards means another replacement.
          </Typography>
          <FormControlLabel
            control={<Checkbox checked={activateAck} onChange={(e) => setActivateAck(e.target.checked)} />}
            label={
              <Typography variant="body2">
                I understand translators will start reading the new source.
              </Typography>
            }
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmActivate(null);
              setActivateAck(false);
            }}
          >
            Not now
          </Button>
          <Button
            variant="contained"
            disabled={!activateAck || laneBusy != null}
            onClick={() => void handleActivateConfirmed()}
            sx={{ bgcolor: theme.palette.flows.ok.ink, fontWeight: 700 }}
          >
            Activate
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRun} onClose={() => setConfirmRun(false)}>
        <DialogTitle>Run the export now?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Renders every book and resource to TSV + USFM and commits to the Door43 export branch —
            the same work the 05:30 UTC nightly does, except a manual run never auto-merges. Safe to
            run, but it takes several minutes and commits real snapshots.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRun(false)}>Not now</Button>
          <Button variant="contained" disabled={runBusy} onClick={() => void handleRunConfirmed()}>
            Run export
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={msg != null}
        autoHideDuration={6000}
        onClose={() => setMsg(null)}
        message={msg ?? ""}
      />
    </AdminDesk>
  );
}
