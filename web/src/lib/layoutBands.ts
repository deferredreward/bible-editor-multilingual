// Pure layout-band logic for the responsive workspace. No React, no DOM — this
// is what makes it unit-testable without a browser (see layoutBands.test.mjs).
//
// The project has three real layout bands: phone (<560), tablet (560-899),
// desktop (>=900). These mirror theme.ts's `tablet` / `md` breakpoint keys
// (kept in sync manually — theme.ts is the MUI-facing copy, this module is the
// DOM-free copy consumed by pure code and tests).

export type LayoutBand = "phone" | "tablet" | "desktop";

export const BAND_PX = { tablet: 560, wide: 820, desktop: 900 } as const;

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
    // max === 2 on tablet today, but written generically: keep the focused
    // region plus its following siblings, wrapping to preceding siblings when
    // there aren't enough following ones (e.g. focus is last).
    keepIndexes = [focusedIndex];
    let next = focusedIndex + 1;
    let prev = focusedIndex - 1;
    while (keepIndexes.length < max && (next < regionIds.length || prev >= 0)) {
      if (next < regionIds.length) {
        keepIndexes.push(next);
        next++;
      } else if (prev >= 0) {
        keepIndexes.push(prev);
        prev--;
      }
    }
  }

  const keep = new Set(keepIndexes);
  // Safety valve: never hide every region. If the computation somehow kept
  // none (shouldn't happen given the guards above, but this is the backstop
  // mirrored from layoutTree.resolveHidden's blank-workspace guard), keep the
  // first region.
  if (keep.size === 0) keep.add(0);

  return regionIds.filter((_, i) => !keep.has(i));
}
