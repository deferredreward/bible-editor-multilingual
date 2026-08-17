// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// a2-import: All roles — the default landing screen. Port of docs/flows/ui/a2-import.html.
//
// 2026-08-11 (Benjamin): this screen is the redesign's top-level entry, and two
// decisions landed together: (1) the old FlowNav pill bar (which pointed at the
// retired flows routes) is replaced by the redesign's own sticky topbar idiom
// (see PackageHubScreen) — title, org/language sub, Tune button opening a menu
// shown to every role; (2) the per-book source-overrides editor was duplicated
// between here and the admin Setup screen — it now lives on Admin → Setup ONLY,
// and this screen's copy is removed in favor of a caption link to #/admin/setup.
//
// Non-admins (editor/viewer) get a read-only version of the book grid: no
// import/re-pull/AI-translate actions, no Bundle B import framing, and Open is
// offered only once a book actually has content. Touching authorization logic
// here means touching both roles' branches — check for `isAdmin`/`role ===
// "admin"` before assuming a change is admin-only.
//
// Real data only. The book grid's imported/not-imported state comes from
// GET /api/books; a FAILED list load renders an explicit error + retry and
// never collapses into an all-"not imported" list (that would re-expose the
// destructive import path for an already-imported book — the same safety rule
// ImportWorkspace enforces, and the shared decision logic in lib/importIntent
// is reused here rather than re-derived).
//
// Breakpoints: only the system bands (theme `tablet` = 560, `md` = 900). The
// mockup mixed 700/820/900; those are not reproduced. The mobile canonical
// accordion replaces the tile grid below `tablet`; the two-pane shell collapses
// below `md`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TuneIcon from "@mui/icons-material/Tune";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import {
  api,
  ApiError,
  importedSourceRepos,
  type BookLintReport,
  type BookListEntry,
  type BookSummary,
  type ImportHasLocalEditsBody,
  type Role,
} from "../../sync/api";
import { BOOKS, bookName } from "../../lib/bookNames";
import {
  classifyAiTranslateResult,
  defaultIntent,
  importActionFor,
  mainPaneState,
  repullDefaultRange,
  type BooksFetchStatus,
  type ImportIntent,
} from "../../lib/importIntent";
import { startBookAiTranslate } from "../../lib/aiTranslate";
import { isTranslationProject, useProjectConfig } from "../../hooks/useProjectConfig";
import { ImportFromDoor43Dialog } from "../ImportFromDoor43Dialog";
import { FlowStatusChip } from "./FlowStatusChip";
import { Panel, PanelBody, PanelFoot, PanelTop } from "./BooksPanel";
import { BooksActivityPanel, BooksPendingPanel } from "./BooksActivityPanels";
import { BooksLanePanel } from "./BooksLanePanel";
import type { FlowScreenContext } from "./types";

export interface BooksScreenProps extends FlowScreenContext {
  // Live in-session position for the Continue card, preferring the current
  // session's navigation over the (potentially stale) `me.lastBook` snapshot
  // fetched once at boot. `null` when there is no last position at all.
  lastPosition: { book: string; chapter: number; verse: number } | null;
}

const OT_COUNT = 39;
const OT = BOOKS.slice(0, OT_COUNT).map((b) => b.code);
const NT = BOOKS.slice(OT_COUNT).map((b) => b.code);

// Canonical sub-groups for the phone accordion tree (the tile grid stays
// OT/NT only). Same set as the mockup's CANON_GROUPS.
const CANON_GROUPS: Array<{
  title: string;
  groups: Array<{ name: string | null; books: string[] }>;
}> = [
  {
    title: "Old Testament",
    groups: [
      { name: "Law", books: ["GEN", "EXO", "LEV", "NUM", "DEU"] },
      {
        name: "History",
        books: ["JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST"],
      },
      { name: "Wisdom & Poetry", books: ["JOB", "PSA", "PRO", "ECC", "SNG"] },
      { name: "Major Prophets", books: ["ISA", "JER", "LAM", "EZK", "DAN"] },
      {
        name: "Minor Prophets",
        books: ["HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL"],
      },
    ],
  },
  {
    title: "New Testament",
    groups: [
      { name: "Gospels & Acts", books: ["MAT", "MRK", "LUK", "JHN", "ACT"] },
      {
        name: "Pauline Epistles",
        books: ["ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM"],
      },
      { name: "General Epistles", books: ["HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD"] },
      // REV rides bare under NT — a one-book collapse group is pointless.
      { name: null, books: ["REV"] },
    ],
  },
];

