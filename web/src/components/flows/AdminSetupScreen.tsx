// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// AdminSetupScreen — the redesigned admin "Setup" desk screen (#/admin/setup),
// rendered inside the shared AdminDesk chrome. Desktop-first presentation of
// the "Setup & Preferences" mockup (artifact a5d4a223: rail groups Setup
// [5 wizard steps] + Preferences [Brief / Instructions / Common issues /
// Terminology / Examples / Source overrides]) over the REAL systems that
// already exist. Nothing here fakes a save; every write goes through the same
// api methods the classic PreferencesWorkspace uses.
//
// Reality mapping (decisions + evidence):
//
//  * Setup wizard — the artifact's five steps (org / sources / lanes / review
//    & apply / done) are NOT re-implemented as five nav entries. SetupWizard
//    (web/src/components/SetupWizard.tsx:75) already IS that wizard, wired to
//    the real endpoints (org search, verify-source, PUT /api/project-config
//    with its honest 409 project_not_empty, PATCH mode) — the same reasoning
//    recorded in flows/SetupScreen.tsx:5-15: rebuilding its apply/409/lane-lock
//    state machine would be more code, no more real, and a second place for
//    that concurrency logic to drift. So the "Setup" group collapses to one
//    section hosting <SetupWizard /> plus the real workspace picker
//    (WorkspaceChoiceDialog, web/src/components/WorkspaceChoiceDialog.tsx:61 —
//    picking an org actually switches and reloads; the caption says so).
//
//  * Brief / Instructions / Common issues — re-presented here with EXACTLY the
//    semantics of PreferencesWorkspace's BriefSection (PreferencesWorkspace.tsx
//    :1376-1488) and MarkdownPrefSection (:1493-1610):
//      - ONE shared useTranslationPrefs hook for all three sections
//        (PreferencesWorkspace.tsx:186-190) so every save reads the same
//        prefs.version for If-Match and a sibling's save can't leave another
//        section self-409ing;
//      - seed-once drafts (setDraft(d => d ?? prefs)) so a sibling's apply()
//        never clobbers unsaved typing (:1382-1389, :1510-1523);
//      - api.putTranslationPrefs(prefs.version, patch) sends only the fields
//        each section owns; the server partial-merges (sync/api.ts:1977-1982);
//      - 409 → currentPrefsFromConflict(e.body) → apply(current) (refetch only
//        if the body carried no row), draft untouched (:1407-1418);
//      - 403 → forbidden message; 400 → too-long message (markdown fields).
//    Char caps mirror the server (api/src/translationMemory.ts via the note at
//    PreferencesWorkspace.tsx:1491-1492): instructions_md 20000,
//    common_issues_md 50000.
//
//  * Terminology — REAL, full editor (issue #190). The ~800-line
//    add/edit/status-change/CSV-import state machine (concept-grouping,
//    per-row If-Match PATCH, duplicate detection, TSV import) was extracted
//    out of PreferencesWorkspace.tsx into components/TerminologySection.tsx
//    so both the classic Preferences page and this desk screen mount the
//    SAME component — no second copy to drift. There is no more read-only
//    mirror and no more #/preferences/terminology deep-link.
//
//  * Examples — re-presentation of ExamplesSection (PreferencesWorkspace.tsx
//    :2454-2580): read-only browse via useExamples, tn/tq toggle, debounced
//    search, and the one real action — revoke — via api.validateNote /
//    api.validateQuestion(id, book, false) (sync/api.ts:1847-1861). React keys
//    and the busy token are `book:id` because 4-char row IDs are only unique
//    per book (comment at :2469-2471). "Feeding AI" chip from
//    useContextExportStatus (:2460, :2486).
//
//  * Source overrides — the artifact's per-book tN/tQ override table maps to a
//    REAL backend (issue #103: api.getBookSources / setBookSource /
//    clearBookSource, sync/api.ts:1662-1702) and a REAL self-contained panel,
//    BookSourceOverridesPanel (web/src/components/BookSourceOverridesPanel.tsx
//    :35, already reused by ImportWorkspace.tsx:484). Reused wholesale behind a
//    book selector fed by api.getBooks() — overrides are per-book, so the
//    artifact's book-less table needed that one addition to be honest.
//
//  * Omitted from the artifact: nothing. Every mockup section has a real
//    backing. The artifact's five separate wizard rail entries collapse to one
//    section (see above), and its inline-editable terminology grid degrades to
//    read-only + link-out (see above) — both deliberate.
//
// Inner navigation: AdminDesk owns the desk rail (Progress / Workflow / Team /
// Setup), so this screen's section nav is a sticky horizontal jump strip above
// the stacked panels — plain scrollIntoView against in-page anchors
// (admin-setup-sec-*), the same pattern PreferencesWorkspace uses for its rail
// (:169-171). No extra hash segments, so back/forward stay owned by the desk.
//
// Gating: admin-only overall (honest no-content gate like SetupScreen.tsx
// :75-95 — hooks still run above the gate so hook order never varies). The
// memory sections additionally require a translation project + write access
// (memoryAvailable = isTranslationProject(cfg) && !isReadOnly(), mirroring
// PreferencesWorkspace.tsx:183-184); a gateway-language or read-only workspace
// sees an honest explanation instead.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import SaveIcon from "@mui/icons-material/Save";
import VisibilityIcon from "@mui/icons-material/Visibility";
import {
  api,
  ApiError,
  isReadOnly,
  REGISTERS,
  type Register,
  type TranslationPrefs,
} from "../../sync/api";
import { currentPrefsFromConflict } from "../../sync/prefsConflict";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import {
  useTranslationPrefs,
  useExamples,
  useContextExportStatus,
} from "../../hooks/useTranslationMemory";
import { MarkdownView } from "../MarkdownView";
import { SetupWizard } from "../SetupWizard";
import { WorkspaceChoiceDialog } from "../WorkspaceChoiceDialog";
import { BookSourceOverridesPanel } from "../BookSourceOverridesPanel";
import { TerminologySection } from "../TerminologySection";
import { bookName } from "../../lib/bookNames";
import { AdminDesk } from "./AdminDesk";
import type { FlowScreenContext } from "./types";

