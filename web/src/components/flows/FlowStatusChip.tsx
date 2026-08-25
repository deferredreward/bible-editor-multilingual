// Status chip shared by the flow screens. Mirrors the .chip-* rules in
// docs/flows/ui/_tokens.css: pill radius, soft ground, ink text, ~0.75rem
// semibold. Semantic colors come from theme.palette.flows (D4) — never
// success/warning.

import Chip, { type ChipProps } from "@mui/material/Chip";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

export type FlowStatusKind =
  | "draft"
  | "aquifer"
  | "approved"
  | "edited"
  | "trashed"
  | "ok"
  | "warn"
  | "skip";

export interface FlowStatusChipProps {
  kind: FlowStatusKind;
  /** Overrides the default label for this kind. */
  label?: string;
  size?: ChipProps["size"];
}

// Default label keys per kind — translated at render.
const DEFAULT_LABEL_KEYS: Record<FlowStatusKind, string> = {
  draft: "flowTranslate.status.draft",
  aquifer: "flowTranslate.status.aquiferImport",
  approved: "flowTranslate.status.approved",
  edited: "flowTranslate.status.edited",
  trashed: "flowTranslate.status.trashed",
  ok: "flowTranslate.status.ok",
  warn: "flowTranslate.status.needsAttention",
  skip: "flowTranslate.status.skipped",
};

export function FlowStatusChip({ kind, label, size = "small" }: FlowStatusChipProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const dark = theme.palette.mode === "dark";
  const { ok, warn, skip } = theme.palette.flows;

  // .chip-edited is the one chip painted from the brand accent rather than a
  // semantic color: --hl ground with --inspire-deep (light) / --inspire (dark).
  const editedSoft = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const editedInk = dark ? "#31ADE3" : "#1B84B8";

  // Aquifer provenance — the classic NoteCard badge (#70C9CC). A distinct hue so
  // it reads as "where this came from", not as a quality/state signal; the light
  // ink is darkened for contrast on the soft ground, mirroring the edited case.
  const aquiferSoft = dark ? "rgba(112, 201, 204, 0.26)" : "rgba(112, 201, 204, 0.18)";
  const aquiferInk = dark ? "#70C9CC" : "#2C8285";

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
    case "aquifer":
      background = aquiferSoft;
      color = aquiferInk;
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
      label={label ?? t(DEFAULT_LABEL_KEYS[kind])}
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
