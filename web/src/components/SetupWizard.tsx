import { useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Link,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useTranslation } from "react-i18next";
import { api, ApiError, importedSourceRepos } from "../sync/api";
import {
  applyProjectOverrides,
  isTranslationProject,
  refreshProjectConfig,
  useProjectConfig,
} from "../hooks/useProjectConfig";
import { BOOKS, bookName } from "../lib/bookNames";
import { useOrgDraft, OrgDraftFields, LaneRepoFields } from "./OrgConfigDraftEditor";

// gatewayAdmin has no confirmed public URL recorded in this repo; link to the
// Door43 Content Service host (verifiable) and name gatewayAdmin in the copy.
// Kept as a constant so it's a one-line change if the real URL is confirmed.
const GATEWAY_ADMIN_URL = "https://git.door43.org";

// Safety cap on the populate loop — each call drains up to ~150 fetches, so this
// covers even the largest book many times over without risking a hung tab.
const POPULATE_MAX_ROUNDS = 60;

// Admin-only guided onboarding for a brand-new org: point the editor at the org's
// Door43 repos (custom-gl), then import a first book and fill its tW/tA areas.
// Pure UI orchestration over routes PR A/B already expose.
export function SetupWizard() {
  const { t } = useTranslation();
  const draft = useOrgDraft();
  const [activeStep, setActiveStep] = useState(0);

  // Step 4 — apply.
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Step 5 — import + populate.
  const [book, setBook] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; remaining: number } | null>(null);
  const [populateNote, setPopulateNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [importedBook, setImportedBook] = useState<string | null>(null);
  // Opt-in: pull tN/tQ from the project's English source repos rather than the
  // org's own (stale machine-translated notes whose row ids no longer match).
  const [translateFromSource, setTranslateFromSource] = useState(false);
  const [sourceNote, setSourceNote] = useState<string | null>(null);

  const projectConfig = useProjectConfig();
  const canTranslateFromSource = isTranslationProject(projectConfig);

  const bookOptions = useMemo(() => BOOKS.map((b) => b.code), []);

  const doApply = async () => {
    if (!draft.complete) return;
    setApplying(true);
    setApplyError(null);
    try {
      await applyProjectOverrides("custom-gl", draft.buildOverrides());
      await refreshProjectConfig().catch(() => {});
      setActiveStep(4);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const code = (e.body as { error?: string } | undefined)?.error;
        setApplyError(
          code === "project_not_empty"
            ? t("setup.projectNotEmpty")
            : t("setup.laneBusy"),
        );
      } else {
        setApplyError(t("setup.applyFailed"));
      }
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
      // Non-null entries mean tN/tQ came from the English source — either
      // because the box was ticked, or because the org's own file was missing
      // and the server fell back on its own.
      const usedSources = importedSourceRepos(res.sources);
      if (usedSources.length > 0) {
        setSourceNote(t("setup.importedFromSource", { repos: usedSources.join(", ") }));
      }
      // Drain the article-population queue for this book: each call processes one
      // bounded chunk and reports how many refs remain. Loop until remaining is 0
      // (or the driver skips/aborts).
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
      // Backstop hit with work still queued — surface it rather than reporting a
      // clean finish. The user can re-run population from the articles workspace.
      if (!settled) setPopulateNote(t("setup.populateIncomplete"));
      setImportedBook(book);
      setActiveStep(5);
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string } | undefined)?.error;
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
    <Box component="section" aria-labelledby="setup-wizard-heading" sx={{ maxWidth: 640 }}>
      <Typography id="setup-wizard-heading" variant="h6" gutterBottom>
        {t("setup.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("setup.intro")}
      </Typography>

      <Stepper activeStep={activeStep} orientation="vertical">
        {/* Step 1 — gatewayAdmin */}
        <Step>
          <StepLabel>{t("setup.step.gatewayAdmin")}</StepLabel>
          <StepContent>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("setup.gatewayAdminIntro")}
            </Typography>
            <Typography variant="body2" component="pre" sx={{ whiteSpace: "pre-wrap", mb: 1 }}>
              {t("setup.gatewayAdminChecklist")}
            </Typography>
            <Link href={GATEWAY_ADMIN_URL} target="_blank" rel="noopener noreferrer">
              {t("setup.gatewayAdminLink")} <OpenInNewIcon fontSize="inherit" sx={{ verticalAlign: "middle" }} />
            </Link>
            <Box sx={{ mt: 2 }}>
              <Button variant="contained" onClick={() => setActiveStep(1)}>
                {t("setup.reposReady")}
              </Button>
            </Box>
          </StepContent>
        </Step>

        {/* Step 2 — detect org */}
        <Step>
          <StepLabel>{t("setup.step.detectOrg")}</StepLabel>
          <StepContent>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("setup.detectIntro")}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                placeholder="BibleEditorMLTest"
                value={draft.org}
                onChange={(e) => draft.setOrg(e.target.value)}
                disabled={draft.loading}
              />
              <Button
                size="small"
                variant="outlined"
                onClick={draft.detect}
                disabled={draft.loading || !draft.org.trim()}
              >
                {draft.loading ? <CircularProgress size={16} /> : t("preferences.detectOrg.button")}
              </Button>
            </Stack>
            {draft.detectError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {draft.detectError}
              </Alert>
            )}
            {draft.draft && (
              <Box sx={{ mt: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
                <OrgDraftFields state={draft} />
              </Box>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button onClick={() => setActiveStep(0)}>{t("setup.back")}</Button>
              <Button variant="contained" disabled={!draft.complete} onClick={() => setActiveStep(2)}>
                {t("setup.next")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 3 — confirm literal/simplified */}
        <Step>
          <StepLabel>{t("setup.step.confirmLanes")}</StepLabel>
          <StepContent>
            <Typography variant="body2" sx={{ mb: 1.5 }}>
              {t("setup.confirmLanesIntro")}
            </Typography>
            <LaneRepoFields state={draft} />
            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button onClick={() => setActiveStep(1)}>{t("setup.back")}</Button>
              <Button
                variant="contained"
                disabled={!draft.repos.lit?.trim() || !draft.repos.sim?.trim()}
                onClick={() => setActiveStep(3)}
              >
                {t("setup.next")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 4 — apply */}
        <Step>
          <StepLabel>{t("setup.step.apply")}</StepLabel>
          <StepContent>
            <Typography variant="body2" sx={{ mb: 1.5 }}>
              {t("setup.applyIntro", { org: draft.draft?.org ?? "" })}
            </Typography>
            {applyError && (
              <Alert severity="error" sx={{ mb: 1.5 }}>
                {applyError}
              </Alert>
            )}
            <Stack direction="row" spacing={1}>
              <Button onClick={() => setActiveStep(2)} disabled={applying}>
                {t("setup.back")}
              </Button>
              <Button
                variant="contained"
                onClick={doApply}
                disabled={applying || !draft.complete}
                startIcon={applying ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {applying ? t("setup.applying") : t("setup.applyButton")}
              </Button>
            </Stack>
          </StepContent>
        </Step>

        {/* Step 5 — import first book */}
        <Step>
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
        <Step>
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
