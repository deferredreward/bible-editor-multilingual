import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../sync/api";
import { applyProjectOverrides, refreshProjectConfig, useProjectConfig } from "../hooks/useProjectConfig";
import { useOrgDraft } from "./OrgConfigDraftEditor";
import { OrgIdentityFields } from "./OrgIdentityFields";
import { UpstreamSourcePicker } from "./UpstreamSourcePicker";
import { LaneTargetModeStep, type LaneEditMode, type LaneModeMap } from "./LaneTargetModeStep";
import { LaneReplacementDriver } from "./LaneReplacementDriver";
import { RepoRef } from "./SourceOverrideField";
import { RESOURCE_KEYS, buildTranslationSource, type ResourceKey } from "../lib/orgDraft";
import {
  SETUP_STEPS,
  lanesNeedingReplacement,
  stepAfterApply,
  replacementContinueEnabled,
  type LaneKey,
} from "../lib/setupWizard";

// Apply the edit/align choice to each lane that exists post-Apply. "align" =
// text frozen (read-only) but alignment writable; "edit" = both writable. Skips
// quarantined lanes (a replacement carries its own locks — their mode is applied
// after activation, in LaneReplacementDriver) and any lane already in the
// desired state. Reads the FRESH config so configRevision isn't stale, and
// RETURNS the lanes whose patch failed so the caller can block rather than
// silently leave an "aligning only" lane editable (data-safety).
async function applyLaneModes(laneMode: LaneModeMap): Promise<("lit" | "sim")[]> {
  const cfg = await refreshProjectConfig().catch(() => null);
  if (!cfg) return ["lit", "sim"];
  const failed: ("lit" | "sim")[] = [];
  for (const lane of ["lit", "sim"] as const) {
    const ls = cfg.laneState?.[lane];
    if (!ls || ls.replacementRequired) continue;
    const desiredReadOnly = laneMode[lane] === "align";
    if (ls.config.textReadOnly === desiredReadOnly && ls.config.alignmentWritable) continue;
    try {
      await api.lanePatch(lane, ls.configRevision, {
        textReadOnly: desiredReadOnly,
        alignmentWritable: true,
      });
    } catch {
      failed.push(lane);
    }
  }
  return failed;
}

