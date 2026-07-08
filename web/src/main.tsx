import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import {
  makeTheme,
  ThemeModeContext,
  FontScaleContext,
  clampFontScale,
  FONT_SCALE_DEFAULT,
  type ThemeMode,
} from "./theme";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installCurlyQuotes } from "./lib/curlyQuotes";

installCurlyQuotes();

const THEME_MODE_KEY = "be:themeMode";
const FONT_SCALE_KEY = "be:fontScale";

function loadInitialMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function loadInitialScale(): number {
  try {
    const raw = localStorage.getItem(FONT_SCALE_KEY);
    if (raw) return clampFontScale(parseFloat(raw));
  } catch {
    /* ignore */
  }
  return FONT_SCALE_DEFAULT;
}

// Set the CSS var synchronously before first paint so a persisted non-default
// scale doesn't flash the reading text at 100% on load.
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty("--be-reading-scale", String(loadInitialScale()));
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(loadInitialMode);
  const [scale, setScale] = useState<number>(loadInitialScale);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  useEffect(() => {
    document.documentElement.style.setProperty("--be-reading-scale", String(scale));
    try {
      localStorage.setItem(FONT_SCALE_KEY, String(scale));
    } catch {
      /* ignore */
    }
  }, [scale]);

  const toggle = useCallback(() => {
    setMode((m) => (m === "dark" ? "light" : "dark"));
  }, []);

  const setScaleClamped = useCallback((n: number) => {
    setScale(clampFontScale(n));
  }, []);

  const theme = useMemo(() => makeTheme(mode), [mode]);
  const ctx = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  const scaleCtx = useMemo(() => ({ scale, setScale: setScaleClamped }), [scale, setScaleClamped]);

  return (
    <ThemeModeContext.Provider value={ctx}>
      <FontScaleContext.Provider value={scaleCtx}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <AppErrorBoundary>
            <App />
          </AppErrorBoundary>
        </ThemeProvider>
      </FontScaleContext.Provider>
    </ThemeModeContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