function matchesQuery(code: string, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  return code.toLowerCase().includes(q) || bookName(code).toLowerCase().includes(q);
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return body?.message ?? body?.error ?? `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function BookTile({
  code,
  imported,
  selected,
  onSelect,
}: {
  code: string;
  imported: boolean;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      aria-current={selected}
      onClick={() => onSelect(code)}
      sx={{
        appearance: "none",
        textAlign: "start",
        font: "inherit",
        color: "inherit",
        border: 1,
        borderColor: selected ? "primary.main" : "divider",
        bgcolor: selected ? "action.selected" : "background.paper",
        borderRadius: 1.25,
        paddingBlock: 1.125,
        paddingInline: 1.25,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 0.5,
        minHeight: 44,
        "&:hover": { borderColor: "primary.main" },
      }}
    >
      <Box component="span" sx={{ fontWeight: 700, fontSize: "0.85rem" }}>
        {code}
      </Box>
      <Box component="span" sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
        {bookName(code)}
      </Box>
      <FlowStatusChip kind={imported ? "approved" : "draft"} label={imported ? "Imported" : "Not imported"} />
    </Box>
  );
}

function BookRow({
  code,
  imported,
  selected,
  onSelect,
}: {
  code: string;
  imported: boolean;
  selected: boolean;
  onSelect: (code: string) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      aria-current={selected}
      onClick={() => onSelect(code)}
      sx={{
        appearance: "none",
        font: "inherit",
        color: "inherit",
        width: "100%",
        textAlign: "start",
        display: "flex",
        alignItems: "center",
        gap: 1,
        border: "none",
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        bgcolor: selected ? "action.selected" : "background.paper",
        paddingBlock: 1.125,
        paddingInline: 1.25,
        minHeight: 44,
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box component="span" sx={{ fontWeight: 700, fontSize: "0.8125rem" }}>
        {code}
      </Box>
      <Box component="span" sx={{ flex: 1, minWidth: 0, color: "text.secondary", fontSize: "0.8125rem" }}>
        {bookName(code)}
      </Box>
      <FlowStatusChip kind={imported ? "approved" : "draft"} label={imported ? "Imported" : "Not imported"} />
    </Box>
  );
}

function LintBadge({ book }: { book: string }) {
  const [report, setReport] = useState<BookLintReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setFailed(false);
    api
      .getBookLint(book)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [book]);

  if (failed) return <FlowStatusChip kind="skip" label="Lint unavailable" />;
  if (!report) return <FlowStatusChip kind="draft" label="Lint …" />;

  const total = report.flagCount + report.escalateCount;
  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={anchor ? true : undefined}
        sx={{
          appearance: "none",
          border: "none",
          background: "none",
          padding: 0,
          font: "inherit",
          cursor: "pointer",
          minHeight: 24,
        }}
      >
        <FlowStatusChip kind={total ? "warn" : "approved"} label={`⚑ Lint ${total}`} />
      </Box>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ p: 1.5, maxWidth: 340 }}>
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "text.secondary",
              mb: 0.75,
            }}
          >
            Lint findings — {book} ({report.flagCount} flag, {report.escalateCount} escalate)
          </Typography>
          {report.issues.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No issues found.
            </Typography>
          ) : (
            <Box component="ul" sx={{ m: 0, paddingInlineStart: 2.25, fontSize: "0.78rem", color: "text.secondary" }}>
              {report.issues.slice(0, 40).map((i, n) => (
                <Box component="li" key={`${i.check}-${i.ref}-${n}`} sx={{ mb: 0.5 }}>
                  {i.bucket === "escalate" ? "Escalate" : "Flag"} — {i.ref} ({i.resource}) {i.message}
                </Box>
              ))}
              {report.issues.length > 40 && (
                <Box component="li">…and {report.issues.length - 40} more.</Box>
              )}
            </Box>
          )}
        </Box>
      </Popover>
    </>
  );
}

function BookDetailPanel({
  book,
  imported,
  role,
  onImported,
  onOpenBook,
}: {
  book: string;
  imported: boolean;
  role: Role;
  onImported: () => Promise<void> | void;
  onOpenBook: (book: string) => void;
}) {
  const isAdmin = role === "admin";
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);

  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [intent, setIntent] = useState<ImportIntent>(() => defaultIntent(imported));
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justImported, setJustImported] = useState(false);
  const [repullOpen, setRepullOpen] = useState(false);

  const effectiveImported = imported || justImported;
  const action = importActionFor(effectiveImported, intent);

  const loadSummary = useCallback(async (): Promise<BookSummary | null> => {
    try {
      const s = await api.getBookSummary(book);
      setSummary(s);
      return s;
    } catch {
      setSummary(null);
      return null;
    }
  }, [book]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const runImport = async (translateFromSource: boolean) => {
    setBusy(true);
    setError(null);
    setWarning(null);
    setMessage(null);
    try {
      const res = await api.importBook(book, translateFromSource ? { translateFromSource: true } : undefined);
      const sources = importedSourceRepos(res.sources);
      setMessage(
        sources.length
          ? `Imported ${book} from ${sources.join(", ")}.`
          : `Imported ${book}.`,
      );
      setJustImported(true);
      await onImported();
      await loadSummary();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as Partial<ImportHasLocalEditsBody> | undefined;
        if (body?.error === "has_local_edits") {
          setError(
            `${book} already carries local edits (${body.tn ?? 0} tN, ${body.tq ?? 0} tQ, ` +
              `${body.twl ?? 0} TWL, ${body.verses ?? 0} verses). A destructive re-import would ` +
              `discard them, so it is not offered here.`,
          );
          return;
        }
      }
      setError(`Import of ${book} failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runAiTranslate = async () => {
    let chapters = (summary?.chapters ?? []).map((c) => c.chapter).sort((a, b) => a - b);
    if (chapters.length === 0) {
      const fresh = await loadSummary();
      chapters = (fresh?.chapters ?? []).map((c) => c.chapter).sort((a, b) => a - b);
    }
    if (chapters.length === 0) {
      setMessage("Nothing to translate — this book has no chapters loaded.");
      return;
    }
    setAiBusy(true);
    setError(null);
    setWarning(null);
    try {
      const res = await startBookAiTranslate(book, chapters);
      const verdict = classifyAiTranslateResult(res);
      if (verdict === "failed") {
        setError(
          "No AI runs started. The pipeline is often unavailable in this environment (503 pipeline_api_disabled when no bot token is configured).",
        );
      } else if (verdict === "partial") {
        setWarning(`${res.started} run(s) started, ${res.failed} failed to start.`);
      } else {
        setMessage(
          `${res.started} AI run(s) started${res.skipped ? `, ${res.skipped} already running` : ""}.`,
        );
      }
    } finally {
      setAiBusy(false);
    }
  };

  const chapterNumbers = useMemo(() => (summary?.chapters ?? []).map((c) => c.chapter), [summary]);
  const chapterCount = summary?.chapters.length ?? 0;
  const tnTotal = summary?.chapters.reduce((s, c) => s + c.tn, 0) ?? 0;
  const tqTotal = summary?.chapters.reduce((s, c) => s + c.tq, 0) ?? 0;

  return (
    <Stack spacing={2}>
      <Panel>
        <PanelTop
          title={`${book} — ${bookName(book)}`}
          aside={
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
              <FlowStatusChip
                kind={effectiveImported ? "approved" : "draft"}
                label={effectiveImported ? "Imported" : "Not imported"}
              />
              {effectiveImported && <LintBadge book={book} />}
            </Stack>
          }
          sub={
            effectiveImported
              ? `${chapterCount} chapter(s) loaded · ${tnTotal} notes · ${tqTotal} questions`
              : "This book has no content in the editor yet."
          }
        />
        <PanelBody>
          {!isAdmin ? (
            effectiveImported ? (
              <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap", rowGap: 1 }}>
                <Button variant="contained" onClick={() => onOpenBook(book)} sx={{ minHeight: 40 }}>
                  Open {book}
                </Button>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Nothing to open yet — an administrator brings books into the editor.
              </Typography>
            )
          ) : (
            <>
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  mb: 0.75,
                }}
              >
                Intent
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={intent}
                onChange={(_, v) => {
                  if (v) setIntent(v as ImportIntent);
                }}
                sx={{ flexWrap: "wrap" }}
              >
                <ToggleButton value="translate" sx={{ textTransform: "none", px: 2, minHeight: 36 }}>
                  Translate a new book
                </ToggleButton>
                <ToggleButton value="load" sx={{ textTransform: "none", px: 2, minHeight: 36 }}>
                  Load my existing work
                </ToggleButton>
              </ToggleButtonGroup>

              <Stack direction="row" spacing={1.5} sx={{ mt: 2, flexWrap: "wrap", rowGap: 1 }}>
                {action.kind === "import" ? (
                  <Button
                    variant="contained"
                    disabled={busy}
                    onClick={() => void runImport(action.translateFromSource)}
                    startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
                    sx={{ minHeight: 40 }}
                  >
                    {busy ? `Importing ${book}…` : `Import ${book}`}
                  </Button>
                ) : (
                  <>
                    <Button variant="contained" onClick={() => onOpenBook(book)} sx={{ minHeight: 40 }}>
                      Open {book}
                    </Button>
                    <Button variant="outlined" onClick={() => setRepullOpen(true)} sx={{ minHeight: 40 }}>
                      Re-pull…
                    </Button>
                  </>
                )}
                {effectiveImported && isTranslation && (
                  <Button
                    variant="outlined"
                    color="secondary"
                    disabled={aiBusy}
                    onClick={() => void runAiTranslate()}
                    startIcon={aiBusy ? <CircularProgress size={16} color="inherit" /> : undefined}
                    sx={{ minHeight: 40 }}
                  >
                    AI Translate whole book
                  </Button>
                )}
              </Stack>

              {busy && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                  Importing a book runs server-side and can take up to a minute for a large book. Leaving
                  this screen does not cancel it.
                </Typography>
              )}

              <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                Import pulls ULT/UST/tN/tQ/TWL from this project's configured source. A fresh, unedited
                book is safe to re-pull; a populated one carries more risk on the nightly re-import.
              </Alert>

              {/* 2026-08-11: the per-book source-overrides editor that used to sit
                  here (duplicated with the admin Setup screen) now lives on
                  Admin → Setup only. */}
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
                Source overrides moved to <Link href="#/admin/setup">Admin → Setup</Link>.
              </Typography>
            </>
          )}

          {message && (
            <Alert severity="success" sx={{ mt: 2 }} onClose={() => setMessage(null)}>
              {message}
            </Alert>
          )}
          {warning && (
            <Alert severity="warning" sx={{ mt: 2 }} onClose={() => setWarning(null)}>
              {warning}
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
        </PanelBody>
        <PanelFoot state={effectiveImported ? "Imported" : "Not yet imported"} />
      </Panel>

      {isAdmin && <BooksActivityPanel book={book} />}

      {isAdmin && (
        <ImportFromDoor43Dialog
          open={repullOpen}
          onClose={() => setRepullOpen(false)}
          book={book}
          currentChapter={1}
          initialRef={repullDefaultRange(chapterNumbers)}
          onMessage={(m) => setMessage(m)}
          onImported={() => {
            void onImported();
            void loadSummary();
          }}
        />
      )}
    </Stack>
  );
}

