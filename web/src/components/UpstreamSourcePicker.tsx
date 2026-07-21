import { useState } from "react";
import {
  Alert,
  Box,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import { RESOURCE_KEYS, UW_UPSTREAM_ORG, type ResourceKey } from "../lib/orgDraft";
import { RepoRef, SourceOverrideField } from "./SourceOverrideField";

// One resource row. Checked = pull from the default upstream at its inferred
// repo. Unchecked reveals a choice: leave the resource blank (no upstream) or
// paste a Door43 URL for a DIFFERENT source (possibly a different org), verified
// on blur. Writes selections into the shared draft's resourceSource map.
function ResourceSourceRow({
  resource,
  state,
}: {
  resource: ResourceKey;
  state: OrgDraftState;
}) {
  const { t } = useTranslation();
  const sel = state.resourceSource[resource] ?? { mode: "upstream" };
  const checked = sel.mode === "upstream";
  // Sub-mode when unchecked: a URL choice is remembered locally so the field
  // stays open while the admin is still typing (mode is only promoted to
  // 'override' once a URL verifies).
  const [urlChoice, setUrlChoice] = useState(sel.mode === "override");

  const onToggleChecked = (next: boolean) => {
    if (next) {
      state.setResourceSource(resource, { mode: "upstream" });
      setUrlChoice(false);
    } else {
      // Default an unchecked resource to blank until the admin opts into a URL.
      state.setResourceSource(resource, { mode: "blank" });
    }
  };

  const onSubMode = (mode: "blank" | "url") => {
    if (mode === "blank") {
      setUrlChoice(false);
      state.setResourceSource(resource, { mode: "blank" });
    } else {
      setUrlChoice(true);
      // Keep it blank (no upstream) until a URL actually verifies.
      if (sel.mode !== "override") state.setResourceSource(resource, { mode: "blank" });
    }
  };

  const upstreamRepo = state.upstreamRepos[resource];

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <FormControlLabel
        control={
          <Checkbox size="small" checked={checked} onChange={(e) => onToggleChecked(e.target.checked)} />
        }
        label={
          <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap">
            <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 150 }}>
              {t(`setup.resource.${resource}`)}
            </Typography>
            {checked && upstreamRepo && <RepoRef org={state.upstreamOrg} repo={upstreamRepo} />}
          </Stack>
        }
      />

      {!checked && (
        <Box sx={{ pl: 4, pt: 0.5 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={urlChoice ? "url" : "blank"}
            onChange={(_e, v) => v && onSubMode(v)}
          >
            <ToggleButton value="blank">{t("setup.leaveBlank")}</ToggleButton>
            <ToggleButton value="url">{t("setup.useDifferentSource")}</ToggleButton>
          </ToggleButtonGroup>

          {urlChoice && <SourceOverrideField resource={resource} state={state} />}
        </Box>
      )}
    </Box>
  );
}

// Step 2 — "Sources (pull FROM)". The default upstream org (unfoldingWord) plus
// one checked-by-default row per resource. DCS has no live org search, so the
// upstream org is verify-on-blur (getInferredOrgConfig), not autocomplete.
export function UpstreamSourcePicker({ state }: { state: OrgDraftState }) {
  const { t } = useTranslation();
  const [orgInput, setOrgInput] = useState(state.upstreamOrg);
  const [verifying, setVerifying] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

  const onOrgBlur = async () => {
    const org = orgInput.trim();
    setOrgError(null);
    if (!org) return;
    if (org === UW_UPSTREAM_ORG) {
      // The well-known default needs no round-trip.
      state.setUpstreamOrg(org);
      state.setUpstreamVerified(true);
      return;
    }
    if (org === state.upstreamOrg && state.upstreamVerified) return;
    state.setUpstreamOrg(org);
    setVerifying(true);
    try {
      const res = await api.getInferredOrgConfig(org);
      state.setUpstreamVerified(true);
      // Adopt any inferred repo names for this alternate upstream org so the
      // rows show real repos rather than the default en_* names.
      const next = { ...state.upstreamRepos };
      for (const key of RESOURCE_KEYS) {
        const inferred = res.proposal.repos[key];
        if (inferred) next[key] = inferred;
      }
      state.setUpstreamRepos(next);
    } catch {
      state.setUpstreamVerified(false);
      setOrgError(t("setup.upstreamOrgError"));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t("setup.sourcesIntro")}
      </Typography>

      <TextField
        size="small"
        sx={{ maxWidth: 360 }}
        label={t("setup.upstreamOrgLabel")}
        value={orgInput}
        onChange={(e) => setOrgInput(e.target.value)}
        onBlur={() => void onOrgBlur()}
        helperText={orgError ?? t("setup.upstreamOrgHelp")}
        error={!!orgError}
        InputProps={{
          endAdornment: verifying ? <CircularProgress size={16} /> : undefined,
        }}
      />

      {!state.upstreamVerified && state.upstreamOrg !== UW_UPSTREAM_ORG && (
        <Alert severity="info" variant="outlined">
          {t("setup.upstreamOrgUnverified")}
        </Alert>
      )}

      <Stack spacing={1}>
        {RESOURCE_KEYS.map((resource) => (
          <ResourceSourceRow key={resource} resource={resource} state={state} />
        ))}
      </Stack>
    </Stack>
  );
}
