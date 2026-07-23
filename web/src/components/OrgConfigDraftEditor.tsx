import { useState } from "react";
import { Stack, TextField } from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError, type InferredOrgConfigResponse } from "../sync/api";
import {
  UW_UPSTREAM_ORG,
  UW_UPSTREAM_LANG,
  UW_UPSTREAM_REPOS,
  defaultResourceSources,
  allResourceSources,
  buildTranslationSource,
  translationSourceOnFor,
  type ResourceKey,
  type ResourceSource,
  type ResourceSourceMap,
} from "../lib/orgDraft";
import { resolveResourceLanguage, type ResolvedResourceLanguage } from "../lib/isoLanguages";
import { hasUnverifiedOverride, unverifiedOverrideResources } from "../lib/setupWizard";

// Shared draft-editor state for manifest inference (PR B), used by the
// multi-step Setup wizard.
export interface OrgDraftState {
  org: string;
  setOrg: (v: string) => void;
  loading: boolean;
  draft: InferredOrgConfigResponse | null;
  /** Localized detection error message, or null. */
  detectError: string | null;
  /** Editable resolved repo per role (verified prefilled, ambiguous picked). */
  repos: Record<string, string>;
  setRepo: (role: string, v: string) => void;
  /**
   * Legacy all-or-nothing translationSource toggle. Backed by `resourceSource`:
   * reads true when ANY resource is non-blank; setting it flips EVERY resource
   * to upstream (on) or blank (off). The existing wizard/Preferences UI drives
   * only this; the per-resource model below lands in the follow-up wizard PR.
   */
  translationSourceOn: boolean;
  setTranslationSourceOn: (v: boolean) => void;
  // ── Per-resource upstream model (owner decision — not yet wired to UI) ──
  /** Upstream org each resource is pulled FROM (single org for all; #84 is per-resource org). */
  upstreamOrg: string;
  setUpstreamOrg: (v: string) => void;
  /** Source language code of the upstream org (translationSource.languageCode); defaults to 'en'. */
  upstreamLanguageCode: string;
  setUpstreamLanguageCode: (v: string) => void;
  /** True once the upstream org has been verified (org-search / canonical). */
  upstreamVerified: boolean;
  setUpstreamVerified: (v: boolean) => void;
  /** Default/inferred repo per resource under the upstream org (auto-fillable). */
  upstreamRepos: Record<ResourceKey, string>;
  setUpstreamRepo: (key: ResourceKey, v: string) => void;
  setUpstreamRepos: (repos: Record<ResourceKey, string>) => void;
  /** Per-resource source selection: pull from upstream, an override repo, or blank. */
  resourceSource: ResourceSourceMap;
  setResourceSource: (key: ResourceKey, sel: ResourceSource) => void;
  /** True when any resource sits on an override URL that hasn't verified — Apply must block. */
  hasUnverifiedOverride: boolean;
  /** The resources currently on an unverified override (for a "fix these" message). */
  unverifiedOverrideResources: ResourceKey[];
  /** Pre-seeded resource language (null until seeded); prefers inferred, falls back to UI lang. */
  resourceLang: ResolvedResourceLanguage | null;
  /** Seed resourceLang from the current draft's inference, falling back to the UI language. */
  seedResourceLanguage: (uiLangCode: string) => void;
  /** Directly set the resource language (Setup wizard's editable Autocomplete). */
  setResourceLanguage: (lang: ResolvedResourceLanguage | null) => void;
  exportOrg: string;
  setExportOrg: (v: string) => void;
  /** Run inference for the entered org. */
  detect: () => Promise<void>;
  /** Clear the draft back to the pre-detection state. */
  reset: () => void;
  /** True once every missing/ambiguous role is resolved. */
  complete: boolean;
  /** Assemble the custom-gl overrides object for PUT /api/project-config. */
  buildOverrides: () => Record<string, unknown>;
}

