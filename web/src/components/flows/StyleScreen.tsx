// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// l2-style: "Teach the AI our style" (Lead). Port of docs/flows/ui/l2-style.html.
// IA per that mockup: context-pack export status · Brief · Instructions +
// Common issues · Terminology · Examples · QA rules · Templates pointer.
//
// Two hard-won invariants are carried over from PreferencesWorkspace (PR #146)
// and must not be re-litigated here:
//
//  1. ONE shared version. Brief, Instructions and Common issues all live in the
//     single `translation_prefs` row, so they share one version number. The
//     `useTranslationPrefs` hook is lifted to this screen (not per-section) so a
//     save from any section updates the version every other section will send as
//     `If-Match` on its next save. A never-saved project returns a synthetic row
//     with `version: 0` (not a 404), and the first write MUST still send
//     `If-Match: 0` — `api.putTranslationPrefs` always sends the header, so
//     passing `prefs.version` through is exactly right; omitting it would 428.
//  2. A 409 KEEPS the user's edits. Every editor seeds its local draft from
//     `prefs` exactly once, so a sibling section's save can never overwrite text
//     being typed. On a 409 we adopt the server's fresh row from the conflict
//     body (`currentPrefsFromConflict`) purely to fix the version for the retry,
//     and leave the on-screen draft alone. Nothing the user typed is discarded.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import SaveIcon from "@mui/icons-material/Save";
import UploadIcon from "@mui/icons-material/Upload";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader, workspaceEyebrow } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  isReadOnly,
  REGISTERS,
  TERM_STATUSES,
  type Register,
  type Term,
  type TermImportResult,
  type TermInput,
  type TermStatus,
  type TranslationExample,
  type TranslationPrefs,
  type TranslationPrefsInput,
} from "../../sync/api";
import { isTranslationProject, setProjectMode, useProjectConfig } from "../../hooks/useProjectConfig";
import {
  useContextExportStatus,
  useExamples,
  useTerms,
  useTranslationPrefs,
} from "../../hooks/useTranslationMemory";
import { currentPrefsFromConflict } from "../../sync/prefsConflict";
import { getWorkspaceSlug } from "../../sync/workspace";

export interface StyleScreenProps extends FlowScreenContext {}

type SectionKey = "brief" | "instructions" | "terminology" | "examples" | "qa" | "templates";

const SECTION_LABELS: Array<{ key: SectionKey; label: string }> = [
  { key: "brief", label: "Brief" },
  { key: "instructions", label: "Instructions" },
  { key: "terminology", label: "Terminology" },
  { key: "examples", label: "Examples" },
  { key: "qa", label: "QA rules" },
  { key: "templates", label: "Templates" },
];

const INSTRUCTIONS_MAX = 20000;
const COMMON_ISSUES_MAX = 50000;

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

const TERM_STATUS_LABELS: Record<TermStatus, string> = {
  preferred: "Preferred",
  admitted: "Admitted",
  deprecated: "Deprecated",
  forbidden: "Forbidden",
  do_not_translate: "Do not translate",
};

