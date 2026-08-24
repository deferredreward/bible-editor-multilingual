// "This verse" read-only context for the review queue, after the .ctx-panel /
// .ctx-lane / .ctx-twl blocks in docs/flows/ui/t2-review.html. One component
// serves all three bands: the desktop right-hand column, the tablet
// collapsible section, and the phone bottom sheet — the mockup duplicated the
// same markup into #ctxBodyDesktop and #ctxBodyMobile.
//
// Nothing here is editable. TWL in particular has no approve lifecycle, and
// the mockup says so out loud rather than implying a third queue.

import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { TwlRow } from "../../sync/api";

export interface ReviewContextPanelProps {
  ultText: string | null;
  ustText: string | null;
  /** Word links for the active row's verse only — already filtered by caller. */
  twl: TwlRow[];
  /** Direction of the original-language words shown in the TWL list. */
  sourceDir: "ltr" | "rtl";
}

function Lane({ label, text }: { label: string; text: string | null }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        component="div"
        sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", mb: 0.5 }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          bgcolor: "action.hover",
          borderRadius: 1,
          paddingInline: 1.25,
          paddingBlock: 1,
          fontFamily: SCRIPTURE_FONT_STACK,
          lineHeight: 1.5,
          textAlign: "start",
        }}
      >
        {text ?? (
          <Box component="em" sx={{ color: "text.secondary" }}>
            {t("flowReview.context.noLaneText", { label })}
          </Box>
        )}
      </Typography>
    </Box>
  );
}

export function ReviewContextPanel({ ultText, ustText, twl, sourceDir }: ReviewContextPanelProps) {
  const { t } = useTranslation();
  return (
    <Box sx={{ textAlign: "start" }}>
      <Lane label="ULT" text={ultText} />
      <Lane label="UST" text={ustText} />

      <Box sx={{ mt: 1.75, pt: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}
        >
          {t("flowReview.context.wordLinks")}
        </Typography>
        {twl.length === 0 ? (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
            {t("flowReview.context.noWordLinks")}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: "none", m: 0, mt: 0.75, p: 0 }}>
            {twl.map((w) => (
              <Box
                component="li"
                key={w.id}
                sx={{ display: "flex", justifyContent: "space-between", gap: 1, mb: 0.75 }}
              >
                <Box
                  component="span"
                  dir={sourceDir}
                  sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: "0.9rem", textAlign: "start" }}
                >
                  {w.orig_words ?? ""}
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {(w.tw_link ?? "").replace(/^rc:\/\/\*\/tw\/dict\/bible\//, "")}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 1, fontStyle: "italic" }}
        >
          {t("flowReview.context.wordLinksNote")}
        </Typography>
      </Box>
    </Box>
  );
}
