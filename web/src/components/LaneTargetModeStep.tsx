import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import { RepoRef, SourceOverrideField } from "./SourceOverrideField";
import { laneChoiceFromMode, laneUrlChoiceSelection, type LaneUpstreamChoice } from "../lib/setupWizard";

// Editing the text (default) vs aligning only. Both keep alignment writable;
// "align" additionally freezes the text. Applied after Apply via lanePatch.
export type LaneEditMode = "edit" | "align";
export type LaneModeMap = { lit: LaneEditMode; sim: LaneEditMode };

// Content-check status for a lane's target scripture repo (item 4):
//   unknown     → not yet checked (blank repo / initial)
//   checking    → verify in flight
//   has         → repo contains USFM book files (good)
//   empty       → repo exists but has NO book files (scaffolding trap) → BLOCK
//   unreachable → couldn't check (repo lookup/contents blip) → non-blocking retry
export type LaneBooksStatus = "unknown" | "checking" | "has" | "empty" | "unreachable";

const LANES: Array<{ key: "lit" | "sim"; labelKey: string }> = [
  { key: "lit", labelKey: "setup.lane.lit" },
  { key: "sim", labelKey: "setup.lane.sim" },
];

function LaneCard({
  lane,
  labelKey,
  state,
  laneMode,
  setLaneMode,
  onLaneBooks,
}: {
  lane: "lit" | "sim";
  labelKey: string;
  state: OrgDraftState;
  laneMode: LaneEditMode;
  setLaneMode: (m: LaneEditMode) => void;
  onLaneBooks: (status: LaneBooksStatus) => void;
}) {
  const { t } = useTranslation();
  const sel = state.resourceSource[lane] ?? { mode: "upstream" };
  const upstreamChoice: LaneUpstreamChoice = laneChoiceFromMode(sel.mode);
  const targetRepo = state.repos[lane] ?? "";
  const upstreamRepo = state.upstreamRepos[lane];
  const org = state.draft?.org ?? "";

  // Content check for the target scripture repo: it must contain book files, not
  // just exist (an empty scaffolding-only repo is a trap). Runs on the resolved
  // org/repo; "empty" blocks Apply, "unreachable" is a non-blocking retry.
  const [booksStatus, setBooksStatus] = useState<LaneBooksStatus>("unknown");
  const reportBooks = (s: LaneBooksStatus) => {
    setBooksStatus(s);
    onLaneBooks(s);
  };
  const checkSeq = useRef(0);
  const checkBooks = async () => {
    const repo = targetRepo.trim();
    if (!org || !repo) {
      reportBooks("unknown");
      return;
    }
    const seq = ++checkSeq.current;
    setBooksStatus("checking");
    try {
      const res = await api.verifySource(`${org}/${repo}`, { checkBooks: true });
      if (seq !== checkSeq.current) return; // superseded by a newer edit
      // hasBooks omitted = contents lookup couldn't run → treat as unreachable.
      reportBooks(res.hasBooks === undefined ? "unreachable" : res.hasBooks ? "has" : "empty");
    } catch {
      if (seq !== checkSeq.current) return;
      // Repo lookup itself failed (missing/invalid/transient) — non-blocking.
      reportBooks("unreachable");
    }
  };

  // Auto-check once when a pre-filled repo is present on mount.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!autoChecked.current && org && targetRepo.trim()) {
      autoChecked.current = true;
      void checkBooks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, targetRepo]);

  const onUpstreamChoice = (choice: LaneUpstreamChoice) => {
    if (choice === "unfoldingWord") state.setResourceSource(lane, { mode: "upstream" });
    else if (choice === "none") state.setResourceSource(lane, { mode: "blank" });
    else if (choice === "url" && sel.mode !== "override") {
      // Mark it override-pending (empty repo) so the choice reads as 'url' and
      // the SourceOverrideField renders; buildTranslationSource skips an empty
      // override, so nothing is committed until a URL verifies.
      state.setResourceSource(lane, laneUrlChoiceSelection());
    }
  };

  // Resolved FROM (upstream) for the inline hint.
  const fromLabel =
    upstreamChoice === "none"
      ? t("setup.upstreamNone")
      : upstreamChoice === "url" && sel.mode === "override" && sel.repo
        ? `${sel.org ?? state.upstreamOrg}/${sel.repo}`
        : upstreamChoice === "url"
          ? t("setup.upstreamPending")
          : `${state.upstreamOrg}/${upstreamRepo ?? ""}`;

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {t(labelKey)}
        </Typography>

        <TextField
          size="small"
          sx={{ maxWidth: 360 }}
          label={t("setup.targetRepoLabel")}
          value={targetRepo}
          onChange={(e) => state.setRepo(lane, e.target.value)}
          onBlur={() => void checkBooks()}
          helperText={t("setup.targetRepoHelp")}
          placeholder={lane === "lit" ? "ru_rlob" : "es-419_gst"}
          InputProps={{
            endAdornment: booksStatus === "checking" ? <CircularProgress size={16} /> : undefined,
          }}
        />
        {booksStatus === "empty" && (
          <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
            {t("setup.laneSourceEmptyInline", { repo: `${org}/${targetRepo}` })}
          </Alert>
        )}
        {booksStatus === "unreachable" && (
          <Alert
            severity="info"
            variant="outlined"
            sx={{ py: 0 }}
            action={
              <Button color="inherit" size="small" onClick={() => void checkBooks()}>
                {t("setup.upstreamOrgRetry")}
              </Button>
            }
          >
            {t("setup.laneSourceCheckUnreachable")}
          </Alert>
        )}

        <Box>
          <Typography variant="caption" color="text.secondary" component="p">
            {t("setup.laneEditModeLabel")}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={laneMode}
            onChange={(_e, v) => v && setLaneMode(v)}
          >
            <ToggleButton value="edit">{t("setup.laneEditMode.edit")}</ToggleButton>
            <ToggleButton value="align">{t("setup.laneEditMode.align")}</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" component="p">
            {t("setup.laneUpstreamLabel")}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={upstreamChoice}
            onChange={(_e, v) => v && onUpstreamChoice(v)}
          >
            <ToggleButton value="unfoldingWord">{t("setup.laneUpstream.unfoldingWord")}</ToggleButton>
            <ToggleButton value="url">{t("setup.laneUpstream.url")}</ToggleButton>
            <ToggleButton value="none">{t("setup.laneUpstream.none")}</ToggleButton>
          </ToggleButtonGroup>
          {upstreamChoice === "url" && <SourceOverrideField resource={lane} state={state} />}
        </Box>

        <Typography variant="body2" color="text.secondary">
          {t("setup.laneFromTo")}{" "}
          <Box component="span" sx={{ fontWeight: 600 }}>
            {fromLabel}
          </Box>{" "}
          →{" "}
          <RepoRef org={state.draft?.org ?? state.upstreamOrg} repo={targetRepo || "—"} />
        </Typography>
      </Stack>
    </Box>
  );
}

