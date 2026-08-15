// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// a2-import's two queue panels: the shared pending-imports review queue and the
// recent import/pipeline activity list. Both read real endpoints:
//   GET /api/pending-imports?book=&chapter=   (api.getPendingImports)
//   GET /api/pipelines                        (api.pipelineList)
//
// Honest scope note carried over from the mockup: /api/pending-imports is
// scoped to ONE book + chapter. There is no whole-project aggregate endpoint,
// so this panel asks for a chapter rather than pretending to show everything.

import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import {
  api,
  ApiError,
  type PendingImport,
  type PipelineJobRow,
} from "../../sync/api";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { Panel, PanelBody, PanelFoot, PanelTop, ListRow } from "./BooksPanel";

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return body?.message ?? body?.error ?? `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function BooksPendingPanel({ book }: { book: string }) {
  const [chapter, setChapter] = useState(1);
  const [items, setItems] = useState<PendingImport[] | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    setError(null);
    try {
      const res = await api.getPendingImports(book, chapter, signal);
      if (signal?.aborted) return;
      setItems(res.items);
      setStatus("loaded");
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setItems(null);
      setError(errorText(e));
      setStatus("error");
    }
  }, [book, chapter]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void load(controller.signal);
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <Panel>
      <PanelTop
        title="Pending imports"
        sub="Shared review queue of AI-pipeline proposals not yet resolved by any translator. The endpoint is scoped to one book and chapter — there is no whole-project aggregate — so this shows the selected book at the chapter below."
      />
      <PanelBody>
        <Stack direction="row" alignItems="flex-end" spacing={1.5} sx={{ mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Book: {book}
          </Typography>
          <TextField
            size="small"
            type="number"
            label="Chapter"
            value={chapter}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setChapter(n);
            }}
            sx={{ width: 110 }}
            inputProps={{ min: 0 }}
          />
        </Stack>

        {status === "loading" ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">Loading…</Typography>
          </Stack>
        ) : status === "error" ? (
          <Alert severity="error">Failed to load pending imports: {error}</Alert>
        ) : !items || items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing pending for this book and chapter.
          </Typography>
        ) : (
          items.map((p) => (
            <ListRow key={p.id}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
                  <Typography component="strong" sx={{ fontWeight: 700, fontSize: "0.875rem" }}>
                    {p.book} {p.chapter}
                  </Typography>
                  <FlowStatusChip kind="draft" label={p.kind} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  verse {p.verse} — proposed by {p.startedByUsername ?? "unknown"} ({p.pipelineType})
                </Typography>
              </Box>
            </ListRow>
          ))
        )}
      </PanelBody>
      <PanelFoot
        state={
          status === "loaded"
            ? `${items?.length ?? 0} pending for ${book} ${chapter}`
            : status === "error"
              ? "Load failed"
              : "Loading…"
        }
      >
        <Button size="small" sx={{ minHeight: 36 }} onClick={() => void load()}>
          Refresh
        </Button>
      </PanelFoot>
    </Panel>
  );
}

const JOB_CHIP: Record<string, FlowStatusKind> = {
  running: "edited",
  dispatching: "edited",
  done: "approved",
  failed: "warn",
};

export function BooksActivityPanel({ book }: { book: string }) {
  const [jobs, setJobs] = useState<PipelineJobRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error" | "forbidden">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await api.pipelineList();
      setJobs(res.jobs);
      setStatus("loaded");
    } catch (e) {
      setJobs(null);
      if (e instanceof ApiError && e.status === 403) {
        setStatus("forbidden");
        return;
      }
      setError(errorText(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const forBook = (jobs ?? []).filter((j) => j.book === book);
  const others = (jobs?.length ?? 0) - forBook.length;

  return (
    <Panel>
      <PanelTop
        title="Recent import activity"
        sub={`Shared pipeline job queue (the same data as the Observe screen), filtered to jobs for ${book}.`}
      />
      <PanelBody>
        {status === "loading" ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">Loading…</Typography>
          </Stack>
        ) : status === "forbidden" ? (
          <Typography variant="body2" color="text.secondary">
            Pipeline job status isn't visible for your role.
          </Typography>
        ) : status === "error" ? (
          <Alert severity="error">Failed to load pipeline jobs: {error}</Alert>
        ) : forBook.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No pipeline jobs for {book}
            {others > 0 ? ` (${others} job(s) for other books).` : " — the queue is empty."}
          </Typography>
        ) : (
          forBook.map((j) => (
            <ListRow key={j.job_id}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
                  <Typography component="strong" sx={{ fontWeight: 700, fontSize: "0.875rem" }}>
                    {j.book} {j.start_chapter === j.end_chapter ? j.start_chapter : `${j.start_chapter}–${j.end_chapter}`}
                  </Typography>
                  <FlowStatusChip kind={JOB_CHIP[j.state] ?? "draft"} label={j.state} />
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {j.pipeline_type}
                  {j.started_by_username ? ` — ${j.started_by_username}` : ""}
                  {j.current_status ? ` — ${j.current_status}` : ""}
                </Typography>
                {j.state === "failed" && (j.error_message || j.error_kind) && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {j.error_kind ?? "error"}: {j.error_message ?? "no message returned"}
                  </Typography>
                )}
              </Box>
            </ListRow>
          ))
        )}
      </PanelBody>
      <PanelFoot
        state={
          status === "loaded"
            ? `${forBook.length} job(s) for ${book}${others > 0 ? `, ${others} elsewhere` : ""}`
            : status === "forbidden"
              ? "Not available for your role"
              : status === "error"
                ? "Load failed"
                : "Loading…"
        }
      >
        <Button size="small" sx={{ minHeight: 36 }} onClick={() => void load()}>
          Refresh status
        </Button>
      </PanelFoot>
    </Panel>
  );
}