const INSPIRE = "#31ADE3";

type PrefsState = ReturnType<typeof useTranslationPrefs>;

type SectionKey =
  | "wizard"
  | "brief"
  | "instructions"
  | "commonIssues"
  | "terminology"
  | "examples"
  | "overrides";

const SECTION_LABELS: Record<SectionKey, string> = {
  wizard: "Setup wizard",
  brief: "Brief",
  instructions: "Instructions",
  commonIssues: "Common issues",
  terminology: "Terminology",
  examples: "Examples",
  overrides: "Source overrides",
};

function scrollToSection(key: SectionKey) {
  document
    .getElementById(`admin-setup-sec-${key}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Per-panel save feedback, mirror of useSaveState (PreferencesWorkspace.tsx
// :1081-1085).
function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}

// ── Panel chrome ────────────────────────────────────────────────────────────
// The artifact's panel-top / panel-body / panel-foot translated to the MUI/sx
// idiom AdminDesk established (1px divider borders, 14px radius, card-2 foot).
function SectionPanel({
  id,
  title,
  sub,
  foot,
  footAction,
  flush,
  children,
}: {
  id: SectionKey;
  title: string;
  sub?: string;
  foot?: ReactNode;
  footAction?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <Paper
      id={`admin-setup-sec-${id}`}
      variant="outlined"
      sx={{ borderRadius: "14px", overflow: "hidden", scrollMarginTop: "64px" }}
    >
      <Box sx={{ paddingInline: 2, paddingBlock: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
          {title}
        </Typography>
        {sub && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {sub}
          </Typography>
        )}
      </Box>
      <Box sx={{ padding: flush ? 0 : 2 }}>{children}</Box>
      {(foot || footAction) && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            flexWrap: "wrap",
            paddingInline: 2,
            paddingBlock: 1,
            borderTop: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {foot}
          </Typography>
          <Box sx={{ marginInlineStart: "auto" }}>{footAction}</Box>
        </Box>
      )}
    </Paper>
  );
}

// ── Setup wizard section ────────────────────────────────────────────────────
function WizardPanel() {
  // Real workspace picker, exactly as flows/SetupScreen.tsx:41,102-111 — there
  // is no preview mode; choosing an org switches the workspace and reloads.
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  return (
    <SectionPanel
      id="wizard"
      title="Setup wizard"
      sub="Organization, sources to pull from, scripture lanes, review & apply. Applying writes the real project configuration."
      foot="Changes apply to this workspace's live configuration."
      footAction={
        <Button variant="text" size="small" onClick={() => setWsPickerOpen(true)}>
          Switch workspace…
        </Button>
      }
    >
      <SetupWizard />
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
        Need a different organization? "Switch workspace" below is the real picker, not a preview:
        choosing an organization switches the active workspace and reloads the app.
      </Typography>
      {wsPickerOpen && <WorkspaceChoiceDialog onClose={() => setWsPickerOpen(false)} />}
    </SectionPanel>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────────
// Faithful re-presentation of BriefSection (PreferencesWorkspace.tsx:1376-1488):
// same fields, same seed-once draft, same PUT field set (audience / purpose /
// register / script_notes / notes — instructions/assisted omitted so the
// server merges them), same 409/403 handling.
function BriefPanel({ prefsState }: { prefsState: PrefsState }) {
  const { prefs, loading, apply, refetch } = prefsState;
  const [draft, setDraft] = useState<TranslationPrefs | null>(null);
  const save = useSaveState();

  // Seed once — a sibling section's save PUTs only its own fields, so it can't
  // change anything Brief owns; re-seeding on every prefs change would clobber
  // in-progress typing (see PreferencesWorkspace.tsx:1382-1386).
  useEffect(() => {
    setDraft((d) => d ?? prefs);
  }, [prefs]);

  const onSave = async () => {
    if (!draft || !prefs) return;
    save.setSaving(true);
    try {
      const res = await api.putTranslationPrefs(prefs.version, {
        audience: draft.audience,
        purpose: draft.purpose,
        register: draft.register,
        script_notes: draft.script_notes,
        notes: draft.notes,
      });
      apply(res.prefs);
      save.setMsg("Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else saved first. Adopt the fresh row from the 409 body so
        // the next save carries the right If-Match; the local draft is kept.
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg("Someone else saved first — your edits are kept; save again to apply them.");
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg("Only an admin can save preferences.");
      } else {
        save.setMsg("Save failed — check your connection and try again.");
      }
    } finally {
      save.setSaving(false);
    }
  };

  return (
    <SectionPanel
      id="brief"
      title="Brief"
      sub="Sets the audience and tone every AI draft is written for."
      foot={prefs ? `Version ${prefs.version}` : undefined}
      footAction={
        <Button
          variant="contained"
          size="small"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={save.saving || !draft}
        >
          Save
        </Button>
      }
    >
      {loading && !draft ? (
        <CircularProgress size={22} />
      ) : !draft ? null : (
        <Stack spacing={2}>
          <TextField
            label="Audience"
            value={draft.audience ?? ""}
            onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
          <TextField
            label="Purpose"
            value={draft.purpose ?? ""}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
          <TextField
            select
            label="Register"
            value={draft.register}
            onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
            sx={{ maxWidth: 240 }}
            size="small"
            helperText="The level of formality AI drafts aim for."
          >
            {REGISTERS.map((r) => (
              <MenuItem key={r} value={r}>
                {r === "default" ? "Default (auto)" : r === "formal" ? "Formal" : "Informal"}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Script / direction notes"
            value={draft.script_notes ?? ""}
            onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </SectionPanel>
  );
}

// ── Instructions / Common issues (shared markdown editor) ───────────────────
// Faithful re-presentation of MarkdownPrefSection (PreferencesWorkspace.tsx
// :1493-1610). Server caps (keep in sync with PutPrefsBody in
// api/src/translationMemory.ts): instructions_md 20000, common_issues_md 50000.
function MarkdownPrefPanel({
  id,
  field,
  title,
  sub,
  placeholder,
  maxChars,
  prefsState,
}: {
  id: SectionKey;
  field: "instructions_md" | "common_issues_md";
  title: string;
  sub: string;
  placeholder: string;
  maxChars: number;
  prefsState: PrefsState;
}) {
  const { prefs, error, apply, refetch } = prefsState;
  // null = not yet seeded (loading gate below). Seed ONLY once prefs actually
  // loaded — coalescing null prefs into "" would render empty over saved
  // content, and a Save from that state would null the field on the server
  // (see PreferencesWorkspace.tsx:1517-1523).
  const [value, setValue] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setValue((v) => v ?? (prefs[field] ?? ""));
  }, [prefs, field]);

  const overLimit = (value ?? "").length > maxChars;

  const onSave = async () => {
    if (!prefs || value === null) return;
    save.setSaving(true);
    try {
      const res = await api.putTranslationPrefs(prefs.version, { [field]: value || null });
      apply(res.prefs);
      save.setMsg("Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg("Someone else saved first — your edits are kept; save again to apply them.");
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg("Only an admin can save preferences.");
      } else if (e instanceof ApiError && e.status === 400) {
        save.setMsg("Too long — trim the text under the character limit and save again.");
      } else {
        save.setMsg("Save failed — check your connection and try again.");
      }
    } finally {
      save.setSaving(false);
    }
  };

  return (
    <SectionPanel
      id={id}
      title={title}
      sub={sub}
      foot={
        value === null
          ? undefined
          : overLimit
            ? `${value.length.toLocaleString()} / ${maxChars.toLocaleString()} characters — over the limit`
            : `${value.length.toLocaleString()} / ${maxChars.toLocaleString()} characters`
      }
      footAction={
        <Button
          variant="contained"
          size="small"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={save.saving || overLimit || value === null}
        >
          Save
        </Button>
      }
    >
      {value === null ? (
        error ? (
          <Alert severity="error">Couldn't load preferences — reload to try again.</Alert>
        ) : (
          <CircularProgress size={22} />
        )
      ) : (
        <Stack spacing={1.5}>
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <ToggleButton
              size="small"
              value="preview"
              selected={preview}
              onChange={() => setPreview((p) => !p)}
              sx={{ textTransform: "none", py: 0.25 }}
            >
              <VisibilityIcon fontSize="small" sx={{ marginInlineEnd: 0.5 }} />
              Preview
            </ToggleButton>
          </Box>
          {preview ? (
            <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, minHeight: 180 }}>
              <MarkdownView markdown={value || "_Empty._"} />
            </Box>
          ) : (
            <TextField
              value={value}
              onChange={(e) => setValue(e.target.value)}
              multiline
              minRows={8}
              fullWidth
              placeholder={placeholder}
              error={overLimit}
              slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
            />
          )}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </SectionPanel>
  );
}

// ── Terminology (real editor — issue #190) ──────────────────────────────────
// Mounts the same TerminologySection the classic #/preferences/terminology
// page uses (extracted to components/TerminologySection.tsx), so add / edit /
// status change / CSV import-export are all real here, not a read-only
// mirror. No more "Edit in Preferences" deep-link.
function TerminologyPanel({ direction }: { direction: "ltr" | "rtl" }) {
  return (
    <SectionPanel
      id="terminology"
      title="Terminology"
      sub="Concept-level term decisions every AI draft and reviewer check must respect."
    >
      <TerminologySection direction={direction} />
    </SectionPanel>
  );
}

// ── Examples ────────────────────────────────────────────────────────────────
function ExamplesPanel({ enabled }: { enabled: boolean }) {
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { examples, loading, refetch } = useExamples(enabled, {
    resource,
    q: debouncedQ || undefined,
    limit: 200,
  });
  const { status } = useContextExportStatus(enabled);
  const [busyId, setBusyId] = useState<string | null>(null);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // 4-char row IDs are only unique per book — busy token and React key must be
  // `book:id` (PreferencesWorkspace.tsx:2469-2471).
  const revoke = async (id: string, book: string) => {
    setBusyId(`${book}:${id}`);
    try {
      if (resource === "tn") await api.validateNote(id, book, false);
      else await api.validateQuestion(id, book, false);
      refetch();
    } catch {
      save.setMsg("Couldn't revoke — try again.");
    } finally {
      setBusyId(null);
    }
  };

  const feedingAi = status?.status === "success" && !!status.sha;

  return (
    <SectionPanel
      id="examples"
      title="Examples"
      sub="Validated notes and questions the AI is shown as style references. Revoking returns an item to the edited state."
      foot={`${examples.length} validated example${examples.length === 1 ? "" : "s"}`}
      footAction={
        <Chip
          size="small"
          label={feedingAi ? "Feeding AI drafts" : "Not feeding AI yet"}
          color={feedingAi ? "success" : "default"}
          variant="outlined"
          sx={{ height: 18, fontSize: 10, fontWeight: 600 }}
        />
      }
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup size="small" exclusive value={resource} onChange={(_, v) => v && setResource(v)}>
            <ToggleButton value="tn" sx={{ textTransform: "none", py: 0.25 }}>
              Notes
            </ToggleButton>
            <ToggleButton value="tq" sx={{ textTransform: "none", py: 0.25 }}>
              Questions
            </ToggleButton>
          </ToggleButtonGroup>
          <TextField
            size="small"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ minWidth: 220 }}
          />
        </Stack>

        {loading && examples.length === 0 ? (
          <CircularProgress size={22} />
        ) : examples.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No validated examples yet — validate notes or questions in the editor to feed the AI.
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
                    label={`${bookName(ex.book)} ${ex.ref_raw}`}
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
                    Revoke
                  </Button>
                </Stack>
                <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>
                  {resource === "tn" ? ex.note : `${ex.question ?? ""}\n${ex.response ?? ""}`}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Stack>
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </SectionPanel>
  );
}

// ── Source overrides ────────────────────────────────────────────────────────
// Overrides are stored per book (api/src/bookSource.ts), so the reused
// BookSourceOverridesPanel needs a book context the artifact's mockup didn't
// draw: a plain selector over the imported books.
function OverridesPanel({ initialBook }: { initialBook: string | null }) {
  const [books, setBooks] = useState<string[] | null>(null);
  const [book, setBook] = useState<string | null>(initialBook);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getBooks()
      .then((res) => {
        if (cancelled) return;
        const codes = res.books.map((b) => b.book);
        setBooks(codes);
        setBook((cur) => (cur && codes.includes(cur) ? cur : (codes[0] ?? null)));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SectionPanel
      id="overrides"
      title="Source overrides (advanced)"
      sub="Per-book overrides for where notes and questions come from. A per-book override wins over the project source."
      foot={book ? `Editing overrides for ${bookName(book)}` : undefined}
    >
      {loadError ? (
        <Alert severity="error">Couldn't load the book list.</Alert>
      ) : books === null ? (
        <CircularProgress size={22} />
      ) : books.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No books imported yet — import a book first, then set its source overrides here.
        </Typography>
      ) : (
        <Stack spacing={2}>
          <TextField
            select
            label="Book"
            size="small"
            value={book ?? ""}
            onChange={(e) => setBook(e.target.value)}
            sx={{ maxWidth: 260 }}
          >
            {books.map((b) => (
              <MenuItem key={b} value={b}>
                {bookName(b)}
              </MenuItem>
            ))}
          </TextField>
          {book && <BookSourceOverridesPanel book={book} />}
        </Stack>
      )}
    </SectionPanel>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────
export interface AdminSetupScreenProps extends FlowScreenContext {}

export default function AdminSetupScreen({ role, me, onNavigate }: AdminSetupScreenProps) {
  // All hooks run before any gate below — hook order must never depend on role
  // or config (a mid-body early return above hooks is the Shell.tsx crash
  // pattern this repo has been burned by).
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);
  const admin = role === "admin";
  const memoryAvailable = admin && isTranslation && !isReadOnly();
  // ONE shared prefs hook for Brief / Instructions / Common issues — all three
  // save against the same TranslationPrefs row/version, so a shared hook keeps
  // every save's If-Match current (PreferencesWorkspace.tsx:185-190).
  const prefsState = useTranslationPrefs(memoryAvailable);

  const sections: SectionKey[] = admin
    ? [
        "wizard",
        ...(memoryAvailable
          ? (["brief", "instructions", "commonIssues", "terminology", "examples"] as SectionKey[])
          : []),
        "overrides",
      ]
    : [];

  return (
    <AdminDesk current="setup">
      <Stack spacing={2}>
        <Box>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "text.secondary",
            }}
          >
            {cfg?.languageTitle ?? cfg?.languageName ?? "Workspace"}
          </Typography>
          <Typography variant="h5" sx={{ lineHeight: 1.25 }}>
            Setup &amp; preferences
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, maxWidth: 640 }}>
            Configure sources and lanes, and the memory AI drafts are written from.
          </Typography>
        </Box>

        {!admin ? (
          // Honest admin-only gate — nothing fabricated in its place (same
          // stance as flows/SetupScreen.tsx:75-95).
          <Paper variant="outlined" sx={{ p: 3, borderRadius: "14px" }}>
            <Typography variant="subtitle1" gutterBottom>
              Admin only
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Setup and translation preferences configure where this project pulls from and what
              every AI draft is told — only an admin can change that. Your role is{" "}
              <strong>{role}</strong>. Ask a project admin, or continue with your regular work.
            </Typography>
            <Button
              variant="outlined"
              sx={{ mt: 2 }}
              onClick={() => onNavigate(me?.lastBook || "OBA", me?.lastChapter || 1, me?.lastVerse || 1)}
            >
              Back to the editor
            </Button>
          </Paper>
        ) : (
          <>
            {/* Sticky jump strip — plain in-page anchors, no extra hash
                segments, so the desk rail keeps sole ownership of routing. */}
            <Box
              sx={{
                position: "sticky",
                insetBlockStart: 0,
                zIndex: 5,
                display: "flex",
                gap: 0.5,
                overflowX: "auto",
                bgcolor: "background.paper",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "9px",
                padding: 0.5,
              }}
            >
              {sections.map((s) => (
                <ButtonBase
                  key={s}
                  onClick={() => scrollToSection(s)}
                  sx={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    color: "text.secondary",
                    borderRadius: "6px",
                    paddingBlock: 0.75,
                    paddingInline: 1.25,
                    whiteSpace: "nowrap",
                    "&:hover": { bgcolor: (theme) => alpha(INSPIRE, theme.palette.mode === "dark" ? 0.16 : 0.1), color: "text.primary" },
                  }}
                >
                  {SECTION_LABELS[s]}
                </ButtonBase>
              ))}
            </Box>

            <WizardPanel />

            {cfg === null ? (
              <CircularProgress size={22} />
            ) : !isTranslation ? (
              <Alert severity="info" variant="outlined">
                Translation preferences (brief, instructions, terminology, examples) apply to
                translation projects only — this workspace is a source project.
              </Alert>
            ) : !memoryAvailable ? (
              <Alert severity="info" variant="outlined">
                This workspace is read-only here, so translation preferences can't be edited.
              </Alert>
            ) : (
              <>
                <BriefPanel prefsState={prefsState} />
                <MarkdownPrefPanel
                  id="instructions"
                  field="instructions_md"
                  title="Instructions"
                  sub="Free markdown, injected into every AI drafting and checking prompt for this project."
                  placeholder="e.g. Prefer clause-first word order; keep second-person plural distinct…"
                  maxChars={20000}
                  prefsState={prefsState}
                />
                <MarkdownPrefPanel
                  id="commonIssues"
                  field="common_issues_md"
                  title="Common issues"
                  sub="Free markdown describing recurring problems reviewers keep flagging."
                  placeholder="e.g. - Translators default to a forbidden rendering for…"
                  maxChars={50000}
                  prefsState={prefsState}
                />
                <TerminologyPanel direction={cfg?.direction ?? "ltr"} />
                <ExamplesPanel enabled={memoryAvailable} />
              </>
            )}

            <OverridesPanel initialBook={me?.lastBook ?? null} />
          </>
        )}
      </Stack>
    </AdminDesk>
  );
}