// Step 3 — "Your scripture lanes: target + edit/align". For each lane: the org's
// OWN target repo (pre-filled from inference, EDITABLE — never assume {lang}_glt;
// Russian's ru_rlob and BSOJ's AVD/NAV prove this), the edit-vs-align choice, and
// the per-lane upstream (unfoldingWord / a URL / None), which reuses the Step-2
// resourceSource entry for the lit/sim role so the two stay consistent.
export function LaneTargetModeStep({
  state,
  laneMode,
  setLaneMode,
  onLaneBooks,
}: {
  state: OrgDraftState;
  laneMode: LaneModeMap;
  setLaneMode: (lane: "lit" | "sim", m: LaneEditMode) => void;
  // Reports each lane's target-repo book-content status up so Apply can block on "empty".
  onLaneBooks: (lane: "lit" | "sim", status: LaneBooksStatus) => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        {t("setup.lanesIntro")}
      </Typography>
      {LANES.map(({ key, labelKey }) => (
        <LaneCard
          key={key}
          lane={key}
          labelKey={labelKey}
          state={state}
          laneMode={laneMode[key]}
          setLaneMode={(m) => setLaneMode(key, m)}
          onLaneBooks={(s) => onLaneBooks(key, s)}
        />
      ))}
    </Stack>
  );
}