export default function BooksScreen({ role, onNavigate, lastPosition }: BooksScreenProps) {
  const theme = useTheme();
  const { skip } = theme.palette.flows;
  const gridView = useMediaQuery(theme.breakpoints.up("tablet"));
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Shared app-wide config cache (BookDetailPanel below already subscribes to
  // it) — read here only to label the topbar; no new fetch.
  const projectConfig = useProjectConfig();

  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [booksStatus, setBooksStatus] = useState<BooksFetchStatus>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const statusRef = useRef<BooksFetchStatus>("loading");
  const [selected, setSelected] = useState<string>("GEN");
  const [search, setSearch] = useState("");
  // Phone accordion tree: which testament / sub-group disclosures are open.
  // Fully controlled so a search-driven force-open can't flip the component
  // between controlled and uncontrolled when the query clears.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // Only auto-jump the selection to a real imported book on the FIRST load —
  // afterwards the user's click wins.
  const seededRef = useRef(false);

  const setStatus = useCallback((s: BooksFetchStatus) => {
    statusRef.current = s;
    setBooksStatus(s);
  }, []);

  const refetchBooks = useCallback(async () => {
    if (statusRef.current !== "loaded") setStatus("loading");
    try {
      const r = await api.getBooks();
      setBooks(r.books);
      setListError(null);
      setStatus("loaded");
      if (!seededRef.current && r.books.length > 0) {
        seededRef.current = true;
        if (!r.books.some((b) => b.book === "GEN")) setSelected(r.books[0].book);
      }
    } catch (e) {
      // A background-refresh failure keeps the last known-good list; an INITIAL
      // failure must never present a bogus all-"not imported" grid.
      if (statusRef.current !== "loaded") {
        setBooks([]);
        setListError(errorText(e));
        setStatus("error");
      }
    }
  }, [setStatus]);

  useEffect(() => {
    void refetchBooks();
  }, [refetchBooks]);

  const importedSet = useMemo(() => new Set(books.map((b) => b.book)), [books]);
  const query = search.trim();

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Redesign topbar (PackageHubScreen idiom): sticky, title + sub, quiet icon
  // buttons. No back chevron — this screen IS the redesign's top-level entry.
  const topbar = (
    <Box
      sx={{
        position: "sticky",
        insetBlockStart: 0,
        zIndex: 20,
        bgcolor: "background.paper",
        borderBlockEnd: "1px solid",
        borderColor: "divider",
      }}
    >
      <Box sx={{ maxWidth: 1180, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
              Books
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {projectConfig
                ? `${projectConfig.org} · ${projectConfig.languageName}`
                : "Import and manage books"}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          <IconButton
            aria-label="Open the books menu"
            title="Menu"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            aria-controls={menuAnchor ? "books-screen-menu" : undefined}
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
          >
            <TuneIcon fontSize="small" />
          </IconButton>
          <Menu id="books-screen-menu" anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            <MenuItem
              onClick={() => {
                setMenuAnchor(null);
                // Same live position the Continue card uses — `me` is a
                // boot-time snapshot, so reading it here would send the user
                // to last session's verse while the card above showed this
                // session's.
                onNavigate(
                  lastPosition?.book ?? "OBA",
                  lastPosition?.chapter ?? 1,
                  lastPosition?.verse ?? 1,
                );
              }}
            >
              <ListItemIcon>
                <MenuBookIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>Classic editor</ListItemText>
            </MenuItem>
            {role === "admin" && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  location.hash = "#/admin/progress";
                }}
              >
                <ListItemIcon>
                  <AdminPanelSettingsIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Admin</ListItemText>
              </MenuItem>
            )}
          </Menu>
        </Stack>
      </Box>
    </Box>
  );

  const listPane =
    booksStatus === "loading" ? (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2">Loading book list…</Typography>
      </Stack>
    ) : booksStatus === "error" ? (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refetchBooks()}>
            Retry
          </Button>
        }
      >
        Could not load the book list ({listError}). Import status is unknown, so no books are shown —
        an empty list here would wrongly read as "nothing imported".
      </Alert>
    ) : gridView ? (
      <Stack spacing={2}>
        {[
          { title: `Old Testament (${OT.length})`, codes: OT },
          { title: `New Testament (${NT.length})`, codes: NT },
        ].map((group) => {
          const visible = group.codes.filter((c) => matchesQuery(c, query));
          if (visible.length === 0) return null;
          return (
            <Box key={group.title}>
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  mb: 1,
                }}
              >
                {group.title}
              </Typography>
              <Box
                sx={{
                  display: "grid",
                  gap: 1,
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                }}
              >
                {visible.map((code) => (
                  <BookTile
                    key={code}
                    code={code}
                    imported={importedSet.has(code)}
                    selected={selected === code}
                    onSelect={setSelected}
                  />
                ))}
              </Box>
            </Box>
          );
        })}
      </Stack>
    ) : (
      // Phone band: collapsed canonical accordion tree instead of the grid.
      // While searching, any group holding a match is force-expanded.
      <Box>
        {CANON_GROUPS.map((testament) => {
          const testamentBooks = testament.groups.flatMap((g) => g.books);
          const anyMatch = testamentBooks.some((c) => matchesQuery(c, query));
          if (query && !anyMatch) return null;
          return (
            <Accordion
              key={testament.title}
              disableGutters
              elevation={0}
              expanded={query ? true : openGroups.has(testament.title)}
              onChange={() => !query && toggleGroup(testament.title)}
              sx={{ border: 1, borderColor: "divider", mb: 1.25, "&:before": { display: "none" } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44 }}>
                <Typography sx={{ fontWeight: 700, fontSize: "0.875rem" }}>{testament.title}</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 1 }}>
                {testament.groups.map((group) => {
                  const visible = group.books.filter((c) => matchesQuery(c, query));
                  if (visible.length === 0) return null;
                  const rows = visible.map((code) => (
                    <BookRow
                      key={code}
                      code={code}
                      imported={importedSet.has(code)}
                      selected={selected === code}
                      onSelect={setSelected}
                    />
                  ));
                  if (!group.name) return <Box key="bare">{rows}</Box>;
                  return (
                    <Accordion
                      key={group.name}
                      disableGutters
                      elevation={0}
                      expanded={query ? true : openGroups.has(group.name)}
                      onChange={() => !query && group.name && toggleGroup(group.name)}
                      sx={{ border: 1, borderColor: "divider", mb: 1, "&:before": { display: "none" } }}
                    >
                      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44 }}>
                        <Typography sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>
                          {group.name}{" "}
                          <Box component="span" sx={{ color: "text.secondary", fontWeight: 400 }}>
                            ({group.books.length})
                          </Box>
                        </Typography>
                      </AccordionSummary>
                      <AccordionDetails sx={{ p: 0 }}>{rows}</AccordionDetails>
                    </Accordion>
                  );
                })}
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
    );

  const detailPane = (() => {
    const pane = mainPaneState(true, booksStatus);
    if (pane === "loading") {
      return (
        <Panel>
          <PanelBody>
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2">Checking import status…</Typography>
            </Stack>
          </PanelBody>
        </Panel>
      );
    }
    if (pane === "error") {
      return (
        <Panel>
          <PanelBody>
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void refetchBooks()}>
                  Retry
                </Button>
              }
            >
              Import status is unknown until the book list loads, so no import action is offered.
            </Alert>
          </PanelBody>
        </Panel>
      );
    }
    return (
      <BookDetailPanel
        key={selected}
        book={selected}
        imported={importedSet.has(selected)}
        role={role}
        onImported={refetchBooks}
        // Redesign entry point: opening a book lands on its package hub
        // (#/package/{book}), not the classic chapter view. Classic remains
        // reachable through its own routes.
        onOpenBook={(b) => {
          location.hash = `#/package/${b}`;
        }}
      />
    );
  })();

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      {topbar}
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
      {lastPosition && (
        <Box sx={{ mb: 2.5 }}>
          <Panel>
            {/* One compact row — this sits above the canon grid on the landing
                screen, so it states where you were and offers the two jumps
                without pushing the books below the fold. */}
            <Stack
              direction="row"
              alignItems="center"
              sx={{ gap: 1.5, flexWrap: "wrap", paddingBlock: 1.5, paddingInline: 2 }}
            >
              <Box sx={{ flex: "1 1 200px", minWidth: 0 }}>
                <Typography
                  component="h2"
                  sx={{ fontSize: "0.75rem", fontWeight: 700, letterSpacing: "0.06em", color: "text.secondary" }}
                >
                  CONTINUE
                </Typography>
                <Typography sx={{ fontSize: "1rem", fontWeight: 600 }}>
                  {`${bookName(lastPosition.book)} ${lastPosition.chapter}:${lastPosition.verse}`}
                </Typography>
              </Box>
              <Button
                variant="contained"
                size="small"
                onClick={() => {
                  location.hash = `#/package/${lastPosition.book}`;
                }}
              >
                Open {lastPosition.book}
              </Button>
              <Button
                variant="outlined"
                size="small"
                endIcon={
                  <ArrowForwardIcon
                    fontSize="small"
                    sx={theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined}
                  />
                }
                onClick={() => {
                  location.hash = `#/notes/${lastPosition.book}/${lastPosition.chapter}/${lastPosition.verse}`;
                }}
              >
                Notes
              </Button>
            </Stack>
          </Panel>
        </Box>
      )}
      <Box sx={{ mt: 0, mb: 2 }}>
        {role === "admin" ? (
          <>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "primary.main",
              }}
            >
              Bundle B · Bring in a book
            </Typography>
            <Typography variant="h5" sx={{ fontSize: "1.5rem", letterSpacing: "-0.02em" }}>
              Import
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {booksStatus === "loaded"
                ? `${books.length}/${BOOKS.length} imported`
                : booksStatus === "error"
                  ? "Import counts unavailable — the book list failed to load."
                  : "Counting imported books…"}
            </Typography>
          </>
        ) : (
          <Typography variant="h5" sx={{ fontSize: "1.5rem", letterSpacing: "-0.02em" }}>
            Browse books
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: "grid",
          gap: 2.5,
          alignItems: "start",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1fr) minmax(320px, 420px)" },
        }}
      >
        <Panel>
          <PanelTop
            title="Books"
            sub="The whole 66-book canon, grouped Old/New Testament. A failed list load shows an explicit error — it never silently falls back to “not imported”."
          />
          <PanelBody>
            <TextField
              size="small"
              fullWidth
              type="search"
              placeholder="Search books…"
              aria-label="Search books"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ mb: 1.5 }}
            />
            {listPane}
          </PanelBody>
          <PanelFoot
            state={
              booksStatus === "loaded"
                ? `${books.length} book(s) imported of ${BOOKS.length}`
                : booksStatus === "error"
                  ? "Load failed"
                  : "Loading…"
            }
          >
            <Button size="small" sx={{ minHeight: 36 }} onClick={() => void refetchBooks()}>
              Retry list
            </Button>
          </PanelFoot>
        </Panel>

        <Box sx={{ minWidth: 0 }}>{detailPane}</Box>
      </Box>

      {role === "admin" && (
        <Box sx={{ mt: 2.5 }}>
          <BooksPendingPanel book={selected} />
        </Box>
      )}

      {role === "admin" && (
        <Box sx={{ mt: 2.5 }}>
          <BooksLanePanel />
        </Box>
      )}
      </Box>
    </Box>
  );
}