function scrollToSection(key: SectionKey) {
  document.getElementById(`style-sec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function timeAgo(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "never saved";
  const mins = Math.round((Date.now() - unixSeconds * 1000) / 60000);
  if (mins < 1) return "saved just now";
  if (mins < 60) return `saved ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `saved ${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  return `saved ${Math.round(hrs / 24)} day(s) ago`;
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
  const isTranslation = isTranslationProject(cfg);
  // Same gate PreferencesWorkspace uses: the memory endpoints only exist for a
  // translation project, and a viewer JWT can't write.
  const memoryAvailable = isTranslation && !isReadOnly();
  const admin = role === "admin";

  // ONE hook for the whole screen — see the header comment (invariant 1).
  const prefsState = useTranslationPrefs(memoryAvailable);

  const [current, setCurrent] = useState<SectionKey>("brief");
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState<Partial<Record<SectionKey, boolean>>>({});
  const markDirty = useCallback((key: SectionKey, value: boolean) => {
    setDirty((d) => (d[key] === value ? d : { ...d, [key]: value }));
  }, []);
  const unsavedCount = Object.values(dirty).filter(Boolean).length;

  const onConflict = useCallback(() => setConflict(true), []);
  const eyebrow = workspaceEyebrow(cfg);

  return (
    <AdminDesk current="style">
      <AdminPageHeader
        eyebrow={eyebrow}
        title="Style"
        subtitle="Teach the AI your project's style — brief, instructions, terminology, examples, and QA rules."
      />

      <Box sx={{ pb: 8 }}>
        <PackStatusBar role={role} />

        {/* A real 409 from the shared prefs row. Never auto-dismissed: the user
            decides when they've read it. Their edits are still on screen. */}
        {conflict && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => setConflict(false)}>
                Keep my edits &amp; continue
              </Button>
            }
          >
            <strong>Someone else saved preferences first.</strong> Everything you typed is still here —
            we only picked up their version number so your next Save goes through.
          </Alert>
        )}

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
                  {dirty[key] && (
                    <Box
                      aria-label="unsaved changes"
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        flex: "none",
                        marginInlineStart: "auto",
                        bgcolor: (theme) => theme.palette.flows.warn.main,
                      }}
                    />
                  )}
                </Box>
              );
            })}
          </Box>

          <Stack spacing={2}>
            {unsavedCount > 0 && (
              <Typography variant="caption" color="text.secondary">
                {unsavedCount} unsaved {unsavedCount === 1 ? "section" : "sections"} — nothing leaves this
                browser until you press Save.
              </Typography>
            )}

            {cfg === null ? (
              <CircularProgress size={22} />
            ) : !isTranslation ? (
              <Alert severity="info" variant="outlined">
                This project is in authoring mode, so there is no translation memory to teach. The AI
                preferences below apply to translation projects only.
              </Alert>
            ) : !memoryAvailable ? (
              <Alert severity="info" variant="outlined">
                Your role is read-only, so translation preferences aren't editable here.
              </Alert>
            ) : (
              <>
                <BriefSection
                  prefsState={prefsState}
                  canSave={admin}
                  onConflict={onConflict}
                  onDirty={(v) => markDirty("brief", v)}
                />
                <InstructionsSection
                  prefsState={prefsState}
                  canSave={admin}
                  onConflict={onConflict}
                  onDirty={(v) => markDirty("instructions", v)}
                />
                <TerminologySection direction={cfg?.direction ?? "ltr"} canEdit={admin} />
                <ExamplesSection canRevoke={!isReadOnly()} />
              </>
            )}

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

// ── Shared prefs plumbing ───────────────────────────────────────────────────
type PrefsState = ReturnType<typeof useTranslationPrefs>;

/**
 * The one place a prefs PUT is issued. `prefs.version` is passed straight
 * through as `If-Match` — including the `0` of a never-saved row, which is the
 * documented first-write case (the GET returns a synthetic version-0 row, and
 * omitting the header would 428 `if_match_required`).
 *
 * On 409 the caller's on-screen draft is deliberately left untouched; we adopt
 * only the server's version so the retry lands.
 */
async function savePrefs(
  prefsState: PrefsState,
  patch: Partial<TranslationPrefsInput>,
  onConflict: () => void,
): Promise<"saved" | "conflict" | "forbidden" | "precondition" | "too_long" | "failed"> {
  const { prefs, apply, refetch } = prefsState;
  if (!prefs) return "failed";
  try {
    const res = await api.putTranslationPrefs(prefs.version, patch);
    apply(res.prefs);
    return "saved";
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const current = currentPrefsFromConflict(e.body);
      if (current) apply(current);
      else refetch();
      onConflict();
      return "conflict";
    }
    if (e instanceof ApiError && e.status === 403) return "forbidden";
    // 428 is a client bug, not a merge conflict — re-read and let the user retry.
    if (e instanceof ApiError && e.status === 428) {
      refetch();
      return "precondition";
    }
    if (e instanceof ApiError && e.status === 400) return "too_long";
    return "failed";
  }
}

/**
 * Lost-update guard, shared by the two sections that write the one prefs row.
 *
 * Seeding a draft exactly once protects typing, but it also freezes the draft
 * against the row as it looked at load time. When a sibling save (or another
 * admin's) replaces the shared row, an untouched section is left holding old
 * values that now read as "dirty" — and its Save would push them back over the
 * newer ones with a fresh If-Match, silently reverting real work. So on every
 * fresh row we re-seed the sections that are NOT dirty, and only flag the ones
 * that are, so their Save is a knowing overwrite rather than an accident.
 */
type BriefFields = Pick<TranslationPrefs, "audience" | "purpose" | "register" | "script_notes">;
function briefEqual(a: BriefFields, b: BriefFields): boolean {
  return (
    a.audience === b.audience &&
    a.purpose === b.purpose &&
    a.register === b.register &&
    a.script_notes === b.script_notes
  );
}

// Shown by a section whose draft is dirty AND whose fields moved on the server
// underneath it.
function ServerChangedNotice({ what }: { what: string }) {
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      {what} changed on the server since you started editing. Your text is kept as-is — saving now will
      overwrite that change.
    </Alert>
  );
}

const SAVE_MESSAGES: Record<string, string> = {
  saved: "Saved",
  conflict: "Someone else saved first — your edits are kept; press Save again",
  forbidden: "Saving preferences is admin-only",
  precondition: "The version header was missing — reloaded; press Save again",
  too_long: "Too long for the server's limit — trim it and save again",
  failed: "Couldn't save",
};

// ── Brief ───────────────────────────────────────────────────────────────────
function BriefSection({
  prefsState,
  canSave,
  onConflict,
  onDirty,
}: {
  prefsState: PrefsState;
  canSave: boolean;
  onConflict: () => void;
  onDirty: (v: boolean) => void;
}) {
  const { prefs, loading, error } = prefsState;
  const [draft, setDraft] = useState<TranslationPrefs | null>(null);
  // The row this draft was seeded from — comparing against it (not the live
  // row) is what tells "the user typed here" apart from "someone else saved".
  const [seed, setSeed] = useState<TranslationPrefs | null>(null);
  const [serverChanged, setServerChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed on first load; afterwards re-seed only while this section is clean.
  // Typing here is never overwritten — see briefEqual's comment for why a
  // seed-once-forever rule loses other people's saves.
  useEffect(() => {
    if (!prefs) return;
    if (!draft || !seed) {
      setDraft(prefs);
      setSeed(prefs);
      setServerChanged(false);
      return;
    }
    if (briefEqual(draft, prefs)) {
      // In sync — our own save landed, or the two happen to match.
      if (!briefEqual(seed, prefs)) setSeed(prefs);
      setServerChanged(false);
      return;
    }
    if (briefEqual(seed, prefs)) return; // dirty, server unchanged: leave it alone
    if (briefEqual(draft, seed)) {
      // Not dirty and the server moved — adopt the fresh values.
      setDraft(prefs);
      setSeed(prefs);
      setServerChanged(false);
      return;
    }
    setServerChanged(true); // dirty AND changed underneath: warn, keep the edits
  }, [prefs, draft, seed]);

  const isDirty =
    !!draft &&
    !!prefs &&
    (draft.audience !== prefs.audience ||
      draft.purpose !== prefs.purpose ||
      draft.register !== prefs.register ||
      draft.script_notes !== prefs.script_notes);
  useEffect(() => onDirty(isDirty), [isDirty, onDirty]);

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    const outcome = await savePrefs(
      prefsState,
      {
        audience: draft.audience,
        purpose: draft.purpose,
        register: draft.register,
        script_notes: draft.script_notes,
        // Instructions / common issues are omitted so the server's partial
        // merge leaves the sibling section's content alone.
      },
      onConflict,
    );
    setMsg(SAVE_MESSAGES[outcome]);
    setSaving(false);
  };

  return (
    <Panel
      id="brief"
      title="Brief"
      intro="The who / why / register of this language's translation — read once by the AI on every run, not per-verse detail."
      headerExtra={serverChanged ? <FlowStatusChip kind="warn" label="Changed on the server" /> : undefined}
      footState={
        loading && !draft
          ? "Loading…"
          : error
            ? "Couldn't load preferences"
            : prefs?.version === 0
              ? "Never saved"
              : timeAgo(prefs?.updated_at)
      }
      footActions={
        <Tooltip title={canSave ? "" : "Saving preferences is admin-only"}>
          <span>
            <Button
              variant="contained"
              size="small"
              startIcon={<SaveIcon />}
              disabled={!canSave || saving || !draft}
              onClick={() => void onSave()}
            >
              Save
            </Button>
          </span>
        </Tooltip>
      }
    >
      {serverChanged && <ServerChangedNotice what="The brief" />}
      {error && !draft ? (
        <Alert severity="error">Couldn't load preferences from the server.</Alert>
      ) : !draft ? (
        <CircularProgress size={22} />
      ) : (
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", tablet: "repeat(2, minmax(0, 1fr))" },
          }}
        >
          <TextField
            label="Audience"
            size="small"
            multiline
            minRows={2}
            value={draft.audience ?? ""}
            onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
          />
          <TextField
            label="Purpose"
            size="small"
            multiline
            minRows={2}
            value={draft.purpose ?? ""}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
          />
          <TextField
            select
            label="Register"
            size="small"
            value={draft.register}
            onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
          >
            {REGISTERS.map((r) => (
              <MenuItem key={r} value={r}>
                {r === "default" ? "Default" : r === "formal" ? "Formal" : "Informal"}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Script / direction notes"
            size="small"
            multiline
            minRows={2}
            placeholder="e.g. right-to-left, no diacritics in body text"
            value={draft.script_notes ?? ""}
            onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
          />
        </Box>
      )}
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Panel>
  );
}

// ── Instructions + Common issues ────────────────────────────────────────────
// One panel, one Save — both fields ride in the same PUT, exactly as the mockup
// does, and both live in the same shared-version row.
function InstructionsSection({
  prefsState,
  canSave,
  onConflict,
  onDirty,
}: {
  prefsState: PrefsState;
  canSave: boolean;
  onConflict: () => void;
  onDirty: (v: boolean) => void;
}) {
  const { prefs, loading, error } = prefsState;
  const [instructions, setInstructions] = useState<string | null>(null);
  const [commonIssues, setCommonIssues] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ instructions: string; commonIssues: string } | null>(null);
  const [serverChanged, setServerChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Seed only after prefs actually loaded — coalescing a null prefs into "" on
  // mount would render an empty editor and let a Save silently null the stored
  // text. Afterwards re-seed only while this section is clean; typing here is
  // never overwritten (see briefEqual's comment for the lost-update this
  // prevents).
  useEffect(() => {
    if (!prefs) return;
    const server = {
      instructions: prefs.instructions_md ?? "",
      commonIssues: prefs.common_issues_md ?? "",
    };
    const adopt = () => {
      setInstructions(server.instructions);
      setCommonIssues(server.commonIssues);
      setSeed(server);
      setServerChanged(false);
    };
    if (instructions === null || commonIssues === null || !seed) {
      adopt();
      return;
    }
    const seedMatchesServer =
      seed.instructions === server.instructions && seed.commonIssues === server.commonIssues;
    if (instructions === server.instructions && commonIssues === server.commonIssues) {
      // In sync — our own save landed, or the two happen to match.
      if (!seedMatchesServer) setSeed(server);
      setServerChanged(false);
      return;
    }
    if (seedMatchesServer) return; // dirty, server unchanged: leave it alone
    if (instructions === seed.instructions && commonIssues === seed.commonIssues) {
      adopt(); // not dirty and the server moved
      return;
    }
    setServerChanged(true); // dirty AND changed underneath: warn, keep the edits
  }, [prefs, instructions, commonIssues, seed]);

  const isDirty =
    !!prefs &&
    instructions !== null &&
    commonIssues !== null &&
    (instructions !== (prefs.instructions_md ?? "") || commonIssues !== (prefs.common_issues_md ?? ""));
  useEffect(() => onDirty(isDirty), [isDirty, onDirty]);

  const overInstructions = (instructions ?? "").length > INSTRUCTIONS_MAX;
  const overCommonIssues = (commonIssues ?? "").length > COMMON_ISSUES_MAX;

  const onSave = async () => {
    if (instructions === null || commonIssues === null) return;
    setSaving(true);
    const outcome = await savePrefs(
      prefsState,
      { instructions_md: instructions || null, common_issues_md: commonIssues || null },
      onConflict,
    );
    setMsg(SAVE_MESSAGES[outcome]);
    setSaving(false);
  };

  return (
    <Panel
      id="instructions"
      title="Instructions"
      intro="Standing guidance injected into every AI draft prompt. Keep it terse and durable — per-segment nuance belongs in Examples, not here."
      headerExtra={
        <>
          {isDirty && <FlowStatusChip kind="warn" label="Unsaved" />}
          {serverChanged && <FlowStatusChip kind="warn" label="Changed on the server" />}
        </>
      }
      footState={
        loading && instructions === null
          ? "Loading…"
          : error
            ? "Couldn't load preferences"
            : prefs?.version === 0
              ? "Never saved"
              : timeAgo(prefs?.updated_at)
      }
      footActions={
        <Tooltip title={canSave ? "" : "Saving preferences is admin-only"}>
          <span>
            <Button
              variant="contained"
              size="small"
              startIcon={<SaveIcon />}
              disabled={
                !canSave || saving || instructions === null || overInstructions || overCommonIssues
              }
              onClick={() => void onSave()}
            >
              Save
            </Button>
          </span>
        </Tooltip>
      }
    >
      {serverChanged && <ServerChangedNotice what="Instructions / common issues" />}
      {error && instructions === null ? (
        <Alert severity="error">Couldn't load preferences from the server.</Alert>
      ) : instructions === null || commonIssues === null ? (
        <CircularProgress size={22} />
      ) : (
        <Stack spacing={2} divider={<Divider />}>
          <TextField
            label="Instructions (markdown)"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            multiline
            minRows={8}
            fullWidth
            error={overInstructions}
            helperText={`${instructions.length.toLocaleString()} / ${INSTRUCTIONS_MAX.toLocaleString()}`}
            slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
          />
          <Box>
            <TextField
              label="Common issues (markdown)"
              value={commonIssues}
              onChange={(e) => setCommonIssues(e.target.value)}
              multiline
              minRows={8}
              fullWidth
              error={overCommonIssues}
              helperText={`${commonIssues.length.toLocaleString()} / ${COMMON_ISSUES_MAX.toLocaleString()}`}
              slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
            />
            <Typography variant="caption" color="text.secondary">
              Recurring problems this team hits — false friends, grammar traps, formatting habits. Rides
              inside instructions.md under a "Common issues" heading at export time.
            </Typography>
          </Box>
        </Stack>
      )}
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Panel>
  );
}

// ── Terminology ─────────────────────────────────────────────────────────────
function TerminologySection({ direction, canEdit }: { direction: "ltr" | "rtl"; canEdit: boolean }) {
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { terms, loading, error, refetch } = useTerms(true, {
    status: statusFilter || undefined,
    q: debouncedQ || undefined,
  });
  const [importOpen, setImportOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // The export route returns text/csv, not JSON, so it can't go through the
  // JSON client — but it still has to be workspace-scoped like every other
  // call. A bare <a download> sends no X-Workspace header, so the server would
  // resolve it against whatever the be_ws cookie happens to say and could hand
  // back another org's termbase. Fetch it with the same header + credentials
  // request() stamps on, then download the blob.
  const [exporting, setExporting] = useState(false);
  const onExport = async () => {
    setExporting(true);
    try {
      const res = await fetch(api.termsExportPath(), {
        credentials: "include",
        headers: { "X-Workspace": getWorkspaceSlug() },
      });
      if (!res.ok) {
        setMsg(res.status === 403 ? "Exporting terms is not allowed for your role" : "Couldn't export the termbase");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "terminology.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — some browsers abort a download whose blob URL
      // is revoked in the same task as the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setMsg("Couldn't export the termbase");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Panel
      id="terminology"
      title="Terminology"
      intro="Concept-oriented termbase: preferred / admitted / deprecated / forbidden (with a required “use instead”) / do-not-translate."
      footState={
        loading && terms.length === 0
          ? "Loading…"
          : error
            ? "Couldn't load terms"
            : `${terms.length} term${terms.length === 1 ? "" : "s"} shown`
      }
      footActions={
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<UploadIcon />} onClick={() => setImportOpen((v) => !v)}>
            {importOpen ? "Close import" : "Import CSV"}
          </Button>
          <Button size="small" startIcon={<DownloadIcon />} disabled={exporting} onClick={() => void onExport()}>
            Export CSV
          </Button>
        </Stack>
      }
    >
      <Stack spacing={2}>
        {importOpen && <ImportPanel onApplied={refetch} />}

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap gap={1}>
          <TextField
            size="small"
            placeholder="Search terms…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ minWidth: 220 }}
          />
          <TextField
            select
            size="small"
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            {TERM_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {TERM_STATUS_LABELS[s]}
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        {canEdit ? (
          <NewTermRow direction={direction} onCreated={refetch} onMessage={setMsg} />
        ) : (
          <Typography variant="caption" color="text.secondary">
            Adding and removing terms is admin-only.
          </Typography>
        )}

        {error ? (
          <Alert severity="error">Couldn't load the termbase.</Alert>
        ) : loading && terms.length === 0 ? (
          <CircularProgress size={22} />
        ) : terms.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No terms yet{debouncedQ || statusFilter ? " for this filter." : " — add one above."}
          </Typography>
        ) : (
          <Stack divider={<Divider />}>
            {terms.map((term) => (
              <TermRow
                key={term.id}
                term={term}
                canEdit={canEdit}
                onChanged={refetch}
                onMessage={setMsg}
              />
            ))}
          </Stack>
        )}
      </Stack>
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Panel>
  );
}

function TermRow({
  term,
  canEdit,
  onChanged,
  onMessage,
}: {
  term: Term;
  canEdit: boolean;
  onChanged: () => void;
  onMessage: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const del = async () => {
    setBusy(true);
    try {
      await api.deleteTerm(term.id);
      onMessage("Term deleted");
      onChanged();
    } catch {
      onMessage("Couldn't delete that term");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ py: 1.25 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="baseline" flexWrap="wrap" useFlexGap gap={1}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {term.source_term}
          </Typography>
          <FlowStatusChip
            kind={term.status === "forbidden" ? "warn" : term.status === "preferred" ? "ok" : "skip"}
            label={
              term.status === "forbidden" && term.replacement
                ? `${TERM_STATUS_LABELS[term.status]} → use “${term.replacement}”`
                : TERM_STATUS_LABELS[term.status]
            }
          />
          <Chip
            size="small"
            variant="outlined"
            label={term.concept_id}
            sx={{ height: 20, fontFamily: "monospace", fontSize: 11 }}
          />
        </Stack>
        {term.target_term && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            “{term.target_term}”
            {term.comment && (
              <Box component="em" sx={{ color: "text.secondary" }}>
                {" "}
                — {term.comment}
              </Box>
            )}
          </Typography>
        )}
        {!term.target_term && term.comment && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, fontStyle: "italic" }}>
            {term.comment}
          </Typography>
        )}
        {term.tw_link && (
          <Typography variant="caption" color="text.secondary">
            {term.tw_link}
          </Typography>
        )}
      </Box>
      {canEdit && (
        <Button
          size="small"
          color="inherit"
          startIcon={<DeleteOutlineIcon />}
          disabled={busy}
          onClick={() => void del()}
          sx={{ minHeight: 32, flex: "none" }}
        >
          Delete
        </Button>
      )}
    </Stack>
  );
}

function NewTermRow({
  direction,
  onCreated,
  onMessage,
}: {
  direction: "ltr" | "rtl";
  onCreated: () => void;
  onMessage: (m: string) => void;
}) {
  const [draft, setDraft] = useState<TermInput>({
    concept_id: "",
    source_term: "",
    target_term: "",
    status: "preferred",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A forbidden entry always needs its "use instead" pointer — the server
  // rejects it too, so disabling Add here just avoids a round trip.
  const canAdd =
    !!draft.concept_id.trim() &&
    !!draft.source_term.trim() &&
    (draft.status !== "forbidden" || !!draft.replacement?.trim());

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTerm({
        concept_id: draft.concept_id.trim(),
        source_term: draft.source_term.trim(),
        target_term: draft.target_term?.trim() || null,
        status: draft.status,
        replacement: draft.status === "forbidden" ? draft.replacement?.trim() || null : null,
      });
      setDraft({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
      onMessage("Term added");
      onCreated();
    } catch (e) {
      // POST /terms has no If-Match, so its only 409 is a duplicate identity.
      if (e instanceof ApiError && e.status === 409) setError("That exact term already exists.");
      else if (e instanceof ApiError && e.status === 403) setError("Adding terms is admin-only.");
      else setError("Couldn't add that term.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap gap={1} alignItems="flex-start">
        <TextField
          size="small"
          label="concept_id"
          placeholder="rc://*/tw/dict/bible/kt/god"
          value={draft.concept_id}
          onChange={(e) => setDraft({ ...draft, concept_id: e.target.value })}
          sx={{ minWidth: 220, flex: 1 }}
        />
        <TextField
          size="small"
          label="Source term"
          value={draft.source_term}
          onChange={(e) => setDraft({ ...draft, source_term: e.target.value })}
          sx={{ minWidth: 160 }}
        />
        <TextField
          size="small"
          label="Target term (optional)"
          value={draft.target_term ?? ""}
          onChange={(e) => setDraft({ ...draft, target_term: e.target.value })}
          sx={{ minWidth: 160 }}
          slotProps={{ htmlInput: { dir: direction } }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
          sx={{ minWidth: 170 }}
        >
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {TERM_STATUS_LABELS[s]}
            </MenuItem>
          ))}
        </TextField>
        {draft.status === "forbidden" && (
          <TextField
            size="small"
            label="Use instead"
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            sx={{ minWidth: 160 }}
            slotProps={{ htmlInput: { dir: direction } }}
          />
        )}
        <Button variant="outlined" startIcon={<AddIcon />} disabled={!canAdd || busy} onClick={() => void add()}>
          Add term
        </Button>
      </Stack>
      {error && (
        <Typography variant="caption" sx={{ color: (t) => t.palette.flows.warn.ink, display: "block", mt: 1 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

// CSV import — the route takes a raw text/csv body and supports a dry run, so
// the preview is the server's own count, not a client guess.
function ImportPanel({ onApplied }: { onApplied: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TermImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean) => {
    if (!text.trim()) {
      setError("Paste CSV first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.importTerms(text, dryRun);
      setResult(res);
      if (!dryRun) onApplied();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setError("Importing terms is admin-only.");
      else setError("The import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1.5 }}>
      <TextField
        fullWidth
        multiline
        minRows={3}
        size="small"
        placeholder="Paste CSV: concept_id,source_term,target_term,status,replacement,comment,tw_link"
        value={text}
        onChange={(e) => setText(e.target.value)}
        slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 12.5 } } }}
      />
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" disabled={busy} onClick={() => void run(true)}>
          Preview (dry run)
        </Button>
        <Button size="small" variant="contained" disabled={busy} onClick={() => void run(false)}>
          Apply import
        </Button>
      </Stack>
      {error && (
        <Typography variant="caption" sx={{ color: (t) => t.palette.flows.warn.ink, display: "block", mt: 1 }}>
          {error}
        </Typography>
      )}
      {result && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          {result.dryRun ? "Dry run" : "Applied"}: {result.added} added, {result.updated} updated,{" "}
          {result.total} row(s) parsed
          {result.parseErrors.length > 0 && `, ${result.parseErrors.length} error(s)`}
          {result.parseWarnings && result.parseWarnings.length > 0 &&
            `, ${result.parseWarnings.length} warning(s)`}
          .
        </Typography>
      )}
    </Box>
  );
}

// ── Examples ────────────────────────────────────────────────────────────────
function ExamplesSection({ canRevoke }: { canRevoke: boolean }) {
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const { examples, loading, error, refetch } = useExamples(true, { resource, limit: 50 });
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // "Revoke" = un-approve: the row drops back to 'edited' and stops feeding the
  // next context-pack export. Uses the row's real id + book, so it can never
  // fire as a param-less request.
  const revoke = async (ex: TranslationExample) => {
    setBusyId(ex.id);
    try {
      if (resource === "tn") await api.validateNote(ex.id, ex.book, false);
      else await api.validateQuestion(ex.id, ex.book, false);
      setMsg("Sent back to “edited” — excluded from the next export");
      refetch();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg("Revoking is not allowed for your role");
      else setMsg("Couldn't revoke that row");
    } finally {
      setBusyId(null);
    }
  };

  const noun = resource === "tn" ? "note" : "question";

  return (
    <Panel
      id="examples"
      title="Examples"
      intro="Validated notes and questions the AI learns from — the same rows a translator approved in the review queue. Revoking one sends it back to “edited” so it's excluded from the next export."
      footState={
        loading
          ? "Loading…"
          : error
            ? "Unavailable"
            : `${examples.length} validated ${noun}${examples.length === 1 ? "" : "s"} shown (max 50)`
      }
      footActions={
        <Button size="small" onClick={refetch} disabled={loading}>
          Refresh
        </Button>
      }
    >
      <Stack spacing={2}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={resource}
          onChange={(_, v) => v && setResource(v as "tn" | "tq")}
          aria-label="Resource"
        >
          <ToggleButton value="tn" sx={{ textTransform: "none", minHeight: 32 }}>
            Notes
          </ToggleButton>
          <ToggleButton value="tq" sx={{ textTransform: "none", minHeight: 32 }}>
            Questions
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Honest gap, carried over from the mockup's own note: the endpoint
            returns only the target-language row, with no paired English source
            text, so a card shows one language rather than inventing a pair. */}
        <Typography variant="caption" color="text.secondary">
          The examples endpoint returns only the target-language row today — there is no paired English
          source text to show alongside it.
        </Typography>

        {error ? (
          <Alert severity="error">Couldn't load examples.</Alert>
        ) : loading ? (
          <CircularProgress size={22} />
        ) : examples.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No validated {noun}s yet. Rows appear here once a translator approves them in the review queue.
          </Typography>
        ) : (
          <Box
            sx={{
              display: "grid",
              gap: 1.25,
              gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" },
            }}
          >
            {examples.map((ex) => (
              <Box key={ex.id} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {ex.book} {ex.ref_raw}
                  {ex.support_reference ? ` · ${ex.support_reference}` : ""}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {ex.quote ? `“${ex.quote}” — ` : ""}
                  {(resource === "tn" ? ex.note : ex.response) ?? ""}
                </Typography>
                {canRevoke && (
                  <Button
                    size="small"
                    sx={{ mt: 0.75, minHeight: 32 }}
                    disabled={busyId === ex.id}
                    onClick={() => void revoke(ex)}
                  >
                    Revoke
                  </Button>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Stack>
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Panel>
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
