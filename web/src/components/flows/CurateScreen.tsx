// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// l3-templates: curate note templates, ported from
// docs/flows/ui/l3-templates.html onto the app's real template data + save
// machinery (194 real units per docs/flows/05-functional-preview-findings.md
// §3.4). This screen re-skins TemplateWorkspace.tsx's data path (useTemplates,
// useTemplateAiDraft, useTemplateBulkDraft, the drafts store,
// TemplateHistoryDialog) with FlowNav chrome and the mockup's band-responsive
// layout — rail+editor side by side at >=900px, card-at-a-time with a Back
// arrow below it — rather than reimplementing save/draft/approve.
//
// Two deliberate departures from TemplateWorkspace, both from the findings
// doc:
// - Approve is always rendered, disabled with a real explanation when
//   translation_state is NULL (§2.14 — the server 404s /validate on a
//   null-state row, which is every untouched unit in a fresh seed).
// - The mockup's "no client-side role gate" note is carried over as-is: grep
//   found no admin/editor check on this route, so this screen doesn't invent
//   one either.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SearchIcon from "@mui/icons-material/Search";

import { FlowNav } from "./FlowNav";
import { FlowStatusChip } from "./FlowStatusChip";
import { CurateEditor, curateStateChipKind, curateStateLabel } from "./CurateEditor";
import type { FlowScreenContext } from "./types";

import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useTemplates } from "../../hooks/useTemplates";
import { useTemplateBulkDraft } from "../../hooks/useTemplateBulkDraft";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { drafts as draftStore, type DraftRecord } from "../../sync/drafts";
import type { TemplateUnitMeta } from "../../sync/api";

export interface CurateScreenProps extends FlowScreenContext {
  templateId: string | null;
}

type MobileView = "rail" | "editor";

