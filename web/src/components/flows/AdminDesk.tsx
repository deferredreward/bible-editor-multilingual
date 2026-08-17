// AdminDesk — shared chrome for the redesigned admin screens, implementing
// the locked "admin = desk-rail" decision (2026-08-07) with Benjamin's
// 2026-08-10 direction: desktop-first (the first user is a laptop user), but
// still usable narrow.
//
//   * >=900px (theme md): a 232px sticky rail beside the content column,
//     inside the 1440px desk — the .desk-shell/.rail primitives from
//     docs/mockups/desktop-first/_design.css translated to the MUI/sx idiom
//     the flows screens already use.
//   * <900px: the rail collapses into a tap-to-open menu at the top (the same
//     pattern the old FlowNav used, which Benjamin found more intuitive on
//     mobile than a horizontal scroll strip — 2026-08-17).
//
// Sections navigate by hash (#/admin/* and the More-tools hashes) so
// back/forward work; the active section is tinted with the Inspire highlight
// like every other selected row in the redesign. Screens render inside as
// children — this file owns ONLY the chrome, never data.
import { useState, type ReactNode } from "react";
import {
  Box,
  Button,
  ButtonBase,
  ListSubheader,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import MenuIcon from "@mui/icons-material/Menu";
import GroupsIcon from "@mui/icons-material/Groups";
import TuneIcon from "@mui/icons-material/Tune";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import InsightsIcon from "@mui/icons-material/Insights";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import PaletteIcon from "@mui/icons-material/Palette";
import ArticleIcon from "@mui/icons-material/Article";
import VisibilityIcon from "@mui/icons-material/Visibility";

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

type NavItem = { key: AdminSection; label: string; icon: ReactNode; hash: string };

const SECTIONS: NavItem[] = [
  { key: "progress", label: "Progress", icon: <InsightsIcon fontSize="small" />, hash: "#/admin/progress" },
  { key: "workflow", label: "Workflow", icon: <AccountTreeIcon fontSize="small" />, hash: "#/admin/workflow" },
  { key: "team", label: "Team & roles", icon: <GroupsIcon fontSize="small" />, hash: "#/admin/team" },
  { key: "setup", label: "Setup", icon: <TuneIcon fontSize="small" />, hash: "#/admin/setup" },
];

// More-tools sections — same first-class treatment as SECTIONS above, but each
// keeps its own pre-existing hash (#/ai etc.) rather than the #/admin/{key}
// pattern, so bookmarks and links into these pages keep working (#186).
const TOOLS: NavItem[] = [
  { key: "ai", label: "AI studio", icon: <AutoAwesomeIcon fontSize="small" />, hash: "#/ai" },
  { key: "style", label: "Style", icon: <PaletteIcon fontSize="small" />, hash: "#/style" },
  { key: "templates", label: "Templates", icon: <ArticleIcon fontSize="small" />, hash: "#/curate" },
  { key: "observe", label: "Observe", icon: <VisibilityIcon fontSize="small" />, hash: "#/observe" },
];

export function AdminDesk({ current, children }: { current: AdminSection; children: ReactNode }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const go = (hash: string) => {
    location.hash = hash;
    setAnchorEl(null);
  };

  const groupHeader = (label: string, marginBlockStart = 0) => (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "text.secondary",
        paddingInline: 1.5,
        paddingBlock: 0.75,
        marginBlockStart,
      }}
    >
      {label}
    </Typography>
  );

  const railItem = (item: NavItem) => {
    const active = item.key === current;
    return (
      <ButtonBase
        key={item.key}
        aria-current={active ? "page" : undefined}
        onClick={() => go(item.hash)}
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
        {item.icon}
        {item.label}
      </ButtonBase>
    );
  };

  // Exit — the desk is a place you leave, so the way out is the first thing in
  // the rail (Benjamin, 2026-08-10: "how do I get out?").
  const booksExit = (
    <ButtonBase
      onClick={() => go("#/books")}
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
  );

  // Desktop: a sticky vertical rail beside the content column.
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
        flexDirection: "column",
        gap: 0.25,
        position: "sticky",
        insetBlockStart: 16,
        alignSelf: "start",
      }}
    >
      {booksExit}
      {groupHeader("Admin")}
      {SECTIONS.map(railItem)}
      {groupHeader("More tools", 0.5)}
      {TOOLS.map(railItem)}
    </Box>
  );

  // Narrow: a compact bar with the Books exit and a tap-to-open menu showing
  // the current section — collapses rather than scrolls (Benjamin 2026-08-17).
  const currentLabel = [...SECTIONS, ...TOOLS].find((i) => i.key === current)?.label ?? "Admin";
  const menuItem = (item: NavItem) => {
    const active = item.key === current;
    return (
      <MenuItem
        key={item.key}
        selected={active}
        aria-current={active ? "page" : undefined}
        onClick={() => go(item.hash)}
        sx={{ minHeight: 44, gap: 1.25 }}
      >
        {item.icon}
        {item.label}
      </MenuItem>
    );
  };
  const collapsedNav = (
    <Box
      component="nav"
      aria-label="Admin sections"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        padding: 1,
      }}
    >
      {booksExit}
      <Button
        startIcon={<MenuIcon />}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={anchorEl ? true : undefined}
        sx={{
          minHeight: 44,
          flex: 1,
          justifyContent: "flex-start",
          textAlign: "start",
          color: "text.primary",
          fontWeight: 600,
        }}
      >
        {currentLabel}
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        <ListSubheader disableSticky>Admin</ListSubheader>
        {SECTIONS.map(menuItem)}
        <ListSubheader disableSticky>More tools</ListSubheader>
        {TOOLS.map(menuItem)}
      </Menu>
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
        {wide ? rail : collapsedNav}
        <Box sx={{ minWidth: 0 }}>{children}</Box>
      </Box>
    </Box>
  );
}
