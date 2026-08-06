import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import type { LayoutBand } from "../lib/layoutBands";

export interface UseLayoutBandResult {
  band: LayoutBand;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isWide: boolean;
}

// The reactive, SSR-safe read of the current layout band. Built on MUI's
// useMediaQuery against the theme's breakpoint keys (theme.ts) rather than
// window.innerWidth, so a resize re-renders this hook's consumers instead of
// requiring a manual resize listener, and it never throws on first render
// server-side (useMediaQuery defaults to `false` for every query before the
// browser's matchMedia is available).
export function useLayoutBand(): UseLayoutBandResult {
  const theme = useTheme();
  // "phone" band: below the tablet breakpoint (560px).
  const isPhone = useMediaQuery(theme.breakpoints.down("tablet"));
  // "desktop" band: at or above the md breakpoint, which is deliberately
  // reused as the desktop boundary (900px) — see theme.ts's comment.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  // >= 820px, independent of the phone/tablet/desktop band — used by callers
  // that want a finer-grained "is there enough width for one more thing"
  // signal within the tablet band.
  const isWide = useMediaQuery(theme.breakpoints.up("wide"));

  const band: LayoutBand = isPhone ? "phone" : isDesktop ? "desktop" : "tablet";

  return {
    band,
    isPhone: band === "phone",
    isTablet: band === "tablet",
    isDesktop: band === "desktop",
    isWide,
  };
}
