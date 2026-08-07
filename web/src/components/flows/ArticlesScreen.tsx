// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t5-articles: tW / tA article translation, ported from
// docs/flows/ui/t5-articles.html. Reuses the same data + save machinery as
// components/ArticleWorkspace.tsx (useArticles, api.getArticle/patchArticle/
// validateArticle/addArticle/populateArticles, drafts.ts's article draft kind)
// but follows the mockup's own layout: a segmented tW/tA switch above a
// rail+editor split that stacks into a list/editor toggle below `md` (the
// mockup's own breakpoint, 819.98px, sits between this project's tablet/md
// bands — `md` (900) is the closer, and only, of the two named in
// docs/flows/06-react-port-plan.md).
//
// Explicit-Save-only: keystrokes go to the IndexedDB drafts store on every
// change (web/src/sync/drafts.ts, articleKey), restored on mount, cleared once
// the server confirms. Nothing reaches the network until Save is clicked.
//
// History: the mockup's History button/dialog documents a real gap — no
// history endpoint exists for tW/tA articles (unlike note templates) — so it
// stays disabled-with-explanation here rather than faked.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import VisibilityIcon from "@mui/icons-material/Visibility";
import EditIcon from "@mui/icons-material/Edit";
import HistoryIcon from "@mui/icons-material/History";
import { FlowNav } from "./FlowNav";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useArticles } from "../../hooks/useArticles";
import { api, ApiError, type ArticleUnit, type ArticleUnitMeta } from "../../sync/api";
import { drafts as draftStore, articleKey, type DraftRecord } from "../../sync/drafts";
import { pipelineStore, getSessionKey } from "../../sync/pipelineStore";
import { MarkdownView } from "../MarkdownView";

type Resource = "tw" | "ta";
type ArticleState = "ai_draft" | "edited" | "validated" | null;

// Mirrors ArticleWorkspace's aggregateState: any ai_draft wins, else any
// edited, else all-translated-parts-validated, else none.
function aggregateState(states: ArticleState[]): ArticleState {
  if (states.some((s) => s === "ai_draft")) return "ai_draft";
  if (states.some((s) => s === "edited")) return "edited";
  const translated = states.filter((s) => s != null);
  if (translated.length > 0 && translated.every((s) => s === "validated")) return "validated";
  return null;
}

function stateChipKind(state: ArticleState): FlowStatusKind {
  if (state === "validated") return "approved";
  if (state === "ai_draft" || state === "edited") return "edited";
  return "draft";
}

// tA articles order title -> sub-title -> body; tw is body-only.
const PART_ORDER: Record<string, number> = { title: 0, "sub-title": 1, body: 2 };
function orderParts(list: ArticleUnit[]): ArticleUnit[] {
  return [...list].sort((a, b) => (PART_ORDER[a.part] ?? 9) - (PART_ORDER[b.part] ?? 9));
}

export interface ArticlesScreenProps extends FlowScreenContext {}

