// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// a4-observe: admin trust & observe dashboard. Port of
// docs/flows/ui/a4-observe.html. Every card reads a real endpoint or renders
// an honest absence — nothing here is fabricated:
//   - Nightly export runs   -> GET  /api/exports            (requireAdmin)
//   - Run export / force    -> POST /api/exports/run        (requireAdmin)
//   - Pipeline jobs         -> GET  /api/pipelines           (api.pipelineList)
//   - Cancel a queued job   -> POST /api/pipelines/:id/cancel (api.pipelineCancel)
//   - Health check          -> GET  /api/health, MANUAL trigger only (see
//     05-functional-preview-findings.md §2.18 — auto-firing this on mount as
//     well as on click double-fires the request; this screen only ever fires
//     it from the "Check now" button)
//   - Context pack status   -> GET  /api/translation-memory/export-status
//     (api.getContextExportStatus)
//   - Cron schedule         -> static, from api/wrangler.toml's
//     [env.production.triggers] crons list — labeled as configuration, not
//     live data (there's no "list registered crons" endpoint)
//   - Spare workspace pool  -> GET  /api/workspaces/pool (super-admin only;
//     a plain admin gets an honest 403, not an empty table)
//
// GET/POST /api/exports* are wrapped in sync/api.ts (api.exportsList/
// exportsRun/exportsInstance — issue #166), so they get the same silent
// 401-refresh-and-retry as every other api.* call. GET /api/health and
// GET/POST /api/workspaces/pool* still have no wrapper, so this file talks
// to them directly via observeFetch() below, mirroring api.ts's request()
// header discipline (credentials, X-Workspace, X-CSRF-Token on writes).
// Unlike request(), it does not retry once on a stale session — this is a
// manual-refresh observability dashboard, not the hot edit path, so a
// 401/403 on health/pool just renders as an honest error rather than
// silently retrying.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import {
  api,
  ApiError,
  type ContextExportStatus,
  type ExportSnapshot,
  type PipelineJobRow,
} from "../../sync/api";
import { getWorkspaceSlug } from "../../sync/workspace";

export interface ObserveScreenProps extends FlowScreenContext {}

// ── Minimal client for the endpoints sync/api.ts doesn't wrap yet ──────────

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = "be_csrf=";
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      try {
        return decodeURIComponent(part.slice(prefix.length));
      } catch {
        return part.slice(prefix.length);
      }
    }
  }
  return null;
}

async function observeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  headers["X-Workspace"] = getWorkspaceSlug();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrfCookie();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(path, { ...init, method, headers, credentials: "include" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* no/invalid JSON body — status alone is enough to classify */
  }
  if (!res.ok) {
    // NOTE: a 401 here does not raise the global re-auth banner. sync/api.ts's
    // emitAuthError() (used by request()'s own 401 path — see App.tsx's
    // onAuthError subscription) is a module-private function, not exported,
    // so this standalone fetch client can't call it without restructuring
    // api.ts's auth-error plumbing. Left as an honest gap rather than doing
    // that restructuring here — a 401 on this screen still renders as an
    // explicit error, it just doesn't also raise the global banner.
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  return body as T;
}

// ── Local response shapes (server-side types live in api/src, a separate
// workspace this file can't import from) ───────────────────────────────────

interface HealthResponse {
  ok: boolean;
  service: string;
  time: string;
}

interface PoolSlot {
  slug: string;
  label: string | null;
  org: string | null;
  binding: string;
  databaseUuid: string | null;
  exportOwner: string | null;
  status: string;
  bindingLive: boolean;
  createdAt: number;
  updatedAt: number;
}

interface PoolStatus {
  counts: Record<string, number>;
  slots: PoolSlot[];
}

function fmtTime(unixSeconds: number | null | undefined): string {
  if (unixSeconds === null || unixSeconds === undefined) return "—";
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const CONTEXT_PACK_LABELS: Record<string, string> = {
  success: "Ready",
  never: "Never generated",
  failed: "Last run failed",
  shrink_refused: "Refused (shrink guard)",
};

// ── Small presentational helpers ────────────────────────────────────────────

function Panel({ title, subtitle, action, children, foot }: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
        p: 2,
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontSize: "1.05rem" }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {action}
      </Stack>
      <Box>{children}</Box>
      {foot && (
        <Box sx={{ mt: 1.5, pt: 1.25, borderBlockStart: 1, borderColor: "divider" }}>
          {foot}
        </Box>
      )}
    </Box>
  );
}

