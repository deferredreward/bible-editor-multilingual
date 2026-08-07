// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// t1-home: queue dispatcher. Port of docs/flows/ui/t1-home.html — see that
// file for the design this mirrors (queue cards + recent activity + banners).
// Every number here comes from a real endpoint; where the mockup's own JS
// comments admit "no endpoint exists for this preview", this component
// renders the same honest-absent state rather than inventing a count.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { FlowNav } from "./FlowNav";
import { LockBanner, ReadyBanner } from "./FlowBanners";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  dismissAlert,
  fetchAlerts,
  type BookSummary,
  type ChapterPayload,
  type ContextExportStatus,
  type PipelineJobRow,
  type SystemAlert,
} from "../../sync/api";

export interface HomeScreenProps extends FlowScreenContext {}

const DEFAULT_BOOK = "OBA";
const DEFAULT_CHAPTER = 1;
const DEFAULT_VERSE = 1;

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const CONTEXT_PACK_LABELS: Record<string, string> = {
  success: "ready",
  never: "never generated",
  failed: "last run failed",
  shrink_refused: "refused (shrink guard)",
};

interface QueueCardProps {
  eyebrow: string;
  title: string;
  count: ReactNode;
  description: string;
  footer?: string | null;
  href: string;
  /** 0-100, or null/undefined to render an empty (zero-width) bar. */
  progress?: number | null;
  progressTone?: "ok" | "default";
}

function QueueCard({ eyebrow, title, count, description, footer, href, progress, progressTone }: QueueCardProps) {
  const theme = useTheme();
  const barColor = progressTone === "ok" ? theme.palette.flows.ok.main : theme.palette.primary.main;
  return (
    <Box
      component="a"
      href={href}
      sx={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
        p: 2,
        "&:hover": { borderColor: "primary.main" },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
        <Box
          aria-hidden="true"
          sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "primary.main", flex: "none" }}
        />
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}
        >
          {eyebrow}
        </Typography>
      </Stack>
      <Typography variant="h6" sx={{ fontSize: "1.05rem", mb: 0.5 }}>
        {title}
      </Typography>
      <Typography sx={{ fontSize: "0.9rem", fontWeight: 700, color: "primary.main", mb: 1 }}>{count}</Typography>
      <Box sx={{ height: 6, borderRadius: 3, bgcolor: theme.palette.flows.skip.soft, overflow: "hidden", mb: 1.5 }}>
        <Box sx={{ height: "100%", width: `${progress ?? 0}%`, bgcolor: barColor, borderRadius: 3 }} />
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, lineHeight: 1.45 }}>
        {description}
      </Typography>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {footer ?? ""}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 700, color: "primary.main" }}>
          Open →
        </Typography>
      </Stack>
    </Box>
  );
}

