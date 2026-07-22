// The IMPORT surface (route: #/import and #/import/:book). A deliberate,
// source-aware, per-book bootstrap workflow — the counterpart to the CONFIGURE
// wizard (separate PR). Two intents drive it:
//   • "Translate a new book" — pull the upstream English source (ULT/UST + tN/tQ)
//     for a book not yet in BE, then optionally AI-Translate notes/questions.
//   • "Load my existing work" — pull a book from the org's own repo to view/edit.
//
// SAFETY: the decision logic lives in ../lib/importIntent (unit-tested). An
// already-imported book NEVER hits the destructive POST /import — it routes to
// the editor, and a pristine-preserving re-pull is offered via the existing
// ImportFromDoor43Dialog. Mirrors the TemplateWorkspace/ArticleWorkspace shape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  importedSourceRepos,
  type BookListEntry,
  type BookSummary,
} from "../sync/api";
import { BOOKS, bookName, bookAbbr } from "../lib/bookNames";
import {
  defaultIntent,
  importActionFor,
  repullDefaultRange,
  classifyAiTranslateResult,
  mainPaneState,
  type ImportIntent,
  type BooksFetchStatus,
} from "../lib/importIntent";
import { startBookAiTranslate } from "../lib/aiTranslate";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { ImportFromDoor43Dialog } from "./ImportFromDoor43Dialog";
import { BookSourceOverridesPanel } from "./BookSourceOverridesPanel";

interface Props {
  /** Selected book (from #/import/:book), or null on the bare #/import route. */
  book: string | null;
  /**
   * Pending scripture target carried through the route (#/import/BOOK/CH/VERSE),
   * e.g. from a reference-box nav to an un-imported book. "Open in editor" lands
   * here after import instead of resetting to 1:1.
   */
  target: { chapter: number; verse: number } | null;
  /** Set the hash to #/import/:book (or #/import when null). */
  onNavigate: (book: string | null) => void;
  /** Return to the last scripture location. */
  onBack: () => void;
  /** Open a book in the scripture editor (defaults to chapter 1, verse 1). */
  onOpenBook: (book: string, chapter?: number, verse?: number) => void;
}

