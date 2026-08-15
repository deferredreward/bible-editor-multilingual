// Pure layout-band logic for the responsive workspace. No React, no DOM — this
// is what makes it unit-testable without a browser (see layoutBands.test.mjs).
//
// The project has three real layout bands: phone (<560), tablet (560-899),
// desktop (>=900). theme.ts imports BAND_PX from here and uses it for its
// `tablet` / `md` breakpoint values, so there is exactly one source of truth
// for the thresholds — see theme.ts's comment.

export type LayoutBand = "phone" | "tablet" | "desktop";

export const BAND_PX = { tablet: 560, desktop: 900 } as const;

export function bandForWidth(width: number): LayoutBand {
  if (width < BAND_PX.tablet) return "phone";
  if (width < BAND_PX.desktop) return "tablet";
  return "desktop";
}

// How many regions a band can show at once before the rest must be hidden
// behind the switcher. Desktop has no cap.
export function maxVisibleRegions(band: LayoutBand): number {
  if (band === "phone") return 1;
  if (band === "tablet") return 2;
  return Infinity;
}

// Which region ids to hide FOR THIS BAND ONLY. This is a render-time overlay
// computed fresh on every call — never persisted (see the CRITICAL note in
// Shell.tsx's wiring: band-hidden ids must never reach layoutStore or the
// user's closedRegions set, or shrinking the window would permanently lose
// regions on the next reopen).
export function resolveBandHidden(
  regionIds: string[],
  band: LayoutBand,
  focusedRegionId: string | null,
): string[] {
  if (band === "desktop") return [];
  const max = maxVisibleRegions(band);
  if (regionIds.length <= max) return [];

  const focusedIndex = focusedRegionId !== null ? regionIds.indexOf(focusedRegionId) : -1;

  let keepIndexes: number[];
  if (focusedIndex === -1) {
    // No focus (or a focus id not present in this band's region set): keep the
    // first N in tree order.
    keepIndexes = regionIds.map((_, i) => i).slice(0, max);
  } else if (max === 1) {
    keepIndexes = [focusedIndex];
  } else {
    // max === 2 is the only case that reaches here (maxVisibleRegions never
    // returns anything else besides 1 and Infinity, and Infinity took the
    // `band === "desktop"` return above) — keep the focused region plus its
    // following sibling, or its preceding sibling when focus is last.
    const next = focusedIndex + 1;
    keepIndexes =
      next < regionIds.length ? [focusedIndex, next] : [focusedIndex, focusedIndex - 1];
  }

  const keep = new Set(keepIndexes);
  return regionIds.filter((_, i) => !keep.has(i));
}
