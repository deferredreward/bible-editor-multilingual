import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError, importedSourceRepos } from "../sync/api";
import {
  applyProjectOverrides,
  isTranslationProject,
  refreshProjectConfig,
  useProjectConfig,
} from "../hooks/useProjectConfig";
import { BOOKS, bookName } from "../lib/bookNames";
import { useOrgDraft } from "./OrgConfigDraftEditor";
import { OrgIdentityFields } from "./OrgIdentityFields";
import { UpstreamSourcePicker } from "./UpstreamSourcePicker";
import { LaneTargetModeStep, type LaneEditMode, type LaneModeMap } from "./LaneTargetModeStep";
import { LaneReplacementDriver } from "./LaneReplacementDriver";
import { RepoRef } from "./SourceOverrideField";
import { RESOURCE_KEYS, buildTranslationSource, type ResourceKey } from "../lib/orgDraft";
import { SETUP_STEPS, lanesNeedingReplacement, stepAfterApply, importErrorLane } from "../lib/setupWizard";

// Safety cap on the populate loop — each call drains up to ~150 fetches, so this
// covers even the largest book many times over without risking a hung tab.
const POPULATE_MAX_ROUNDS = 60;

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

// Admin-only guided onboarding for an org (owner-confirmed flow): confirm the
// org + resource language, choose the upstream sources to pull FROM, set the
// org's own target repos + edit/align per lane, apply, finish any lane text
// replacement, then import a first book.
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

  // Scroll the newly-active step to the top of the viewport on change, so the
  // admin lands on the step header rather than below it (item 10).
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    stepRefs.current[activeStep]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeStep]);

  // Step 5 — import + populate.
  const [book, setBook] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; remaining: number } | null>(null);
  const [populateNote, setPopulateNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [importedBook, setImportedBook] = useState<string | null>(null);
  const [translateFromSource, setTranslateFromSource] = useState(false);
  const [sourceNote, setSourceNote] = useState<string | null>(null);

  const canTranslateFromSource = isTranslationProject(projectConfig);
  const bookOptions = useMemo(() => BOOKS.map((b) => b.code), []);
  const quarantinedLanes = lanesNeedingReplacement(projectConfig?.laneState);

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
    setActiveStep(stepAfterApply(cfg?.laneState));
  };

  const doApply = async () => {
    if (!draft.complete || !draft.upstreamVerified) return;
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

  const doImport = async () => {
    if (!book) return;
    setImporting(true);
    setImportError(null);
    setPopulateNote(null);
    setProgress(null);
    setWarnings(0);
    setSourceNote(null);
    try {
      const res = await api.importBook(
        book,
        translateFromSource ? { translateFromSource: true } : undefined,
      );
      const usedSources = importedSourceRepos(res.sources);
      if (usedSources.length > 0) {
        setSourceNote(t("setup.importedFromSource", { repos: usedSources.join(", ") }));
      }
      let totalProcessed = 0;
      let totalWarnings = 0;
      let settled = false;
      for (let round = 0; round < POPULATE_MAX_ROUNDS; round++) {
        const r = await api.populateArticles({ book });
        totalProcessed += r.processed;
        totalWarnings += r.warnings.length;
        setProgress({ processed: totalProcessed, remaining: r.remaining });
        setWarnings(totalWarnings);
        if (r.skipped) {
          setPopulateNote(t("setup.populateSkipped"));
          settled = true;
          break;
        }
        if (r.aborted) {
          setPopulateNote(t("setup.populateAborted"));
          settled = true;
          break;
        }
        if (r.remaining === 0) {
          settled = true;
          break;
        }
      }
      if (!settled) setPopulateNote(t("setup.populateIncomplete"));
      setImportedBook(book);
      setActiveStep(SETUP_STEPS.done);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; message?: string } | undefined;
        // A lane frozen for replacement blocks import — route to the in-wizard
        // replacement driver instead of showing a dead-end generic error.
        const lane = importErrorLane(body);
        if (lane) {
          await refreshProjectConfig().catch(() => {});
          setImportError(null);
          setActiveStep(SETUP_STEPS.replacement);
          return;
        }
        const code = body?.error;
        setImportError(
          code === "unknown_book"
            ? t("setup.unknownBook")
            : code === "in_progress"
              ? t("setup.importInProgress")
              : t("setup.importFailed"),
        );
      } else {
        setImportError(t("setup.importFailed"));
      }
    } finally {
      setImporting(false);
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
                disabled={!draft.upstreamVerified}
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
                  disabled={applying || applied || !draft.complete || !draft.upstreamVerified}
                  startIcon={applying ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {applying ? t("setup.applying") : t("setup.applyButton")}
                </Button>
              )}
            </Stack>
          </StepContent>
        </Step>

        {/* Step 4b — Finish replacing a lane's text (conditional) */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.replacement] = el; }}>
          <StepLabel>{t("setup.step.replacement")}</StepLabel>
          <StepContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {t("setup.replacementStepIntro")}
            </Typography>
            {quarantinedLanes.length === 0 ? (
              <Alert severity="success" variant="outlined">
                {t("setup.replacementNone")}
              </Alert>
            ) : (
              <Stack spacing={2}>
                {quarantinedLanes.map((lane) => {
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
                    />
                  );
                })}
              </Stack>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button
                variant="contained"
                onClick={() => setActiveStep(SETUP_STEPS.importBook)}
                disabled={quarantinedLanes.length > 0}
              >
                {t("setup.continueToImport")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 5 — Import first book */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.importBook] = el; }}>
          <StepLabel>{t("setup.step.importBook")}</StepLabel>
          <StepContent>
            <Typography variant="body2" sx={{ mb: 1.5 }}>
              {t("setup.importIntro")}
            </Typography>
            <Autocomplete
              size="small"
              options={bookOptions}
              value={book}
              onChange={(_, v) => setBook(v)}
              getOptionLabel={(code) => `${bookName(code)} (${code})`}
              disabled={importing}
              sx={{ maxWidth: 320 }}
              renderInput={(params) => <TextField {...params} label={t("setup.bookLabel")} />}
            />
            {canTranslateFromSource && (
              <Box sx={{ mt: 1.5 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={translateFromSource}
                      onChange={(e) => setTranslateFromSource(e.target.checked)}
                      disabled={importing}
                    />
                  }
                  label={t("setup.translateFromSource")}
                />
                <Typography variant="caption" color="text.secondary" component="p" sx={{ ml: 4 }}>
                  {t("setup.translateFromSourceHelp")}
                </Typography>
              </Box>
            )}
            {importing && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
                <CircularProgress size={16} />
                <Typography variant="body2">
                  {progress
                    ? t("setup.populating", { processed: progress.processed, remaining: progress.remaining })
                    : t("setup.importing")}
                </Typography>
              </Stack>
            )}
            {importError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {importError}
              </Alert>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button variant="contained" onClick={doImport} disabled={importing || !book}>
                {t("setup.importButton")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 6 — done */}
        <Step ref={(el) => { stepRefs.current[SETUP_STEPS.done] = el; }}>
          <StepLabel>{t("setup.step.done")}</StepLabel>
          <StepContent>
            <Typography variant="subtitle1" gutterBottom>
              {t("setup.doneTitle")}
            </Typography>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("setup.doneSummary", {
                org: draft.draft?.org ?? importedBook ?? "",
                book: importedBook ? bookName(importedBook) : "",
                processed: progress?.processed ?? 0,
              })}
            </Typography>
            {sourceNote && (
              <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
                {sourceNote}
              </Alert>
            )}
            {warnings > 0 && (
              <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
                {t("setup.populateWarnings", { count: warnings })}
              </Alert>
            )}
            {populateNote && (
              <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
                {populateNote}
              </Alert>
            )}
            <Button
              variant="contained"
              onClick={() => {
                location.hash = "#/";
              }}
            >
              {t("setup.goToScripture")}
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
