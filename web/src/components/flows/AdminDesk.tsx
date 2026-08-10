// AdminDesk — shared chrome for the redesigned admin screens, implementing
// the locked "admin = desk-rail" decision (2026-08-07) with Benjamin's
// 2026-08-10 direction: desktop-first (the first user is a laptop user), but
// still usable narrow.
//
//   * >=900px (theme md): a 232px sticky rail beside the content column,
//     inside the 1180px desk — the .desk-shell/.rail primitives from
//     docs/mockups/desktop-first/_design.css translated to the MUI/sx idiom
//     the flows screens already use.
//   * <900px: the rail becomes a horizontal scroll strip above the content
//     (same as the artifact CSS's max-width:900px rule).
//
// Sections are plain hash links (#/admin/*) so back/forward work; the active
// section is tinted with the Inspire highlight like every other selected row
// in the redesign. Screens render inside as children — this file owns ONLY
// the chrome, never data.
import type { ReactNode } from "react";
import { Box, ButtonBase, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import GroupsIcon from "@mui/icons-material/Groups";
import TuneIcon from "@mui/icons-material/Tune";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import InsightsIcon from "@mui/icons-material/Insights";

const INSPIRE = "#31ADE3";

export type AdminSection = "team" | "setup" | "workflow" | "progress";

const SECTIONS: Array<{ key: AdminSection; label: string; icon: ReactNode }> = [
  { key: "progress", label: "Progress", icon: <InsightsIcon fontSize="small" /> },
  { key: "workflow", label: "Workflow", icon: <AccountTreeIcon fontSize="small" /> },
  { key: "team", label: "Team & roles", icon: <GroupsIcon fontSize="small" /> },
  { key: "setup", label: "Setup", icon: <TuneIcon fontSize="small" /> },
];

export function AdminDesk({ current, children }: { current: AdminSection; children: ReactNode }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const wide = useMediaQuery(theme.breakpoints.up("md"));

  const rail = (
    <Box
      component="nav"
      aria-label="Admin sections"
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        padding: 1.25,
        display: "flex",
        gap: 0.25,
        ...(wide
          ? { flexDirection: "column", position: "sticky", insetBlockStart: 16, alignSelf: "start" }
          : { flexDirection: "row", overflowX: "auto" }),
      }}
    >
      {/* Exit — the desk is a place you leave, so the way out is the first
          thing in the rail (Benjamin, 2026-08-10: "how do I get out?"). */}
      <ButtonBase
        onClick={() => {
          location.hash = "#/books";
        }}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 1.25,
          textAlign: "start",
          fontSize: "0.875rem",
          fontWeight: 600,
          color: "text.secondary",
          borderRadius: "9px",
          paddingBlock: 1,
          paddingInline: 1.5,
          whiteSpace: "nowrap",
          "&:hover": { bgcolor: "action.hover", color: "text.primary" },
        }}
      >
        <ChevronLeftIcon
          fontSize="small"
          sx={theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined}
        />
        Books
      </ButtonBase>
      {wide && (
        <Typography
          variant="caption"
          sx={{
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "text.secondary",
            paddingInline: 1.5,
            paddingBlock: 0.75,
          }}
        >
          Admin
        </Typography>
      )}
      {SECTIONS.map((s) => {
        const active = s.key === current;
        return (
          <ButtonBase
            key={s.key}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              location.hash = `#/admin/${s.key}`;
            }}
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: 1.25,
              textAlign: "start",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: active ? "text.primary" : "text.secondary",
              bgcolor: active ? alpha(INSPIRE, dark ? 0.16 : 0.1) : "transparent",
              borderRadius: "9px",
              paddingBlock: 1,
              paddingInline: 1.5,
              whiteSpace: "nowrap",
              "&:hover": { bgcolor: active ? alpha(INSPIRE, dark ? 0.16 : 0.1) : "action.hover" },
            }}
          >
            {s.icon}
            {s.label}
          </ButtonBase>
        );
      })}
    </Box>
  );

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      <Box
        sx={{
          maxWidth: 1180,
          mx: "auto",
          paddingInline: 2,
          paddingBlock: 2,
          ...(wide
            ? { display: "grid", gridTemplateColumns: "232px minmax(0, 1fr)", gap: 2.5, alignItems: "start" }
            : { display: "flex", flexDirection: "column", gap: 1.5 }),
        }}
      >
        {rail}
        <Box sx={{ minWidth: 0 }}>{children}</Box>
      </Box>
    </Box>
  );
}