export default function CurateScreen({ role, templateId }: CurateScreenProps) {
  const theme = useTheme();
  // System band only (web/src/lib/layoutBands.ts: desktop=900) — the mockup's
  // rail+editor split collapses to card-at-a-time below it.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));

  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);
  const { units, loading, error, refetch } = useTemplates(isTranslation);

  const [search, setSearch] = useState("");
  const [mobileView, setMobileView] = useState<MobileView>(templateId ? "editor" : "rail");
  // Once a real 503 has been seen (single-unit or bulk draft), stop offering
  // AI drafting anywhere on this screen rather than re-asking the server per
  // unit — mirrors the mockup's one shared aiDisabled flag.
  const [aiDisabled, setAiDisabled] = useState(false);

  const selectTemplate = useCallback((id: string) => {
    location.hash = `#/curate/${encodeURIComponent(id)}`;
    setMobileView("editor");
  }, []);
  const backToRail = useCallback(() => setMobileView("rail"), []);

  const total = units.length;
  const validatedCount = units.filter((u) => u.translation_state === "validated").length;
  const approvedTally = `${validatedCount} of ${total}`;

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q
      ? units.filter(
          (u) =>
            u.template_id.toLowerCase().includes(q) ||
            u.support_ref.toLowerCase().includes(q) ||
            (u.type ?? "").toLowerCase().includes(q),
        )
      : units;
    const map = new Map<string, TemplateUnitMeta[]>();
    for (const u of matches) {
      const arr = map.get(u.support_ref);
      if (arr) arr.push(u);
      else map.set(u.support_ref, [u]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [units, search]);

  // Unsaved-typing tracking, mirrored from TemplateWorkspace.tsx so the rail's
  // unsaved dot and the reload guard both come from the one real signal.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => draftStore.subscribe(setDraftList), []);
  const dirtyIds = useMemo(() => {
    const s = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "template") continue;
      s.add(d.meta.templateId);
    }
    return s;
  }, [draftList]);
  useUnsavedGuard(dirtyIds.size > 0);

  const {
    running: bulkRunning,
    progress: bulkProgress,
    result: bulkResult,
    clearResult: clearBulkResult,
    cancel: cancelBulk,
    draftAll,
  } = useTemplateBulkDraft();
  // Deliberately narrow, same as TemplateWorkspace's "Draft all": an approved
  // unit is never touched (the server 409s anyway), a unit that already has a
  // target is left for its own per-unit button, and a unit with unsaved
  // typing is skipped so the run can't clobber it. No bulk endpoint exists
  // server-side (api/src/templates.ts only has POST .../unit/draft?id=<one>)
  // — this composes real per-unit calls in sequence, not a fabricated batch.
  const draftableUnits = useMemo(
    () =>
      units.filter(
        (u) => u.has_target === 0 && u.translation_state !== "validated" && !dirtyIds.has(u.template_id),
      ),
    [units, dirtyIds],
  );
  const handleDraftAll = useCallback(async () => {
    if (bulkRunning || draftableUnits.length === 0 || aiDisabled) return;
    const result = await draftAll(draftableUnits);
    if (result.reason === "disabled") setAiDisabled(true);
    refetch();
  }, [bulkRunning, draftableUnits, draftAll, refetch, aiDisabled]);
  const bulkMessage = useMemo(() => {
    if (!bulkResult) return null;
    const { drafted, failed, reason, lastErrorCode } = bulkResult;
    if (reason === "disabled") return "AI not configured for this workspace.";
    if (reason === "aborted_failures")
      return `Stopped after ${drafted} drafted — repeated failures (${lastErrorCode ?? "unknown"}).`;
    if (reason === "cancelled") return `Cancelled after ${drafted} drafted.`;
    return failed > 0 ? `${drafted} drafted, ${failed} failed.` : `${drafted} drafted.`;
  }, [bulkResult]);

  if (!isTranslation) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="curate" role={role} />
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, px: 4 }} spacing={1}>
          <Typography variant="h6">Curate note templates</Typography>
          <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 420 }}>
            Note templates are only editable on gateway-language projects.
          </Typography>
        </Stack>
      </Stack>
    );
  }

  const showRail = isDesktop || mobileView === "rail";
  const showEditor = isDesktop || mobileView === "editor";

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <FlowNav current="curate" role={role} />

      {/* Mirrored from the mockup, not invented for this screen: grep found no
          admin/editor gate on this route (TemplateWorkspace.tsx). */}
      <Alert severity="info" icon={false} sx={{ mx: 2, mt: 1.5, fontSize: 12, py: 0.25 }}>
        This route has no client-side role gate today — any signed-in user who can reach #/curate can edit here.
      </Alert>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden", mt: 1.5, gap: 2, px: { xs: 0, md: 2 } }}>
        {showRail && (
          <Box
            sx={{
              width: isDesktop ? 280 : "100%",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              border: { xs: "none", md: "1px solid" },
              borderColor: "divider",
              borderRadius: { md: 1 },
              overflow: "hidden",
            }}
          >
            <Box sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
              <TextField
                size="small"
                fullWidth
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates…"
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
              />
            </Box>

            <Box sx={{ px: 1.5, py: 1.25, borderBottom: "1px solid", borderColor: "divider" }}>
              {bulkRunning ? (
                <Stack direction="row" alignItems="center" spacing={1}>
                  <CircularProgress size={14} />
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                    {bulkProgress?.done ?? 0} / {bulkProgress?.total ?? 0} drafted
                  </Typography>
                  <Button size="small" onClick={cancelBulk} sx={{ minHeight: 44 }}>
                    Cancel
                  </Button>
                </Stack>
              ) : (
                <Tooltip title={aiDisabled ? "AI not configured for this workspace — an admin needs to set BT_API_TOKEN." : ""}>
                  <span>
                    <Button
                      fullWidth
                      size="small"
                      variant="outlined"
                      startIcon={<AutoAwesomeIcon fontSize="small" />}
                      disabled={aiDisabled || draftableUnits.length === 0}
                      onClick={handleDraftAll}
                      sx={{ minHeight: 44 }}
                    >
                      Draft all with AI ({draftableUnits.length})
                    </Button>
                  </span>
                </Tooltip>
              )}
              {bulkMessage && (
                <Alert
                  severity={bulkResult?.reason === "completed" ? "success" : "warning"}
                  onClose={clearBulkResult}
                  sx={{ mt: 1, py: 0, fontSize: 11, "& .MuiAlert-message": { py: 0.5 } }}
                >
                  {bulkMessage}
                </Alert>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                {approvedTally} approved
              </Typography>
            </Box>

            <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }} role="list" aria-label="Template list">
              {loading && units.length === 0 ? (
                <Stack alignItems="center" sx={{ p: 3 }}>
                  <CircularProgress size={20} />
                </Stack>
              ) : error ? (
                <Box sx={{ p: 2 }}>
                  <Typography variant="body2" color="error">
                    Couldn&rsquo;t load templates — {error.message}
                  </Typography>
                </Box>
              ) : groups.length === 0 ? (
                <Box sx={{ p: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    {units.length === 0 ? "No templates found for this workspace." : "No templates match your search."}
                  </Typography>
                </Box>
              ) : (
                groups.map(([supportRef, rows]) => (
                  <Box key={supportRef}>
                    <Typography
                      variant="caption"
                      sx={{
                        display: "block",
                        px: 1.5,
                        pt: 1.25,
                        pb: 0.5,
                        color: "text.disabled",
                        textTransform: "uppercase",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                      }}
                    >
                      {supportRef}
                    </Typography>
                    {rows.map((u) => {
                      const selected = u.template_id === templateId;
                      return (
                        <Box
                          key={u.template_id}
                          role="listitem"
                          onClick={() => selectTemplate(u.template_id)}
                          sx={{
                            px: 1.5,
                            py: 0.75,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            minHeight: 44,
                            borderInlineStart: "3px solid",
                            borderColor: selected ? "primary.main" : "transparent",
                            bgcolor: selected ? (t) => alpha(t.palette.primary.main, 0.08) : "transparent",
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                        >
                          {u.stale_source === 1 && (
                            <Tooltip title="Stale source — English sheet changed since this draft">
                              <Box
                                component="span"
                                sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: theme.palette.flows.warn.main, flexShrink: 0 }}
                              />
                            </Tooltip>
                          )}
                          <Box sx={{ flex: 1, overflow: "hidden" }}>
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >
                              {u.template_id}
                            </Typography>
                          </Box>
                          {dirtyIds.has(u.template_id) && (
                            <Tooltip title="Unsaved edit">
                              <Box
                                component="span"
                                aria-label="Unsaved edit"
                                sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: theme.palette.flows.warn.main, flexShrink: 0 }}
                              />
                            </Tooltip>
                          )}
                          <FlowStatusChip kind={curateStateChipKind(u.translation_state)} label={curateStateLabel(u.translation_state)} />
                        </Box>
                      );
                    })}
                  </Box>
                ))
              )}
            </Box>
          </Box>
        )}

        {showEditor && (
          <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {templateId ? (
              <CurateEditor
                key={templateId}
                templateId={templateId}
                direction={cfg?.direction ?? "ltr"}
                approvedTally={approvedTally}
                aiDisabledGlobal={aiDisabled}
                onAiDisabled={() => setAiDisabled(true)}
                onServerChange={refetch}
                onBack={isDesktop ? undefined : backToRail}
              />
            ) : (
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }}>
                <Typography variant="body2" color="text.secondary">
                  {loading ? "Loading templates…" : total === 0 ? "No templates found for this workspace." : "Select a template from the list."}
                </Typography>
              </Stack>
            )}
          </Box>
        )}
      </Box>
    </Stack>
  );
}
