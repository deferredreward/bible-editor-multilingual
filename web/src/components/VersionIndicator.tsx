// Top-bar build stamp + "you're running stale code" nudge. Idle, it's a quiet
// `v <sha>` chip so anyone can confirm at a glance which build a translator is
// on ("are you on the latest prod?"). Once a newer build is deployed, the open
// tab notices (see useAppVersion) and the chip becomes a clickable
// "Update available — refresh" in the Kindle warning accent — so people don't
// have to compare numbers, the app tells them to reload.

import { Chip, Stack, Tooltip, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useTranslation } from "react-i18next";
import { useAppVersion } from "../hooks/useAppVersion";

// Kindle warning accent (#E59D33 from CLAUDE.md brand palette), matching the
// transient-state chips in SyncStatusBar.
const updateAccentSx = {
  color: "#E59D33",
  borderColor: "#E59D33",
  "& .MuiChip-icon": { color: "#E59D33" },
} as const;

function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface Props {
  // Save-aware reload. When there's unsaved in-memory work (alignment drags),
  // Shell flushes it to the durable outbox before reloading so the version-bump
  // refresh can't silently drop it. Falls back to a plain reload when absent.
  onRequestReload?: () => void;
}

export function VersionIndicator({ onRequestReload }: Props = {}) {
  const { t } = useTranslation();
  const { current, updateAvailable } = useAppVersion();

  if (updateAvailable) {
    return (
      <Tooltip title={t("sync.updateAvailableTooltip")}>
        <Chip
          icon={<RefreshIcon />}
          label={t("sync.updateAvailable")}
          size="small"
          variant="outlined"
          clickable
          onClick={onRequestReload ?? (() => window.location.reload())}
          sx={updateAccentSx}
        />
      </Tooltip>
    );
  }

  // Don't show a meaningless "vunknown" stamp (e.g. a build without git info).
  if (current.commit === "unknown") return null;

  const tooltip = (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
        {t("sync.buildSha", { commit: current.commit })}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {formatBuiltAt(current.builtAt)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t("sync.onLatestVersion")}
      </Typography>
    </Stack>
  );

  return (
    <Tooltip title={tooltip}>
      <Typography
        variant="caption"
        component="span"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          opacity: 0.5,
          userSelect: "none",
          cursor: "default",
          "&:hover": { opacity: 0.85 },
        }}
      >
        {current.commit}
      </Typography>
    </Tooltip>
  );
}
