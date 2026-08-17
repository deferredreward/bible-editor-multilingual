// useSwipeNav — horizontal touch-swipe navigation for the translate queue
// screens (Benjamin, 2026-08-10: "swiping should let you change notes/etc").
//
// Attach the returned handlers to the scrolling content container. A swipe
// counts only when it is decisively horizontal (|dx| >= 64px and more than
// twice the vertical travel), single-touch, and did not START inside an
// editing or drag surface — input, textarea, contenteditable, an HTML5
// draggable, or anything under [data-no-swipe]. That guard is what keeps
// text selection, textarea cursor drags, and the aligner's drag canvas from
// triggering navigation.
//
// Direction is reading-order aware: in LTR, swiping toward the left advances
// (like turning a page forward); under RTL the mapping flips.
import { useRef } from "react";
import type React from "react";

export interface SwipeNavHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
}

export function useSwipeNav(opts: {
  onPrev: () => void;
  onNext: () => void;
  /** Pass false to disable (e.g. while a dialog is open). Default true. */
  enabled?: boolean;
  /** Reading direction of the CONTENT being paged, not the UI chrome. */
  rtl?: boolean;
}): SwipeNavHandlers {
  const start = useRef<{ x: number; y: number } | null>(null);

  function blocked(t: EventTarget | null): boolean {
    if (!(t instanceof Element)) return false;
    return (
      t.closest(
        'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [draggable="true"], [data-no-swipe]',
      ) !== null
    );
  }

  return {
    onTouchStart: (e) => {
      const t = e.touches[0];
      if (opts.enabled === false || e.touches.length !== 1 || !t || blocked(e.target)) {
        start.current = null;
        return;
      }
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s || opts.enabled === false) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < 64 || Math.abs(dx) <= 2 * Math.abs(dy)) return;
      const forward = opts.rtl ? dx > 0 : dx < 0;
      if (forward) opts.onNext();
      else opts.onPrev();
    },
  };
}
