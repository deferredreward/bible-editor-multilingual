// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// Editor pane for CurateScreen.tsx (l3-templates). Reuses the exact server
// contract and drafts-store wiring TemplateWorkspace.tsx already established
// for note templates — this is a re-skin (FlowNav chrome, mobile Back arrow,
// always-visible-but-honestly-disabled Approve) rather than a second
// implementation of the save/draft/approve machinery.
//
// Note save semantics (CLAUDE.md): nothing leaves the browser until Save is
// clicked. Every keystroke is stashed in the IndexedDB drafts store keyed by
// templateKey() and restored on mount, so leaving and coming back — or a
// reload — never silently discards typing. Templates are book-agnostic
// (DraftMeta carries no book/chapter/verse), same as tW/tA articles.

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
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
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import HistoryIcon from "@mui/icons-material/History";
import SaveIcon from "@mui/icons-material/Save";

import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { MarkdownView } from "../MarkdownView";
import { TemplateHistoryDialog } from "../TemplateHistoryDialog";
import { useTemplateAiDraft } from "../../hooks/useTemplateAiDraft";
import { drafts as draftStore, templateKey } from "../../sync/drafts";
import { ApiError, api, type TemplateUnit } from "../../sync/api";

export const CURATE_STATE_LABEL: Record<string, string> = {
  ai_draft: "AI draft",
  edited: "edited",
  validated: "validated",
};

export function curateStateChipKind(state: TemplateUnit["translation_state"]): FlowStatusKind {
  if (state === "validated") return "approved";
  if (state === "edited") return "edited";
  if (state === "ai_draft") return "draft";
  return "skip";
}

export function curateStateLabel(state: TemplateUnit["translation_state"]): string {
  return state ? CURATE_STATE_LABEL[state] ?? state : "not started";
}

export interface CurateEditorProps {
  templateId: string;
  direction: "ltr" | "rtl";
  approvedTally: string;
  aiDisabledGlobal: boolean;
  onAiDisabled: () => void;
  onServerChange: () => void;
  /** Present only below the desktop band — renders the mobile Back arrow. */
  onBack?: () => void;
}

