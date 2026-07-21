// Async lifecycle for POST /api/templates/unit/draft — the note-template
// analogue of useAiDrafts.ts (which owns /api/tn-quick). Simpler than the TN
// version on purpose: a template is edited in a single-pane workspace (one
// TemplateEditor mounted at a time, keyed by templateId — see
// TemplateWorkspace.tsx), so there's no off-screen-card / notification-stack
// concern to solve. The request still aborts on unmount (component remounts
// wholesale on templateId change), matching useAiDrafts's cross-navigation
// safety without needing to lift ownership to a shell-level owner.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type TemplateUnit } from "../sync/api";

function mapTemplateDraftError(err: unknown): string {
  if (err instanceof ApiError) {
    const code =
      err.body && typeof err.body === "object" && "error" in err.body
        ? String((err.body as { error?: unknown }).error)
        : "";
    switch (code) {
      case "template_draft_disabled":
        return "AI not configured — admin must set BT_API_TOKEN.";
      case "model_call_failed":
        return "AI service unavailable.";
      case "body_too_large":
        return "Template too large for the AI request.";
      case "version_mismatch":
        return "Someone else updated this template — reload and try again.";
      case "unauthorized":
        return "Session expired — sign in again.";
      default:
        return `AI request failed (HTTP ${err.status}).`;
    }
  }
  if (err instanceof DOMException && err.name === "AbortError") return "";
  if (err instanceof Error && err.message) return err.message;
  return "Network error.";
}

export interface UseTemplateAiDraftAPI {
  drafting: boolean;
  error: string | null;
  clearError: () => void;
  /** Set when a draft request 409s — the fresh server row from the error
   *  body, same as handleSave's conflict rebase. The caller should apply it
   *  (e.g. via applyServerUnit) so the next retry uses the current version
   *  instead of re-sending the stale one and 409ing forever. */
  conflictUnit: TemplateUnit | null;
  clearConflict: () => void;
  draft: (unit: TemplateUnit) => Promise<TemplateUnit | null>;
}

export function useTemplateAiDraft(): UseTemplateAiDraftAPI {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictUnit, setConflictUnit] = useState<TemplateUnit | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const clearError = useCallback(() => setError(null), []);
  const clearConflict = useCallback(() => setConflictUnit(null), []);

  const draft = useCallback(async (unit: TemplateUnit) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setDrafting(true);
    setError(null);
    try {
      const updated = await api.draftTemplate(unit.template_id, unit.version, controller.signal);
      return updated;
    } catch (err) {
      if (controller.signal.aborted) return null;
      if (err instanceof ApiError && err.status === 409) {
        const fresh = (err.body as { current?: TemplateUnit } | undefined)?.current;
        if (fresh) setConflictUnit(fresh);
      }
      const message = mapTemplateDraftError(err);
      if (message) setError(message);
      return null;
    } finally {
      if (controllerRef.current === controller) setDrafting(false);
    }
  }, []);

  // Abort an in-flight draft request when the owning component unmounts
  // (templateId change remounts TemplateEditor wholesale — see the `key`
  // prop in TemplateWorkspace.tsx).
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { drafting, error, clearError, conflictUnit, clearConflict, draft };
}
