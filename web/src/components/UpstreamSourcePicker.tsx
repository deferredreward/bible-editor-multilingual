import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
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
import { api, ApiError } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import { RESOURCE_KEYS, UW_UPSTREAM_ORG, type ResourceKey } from "../lib/orgDraft";
import { RepoRef, SourceOverrideField } from "./SourceOverrideField";
import { upstreamLanguageOf, pendingOverrideSelection } from "../lib/setupWizard";

// Aligned grid template shared by every resource row so labels + the source
// column line up vertically (item: "make the columns actually columnar").
const ROW_GRID = { xs: "1fr", sm: "minmax(200px, max-content) 1fr" };

// One resource row. Checked = pull from the default upstream at its inferred
// repo. Unchecked reveals a choice: leave the resource blank (no upstream) or
// paste a Door43 URL for a DIFFERENT source (possibly a different org), verified
// on blur. Writes selections into the shared draft's resourceSource map.
function ResourceSourceRow({ resource, state }: { resource: ResourceKey; state: OrgDraftState }) {
  const { t } = useTranslation();
  const sel = state.resourceSource[resource] ?? { mode: "upstream" };
  const checked = sel.mode === "upstream";
  const [urlChoice, setUrlChoice] = useState(sel.mode === "override");

  const onToggleChecked = (next: boolean) => {
    if (next) {
      state.setResourceSource(resource, { mode: "upstream" });
      setUrlChoice(false);
    } else {
      state.setResourceSource(resource, { mode: "blank" });
    }
  };

  const onSubMode = (mode: "blank" | "url") => {
    if (mode === "blank") {
      setUrlChoice(false);
      state.setResourceSource(resource, { mode: "blank" });
    } else {
      setUrlChoice(true);
      // Opting into a custom URL marks the resource a PENDING override (no repo
      // yet) so Apply is blocked until a URL verifies — it must not fall through
      // to blank and silently omit the source the user intended to set.
      if (sel.mode !== "override") state.setResourceSource(resource, pendingOverrideSelection());
    }
  };

  const upstreamRepo = state.upstreamRepos[resource];

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: ROW_GRID,
        alignItems: "start",
        columnGap: 2,
        rowGap: 0.5,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        p: 1.5,
      }}
    >
      <FormControlLabel
        sx={{ m: 0 }}
        control={
          <Checkbox size="small" checked={checked} onChange={(e) => onToggleChecked(e.target.checked)} />
        }
        label={
          <Typography variant="body2" sx={{ fontWeight: 600, textAlign: "start" }}>
            {t(`setup.resource.${resource}`)}
          </Typography>
        }
      />

      <Box sx={{ minWidth: 0 }}>
        {checked ? (
          upstreamRepo ? (
            <RepoRef org={state.upstreamOrg} repo={upstreamRepo} />
          ) : (
            <Typography variant="body2" color="warning.main">
              {t("setup.reviewMissing")}
            </Typography>
          )
        ) : (
          <Stack spacing={0.5}>
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
          </Stack>
        )}
      </Box>
    </Box>
  );
}

// Step 2 — "Sources (pull FROM)". The default upstream org (unfoldingWord) plus
// one checked-by-default row per resource. DCS has no live org search, so the
// upstream org is verify-on-blur (getInferredOrgConfig), not autocomplete. The
// org must be VERIFIED before the wizard can advance/apply — except the
// well-known unfoldingWord default, which needs no round-trip.
export function UpstreamSourcePicker({ state }: { state: OrgDraftState }) {
  const { t } = useTranslation();
  const [orgInput, setOrgInput] = useState(state.upstreamOrg);
  const [verifying, setVerifying] = useState(false);
  // Distinguish a transient DCS failure (retry, don't hard-block) from a genuine
  // "no such org" (invalid). null = no error.
  const [errKind, setErrKind] = useState<"invalid" | "unreachable" | null>(null);

  // The well-known default upstream is known-good — mark it verified without a
  // round-trip so the happy path is never gated behind a network call.
  useEffect(() => {
    if (state.upstreamOrg === UW_UPSTREAM_ORG && !state.upstreamVerified) {
      state.setUpstreamVerified(true);
    }
  }, [state]);

  const verifyOrg = async () => {
    const org = orgInput.trim();
    setErrKind(null);
    if (!org) return;
    state.setUpstreamOrg(org);
    if (org === UW_UPSTREAM_ORG) {
      state.setUpstreamVerified(true);
      state.setUpstreamLanguageCode("en");
      return;
    }
    if (org === state.upstreamOrg && state.upstreamVerified) return;
    state.setUpstreamVerified(false);
    setVerifying(true);
    try {
      const res = await api.getInferredOrgConfig(org);
      state.setUpstreamVerified(true);
      // A non-unfoldingWord upstream must carry ITS language, not 'en'.
      state.setUpstreamLanguageCode(upstreamLanguageOf(res.proposal.languageCode));
      // Adopt any inferred repo names for this alternate upstream org.
      const next = { ...state.upstreamRepos };
      for (const key of RESOURCE_KEYS) {
        const inferred = res.proposal.repos[key];
        if (inferred) next[key] = inferred;
      }
      state.setUpstreamRepos(next);
    } catch (e) {
      state.setUpstreamVerified(false);
      // 5xx (DCS unreachable) is transient — allow retry, don't call it invalid.
      const transient = e instanceof ApiError && e.status >= 500;
      setErrKind(transient ? "unreachable" : "invalid");
    } finally {
      setVerifying(false);
    }
  };

  const showBlockingGate = !state.upstreamVerified && state.upstreamOrg !== UW_UPSTREAM_ORG;

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t("setup.sourcesIntro")}
      </Typography>

      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          sx={{ maxWidth: 360, flex: 1 }}
          label={t("setup.upstreamOrgLabel")}
          value={orgInput}
          onChange={(e) => setOrgInput(e.target.value)}
          onBlur={() => void verifyOrg()}
          helperText={
            errKind === "invalid"
              ? t("setup.upstreamOrgError")
              : errKind === "unreachable"
                ? t("setup.upstreamOrgUnreachable")
                : t("setup.upstreamOrgHelp")
          }
          error={errKind === "invalid"}
          InputProps={{ endAdornment: verifying ? <CircularProgress size={16} /> : undefined }}
        />
        {(errKind === "unreachable" || (showBlockingGate && !verifying)) && (
          <Button size="small" variant="outlined" onClick={() => void verifyOrg()} disabled={verifying}>
            {t("setup.upstreamOrgRetry")}
          </Button>
        )}
      </Stack>

      {showBlockingGate && (
        <Alert severity={errKind === "unreachable" ? "warning" : "error"} variant="outlined">
          {errKind === "unreachable"
            ? t("setup.upstreamOrgUnreachable")
            : t("setup.upstreamOrgUnverified")}
        </Alert>
      )}

      <Stack spacing={1}>
        {RESOURCE_KEYS.map((resource) => (
          <ResourceSourceRow key={resource} resource={resource} state={state} />
        ))}
      </Stack>

      {state.hasUnverifiedOverride && (
        <Alert severity="warning" variant="outlined">
          {t("setup.unverifiedOverride", {
            resources: state.unverifiedOverrideResources
              .map((r) => t(`setup.resource.${r}`))
              .join(", "),
          })}
        </Alert>
      )}
    </Stack>
  );
}
