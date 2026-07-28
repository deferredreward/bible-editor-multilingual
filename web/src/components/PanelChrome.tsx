// The thin header bar that makes a panel draggable and collapsible.
//
// Rendered ONLY for arrangeable (non-Classic) layouts — Shell gates every call
// site on `arrangeable`, which is `!isClassic`. Classic's regions render exactly
// as they did before, with no chrome and no drag affordance.
//
// Minimizing HIDES the body (display:none) rather than unmounting it: the panel
// keeps its scroll position, its in-flight edits, and its note-save-on-unmount
// semantics. Matches the mockup's `.panel.collapsed .panel-body { display:none }`.

import type { ReactNode } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import { useTranslation } from "react-i18next";
import type { PanelType } from "../lib/layoutSpec";
import { useLayoutDrag } from "./LayoutDragContext";

interface PanelChromeProps {
  panelId: string;
  panelType: PanelType;
  minimized: boolean;
  onToggleMinimized: () => void;
  // Close the whole REGION this panel sits in (a different thing from
  // `onToggleMinimized`, which collapses just this panel to its header). Shell
  // passes it on a region's FIRST panel only, and only when the region is
  // closeable — so the button's presence is itself the availability test.
  //
  // It lives in the panel header rather than in a region header of its own so it
  // stays IN FLOW: a floating region control would sit on top of the workspace
  // and could cover the drag grips or the perimeter drop bands, which is exactly
  // the class of bug the perimeter bands already shipped once.
  onCloseRegion?: () => void;
  children: ReactNode;
}

export function PanelChrome({
  panelId,
  panelType,
  minimized,
  onToggleMinimized,
  onCloseRegion,
  children,
}: PanelChromeProps) {
  const { t } = useTranslation();
  const drag = useLayoutDrag();
  const dragging = drag?.draggedPanelId === panelId;
  // Panel titles come from a dedicated `panelTitle.*` namespace keyed by panel
  // type. English-only in en.json; other locales fall back to English via
  // i18n's fallbackLng.
  const title = t(`panelTitle.${panelType}`);

  return (
    // `data-be-panel-id` is how RegionDropZone measures panel midpoints for the
    // center ("into") insertion index. Keep it in sync with that query.
    <Box
      data-be-panel-id={panelId}
      sx={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
        opacity: dragging ? 0.45 : 1,
        transition: "opacity 0.12s",
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 0.25,
          px: 0.5,
          py: 0,
          minHeight: 18,
          bgcolor: "grey.50",
          borderBottom: minimized ? 0 : "1px solid",
          borderColor: "divider",
          userSelect: "none",
        }}
      >
        <Tooltip title={t("layout.dragToMove")}>
          <Box
            component="span"
            draggable
            onDragStart={(e: React.DragEvent) => {
              // Firefox refuses to start a drag with no dataTransfer payload;
              // the drag STATE that matters lives in context (see
              // LayoutDragContext), this is only the browser's ticket.
              try {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", panelId);
              } catch {
                /* some browsers throw on a detached dataTransfer — harmless */
              }
              drag?.beginDrag(panelId);
            }}
            onDragEnd={() => drag?.endDrag()}
            sx={{
              display: "flex",
              alignItems: "center",
              cursor: "grab",
              color: "text.disabled",
              "&:active": { cursor: "grabbing" },
            }}
          >
            <DragIndicatorIcon sx={{ fontSize: 13 }} />
          </Box>
        </Tooltip>
        {/* Quiet, not a heading — the panel body carries its own title. Kept
            (tiny) so a minimized panel is still identifiable. */}
        <Typography
          variant="caption"
          sx={{
            fontSize: 9,
            lineHeight: 1.4,
            fontWeight: 500,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "text.disabled",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </Typography>
        <IconButton
          size="small"
          onClick={onToggleMinimized}
          aria-label={minimized ? t("layout.expandPanel") : t("layout.minimizePanel")}
          sx={{ marginInlineStart: "auto", p: 0 }}
        >
          {minimized ? (
            <ChevronRightIcon sx={{ fontSize: 14 }} />
          ) : (
            <ExpandMoreIcon sx={{ fontSize: 14 }} />
          )}
        </IconButton>
        {onCloseRegion && (
          <Tooltip title={t("layout.closeRegion")}>
            <IconButton
              size="small"
              onClick={onCloseRegion}
              aria-label={t("layout.closeRegion")}
              sx={{ p: 0 }}
            >
              <CloseIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {/* HIDDEN, not unmounted — scroll position and unsaved edits survive. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: minimized ? "none" : "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
