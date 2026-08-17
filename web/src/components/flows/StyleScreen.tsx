// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// l2-style: "Teach the AI our style" (Lead). Port of docs/flows/ui/l2-style.html.
// Post-#187 this screen owns ONLY the style-specific surfaces: context-pack
// export status, QA rules preview, and the templates-coverage pointer.
//
// The memory sections (Brief / Instructions / Common issues / Terminology /
// Examples) that used to be duplicated here were removed in #187 — their
// canonical home is now the admin Setup page (AdminSetupScreen), with classic
// PreferencesWorkspace keeping its copy until classic retires. The shared-
// version / 409-conflict save logic for those sections lives with those owners
// now, not here.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { api, ApiError } from "../../sync/api";
import { setProjectMode, useProjectConfig } from "../../hooks/useProjectConfig";
import { useContextExportStatus } from "../../hooks/useTranslationMemory";

export interface StyleScreenProps extends FlowScreenContext {}

type SectionKey = "qa" | "templates";

const SECTION_LABELS: Array<{ key: SectionKey; label: string }> = [
  { key: "qa", label: "QA rules" },
  { key: "templates", label: "Templates" },
];

// Server-reported export states, spelled out in plain English. Anything not in
// this map is shown verbatim rather than being smoothed into a friendly lie.
const EXPORT_STATUS_LABELS: Record<string, string> = {
  success: "ready",
  never: "never generated",
  queued: "queued",
  running: "running",
  failed: "last run failed",
  shrink_refused: "refused by the shrink guard",
  no_content: "nothing to export",
  dry_run: "dry run only (nothing committed)",
};