export default function ArticlesScreen({ role }: ArticlesScreenProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md")); // >=900: rail + editor side by side

  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);

  const [resource, setResource] = useState<Resource>("ta");
  const { units, loading, refetch } = useArticles(isTranslation ? resource : null);

  const articles = useMemo(() => {
    const map = new Map<string, ArticleUnitMeta[]>();
    for (const u of units) {
      const arr = map.get(u.article_id);
      if (arr) arr.push(u);
      else map.set(u.article_id, [u]);
    }
    return Array.from(map.entries()).map(([id, parts]) => ({
      id,
      parts,
      state: aggregateState(parts.map((p) => p.translation_state)),
    }));
  }, [units]);

  const total = articles.length;
  const validatedCount = articles.filter((a) => a.state === "validated").length;

  const [search, setSearch] = useState("");
  const [addId, setAddId] = useState("");
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  const [articleId, setArticleId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "editor">("list");
  const [historyOpen, setHistoryOpen] = useState(false);

  const query = search.trim();
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return q ? articles.filter((a) => a.id.toLowerCase().includes(q)) : articles;
  }, [articles, query]);

  const selectedPaths = useMemo(
    () => (articleId ? units.filter((u) => u.article_id === articleId).map((u) => u.path) : []),
    [units, articleId],
  );

  // Dirty markers for the rail — which articles hold unsaved typing.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => draftStore.subscribe(setDraftList), []);
  const dirtyArticleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "article" || d.meta.resource !== resource) continue;
      ids.add(d.meta.articleId);
    }
    return ids;
  }, [draftList, resource]);

  function selectArticle(id: string) {
    setArticleId(id);
    setMobileView("editor");
  }

  function switchResource(r: Resource) {
    setResource(r);
    setArticleId(null);
    setMobileView("list");
  }

  const handleAdd = useCallback(async () => {
    if (!addId.trim() || busy) return;
    const id = addId.trim();
    setBusy(true);
    setSnack(null);
    try {
      const res = await api.addArticle(resource, id);
      refetch();
      setAddId("");
      setArticleId(res.article_id);
      setMobileView("editor");
      setSnack(`Added ${res.article_id}`);
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
      setSnack(
        code === "source_not_found"
          ? `No source found for id "${id}"`
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }, [addId, busy, resource, refetch]);

  const handlePopulate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setSnack(null);
    try {
      let warnings = 0;
      let aborted = false;
      let guard = 0;
      for (;;) {
        const res = await api.populateArticles();
        warnings += res.warnings?.length ?? 0;
        if (res.aborted) aborted = true;
        if (res.skipped || res.aborted || res.remaining === 0 || ++guard > 200) break;
      }
      refetch();
      setSnack(
        aborted
          ? "Populate stopped — source changed mid-run. Try again."
          : warnings > 0
            ? `Populate: ${warnings} warning(s)`
            : "Populate: done",
      );
    } catch (e) {
      setSnack(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refetch]);

  if (!isTranslation) {
    return (
      <Box>
        <FlowNav current="articles" role={role} />
        <Stack alignItems="center" justifyContent="center" sx={{ height: "60vh", px: 4 }} spacing={1}>
          <Typography variant="h6">Articles — tW / tA</Typography>
          <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 420 }}>
            Article translation only applies to gateway-language projects.
          </Typography>
        </Stack>
      </Box>
    );
  }

  const showRail = isDesktop || mobileView === "list";
  const showEditor = isDesktop || mobileView === "editor";

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <FlowNav current="articles" role={role} />

      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: 2, pt: 1.5, pb: 1, flexWrap: "wrap", rowGap: 1 }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={resource}
          onChange={(_e, v) => {
            if (v && v !== resource) switchResource(v as Resource);
          }}
        >
          <ToggleButton value="tw" sx={{ textTransform: "none", fontWeight: 700 }}>
            translationWords
          </ToggleButton>
          <ToggleButton value="ta" sx={{ textTransform: "none", fontWeight: 700 }}>
            translationAcademy
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary">
          Two focused views, not a shared tab bar — tW and tA never share one content region.
        </Typography>
      </Stack>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* ── Rail ── */}
        {showRail && (
          <Box
            sx={{
              width: isDesktop ? 280 : "100%",
              flexShrink: 0,
              borderInlineEnd: isDesktop ? "1px solid" : "none",
              borderColor: "divider",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <Stack spacing={1} sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
              <TextField
                size="small"
                fullWidth
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search articles…"
                inputProps={{ "aria-label": "Search articles", style: { fontSize: 13.5 } }}
              />
              <Typography variant="caption" color="text.secondary">
                {total ? `${validatedCount} of ${total} approved` : `No ${resource} articles imported in this environment`}
              </Typography>
              <Button
                size="small"
                variant="text"
                disabled={busy}
                onClick={handlePopulate}
                sx={{
                  justifyContent: "flex-start",
                  textTransform: "none",
                  border: "1px dashed",
                  borderColor: "divider",
                  color: "text.secondary",
                }}
                startIcon={busy ? <CircularProgress size={14} /> : undefined}
              >
                Populate from books
              </Button>
              <Stack direction="row" spacing={0.75}>
                <TextField
                  size="small"
                  fullWidth
                  value={addId}
                  onChange={(e) => setAddId(e.target.value)}
                  placeholder="Add by id…"
                  inputProps={{ "aria-label": "Add article by id", style: { fontSize: 12.5 } }}
                />
                <Button size="small" variant="outlined" disabled={busy || !addId.trim()} onClick={handleAdd}>
                  Add
                </Button>
              </Stack>
            </Stack>

            <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }} role="list" aria-label="Articles">
              {loading && articles.length === 0 ? (
                <Stack alignItems="center" sx={{ p: 3 }}>
                  <CircularProgress size={20} />
                </Stack>
              ) : filtered.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  {total ? "No articles match your search." : `No ${resource} articles imported in this environment.`}
                </Typography>
              ) : (
                filtered.map((a) => {
                  const selected = a.id === articleId;
                  const unsaved = dirtyArticleIds.has(a.id);
                  return (
                    <Box
                      key={a.id}
                      component="button"
                      type="button"
                      onClick={() => selectArticle(a.id)}
                      aria-current={selected ? "true" : undefined}
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        width: "100%",
                        textAlign: "start",
                        border: "none",
                        font: "inherit",
                        color: "inherit",
                        cursor: "pointer",
                        px: 1.5,
                        py: 0.75,
                        bgcolor: selected ? (t) => alpha(t.palette.primary.main, 0.08) : "transparent",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: "monospace" }} noWrap>
                          {a.id}
                        </Typography>
                      </Box>
                      {unsaved && (
                        <Tooltip title="Unsaved draft">
                          <Box
                            aria-label="Unsaved draft"
                            sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "#E59D33", flexShrink: 0 }}
                          />
                        </Tooltip>
                      )}
                      <FlowStatusChip kind={stateChipKind(a.state)} />
                    </Box>
                  );
                })
              )}
            </Box>
          </Box>
        )}

        {/* ── Editor ── */}
        {showEditor && (
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1180, mx: "auto" }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5, flexWrap: "wrap" }}>
                {!isDesktop && (
                  <IconButton size="small" onClick={() => setMobileView("list")} aria-label="Back to articles">
                    <ArrowBackIcon fontSize="small" />
                  </IconButton>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title="No history endpoint exists for tW/tA articles today (unlike note templates) — this is a real gap, not an omission.">
                  <span>
                    <Button
                      size="small"
                      startIcon={<HistoryIcon fontSize="small" />}
                      onClick={() => setHistoryOpen(true)}
                    >
                      History
                    </Button>
                  </span>
                </Tooltip>
              </Stack>

              {!articleId ? (
                <Stack alignItems="center" justifyContent="center" sx={{ height: "50vh" }}>
                  <Typography variant="body2" color="text.secondary">
                    Select an article to translate.
                  </Typography>
                </Stack>
              ) : (
                <ArticleEditorPanel
                  key={`${resource}/${articleId}`}
                  resource={resource}
                  articleId={articleId}
                  paths={selectedPaths}
                  direction={cfg?.direction ?? "ltr"}
                  languageTitle={cfg?.languageTitle ?? ""}
                  onServerChange={refetch}
                />
              )}
            </Box>
          </Box>
        )}
      </Box>

      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Article history</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            No history endpoint exists for tW/tA articles today (unlike note templates) — this is a real
            gap, not a mockup omission.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack !== null}
        autoHideDuration={6000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" onClose={() => setSnack(null)}>
          {snack}
        </Alert>
      </Snackbar>
    </Box>
  );
}