export function CurateEditor({
  templateId,
  direction,
  approvedTally,
  aiDisabledGlobal,
  onAiDisabled,
  onServerChange,
  onBack,
}: CurateEditorProps) {
  const theme = useTheme();
  const [unit, setUnit] = useState<TemplateUnit | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch the unit, then restore any unsaved typing persisted for it — same
  // hydrate-on-mount pattern as TemplateWorkspace.tsx, so nothing is lost by
  // navigating away and back (or reloading) before Save.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStaleDraft(false);
    api
      .getTemplate(templateId)
      .then(async (u) => {
        if (cancelled) return;
        const server = u.target_md ?? "";
        const rec = await draftStore.get(templateKey(templateId)).catch(() => undefined);
        if (cancelled) return;
        const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
        let seeded = server;
        if (typeof stored === "string") {
          if (stored === server) {
            void draftStore.clear(templateKey(templateId));
          } else {
            seeded = stored;
            if (rec && rec.expectedVersion !== u.version) setStaleDraft(true);
          }
        }
        setUnit(u);
        setDraft(seeded);
        setPreview(false);
        setExpanded(false);
        setLoading(false);
        setErrorMsg(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setUnit(null);
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const applyServerUnit = useCallback((u: TemplateUnit) => {
    setUnit(u);
    setDraft(u.target_md ?? "");
    const key = templateKey(u.template_id);
    void draftStore.get(key).then((rec) => {
      const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
      if (stored === undefined || stored === (u.target_md ?? "")) void draftStore.clear(key);
    });
  }, []);

  const persistDraft = useCallback((u: TemplateUnit, text: string) => {
    const key = templateKey(u.template_id);
    if (text === (u.target_md ?? "")) {
      void draftStore.clear(key);
      return;
    }
    void draftStore.set(key, { target_md: text }, u.version, {
      kind: "template",
      templateId: u.template_id,
      supportRef: u.support_ref,
    });
  }, []);

  const dirty = unit != null && draft !== (unit.target_md ?? "");
  const state = unit?.translation_state ?? null;
  const isValidated = state === "validated";
  const isDraftState = state === "ai_draft" || state === "edited";
  const collapsedValidated = isValidated && !expanded && !dirty;

  useEffect(() => {
    if (!isValidated) setExpanded(false);
  }, [isValidated]);

  const {
    drafting: aiDrafting,
    error: aiDraftError,
    clearError: clearAiDraftError,
    conflictUnit: aiConflictUnit,
    clearConflict: clearAiConflict,
    draft: requestAiDraft,
  } = useTemplateAiDraft();

  useEffect(() => {
    if (!aiDraftError) return;
    setErrorMsg(aiDraftError);
    // The 503 body maps to this exact message (useTemplateAiDraft's
    // mapTemplateDraftError) — detect it once and disable AI drafting for the
    // rest of the screen, matching the mockup's aiDisabled flag rather than
    // re-asking the server per unit.
    if (aiDraftError.startsWith("AI not configured")) onAiDisabled();
    clearAiDraftError();
  }, [aiDraftError, clearAiDraftError, onAiDisabled]);

  useEffect(() => {
    if (!aiConflictUnit) return;
    applyServerUnit(aiConflictUnit);
    clearAiConflict();
    onServerChange();
  }, [aiConflictUnit, clearAiConflict, applyServerUnit, onServerChange]);

  const handleDraftWithAi = useCallback(async () => {
    if (!unit) return;
    const updated = await requestAiDraft(unit);
    if (updated) {
      applyServerUnit(updated);
      onServerChange();
    }
  }, [unit, requestAiDraft, applyServerUnit, onServerChange]);

  const handleSave = useCallback(async () => {
    if (!unit || !dirty) return;
    setSaving(true);
    try {
      const updated = await api.patchTemplate(templateId, unit.version, draft);
      applyServerUnit(updated);
      onServerChange();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const fresh = (e.body as { current?: TemplateUnit } | undefined)?.current;
        if (fresh) setUnit(fresh);
        setConflict(true);
        onServerChange();
      } else {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }, [unit, dirty, templateId, draft, applyServerUnit, onServerChange]);

  const handleValidate = useCallback(
    async (value: boolean) => {
      if (!unit) return;
      try {
        const updated = await api.validateTemplate(templateId, value);
        applyServerUnit(updated);
        onServerChange();
      } catch (e) {
        // The 404 case (translation_state NULL) is prevented client-side by
        // disabling the button below — a 404 reaching here would mean the
        // unit changed server-side between render and click.
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [unit, templateId, applyServerUnit, onServerChange],
  );

  if (loading && !unit) {
    return (
      <Stack alignItems="center" sx={{ p: 4 }}>
        <CircularProgress size={24} />
      </Stack>
    );
  }
  if (!unit) {
    return (
      <Box sx={{ p: 3 }}>
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mb: 1, minWidth: 44, minHeight: 44 }} aria-label="Back to template list">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Alert severity="error">
          {errorMsg ?? `Couldn't load ${templateId}.`}
        </Alert>
      </Box>
    );
  }

  // Findings §2.14: POST /api/templates/unit/validate 404s when
  // translation_state is NULL — true for every untouched unit (194/194 in a
  // fresh seed). Approve stays visible so the feature doesn't look missing,
  // but is disabled with the real reason rather than left always-on.
  const approveDisabledReason = dirty
    ? "Save your edit first."
    : saving
      ? null
      : state === null
        ? "Nothing to approve yet — the server requires a translation before Approve works. Write a translation or draft one with AI first."
        : null;

  return (
    <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1000, mx: "auto" }}>
      <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 2 }}>
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mt: 0.25, minWidth: 44, minHeight: 44 }} aria-label="Back to template list">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontFamily: "monospace", wordBreak: "break-word" }}>
            {unit.template_id}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
            <FlowStatusChip kind={curateStateChipKind(state)} label={curateStateLabel(state)} />
            <Typography variant="caption" color="text.secondary">
              {approvedTally} approved
            </Typography>
          </Stack>
        </Box>
        <Tooltip title="Version history">
          <IconButton size="small" onClick={() => setHistoryOpen(true)} sx={{ color: "text.secondary", minWidth: 44, minHeight: 44 }}>
            <HistoryIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {aiDisabledGlobal && (
        <Alert severity="info" sx={{ mb: 2 }}>
          AI not configured for this workspace — Draft with AI is unavailable (an admin needs to set BT_API_TOKEN). Editing and Approve still work normally.
        </Alert>
      )}

      {collapsedValidated ? (
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setExpanded(true);
          }}
          sx={{
            cursor: "pointer",
            borderRadius: "9px",
            border: `1px solid ${theme.palette.flows.ok.main}`,
            background: theme.palette.flows.ok.soft,
            color: theme.palette.flows.ok.ink,
            px: 2,
            py: 1.5,
            mb: 2,
          }}
        >
          Validated — click to expand and edit
        </Box>
      ) : (
        <Box
          sx={{
            border: dirty ? "1.5px solid" : "1px solid",
            borderColor: dirty ? "warning.light" : "divider",
            borderRadius: 1,
            overflow: "hidden",
            mb: 1,
          }}
        >
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            {/* LEFT: English source, read-only, forced LTR */}
            <Box
              dir="ltr"
              sx={{
                p: 2,
                borderInlineEnd: { md: "1px solid" },
                borderBottom: { xs: "1px solid", md: "none" },
                borderColor: "divider",
                bgcolor: (t) => alpha(t.palette.text.primary, 0.02),
              }}
            >
              <Typography
                variant="caption"
                sx={{ display: "block", mb: 1, fontFamily: "monospace", color: "text.disabled", textTransform: "uppercase", fontSize: 10, fontWeight: 600, letterSpacing: "0.09em" }}
              >
                Source (English, read-only)
              </Typography>
              <MarkdownView markdown={unit.source_md} dir="ltr" />
            </Box>

            {/* RIGHT: editable target draft, or its rendered preview */}
            <Box sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{ flex: 1, fontFamily: "monospace", color: "text.disabled", textTransform: "uppercase", fontSize: 10, fontWeight: 600, letterSpacing: "0.09em" }}
                >
                  Target (translated template)
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={preview ? "preview" : "edit"}
                  onChange={(_, v) => {
                    if (v) setPreview(v === "preview");
                  }}
                  sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1.25, minHeight: 32 } }}
                >
                  <ToggleButton value="edit">Edit</ToggleButton>
                  <ToggleButton value="preview">Preview</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              {preview ? (
                <MarkdownView markdown={draft} dir={direction} />
              ) : (
                <TextField
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    persistDraft(unit, e.target.value);
                  }}
                  fullWidth
                  multiline
                  minRows={8}
                  spellCheck={false}
                  variant="outlined"
                  inputProps={{
                    dir: direction,
                    style: {
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      fontSize: 14,
                      lineHeight: 1.6,
                      ...(direction === "rtl" ? { textAlign: "right" as const } : {}),
                    },
                  }}
                />
              )}
            </Box>
          </Box>
        </Box>
      )}
      {isDraftState && !collapsedValidated && (
        <Typography variant="caption" sx={{ color: "text.disabled", display: "block", mb: 1.5 }}>
          This draft came from AI — review it before approving.
        </Typography>
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {dirty ? "1 unsaved" : unit.updated_at ? `Saved ${new Date(unit.updated_at * 1000).toLocaleString()}` : "Not saved yet"}
        </Typography>
        <Tooltip title={isValidated ? "Approved templates can't be re-drafted — un-approve first." : aiDisabledGlobal ? "AI not configured for this workspace." : ""}>
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={aiDrafting ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />}
              disabled={dirty || saving || aiDrafting || isValidated || aiDisabledGlobal}
              onClick={handleDraftWithAi}
              sx={{ minHeight: 44 }}
            >
              Draft with AI
            </Button>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="contained"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon sx={{ fontSize: "18px !important" }} />}
          disabled={!dirty || saving}
          onClick={handleSave}
          sx={{ minHeight: 44 }}
        >
          Save
        </Button>
        {isValidated ? (
          <Tooltip title={dirty ? "Save your edit first." : ""}>
            <span>
              <Button size="small" variant="text" color="warning" disabled={dirty} onClick={() => handleValidate(false)} sx={{ minHeight: 44 }}>
                Un-approve
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title={approveDisabledReason ?? ""}>
            <span>
              <Button
                size="small"
                variant="contained"
                color="success"
                startIcon={<CheckIcon sx={{ fontSize: "18px !important" }} />}
                disabled={Boolean(approveDisabledReason) || saving}
                onClick={() => handleValidate(true)}
                sx={{ minHeight: 44 }}
              >
                Approve
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      <TemplateHistoryDialog
        open={historyOpen}
        templateId={templateId}
        currentVersion={unit.version}
        direction={direction}
        onClose={() => setHistoryOpen(false)}
        onUseVersion={(md) => {
          setDraft(md);
          persistDraft(unit, md);
        }}
      />

      <Snackbar open={staleDraft} onClose={() => setStaleDraft(false)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="warning" onClose={() => setStaleDraft(false)}>
          Your unsaved draft is from an older version of this template — saving will overwrite the newer server text with your draft.
        </Alert>
      </Snackbar>
      <Snackbar open={conflict} autoHideDuration={10000} onClose={() => setConflict(false)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="warning" onClose={() => setConflict(false)}>
          Someone else saved this template first — your draft is kept, Save again to apply it on top.
        </Alert>
      </Snackbar>
      <Snackbar open={errorMsg !== null} autoHideDuration={6000} onClose={() => setErrorMsg(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="error" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