export function ImportWorkspace({ book, target, onNavigate, onBack, onOpenBook }: Props) {
  const { t } = useTranslation();
  const [books, setBooks] = useState<BookListEntry[]>([]);
  // Explicit tri-state: a FAILED GET /api/books must NOT collapse into an empty
  // "not-imported" list (that would re-expose the destructive import path for an
  // already-imported book). "error" is surfaced as a retry, never as "ready".
  const [booksStatus, setBooksStatus] = useState<BooksFetchStatus>("loading");
  // Mirror of booksStatus for logic inside the async callback (no stale closure).
  const statusRef = useRef<BooksFetchStatus>("loading");
  const setStatus = useCallback((s: BooksFetchStatus) => {
    statusRef.current = s;
    setBooksStatus(s);
  }, []);
  const [search, setSearch] = useState("");

  const refetchBooks = useCallback(() => {
    // Only show the blocking "loading" gate before we've EVER loaded (initial
    // load or a retry from error). A background refresh (e.g. after an import)
    // keeps the known-good list so the pane doesn't flash/unmount.
    if (statusRef.current !== "loaded") setStatus("loading");
    return api
      .getBooks()
      .then((r) => {
        setBooks(r.books);
        setStatus("loaded");
      })
      .catch(() => {
        // Only regress to the error gate when we have NO good list yet. A
        // background-refresh failure keeps the last known-good statuses rather
        // than blanking them — but an initial failure must never present a
        // bogus all-"not imported" list (the safety hole).
        if (statusRef.current !== "loaded") {
          setBooks([]);
          setStatus("error");
        }
      });
  }, [setStatus]);

  useEffect(() => {
    void refetchBooks();
  }, [refetchBooks]);

  const importedSet = useMemo(() => new Set(books.map((b) => b.book)), [books]);

  const query = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      BOOKS.filter((b) => {
        if (!query) return true;
        return (
          b.code.toLowerCase().includes(query) ||
          bookName(b.code).toLowerCase().includes(query) ||
          bookAbbr(b.code).toLowerCase().includes(query)
        );
      }),
    [query],
  );

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail: canonical book list ── */}
      <Box
        sx={{
          width: 280,
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
            <Tooltip title={t("import.backToScripture")}>
              <IconButton size="small" onClick={onBack} sx={{ ml: -0.5 }}>
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("import.title")}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {booksStatus === "loaded"
              ? t("import.importedCount", { n: books.length, total: BOOKS.length })
              : booksStatus === "error"
                ? t("import.loadFailed")
                : " "}
          </Typography>
          <TextField
            size="small"
            fullWidth
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("import.searchPlaceholder")}
            inputProps={{ style: { fontSize: 13 } }}
          />
        </Stack>

        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {booksStatus === "loading" ? (
            <Stack alignItems="center" sx={{ p: 3 }}>
              <CircularProgress size={20} />
            </Stack>
          ) : booksStatus === "error" ? (
            // Don't render the canonical list with all-"not imported" chips when
            // we couldn't fetch status — that's misleading. Offer a retry.
            <Stack spacing={1.5} sx={{ p: 2 }} alignItems="flex-start">
              <Typography variant="body2" color="text.secondary">
                {t("import.loadFailed")}
              </Typography>
              <Button size="small" variant="outlined" onClick={() => void refetchBooks()}>
                {t("import.retry")}
              </Button>
            </Stack>
          ) : (
            rows.map((b) => {
              const selected = b.code === book;
              const imported = importedSet.has(b.code);
              return (
                <Box
                  key={b.code}
                  onClick={() => onNavigate(b.code)}
                  sx={{
                    px: 1.5,
                    py: 0.75,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                    borderInlineStart: "3px solid",
                    borderColor: selected ? "primary.main" : "transparent",
                    bgcolor: selected
                      ? (theme) => alpha(theme.palette.primary.main, 0.08)
                      : "transparent",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <Box sx={{ flex: 1, overflow: "hidden" }}>
                    <Typography
                      variant="body2"
                      sx={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      <Box component="span" sx={{ fontFamily: "monospace", color: "text.secondary", mr: 0.75 }}>
                        {b.code}
                      </Box>
                      {bookName(b.code)}
                    </Typography>
                  </Box>
                  <Chip
                    label={imported ? t("import.imported") : t("import.notImported")}
                    size="small"
                    variant="outlined"
                    color={imported ? "success" : "default"}
                    sx={{ height: 18, fontSize: 10, fontWeight: 600 }}
                  />
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {(() => {
          // Gate on a SUCCESSFUL books fetch: until GET /api/books resolves we
          // don't know this book's imported status. A failed fetch must render
          // an error+retry — NEVER the pane, whose empty-list "not imported"
          // state would offer a destructive Import for an imported book.
          const pane = mainPaneState(!!book, booksStatus);
          if (pane === "empty") {
            return (
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("import.selectBook")}
                </Typography>
              </Stack>
            );
          }
          if (pane === "loading") {
            return (
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
                <CircularProgress size={24} />
              </Stack>
            );
          }
          if (pane === "error") {
            return (
              <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ height: "100%", px: 4 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("import.loadFailed")}
                </Typography>
                <Button variant="outlined" onClick={() => void refetchBooks()}>
                  {t("import.retry")}
                </Button>
              </Stack>
            );
          }
          return (
            <BookImportPane
              key={book!}
              book={book!}
              imported={importedSet.has(book!)}
              target={target}
              onImported={refetchBooks}
              onOpenBook={onOpenBook}
            />
          );
        })()}
      </Box>
    </Box>
  );
}

interface PaneProps {
  book: string;
  imported: boolean;
  target: { chapter: number; verse: number } | null;
  onImported: () => Promise<void> | void;
  onOpenBook: (book: string, chapter?: number, verse?: number) => void;
}

function BookImportPane({ book, imported, target, onImported, onOpenBook }: PaneProps) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);

  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [intent, setIntent] = useState<ImportIntent>(() => defaultIntent(imported));
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Import succeeded this session — reflect the "imported" state immediately
  // (the parent's books refetch is async) and reveal the post-import actions.
  const [justImported, setJustImported] = useState(false);
  const [repullOpen, setRepullOpen] = useState(false);

  const effectiveImported = imported || justImported;

  // Returns the fresh summary too, so callers that need the chapter list right
  // away (AI-translate immediately after import) don't race the state update.
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

  const action = importActionFor(effectiveImported, intent);

  const openBook = useCallback(
    () => onOpenBook(book, target?.chapter, target?.verse),
    [onOpenBook, book, target],
  );

  const runImport = useCallback(
    async (translateFromSource: boolean) => {
      setBusy(true);
      setError(null);
      setWarning(null);
      setMessage(null);
      try {
        const res = await api.importBook(
          book,
          translateFromSource ? { translateFromSource: true } : undefined,
        );
        const sources = importedSourceRepos(res.sources);
        setMessage(
          sources.length
            ? t("import.importedFromSource", { book, repos: sources.join(", ") })
            : t("import.importedOk", { book }),
        );
        setJustImported(true);
        await onImported();
        // Await the summary so AI-translate (which reads the chapter list) is
        // armed with real chapters the moment its button appears.
        await loadSummary();
      } catch (e) {
        const body =
          e instanceof ApiError ? (e.body as { error?: string; message?: string } | undefined) : undefined;
        const msg = body?.message ?? body?.error ?? (e instanceof Error ? e.message : String(e));
        setError(t("import.importFailed", { book, message: msg }));
      } finally {
        setBusy(false);
      }
    },
    [book, onImported, loadSummary, t],
  );

  const runAiTranslate = useCallback(async () => {
    // Prefer loaded chapters; if the summary hasn't landed yet (e.g. a fresh
    // deep-link), fetch it fresh rather than reporting "nothing to translate".
    let chapters = (summary?.chapters ?? []).map((c) => c.chapter).sort((a, b) => a - b);
    if (chapters.length === 0) {
      const fresh = await loadSummary();
      chapters = (fresh?.chapters ?? []).map((c) => c.chapter).sort((a, b) => a - b);
    }
    if (chapters.length === 0) {
      setMessage(t("import.aiTranslateNone"));
      return;
    }
    setAiBusy(true);
    setError(null);
    setWarning(null);
    try {
      const res = await startBookAiTranslate(book, chapters);
      const verdict = classifyAiTranslateResult(res);
      if (verdict === "failed") {
        setError(t("import.aiTranslateFailedAll"));
      } else if (verdict === "partial") {
        setWarning(t("import.aiTranslatePartial", { started: res.started, failed: res.failed }));
      } else {
        const suffix = res.skipped ? t("import.aiTranslateSkipped", { skipped: res.skipped }) : "";
        setMessage(t("import.aiTranslateStarted", { started: res.started, suffix }));
      }
    } finally {
      setAiBusy(false);
    }
  }, [book, summary, loadSummary, t]);

  const chapterNumbers = useMemo(
    () => (summary?.chapters ?? []).map((c) => c.chapter),
    [summary],
  );
  const chapterCount = summary?.chapters.length ?? 0;
  const tnTotal = summary?.chapters.reduce((s, c) => s + c.tn, 0) ?? 0;
  const tqTotal = summary?.chapters.reduce((s, c) => s + c.tq, 0) ?? 0;
  // Available for ANY imported, translation-eligible book — not just the one
  // imported this session — so already-imported books (the everyday case) can
  // be AI-translated from here too.
  const showAiTranslate = effectiveImported && isTranslation;

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 760, mx: "auto" }}>
      {/* Header */}
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 0.5, flexWrap: "wrap" }}>
        <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
          {book}
        </Typography>
        <Typography variant="h6" color="text.secondary">
          {bookName(book)}
        </Typography>
        <Chip
          label={effectiveImported ? t("import.imported") : t("import.notImported")}
          size="small"
          variant="outlined"
          color={effectiveImported ? "success" : "default"}
        />
      </Stack>
      {effectiveImported ? (
        <Typography variant="caption" color="text.secondary">
          {t("import.summaryHint", { chapters: chapterCount, tn: tnTotal, tq: tqTotal })}
        </Typography>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {t("import.notImportedYet")}
        </Typography>
      )}

      {/* Intent toggle */}
      <Box sx={{ mt: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t("import.intentLegend")}
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={intent}
          onChange={(_, v) => {
            if (v) setIntent(v as ImportIntent);
          }}
          size="small"
          sx={{ flexWrap: "wrap" }}
        >
          <ToggleButton value="translate" sx={{ textTransform: "none", px: 2 }}>
            {t("import.intentTranslate")}
          </ToggleButton>
          <ToggleButton value="load" sx={{ textTransform: "none", px: 2 }}>
            {t("import.intentLoad")}
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {intent === "translate" ? t("import.intentTranslateDesc") : t("import.intentLoadDesc")}
        </Typography>
      </Box>

      {/* Advanced — per-book / per-chapter-range resource source overrides. */}
      <Accordion
        disableGutters
        elevation={0}
        sx={{ mt: 2, border: "1px solid", borderColor: "divider", "&:before": { display: "none" } }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2">{t("import.sources.title")}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <BookSourceOverridesPanel book={book} />
        </AccordionDetails>
      </Accordion>

      {/* Actions */}
      <Stack direction="row" spacing={1.5} sx={{ mt: 3, flexWrap: "wrap", rowGap: 1 }}>
        {action.kind === "import" ? (
          <Button
            variant="contained"
            startIcon={
              busy ? <CircularProgress size={16} color="inherit" /> : <CloudDownloadIcon />
            }
            disabled={busy}
            onClick={() => void runImport(action.translateFromSource)}
          >
            {busy ? t("import.importing") : t("import.importButton", { book })}
          </Button>
        ) : (
          <>
            <Button
              variant="contained"
              startIcon={<OpenInNewIcon />}
              onClick={openBook}
            >
              {t("import.openButton")}
            </Button>
            <Button
              variant="outlined"
              startIcon={<CloudDownloadIcon />}
              onClick={() => setRepullOpen(true)}
            >
              {t("import.repullButton")}
            </Button>
          </>
        )}
        {showAiTranslate && (
          <Button
            variant="outlined"
            color="secondary"
            startIcon={aiBusy ? <CircularProgress size={16} color="inherit" /> : <AutoAwesomeIcon />}
            disabled={aiBusy}
            onClick={() => void runAiTranslate()}
          >
            {t("import.aiTranslate")}
          </Button>
        )}
      </Stack>

      {action.kind === "open" && !justImported && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
          {t("import.alreadyImported")}
        </Typography>
      )}
      {showAiTranslate && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
          {t("import.aiTranslateDesc")}
        </Typography>
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

      <ImportFromDoor43Dialog
        open={repullOpen}
        onClose={() => setRepullOpen(false)}
        book={book}
        currentChapter={1}
        // Default the re-pull to the WHOLE book so accepting it refreshes every
        // chapter, not just chapter 1. The user can still narrow the range.
        initialRef={repullDefaultRange(chapterNumbers)}
        onMessage={(m) => setMessage(m)}
        onImported={() => {
          void onImported();
          void loadSummary();
        }}
      />
    </Box>
  );
}
