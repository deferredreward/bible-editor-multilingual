import { useMemo, type MouseEvent } from "react";
import { IconButton, Tooltip } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import { verseHasUnalignedWork } from "../lib/alignment";

// The per-verse "align" affordance, shared by all three scripture view modes
// (rows / columns / book). A green chain means every word — Hebrew/Greek source
// and English target — is aligned; a red broken chain (LinkOff) means the verse
// still has at least one unaligned word, so the editor can spot incomplete
// alignment at a glance. Clicking always opens the aligner regardless of state.
export function AlignLinkButton({
  targetContent,
  sourceContent,
  tooltip,
  iconSize = 22,
  sx,
  onClick,
}: {
  // This verse's content_json (the target being aligned: ULT / UST).
  targetContent: unknown;
  // The matching UHB/UGNT verse content_json — needed to tell whether any
  // source word lacks a target. Absent falls back to an English-only check.
  sourceContent?: unknown;
  // Normal-state tooltip; the broken state appends a hint.
  tooltip: string;
  iconSize?: number;
  sx?: SxProps<Theme>;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const broken = useMemo(() => {
    const targetVO = (targetContent as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(targetVO)) return false;
    const sourceVO = (sourceContent as { verseObjects?: unknown[] } | null)?.verseObjects;
    return verseHasUnalignedWork(targetVO, Array.isArray(sourceVO) ? sourceVO : null);
  }, [targetContent, sourceContent]);

  return (
    <Tooltip title={broken ? `${tooltip} — has unaligned words` : tooltip}>
      <IconButton
        size="small"
        onClick={onClick}
        // Caller sx first, then component-owned color so the aligned/broken
        // signal always wins over any incidental color in the passed sx.
        sx={[
          ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
          { color: broken ? "error.main" : "success.main" },
        ] as SxProps<Theme>}
      >
        {broken ? (
          <LinkOffIcon sx={{ fontSize: iconSize }} />
        ) : (
          <LinkIcon sx={{ fontSize: iconSize }} />
        )}
      </IconButton>
    </Tooltip>
  );
}