export default function HomeScreen({ role, me, onNavigate }: HomeScreenProps) {
  // Real last-visited location from GET /api/auth/me; falls back to the same
  // default the rest of the flow screens use when there's no signed-in user
  // or the field is unset. Never fabricated.
  const book = me?.lastBook || DEFAULT_BOOK;
  const chapter = me?.lastChapter || DEFAULT_CHAPTER;
  const verse = me?.lastVerse || DEFAULT_VERSE;

  const [queueStatus, setQueueStatus] = useState<"loading" | "ready" | "error">("loading");
  const [bookSummary, setBookSummary] = useState<BookSummary | null>(null);
  const [chapterData, setChapterData] = useState<ChapterPayload | null>(null);

  const [alerts, setAlerts] = useState<SystemAlert[]>([]);

  // Pipelines + context-pack status are gated `requireEditor` server-side —
  // a viewer gets a 403, which we treat as "not available for your role"
  // rather than an error.
  const [pipelineJobs, setPipelineJobs] = useState<PipelineJobRow[] | null>(null);
  const [pipelinesUnavailable, setPipelinesUnavailable] = useState(false);
  const [contextPack, setContextPack] = useState<ContextExportStatus | null>(null);
  const [contextPackUnavailable, setContextPackUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setQueueStatus("loading");
    Promise.all([api.getBookSummary(book), api.getChapter(book, chapter)])
      .then(([summary, chapterPayload]) => {
        if (cancelled) return;
        setBookSummary(summary);
        setChapterData(chapterPayload);
        setQueueStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setQueueStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [book, chapter]);

  useEffect(() => {
    let cancelled = false;
    void fetchAlerts().then((a) => {
      if (!cancelled) setAlerts(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (role === "viewer") {
      setPipelinesUnavailable(true);
      return;
    }
    let cancelled = false;
    api
      .pipelineList()
      .then((res) => {
        if (!cancelled) setPipelineJobs(res.jobs);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setPipelinesUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  useEffect(() => {
    if (role === "viewer") {
      setContextPackUnavailable(true);
      return;
    }
    let cancelled = false;
    api
      .getContextExportStatus()
      .then((res) => {
        if (!cancelled) setContextPack(res);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setContextPackUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  async function handleDismissAlert(id: number) {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await dismissAlert(id);
    } catch {
      /* best-effort — alert stays hidden locally even if the dismiss write fails */
    }
  }

  // The chapter this book/chapter pair currently locks under, if any real
  // pipeline job is running/dispatching against it. Never names an editor —
  // only what LockBanner already supports (pipeline type + start time).
  const lockingJob = useMemo(() => {
    if (!pipelineJobs) return null;
    return (
      pipelineJobs.find(
        (j) =>
          (j.state === "running" || j.state === "dispatching") &&
          j.book === book &&
          chapter >= j.start_chapter &&
          chapter <= j.end_chapter,
      ) ?? null
    );
  }, [pipelineJobs, book, chapter]);

  const readyJobs = useMemo(() => {
    if (!pipelineJobs) return [];
    return pipelineJobs.filter((j) => j.state === "done" && j.notified_user_at === null && j.book === book);
  }, [pipelineJobs, book]);

  const chapters = bookSummary?.chapters ?? [];
  const totalVerses = chapters.reduce((s, c) => s + (c.verses || 0), 0);
  const totalTn = chapters.reduce((s, c) => s + (c.tn || 0), 0);
  const totalTq = chapters.reduce((s, c) => s + (c.tq || 0), 0);
  const versesInChapter = chapters.find((c) => c.chapter === chapter)?.verses ?? 0;
  const doneInChapter = (chapterData?.verseStatuses ?? []).filter((s) => s.verse > 0 && s.done).length;
  const tnRows = chapterData?.tn ?? [];
  const tqRows = chapterData?.tq ?? [];
  const tnApproved = tnRows.filter((r) => r.translation_state === "validated").length;
  const tqApproved = tqRows.filter((r) => r.translation_state === "validated").length;

  const contextPackLabel = contextPackUnavailable
    ? "not available for your role"
    : contextPack
      ? CONTEXT_PACK_LABELS[contextPack.status] ?? contextPack.status
      : "unknown";

  return (
    <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
      <FlowNav current="home" book={book} chapter={chapter} verse={verse} role={role} />

      <Stack spacing={1} sx={{ mt: 2, mb: 1.75 }}>
        {alerts.map((a) => (
          <Alert key={a.id} severity={a.severity} onClose={() => handleDismissAlert(a.id)}>
            {a.message}
            {a.linkUrl && (
              <>
                {" "}
                <Box component="a" href={a.linkUrl} sx={{ color: "inherit", fontWeight: 700 }}>
                  View
                </Box>
              </>
            )}
          </Alert>
        ))}
        {lockingJob && (
          <LockBanner
            pipelineType={lockingJob.pipeline_type}
            startedAt={
              lockingJob.updated_at ? new Date(lockingJob.updated_at * 1000).toISOString() : null
            }
          />
        )}
        {readyJobs.length > 0 && (
          <ReadyBanner
            count={readyJobs.length}
            onReview={() => onNavigate(book, chapter, verse)}
          />
        )}
        {pipelinesUnavailable && (
          <Typography variant="caption" color="text.secondary">
            AI run status isn't visible for your role.
          </Typography>
        )}
      </Stack>

      <Stack
        direction="row"
        alignItems="center"
        flexWrap="wrap"
        spacing={1.25}
        sx={{ mb: 2 }}
      >
        <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
          <Typography variant="h5" sx={{ fontSize: "1.25rem", letterSpacing: "-0.01em" }}>
            {timeGreeting()}
            {me?.username ? `, ${me.username}` : ""}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {queueStatus === "loading" ? (
              <Skeleton variant="text" width={160} />
            ) : (
              `${bookSummary?.book ?? book} · ${me?.workspace ? `${me.workspace} workspace` : "workspace unknown"}`
            )}
          </Typography>
        </Box>
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "text.secondary",
            bgcolor: "action.hover",
            border: 1,
            borderColor: "divider",
            borderRadius: 999,
            px: 1.5,
            py: 0.625,
          }}
          title="Feeds AI drafting for this workspace"
        >
          <Box component="span" aria-hidden="true">
            🧠
          </Box>
          Context pack: {contextPackLabel}
        </Box>
      </Stack>

      <Box
        sx={{
          display: "grid",
          gap: 2.25,
          gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(260px, 320px)" },
          alignItems: "start",
        }}
      >
        <Box
          role="list"
          aria-label="Work queues"
          sx={{
            display: "grid",
            gap: 1.75,
            gridTemplateColumns: { xs: "1fr", tablet: "repeat(2, minmax(0, 1fr))" },
          }}
        >
          {queueStatus === "loading" ? (
            <>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} variant="rounded" height={190} />
              ))}
            </>
          ) : queueStatus === "error" ? (
            <Box sx={{ gridColumn: "1 / -1" }}>
              <Alert severity="error">
                Could not load {book} data.
              </Alert>
            </Box>
          ) : (
            <>
              <QueueCard
                eyebrow="Scripture text"
                title={bookSummary?.book ?? book}
                count={`${doneInChapter} of ${versesInChapter} verses done in chapter ${chapter}`}
                description="ULT → GLT (literal) and UST → GST (simplified), verse by verse."
                footer={`${chapters.length} chapters, ${totalVerses} verses total`}
                href={`#/scripture/${book}/${chapter}/${verse}`}
                progress={versesInChapter ? (doneInChapter / versesInChapter) * 100 : 0}
              />
              <QueueCard
                eyebrow="Notes & questions"
                title="Translation notes"
                count={`${tnApproved} of ${tnRows.length} approved in chapter ${chapter}`}
                description="AI-drafted translation notes, one card at a time."
                footer={`${totalTn} notes across ${chapters.length} chapters`}
                href={`#/review/${book}/${chapter}`}
                progress={tnRows.length ? (tnApproved / tnRows.length) * 100 : 0}
                progressTone="ok"
              />
              <QueueCard
                eyebrow="Notes & questions"
                title="Questions"
                count={`${tqApproved} of ${tqRows.length} approved in chapter ${chapter}`}
                description="AI-drafted translation questions, one card at a time."
                footer={`${totalTq} questions across ${chapters.length} chapters`}
                href={`#/review/${book}/${chapter}`}
                progress={tqRows.length ? (tqApproved / tqRows.length) * 100 : 0}
                progressTone="ok"
              />
              <QueueCard
                eyebrow="Word alignment"
                title="Alignment"
                count="Not available in this preview"
                description="Link target words to the Hebrew/Greek source, verse by verse."
                footer={null}
                href={`#/align/${book}/${chapter}/${verse}`}
                progress={0}
              />
              <QueueCard
                eyebrow="tW / tA articles"
                title="Articles"
                count="Not available in this preview"
                description="Key-term and translation-academy articles referenced from this book."
                footer={null}
                href="#/articles"
                progress={0}
              />
            </>
          )}
        </Box>

        <Box
          component="aside"
          aria-label="Recent activity"
          sx={{
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 1.5,
            boxShadow: 1,
            p: 1.75,
          }}
        >
          <Typography
            variant="caption"
            sx={{ display: "block", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary", mb: 1.25 }}
          >
            Recent activity
          </Typography>
          {/* No activity/audit-log endpoint exists yet (see docs/flows/00b-api-inventory.md) —
              honest empty state rather than fabricated entries. */}
          <Typography variant="body2" color="text.secondary">
            No activity feed yet — this workspace has no audit-log endpoint to read from.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