// Admin-only guided CONFIGURATION for an org (owner-confirmed flow): confirm the
// org + resource language, choose the upstream sources to pull FROM, set the
// org's own target repos + edit/align per lane, apply, and (only when
// re-configuring a populated project) finish changing the scripture source.
// Setup no longer imports content — that happens later in the editor / the
// forthcoming Import surface.
export function SetupWizard() {
  const { t } = useTranslation();
  const draft = useOrgDraft();
  const projectConfig = useProjectConfig();
  const [activeStep, setActiveStep] = useState<number>(SETUP_STEPS.organization);

  // Step 3 — per-lane edit/align choice (applied after Apply).
  const [laneMode, setLaneModeState] = useState<LaneModeMap>({ lit: "edit", sim: "edit" });
  const setLaneMode = (lane: "lit" | "sim", m: LaneEditMode) =>
    setLaneModeState((s) => ({ ...s, [lane]: m }));

  // Step 4 — apply.
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // True once the custom-gl overrides were persisted — re-clicking Apply would
  // 409, so after this only the lane-mode step can be retried.
  const [applied, setApplied] = useState(false);
  // Set when a post-apply lanePatch (edit/align) failed: block advancing and
  // offer a retry, so an "Aligning only" lane is never left editable.
  const [laneModeError, setLaneModeError] = useState<string | null>(null);

  // The lanes that Apply quarantined (a source migration), captured when routing
  // to the replacement step, plus which have finished (activated + mode
  // confirmed). Continue is gated on ALL of them being done.
  const [lanesToReplace, setLanesToReplace] = useState<LaneKey[]>([]);
  const [laneDone, setLaneDone] = useState<Partial<Record<LaneKey, boolean>>>({});
  const markLaneDone = (lane: LaneKey) => setLaneDone((d) => ({ ...d, [lane]: true }));

  // Scroll the newly-active step to the top of the viewport on change, so the
  // admin lands on the step header rather than below it (item 10).
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    stepRefs.current[activeStep]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeStep]);

  // Apply the lane edit/align modes, then advance. Shared by first-apply and the
  // retry button so a lanePatch failure is recoverable without re-applying the
  // (now-persisted) overrides.
  const finishLaneModesAndAdvance = async () => {
    const failed = await applyLaneModes(laneMode);
    if (failed.length > 0) {
      setLaneModeError(t("setup.laneModeFailed", { lanes: failed.join(", ") }));
      return;
    }
    setLaneModeError(null);
    const cfg = await refreshProjectConfig().catch(() => null);
    const next = stepAfterApply(cfg?.laneState);
    if (next === SETUP_STEPS.replacement) {
      // Capture the quarantined lanes so their drivers stay mounted through
      // activation + mode confirmation (they leave `laneState` once activated).
      setLanesToReplace(lanesNeedingReplacement(cfg?.laneState));
      setLaneDone({});
    }
    setActiveStep(next);
  };

  const doApply = async () => {
    if (!draft.complete || !draft.upstreamVerified || draft.hasUnverifiedOverride) return;
    setApplying(true);
    setApplyError(null);
    setLaneModeError(null);
    try {
      await applyProjectOverrides("custom-gl", draft.buildOverrides());
      setApplied(true);
      await finishLaneModesAndAdvance();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const code = (e.body as { error?: string } | undefined)?.error;
        setApplyError(code === "project_not_empty" ? t("setup.projectNotEmpty") : t("setup.laneBusy"));
      } else {
        setApplyError(t("setup.applyFailed"));
      }
    } finally {
      setApplying(false);
    }
  };

  const retryLaneModes = async () => {
    setApplying(true);
    try {
      await finishLaneModesAndAdvance();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Box component="section" aria-labelledby="setup-wizard-heading" sx={{ maxWidth: 680 }}>
      <Typography id="setup-wizard-heading" variant="h6" gutterBottom>
        {t("setup.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("setup.intro")}
      </Typography>

      <Stepper activeStep={activeStep} orientation="vertical">
        {/* Step 1 — Your organization */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.organization] = el; }}>
          <StepLabel>{t("setup.step.organization")}</StepLabel>
          <StepContent>
            <OrgIdentityFields state={draft} />
            <Box sx={{ mt: 2 }}>
              <Button
                variant="contained"
                disabled={!draft.draft || !draft.resourceLang}
                onClick={() => setActiveStep(SETUP_STEPS.sources)}
              >
                {t("setup.next")}
              </Button>
            </Box>
          </StepContent>
        </Step>

        {/* Step 2 — Sources (pull FROM) */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.sources] = el; }}>
          <StepLabel>{t("setup.step.sources")}</StepLabel>
          <StepContent>
            <UpstreamSourcePicker state={draft} />
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button onClick={() => setActiveStep(SETUP_STEPS.organization)}>{t("setup.back")}</Button>
              <Button
                variant="contained"
                disabled={!draft.upstreamVerified || draft.hasUnverifiedOverride}
                onClick={() => setActiveStep(SETUP_STEPS.lanes)}
              >
                {t("setup.next")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 3 — Your scripture lanes: target + edit/align */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.lanes] = el; }}>
          <StepLabel>{t("setup.step.lanes")}</StepLabel>
          <StepContent>
            <LaneTargetModeStep state={draft} laneMode={laneMode} setLaneMode={setLaneMode} />
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button onClick={() => setActiveStep(SETUP_STEPS.sources)}>{t("setup.back")}</Button>
              <Button
                variant="contained"
                disabled={!draft.repos.lit?.trim() || !draft.repos.sim?.trim()}
                onClick={() => setActiveStep(SETUP_STEPS.review)}
              >
                {t("setup.next")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 4 — Review & apply */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.review] = el; }}>
          <StepLabel>{t("setup.step.review")}</StepLabel>
          <StepContent>
            <ReviewSummary state={draft} laneMode={laneMode} />
            {!draft.complete && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {t("setup.reviewIncomplete")}
              </Alert>
            )}
            {!draft.upstreamVerified && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {t("setup.upstreamOrgUnverified")}
              </Alert>
            )}
            {draft.hasUnverifiedOverride && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {t("setup.unverifiedOverride", {
                  resources: draft.unverifiedOverrideResources
                    .map((r) => t(`setup.resource.${r}`))
                    .join(", "),
                })}
              </Alert>
            )}
            {applyError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {applyError}
              </Alert>
            )}
            {laneModeError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {laneModeError}
              </Alert>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button
                onClick={() => setActiveStep(SETUP_STEPS.lanes)}
                disabled={applying || applied}
              >
                {t("setup.back")}
              </Button>
              {applied && laneModeError ? (
                // Overrides already persisted; re-applying would 409. Only the
                // failed lane-mode patch needs retrying.
                <Button
                  variant="contained"
                  onClick={retryLaneModes}
                  disabled={applying}
                  startIcon={applying ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {applying ? t("setup.applying") : t("setup.retryLaneMode")}
                </Button>
              ) : (
                <Button
                  variant="contained"
                  onClick={doApply}
                  disabled={
                    applying ||
                    applied ||
                    !draft.complete ||
                    !draft.upstreamVerified ||
                    draft.hasUnverifiedOverride
                  }
                  startIcon={applying ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {applying ? t("setup.applying") : t("setup.applyButton")}
                </Button>
              )}
            </Stack>
          </StepContent>
        </Step>

        {/* Step 4b — Finish changing the scripture source (conditional — only on
            a source migration for an already-populated project) */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.replacement] = el; }}>
          <StepLabel>{t("setup.step.replacement")}</StepLabel>
          <StepContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {t("setup.replacementStepIntro")}
            </Typography>
            {lanesToReplace.length === 0 ? (
              <Alert severity="success" variant="outlined">
                {t("setup.replacementNone")}
              </Alert>
            ) : (
              <Stack spacing={2}>
                {/* Drive by the CAPTURED set (not the live quarantine list): a lane
                    leaves `laneState.replacementRequired` the moment it activates,
                    but its driver must stay mounted to confirm the edit/align mode
                    before the lane counts as done. */}
                {lanesToReplace.map((lane) => {
                  const ls = projectConfig?.laneState?.[lane];
                  if (!ls) return null;
                  const label = lane === "lit" ? draft.repos.lit || "ULT" : draft.repos.sim || "UST";
                  return (
                    <LaneReplacementDriver
                      key={lane}
                      lane={lane}
                      label={label}
                      laneState={ls}
                      desiredMode={laneMode[lane]}
                      onComplete={() => markLaneDone(lane)}
                    />
                  );
                })}
              </Stack>
            )}
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
              <Button
                variant="contained"
                onClick={() => setActiveStep(SETUP_STEPS.done)}
                disabled={!replacementContinueEnabled(lanesToReplace, laneDone)}
              >
                {t("setup.replacementContinue")}
              </Button>
              {!replacementContinueEnabled(lanesToReplace, laneDone) && (
                <Typography variant="caption" color="text.secondary">
                  {t("setup.replacementContinueBlocked")}
                </Typography>
              )}
            </Stack>
          </StepContent>
        </Step>

        {/* Step 5 — Configured */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.done] = el; }}>
          <StepLabel>{t("setup.step.done")}</StepLabel>
          <StepContent>
            <Typography variant="subtitle1" gutterBottom>
              {t("setup.doneTitle")}
            </Typography>
            <Typography variant="body2" sx={{ mb: 2 }}>
              {t("setup.doneConfigured", { org: draft.draft?.org ?? "" })}
            </Typography>
            <Button
              variant="contained"
              onClick={() => {
                // Import & translation happen in the editor / the forthcoming
                // Import surface — a follow-up will repoint this at #/import.
                location.hash = "#/";
              }}
            >
              {t("setup.goToEditor")}
            </Button>
          </StepContent>
        </Step>
      </Stepper>
    </Box>
  );
}

