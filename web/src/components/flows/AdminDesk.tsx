// AdminDesk — shared chrome for the redesigned admin screens, implementing
// the locked "admin = desk-rail" decision (2026-08-07) with Benjamin's
// 2026-08-10 direction: desktop-first (the first user is a laptop user), but
// still usable narrow.
//
//   * >=900px (theme md): a 232px sticky rail beside the content column,
//     inside the 1440px desk — the .desk-shell/.rail primitives from
//     docs/mockups/desktop-first/_design.css translated to the MUI/sx idiom
//     the flows screens already use.
//   * <900px: the rail becomes a horizontal scroll strip above the content
//     (same as the artifact CSS's max-width:900px rule).
//
// Sections are plain hash links so back/forward work; the active section is
// tinted with the Inspire highlight like every other selected row in the
// redesign. Screens render inside as children — this file owns ONLY the
// chrome, never data. Two groups share one rail: the top-4 ADMIN sections
// (#/admin/*) and the four MORE TOOLS sections (AI studio, Style, Templates,
// Observe) — the latter keep their pre-existing URLs (#/ai, #/style,
// #/curate, #/observe; issue #186) even though "templates" is the desk
// section key for the #/curate page.
import type { ReactNode } from "react";
import { Box, ButtonBase, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import GroupsIcon from "@mui/icons-material/Groups";
import TuneIcon from "@mui/icons-material/Tune";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import InsightsIcon from "@mui/icons-material/Insights";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import StyleIcon from "@mui/icons-material/Style";
import ArticleIcon from "@mui/icons-material/Article";
import QueryStatsIcon from "@mui/icons-material/QueryStats";

const INSPIRE = "#31ADE3";

export type AdminSection =
  | "team"
  | "setup"
  | "workflow"
  | "progress"
  | "ai"
  | "style"
  | "templates"
  | "observe";

interface SectionDef {
  key: AdminSection;
  label: string;
  icon: ReactNode;
  // The desk section key doesn't always match the URL segment (e.g.
  // "templates" stays at #/curate — see App.tsx's parseHash), so each entry
  // owns the hash it navigates to rather than deriving it from `key`.
  hash: string;
}

const SECTIONS: SectionDef[] = [
  { key: "progress", label: "Progress", icon: <InsightsIcon fontSize="small" />, hash: "#/admin/progress" },
  { key: "workflow", label: "Workflow", icon: <AccountTreeIcon fontSize="small" />, hash: "#/admin/workflow" },
  { key: "team", label: "Team & roles", icon: <GroupsIcon fontSize="small" />, hash: "#/admin/team" },
  { key: "setup", label: "Setup", icon: <TuneIcon fontSize="small" />, hash: "#/admin/setup" },
];

// The four MORE TOOLS pages, now first-class desk sections — same rail
// treatment (icon + selected state) as SECTIONS above, just kept in a
// separate group under its own "More tools" caption. URLs are unchanged
// (#/ai, #/style, #/curate, #/observe) — only where App.tsx routes them TO
// moved into the desk shell.
const TOOL_SECTIONS: SectionDef[] = [
  { key: "ai", label: "AI studio", icon: <AutoAwesomeIcon fontSize="small" />, hash: "#/ai" },
  { key: "style", label: "Style", icon: <StyleIcon fontSize="small" />, hash: "#/style" },
  { key: "templates", label: "Templates", icon: <ArticleIcon fontSize="small" />, hash: "#/curate" },
  { key: "observe", label: "Observe", icon: <QueryStatsIcon fontSize="small" />, hash: "#/observe" },
];

// Shared button chrome for every rail entry — top-4 ADMIN sections and the
// four MORE TOOLS sections render identically (icon, selected tint,
// aria-current), the only difference being which hash each navigates to.
function sectionButton(s: SectionDef, current: AdminSection, dark: boolean) {
  const active = s.key === current;
  return (
    <ButtonBase
      key={s.key}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        location.hash = s.hash;
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
}

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
      {SECTIONS.map((s) => sectionButton(s, current, dark))}
      {/* Admin surfaces that predate the desk redesign, kept reachable here
          since FlowNav is retiring (Benjamin 2026-08-11). Each moves into the
          desk when its own redesign lands. */}
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
            marginBlockStart: 0.5,
          }}
        >
          More tools
        </Typography>
      )}
      {TOOL_SECTIONS.map((s) => sectionButton(s, current, dark))}
    </Box>
  );

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      <Box
        sx={{
          maxWidth: 1440,
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
