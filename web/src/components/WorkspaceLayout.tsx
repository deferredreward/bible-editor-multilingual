import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import { styled } from "@mui/material/styles";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import type { Axis, LayoutNode, LayoutSpec, PanelRegion } from "../lib/layoutSpec";
import { isNodeVisible, type HiddenMap } from "../lib/layoutTree";
import { CLASSIC_LAYOUT_ID } from "../lib/builtinLayouts";
import { OuterDropZone } from "./OuterDropZone";

// The in-flow strip that lists CLOSED regions so they can be reopened.
const CLOSED_STRIP_PX = 26;

interface WorkspaceLayoutProps {
  // The resolved active layout. `builtin:classic` renders through the
  // special-cased flexbox path below (byte-identical to Phase 2); every other
  // layout renders through the generic react-resizable-panels tree.
  spec: LayoutSpec;
  // Shell builds the content of a region from its panel instances. WorkspaceLayout
  // only positions/sizes; it never decides WHAT a panel is.
  renderRegion: (region: PanelRegion) => ReactNode;
  railNode: ReactNode;
  railCollapsed: boolean;
  railWidth: number;
  // Persisted per-node size overrides (fractions 0..1), keyed by region id /
  // synthesized split id. Merged over each node's spec `size`.
  sizes: Record<string, number>;
  // Debounced size persistence — receives a patch of {nodeId: fraction} for one
  // resized Group. Only Classic uses the divider ratio path.
  onSizesChange: (patch: Record<string, number>) => void;
  // Regions the user has CLOSED, in tree order, already resolved by
  // layoutTree.resolveHidden (so this is never "every region"). Two jobs: the
  // renderer skips them, and the strip below offers them back. Empty for
  // Classic, which never reaches either.
  closedRegions: { id: string; label: string }[];
  onRestoreRegion: (regionId: string) => void;
  // Label for the reopen strip's controls (Shell owns i18n).
  restoreLabel: (label: string) => string;
  // Classic-only divider (the hand-rolled 8px flex divider from Phase 2).
  effectiveSplit: number;
  onSplitRatioChange: (ratio: number) => void;
}

const DIVIDER_PX = 8;

// A react-resizable-panels Separator styled to match the classic 8px divider:
// a thin centered line that highlights on hover, with an orientation-aware
// resize cursor. `axis` is the parent Group's orientation.
const LayoutSeparator = styled(Separator, {
  shouldForwardProp: (prop) => prop !== "axis",
})<{ axis: Axis }>(({ theme, axis }) => ({
  position: "relative",
  ...(axis === "horizontal"
    ? { width: DIVIDER_PX, cursor: "col-resize" }
    : { height: DIVIDER_PX, cursor: "row-resize" }),
  "&::after": {
    content: '""',
    position: "absolute",
    backgroundColor: theme.palette.divider,
    transition: "background-color 0.15s",
    ...(axis === "horizontal"
      ? { left: "50%", top: 0, bottom: 0, width: "1px", transform: "translateX(-50%)" }
      : { top: "50%", left: 0, right: 0, height: "1px", transform: "translateY(-50%)" }),
  },
  "&:hover::after": { backgroundColor: theme.palette.primary.main },
}));

// A split child's persistence key: regions use their own id; nested splits use
// a path-derived id (they carry no id in the schema). Stable per layout so
// persisted sizes and onLayoutChanged keys line up across reloads.
function childId(child: LayoutNode, path: string): string {
  return child.kind === "region" ? child.id : `split:${path}`;
}