interface EditorProps {
  resource: Resource;
  articleId: string;
  paths: string[];
  direction: "ltr" | "rtl";
  languageTitle: string;
  onServerChange: () => void;
}

// Split-screen part editor — mirrors ArticleWorkspace's ArticleEditor: source
// (English, read-only) alongside an editable target draft per part, wired to
// the same drafts store and PATCH/validate/translate machinery.
function ArticleEditorPanel({ resource, articleId, paths, direction, languageTitle, onServerChange }: EditorProps) {
  const pathsKey = useMemo(() => [...paths].sort().join("|"), [paths]);

  const [parts, setParts] = useState<ArticleUnit[] | null>(null);
  const [loadingParts, setLoadingParts] = useState(false);
  const [draftsByPath, setDraftsByPath] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!articleId || paths.length === 0) {
      setParts(null);
      return;
    }
    let cancelled = false;
    setLoadingParts(true);
    setStaleDraft(false);
    Promise.all(paths.map((p) => api.getArticle(resource, p)))
      .then(async (list) => {
        if (cancelled) return;
        const ordered = orderParts(list);
        const seeded = Object.fromEntries(ordered.map((u) => [u.path, u.target_md ?? ""]));
        let stale = false;
        const stored = await Promise.all(
          ordered.map((u) =>
            draftStore
              .get(articleKey(resource, u.path))
              .then((rec) => ({ unit: u, rec }))
              .catch(() => ({ unit: u, rec: undefined })),
          ),
        );
        if (cancelled) return;
        for (const { unit, rec } of stored) {
          const text = (rec?.payload as { target_md?: string } | undefined)?.target_md;
          if (typeof text !== "string") continue;
          if (text === (unit.target_md ?? "")) {
            void draftStore.clear(articleKey(resource, unit.path));
            continue;
          }
          if (rec && rec.expectedVersion !== unit.version) stale = true;
          seeded[unit.path] = text;
        }
        setParts(ordered);
        setDraftsByPath(seeded);
        setPreviews({});
        setLoadingParts(false);
        if (stale) setStaleDraft(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setLoadingParts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, articleId, pathsKey, reloadKey]);

  useEffect(
    () =>
      pipelineStore.onComplete((job) => {
        if (job.pipeline_type !== "translate") return;
        setTranslating(false);
        if (job.state === "done") {
          bumpReload();
          onServerChange();
        }
      }),
    [bumpReload, onServerChange],
  );

  const applyServerUnit = useCallback(
    (u: ArticleUnit) => {
      setParts((prev) => (prev ? prev.map((p) => (p.path === u.path ? u : p)) : prev));
      setDraftsByPath((prev) => ({ ...prev, [u.path]: u.target_md ?? "" }));
      const key = articleKey(resource, u.path);
      void draftStore.get(key).then((rec) => {
        const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
        if (stored === undefined || stored === (u.target_md ?? "")) void draftStore.clear(key);
      });
    },
    [resource],
  );

  const persistDraft = useCallback(
    (part: ArticleUnit, text: string) => {
      const key = articleKey(resource, part.path);
      if (text === (part.target_md ?? "")) {
        void draftStore.clear(key);
        return;
      }
      void draftStore.set(key, { target_md: text }, part.version, {
        kind: "article",
        resource,
        articleId: part.article_id,
        path: part.path,
        part: part.part,
      });
    },
    [resource],
  );

  const isDirtyPart = useCallback(
    (part: ArticleUnit) => (draftsByPath[part.path] ?? "") !== (part.target_md ?? ""),
    [draftsByPath],
  );
  const anyDirty = useMemo(() => (parts ?? []).some(isDirtyPart), [parts, isDirtyPart]);

  const aggregate = useMemo(
    () => aggregateState((parts ?? []).map((p) => p.translation_state ?? null)),
    [parts],
  );
  const isValidated = aggregate === "validated";
  const isDraftState = aggregate === "ai_draft" || aggregate === "edited";
  const isUntranslated = useMemo(
    () => (parts ?? []).every((p) => !(p.target_md && p.target_md.trim()) && !p.translation_state),
    [parts],
  );

  const handleSave = useCallback(async () => {
    if (!parts || !anyDirty) return;
    const dirty = parts.filter(isDirtyPart);
    setSaving(true);
    const results = await Promise.allSettled(
      dirty.map((part) => api.patchArticle(resource, part.path, part.version, draftsByPath[part.path] ?? "")),
    );
    let conflicted = false;
    let otherErr: string | null = null;
    for (const r of results) {
      if (r.status === "fulfilled") applyServerUnit(r.value);
      else if (r.reason instanceof ApiError && r.reason.status === 409) conflicted = true;
      else otherErr = r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
    if (conflicted) setConflict(true);
    if (otherErr) setErrorMsg(otherErr);
    setSaving(false);
    onServerChange();
  }, [parts, anyDirty, isDirtyPart, resource, draftsByPath, applyServerUnit, onServerChange]);

  const handleValidate = useCallback(
    async (value: boolean) => {
      if (!parts) return;
      const targets = parts.filter((p) => p.translation_state != null);
      if (targets.length === 0) return;
      const results = await Promise.allSettled(
        targets.map((part) => api.validateArticle(resource, part.path, value)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") applyServerUnit(r.value);
        else setErrorMsg(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
      onServerChange();
    },
    [parts, resource, applyServerUnit, onServerChange],
  );

  const handleTranslate = useCallback(async () => {
    setTranslating(true);
    try {
      await pipelineStore.start({
        pipelineType: "translate",
        sessionKey: getSessionKey(),
        translate: { resourceType: resource, articleId },
      });
    } catch (e) {
      setTranslating(false);
      const body = (e as { body?: { error?: string } } | null)?.body;
      setErrorMsg(body?.error ?? (e instanceof Error ? e.message : String(e)));
    }
  }, [resource, articleId]);

  const partLabel = useCallback(
    (part: ArticleUnit): string => {
      if (part.part === "title") return "title";
      if (part.part === "sub-title") return "subtitle";
      return languageTitle || "body";
    },
    [languageTitle],
  );

  const unsavedCount = (parts ?? []).filter(isDirtyPart).length;

  if (loadingParts && !parts) {
    return (
      <Stack alignItems="center" sx={{ p: 4 }}>
        <CircularProgress size={24} />
      </Stack>
    );
  }
  if (!parts || parts.length === 0) {
    return (
      <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 3, textAlign: "center" }}>
        <Typography variant="body2" color="text.secondary">
          No parts found for this article.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ p: 2, borderBottom: "1px solid", borderColor: "divider", flexWrap: "wrap" }}
      >
        <Typography variant="h6" sx={{ fontFamily: "monospace", fontSize: 17 }}>
          {articleId}
        </Typography>
        <FlowStatusChip kind={stateChipKind(aggregate)} />
        {unsavedCount > 0 && (
          <FlowStatusChip kind="warn" label={`${unsavedCount} unsaved`} />
        )}
      </Stack>

      <Box sx={{ p: 2 }}>
        <Stack spacing={2.5}>
          {parts.map((part) => {
            const draft = draftsByPath[part.path] ?? "";
            const preview = previews[part.path] ?? false;
            const dirty = isDirtyPart(part);
            return (
              <Box
                key={part.path}
                sx={{
                  border: dirty ? "1.5px solid" : "1px solid",
                  borderColor: dirty ? "warning.light" : "divider",
                  borderRadius: 1,
                  p: 1.5,
                }}
              >
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      flex: 1,
                      fontWeight: 700,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "text.secondary",
                      fontSize: 11,
                    }}
                  >
                    {partLabel(part)}
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={
                      preview ? <EditIcon sx={{ fontSize: "16px !important" }} /> : <VisibilityIcon sx={{ fontSize: "16px !important" }} />
                    }
                    onClick={() => setPreviews((prev) => ({ ...prev, [part.path]: !preview }))}
                    sx={{ py: 0, color: "text.secondary" }}
                  >
                    {preview ? "Edit" : "Preview"}
                  </Button>
                </Stack>

                {part.source_md && (
                  <Box
                    sx={{
                      fontSize: 12.5,
                      color: "text.secondary",
                      bgcolor: "action.hover",
                      border: "1px dashed",
                      borderColor: "divider",
                      borderRadius: 1,
                      p: 1.25,
                      mb: 1.25,
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{ display: "block", fontWeight: 700, textTransform: "uppercase", fontSize: 10.5, mb: 0.5 }}
                    >
                      Source (English, read-only)
                    </Typography>
                    <MarkdownView markdown={part.source_md} dir="ltr" />
                  </Box>
                )}

                {preview ? (
                  <MarkdownView markdown={draft} dir={direction} />
                ) : (
                  <TextField
                    value={draft}
                    onChange={(e) => {
                      setDraftsByPath((prev) => ({ ...prev, [part.path]: e.target.value }));
                      persistDraft(part, e.target.value);
                    }}
                    fullWidth
                    multiline
                    minRows={part.part === "body" ? 6 : 1}
                    spellCheck
                    variant="outlined"
                    aria-label={`${part.part} draft (target language)`}
                    inputProps={{
                      dir: direction,
                      style: {
                        fontSize: 15,
                        lineHeight: 1.6,
                        ...(direction === "rtl" ? { textAlign: "right" as const } : {}),
                      },
                    }}
                  />
                )}
              </Box>
            );
          })}
        </Stack>
      </Box>

      <Stack
        direction="row"
        spacing={1}
        sx={{ p: 2, borderTop: "1px solid", borderColor: "divider", bgcolor: "action.hover", flexWrap: "wrap" }}
      >
        {(isUntranslated || isDraftState) && (
          <Button
            size="small"
            variant="outlined"
            disabled={translating}
            startIcon={
              translating ? <CircularProgress size={14} /> : <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />
            }
            onClick={handleTranslate}
          >
            {translating ? "Translating…" : isUntranslated ? "Translate" : "Re-run AI"}
          </Button>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          variant="outlined"
          startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon sx={{ fontSize: "18px !important" }} />}
          disabled={!anyDirty || saving}
          onClick={handleSave}
        >
          Save
        </Button>
        {isDraftState && (
          <Button
            size="small"
            variant="contained"
            color="success"
            startIcon={<CheckIcon sx={{ fontSize: "18px !important" }} />}
            disabled={anyDirty}
            onClick={() => handleValidate(true)}
          >
            Approve
          </Button>
        )}
        {isValidated && (
          <Button size="small" variant="text" color="warning" disabled={anyDirty} onClick={() => handleValidate(false)}>
            Unapprove
          </Button>
        )}
      </Stack>

      <Snackbar
        open={staleDraft}
        onClose={() => setStaleDraft(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setStaleDraft(false)}>
          Your unsaved draft here predates a newer server version — saving now would overwrite it.
        </Alert>
      </Snackbar>
      <Snackbar
        open={conflict}
        autoHideDuration={6000}
        onClose={() => setConflict(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setConflict(false)}>
          Someone else saved a part of this article first — reload to see the latest.
        </Alert>
      </Snackbar>
      <Snackbar
        open={errorMsg !== null}
        autoHideDuration={6000}
        onClose={() => setErrorMsg(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
