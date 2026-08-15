// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Status chip shared by the flow screens. Mirrors the .chip-* rules in
// docs/flows/ui/_tokens.css: pill radius, soft ground, ink text, ~0.75rem
// semibold. Semantic colors come from theme.palette.flows (D4) — never
// success/warning.

import Chip, { type ChipProps } from "@mui/material/Chip";
import { useTheme } from "@mui/material/styles";

export type FlowStatusKind =
  | "draft"
  | "approved"
  | "edited"
  | "trashed"
  | "ok"
  | "warn"
  | "skip";

export interface FlowStatusChipProps {
  kind: FlowStatusKind;
  /** Overrides the default English label for this kind. */
  label?: string;
  size?: ChipProps["size"];
}

const DEFAULT_LABELS: Record<FlowStatusKind, string> = {
  draft: "Draft",
  approved: "Approved",
  edited: "Edited",
  trashed: "Trashed",
  ok: "OK",
  warn: "Needs attention",
  skip: "Skipped",
};

export function FlowStatusChip({ kind, label, size = "small" }: FlowStatusChipProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const { ok, warn, skip } = theme.palette.flows;

  // .chip-edited is the one chip painted from the brand accent rather than a
  // semantic color: --hl ground with --inspire-deep (light) / --inspire (dark).
  const editedSoft = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const editedInk = dark ? "#31ADE3" : "#1B84B8";

  let background: string;
  let color: string;
  switch (kind) {
    case "approved":
    case "ok":
      background = ok.soft;
      color = ok.ink;
      break;
    case "warn":
      background = warn.soft;
      color = warn.ink;
      break;
    case "edited":
      background = editedSoft;
      color = editedInk;
      break;
    case "draft":
    case "trashed":
    case "skip":
    default:
      background = skip.soft;
      color = skip.ink;
      break;
  }

  return (
    <Chip
      size={size}
      label={label ?? DEFAULT_LABELS[kind]}
      sx={{
        background,
        color,
        borderRadius: 999,
        fontWeight: 600,
        fontSize: "0.75rem",
        height: "auto",
        py: 0.375,
        textAlign: "start",
        "& .MuiChip-label": { paddingInline: 1.25 },
      }}
    />
  );
}
