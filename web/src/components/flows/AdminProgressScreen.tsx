// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// AdminProgressScreen — #/admin/progress, the Progress section of the
// redesigned admin desk (rendered inside AdminDesk, which owns the rail
// chrome). Desktop-first per Benjamin's 2026-08-10 direction.
//
// ── Honesty mapping — what the artifact shows vs. what endpoints exist ──────
//
// The design artifact ("Admin · Progress — Book Packages") tier-labels its
// sections Today / Phase 2 / Later, and its "Today" numbers are mock data.
// This file renders ONLY what real endpoints support, and records the unlock
// for everything omitted. The data reality (established by
// PackageHubScreen.tsx's header, re-verified here):
//
//   * The ONLY book-level aggregate is BookSummary (web/src/sync/api.ts:167-176)
//     — per-chapter verses / tn / tq / twl counts, one GET /api/chapters/{book}
//     per book (api.ts:1589-1590). Approval/validation rollups do NOT exist at
//     book level: `translation_state` lives on individual rows inside
//     ChapterPayload (api.ts:156-165), per-chapter payloads only, and fetching
//     every chapter of every book (N+1) is forbidden.
//   * The workspace book list is GET /api/books → { books: BookListEntry[] }
//     (api.ts:1704; BookListEntry api.ts:902-905) — book code + imported_at
//     only, NO counts. So the board costs 1 (books) + N (one BookSummary per
//     imported book, concurrency-limited to 4) requests — summaries are
//     fetched only for books actually present in the workspace, never for the
//     whole 66-book canon. Cheaper unlock: a workspace book-list endpoint that
//     carries counts (e.g. GET /api/books growing per-book totals) would make
//     this 1 request.
//
// What IS shown, with endpoint evidence:
//
//   * KPI tiles — content counts only, never completion percentages:
//     books in workspace (GET /api/books), verses / notes / word links /
//     questions (sums of the loaded BookSummary rows). While summaries are
//     still loading the tiles say so instead of showing a partial number as
//     if it were final.
//   * Book package board — one row per imported book, with the counts
//     BookSummary honestly provides (chapters / verses / tn / tq / twl) and
//     an imported-at date from BookListEntry. Clicking a row expands a
//     per-chapter drawer (same data, per chapter), mirroring the hub's inline
//     expansion. Chapter 0 (front-matter intro rows) is excluded from counts,
//     same as PackageHubScreen (its header, "BookSummary includes a chapter-0
//     entry") — intro rows aren't reachable via the chapter-scoped screens.
//   * Activity — the two real feeds ObserveScreen.tsx already surfaces:
//     export snapshots via api.exportsList() (GET /api/exports, capped to
//     FEED_LIMIT since only the top FEED_LIMIT merged items ever render) and
//     AI pipeline jobs via api.pipelineList() (GET /api/pipelines).
//     Merged and sorted by timestamp (committed_at / updated_at, unix seconds
//     — PipelineJobRow api.ts:1419-1420).
//
// What is OMITTED, and the unlock for each:
//
//   * Percent-complete / Overall / Literal / Simplified / Notes% / Articles
//     columns and progress bars — no approval rollup endpoint. Unlock: the
//     per-chapter `tnValidated` / `tqValidated` / `versesDone` extension to
//     GET /api/chapters/{book} already proposed in PackageHubScreen.tsx's
//     header.
//   * Step and Pair columns — workflow stages have no backend
//     (docs/flows/02-architecture.md D2, restated in ObserveScreen.tsx's
//     WorkflowStagesCard) and no pair-assignment model exists on any endpoint.
//   * Chapter checkoff board — per-verse lane checks exist only inside
//     ChapterPayload.verseLaneChecks (api.ts:163-164), per-chapter payloads;
//     rendering the board would be exactly the per-chapter-per-resource N+1
//     this screen refuses. Unlock: per-chapter per-lane checked-count rollups
//     on the same GET /api/chapters/{book} extension.
//   * Waiting on — no validation-queue or nudge endpoint (artifact marks it
//     Phase 2). Unlock: a queue endpoint plus a notification channel.
//   * KPI tiles "Average progress" / "Awaiting final validation" / "Stalled"
//     — all derive from the missing approval rollups above.
//   * Human editing activity ("Pair 2 finished Align on Titus 1") — edits are
//     audited in edit_log server-side (api.ts:41,836 reference it) but there
//     is no list endpoint. Unlock: GET /api/activity (or /api/edit-log) with
//     workspace-scoped recent entries.
//
// Request budget: 1 (books) + N (summaries, N = imported books, 4 in flight
// at a time) + 1 (exports) + 1 (pipelines). No per-chapter fetches, ever.
//
// Admin gating: same convention as ObserveScreen.tsx:551-576 — a non-admin
// gets an honest "Admin only" card, nothing fabricated in its place.
// RTL: logical properties only (paddingInline / insetBlockStart / textAlign
// start-end); tables sit inside their own overflow-x wrappers.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  type BookListEntry,
  type BookSummary,
  type ExportSnapshot,
  type PipelineJobRow,
} from "../../sync/api";
import { bookName, BOOKS } from "../../lib/bookNames";
import { realChapters } from "../../lib/bookSummary";
import { useProjectConfig } from "../../hooks/useProjectConfig";