function scrollToSection(key: SectionKey) {
  document.getElementById(`style-sec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Panel chrome (mirrors .panel / .panel-top / .panel-body / .panel-foot) ──
function Panel({
  id,
  title,
  intro,
  headerExtra,
  footState,
  footActions,
  children,
}: {
  id: SectionKey;
  title: string;
  intro: string;
  headerExtra?: ReactNode;
  footState?: ReactNode;
  footActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      id={`style-sec-${id}`}
      aria-labelledby={`style-sec-${id}-heading`}
      sx={{
        scrollMarginBlockStart: "16px",
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
        overflow: "hidden",
      }}
    >
      <Box sx={{ p: 2, borderBlockEnd: 1, borderColor: "divider" }}>
        <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
          <Typography id={`style-sec-${id}-heading`} variant="h6" sx={{ fontSize: "1rem" }}>
            {title}
          </Typography>
          {headerExtra}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {intro}
        </Typography>
      </Box>
      <Box sx={{ p: 2 }}>{children}</Box>
      {(footState || footActions) && (
        <Stack
          direction="row"
          alignItems="center"
          flexWrap="wrap"
          gap={1.5}
          sx={{ px: 2, py: 1.25, borderBlockStart: 1, borderColor: "divider", bgcolor: "action.hover" }}
        >
          <Typography variant="caption" color="text.secondary">
            {footState}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {footActions}
        </Stack>
      )}
    </Box>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────
export default function StyleScreen({ role, me }: StyleScreenProps) {
  const cfg = useProjectConfig();

  const [current, setCurrent] = useState<SectionKey>("qa");

  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : "Workspace";

  return (
    <AdminDesk current="style">
    <Box sx={{ pb: 8 }}>
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2 }}>
        <AdminPageHeader
          eyebrow={eyebrow}
          title="Style"
          subtitle="Teach the AI our style — context pack and QA rules every AI draft is written against."
        />
        <PackStatusBar role={role} />

        <Box
          sx={{
            display: "grid",
            gap: 2.5,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "220px minmax(0, 1fr)" },
            alignItems: "start",
          }}
        >
          {/* Rail: sticky column at ≥900px, horizontally scrollable strip below. */}
          <Box
            component="nav"
            aria-label="Preference sections"
            sx={{
              position: { xs: "static", md: "sticky" },
              insetBlockStart: { md: 16 },
              display: "flex",
              flexDirection: { xs: "row", md: "column" },
              overflowX: { xs: "auto", md: "visible" },
              gap: 0.5,
              p: 1,
              bgcolor: "background.paper",
              border: 1,
              borderColor: "divider",
              borderRadius: 1.5,
            }}
          >
            {SECTION_LABELS.map(({ key, label }) => {
              const selected = key === current;
              return (
                <Box
                  key={key}
                  component="button"
                  type="button"
                  onClick={() => {
                    setCurrent(key);
                    scrollToSection(key);
                  }}
                  aria-current={selected ? "true" : undefined}
                  sx={{
                    appearance: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minHeight: 40,
                    whiteSpace: "nowrap",
                    textAlign: "start",
                    borderRadius: 1,
                    paddingBlock: 1,
                    paddingInline: 1.375,
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    fontFamily: "inherit",
                    bgcolor: selected ? "action.selected" : "transparent",
                    color: selected ? "text.primary" : "text.secondary",
                    "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                  }}
                >
                  {label}
                </Box>
              );
            })}
          </Box>

          <Stack spacing={2}>
            <QaRulesSection />
            <TemplatesSection />

            {me?.workspace && (
              <Typography variant="caption" color="text.secondary">
                Workspace: {me.workspace}
              </Typography>
            )}
          </Stack>
        </Box>
      </Box>
    </Box>
    </AdminDesk>
  );
}

// ── Context-pack export status ──────────────────────────────────────────────
// The trust indicator. Everything here is the server's own report; when there
// is no committed pack (the dev workspace reports
// `status: "dry_run", failureReason: "no_service_token"`) we say exactly that
// rather than implying the AI has a pack to read.
function PackStatusBar({ role }: { role: "admin" | "editor" | "viewer" }) {
  const admin = role === "admin";
  const { status, loading, error, refetch } = useContextExportStatus(role !== "viewer");
  const cfg = useProjectConfig();
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const runExport = async (shrinkOverride: boolean) => {
    setBusy(true);
    // Clear any earlier 403 verdict before asking again — a role change (or a
    // workspace switch) can make this allowed, and a latched flag would keep
    // claiming the status isn't visible forever.
    setForbidden(false);
    try {
      const res = await api.runContextExport(shrinkOverride ? { shrinkOverride: true } : undefined);
      setMsg(`Export queued (${res.id})`);
      // The workflow is async; poll a few times so the chip converges without a
      // manual reload. No claim is made about success until the status says so.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        refetch();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg("Running exports is admin-only");
      else if (e instanceof ApiError && e.status === 409) setMsg("An export was just queued — wait a moment and retry");
      else setMsg("Couldn't start the export");
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = async (next: "authoring" | "translation") => {
    setModeBusy(true);
    try {
      const updated = await setProjectMode(next);
      setMsg(`Mode set to ${updated.mode}`);
    } catch (e) {
      // Never flip the switch optimistically: on failure it keeps showing the
      // server's actual mode (cfg is unchanged), not the opposite of it.
      if (e instanceof ApiError && e.status === 403) setMsg("Changing project mode is admin-only");
      else setMsg("Couldn't change the project mode");
    } finally {
      setModeBusy(false);
    }
  };

  // Two-way, not latching: the hook clears `error` at the start of every fetch,
  // so a later successful read must also clear this flag.
  useEffect(() => {
    setForbidden(error instanceof ApiError && error.status === 403);
  }, [error]);

  let chipText: string;
  if (role === "viewer" || forbidden) chipText = "Export status isn't visible for your role";
  else if (loading && !status) chipText = "Loading export status…";
  else if (!status) chipText = "Export status unavailable";
  else if (status.sha) chipText = `Context pack ready — ${status.sha.slice(0, 8)}`;
  else chipText = `No context pack exported yet (${EXPORT_STATUS_LABELS[status.status] ?? status.status})`;

  const detailBits: string[] = [];
  if (status) {
    detailBits.push(`${status.terms} terms`);
    detailBits.push(`${status.examplesTn} tN examples`);
    detailBits.push(`${status.examplesTq} tQ examples`);
    if (status.failureReason) detailBits.push(`blocked: ${status.failureReason}`);
  }

  const mode = cfg?.mode ?? null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 1.25,
        p: 1.75,
        mb: 2,
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
      }}
    >
      <Chip
        size="small"
        label={chipText}
        sx={{
          fontWeight: 600,
          borderRadius: 999,
          bgcolor: "action.selected",
          color: "text.primary",
          height: "auto",
          py: 0.5,
          "& .MuiChip-label": { whiteSpace: "normal" },
        }}
      />

      <Box sx={{ flex: 1, minWidth: 8 }} />

      <FormControlLabel
        sx={{ mr: 0 }}
        control={
          <Switch
            size="small"
            checked={mode === "translation"}
            disabled={!admin || mode === null || modeBusy}
            onChange={(_, checked) => void toggleMode(checked ? "translation" : "authoring")}
          />
        }
        label={
          <Typography variant="body2">
            Project mode: {mode ?? "loading…"}
            {!admin && " (admin-only)"}
          </Typography>
        }
      />

      <Tooltip title={admin ? "" : "Running exports is admin-only"}>
        <span>
          <Button size="small" variant="outlined" disabled={!admin || busy} onClick={() => void runExport(false)}>
            Export now
          </Button>
        </span>
      </Tooltip>
      {/* Force is not a hidden double-click easter egg like the mockup — it
          appears exactly when the server says the shrink guard refused. */}
      {admin && status?.status === "shrink_refused" && (
        <Button size="small" variant="outlined" color="warning" disabled={busy} onClick={() => void runExport(true)}>
          Export (force)
        </Button>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ flexBasis: "100%" }}>
        The pack is a git-committed snapshot the AI reads from — a run records the exact commit it used, so
        it stays reproducible even if the pack changes later.
        {detailBits.length > 0 && ` Last export snapshot — ${detailBits.join(", ")}.`}
      </Typography>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}



// ── QA rules ────────────────────────────────────────────────────────────────
// Designed, not built. The structural tN checks named here really do run at
// apply time in the server code; what does not exist is any endpoint for
// enabling, tuning, or adding rules — so this section reads its own state
// honestly instead of pretending to be a live config surface.
const QA_RULES: Array<{ name: string; severity: "error" | "warning" }> = [
  { name: "Quote column untouched", severity: "error" },
  { name: "Empty translation", severity: "error" },
  { name: "Repeated word", severity: "warning" },
  { name: "Terminology enforcement", severity: "warning" },
];

function QaRulesSection() {
  return (
    <Panel
      id="qa"
      title="QA rules"
      intro="Deterministic checks with severities. The structural note checks (quote / ID / reference integrity) already run when a draft is applied; this screen for enabling, tuning, and adding rules is designed but not built."
      headerExtra={<FlowStatusChip kind="edited" label="Design-complete, build-deferred" />}
      footState="No API exists for this section yet"
    >
      <Stack spacing={1}>
        {QA_RULES.map((rule) => (
          <Stack key={rule.name} direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" sx={{ flex: 1 }}>
              {rule.name}
            </Typography>
            <FlowStatusChip kind={rule.severity === "error" ? "warn" : "edited"} label={rule.severity} />
          </Stack>
        ))}
      </Stack>
    </Panel>
  );
}

// ── Templates pointer ───────────────────────────────────────────────────────
function TemplatesSection() {
  const [units, setUnits] = useState<{ support_ref: string; has_target: 0 | 1 }[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getTemplates()
      .then((res) => {
        if (!cancelled) setUnits(res.units.map((u) => ({ support_ref: u.support_ref, has_target: u.has_target })));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const coverage = useMemo(() => {
    if (!units) return null;
    const byRef = new Map<string, boolean>();
    for (const u of units) {
      byRef.set(u.support_ref, (byRef.get(u.support_ref) ?? false) || u.has_target === 1);
    }
    const total = byRef.size;
    const translated = [...byRef.values()].filter(Boolean).length;
    return { total, translated, units: units.length };
  }, [units]);

  return (
    <Panel
      id="templates"
      title="Templates"
      intro="Coverage summary for per-SupportReference note templates. Full curation — draft, save, approve, history — lives on its own screen."
      footState="Curate templates on the dedicated screen"
      footActions={
        <Button size="small" variant="contained" href="#/curate">
          Open template curation →
        </Button>
      }
    >
      {failed ? (
        <Alert severity="error">Couldn't load template coverage.</Alert>
      ) : !coverage ? (
        <CircularProgress size={22} />
      ) : (
        <Stack spacing={0.5}>
          <Typography variant="body2">
            {coverage.translated} of {coverage.total} SupportReference types have a translated unit
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {coverage.units} template units in this workspace
          </Typography>
        </Stack>
      )}
    </Panel>
  );
}
