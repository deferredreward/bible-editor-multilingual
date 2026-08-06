import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Box, Button, IconButton, Tooltip } from "@mui/material";
import { styled } from "@mui/material/styles";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Group, Panel, Separator, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import type { Axis, LayoutNode, LayoutSpec, PanelRegion } from "../lib/layoutSpec";
import { isNodeVisible, type HiddenMap } from "../lib/layoutTree";
import type { LayoutBand } from "../lib/layoutBands";
import { CLASSIC_LAYOUT_ID } from "../lib/builtinLayouts";
import { OuterDropZone } from "./OuterDropZone";

// The in-flow strip that lists CLOSED regions so they can be reopened. Not
// reused for the band-driven region switcher below: at 26px it sits under the
// 24px WCAG 2.5.8 floor once padding is accounted for (this project's own
// design findings already flag 22-23px tap targets as failures), so the
// switcher gets its own full-width, >=44px-tall control instead.
const CLOSED_STRIP_PX = 26;

// Minimum touch target for the region switcher (WCAG 2.5.8 target size, with
// margin — the closed-region strip above is the cautionary example of going
// too small).
const SWITCHER_MIN_TARGET_PX = 44;

// Full-width row of buttons that makes the regions a narrow viewport dropped
// reachable again — the ones the band hid to keep the workspace from squeezing
// everything into unusable slivers. A flex SIBLING of the workspace (not an
// absolutely-positioned overlay), for the same reason the closed-region strip
// below is in-flow: an overlay strip previously swallowed drag grips and drop
// bands (see the comment further down where that strip is rendered).
//
// It lists EVERY (open) region and marks the current one, rather than listing
// only what the band has hidden. Two reasons. A strip of just-the-hidden
// regions is a tablist in which no tab is ever selected, so it can say where
// you may go but never where you are; and its contents reshuffle on every tap,
// since the region you just left becomes the only thing listed.
//
// `selectedId` is the FOCUSED region, not "every visible region". On tablet two
// regions are on screen but only one was chosen — the neighbour is along for the
// ride because the band's window is two wide, so marking both selected would
// overstate the user's intent.
//
// NOT a real ARIA tablist: there's no matching `tabpanel`, no roving tabindex,
// and no arrow-key handling, so claiming `role="tablist"`/`role="tab"` would
// promise keyboard behaviour (Left/Right arrow) that isn't implemented and a
// screen reader user would hit a dead end on. `role="group"` + `aria-pressed`
// describes what's actually here — a labeled group of toggle buttons — and
// native <button> keeps Tab/Enter/Space working for free.
function RegionSwitcher({
  regions,
  selectedId,
  onFocusRegion,
  ariaLabel,
}: {
  regions: { id: string; label: string }[];
  selectedId: string | null;
  onFocusRegion: (regionId: string) => void;
  ariaLabel: string;
}) {
  return (
    <Box
      role="group"
      aria-label={ariaLabel}
      // Test handle, matching the `data-be-closed-strip` convention below: the
      // page has other MUI tablists (the resource column's tabs), so a probe
      // needs a way to name THIS one.
      data-be-region-switcher=""
      sx={{
        display: "flex",
        flexShrink: 0,
        width: "100%",
        bgcolor: "grey.50",
      }}
    >
      {regions.map((r) => {
        const selected = r.id === selectedId;
        // A region's label is the concatenation of its panel titles, so a
        // multi-panel region reads "translationNotes, translationWords,
        // translationQuestions" — unreadable once truncated to one line in a
        // ~187px phone-width slot. Show the first part plus a count of the
        // rest ("translationNotes +2"); the full label still reaches
        // assistive tech via aria-label below.
        const parts = r.label.split(", ");
        const shortLabel = parts.length > 1 ? `${parts[0]} +${parts.length - 1}` : r.label;
        return (
          <Button
            key={r.id}
            aria-pressed={selected}
            // The visible label is truncated to one line (and, for multi-part
            // labels, shortened to "first +N") so the full region name has to
            // reach assistive tech some other way.
            aria-label={r.label}
            onClick={() => onFocusRegion(r.id)}
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: SWITCHER_MIN_TARGET_PX,
              borderRadius: 0,
              fontSize: 13,
              textTransform: "none",
              // Weight plus an inline-end-agnostic underline: the selected tab
              // has to survive a forced-colors / high-contrast mode where a
              // background tint alone is dropped. This is the strip's ONLY
              // border — the container itself has none — so the selected
              // indicator lands directly on the divider line under the strip
              // instead of a second border stacking on top of it.
              fontWeight: selected ? 600 : 400,
              color: selected ? "primary.main" : "text.secondary",
              bgcolor: selected ? "action.selected" : "transparent",
              borderBlockEnd: "2px solid",
              borderColor: selected ? "primary.main" : "divider",
            }}
          >
            {/* One line, ellipsised — the backstop for a single long part that
                the "first +N" shortening above doesn't apply to. Wrapping to
                three lines made the strip 82px tall at phone width, eating a
                tenth of the screen; the strip has to stay chrome, not
                content. */}
            <Box
              component="span"
              sx={{
                minWidth: 0,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {shortLabel}
            </Box>
          </Button>
        );
      })}
    </Box>
  );
}

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
  // Responsive layout band (phone/tablet/desktop) — see lib/layoutBands.ts.
  // Shell derives this from the theme's breakpoints and passes it down so
  // both the Classic and generic render paths can react to it.
  band: LayoutBand;
  // Regions hidden by the current band, in the same {id, label} shape as
  // `closedRegions` — a VIEWPORT constraint, computed fresh every render and
  // NEVER persisted. This is a different concept from `closedRegions` (the
  // user's own intent, persisted to layoutStore): shrinking the window must
  // never permanently narrow what the user sees again after widening it.
  bandHiddenRegions: { id: string; label: string }[];
  // Every OPEN region (not user-closed) in tree order, for the switcher's tab
  // strip. Distinct from `bandHiddenRegions` on purpose: the strip marks the
  // current region, which it can only do if it knows about the visible ones
  // too. Deliberately excludes user-closed regions — see Shell's CRITICAL
  // comment on `openRegionIds`: a tab pointing at a closed region would be a
  // dead end, since resolveBandHidden was never fed that id in the first
  // place and closing it is a completely separate action (the reopen strip).
  bandRegions: { id: string; label: string }[];
  // Which region the switcher keeps in view alongside its window neighbour
  // (tablet) or shows alone (phone). Null means "no explicit focus" — the
  // band-hiding logic then keeps the first region(s) in tree order.
  focusedRegionId: string | null;
  onFocusRegion: (regionId: string) => void;
  // Accessible name for the switcher's group (Shell owns i18n).
  switcherLabel: string;
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
  band,
  bandHiddenRegions,
  bandRegions,
  focusedRegionId,
  onFocusRegion,
  switcherLabel,
}: WorkspaceLayoutProps) {
  // The switcher only earns its place when the current band is actually
  // hiding something — desktop (and a spec with few enough regions) never
  // reaches this, since Shell's resolveBandHidden already returns [] there.
  const showRegionSwitcher = band !== "desktop" && bandHiddenRegions.length > 0;
  // What the strip marks as current. `focusedRegionId` is null until the user
  // taps a tab, so fall back to the first region the band left visible — which
  // is exactly what resolveBandHidden keeps when focus is null, so the mark
  // always names a region actually on screen.
  const bandHiddenIds = new Set(bandHiddenRegions.map((r) => r.id));
  const switcherSelectedId =
    focusedRegionId ?? bandRegions.find((r) => !bandHiddenIds.has(r.id))?.id ?? null;
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
      // A band hiding a sibling from a 3+-child split leaves the survivors in
      // their own Group, whose reported layout renormalizes to sum to 1 for
      // JUST the survivors (same renormalization the render-time comment
      // above the closed-region case describes). Persisting that here would
      // silently rewrite the user's full-width desktop proportions from a
      // resize-constrained view — a viewport constraint must never be able to
      // overwrite the arrangement the user built at full width. Once the band
      // stops hiding anything the Group reports the real, full sibling set
      // again and resizes persist normally.
      if (bandHiddenRegions.length > 0) return;
      const patch: Record<string, number> = {};
      for (const [id, pct] of Object.entries(layout)) patch[id] = pct / 100;
      onSizesChange(patch);
    },
    [onSizesChange, bandHiddenRegions],
  );

  // ── Classic: byte-identical to the Phase-2 flexbox arrangement. Kept as a
  // special case (not routed through the generic renderer) so the power view is
  // guaranteed unchanged — a safe Classic beats elegant code (P0).
  if (spec.id === CLASSIC_LAYOUT_ID) {
    const root = spec.root;
    const regions = root.kind === "split" ? root.children : [root];
    const scriptureRegion = regions[0] as PanelRegion;
    const resourcesRegion = regions[1] as PanelRegion;
    // On phone, Classic's two-region flexbox has no room for both side by
    // side (nor for the divider between them) — show exactly one, chosen by
    // `focusedRegionId`, defaulting to scripture when nothing is focused yet.
    const isPhone = band === "phone";
    const focusedIsResources = isPhone && focusedRegionId === resourcesRegion.id;
    const showScripture = !isPhone || !focusedIsResources;
    const showResources = !isPhone || focusedIsResources;
    return (
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
        {showRegionSwitcher && (
          <RegionSwitcher
            regions={bandRegions}
            selectedId={switcherSelectedId}
            onFocusRegion={onFocusRegion}
            ariaLabel={switcherLabel}
          />
        )}
        <Box ref={splitContainerRef} sx={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
          {!railCollapsed && (
            <Box sx={{ width: railWidth, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              {railNode}
            </Box>
          )}
          {showScripture && (
            <Box
              sx={{
                width: showResources ? `${effectiveSplit * 100}%` : "100%",
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {renderRegion(scriptureRegion)}
            </Box>
          )}
          {showScripture && showResources && (
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
          )}
          {showResources && (
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
          )}
        </Box>
      </Box>
    );
  }

  // ── Generic (non-classic): walk the recursive split tree. Each SplitNode is a
  // Group with one Panel per child (Separators between); each PanelRegion leaf
  // renders its Shell-built content. The rail stays OUTSIDE the resizable tree.
  // The closed set, as a map for the pure visibility helper. Derived from the
  // already-resolved `closedRegions` PLUS `bandHiddenRegions` so there is one
  // merged source of truth for "what is invisible right now" — the renderer
  // below doesn't need to know WHY a region is hidden (the user closed it vs.
  // the viewport can't fit it), only that it is. The two sets stay separate
  // everywhere else (Shell never persists bandHiddenRegions); they are only
  // combined here, at render time.
  const hiddenMap: HiddenMap = {};
  for (const r of closedRegions) hiddenMap[r.id] = true;
  for (const r of bandHiddenRegions) hiddenMap[r.id] = true;
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
          // absorb the closed region's share proportionally. Closing writes
          // nothing back (handleLayoutChanged ignores non-user layouts), so
          // reopening restores the original proportions. Caveat: dragging a
          // separator WHILE a sibling is closed persists renormalized fractions
          // for the survivors only, so the group can then sum to more than 1 and
          // reopening is approximate — which is why Shell's applyEffectiveSizes
          // renormalizes before baking those sizes into a saved layout.
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
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {showRegionSwitcher && (
        <RegionSwitcher
          regions={bandRegions}
          selectedId={switcherSelectedId}
          onFocusRegion={onFocusRegion}
          ariaLabel={switcherLabel}
        />
      )}
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
              // No `placement` override: the strip sits at the workspace's
              // INLINE-start, which is the screen's right under an RTL UI, and
              // `placement` is a JS prop that stylis-plugin-rtl cannot mirror — a
              // hard-coded "right" would open the tooltip off-viewport there.
              <Tooltip key={r.id} title={restoreLabel(r.label)}>
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
    </Box>
  );
}
