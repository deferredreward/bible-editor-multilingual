// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Persona-grouped pill navigation across the flow screens, after .flow-nav in
// docs/flows/ui/t1-home.html. Three groups — Translator / Lead / Admin — with
// the Admin group shown only to admins.
//
// The mockups drop the nav entirely below 700px, which strands admin screens
// with no way out. Here it collapses to a single menu button instead: the nav
// is always reachable at every width.

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import MenuIcon from "@mui/icons-material/Menu";
import useMediaQuery from "@mui/material/useMediaQuery";

export type FlowRole = "viewer" | "editor" | "admin";

export interface FlowNavProps {
  /** Id of the screen currently shown, e.g. "review". Marks that pill current. */
  current: string;
  book?: string;
  chapter?: number;
  verse?: number;
  role: FlowRole;
}

// Screens that address a passage fall back to these when the caller has no
// current location (e.g. the Admin screens, which aren't passage-scoped).
const DEFAULT_BOOK = "OBA";
const DEFAULT_CHAPTER = 1;
const DEFAULT_VERSE = 1;

interface NavItem {
  id: string;
  label: string;
  href: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function buildGroups(book: string, chapter: number, verse: number, role: FlowRole): NavGroup[] {
  const groups: NavGroup[] = [
    {
      label: "Translator",
      items: [
        { id: "home", label: "Home", href: "#/home" },
        { id: "review", label: "Review", href: `#/review/${book}/${chapter}` },
        { id: "scripture", label: "Scripture", href: `#/scripture/${book}/${chapter}/${verse}` },
        { id: "verse", label: "Verse", href: `#/verse/${book}/${chapter}/${verse}` },
        { id: "align", label: "Align", href: `#/align/${book}/${chapter}/${verse}` },
        { id: "articles", label: "Articles", href: "#/articles" },
        { id: "words", label: "Words", href: `#/words/${book}/${chapter}/${verse}` },
      ],
    },
    {
      label: "Lead",
      items: [
        { id: "ai", label: "AI", href: "#/ai" },
        { id: "style", label: "Style", href: "#/style" },
        { id: "curate", label: "Templates", href: "#/curate" },
      ],
    },
  ];
  if (role === "admin") {
    groups.push({
      label: "Admin",
      items: [
        { id: "setup", label: "Setup", href: "#/setup" },
        { id: "books", label: "Books", href: "#/books" },
        { id: "team", label: "Team", href: "#/team" },
        { id: "observe", label: "Observe", href: "#/observe" },
      ],
    });
  }
  return groups;
}

export function FlowNav({ current, book, chapter, verse, role }: FlowNavProps) {
  // The mockup's own failure point. Below it we collapse rather than hide.
  const collapsed = useMediaQuery("(max-width:699.95px)");
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const groups = buildGroups(
    book ?? DEFAULT_BOOK,
    chapter ?? DEFAULT_CHAPTER,
    verse ?? DEFAULT_VERSE,
    role,
  );

  const currentItem = groups.flatMap((g) => g.items).find((i) => i.id === current);

  if (collapsed) {
    return (
      <Box
        component="nav"
        aria-label="Screens"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          paddingBlock: 1,
          paddingInline: 1.5,
          bgcolor: "background.paper",
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Button
          startIcon={<MenuIcon />}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{ minHeight: 44, textAlign: "start" }}
          aria-haspopup="menu"
          aria-expanded={anchorEl ? true : undefined}
        >
          {currentItem?.label ?? "Screens"}
        </Button>
        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
          {groups.flatMap((group) => [
            <ListSubheader key={`h-${group.label}`} disableSticky>
              {group.label}
            </ListSubheader>,
            ...group.items.map((item) => (
              <MenuItem
                key={item.id}
                component="a"
                href={item.href}
                selected={item.id === current}
                aria-current={item.id === current ? "page" : undefined}
                onClick={() => setAnchorEl(null)}
                sx={{ minHeight: 44 }}
              >
                {item.label}
              </MenuItem>
            )),
          ])}
        </Menu>
      </Box>
    );
  }

  return (
    <Box
      component="nav"
      aria-label="Screens"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        overflowX: "auto",
        paddingBlock: 1,
        paddingInline: 2.25,
        bgcolor: "background.paper",
        borderBlockEnd: "1px solid",
        borderColor: "divider",
      }}
    >
      {groups.map((group) => (
        <Box key={group.label} sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: "none" }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "text.secondary",
              fontSize: "0.65rem",
              whiteSpace: "nowrap",
            }}
          >
            {group.label}
          </Typography>
          {group.items.map((item) => {
            const isCurrent = item.id === current;
            return (
              <Box
                key={item.id}
                component="a"
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                sx={{
                  flex: "none",
                  textDecoration: "none",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  borderRadius: 999,
                  paddingBlock: 0.625,
                  paddingInline: 1.375,
                  border: "1px solid",
                  borderColor: isCurrent ? "primary.main" : "divider",
                  bgcolor: isCurrent ? "action.selected" : "action.hover",
                  color: isCurrent ? "text.primary" : "text.secondary",
                  "&:hover": { color: "text.primary" },
                }}
              >
                {item.label}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