export interface AdminProgressScreenProps extends FlowScreenContext {}

type SummaryState =
  | { kind: "loading" }
  | { kind: "ready"; data: BookSummary }
  | { kind: "error" };

interface BookTotals {
  chapters: number;
  verses: number;
  tn: number;
  tq: number;
  twl: number;
}

function totalsOf(s: BookSummary): BookTotals {
  const t: BookTotals = { chapters: 0, verses: 0, tn: 0, tq: 0, twl: 0 };
  for (const c of realChapters(s)) {
    t.chapters += 1;
    t.verses += c.verses;
    t.tn += c.tn;
    t.tq += c.tq;
    t.twl += c.twl;
  }
  return t;
}

function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
}

// Canonical book order for the board (BOOKS is the canon list in
// web/src/lib/bookNames.ts:21); unknown codes sort last, alphabetically.
const CANON_INDEX = new Map(BOOKS.map((b, i) => [b.code, i]));

function canonSort(a: BookListEntry, b: BookListEntry): number {
  const ia = CANON_INDEX.get(a.book.toUpperCase());
  const ib = CANON_INDEX.get(b.book.toUpperCase());
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return a.book.localeCompare(b.book);
}

// ── Panel chrome — the artifact's .panel top/body/foot in MUI/sx, using the
// same card tokens PackageHubScreen calibrated (radius 14, divider border,
// ocean-tinted shadow) ───────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  action,
  children,
  foot,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        boxShadow:
          theme.palette.mode === "dark"
            ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
            : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
        overflow: "hidden",
      }}
    >
      <Box sx={{ paddingBlock: 1.5, paddingInline: 2, borderBlockEnd: "1px solid", borderColor: "divider" }}>
        <Stack direction="row" alignItems="center" gap={1.25} flexWrap="wrap">
          <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, m: 0 }}>
            {title}
          </Typography>
          {action}
        </Stack>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" component="p" sx={{ m: 0, marginBlockStart: 0.25 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      <Box>{children}</Box>
      {foot && (
        <Box
          sx={{
            paddingBlock: 1.25,
            paddingInline: 2,
            borderBlockStart: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
          }}
        >
          {foot}
        </Box>
      )}
    </Box>
  );
}

function KpiTile({ label, value, cap }: { label: string; value: ReactNode; cap: string }) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        paddingBlock: 1.75,
        paddingInline: 2,
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        minWidth: 0,
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "text.secondary",
          m: 0,
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{ fontSize: "1.85rem", fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums", m: 0 }}
      >
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
        {cap}
      </Typography>
    </Box>
  );
}

// Numeric table cells: end-aligned (logical, so RTL flips it), tabular digits.
const NUM_CELL_SX = {
  textAlign: "end",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
} as const;

// One merged activity entry (see file header for the two real sources).
interface FeedItem {
  key: string;
  at: number;
  text: string;
  warn: boolean;
}

const FEED_LIMIT = 12;