export function WorkspaceLayout({
  spec,
  renderRegion,
  railNode,
  railCollapsed,
  railWidth,
  sizes,
  onSizesChange,
  closedRegions,
  onRestoreRegion,
  restoreLabel,
  effectiveSplit,
  onSplitRatioChange,
}: WorkspaceLayoutProps) {
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  useEffect(() => () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; }, []);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const available = rect.width - railWidth;
      const offset = ev.clientX - rect.left - railWidth;
      onSplitRatioChange(Math.min(0.8, Math.max(0.2, offset / available)));
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [railWidth, onSplitRatioChange]);

  // Persist only user-driven resizes (not initial mount / programmatic). The
  // callback fires once per resized Group; its layout map is keyed by our Panel
  // ids (= childId), so a patch touches only that Group's children.
  const handleLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const patch: Record<string, number> = {};
      for (const [id, pct] of Object.entries(layout)) patch[id] = pct / 100;
      onSizesChange(patch);
    },
    [onSizesChange],
  );

  // ── Classic: byte-identical to the Phase-2 flexbox arrangement. Kept as a
  // special case (not routed through the generic renderer) so the power view is
  // guaranteed unchanged — a safe Classic beats elegant code (P0).
  if (spec.id === CLASSIC_LAYOUT_ID) {
    const root = spec.root;
    const regions = root.kind === "split" ? root.children : [root];
    const scriptureRegion = regions[0] as PanelRegion;
    const resourcesRegion = regions[1] as PanelRegion;
    return (
      <Box ref={splitContainerRef} sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {!railCollapsed && (
          <Box sx={{ width: railWidth, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {railNode}
          </Box>
        )}
        <Box
          sx={{
            width: `${effectiveSplit * 100}%`,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {renderRegion(scriptureRegion)}
        </Box>
        <Box
          onMouseDown={handleDividerMouseDown}
          sx={{
            width: "8px",
            flexShrink: 0,
            cursor: "ew-resize",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              left: "50%",
              top: 0,
              bottom: 0,
              width: "1px",
              bgcolor: "divider",
              transform: "translateX(-50%)",
              transition: "background-color 0.15s",
            },
            "&:hover::after": { bgcolor: "primary.main" },
          }}
        />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {renderRegion(resourcesRegion)}
        </Box>
      </Box>
    );
  }

  // ── Generic (non-classic): walk the recursive split tree. Each SplitNode is a
  // Group with one Panel per child (Separators between); each PanelRegion leaf
  // renders its Shell-built content. The rail stays OUTSIDE the resizable tree.
  // The closed set, as a map for the pure visibility helper. Derived from the
  // already-resolved `closedRegions` so there is exactly one source of truth for
  // "what is closed" (Shell's layoutTree.resolveHidden call).
  const hiddenMap: HiddenMap = {};
  for (const r of closedRegions) hiddenMap[r.id] = true;
  const isRegionClosed = (id: string): boolean => hiddenMap[id] === true;

  const renderNode = (node: LayoutNode, path: string): ReactNode => {
    if (node.kind === "region") {
      if (isRegionClosed(node.id)) return null;
      return (
        <Box
          sx={{
            height: "100%",
            width: "100%",
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {renderRegion(node)}
        </Box>
      );
    }
    const n = node.children.length;
    const orientation = node.orientation;

    // CLOSED regions are filtered out HERE, at render time — the tree still holds
    // them (with their panels), which is what makes restoring them free and makes
    // it impossible for the docking engine to lose a hidden region's panels.
    //
    // The path/key is computed from the ORIGINAL child index and only THEN
    // filtered. That ordering is load-bearing: layoutTree.collectSizeKeys mirrors
    // this `${path}.${i}` scheme, so re-indexing the surviving children would
    // silently repoint every nested `split:<path>` size key — closing a region
    // would then resize unrelated splits, and pruneSizes would delete live keys.
    const visible = node.children
      .map((child, i) => ({ child, cpath: `${path}.${i}` }))
      .filter(({ child }) => isNodeVisible(child, hiddenMap));

    // Nothing left under this split — the parent already filtered it out via
    // isNodeVisible; this is the defensive tail (and the root case).
    if (visible.length === 0) return null;
    // Exactly one child still open: render it DIRECTLY, with no Group. Two
    // reasons. It absorbs the closed sibling's space naturally, and a
    // single-Panel Group would report a 100% layout that could overwrite the
    // persisted size of the region the user is about to reopen.
    if (visible.length === 1) return renderNode(visible[0].child, visible[0].cpath);

    return (
      <Group
        key={`group:${path}`}
        id={`group:${path}`}
        orientation={orientation}
        onLayoutChanged={handleLayoutChanged}
        style={{ height: "100%", width: "100%" }}
      >
        {visible.flatMap(({ child, cpath }, vi) => {
          const id = childId(child, cpath);
          // Fractions of the OPEN children no longer sum to 1 once a sibling is
          // closed; react-resizable-panels renormalizes them, so the survivors
          // absorb the closed region's share proportionally. Nothing is written
          // back, so reopening restores the original proportions exactly.
          const frac = sizes[id] ?? child.size ?? 1 / n;
          const panel = (
            <Panel key={id} id={id} defaultSize={`${(frac * 100).toFixed(4)}%`} minSize="10%">
              {renderNode(child, cpath)}
            </Panel>
          );
          return vi === 0
            ? [panel]
            : [<LayoutSeparator key={`sep:${id}`} axis={orientation} />, panel];
        })}
      </Group>
    );
  };

  return (
    <Box sx={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
      {spec.rail.visible && !railCollapsed && (
        <Box sx={{ width: railWidth, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {railNode}
        </Box>
      )}
      {/* Closed-region reopen strip. Deliberately a FLEX SIBLING of the
          workspace, not an overlay: an absolutely-positioned strip would sit on
          top of the region content and could swallow the drag grips or the
          perimeter drop bands (the bug the perimeter bands already shipped
          once). In flow it merely narrows the workspace by a few pixels, and it
          only exists while something is closed. */}
      {closedRegions.length > 0 && (
        <Box
          data-be-closed-strip=""
          sx={{
            width: CLOSED_STRIP_PX,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 0.25,
            pt: 0.5,
            // LOGICAL border: under an RTL UI stylis-plugin-rtl mirrors physical
            // sides, so `borderRight` here would land on the wrong edge.
            borderInlineEnd: "1px solid",
            borderColor: "divider",
            bgcolor: "grey.50",
            overflow: "hidden",
          }}
        >
          {closedRegions.map((r) => (
            <Tooltip key={r.id} title={restoreLabel(r.label)} placement="right">
              <IconButton
                size="small"
                onClick={() => onRestoreRegion(r.id)}
                aria-label={restoreLabel(r.label)}
                sx={{ p: 0.25 }}
              >
                <VisibilityOutlinedIcon sx={{ fontSize: 15 }} />
              </IconButton>
            </Tooltip>
          ))}
        </Box>
      )}
      {/* `position: relative` anchors the perimeter drop frame to the WORKSPACE
          area (all regions, rail excluded). Classic returns above and never
          reaches this. */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Root path seeds group/split keys with the layout id so a switch
            between non-classic layouts remounts the tree (re-reading defaultSize
            from the new spec/overrides). */}
        {renderNode(spec.root, spec.id)}
        {/* Outer-edge docking: wraps the whole tree so a full-width band stays
            recoverable after its region has been emptied. Renders nothing unless
            a panel drag is in flight. */}
        <OuterDropZone />
      </Box>
    </Box>
  );
}