function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Box sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.75 }}>
      <Typography
        variant="caption"
        sx={{ display: "block", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", mb: 0.5 }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontSize: "1.3rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
          {sub}
        </Typography>
      )}
    </Box>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function ObserveScreen({ role, me, onNavigate }: ObserveScreenProps) {
  // Health — manual only. Never fetched on mount (see the header comment and
  // 05-functional-preview-findings.md §2.18: firing this from an effect AND
  // the button double-fires the request).
  const [health, setHealth] = useState<{ state: "idle" | "checking" | "ok" | "down"; time: string | null; body: unknown }>({
    state: "idle",
    time: null,
    body: null,
  });

  const [contextPack, setContextPack] = useState<ContextExportStatus | null>(null);
  const [contextPackUnavailable, setContextPackUnavailable] = useState(false);
  const [contextPackError, setContextPackError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<PipelineJobRow[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<ExportSnapshot[] | null>(null);
  const [exportsError, setExportsError] = useState<string | null>(null);

  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [poolError, setPoolError] = useState<{ status: number; message: string } | null>(null);
  const [poolDialog, setPoolDialog] = useState<null | "register" | "claim">(null);
  const [poolBusy, setPoolBusy] = useState(false);
  const [poolBusyMessage, setPoolBusyMessage] = useState<string | null>(null);

  const isAdmin = role === "admin";
  const cfg = useProjectConfig();
  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : "Workspace";

  const loadContextPack = useCallback(() => {
    if (!isAdmin) {
      setContextPackUnavailable(true);
      return;
    }
    setContextPackError(null);
    api
      .getContextExportStatus()
      .then((res) => setContextPack(res))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setContextPackUnavailable(true);
        } else {
          setContextPackError(err instanceof Error ? err.message : "load failed");
        }
      });
  }, [isAdmin]);

  const loadJobs = useCallback(() => {
    if (!isAdmin) return;
    setJobsError(null);
    api
      .pipelineList()
      .then((res) => {
        setJobs(res.jobs);
      })
      .catch((err) => setJobsError(err instanceof Error ? err.message : "load failed"));
  }, [isAdmin]);

  const loadExports = useCallback(() => {
    if (!isAdmin) return;
    setExportsError(null);
    api
      .exportsList()
      .then((res) => setSnapshots(res.snapshots))
      .catch((err) => {
        setExportsError(
          err instanceof ApiError ? `${err.status} ${(err.body as { error?: string } | null)?.error ?? err.message}` : "load failed",
        );
      });
  }, [isAdmin]);

  const loadPool = useCallback(() => {
    if (!isAdmin) return;
    setPoolError(null);
    observeFetch<PoolStatus>("/api/workspaces/pool")
      .then((res) => setPool(res))
      .catch((err) => {
        if (err instanceof ApiError) {
          setPoolError({
            status: err.status,
            message: err.status === 403 ? "Your account isn't a super-admin — this data isn't visible to you." : `Failed to load (HTTP ${err.status}).`,
          });
        } else {
          setPoolError({ status: 0, message: "Failed to load." });
        }
      });
  }, [isAdmin]);

  useEffect(() => {
    loadContextPack();
  }, [loadContextPack]);
  useEffect(() => {
    loadJobs();
  }, [loadJobs]);
  useEffect(() => {
    loadExports();
  }, [loadExports]);
  useEffect(() => {
    loadPool();
  }, [loadPool]);

  function runHealthCheck() {
    setHealth((h) => ({ ...h, state: "checking" }));
    observeFetch<HealthResponse>("/api/health")
      .then((res) => {
        setHealth({ state: res.ok ? "ok" : "down", time: new Date().toLocaleTimeString(), body: res });
      })
      .catch((err) => {
        setHealth({
          state: "down",
          time: new Date().toLocaleTimeString(),
          body: err instanceof ApiError ? err.body ?? { error: err.message } : { error: "network error" },
        });
      });
  }

  async function registerSlot(binding: string) {
    setPoolBusy(true);
    setPoolBusyMessage(null);
    try {
      await observeFetch("/api/workspaces/pool", { method: "POST", body: JSON.stringify({ binding }) });
      setPoolBusyMessage(`Registered slot for binding "${binding}".`);
      setPoolDialog(null);
      loadPool();
    } catch (err) {
      setPoolBusyMessage(
        err instanceof ApiError ? `${err.status} ${(err.body as { error?: string } | null)?.error ?? err.message}` : "Register failed.",
      );
    } finally {
      setPoolBusy(false);
    }
  }

  async function claimSlot(org: string, label: string) {
    setPoolBusy(true);
    setPoolBusyMessage(null);
    try {
      await observeFetch("/api/workspaces/pool/claim", { method: "POST", body: JSON.stringify({ org, label }) });
      setPoolBusyMessage(`Claimed a slot for "${org}".`);
      setPoolDialog(null);
      loadPool();
    } catch (err) {
      setPoolBusyMessage(
        err instanceof ApiError ? `${err.status} ${(err.body as { error?: string } | null)?.error ?? err.message}` : "Claim failed.",
      );
    } finally {
      setPoolBusy(false);
    }
  }

  if (!isAdmin) {
    // Honest admin-only state — same convention as SetupScreen: no dashboard
    // content leaks to a non-admin role, and nothing is fabricated in its place.
    return (
      <AdminDesk current="observe">
        <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
          <Paper variant="outlined" sx={{ p: 3, mt: 3 }}>
            <Typography variant="subtitle1" gutterBottom>
              Admin only
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This dashboard shows export runs, AI pipeline jobs, service health, and
              the context-pack that steers every AI draft — only an admin can see it.
              Your role is <strong>{role}</strong>.
            </Typography>
            <Button
              variant="outlined"
              sx={{ mt: 2 }}
              onClick={() => onNavigate(me?.lastBook || "OBA", me?.lastChapter || 1, me?.lastVerse || 1)}
            >
              Back to home
            </Button>
          </Paper>
        </Box>
      </AdminDesk>
    );
  }

  const running = jobs?.filter((j) => j.state === "running" || j.state === "dispatching").length ?? 0;
  const queued = jobs?.filter((j) => j.state === "queued").length ?? 0;
  const failed = jobs?.filter((j) => j.state === "failed").length ?? 0;
  const latestSnapshot = snapshots && snapshots.length > 0 ? snapshots[0] : null;

  const contextPackLabel = contextPackUnavailable
    ? "Not available for your role"
    : contextPack
      ? CONTEXT_PACK_LABELS[contextPack.status] ?? contextPack.status
      : contextPackError
        ? "Load failed"
        : "—";

  return (
    <AdminDesk current="observe">
    <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
      <AdminPageHeader
        eyebrow={eyebrow}
        title="Observe"
        subtitle="Export runs, AI pipeline jobs, service health, and the context-pack that steers every AI draft."
      />

      {/* Stat row */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 1.5,
          mb: 2.25,
        }}
      >
        <StatTile
          label="Health"
          value={health.state === "checking" ? <CircularProgress size={18} /> : health.state === "ok" ? "OK" : health.state === "down" ? "DOWN" : "—"}
          sub={health.state === "idle" ? "not checked yet" : health.time ? `checked ${health.time}` : "checking…"}
        />
        <StatTile label="Context pack" value={contextPackLabel} sub={contextPack?.sha ? `sha ${contextPack.sha}` : contextPack?.failureReason ?? "—"} />
        <StatTile
          label="Pipeline jobs"
          value={jobs ? `${running} / ${queued} / ${failed}` : jobsError ? "—" : <Skeleton width={40} />}
          sub={
            <>
              running / queued / failed —{" "}
              <Link component="button" type="button" variant="caption" onClick={() => { location.hash = "#/ai"; }}>
                Open AI studio
              </Link>
            </>
          }
        />
        <StatTile
          label="Last nightly export"
          value={latestSnapshot ? fmtTime(latestSnapshot.committed_at) : snapshots ? "none" : exportsError ? "—" : <Skeleton width={80} />}
          sub={latestSnapshot ? `${latestSnapshot.book}·${latestSnapshot.resource}${latestSnapshot.error ? ` — ${latestSnapshot.error}` : ` — ${latestSnapshot.rows_exported} rows`}` : "—"}
        />
      </Box>

      <Stack spacing={2.25}>
        {/* Nightly export runs */}
        <Panel
          title="Nightly export runs"
          subtitle="The single status-check route covers both the 05:30 UTC nightly cron and any manual/context-only run."
          foot={
            <Typography variant="caption" color="text.secondary">
              Listed via <code>GET /api/exports?limit=&amp;book=</code>
            </Typography>
          }
        >
          {exportsError && <Alert severity="error">Failed to load export runs: {exportsError}</Alert>}
          {!exportsError && snapshots === null && <Skeleton variant="rounded" height={80} />}
          {!exportsError && snapshots !== null && snapshots.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No export runs recorded yet.
            </Typography>
          )}
          {!exportsError && snapshots && snapshots.length > 0 && (
            <Stack divider={<Box sx={{ borderBlockEnd: 1, borderColor: "divider" }} />}>
              {snapshots.map((r) => {
                const hasError = !!r.error;
                return (
                  <Box key={r.id} sx={{ py: 1.125 }}>
                    <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {r.book} · {r.resource} — {fmtTime(r.committed_at)}
                      </Typography>
                      <FlowStatusChip kind={hasError ? "warn" : "approved"} label={hasError ? "needs attention" : "committed"} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {r.rows_exported} rows exported · branch {r.branch ?? "—"}
                      {r.error ? ` · error: ${r.error}` : ""}
                      {r.pr_number ? ` · PR #${r.pr_number}` : ""}
                      {r.pr_error ? ` · PR error: ${r.pr_error}` : ""}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          )}
          {/* Per-row "Details" (GET /api/exports/instance/:id) is intentionally not
              offered here: export_snapshots rows don't store the Workflow
              instanceId (see api/src/exportWorkflow.ts's INSERT INTO
              export_snapshots — no instanceId column), so there is no valid id to
              call that endpoint with for a historical row. The "Check status"
              button above uses the id POST /api/exports/run actually returns,
              which is the one case this endpoint can be called correctly from. */}
        </Panel>

        {/* Health check + Context pack status */}
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", tablet: "1fr 1fr" }, gap: 2.25 }}>
          <Panel
            title="Health check"
            subtitle="No auth, no side effects."
            foot={
              <Button size="small" variant="outlined" onClick={runHealthCheck} disabled={health.state === "checking"}>
                {health.state === "checking" ? "Checking…" : "Check now"}
              </Button>
            }
          >
            <Stack spacing={0.75}>
              <Typography variant="body2">
                <strong>Endpoint:</strong> <code>GET /api/health</code>
              </Typography>
              <Typography variant="body2">
                <strong>Last check:</strong> {health.time ?? "—"}
              </Typography>
              <Typography variant="body2" component="div">
                <strong>Response:</strong>{" "}
                <Box component="span" sx={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                  {health.body ? JSON.stringify(health.body) : "—"}
                </Box>
              </Typography>
            </Stack>
          </Panel>

          <Panel
            title="Context pack status"
            subtitle="The trust indicator every AI draft is pinned against."
            foot={
              <Typography variant="caption" color="text.secondary">
                Loaded via <code>GET /api/translation-memory/export-status</code>
              </Typography>
            }
          >
            {contextPackError && <Alert severity="error">{contextPackError}</Alert>}
            {!contextPackError && (
              <Stack spacing={0.5}>
                <Typography variant="body2" component="div">
                  <strong>Status:</strong>{" "}
                  {contextPackUnavailable ? (
                    "not available for your role"
                  ) : contextPack ? (
                    <FlowStatusChip
                      kind={contextPack.status === "success" && contextPack.sha ? "approved" : "warn"}
                      label={
                        contextPack.status === "success" && contextPack.sha
                          ? `ready — sha ${contextPack.sha}`
                          : `${contextPack.status}${contextPack.failureReason ? ` — ${contextPack.failureReason}` : ""}`
                      }
                    />
                  ) : (
                    "—"
                  )}
                </Typography>
                <Typography variant="body2">
                  <strong>Completed at:</strong> {contextPack ? fmtTime(contextPack.completedAt) : "—"}
                </Typography>
                <Typography variant="body2">
                  <strong>Terms:</strong>{" "}
                  {contextPack ? `${contextPack.terms} (tN examples ${contextPack.examplesTn}, tQ examples ${contextPack.examplesTq})` : "—"}
                </Typography>
                <Typography variant="body2">
                  <strong>Content files:</strong>{" "}
                  {contextPack ? `${contextPack.contentFiles} (${contextPack.totalBytes} bytes)` : "—"}
                </Typography>
                <Typography variant="body2">
                  <strong>Owner:</strong> {contextPack?.owner ?? "—"}
                </Typography>
              </Stack>
            )}
          </Panel>
        </Box>

        {/* Cron schedule — static configuration, not live data */}
        <Panel
          title="Cron schedule"
          subtitle="Not user-triggerable — shown here for observability only. Values are api/wrangler.toml's registered [env.production.triggers], not a live read (there's no list-crons endpoint)."
        >
          {!me?.nightlyExportsEnabled && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              Automatic nightly exports are <strong>not enabled on this deployment</strong> — use{" "}
              <strong>Run export now</strong> to publish. The schedule below is the production
              configuration.
            </Alert>
          )}
          <Stack divider={<Box sx={{ borderBlockEnd: 1, borderColor: "divider" }} />}>
            <Stack direction="row" gap={1.5} alignItems="baseline" sx={{ py: 1 }}>
              <Typography sx={{ fontFamily: "monospace", fontWeight: 700, minWidth: 74 }}>05:30 UTC</Typography>
              <Typography variant="body2" component="div">
                <strong>Export</strong> — DCS→D1 sync, render, commit to <code>live-snapshot</code>.{" "}
                {me?.nightlyExportsEnabled ? (
                  <FlowStatusChip kind="approved" label="live" />
                ) : (
                  <FlowStatusChip kind="warn" label="not enabled on this deployment" />
                )}
              </Typography>
            </Stack>
            <Stack direction="row" gap={1.5} alignItems="baseline" sx={{ py: 1 }}>
              <Typography sx={{ fontFamily: "monospace", fontWeight: 700, minWidth: 74 }}>*/5 min</Typography>
              <Typography variant="body2" component="div">
                <strong>Pipeline poll</strong> — advances AI jobs even with no tab open; sweeps stale import locks.{" "}
                <FlowStatusChip kind="approved" label="live" />
              </Typography>
            </Stack>
            <Stack direction="row" gap={1.5} alignItems="baseline" sx={{ py: 1 }}>
              <Typography sx={{ fontFamily: "monospace", fontWeight: 700, minWidth: 74 }}>08:00 UTC</Typography>
              <Typography variant="body2" component="div">
                <strong>Reimport</strong> — chunked self-heal reimport for books with no recent render.{" "}
                <FlowStatusChip kind="warn" label="dormant — not registered in wrangler.toml" />
              </Typography>
            </Stack>
          </Stack>
        </Panel>

        {/* Spare workspace pool */}
        <Panel
          title="Spare workspace pool"
          subtitle="Pre-provisioned D1 bindings, claimed on demand when a new org needs a database."
          action={<Chip size="small" label="Super-admin" color="primary" variant="outlined" />}
          foot={
            <Stack direction="row" flexWrap="wrap" gap={1}>
              <Button size="small" variant="outlined" onClick={loadPool}>
                Refresh pool
              </Button>
              <Button size="small" variant="outlined" onClick={() => setPoolDialog("register")} disabled={!!poolError}>
                Register a slot…
              </Button>
              <Button size="small" variant="contained" onClick={() => setPoolDialog("claim")} disabled={!!poolError}>
                Claim for an org…
              </Button>
            </Stack>
          }
        >
          {poolBusyMessage && (
            <Alert severity={poolBusyMessage.startsWith("Registered") || poolBusyMessage.startsWith("Claimed") ? "success" : "error"} sx={{ mb: 1.5 }} onClose={() => setPoolBusyMessage(null)}>
              {poolBusyMessage}
            </Alert>
          )}
          {poolError && <Alert severity={poolError.status === 403 ? "info" : "error"}>{poolError.message}</Alert>}
          {!poolError && pool === null && <Skeleton variant="rounded" height={100} />}
          {!poolError && pool && (
            <>
              <Stack direction="row" gap={3} sx={{ mb: 1.5 }}>
                <Typography variant="body2">
                  <strong>Claimed slots:</strong> {pool.counts.claimed ?? 0}
                </Typography>
                <Typography variant="body2">
                  <strong>Total slots seen:</strong> {pool.slots.length}
                </Typography>
              </Stack>
              {pool.slots.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No slots registered.
                </Typography>
              ) : (
                <Box sx={{ overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Slug</TableCell>
                        <TableCell>Org</TableCell>
                        <TableCell>Binding</TableCell>
                        <TableCell>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {pool.slots.map((s) => (
                        <TableRow key={s.slug}>
                          <TableCell>{s.slug}</TableCell>
                          <TableCell>{s.org ?? "—"}</TableCell>
                          <TableCell>{s.binding}</TableCell>
                          <TableCell>
                            <FlowStatusChip kind={s.status === "claimed" ? "approved" : "draft"} label={`${s.status}${s.bindingLive === false ? " (binding not live)" : ""}`} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
            </>
          )}
        </Panel>
      </Stack>

      <PoolActionDialog
        kind={poolDialog}
        busy={poolBusy}
        onClose={() => setPoolDialog(null)}
        onRegister={registerSlot}
        onClaim={claimSlot}
      />
    </Box>
    </AdminDesk>
  );
}

// Register/claim both mutate the shared workspace registry — deliberately a
// confirmed dialog rather than a one-click button, mirroring the mockup's
// window.confirm() gate on both actions.
function PoolActionDialog({
  kind,
  busy,
  onClose,
  onRegister,
  onClaim,
}: {
  kind: null | "register" | "claim";
  busy: boolean;
  onClose: () => void;
  onRegister: (binding: string) => void;
  onClaim: (org: string, label: string) => void;
}) {
  const [binding, setBinding] = useState("");
  const [org, setOrg] = useState("");
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (kind === null) {
      setBinding("");
      setOrg("");
      setLabel("");
    }
  }, [kind]);

  if (kind === null) return null;

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{kind === "register" ? "Register a spare-pool slot" : "Claim a slot for an org"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          {kind === "register" ? (
            <TextField
              label="D1 binding name"
              placeholder="e.g. DB_SPARE1"
              value={binding}
              onChange={(e) => setBinding(e.target.value)}
              autoFocus
              fullWidth
            />
          ) : (
            <>
              <TextField label="Org to claim a slot for" value={org} onChange={(e) => setOrg(e.target.value)} autoFocus fullWidth />
              <TextField label="Label for this workspace" value={label} onChange={(e) => setLabel(e.target.value || org)} fullWidth />
            </>
          )}
          <Typography variant="caption" color="text.secondary">
            This mutates the local workspace registry.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {kind === "register" ? (
          <Button variant="contained" disabled={busy || !binding.trim()} onClick={() => onRegister(binding.trim())}>
            {busy ? "Registering…" : "Register"}
          </Button>
        ) : (
          <Button variant="contained" disabled={busy || !org.trim() || !label.trim()} onClick={() => onClaim(org.trim(), label.trim())}>
            {busy ? "Claiming…" : "Claim"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