export default function AdminProgressScreen({ role }: AdminProgressScreenProps) {
  const isAdmin = role === "admin";
  const cfg = useProjectConfig();
  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : "Workspace";

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Map<string, SummaryState>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<ExportSnapshot[] | null>(null);
  const [exportsError, setExportsError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PipelineJobRow[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  // Workspace book list — one request (GET /api/books, api.ts:1704).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setBooksError(null);
    api
      .getBooks()
      .then((res) => {
        if (cancelled) return;
        const sorted = [...res.books].sort(canonSort);
        setBooks(sorted);
        setSummaries(new Map(sorted.map((b) => [b.book, { kind: "loading" } as SummaryState])));
      })
      .catch((err) => {
        if (!cancelled) setBooksError(err instanceof Error ? err.message : "load failed");
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Summaries for books present in the workspace ONLY — never the whole
  // canon. Four workers drain the queue so a big workspace doesn't fire all
  // its requests at once (see file-header request budget).
  useEffect(() => {
    if (!books || books.length === 0) return;
    const ctrl = new AbortController();
    const queue = books.map((b) => b.book);
    const worker = async () => {
      for (;;) {
        const book = queue.shift();
        if (book === undefined || ctrl.signal.aborted) return;
        try {
          const data = await api.getBookSummary(book, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setSummaries((prev) => new Map(prev).set(book, { kind: "ready", data }));
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          setSummaries((prev) => new Map(prev).set(book, { kind: "error" }));
        }
      }
    };
    for (let i = 0; i < Math.min(4, queue.length); i++) void worker();
    return () => {
      ctrl.abort();
    };
  }, [books]);

  // Activity sources — export snapshots (admin-only endpoint) + pipeline jobs.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .exportsList(FEED_LIMIT)
      .then((res) => {
        if (!cancelled) setSnapshots(res.snapshots);
      })
      .catch((err) => {
        if (!cancelled)
          setExportsError(
            err instanceof ApiError
              ? `${err.status} ${(err.body as { error?: string } | null)?.error ?? err.message}`
              : "load failed",
          );
      });
    api
      .pipelineList()
      .then((res) => {
        if (!cancelled) setJobs(res.jobs);
      })
      .catch((err) => {
        if (!cancelled) setJobsError(err instanceof Error ? err.message : "load failed");
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const kpis = useMemo(() => {
    let loaded = 0;
    let errs = 0;
    const t: BookTotals = { chapters: 0, verses: 0, tn: 0, tq: 0, twl: 0 };
    for (const s of summaries.values()) {
      if (s.kind === "error") {
        errs += 1;
        continue;
      }
      if (s.kind !== "ready") continue;
      loaded += 1;
      const bt = totalsOf(s.data);
      t.verses += bt.verses;
      t.tn += bt.tn;
      t.tq += bt.tq;
      t.twl += bt.twl;
    }
    return { loaded, errs, total: summaries.size, ...t };
  }, [summaries]);

  // Sums are shown once every workspace book's summary has settled (loaded or
  // failed); a failed book is stated in the caption rather than silently
  // excluded from a number that claims to be the whole workspace.
  const sumsReady = books !== null && kpis.loaded + kpis.errs === kpis.total;
  const partialCap = (base: string) =>
    kpis.errs > 0 ? `${base} · ${kpis.errs} ${kpis.errs === 1 ? "book" : "books"} failed to load` : base;

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    for (const s of snapshots ?? []) {
      items.push({
        key: `exp-${s.id}`,
        at: s.committed_at,
        text: s.error
          ? `Export ${s.book} · ${s.resource} failed — ${s.error}`
          : `Nightly export committed ${s.book} · ${s.resource} — ${s.rows_exported} rows`,
        warn: !!s.error,
      });
    }
    for (const j of jobs ?? []) {
      const range = j.end_chapter !== j.start_chapter ? `${j.start_chapter}–${j.end_chapter}` : `${j.start_chapter}`;
      items.push({
        key: `job-${j.job_id}`,
        at: j.updated_at,
        text: `AI pipeline ${j.pipeline_type} on ${j.book} ${range} — ${j.state.replace(/_/g, " ")}`,
        warn: j.state === "failed" || j.state.startsWith("paused"),
      });
    }
    items.sort((a, b) => b.at - a.at);
    return items.slice(0, FEED_LIMIT);
  }, [snapshots, jobs]);

  // Same honest admin-only convention as ObserveScreen.tsx:551-576.
  if (!isAdmin) {
    return (
      <AdminDesk current="progress">
        <Panel title="Admin only">
          <Box sx={{ paddingBlock: 2, paddingInline: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Progress shows every imported book package with its content counts,
              recent export runs, and AI pipeline activity — only an admin can see
              it. Your role is <strong>{role}</strong>.
            </Typography>
            <Button
              variant="outlined"
              sx={{ marginBlockStart: 2 }}
              onClick={() => {
                location.hash = "#/books";
              }}
            >
              Back to books
            </Button>
          </Box>
        </Panel>
      </AdminDesk>
    );
  }

  return (
    <AdminDesk current="progress">
      <Stack spacing={2}>
        <AdminPageHeader
          eyebrow={eyebrow}
          title="Progress"
          subtitle="Every number here is real: book content counts, export runs, and AI pipeline activity. Approval progress has no book-level endpoint yet, so no percent-complete is shown — a bar with no data behind it would be an invented number."
        />

        {/* KPI tiles — content counts, not completion. */}
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 1.5,
          }}
        >
          <KpiTile
            label="Books"
            value={booksError ? "—" : books ? books.length : <Skeleton width={36} />}
            cap="imported in this workspace"
          />
          <KpiTile
            label="Verses"
            value={sumsReady ? kpis.verses : booksError ? "—" : <Skeleton width={48} />}
            cap={
              sumsReady || booksError
                ? partialCap("across all imported books")
                : `loading ${kpis.loaded} of ${kpis.total} books…`
            }
          />
          <KpiTile
            label="Notes"
            value={sumsReady ? kpis.tn : booksError ? "—" : <Skeleton width={48} />}
            cap={partialCap("translationNotes rows")}
          />
          <KpiTile
            label="Word links"
            value={sumsReady ? kpis.twl : booksError ? "—" : <Skeleton width={48} />}
            cap={partialCap("translationWords links")}
          />
          <KpiTile
            label="Questions"
            value={sumsReady ? kpis.tq : booksError ? "—" : <Skeleton width={48} />}
            cap={partialCap("translationQuestions rows")}
          />
        </Box>

        {/* Book package board */}
        <Panel
          title="Book package board"
          subtitle="One row per imported book, with the counts the API provides. Click a row for the per-chapter breakdown."
          foot={
            <Typography variant="caption" color="text.secondary">
              No percent-complete, step, or pair columns: approval state exists
              only on individual rows inside per-chapter payloads, and workflow
              stages / pair assignments have no backend. See this file&apos;s
              header for the endpoint that would unlock each.
            </Typography>
          }
        >
          {booksError && (
            <Alert severity="error" sx={{ m: 2 }}>
              Could not load the workspace book list: {booksError}
            </Alert>
          )}
          {!booksError && books === null && (
            <Box sx={{ paddingBlock: 2, paddingInline: 2 }}>
              <Skeleton variant="rounded" height={96} />
            </Box>
          )}
          {!booksError && books !== null && books.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 2, paddingInline: 2 }}>
              No books imported into this workspace yet.
            </Typography>
          )}
          {!booksError && books !== null && books.length > 0 && (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 640 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ textAlign: "start" }}>Package</TableCell>
                    <TableCell sx={{ textAlign: "start" }}>Imported</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Chapters</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Verses</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Notes</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Word links</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Questions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {books.map((b) => {
                    const s = summaries.get(b.book);
                    const open = expanded === b.book;
                    const totals = s?.kind === "ready" ? totalsOf(s.data) : null;
                    const cell = (n: number | null) =>
                      totals !== null ? n : s?.kind === "error" ? "—" : <Skeleton width={28} sx={{ marginInlineStart: "auto" }} />;
                    return (
                      <BookRowGroup
                        key={b.book}
                        entry={b}
                        state={s}
                        open={open}
                        onToggle={() => setExpanded((cur) => (cur === b.book ? null : b.book))}
                        cells={
                          <>
                            <TableCell sx={NUM_CELL_SX}>{cell(totals?.chapters ?? null)}</TableCell>
                            <TableCell sx={NUM_CELL_SX}>{cell(totals?.verses ?? null)}</TableCell>
                            <TableCell sx={NUM_CELL_SX}>{cell(totals?.tn ?? null)}</TableCell>
                            <TableCell sx={NUM_CELL_SX}>{cell(totals?.twl ?? null)}</TableCell>
                            <TableCell sx={NUM_CELL_SX}>{cell(totals?.tq ?? null)}</TableCell>
                          </>
                        }
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          )}
        </Panel>

        {/* Activity — the two real feeds (file header). */}
        <Panel
          title="Activity"
          subtitle="Export runs and AI pipeline jobs — the two activity feeds the API records."
          foot={
            <Typography variant="caption" color="text.secondary">
              Human editing activity is audited in edit_log server-side but has
              no list endpoint yet — a GET /api/activity would unlock a
              who-edited-what feed here.
            </Typography>
          }
        >
          <Box sx={{ paddingBlock: 1, paddingInline: 2 }}>
            {exportsError && <Alert severity="error" sx={{ marginBlock: 1 }}>Export runs failed to load: {exportsError}</Alert>}
            {jobsError && <Alert severity="error" sx={{ marginBlock: 1 }}>Pipeline jobs failed to load: {jobsError}</Alert>}
            {!exportsError && !jobsError && snapshots === null && jobs === null && (
              <Skeleton variant="rounded" height={80} sx={{ marginBlock: 1 }} />
            )}
            {feed.length === 0 && (snapshots !== null || jobs !== null) && (
              <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 1 }}>
                No export runs or pipeline jobs recorded yet.
              </Typography>
            )}
            {feed.map((f, i) => (
              <Stack
                key={f.key}
                direction="row"
                spacing={1.5}
                alignItems="baseline"
                sx={{
                  paddingBlock: 1,
                  ...(i > 0 ? { borderBlockStart: "1px solid", borderColor: "divider" } : {}),
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flex: "none", inlineSize: 130, fontVariantNumeric: "tabular-nums" }}
                >
                  {fmtTime(f.at)}
                </Typography>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                  {f.text}
                </Typography>
                {f.warn && <FlowStatusChip kind="warn" label="needs attention" />}
              </Stack>
            ))}
          </Box>
        </Panel>

        {/* Honest absence — sections the artifact designs that have no data
            source today. Stated once, quietly, instead of faked. */}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, paddingInline: 0.5 }}>
          Not shown (no endpoint yet): per-package completion bars, workflow
          step and pair columns, the chapter checkoff board, and the waiting-on
          queue. Each unlock is recorded in this screen&apos;s source header.
        </Typography>
      </Stack>
    </AdminDesk>
  );
}

