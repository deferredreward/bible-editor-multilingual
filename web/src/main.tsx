import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { CacheProvider } from "@emotion/react";
import createCache from "@emotion/cache";
import { prefixer } from "stylis";
import rtlPlugin from "stylis-plugin-rtl";
import {
  makeTheme,
  ThemeModeContext,
  FontScaleContext,
  clampFontScale,
  FONT_SCALE_DEFAULT,
  type ThemeMode,
} from "./theme";
import i18n, { dirForLang, loadInitialUiLang, persistUiLang } from "./i18n";
import { applyOverrides } from "./i18n/overrides";
import { UiLangContext } from "./i18n/UiLangContext";
import { api } from "./sync/api";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installCurlyQuotes } from "./lib/curlyQuotes";

installCurlyQuotes();

const THEME_MODE_KEY = "be:themeMode";
const FONT_SCALE_KEY = "be:fontScale";

// Two emotion caches, one per direction. The RTL cache runs every style rule
// through stylis-plugin-rtl, which is what actually mirrors MUI's generated
// CSS (margins, paddings, absolute insets) — theme.direction alone only flips
// the components that consult it explicitly. Created once at module scope:
// recreating a cache remounts every style, which flashes the whole app.
const ltrCache = createCache({ key: "mui" });
const rtlCache = createCache({ key: "muirtl", stylisPlugins: [prefixer, rtlPlugin] });

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
  // Same for direction: a persisted RTL language must not flash LTR chrome.
  const initialLang = loadInitialUiLang();
  document.documentElement.setAttribute("lang", initialLang);
  document.documentElement.setAttribute("dir", dirForLang(initialLang));
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(loadInitialMode);
  const [scale, setScale] = useState<number>(loadInitialScale);
  const [lang, setLangState] = useState<string>(loadInitialUiLang);

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

  const dir = dirForLang(lang);

  // Fetch server-stored UI-string overrides once at boot and layer them over the
  // bundled locales, so everyone picks up the org's latest wording without a
  // rebuild (Localization tab; migration 0052). Fire-and-forget: a failure just
  // leaves the bundled strings in place, and bindI18nStore repaints on apply.
  useEffect(() => {
    let cancelled = false;
    void api
      .getL10nOverrides()
      .then(({ overrides }) => {
        if (!cancelled) applyOverrides(overrides);
      })
      .catch(() => {
        /* offline / unauth — bundled strings stand */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void i18n.changeLanguage(lang);
    persistUiLang(lang);
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", dir);
  }, [lang, dir]);

  const toggle = useCallback(() => {
    setMode((m) => (m === "dark" ? "light" : "dark"));
  }, []);

  const setScaleClamped = useCallback((n: number) => {
    setScale(clampFontScale(n));
  }, []);

  const setLang = useCallback((code: string) => {
    setLangState(code);
  }, []);

  const theme = useMemo(() => makeTheme(mode, dir), [mode, dir]);
  const ctx = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  const scaleCtx = useMemo(() => ({ scale, setScale: setScaleClamped }), [scale, setScaleClamped]);
  const langCtx = useMemo(() => ({ lang, setLang }), [lang, setLang]);

  return (
    <UiLangContext.Provider value={langCtx}>
      <ThemeModeContext.Provider value={ctx}>
        <FontScaleContext.Provider value={scaleCtx}>
          <CacheProvider value={dir === "rtl" ? rtlCache : ltrCache}>
            <ThemeProvider theme={theme}>
              <CssBaseline />
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </ThemeProvider>
          </CacheProvider>
        </FontScaleContext.Provider>
      </ThemeModeContext.Provider>
    </UiLangContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
