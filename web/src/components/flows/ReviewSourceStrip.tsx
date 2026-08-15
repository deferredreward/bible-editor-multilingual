// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// The original-language quote strip, after .greek-strip / .quote-chip in
// docs/flows/ui/t2-review.html — a region of its own above the note body, not
// a line of the note.
//
// Direction is driven by which original-language lane the chapter actually
// carries (UHB → Hebrew, RTL; UGNT → Greek, LTR), and the text renders in
// SCRIPTURE_FONT_STACK. Per the RTL lesson we set the `dir` attribute and use
// `text-align: start` — never a hard-coded left/right or an sx `direction`,
// which stylis inverts under an RTL UI.

import type { Ref } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface ReviewSourceStripProps {
  /** "Hebrew" or "Greek" — derived from the chapter's loaded source lane. */
  label: string;
  dir: "ltr" | "rtl";
  quote: string | null;
  occurrence: number | null;
  supportReference: string | null;
  /** Absent when there is no source verse to build a quote from. */
  onBuildFromSource?: () => void;
  buildDisabledReason?: string;
  buildButtonRef?: Ref<HTMLButtonElement>;
}

export function ReviewSourceStrip({
  label,
  dir,
  quote,
  occurrence,
  supportReference,
  onBuildFromSource,
  buildDisabledReason,
  buildButtonRef,
}: ReviewSourceStripProps) {
  return (
    <Box sx={{ mb: 1.5, textAlign: "start" }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1.25, flexWrap: "wrap" }}>
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{
            flex: "none",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            m: 0,
          }}
        >
          {label}
        </Typography>
        {quote ? (
          <Box
            component="p"
            dir={dir}
            sx={{
              m: 0,
              fontFamily: SCRIPTURE_FONT_STACK,
              fontSize: "1.05rem",
              bgcolor: "action.hover",
              borderRadius: 1,
              paddingInline: 1,
              paddingBlock: 0.25,
              textAlign: "start",
            }}
          >
            {quote}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No {label} quote on this note.
          </Typography>
        )}
        {occurrence != null && occurrence !== 1 && (
          <Typography variant="caption" color="text.secondary">
            occurrence {occurrence}
          </Typography>
        )}
        <Tooltip title={buildDisabledReason ?? ""}>
          <span style={{ marginInlineStart: "auto" }}>
            <Button
              ref={buildButtonRef}
              size="small"
              variant="outlined"
              onClick={onBuildFromSource}
              disabled={!onBuildFromSource}
              sx={{ borderStyle: "dashed", minHeight: 44 }}
            >
              Build from source
            </Button>
          </span>
        </Tooltip>
      </Box>
      {supportReference && (
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{ fontWeight: 700, mt: 0.75 }}
        >
          {supportReference}
        </Typography>
      )}
    </Box>
  );
}
