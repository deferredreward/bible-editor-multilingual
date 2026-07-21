import {
  Box,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import { RepoRef, SourceOverrideField } from "./SourceOverrideField";
import { laneChoiceFromMode, type LaneUpstreamChoice } from "../lib/setupWizard";

// Editing the text (default) vs aligning only. Both keep alignment writable;
// "align" additionally freezes the text. Applied after Apply via lanePatch.
export type LaneEditMode = "edit" | "align";
export type LaneModeMap = { lit: LaneEditMode; sim: LaneEditMode };

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
}: {
  lane: "lit" | "sim";
  labelKey: string;
  state: OrgDraftState;
  laneMode: LaneEditMode;
  setLaneMode: (m: LaneEditMode) => void;
}) {
  const { t } = useTranslation();
  const sel = state.resourceSource[lane] ?? { mode: "upstream" };
  const upstreamChoice: LaneUpstreamChoice = laneChoiceFromMode(sel.mode);
  const targetRepo = state.repos[lane] ?? "";
  const upstreamRepo = state.upstreamRepos[lane];

  const onUpstreamChoice = (choice: LaneUpstreamChoice) => {
    if (choice === "unfoldingWord") state.setResourceSource(lane, { mode: "upstream" });
    else if (choice === "none") state.setResourceSource(lane, { mode: "blank" });
    else if (sel.mode !== "override") state.setResourceSource(lane, { mode: "blank" });
    // 'url' keeps blank until a URL verifies (SourceOverrideField promotes it).
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
          helperText={t("setup.targetRepoHelp")}
          placeholder={lane === "lit" ? "ru_rlob" : "es-419_gst"}
        />

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
}: {
  state: OrgDraftState;
  laneMode: LaneModeMap;
  setLaneMode: (lane: "lit" | "sim", m: LaneEditMode) => void;
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
        />
      ))}
    </Stack>
  );
}
