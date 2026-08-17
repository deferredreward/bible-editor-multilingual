// AdminPageHeader — the eyebrow/h1/subtitle block every AdminDesk page opens
// with. Extracted (issue #186) from four near-identical copies
// (AdminProgressScreen, AdminWorkflowScreen, AdminTeamScreen, AdminSetupScreen)
// and now reused by the four MORE TOOLS pages (AiScreen, StyleScreen,
// CurateScreen, ObserveScreen) too, so all eight AdminDesk pages open with one
// visual pattern instead of four hand-copied variants.
//
// Eyebrow is standardized on `{languageTitle} · {org}` (AdminWorkflowScreen's
// original pattern — Benjamin's call when this file was extracted): callers
// compute that string themselves via `useProjectConfig()` and pass it in as
// `eyebrow`, rather than this component fetching config itself, so a screen
// that already needs `cfg` for other reasons (most of them do) isn't forced
// into a second source of truth. A literal string works too, for the rare
// page with nothing more specific to say.
import type { ReactNode } from "react";
import { Box, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";

const INSPIRE = "#31ADE3";
const INSPIRE_DEEP = "#1B84B8";

export function AdminPageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  const theme = useTheme();
  const accent = theme.palette.mode === "dark" ? INSPIRE : INSPIRE_DEEP;
  return (
    <Box component="header" sx={{ mb: 2 }}>
      <Typography
        variant="caption"
        sx={{
          display: "block",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: accent,
        }}
      >
        {eyebrow}
      </Typography>
      <Typography variant="h5" component="h1" sx={{ mt: 0.25, letterSpacing: "-0.02em" }}>
        {title}
      </Typography>
      {subtitle && (
        <Typography color="text.secondary" sx={{ mt: 0.5, fontSize: "0.875rem", maxWidth: 640 }}>
          {subtitle}
        </Typography>
      )}
    </Box>
  );
}

// Shared helper: the standardized eyebrow string, `{languageTitle} · {org}`,
// falling back to "Workspace" while config hasn't loaded yet. Every AdminDesk
// page computes its eyebrow this way now (issue #186); kept here so the
// fallback text can't drift between the eight call sites.
export function workspaceEyebrow(
  cfg: { languageTitle?: string; languageName?: string; languageCode?: string; org?: string } | null,
): string {
  if (!cfg) return "Workspace";
  const lang = cfg.languageTitle || cfg.languageName || cfg.languageCode || "Workspace";
  return cfg.org ? `${lang} · ${cfg.org}` : lang;
}
