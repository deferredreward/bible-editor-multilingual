// TODO(i18n): this file has no user-facing literals of its own — its children
// supply the labels — but it stays in the flow-screen i18n sweep alongside the
// screens that use it.
//
// Fixed bottom action bar for the phone/tablet bands, after .actionbar in
// docs/flows/ui/_tokens.css. Renders nothing at >=900px (BAND_PX.desktop),
// where the same actions live inline in the work card.
//
// Touch targets: the mockups measured 22–23px tall here, which fails WCAG 2.5.8
// (24px floor). Every direct child gets a 44px minimum instead — don't relax it.

import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";

export interface FlowActionBarProps {
  children: ReactNode;
}

export function FlowActionBar({ children }: FlowActionBarProps) {
  const theme = useTheme();
  const belowDesktop = useMediaQuery(theme.breakpoints.down("md")); // <900
  if (!belowDesktop) return null;

  return (
    <Box
      component="footer"
      sx={{
        position: "fixed",
        insetInline: 0,
        insetBlockEnd: 0,
        zIndex: theme.zIndex.appBar,
        display: "flex",
        gap: 1.25,
        paddingBlockStart: 1.5,
        paddingBlockEnd: "calc(12px + env(safe-area-inset-bottom))",
        paddingInline: 2,
        bgcolor: "background.paper",
        // Logical-property borders aren't MUI system props, so spell the style
        // out; `borderColor` IS a system prop and resolves the theme token.
        borderBlockStart: "1px solid",
        borderColor: "divider",
        "& > *": { flex: 1, minHeight: 44 },
      }}
    >
      {children}
    </Box>
  );
}
