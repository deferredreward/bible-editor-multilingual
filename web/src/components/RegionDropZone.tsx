// A region's drop target + drop preview overlay.
//
// Wraps whatever Shell renders for ONE region in an arrangeable (non-Classic)
// layout. Classic's regions are never wrapped — Shell returns their content raw —
// so none of this code is reachable from builtin:classic.
//
// The pointer→DropTarget arithmetic (including RTL mirroring) is NOT here: it
// lives in lib/dropZone.ts so it can be unit-tested without a DOM. This
// component's only jobs are measuring the DOM, throttling that measurement, and
// painting the preview.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box } from "@mui/material";
import {
  bandInsets,
  computeDropPreview,
  computeDropTarget,
  type DropPreview,
  type DropZoneInput,
  type Rect,
} from "../lib/dropZone";
import type { RegionDropTarget } from "../lib/layoutTree";
import { useLayoutDrag } from "./LayoutDragContext";

// Re-measuring every panel's box on every dragover tick is the obvious
// performance trap (dragover fires continuously). Geometry is measured once per
// region-entry and then reused; it is only refreshed when this stale, so a
// scroll or a resize mid-drag still corrects itself within a few frames.
const GEOMETRY_MAX_AGE_MS = 250;

type Geometry = Omit<DropZoneInput, "pointer">;

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// A cheap identity for a resolved target, so a dragover tick that lands in the
// same zone as the previous one causes no React re-render.
function targetKey(target: RegionDropTarget | null): string {
  if (!target) return "";
  const p = target.placement;
  return p.kind === "into"
    ? `${target.regionId}|into|${p.index ?? "end"}`
    : `${target.regionId}|split|${p.orientation}|${p.side}`;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

interface RegionDropZoneProps {
  regionId: string;
  children: ReactNode;
}

export function RegionDropZone({ regionId, children }: RegionDropZoneProps) {
  const drag = useLayoutDrag();
  const draggedPanelId = drag?.draggedPanelId ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const geomRef = useRef<{ at: number; geometry: Geometry } | null>(null);
  const [hover, setHover] = useState<{ target: RegionDropTarget; preview: DropPreview } | null>(null);
  const hoverKeyRef = useRef("");

  const clear = useCallback(() => {
    geomRef.current = null;
    if (hoverKeyRef.current !== "") {
      hoverKeyRef.current = "";
      setHover(null);
    }
  }, []);

  // Any end of the drag (drop elsewhere, Escape, dragend) must wipe this
  // region's preview — dragleave is not guaranteed to fire in those cases.
  useEffect(() => {
    if (!draggedPanelId) clear();
  }, [draggedPanelId, clear]);

  const readGeometry = useCallback((panelId: string): Geometry | null => {
    const el = ref.current;
    if (!el) return null;
    // A region is a LEAF of the layout tree, so this subtree contains only this
    // region's own panels — no cross-region contamination possible.
    const panelEls = Array.from(el.querySelectorAll<HTMLElement>("[data-be-panel-id]"));
    const panelIds: string[] = [];
    const panelRects: Rect[] = [];
    for (const p of panelEls) {
      const id = p.dataset.bePanelId;
      if (!id) continue;
      panelIds.push(id);
      panelRects.push(toRect(p.getBoundingClientRect()));
    }
    // Read the EFFECTIVE direction off the element: the app sets `dir` on an
    // ancestor, so a prop or a theme flag would be the wrong source of truth.
    const computed = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    return {
      rect: toRect(el.getBoundingClientRect()),
      direction: computed?.direction === "rtl" ? "rtl" : "ltr",
      panelRects,
      panelIds,
      draggedPanelId: panelId,
      currentRegionId: regionId,
    };
  }, [regionId]);

  // Resolve the pointer to a DropTarget, measuring (or reusing) geometry.
  const resolve = useCallback(
    (clientX: number, clientY: number, panelId: string): { target: RegionDropTarget; preview: DropPreview } | null => {
      const t = now();
      let cached = geomRef.current;
      if (!cached || cached.geometry.draggedPanelId !== panelId || t - cached.at > GEOMETRY_MAX_AGE_MS) {
        const fresh = readGeometry(panelId);
        if (!fresh) return null;
        cached = { at: t, geometry: fresh };
        geomRef.current = cached;
      }
      const input: DropZoneInput = { ...cached.geometry, pointer: { x: clientX, y: clientY } };
      const target = computeDropTarget(input);
      return { target, preview: computeDropPreview(input, target) };
    },
    [readGeometry],
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // Only PANEL drags concern us. The repo has other HTML5 drags (note
    // reordering inside a resource panel); those leave draggedPanelId null and
    // must pass through untouched — no preventDefault, no preview.
    if (!draggedPanelId) return;
    // Without preventDefault the browser never fires `drop`.
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      /* ignore */
    }
    const next = resolve(e.clientX, e.clientY, draggedPanelId);
    const key = targetKey(next?.target ?? null);
    if (key === hoverKeyRef.current) return; // same zone — no re-render
    hoverKeyRef.current = key;
    setHover(next);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId) return;
    e.preventDefault();
    geomRef.current = null; // force a fresh measure on the next dragover
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId) return;
    // dragleave bubbles up from every descendant, so `e.target === el` is a
    // fragile test (the mockup's bug). Ask instead where the pointer is GOING:
    // if the next element is still inside this region, we never left it.
    // relatedTarget is null when the pointer leaves the window entirely, which
    // does count as leaving.
    const related = e.relatedTarget as Node | null;
    if (related && ref.current && ref.current.contains(related)) return;
    clear();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    // Recompute rather than trusting the last hover: a drop can arrive without a
    // preceding dragover tick in this region.
    const resolved = resolve(e.clientX, e.clientY, draggedPanelId);
    clear();
    if (resolved) drag.commitDrop(resolved.target);
    drag.endDrag();
  };

  return (
    <Box
      ref={ref}
      data-be-region-id={regionId}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        ...(hover
          ? { outline: "2px dashed", outlineColor: "primary.main", outlineOffset: "-3px" }
          : null),
      }}
    >
      {children}
      {hover && (
        // pointer-events:none is load-bearing — an overlay that swallowed
        // dragover would freeze the preview and kill the drop.
        <Box sx={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}>
          {hover.preview.kind === "area" ? (
            <Box
              sx={{
                position: "absolute",
                // LOGICAL insets, from the same helper the perimeter bands use.
                // Painting a physical `left` here would be mirrored a second time
                // by stylis-plugin-rtl under an Arabic UI, putting the preview on
                // the opposite side from the drop — see DropPreview in dropZone.ts.
                ...bandInsets(hover.preview.edge, `${hover.preview.extent * 100}%`),
                bgcolor: "primary.main",
                opacity: 0.18,
                border: "2px solid",
                borderColor: "primary.main",
                borderRadius: 1,
                boxSizing: "border-box",
              }}
            />
          ) : (
            <Box
              sx={{
                position: "absolute",
                left: 2,
                right: 2,
                top: `${hover.preview.top * 100}%`,
                height: "3px",
                bgcolor: "primary.main",
                borderRadius: "2px",
                transform: "translateY(-1.5px)",
              }}
            />
          )}
        </Box>
      )}
    </Box>
  );
}