// Step 4 — a two-column FROM (source/upstream) vs TO (your org) summary, built
// from the same draft the Apply button materializes. The FROM column reads the
// assembled translationSource (per-resource, with per-resource org); the TO
// column reads the org's own target repos.
function ReviewSummary({
  state,
  laneMode,
}: {
  state: ReturnType<typeof useOrgDraft>;
  laneMode: LaneModeMap;
}) {
  const { t } = useTranslation();
  const targetOrg = state.draft?.org ?? "";
  const source = useMemo(
    () =>
      buildTranslationSource({
        upstreamOrg: state.upstreamOrg,
        languageCode: state.upstreamLanguageCode,
        upstreamRepos: state.upstreamRepos,
        resourceSource: state.resourceSource,
      }),
    [state.upstreamOrg, state.upstreamLanguageCode, state.upstreamRepos, state.resourceSource],
  );

  const sourceRefFor = (key: ResourceKey): { org: string; repo: string } | null => {
    const v = source?.repos?.[key];
    if (!v) return null;
    if (typeof v === "string") return { org: source.org, repo: v };
    return { org: v.org, repo: v.repo };
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {t("setup.reviewIntro", {
          lang: state.resourceLang?.languageName ?? "",
          org: targetOrg,
        })}
      </Typography>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        {/* FROM */}
        <Box sx={{ flex: 1, border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
          <Typography variant="overline" color="text.secondary">
            {t("setup.reviewFrom")}
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(80px, max-content) 1fr",
              columnGap: 1,
              rowGap: 0.5,
              alignItems: "baseline",
              mt: 0.5,
            }}
          >
            {RESOURCE_KEYS.map((key) => {
              const ref = sourceRefFor(key);
              return (
                <Box key={key} sx={{ display: "contents" }}>
                  <Typography variant="caption" sx={{ color: "text.secondary", textAlign: "start" }}>
                    {t(`setup.resource.${key}`)}
                  </Typography>
                  {ref ? (
                    <RepoRef org={ref.org} repo={ref.repo} />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {t("setup.upstreamNone")}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
        {/* TO */}
        <Box sx={{ flex: 1, border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
          <Typography variant="overline" color="text.secondary">
            {t("setup.reviewTo", { org: targetOrg })}
          </Typography>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(80px, max-content) 1fr",
              columnGap: 1,
              rowGap: 0.5,
              alignItems: "baseline",
              mt: 0.5,
            }}
          >
            {RESOURCE_KEYS.map((key) => {
              const repo = state.repos[key];
              const isLane = key === "lit" || key === "sim";
              return (
                <Box key={key} sx={{ display: "contents" }}>
                  <Typography variant="caption" sx={{ color: "text.secondary", textAlign: "start" }}>
                    {t(`setup.resource.${key}`)}
                  </Typography>
                  <Box sx={{ minWidth: 0 }}>
                    {repo ? (
                      <RepoRef org={targetOrg} repo={repo} />
                    ) : (
                      <Typography variant="body2" component="span" color="warning.main">
                        {t("setup.reviewMissing")}
                      </Typography>
                    )}
                    {isLane && repo && (
                      <Typography variant="caption" component="span" color="text.secondary">
                        {" · "}
                        {t(`setup.laneEditMode.${laneMode[key as "lit" | "sim"]}`)}
                      </Typography>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Stack>
    </Stack>
  );
}
