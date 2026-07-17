import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Box } from "@mui/material";
import { styled } from "@mui/material/styles";
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import type { Axis, LayoutNode, LayoutSpec, PanelRegion } from "../lib/layoutSpec";
import { CLASSIC_LAYOUT_ID } from "../lib/builtinLayouts";

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
  const renderNode = (node: LayoutNode, path: string): ReactNode => {
    if (node.kind === "region") {
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
    return (
      <Group
        key={`group:${path}`}
        id={`group:${path}`}
        orientation={orientation}
        onLayoutChanged={handleLayoutChanged}
        style={{ height: "100%", width: "100%" }}
      >
        {node.children.flatMap((child, i) => {
          const cpath = `${path}.${i}`;
          const id = childId(child, cpath);
          const frac = sizes[id] ?? child.size ?? 1 / n;
          const panel = (
            <Panel key={id} id={id} defaultSize={`${(frac * 100).toFixed(4)}%`} minSize="10%">
              {renderNode(child, cpath)}
            </Panel>
          );
          return i === 0
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
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Root path seeds group/split keys with the layout id so a switch
            between non-classic layouts remounts the tree (re-reading defaultSize
            from the new spec/overrides). */}
        {renderNode(spec.root, spec.id)}
      </Box>
    </Box>
  );
}
