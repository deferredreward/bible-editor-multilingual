import { useEffect, useRef, useState } from "react";
import { drafts } from "../sync/drafts";

// Warn before a full-page unload (reload — including the "App update available"
// chip's programmatic reload — tab close, or external navigation) when unsaved
// work would be lost. In-app navigation is already gated (runWithDirtyGate /
// requestDualAction in Shell); this covers the paths that tear the page down
// without ever routing through React.
//
// This is the safety net that was missing when a version-bump reload silently
// dropped a chapter of alignment work: alignment drags live only in React state
// until an explicit save, so a reload mid-alignment loses them with no trace.
// Text / note / row drafts persist in IndexedDB and survive the reload, but a
// translator who reloads past them still has to notice and re-save, so we warn
// for those too.
//
// beforeunload cannot run async work (no flushing IndexedDB from here) — the
// spec only lets us ask the browser to show its generic "Leave site? Changes
// you made may not be saved" confirm. That prompt is the guard; the user
// cancels, saves through the normal UI, then reloads.
export function useUnsavedGuard(panelDirty: boolean): void {
  const [hasDrafts, setHasDrafts] = useState(false);
  useEffect(() => drafts.subscribe((all) => setHasDrafts(all.length > 0)), []);

  // Read through a ref so the listener can stay installed once (stable identity)
  // and always see the latest dirtiness without re-adding on every change.
  const activeRef = useRef(false);
  activeRef.current = panelDirty || hasDrafts;

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      // Legacy Chrome requires returnValue to be set for the prompt to show.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
