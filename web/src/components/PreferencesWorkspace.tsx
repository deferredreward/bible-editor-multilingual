import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SaveIcon from "@mui/icons-material/Save";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import DownloadIcon from "@mui/icons-material/Download";
import UploadIcon from "@mui/icons-material/Upload";
import VisibilityIcon from "@mui/icons-material/Visibility";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  isAdmin,
  isReadOnly,
  REGISTERS,
  TERM_STATUSES,
  type LanePublicState,
  type Register,
  type Term,
  type TermInput,
  type TermStatus,
  type TranslationPrefs,
  type ProjectConfig,
  type Role,
  type LaneReplacementJobResponse,
  type LaneReplacementBook,
  type InferredOrgConfigResponse,
  type WorkMode,
} from "../sync/api";
import {
  useProjectConfig,
  useProjectPresets,
  isTranslationProject,
  selectProjectPreset,
  applyProjectOverrides,
  refreshProjectConfig,
} from "../hooks/useProjectConfig";
import { useWorkMode, effectiveModeFor } from "../hooks/useWorkMode";
import {
  useTranslationPrefs,
  useTerms,
  useExamples,
  useContextExportStatus,
} from "../hooks/useTranslationMemory";
import { MarkdownView } from "./MarkdownView";

const EXPORT_STATUS_I18N_KEY: Record<string, string> = {
  running: "preferences.exportStatus.running",
  failed: "preferences.exportStatus.failed",
  queued: "preferences.exportStatus.queued",
  shrink_refused: "preferences.exportStatus.shrink_refused",
  no_content: "preferences.exportStatus.no_content",
  dry_run: "preferences.exportStatus.dry_run",
};

// Lane replacement/activation errors arrive from the server as bare codes. A few
// (e.g. `lane_busy:sim`) carry a `:detail` suffix; the split below tolerates that
// shape generically. Map known codes to translated copy; fall back to the raw
// string for anything unrecognized so nothing is hidden.
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

export type Section = "brief" | "instructions" | "terminology" | "examples";
export const SECTIONS: Section[] = ["brief", "instructions", "terminology", "examples"];

// Term-status → semantic palette (design §10). Not the violet AI identity —
// status is not an AI-draft state.
function statusColor(status: TermStatus): string {
  switch (status) {
    case "preferred":
      return "success.main";
    case "admitted":
      return "info.main";
    case "forbidden":
      return "error.main";
    case "do_not_translate":
      return "text.primary";
    default:
      return "text.secondary"; // deprecated
  }
}

interface Props {
  onNavigate: (section: Section) => void;
  section: Section;
  role: Role;
}

