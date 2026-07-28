// The workspace PERIMETER drop zone — a frame of four bands around the whole
// arrangeable workspace. Dropping on one wraps the ENTIRE layout tree in a new
// split, so the dragged panel becomes a full-width band (top/bottom) or a
// full-height column (left/right).
//
// WHY IT EXISTS: every other drop target is scoped to a region that already
// exists. Once the user drags the scripture panel out of Flexible's full-width
// top band, that region is empty, normalizeTree deletes it, the root split
// collapses to its single surviving child — and no region-scoped gesture can ever
// rebuild a band spanning the whole workspace again. Dropping on a column's top
// edge only splits that column. The perimeter is the recovery gesture.
//
// DISCOVERABILITY is half the fix: the user could not find the capability, so all
// four bands are visibly inviting the moment a panel drag starts, and the hovered
// one previews the exact band that will be created.
//
// Rendered only from WorkspaceLayout's recursive (non-Classic) path, and the bands
// exist only while a PANEL drag is in flight — so Classic never sees it and normal
// interaction is never covered by an invisible frame.
//
// The pointer arithmetic (including RTL mirroring) is NOT here: it lives in
// lib/dropZone.ts (computeOuterDropTarget) so it can be unit-tested with no DOM.
// Everything painted here is positioned with CSS LOGICAL insets, so it is correct
// in both directions without mirroring anything itself — see computeOuterDropBand.

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import {
  OUTER_BAND_PX,
  computeOuterDropBand,
  computeOuterDropTarget,
  type Direction,
  type OuterBandEdge,
} from "../lib/dropZone";
import type { OuterDropTarget } from "../lib/layoutTree";
import { useLayoutDrag } from "./LayoutDragContext";

const EDGES: OuterBandEdge[] = ["blockStart", "blockEnd", "inlineStart", "inlineEnd"];

interface Resolved {
  target: OuterDropTarget;
  edge: OuterBandEdge;
  // Fraction of the workspace the resulting band will occupy.
  size: number;
}

// Absolute placement for a band or its preview: `extent` is the CSS length along
// the band's own axis (a px thickness for the hit band, a percentage for the
// preview of the real thing).
function place(edge: OuterBandEdge, extent: string): Record<string, string | number> {
  switch (edge) {
    case "blockStart":
      return { insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: extent };
    case "blockEnd":
      return { insetInlineStart: 0, insetInlineEnd: 0, bottom: 0, height: extent };
    case "inlineStart":
      return { top: 0, bottom: 0, insetInlineStart: 0, width: extent };
    default:
      return { top: 0, bottom: 0, insetInlineEnd: 0, width: extent };
  }
}

export function OuterDropZone() {
  const { t } = useTranslation();
  const drag = useLayoutDrag();
  const draggedPanelId = drag?.draggedPanelId ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Resolved | null>(null);
  const hoverKeyRef = useRef("");

  const clear = useCallback(() => {
    if (hoverKeyRef.current !== "") {
      hoverKeyRef.current = "";
      setHover(null);
    }
  }, []);

  // Any end of the drag (drop elsewhere, Escape, dragend) must wipe the preview —
  // dragleave is not guaranteed to fire in those cases.
  useEffect(() => {
    if (!draggedPanelId) clear();
  }, [draggedPanelId, clear]);

  // Measure on demand rather than caching: the perimeter is only hit-tested while
  // the pointer is inside a 22px band, so this runs far less often than a region's
  // dragover, and a fresh rect is immune to a mid-drag resize.
  const resolve = useCallback((clientX: number, clientY: number): Resolved | null => {
    const el = ref.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    // Read the EFFECTIVE direction off the element (an ancestor carries `dir`),
    // never off a prop or theme flag.
    const computed = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const direction: Direction = computed?.direction === "rtl" ? "rtl" : "ltr";
    const target = computeOuterDropTarget({
      rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      pointer: { x: clientX, y: clientY },
      direction,
    });
    if (!target) return null;
    return { target, ...computeOuterDropBand(target) };
  }, []);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    // Only PANEL drags concern us; the repo has other HTML5 drags (note
    // reordering) which must pass through untouched.
    if (!draggedPanelId) return;
    e.preventDefault(); // without this the browser never fires `drop`
    try {
      e.dataTransfer.dropEffect = "move";
    } catch {
      /* ignore */
    }
    const next = resolve(e.clientX, e.clientY);
    const k = next ? next.edge : "";
    if (k === hoverKeyRef.current) return; // same band — no re-render
    hoverKeyRef.current = k;
    setHover(next);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId) return;
    // Ask where the pointer is GOING: moving between two adjacent bands never
    // leaves this frame, so a blanket clear here would flicker the preview off.
    const related = e.relatedTarget as Node | null;
    if (related && ref.current && ref.current.contains(related)) return;
    clear();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggedPanelId || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    // Recompute rather than trusting the last hover: a drop can arrive with no
    // preceding dragover tick.
    const resolved = resolve(e.clientX, e.clientY);
    clear();
    if (resolved) drag.commitDrop(resolved.target);
    drag.endDrag();
  };

  return (
    // zIndex sits above the regions' own preview overlays (zIndex 4) so the
    // perimeter wins whenever the pointer is inside a band.
    <Box ref={ref} sx={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}>
      {/* Bands exist ONLY while a panel is in flight — otherwise a frame of
          pointer-events:auto elements would sit on top of the workspace. */}
      {draggedPanelId !== null &&
        EDGES.map((edge) => (
          <Box
            key={edge}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            sx={{
              position: "absolute",
              pointerEvents: "auto", // load-bearing: a band must RECEIVE dragover/drop
              ...place(edge, `${OUTER_BAND_PX}px`),
              boxSizing: "border-box",
              border: "2px dashed",
              borderColor: hover?.edge === edge ? "primary.main" : "primary.light",
              bgcolor: "primary.main",
              opacity: hover?.edge === edge ? 0.4 : 0.14,
              borderRadius: 1,
              transition: "opacity 0.12s",
            }}
          />
        ))}
      {draggedPanelId !== null && hover && (
        // The resulting band, previewed at its real size. pointer-events:none —
        // an overlay that swallowed dragover would freeze the preview.
        <Box
          sx={{
            position: "absolute",
            ...place(hover.edge, `${hover.size * 100}%`),
            pointerEvents: "none",
            bgcolor: "primary.main",
            opacity: 0.18,
            border: "2px solid",
            borderColor: "primary.main",
            borderRadius: 1,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            variant="caption"
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: 1,
              bgcolor: "background.paper",
              color: "primary.main",
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {t(hover.target.orientation === "vertical" ? "layout.dockFullWidth" : "layout.dockFullHeight")}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