// One board row plus its optional per-chapter drawer. Split out so the drawer
// (a second <tr>) stays adjacent to its row inside <TableBody>.
function BookRowGroup({
  entry,
  state,
  open,
  onToggle,
  cells,
}: {
  entry: BookListEntry;
  state: SummaryState | undefined;
  open: boolean;
  onToggle: () => void;
  cells: ReactNode;
}) {
  const theme = useTheme();
  const name = bookName(entry.book);
  const expandable = state?.kind === "ready";
  return (
    <>
      <TableRow
        hover={expandable}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
        sx={{ cursor: expandable ? "pointer" : "default" }}
      >
        <TableCell sx={{ textAlign: "start" }}>
          <ButtonBase
            disabled={!expandable}
            onClick={(e) => {
              // The row handles the toggle; keep the button from double-firing.
              e.stopPropagation();
              onToggle();
            }}
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, fontWeight: 700, fontSize: "0.875rem" }}
          >
            <ChevronRightIcon
              fontSize="small"
              sx={{
                color: "text.secondary",
                transition: "transform 0.15s ease",
                transform: open ? "rotate(90deg)" : "none",
                visibility: expandable ? "visible" : "hidden",
              }}
            />
            {name}
            <Typography component="span" variant="caption" color="text.secondary">
              {entry.book.toUpperCase()}
            </Typography>
          </ButtonBase>
          {state?.kind === "error" && (
            <Chip
              size="small"
              label="counts failed to load"
              sx={{
                marginInlineStart: 1,
                bgcolor: theme.palette.flows.warn.soft,
                color: theme.palette.flows.warn.ink,
                fontWeight: 600,
              }}
            />
          )}
        </TableCell>
        <TableCell sx={{ textAlign: "start", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {fmtDate(entry.imported_at)}
        </TableCell>
        {cells}
      </TableRow>
      {open && state?.kind === "ready" && (
        <TableRow>
          <TableCell colSpan={7} sx={{ bgcolor: "action.hover", paddingBlock: 1.5, paddingInline: 2 }}>
            <Typography
              variant="caption"
              component="p"
              sx={{
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "text.secondary",
                m: 0,
                marginBlockEnd: 1,
              }}
            >
              {name} — per chapter
            </Typography>
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small" sx={{ minWidth: 420 }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ textAlign: "start" }}>Chapter</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Verses</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Notes</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Word links</TableCell>
                    <TableCell sx={NUM_CELL_SX}>Questions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {realChapters(state.data).map((c) => (
                    <TableRow key={c.chapter}>
                      <TableCell sx={{ textAlign: "start", fontWeight: 600 }}>Chapter {c.chapter}</TableCell>
                      <TableCell sx={NUM_CELL_SX}>{c.verses}</TableCell>
                      <TableCell sx={NUM_CELL_SX}>{c.tn}</TableCell>
                      <TableCell sx={NUM_CELL_SX}>{c.twl}</TableCell>
                      <TableCell sx={NUM_CELL_SX}>{c.tq}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
