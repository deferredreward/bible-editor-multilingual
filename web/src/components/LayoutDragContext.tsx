// Shared drag state for tiled panel docking.
//
// The drag SOURCE (PanelChrome's grip) and the drop TARGETS (RegionDropZone) are
// rendered by different code paths — Shell's renderRegion builds both, but they
// end up in unrelated branches of WorkspaceLayout's tree — so the "what is being
// dragged" bit has to live above them. Shell owns it and publishes it here.
//
// Why React state and not just dataTransfer: dataTransfer's payload is
// unreadable during `dragover` in every browser (only the TYPES are exposed), so
// the hit-test could not know which panel is in flight, and — more importantly —
// the repo has OTHER HTML5 drags (note reordering inside a resource panel). A
// region must ignore those, and `draggedPanelId === null` is exactly that test.
// `dataTransfer.setData` is still called at dragstart, because Firefox refuses
// to start a drag without it.
//
// Not provided at all for builtin:classic — Shell never wraps Classic's regions
// in a RegionDropZone and never renders PanelChrome for them, so nothing under
// Classic consumes this.

import { createContext, useContext } from "react";
import type { DropTarget } from "../lib/layoutTree";

export interface LayoutDragValue {
  // The panel currently being dragged by its grip, or null when no PANEL drag is
  // in flight (a note drag, a text selection drag, … all read as null).
  draggedPanelId: string | null;
  beginDrag: (panelId: string) => void;
  endDrag: () => void;
  // Commit a drop. Implemented by Shell: movePanel + persist + re-render.
  commitDrop: (target: DropTarget) => void;
}

const LayoutDragContext = createContext<LayoutDragValue | null>(null);

export const LayoutDragProvider = LayoutDragContext.Provider;

// Null when there is no provider — i.e. under Classic, or in any tree that has
// not opted into arranging. Callers must handle null.
export function useLayoutDrag(): LayoutDragValue | null {
  return useContext(LayoutDragContext);
}
