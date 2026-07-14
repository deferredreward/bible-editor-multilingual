import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckIcon from "@mui/icons-material/Check";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { useTranslation } from "react-i18next";
import { CHECK_LANES, type CheckLane } from "../sync/api";
import { LANE_FILL, type LaneShade } from "../lib/laneChecks";
import type { VerseTile, VerseTileLane } from "./TimelineRail";

export interface ChapterBoardProps {
  open: boolean;
  onClose: () => void;
  book: string;
  chapter: number;
  tiles: VerseTile[]; // one per verse (verse may be 0 = intro)
  canCheck: boolean;
  onToggle: (verse: number, lane: CheckLane) => void; // per cell
  onBulkToggle: (lane: CheckLane) => void; // column "all" (already confirm-gated upstream — just call it)
  // Lanes currently shown in the timeline rail; the board always lists every
  // lane so a hidden one can be turned back on here.
  enabledLanes: CheckLane[];
  onToggleLaneVisible: (lane: CheckLane) => void;
}

// Column layout shared by header / body / footer so the grid stays aligned.
const GRID_TEMPLATE = `72px repeat(${CHECK_LANES.length}, minmax(96px, 1fr))`;

function BoardCell({
  lane,
  canCheck,
  onToggle,
}: {
  lane: VerseTileLane;
  canCheck: boolean;
  onToggle: () => void;
}) {
  if (!lane.applicable) {
    return (
      <Tooltip title={lane.title}>
        <Box
          sx={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "text.disabled",
            fontSize: 15,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          –
        </Box>
      </Tooltip>
    );
  }
  const filled = lane.shade !== "open";
  const fill = filled ? LANE_FILL[lane.shade as Exclude<LaneShade, "open">] : null;
  return (
    <Tooltip title={lane.title}>
      <Box
        role="checkbox"
        aria-checked={filled}
        aria-label={lane.title}
        aria-disabled={!canCheck}
        onClick={canCheck ? onToggle : undefined}
        sx={{
          width: 24,
          height: 24,
          borderRadius: "5px",
          cursor: canCheck ? "pointer" : "not-allowed",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: fill ? fill.bg : "transparent",
          color: fill ? fill.fg : "transparent",
          border: fill ? "none" : "1.5px solid",
          borderColor: fill ? "transparent" : "divider",
          transition: "background-color 120ms",
          "&:hover": canCheck ? { borderColor: fill ? "transparent" : "text.secondary" } : {},
        }}
      >
        {filled && <CheckIcon sx={{ fontSize: 17 }} />}
      </Box>
    </Tooltip>
  );
}

export function ChapterBoard({
  open,
  onClose,
  book,
  chapter,
  tiles,
  canCheck,
  onToggle,
  onBulkToggle,
  enabledLanes,
  onToggleLaneVisible,
}: ChapterBoardProps) {
  const { t } = useTranslation();
  // Per-lane tally: applicable = cells where the lane applies; done = those with
  // a non-"open" shade (checked by me / others / both). Percent rounds done/applicable.
  const tallies = CHECK_LANES.map((laneKind) => {
    let applicable = 0;
    let done = 0;
    for (const tile of tiles) {
      const lane = tile.lanes.find((l) => l.lane === laneKind);
      if (!lane || !lane.applicable) continue;
      applicable += 1;
      if (lane.shade !== "open") done += 1;
    }
    const percent = applicable === 0 ? 0 : Math.round((done / applicable) * 100);
    return { lane: laneKind, applicable, done, percent };
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1.5 }}
      >
        <Typography component="span" sx={{ fontSize: 18, fontWeight: 600 }}>
          {t("shell.boardTitle", { book, chapter })}
        </Typography>
        <IconButton onClick={onClose} aria-label={t("common.close")} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ fontSize: 15 }}>
        <Box sx={{ display: "table", width: "100%", borderCollapse: "collapse" }}>
          {/* Header row */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: GRID_TEMPLATE,
              alignItems: "end",
              columnGap: 1,
              pb: 1,
              borderBottom: "1px solid",
              borderColor: "divider",
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 1,
            }}
          >
            <Box sx={{ fontSize: 14, fontWeight: 600, color: "text.secondary", pl: 0.5 }}>#</Box>
            {CHECK_LANES.map((laneKind) => {
              const shown = enabledLanes.includes(laneKind);
              return (
              <Box
                key={laneKind}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.25,
                }}
              >
                <Typography
                  sx={{ fontSize: 15, fontWeight: 600, color: shown ? "text.primary" : "text.disabled" }}
                >
                  {t(`lanes.${laneKind}`)}
                </Typography>
                <Tooltip title={shown ? t("shell.hideLaneInSidebar") : t("shell.showLaneInSidebar")}>
                  <Box
                    role="button"
                    aria-label={
                      shown
                        ? t("shell.hideLabelInSidebar", { label: t(`lanes.${laneKind}`) })
                        : t("shell.showLabelInSidebar", { label: t(`lanes.${laneKind}`) })
                    }
                    aria-pressed={shown}
                    onClick={() => onToggleLaneVisible(laneKind)}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.25,
                      cursor: "pointer",
                      color: shown ? "primary.main" : "text.disabled",
                      fontSize: 12,
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    {shown ? (
                      <VisibilityIcon sx={{ fontSize: 14 }} />
                    ) : (
                      <VisibilityOffIcon sx={{ fontSize: 14 }} />
                    )}
                    {shown ? t("shell.shown") : t("shell.hidden")}
                  </Box>
                </Tooltip>
                {canCheck && (
                  <Box
                    role="button"
                    aria-label={t("shell.checkAllLabel", { label: t(`lanes.${laneKind}`) })}
                    onClick={() => onBulkToggle(laneKind)}
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.25,
                      cursor: "pointer",
                      color: "primary.main",
                      fontSize: 13,
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    <DoneAllIcon sx={{ fontSize: 14 }} />
                    {t("shell.all")}
                  </Box>
                )}
              </Box>
              );
            })}
          </Box>

          {/* Body rows */}
          {tiles.map((tile) => {
            const byLane = new Map(tile.lanes.map((l) => [l.lane, l]));
            return (
              <Box
                key={tile.verse}
                sx={{
                  display: "grid",
                  gridTemplateColumns: GRID_TEMPLATE,
                  alignItems: "center",
                  columnGap: 1,
                  py: 0.75,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Box
                  sx={{
                    fontFamily: "monospace",
                    fontSize: 14,
                    color: "text.secondary",
                    pl: 0.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  {tile.verse === 0 ? "intro" : tile.verse}
                </Box>
                {CHECK_LANES.map((laneKind) => {
                  const lane = byLane.get(laneKind);
                  return (
                    <Box
                      key={laneKind}
                      sx={{ display: "flex", justifyContent: "center", alignItems: "center" }}
                    >
                      {lane ? (
                        <BoardCell
                          lane={lane}
                          canCheck={canCheck}
                          onToggle={() => onToggle(tile.verse, laneKind)}
                        />
                      ) : (
                        <Box sx={{ color: "text.disabled", fontSize: 15 }}>–</Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );
          })}

          {/* Footer tally row */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: GRID_TEMPLATE,
              alignItems: "center",
              columnGap: 1,
              pt: 1,
            }}
          >
            <Box sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary", pl: 0.5 }}>
              {t("shell.done")}
            </Box>
            {tallies.map((tally) => (
              <Box
                key={tally.lane}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.5,
                  px: 0.5,
                }}
              >
                <Typography sx={{ fontSize: 13, color: "text.secondary", whiteSpace: "nowrap" }}>
                  {tally.done}/{tally.applicable}
                </Typography>
                <Box
                  aria-label={t("shell.lanePercentComplete", { label: t(`lanes.${tally.lane}`), percent: tally.percent })}
                  sx={{
                    width: "100%",
                    height: 6,
                    borderRadius: 3,
                    bgcolor: "action.hover",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      width: `${tally.percent}%`,
                      height: "100%",
                      bgcolor: "#70C9CC",
                      transition: "width 160ms",
                    }}
                  />
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