export function useOrgDraft(): OrgDraftState {
  const { t } = useTranslation();
  const [org, setOrg] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<InferredOrgConfigResponse | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Record<string, string>>({});
  const [upstreamOrg, setUpstreamOrg] = useState(UW_UPSTREAM_ORG);
  const [upstreamLanguageCode, setUpstreamLanguageCode] = useState(UW_UPSTREAM_LANG);
  const [upstreamVerified, setUpstreamVerified] = useState(false);
  const [upstreamRepos, setUpstreamReposState] =
    useState<Record<ResourceKey, string>>({ ...UW_UPSTREAM_REPOS });
  // Default all-upstream — reproduces the legacy `translationSourceOn = true`
  // default (UW_SOURCE) once buildOverrides runs.
  const [resourceSource, setResourceSourceState] = useState<ResourceSourceMap>(defaultResourceSources());
  const [resourceLang, setResourceLang] = useState<ResolvedResourceLanguage | null>(null);
  const [exportOrg, setExportOrg] = useState("");

  const setRepo = (role: string, v: string) => setRepos((r) => ({ ...r, [role]: v }));
  const setUpstreamRepo = (key: ResourceKey, v: string) =>
    setUpstreamReposState((r) => ({ ...r, [key]: v }));
  const setUpstreamRepos = (next: Record<ResourceKey, string>) => setUpstreamReposState({ ...next });
  const setResourceSource = (key: ResourceKey, sel: ResourceSource) =>
    setResourceSourceState((s) => ({ ...s, [key]: sel }));

  const translationSourceOn = translationSourceOnFor(resourceSource);
  const setTranslationSourceOn = (v: boolean) =>
    setResourceSourceState(allResourceSources(v ? "upstream" : "blank"));

  const seedResourceLanguage = (uiLangCode: string) =>
    setResourceLang(resolveResourceLanguage(draft?.proposal ?? null, uiLangCode));
  const setResourceLanguage = (lang: ResolvedResourceLanguage | null) => setResourceLang(lang);

  const reset = () => {
    setDraft(null);
    setDetectError(null);
    setRepos({});
    setResourceLang(null);
  };

  const detect = async () => {
    const trimmed = org.trim();
    if (!trimmed) return;
    setLoading(true);
    setDetectError(null);
    setDraft(null);
    try {
      const res = await api.getInferredOrgConfig(trimmed);
      setDraft(res);
      setExportOrg(res.proposal.suggestedExportOrg);
      // Seed the editable repo map from the verified roles; ambiguous/missing
      // roles start empty and must be resolved before `complete` flips true.
      setRepos({ ...(res.proposal.repos as Record<string, string>) });
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string } | undefined)?.error;
        const key = code === "org_not_found" ? "orgNotFound" : code === "dcs_forbidden" ? "forbidden" : null;
        setDetectError(key ? t(`preferences.detectOrg.${key}`) : e.message);
      } else {
        setDetectError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const complete =
    !!draft &&
    draft.missing.length === 0 &&
    draft.ambiguous.every((a) => !!repos[a.role]);

  const buildOverrides = (): Record<string, unknown> => {
    if (!draft) return {};
    const resolvedRepos: Record<string, string> = { ...repos };
    // Language fields: prefer an explicitly pre-seeded resourceLang (follow-up
    // wizard); otherwise keep the exact proposal-first logic the existing
    // wizard has always emitted (so its output is byte-identical).
    const languageCode = resourceLang?.languageCode ?? draft.proposal.languageCode ?? draft.org;
    const languageName = resourceLang?.languageName ?? draft.proposal.languageName ?? draft.org;
    const languageTitle = resourceLang
      ? (draft.proposal.languageTitle ?? resourceLang.languageName)
      : (draft.proposal.languageTitle ?? draft.org);
    const direction = resourceLang?.direction ?? draft.proposal.direction;
    // translationSource: assembled from the per-resource selection. All-upstream
    // with the default UW upstream (org=unfoldingWord, en_* repos) reproduces the
    // legacy UW_SOURCE exactly; all-blank yields null — matching what the old
    // `translationSourceOn ? UW_SOURCE : null` produced.
    const translationSource = buildTranslationSource({
      upstreamOrg,
      languageCode: upstreamLanguageCode,
      upstreamRepos,
      resourceSource,
    });
    return {
      org: draft.org,
      exportOrg: exportOrg.trim() || draft.org,
      languageCode,
      languageName,
      languageTitle,
      direction,
      repos: resolvedRepos,
      litLabel: draft.proposal.litLabel ?? resolvedRepos.lit?.toUpperCase() ?? "LIT",
      simLabel: draft.proposal.simLabel ?? resolvedRepos.sim?.toUpperCase() ?? "SIM",
      translationSource,
    };
  };

  return {
    org,
    setOrg,
    loading,
    draft,
    detectError,
    repos,
    setRepo,
    translationSourceOn,
    setTranslationSourceOn,
    upstreamOrg,
    setUpstreamOrg,
    upstreamLanguageCode,
    setUpstreamLanguageCode,
    upstreamVerified,
    setUpstreamVerified,
    upstreamRepos,
    setUpstreamRepo,
    setUpstreamRepos,
    resourceSource,
    setResourceSource,
    hasUnverifiedOverride: hasUnverifiedOverride(resourceSource),
    unverifiedOverrideResources: unverifiedOverrideResources(resourceSource),
    resourceLang,
    seedResourceLanguage,
    setResourceLanguage,
    exportOrg,
    setExportOrg,
    detect,
    reset,
    complete,
    buildOverrides,
  };
}

// The two lane repo fields (lit/sim), editable. Used by the wizard's
// confirm-lanes step; both feed the same custom-gl override that is applied next.
export function LaneRepoFields({ state }: { state: OrgDraftState }) {
  const { t } = useTranslation();
  const { draft, repos, setRepo } = state;
  if (!draft) return null;
  const litLabel = draft.proposal.litLabel ?? "LIT";
  const simLabel = draft.proposal.simLabel ?? "SIM";
  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={`${t("setup.litRepoLabel")} (${litLabel})`}
        value={repos.lit ?? ""}
        onChange={(e) => setRepo("lit", e.target.value)}
        placeholder="en_ult"
      />
      <TextField
        size="small"
        label={`${t("setup.simRepoLabel")} (${simLabel})`}
        value={repos.sim ?? ""}
        onChange={(e) => setRepo("sim", e.target.value)}
        placeholder="en_ust"
      />
    </Stack>
  );
}