export function PreferencesWorkspace({ onNavigate, section, role }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const { workMode } = useWorkMode();
  // isTranslation = project CAN translate (capability; unchanged semantics of
  // isTranslationProject). authorMode = the user has switched the per-user
  // toggle to Author on a project that CAN translate — a different case from
  // "this project can't translate at all", so it gets its own copy below.
  const isTranslation = isTranslationProject(cfg);
  const authorMode = isTranslation && effectiveModeFor(workMode, cfg) === "author";
  const memoryAvailable = isTranslation && !authorMode && !isReadOnly();

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail ── */}
      <Box
        sx={{
          width: 240,
          flexShrink: 0,
          borderInlineEnd: "1px solid",
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Stack spacing={1} sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Tooltip title={t("preferences.backToScripture")}>
              <IconButton
                size="small"
                onClick={() => {
                  location.hash = "#/";
                }}
                sx={{ ml: -0.5 }}
              >
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("preferences.title")}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {cfg?.languageTitle ?? cfg?.languageName ?? cfg?.languageCode}
          </Typography>
          <AssistedModeControls />
        </Stack>
        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0, py: 0.5 }}>
          {memoryAvailable && SECTIONS.map((s) => {
            const selected = s === section;
            return (
              <Box
                key={s}
                onClick={() => onNavigate(s)}
                sx={{
                  px: 1.5,
                  py: 0.9,
                  cursor: "pointer",
                  borderInlineStart: "3px solid",
                  borderColor: selected ? "primary.main" : "transparent",
                  bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: selected ? 700 : 400 }}>
                  {t(`preferences.section.${s}`)}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <Box sx={{ maxWidth: 900, mx: "auto", p: 3 }}>
          <WorkModeControl cfg={cfg} role={role} />
          <ProjectModeControl cfg={cfg} role={role} />
          {role === "admin" && cfg && <ScriptureLanesSection cfg={cfg} />}
          {cfg === null ? null : !isTranslation ? (
            <Alert severity="info" variant="outlined">
              {t("preferences.glOnly")}
            </Alert>
          ) : authorMode ? (
            <Alert severity="info" variant="outlined">
              {t("preferences.workMode.hiddenInAuthor")}
            </Alert>
          ) : !memoryAvailable ? (
            <Alert severity="info" variant="outlined">
              {t("preferences.editorOnly")}
            </Alert>
          ) : (
            <>
              {section === "brief" && <BriefSection />}
              {section === "instructions" && <InstructionsSection />}
              {section === "terminology" && <TerminologySection direction={cfg?.direction ?? "ltr"} />}
              {section === "examples" && <ExamplesSection />}
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// ── Scripture Lanes admin section ──────────────────────────────────────────

function ScriptureLanesSection({ cfg }: { cfg: ProjectConfig }) {
  const { t } = useTranslation();
  const lanes: Array<{ key: "lit" | "sim"; label: string }> = [
    {
      key: "lit",
      label:
        (cfg.laneState?.lit?.config?.label && cfg.laneState.lit.config.label !== "LEGACY"
          ? cfg.laneState.lit.config.label
          : null) ||
        (cfg.laneState?.lit?.pendingTarget)?.label ||
        cfg.litLabel ||
        "ULT",
    },
    {
      key: "sim",
      label:
        (cfg.laneState?.sim?.config?.label && cfg.laneState.sim.config.label !== "LEGACY"
          ? cfg.laneState.sim.config.label
          : null) ||
        (cfg.laneState?.sim?.pendingTarget)?.label ||
        cfg.simLabel ||
        "UST",
    },
  ];

  return (
    <Box
      component="section"
      aria-labelledby="scripture-lanes-heading"
      sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, mb: 3 }}
    >
      <Typography id="scripture-lanes-heading" variant="h6" gutterBottom>
        {t("preferences.scriptureLanes.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("preferences.scriptureLanes.intro")}
      </Typography>
      <Stack spacing={2}>
          {lanes.map(({ key, label }) => (
          <LaneCard key={key} lane={key} label={label} cfg={cfg} />
        ))}
      </Stack>
    </Box>
  );
}

function LaneCard({ lane, label, cfg }: { lane: "lit" | "sim"; label: string; cfg: ProjectConfig }) {
  const { t } = useTranslation();
  const state: LanePublicState | undefined = cfg.laneState?.[lane];
  const [saving, setSaving] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [job, setJob] = useState<LaneReplacementJobResponse | null>(null);
  const [activating, setActivating] = useState(false);
  const [busyBook, setBusyBook] = useState<string | null>(null);

  const replacementJobId = state?.replacementJobId ?? null;

  // Poll the job while one is running so per-book staging status + readiness
  // stay live without a manual reload. Stops on a terminal status and refreshes
  // the shared config (which clears replacementJobId, so the poll won't re-arm).
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
          return; // terminal — stop polling
        }
      } catch {
        // transient — keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lane, replacementJobId]);

  if (!state) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {t("preferences.scriptureLanes.noState", { lane: label })}
        </Typography>
      </Box>
    );
  }

  const { config, replacementRequired, configRevision } = state;

  const handleToggle = async (field: "textReadOnly" | "alignmentWritable", value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await api.lanePatch(lane, configRevision, { [field]: value });
      await refreshProjectConfig();
      setSuccessMsg(t("preferences.scriptureLanes.saved"));
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleValidateUrl = async () => {
    if (!sourceUrl.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const result = await api.laneValidate(lane, sourceUrl.trim());
      const confirmMsg = t("preferences.scriptureLanes.confirmReplace", {
        books: result.impactBooks,
        verses: result.impactVerses,
        owner: result.source.owner,
        repo: result.source.repo,
      });
      if (!window.confirm(confirmMsg)) {
        setValidating(false);
        return;
      }
      // When the lane is in BSOJ transitional freeze, the mandatory pending
      // target carries the correct AVD/NAV locks/export — do not inherit the
      // quarantined LEGACY config's false locks / null export.
      const base = replacementRequired && state.pendingTarget ? state.pendingTarget : config;
      const exportCfg =
        base.export ??
        ({
          owner: result.source.owner,
          repo: result.source.repo,
          baseRef: result.source.ref,
          branchPolicy: "contributor_book_branch" as const,
        });
      await api.laneStartReplacement(lane, {
        label: base.label === "LEGACY" ? `${result.source.repo}` : base.label,
        source: result.source,
        export: exportCfg,
        textReadOnly: base.textReadOnly,
        alignmentWritable: base.alignmentWritable,
      }, true);
      await refreshProjectConfig();
      setSourceUrl("");
      setSuccessMsg(t("preferences.scriptureLanes.replacementStarted"));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
    } finally {
      setValidating(false);
    }
  };

  const handleCancel = async () => {
    if (!replacementJobId) return;
    setSaving(true);
    setError(null);
    try {
      await api.laneCancelJob(lane, replacementJobId);
      await refreshProjectConfig();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async () => {
    if (!replacementJobId) return;
    setActivating(true);
    setError(null);
    try {
      // The fencing token guards against a split-brain export completing a
      // stale render after the flip; a fresh UUID per activation is sufficient.
      await api.laneActivate(lane, replacementJobId, crypto.randomUUID());
      await refreshProjectConfig();
      setSuccessMsg(t("preferences.scriptureLanes.replacementActivated"));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
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
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusyBook(null);
    }
  };

  const handleWaiveBook = async (book: string) => {
    if (!replacementJobId) return;
    if (!window.confirm(t("preferences.scriptureLanes.confirmWaiveBook", { book }))) {
      return;
    }
    setBusyBook(book);
    setError(null);
    try {
      await api.laneWaiveBook(lane, replacementJobId, book, true);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
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
          <Typography variant="subtitle1" fontWeight="bold">
            {label}
          </Typography>
          <Chip size="small" label={`${config.source.owner}/${config.source.repo}`} />
          {replacementRequired && (
            <Chip size="small" color="warning" label={t("preferences.scriptureLanes.replacementRequired")} />
          )}
          {replacementJobId && (
            <Chip size="small" color="info" label={t("preferences.scriptureLanes.replacementActive")} />
          )}
        </Stack>

        {replacementRequired && !replacementJobId && state.pendingTarget != null && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t("preferences.scriptureLanes.pendingTargetBanner")}
          </Alert>
        )}

        <Stack direction="row" spacing={2} alignItems="center">
          <FormControlLabel
            control={
              <Switch
                checked={config.textReadOnly}
                onChange={(_, v) => handleToggle("textReadOnly", v)}
                disabled={saving || !!replacementJobId}
                size="small"
              />
            }
            label={t("preferences.scriptureLanes.textReadOnly")}
          />
          <FormControlLabel
            control={
              <Switch
                checked={config.alignmentWritable}
                onChange={(_, v) => handleToggle("alignmentWritable", v)}
                disabled={saving || !!replacementJobId}
                size="small"
              />
            }
            label={t("preferences.scriptureLanes.alignmentWritable")}
          />
        </Stack>

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
                  color="primary"
                  onClick={handleActivate}
                  disabled={activating}
                >
                  {activating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.activate")}
                </Button>
              )}
              <Button size="small" color="error" onClick={handleCancel} disabled={saving}>
                {t("preferences.scriptureLanes.cancel")}
              </Button>
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
                          label={
                            busyBook === b.book ? `${b.book}…` : b.book
                          }
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

        {!replacementJobId && (
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              size="small"
              label={t("preferences.scriptureLanes.sourceUrlLabel")}
              placeholder="https://git.door43.org/owner/repo"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              sx={{ flex: 1, maxWidth: 500 }}
              disabled={validating}
            />
            <Button
              size="small"
              variant="outlined"
              onClick={handleValidateUrl}
              disabled={!sourceUrl.trim() || validating}
            >
              {validating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.changeSource")}
            </Button>
          </Stack>
        )}

        {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
        {successMsg && <Alert severity="success" onClose={() => setSuccessMsg(null)}>{successMsg}</Alert>}
      </Stack>
    </Box>
  );
}

// Per-user Translate/Author toggle (PR C) — "Saved for you", in contrast to
// ProjectModeControl below which is an admin-only, project-wide setting.
// Shown for any non-viewer on a project that CAN translate (isTranslationProject);
// viewers have no write access to the preference and the toggle is
// meaningless on a non-translation project (effective mode is always author).
function WorkModeControl({ cfg, role }: { cfg: ProjectConfig | null; role: Role }) {
  const { t } = useTranslation();
  const { workMode, setWorkMode, failed } = useWorkMode();

  if (role === "viewer" || !isTranslationProject(cfg)) return null;

  const mode: WorkMode = effectiveModeFor(workMode, cfg);

  return (
    <Box
      component="section"
      aria-labelledby="work-mode-heading"
      sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, mb: 3 }}
    >
      <Stack spacing={1.5}>
        <Box>
          <Typography id="work-mode-heading" variant="h6">
            {t("preferences.workMode.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("preferences.workMode.intro")}
          </Typography>
        </Box>
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, next: WorkMode | null) => {
            if (next) setWorkMode(next);
          }}
        >
          <ToggleButton value="translate">{t("preferences.workMode.translate")}</ToggleButton>
          <ToggleButton value="author">{t("preferences.workMode.author")}</ToggleButton>
        </ToggleButtonGroup>
        {failed && <Alert severity="error">{t("preferences.workMode.failed")}</Alert>}
      </Stack>
    </Box>
  );
}

function ProjectModeControl({ cfg, role }: { cfg: ProjectConfig | null; role: Role }) {
  const { t } = useTranslation();
  const presets = useProjectPresets();
  const [selected, setSelected] = useState(cfg?.preset ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ severity: "success" | "error" | "info"; text: string } | null>(null);
  const canChange = role === "admin";

  useEffect(() => {
    if (cfg?.preset) setSelected(cfg.preset);
  }, [cfg?.preset]);

  const apply = async () => {
    if (!cfg || !selected || selected === cfg.preset || !canChange) return;
    setSaving(true);
    setMessage(null);
    try {
      await selectProjectPreset(selected);
      // PUT now returns overlay laneState, but re-fetch so a partial/older
      // worker response cannot leave the shared cache without lane rows.
      await refreshProjectConfig().catch(() => {});
      setMessage({ severity: "success", text: t("preferences.projectModeSaved") });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setMessage({ severity: "error", text: t("preferences.projectModeForbidden") });
      } else if (e instanceof ApiError && e.status === 409) {
        setMessage({ severity: "error", text: t("preferences.projectModeLaneBusy") });
      } else {
        setMessage({ severity: "error", text: t("preferences.projectModeFailed") });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      component="section"
      aria-labelledby="project-mode-heading"
      sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, mb: 3 }}
    >
      <Stack spacing={1.5}>
        <Box>
          <Typography id="project-mode-heading" variant="h6">
            {t("preferences.projectModeTitle")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("preferences.projectModeIntro")}
          </Typography>
        </Box>
        {!cfg ? (
          <CircularProgress size={22} />
        ) : (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "flex-start" }}>
            <TextField
              select
              size="small"
              label={t("preferences.projectModeLabel")}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canChange || saving || presets.length === 0}
              sx={{ minWidth: 320 }}
              helperText={!canChange ? t("preferences.projectModeForbidden") : undefined}
            >
              {presets.map((preset) => (
                <MenuItem key={preset.preset} value={preset.preset}>
                  {preset.isTranslation
                    ? t("preferences.translationPreset", {
                        language: preset.languageTitle,
                        org: preset.org,
                      })
                    : t("preferences.authoringPreset", {
                        language: preset.languageTitle,
                        org: preset.org,
                      })}
                  {!preset.reposVerified ? ` · ${t("preferences.presetUnverified")}` : ""}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              onClick={apply}
              disabled={!canChange || saving || !selected || selected === cfg.preset}
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            >
              {saving ? t("preferences.applyingProjectMode") : t("preferences.applyProjectMode")}
            </Button>
          </Stack>
        )}
        {message && <Alert severity={message.severity}>{message.text}</Alert>}
      </Stack>
      {canChange && <OrgDetectionSection />}
    </Box>
  );
}

const RESOURCE_ROLES = ["lit", "sim", "tn", "tq", "twl", "tw", "ta"] as const;

// PR B: draft-first manifest inference. Detect an org's repos, complete any
// missing/ambiguous roles, choose translationSource/exportOrg explicitly, then
// apply via the custom-gl preset. Applies NOTHING until "Apply" is pressed.
function OrgDetectionSection() {
  const { t } = useTranslation();
  const [org, setOrg] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<InferredOrgConfigResponse | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [translationSourceOn, setTranslationSourceOn] = useState(true);
  const [exportOrg, setExportOrg] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ severity: "success" | "error"; text: string } | null>(null);

  const detect = async () => {
    const trimmed = org.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setDraft(null);
    setMessage(null);
    try {
      const res = await api.getInferredOrgConfig(trimmed);
      setDraft(res);
      setExportOrg(res.proposal.suggestedExportOrg);
      setSelections({});
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string } | undefined)?.error;
        const key = code === "org_not_found" ? "orgNotFound" : code === "dcs_forbidden" ? "forbidden" : null;
        setError(key ? t(`preferences.detectOrg.${key}`) : e.message);
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const complete =
    !!draft &&
    draft.missing.length === 0 &&
    draft.ambiguous.every((a) => !!selections[a.role]);

  const apply = async () => {
    if (!draft || !complete) return;
    setApplying(true);
    setMessage(null);
    try {
      const repos: Record<string, string> = { ...(draft.proposal.repos as Record<string, string>) };
      for (const a of draft.ambiguous) repos[a.role] = selections[a.role];
      const overrides: Record<string, unknown> = {
        org: draft.org,
        exportOrg: exportOrg.trim() || draft.org,
        languageCode: draft.proposal.languageCode ?? draft.org,
        languageName: draft.proposal.languageName ?? draft.org,
        languageTitle: draft.proposal.languageTitle ?? draft.org,
        direction: draft.proposal.direction,
        repos,
        litLabel: draft.proposal.litLabel ?? repos.lit?.toUpperCase() ?? "LIT",
        simLabel: draft.proposal.simLabel ?? repos.sim?.toUpperCase() ?? "SIM",
        translationSource: translationSourceOn
          ? {
              org: "unfoldingWord",
              languageCode: "en",
              repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
            }
          : null,
      };
      await applyProjectOverrides("custom-gl", overrides);
      await refreshProjectConfig().catch(() => {});
      setMessage({ severity: "success", text: t("preferences.detectOrg.applied") });
      setDraft(null);
      setOrg("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMessage({ severity: "error", text: t("preferences.detectOrg.projectNotEmpty") });
      } else {
        setMessage({ severity: "error", text: t("preferences.detectOrg.applyFailed") });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <Box sx={{ borderTop: "1px dashed", borderColor: "divider", pt: 1.5, mt: 1.5 }}>
      <Typography variant="subtitle2">{t("preferences.detectOrg.label")}</Typography>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
        <TextField
          size="small"
          placeholder="BibleEditorMLTest"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          disabled={loading}
        />
        <Button size="small" variant="outlined" onClick={detect} disabled={loading || !org.trim()}>
          {loading ? <CircularProgress size={16} /> : t("preferences.detectOrg.button")}
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
      {draft && (
        <Stack spacing={1} sx={{ mt: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
          {!draft.manifestFound && (
            <Alert severity="warning" variant="outlined">{t("preferences.detectOrg.manifestMissing")}</Alert>
          )}
          {RESOURCE_ROLES.map((role) => {
            const verified = draft.proposal.repos[role];
            const ambiguous = draft.ambiguous.find((a) => a.role === role);
            const missing = draft.missing.includes(role);
            return (
              <Stack key={role} direction="row" spacing={1} alignItems="center">
                <Chip size="small" label={role} sx={{ width: 48 }} />
                {verified ? (
                  <Typography variant="body2">{verified}</Typography>
                ) : ambiguous ? (
                  <TextField
                    select
                    size="small"
                    value={selections[role] ?? ""}
                    onChange={(e) => setSelections((s) => ({ ...s, [role]: e.target.value }))}
                    sx={{ minWidth: 200 }}
                    helperText={t("preferences.detectOrg.ambiguousRole")}
                  >
                    {ambiguous.candidates.map((cand) => (
                      <MenuItem key={cand} value={cand}>
                        {cand}
                      </MenuItem>
                    ))}
                  </TextField>
                ) : missing ? (
                  <Typography variant="body2" color="error.main">
                    {t("preferences.detectOrg.missingRoles")}
                  </Typography>
                ) : null}
              </Stack>
            );
          })}
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={translationSourceOn}
                onChange={(_, v) => setTranslationSourceOn(v)}
              />
            }
            label={t("preferences.detectOrg.translationSourceToggle")}
          />
          <TextField
            size="small"
            label={t("preferences.detectOrg.exportOrgLabel")}
            value={exportOrg}
            onChange={(e) => setExportOrg(e.target.value)}
          />
          <Typography variant="caption" color="text.secondary">
            {t("preferences.detectOrg.laneHint")}
          </Typography>
          <Box>
            <Button variant="contained" onClick={apply} disabled={!complete || applying}>
              {applying ? t("preferences.detectOrg.applying") : t("preferences.detectOrg.apply")}
            </Button>
          </Box>
        </Stack>
      )}
      {message && (
        <Alert severity={message.severity} sx={{ mt: 1 }} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}
    </Box>
  );
}

function AssistedModeControls() {
  const { t } = useTranslation();
  const { prefs, refetch: refetchPrefs } = useTranslationPrefs(true);
  const { status, refetch: refetchStatus } = useContextExportStatus(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const admin = isAdmin();

  const canEnable = admin && status?.status === "success" && !!status.sha;
  const assistedOn = prefs?.assisted_mode === 1;

  const onToggle = async (next: boolean) => {
    if (!admin || !prefs) return;
    if (next && !canEnable) return;
    setBusy(true);
    try {
      await api.putTranslationPrefs(prefs.version, { assisted_mode: next });
      refetchPrefs();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg(t("preferences.saveForbidden"));
      else if (e instanceof ApiError && e.status === 409) {
        setMsg(t("preferences.conflict"));
        refetchPrefs();
      } else setMsg(t("preferences.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    if (!admin) return;
    setBusy(true);
    try {
      await api.runContextExport();
      setMsg(t("preferences.exportQueued"));
      // Poll status a few times so the toggle can enable after success.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        refetchStatus();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg(t("preferences.saveForbidden"));
      else setMsg(t("preferences.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const statusKey = status ? EXPORT_STATUS_I18N_KEY[status.status] : undefined;
  const statusLabel =
    !status || status.status === "never"
      ? t("preferences.exportStatusNever")
      : status.status === "success" && status.sha
        ? t("preferences.exportStatusSuccess", { sha: status.sha.slice(0, 8) })
        : statusKey
          ? t(statusKey)
          : t("preferences.exportStatusOther", { status: status.status });

  const toggleTooltip = !admin
    ? t("preferences.assistedModeAdminOnly")
    : canEnable
      ? t("preferences.assistedModeHelp")
      : t("preferences.assistedModeDisabled");

  return (
    <Stack spacing={0.75}>
      <Tooltip title={toggleTooltip}>
        <span>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={assistedOn}
                disabled={!admin || busy || (!canEnable && !assistedOn)}
                onChange={(_, checked) => void onToggle(checked)}
              />
            }
            label={
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {assistedOn ? t("preferences.assistedModeOn") : t("preferences.assistedModeOff")}
              </Typography>
            }
            sx={{ m: 0, alignItems: "center" }}
          />
        </span>
      </Tooltip>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
        {statusLabel}
      </Typography>
      {!admin && (
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
          {t("preferences.assistedModeAdminOnly")}
        </Typography>
      )}
      <Tooltip title={admin ? "" : t("preferences.assistedModeAdminOnly")}>
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={!admin || busy}
            onClick={() => void onExport()}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("preferences.exportNow")}
          </Button>
        </span>
      </Tooltip>
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg} />
    </Stack>
  );
}

// ── Shared save-state helper ───────────────────────────────────────────────
function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}

// ── Brief ──────────────────────────────────────────────────────────────────
function BriefSection() {
  const { t } = useTranslation();
  const { prefs, loading, refetch } = useTranslationPrefs(true);
  const [draft, setDraft] = useState<TranslationPrefs | null>(null);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setDraft(prefs);
  }, [prefs]);

  const onSave = async () => {
    if (!draft || !prefs) return;
    save.setSaving(true);
    try {
      await api.putTranslationPrefs(prefs.version, {
        audience: draft.audience,
        purpose: draft.purpose,
        register: draft.register,
        script_notes: draft.script_notes,
        notes: draft.notes,
        // brief section doesn't own instructions/assisted — omit so the server
        // merges the existing values.
      });
      save.setMsg(t("preferences.saved"));
      refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else's write won — reload their version so the next save
        // has the right If-Match. Any other failure keeps the user's draft
        // as-is (refetch() would otherwise clobber unsaved typing).
        save.setMsg(t("preferences.conflict"));
        refetch();
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("preferences.saveForbidden"));
      } else {
        save.setMsg(t("preferences.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  if (loading && !draft) return <CircularProgress size={22} />;
  if (!draft) return null;

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("preferences.section.brief")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.briefIntro")}
      </Typography>
      <TextField
        label={t("preferences.audience")}
        value={draft.audience ?? ""}
        onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        label={t("preferences.purpose")}
        value={draft.purpose ?? ""}
        onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        select
        label={t("preferences.register")}
        value={draft.register}
        onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
        sx={{ maxWidth: 240 }}
        size="small"
        helperText={t("preferences.registerHelp")}
      >
        {REGISTERS.map((r) => (
          <MenuItem key={r} value={r}>
            {t(`preferences.register.${r}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={t("preferences.scriptNotes")}
        value={draft.script_notes ?? ""}
        onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

// ── Instructions ─────────────────────────────────────────────────────────────
function InstructionsSection() {
  const { t } = useTranslation();
  const { prefs, loading, refetch } = useTranslationPrefs(true);
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setValue(prefs.instructions_md ?? "");
  }, [prefs]);

  const onSave = async () => {
    if (!prefs) return;
    save.setSaving(true);
    try {
      await api.putTranslationPrefs(prefs.version, { instructions_md: value || null });
      save.setMsg(t("preferences.saved"));
      refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        save.setMsg(t("preferences.conflict"));
        refetch();
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("preferences.saveForbidden"));
      } else {
        save.setMsg(t("preferences.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  if (loading && !prefs) return <CircularProgress size={22} />;

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">{t("preferences.section.instructions")}</Typography>
        <ToggleButton
          size="small"
          value="preview"
          selected={preview}
          onChange={() => setPreview((p) => !p)}
          sx={{ textTransform: "none", py: 0.25 }}
        >
          <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
          {t("preferences.preview")}
        </ToggleButton>
      </Stack>
      <Alert severity="info" variant="outlined" sx={{ py: 0.25 }}>
        {t("preferences.instructionsIntro")}
      </Alert>
      {preview ? (
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, minHeight: 200 }}>
          <MarkdownView markdown={value || "_" + t("preferences.empty") + "_"} />
        </Box>
      ) : (
        <TextField
          value={value}
          onChange={(e) => setValue(e.target.value)}
          multiline
          minRows={10}
          fullWidth
          placeholder={t("preferences.instructionsPlaceholder")}
          slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
        />
      )}
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

// ── Terminology ──────────────────────────────────────────────────────────────
function StatusChip({ status }: { status: TermStatus }) {
  const { t } = useTranslation();
  const color = statusColor(status);
  return (
    <Chip
      label={t(`preferences.status.${status}`)}
      size="small"
      variant="outlined"
      sx={{ height: 18, fontSize: 10, fontWeight: 600, color, borderColor: color }}
    />
  );
}

function TerminologySection({ direction }: { direction: "ltr" | "rtl" }) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { terms, loading, refetch } = useTerms(true, {
    status: statusFilter || undefined,
    q: debouncedQ || undefined,
  });
  const [importOpen, setImportOpen] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  const onExport = () => {
    const a = document.createElement("a");
    a.href = api.termsExportPath();
    a.download = "terminology.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Typography variant="h6">{t("preferences.section.terminology")}</Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<UploadIcon />} onClick={() => setImportOpen((v) => !v)}>
            {t("preferences.import")}
          </Button>
          <Button size="small" startIcon={<DownloadIcon />} onClick={onExport}>
            {t("preferences.export")}
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.terminologyIntro")}
      </Typography>

      {importOpen && (
        <ImportPanel onApplied={refetch} onError={() => save.setMsg(t("preferences.actionFailed"))} />
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.statusFilter")}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t("preferences.allStatuses")}</MenuItem>
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <NewTermRow direction={direction} onCreated={refetch} onError={() => save.setMsg(t("preferences.saveFailed"))} />

      {loading && terms.length === 0 ? (
        <CircularProgress size={22} />
      ) : terms.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noTerms")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {terms.map((term) => (
            <TermRow
              key={term.id}
              term={term}
              direction={direction}
              onChanged={refetch}
              onError={(msg) => save.setMsg(msg)}
            />
          ))}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

function NewTermRow({
  direction,
  onCreated,
  onError,
}: {
  direction: "ltr" | "rtl";
  onCreated: () => void;
  onError: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TermInput>({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
  const [busy, setBusy] = useState(false);
  const canAdd =
    draft.concept_id.trim() &&
    draft.source_term.trim() &&
    // A forbidden entry always needs its "use instead" pointer (design §5.1) —
    // the server rejects this too, but disabling Add here avoids a round trip.
    (draft.status !== "forbidden" || !!draft.replacement?.trim());

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await api.createTerm({
        concept_id: draft.concept_id.trim(),
        source_term: draft.source_term.trim(),
        target_term: draft.target_term?.trim() || null,
        status: draft.status,
        // replacement only means anything for forbidden — force it null
        // otherwise so switching the status field away from forbidden can't
        // leave a stale value behind (the field stays in local draft state
        // even when hidden from the form).
        replacement: draft.status === "forbidden" ? draft.replacement?.trim() || null : null,
      });
      setDraft({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
      onCreated();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
        <TextField
          size="small"
          label={t("preferences.conceptId")}
          value={draft.concept_id}
          onChange={(e) => setDraft({ ...draft, concept_id: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.sourceTerm")}
          value={draft.source_term}
          onChange={(e) => setDraft({ ...draft, source_term: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.targetTerm")}
          value={draft.target_term ?? ""}
          onChange={(e) => setDraft({ ...draft, target_term: e.target.value })}
          sx={{ width: 160 }}
          slotProps={{ htmlInput: { dir: direction } }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.termStatus")}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
          sx={{ width: 160 }}
        >
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
        {draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            sx={{ width: 160 }}
            slotProps={{ htmlInput: { dir: direction } }}
          />
        )}
        <Button variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={!canAdd || busy}>
          {t("preferences.addTerm")}
        </Button>
      </Stack>
    </Box>
  );
}

function TermRow({
  term,
  direction,
  onChanged,
  onError,
}: {
  term: Term;
  direction: "ltr" | "rtl";
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Term>(term);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(term), [term]);

  const saveEdit = async () => {
    setBusy(true);
    try {
      await api.patchTerm(term.id, term.version, {
        target_term: draft.target_term,
        status: draft.status,
        // Same stale-replacement guard as NewTermRow.add — see that comment.
        replacement: draft.status === "forbidden" ? draft.replacement : null,
        comment: draft.comment,
        tw_link: draft.tw_link,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      // A 409 means someone else edited this term first — refresh the row so
      // the retry has the right version instead of leaving a stale, silently
      // un-saved edit in place.
      if (e instanceof ApiError && e.status === 409) {
        onError(t("preferences.conflict"));
        onChanged();
      } else {
        onError(t("preferences.actionFailed"));
      }
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteTerm(term.id);
      onChanged();
    } catch {
      onError(t("preferences.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        p: 1.25,
        bgcolor: (theme) =>
          term.status === "forbidden" ? alpha(theme.palette.error.main, 0.05) : "transparent",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" gap={0.5}>
        <Chip label={term.concept_id} size="small" variant="outlined" sx={{ height: 20, fontFamily: "monospace", fontSize: 11 }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {term.source_term}
        </Typography>
        <Typography variant="body2" color="text.disabled">
          {t("preferences.termArrow")}
        </Typography>
        {editing ? (
          <TextField
            size="small"
            value={draft.target_term ?? ""}
            onChange={(e) => setDraft({ ...draft, target_term: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 180 }}
          />
        ) : (
          <Typography variant="body2" dir={direction} sx={{ fontWeight: 600 }}>
            {term.target_term ?? t("preferences.noRendering")}
          </Typography>
        )}
        {editing ? (
          <TextField
            select
            size="small"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
            sx={{ width: 150 }}
          >
            {TERM_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {t(`preferences.status.${s}`)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <StatusChip status={term.status} />
        )}
        {term.status === "forbidden" && !editing && term.replacement && (
          <Typography variant="caption" color="error.main">
            {t("preferences.useInstead", { term: term.replacement })}
          </Typography>
        )}
        {editing && draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 150 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {editing ? (
          <>
            <Button
              size="small"
              onClick={saveEdit}
              disabled={busy || (draft.status === "forbidden" && !draft.replacement?.trim())}
            >
              {t("preferences.save")}
            </Button>
            <Button size="small" color="inherit" onClick={() => { setEditing(false); setDraft(term); }}>
              {t("preferences.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button size="small" onClick={() => setEditing(true)}>
              {t("preferences.edit")}
            </Button>
            <Tooltip title={t("preferences.delete")}>
              <IconButton size="small" onClick={del} disabled={busy}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      {term.tw_link && !editing && (
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {term.tw_link}
        </Typography>
      )}
    </Box>
  );
}

function ImportPanel({ onApplied, onError }: { onApplied: () => void; onError: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ added: number; updated: number; total: number; errors: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await api.importTerms(text, dryRun);
      setResult({ added: res.added, updated: res.updated, total: res.total, errors: res.parseErrors.length });
      // Refresh the term list but keep the panel open — the added/updated/error
      // counts above are the whole point of a real (non-dry-run) import and
      // must stay visible until the user is done reviewing them.
      if (!dryRun) onApplied();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {t("preferences.importTitle")}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t("preferences.importHelp")}
      </Typography>
      <TextField
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
        minRows={5}
        fullWidth
        placeholder={t("preferences.csvColumnPlaceholder")}
        sx={{ mt: 1 }}
        slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 12 } } }}
      />
      {result && (
        <Alert severity={result.errors ? "warning" : "success"} sx={{ mt: 1, py: 0.25 }}>
          {t("preferences.importResult", { added: result.added, updated: result.updated, errors: result.errors })}
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" onClick={() => run(true)} disabled={busy || !text.trim()}>
          {t("preferences.dryRun")}
        </Button>
        <Button size="small" variant="contained" onClick={() => run(false)} disabled={busy || !text.trim()}>
          {t("preferences.applyImport")}
        </Button>
      </Stack>
    </Box>
  );
}

// ── Examples ─────────────────────────────────────────────────────────────────
function ExamplesSection() {
  const { t } = useTranslation();
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { examples, loading, refetch } = useExamples(true, { resource, q: debouncedQ || undefined, limit: 200 });
  const { prefs } = useTranslationPrefs(true);
  const { status } = useContextExportStatus(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // 4-char row IDs are only unique per book (migration 0015's composite PK) —
  // /examples browses across all books, so both the React key and the busy
  // token below must be `book:id`, not bare `id`.
  const revoke = async (id: string, book: string) => {
    setBusyId(`${book}:${id}`);
    try {
      if (resource === "tn") await api.validateNote(id, book, false);
      else await api.validateQuestion(id, book, false);
      refetch();
    } catch {
      save.setMsg(t("preferences.actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const count = examples.length;
  const feedingAi = prefs?.assisted_mode === 1 && status?.status === "success" && !!status.sha;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h6">{t("preferences.section.examples")}</Typography>
        <Chip
          size="small"
          label={feedingAi ? t("preferences.feedingAi") : t("preferences.notFeedingAi")}
          color={feedingAi ? "success" : "default"}
          variant="outlined"
          sx={{ height: 18, fontSize: 10, fontWeight: 600 }}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.examplesIntro")}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={resource}
          onChange={(_, v) => v && setResource(v)}
        >
          <ToggleButton value="tn" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.notes")}
          </ToggleButton>
          <ToggleButton value="tq" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.questions")}
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <Typography variant="caption" color="text.secondary">
          {t("preferences.examplesCount", { n: count })}
        </Typography>
      </Stack>

      {loading && examples.length === 0 ? (
        <CircularProgress size={22} />
      ) : examples.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noExamples")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {examples.map((ex) => (
            <Box
              key={`${ex.book}:${ex.id}`}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                p: 1.25,
                borderInlineStart: "3px solid",
                borderInlineStartColor: "success.main",
                bgcolor: (theme) => alpha(theme.palette.success.main, 0.05),
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <Chip
                  label={`${ex.book} ${ex.ref_raw}`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: 11 }}
                />
                {ex.support_reference && (
                  <Chip label={ex.support_reference} size="small" sx={{ height: 20, fontSize: 10 }} />
                )}
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => revoke(ex.id, ex.book)}
                  disabled={busyId === `${ex.book}:${ex.id}`}
                >
                  {t("preferences.revoke")}
                </Button>
              </Stack>
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>
                {resource === "tn" ? ex.note : `${ex.question ?? ""}\n${ex.response ?? ""}`}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}
