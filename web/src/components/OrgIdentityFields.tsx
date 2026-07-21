import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Autocomplete, Box, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { api } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import { LANGUAGES, lookupLanguage, directionForLang } from "../lib/isoLanguages";

interface LangOption {
  code: string;
  name: string;
}

// Curated ISO options for the resource-language picker (code → name), sorted by
// display name. Freesolo-friendly: an unknown typed code still resolves a
// name/direction via lookupLanguage/directionForLang at selection time.
const LANGUAGE_OPTIONS: LangOption[] = Object.entries(LANGUAGES)
  .map(([code, info]) => ({ code, name: info.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Step 1 — "Your organization". No typing: the org is read from the current
// workspace and shown read-only (a single-org admin cannot change it). On mount
// we auto-detect the org's inferred config, then pre-seed the one editable
// field — resource language — which writes straight into the draft's language
// fields (languageCode/languageName/direction) via setResourceLanguage.
export function OrgIdentityFields({ state }: { state: OrgDraftState }) {
  const { t, i18n } = useTranslation();
  const [workspaceOrg, setWorkspaceOrg] = useState<string | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  // Auto-detect must fire exactly once for the resolved workspace org.
  const detectedFor = useRef<string | null>(null);
  const seeded = useRef(false);

  // Resolve the current workspace's org, then drive the shared draft's org +
  // detection. The org name is display-only; detection populates repos + the
  // inferred proposal the rest of the wizard builds on.
  useEffect(() => {
    let cancelled = false;
    api
      .listWorkspaces()
      .then((res) => {
        if (cancelled) return;
        const org = res.workspaces.find((w) => w.slug === res.current)?.org ?? null;
        setWorkspaceOrg(org);
        if (org) state.setOrg(org);
      })
      .catch(() => {
        if (!cancelled) setWsError(t("setup.orgLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-run detection once the org is known (only once per org).
  useEffect(() => {
    if (workspaceOrg && detectedFor.current !== workspaceOrg && state.org === workspaceOrg) {
      detectedFor.current = workspaceOrg;
      void state.detect();
    }
  }, [workspaceOrg, state]);

  // Pre-seed the resource language the first time a proposal arrives (inferred
  // language wins; UI language is the fallback). The admin can then override it.
  useEffect(() => {
    if (state.draft && !seeded.current && !state.resourceLang) {
      seeded.current = true;
      state.seedResourceLanguage(i18n.language);
    }
  }, [state, i18n.language]);

  const selected = useMemo<LangOption | null>(() => {
    if (!state.resourceLang) return null;
    return { code: state.resourceLang.languageCode, name: state.resourceLang.languageName };
  }, [state.resourceLang]);

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t("setup.orgIdentityIntro")}
      </Typography>

      {wsError && <Alert severity="error">{wsError}</Alert>}

      <Box>
        <Typography variant="caption" color="text.secondary">
          {t("setup.orgNameLabel")}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h6">{workspaceOrg ?? "…"}</Typography>
          {state.loading && <CircularProgress size={16} />}
        </Stack>
      </Box>

      {state.detectError && <Alert severity="warning">{state.detectError}</Alert>}

      <Autocomplete<LangOption, false, false, true>
        freeSolo
        size="small"
        sx={{ maxWidth: 360 }}
        options={LANGUAGE_OPTIONS}
        value={selected}
        getOptionLabel={(opt) => (typeof opt === "string" ? opt : `${opt.name} (${opt.code})`)}
        isOptionEqualToValue={(opt, val) => opt.code === val.code}
        onChange={(_e, val) => {
          if (val == null) {
            state.setResourceLanguage(null);
            return;
          }
          // A picked option carries a code+name; a free-typed string is treated
          // as a raw code and resolved through the curated table.
          const code = typeof val === "string" ? val.trim() : val.code;
          if (!code) return;
          const known = lookupLanguage(code);
          state.setResourceLanguage({
            languageCode: code,
            languageName: typeof val === "string" ? known?.name || code : val.name,
            direction: known?.direction ?? directionForLang(code),
          });
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={t("setup.resourceLanguageLabel")}
            helperText={t("setup.resourceLanguageHelp")}
          />
        )}
      />
    </Stack>
  );
}
