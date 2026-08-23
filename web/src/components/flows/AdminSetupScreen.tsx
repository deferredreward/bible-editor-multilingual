// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// AdminSetupScreen — the redesigned admin "Setup" desk screen (#/admin/setup),
// rendered inside the shared AdminDesk chrome. Desktop-first presentation of
// the "Setup & Preferences" mockup (artifact a5d4a223) over the REAL systems
// that already exist. Nothing here fakes a save; every write goes through the
// same api methods the classic PreferencesWorkspace uses.
//
// Configuration-only, per Benjamin's post-review IA decision: the "teach the
// AI" memory sections (Brief / Instructions / Common issues / Terminology /
// Examples) moved to the Style screen (StyleScreen.tsx) — this screen keeps
// only the setup wizard, AI service, source overrides, and localization.
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
//  * AI service (#188) and Localization (#189) — same pattern: AiServiceSection
//    and LocalizationSection were already standalone components and are
//    mounted here directly, no re-implementation.
//
//  * Source overrides — the artifact's per-book tN/tQ override table maps to a
//    REAL backend (issue #103: api.getBookSources / setBookSource /
//    clearBookSource, sync/api.ts:1662-1702) and a REAL self-contained panel,
//    BookSourceOverridesPanel (web/src/components/BookSourceOverridesPanel.tsx
//    :35, already reused by ImportWorkspace.tsx:484). Reused wholesale behind a
//    book selector fed by api.getBooks() — overrides are per-book, so the
//    artifact's book-less table needed that one addition to be honest.
//
// Inner navigation: AdminDesk owns the desk rail (Progress / Workflow / Team /
// Setup), so this screen's section nav is a sticky horizontal jump strip above
// the stacked panels — plain scrollIntoView against in-page anchors
// (admin-setup-sec-*), the same pattern PreferencesWorkspace uses for its rail
// (:169-171). No extra hash segments, so back/forward stay owned by the desk.
// Hidden below md — the jump strip is a desktop convenience only.
//
// Gating: admin-only overall (honest no-content gate like SetupScreen.tsx
// :75-95 — hooks still run above the gate so hook order never varies).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { api } from "../../sync/api";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import { SetupWizard } from "../SetupWizard";
import { WorkspaceChoiceDialog } from "../WorkspaceChoiceDialog";
import { BookSourceOverridesPanel } from "../BookSourceOverridesPanel";
import { AiServiceSection } from "../AiServiceSection";
import { LocalizationSection } from "../LocalizationSection";
import { bookName, BOOKS } from "../../lib/bookNames";
import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import type { FlowScreenContext } from "./types";

const INSPIRE = "#31ADE3";

type SectionKey = "wizard" | "aiService" | "overrides" | "localization";

const SECTION_LABELS: Record<SectionKey, string> = {
  wizard: "Setup wizard",
  aiService: "AI service",
  overrides: "Source overrides",
  localization: "Localization",
};

function scrollToSection(key: SectionKey) {
  document
    .getElementById(`admin-setup-sec-${key}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        const canonCodes = new Set(BOOKS.map((b) => b.code));
        setBook((cur) =>
          cur && canonCodes.has(cur) ? cur : (codes[0] ?? BOOKS[0].code)
        );
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
      sub="Per-book overrides for where notes and questions come from. A per-book override wins over the project source. Set an override before a book's first import to have it apply right away — an already-imported book needs a full re-import to pick up a new override."
      foot={book ? `Editing overrides for ${bookName(book)}` : undefined}
    >
      {loadError ? (
        <Alert severity="error">Couldn't load the book list.</Alert>
      ) : books === null ? (
        <CircularProgress size={22} />
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
            {BOOKS.map(({ code }) => (
              <MenuItem key={code} value={code}>
                {bookName(code)}
                {!books.includes(code) && " — not imported"}
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
  const admin = role === "admin";

  const sections: SectionKey[] = admin ? ["wizard", "aiService", "overrides", "localization"] : [];

  return (
    <AdminDesk current="setup">
      <Stack spacing={2}>
        <AdminPageHeader
          eyebrow={cfg ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}` : "Workspace"}
          title="Setup & preferences"
          subtitle="Configure where this project pulls from and how it's set up."
        />

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
                display: { xs: "none", md: "flex" },
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

            {/* AI service is org-wide admin config (provider/model/key), not a
                translation-memory feature — gate on admin only, matching
                classic Preferences, so admins on source-language or read-only
                workspaces can still reach it. */}
            <SectionPanel id="aiService" title="AI service" sub="Provider, model, and API key AI drafts and checks run on.">
              <AiServiceSection />
            </SectionPanel>

            <OverridesPanel initialBook={me?.lastBook ?? null} />

            <SectionPanel id="localization" title="Localization" sub="UI string overrides for this workspace.">
              <LocalizationSection />
            </SectionPanel>
          </>
        )}
      </Stack>
    </AdminDesk>
  );
}
