// Panel chrome shared by the a2-import port (BooksScreen + its sibling
// Books*.tsx panels). Mirrors .panel / .panel-top / .panel-body / .panel-foot
// in docs/flows/ui/_tokens.css: a card with a titled head, a padded body, and
// a foot that states live state on the inline-start and the next action on the
// inline-end. Logical properties only.

import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function Panel({ children }: { children: ReactNode }) {
  return (
    <Box
      component="section"
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.75,
        boxShadow: 1,
        overflow: "hidden",
      }}
    >
      {children}
    </Box>
  );
}

export function PanelTop({
  title,
  sub,
  aside,
}: {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        flexWrap: "wrap",
        paddingBlock: 1.625,
        paddingInline: 2,
        borderBlockEnd: 1,
        borderColor: "divider",
      }}
    >
      <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
        {title}
      </Typography>
      {aside}
      {sub ? (
        <Typography variant="body2" color="text.secondary" sx={{ width: "100%", mt: 0.25 }}>
          {sub}
        </Typography>
      ) : null}
    </Box>
  );
}

export function PanelBody({ children }: { children: ReactNode }) {
  return <Box sx={{ p: 2 }}>{children}</Box>;
}

export function PanelFoot({ state, children }: { state: ReactNode; children?: ReactNode }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      flexWrap="wrap"
      sx={{
        gap: 1.5,
        paddingBlock: 1.375,
        paddingInline: 2,
        borderBlockStart: 1,
        borderColor: "divider",
        bgcolor: "action.hover",
      }}
    >
      <Box sx={{ flex: "1 1 200px", minWidth: 0, fontSize: "0.8125rem", color: "text.secondary" }}>
        {state}
      </Box>
      {children}
    </Stack>
  );
}

/** Row used by the job / pending / per-book lists: main block + trailing actions. */
export function ListRow({ children }: { children: ReactNode }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{
        gap: 1.25,
        paddingBlock: 1.125,
        borderBlockEnd: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBlockEnd: 0 },
      }}
    >
      {children}
    </Stack>
  );
}
