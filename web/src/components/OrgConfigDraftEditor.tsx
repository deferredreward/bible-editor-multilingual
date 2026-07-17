import { useState } from "react";
import {
  Alert,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError, type InferredOrgConfigResponse } from "../sync/api";

// The seven repo roles a custom-gl override must carry, in display order.
export const RESOURCE_ROLES = ["lit", "sim", "tn", "tq", "twl", "tw", "ta"] as const;

// unfoldingWord's English gateway resources — the default translationSource a
// non-English org typically translates FROM. Kept identical to the object PR B's
// OrgDetectionSection built inline, so the two callers can never drift apart.
const UW_SOURCE = {
  org: "unfoldingWord",
  languageCode: "en",
  repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
} as const;

// Shared draft-editor state for manifest inference (PR B). Used both by the
// single-shot OrgDetectionSection in Preferences and by the multi-step Setup
// wizard, so the override-building logic lives in exactly one place.
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
  translationSourceOn: boolean;
  setTranslationSourceOn: (v: boolean) => void;
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
  const [translationSourceOn, setTranslationSourceOn] = useState(true);
  const [exportOrg, setExportOrg] = useState("");

  const setRepo = (role: string, v: string) => setRepos((r) => ({ ...r, [role]: v }));

  const reset = () => {
    setDraft(null);
    setDetectError(null);
    setRepos({});
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
    return {
      org: draft.org,
      exportOrg: exportOrg.trim() || draft.org,
      languageCode: draft.proposal.languageCode ?? draft.org,
      languageName: draft.proposal.languageName ?? draft.org,
      languageTitle: draft.proposal.languageTitle ?? draft.org,
      direction: draft.proposal.direction,
      repos: resolvedRepos,
      litLabel: draft.proposal.litLabel ?? resolvedRepos.lit?.toUpperCase() ?? "LIT",
      simLabel: draft.proposal.simLabel ?? resolvedRepos.sim?.toUpperCase() ?? "SIM",
      translationSource: translationSourceOn ? UW_SOURCE : null,
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
    exportOrg,
    setExportOrg,
    detect,
    reset,
    complete,
    buildOverrides,
  };
}

// Renders the per-role rows (verified read-only, ambiguous select, missing
// warning), the translationSource toggle, and the export-org field. Presentation
// only — all state lives in the shared `useOrgDraft` instance passed in.
export function OrgDraftFields({ state }: { state: OrgDraftState }) {
  const { t } = useTranslation();
  const { draft, repos, setRepo, translationSourceOn, setTranslationSourceOn, exportOrg, setExportOrg } = state;
  if (!draft) return null;
  return (
    <Stack spacing={1}>
      {!draft.manifestFound && (
        <Alert severity="warning" variant="outlined">
          {t("preferences.detectOrg.manifestMissing")}
        </Alert>
      )}
      {RESOURCE_ROLES.map((role) => {
        const verified = draft.proposal.repos[role];
        const ambiguous = draft.ambiguous.find((a) => a.role === role);
        const missing = draft.missing.includes(role);
        return (
          <Stack key={role} direction="row" spacing={1} alignItems="center">
            <Chip size="small" label={role} sx={{ width: 48 }} />
            {verified ? (
              <Typography variant="body2">{verified}</Typography>
            ) : ambiguous ? (
              <TextField
                select
                size="small"
                value={repos[role] ?? ""}
                onChange={(e) => setRepo(role, e.target.value)}
                sx={{ minWidth: 200 }}
                helperText={t("preferences.detectOrg.ambiguousRole")}
              >
                {ambiguous.candidates.map((cand) => (
                  <MenuItem key={cand} value={cand}>
                    {cand}
                  </MenuItem>
                ))}
              </TextField>
            ) : missing ? (
              <Typography variant="body2" color="error.main">
                {t("preferences.detectOrg.missingRoles")}
              </Typography>
            ) : null}
          </Stack>
        );
      })}
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={translationSourceOn}
            onChange={(_, v) => setTranslationSourceOn(v)}
          />
        }
        label={t("preferences.detectOrg.translationSourceToggle")}
      />
      <TextField
        size="small"
        label={t("preferences.detectOrg.exportOrgLabel")}
        value={exportOrg}
        onChange={(e) => setExportOrg(e.target.value)}
      />
    </Stack>
  );
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
