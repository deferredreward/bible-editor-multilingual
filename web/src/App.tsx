import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Link, Snackbar, Stack, Typography } from "@mui/material";
import { Shell } from "./components/Shell";
import { ArticleWorkspace } from "./components/ArticleWorkspace";
import { TopBar } from "./components/TopBar";
import { TemplateWorkspace } from "./components/TemplateWorkspace";
import { ImportWorkspace } from "./components/ImportWorkspace";
import { ReviewQueue } from "./components/ReviewQueue";
import { PreferencesWorkspace, ALL_SECTIONS as PREFS_SECTIONS, type Section as PrefsSection } from "./components/PreferencesWorkspace";
import { LocalizationInspector } from "./components/LocalizationInspector";
import { useBook } from "./hooks/useBook";
import { useAlerts } from "./hooks/useAlerts";
import {
  authLogout,
  devSignIn,
  fetchAuthMe,
  onAuthError,
  setReadOnly,
  setIsAdmin,
  updateLastLocation,
  type MeResponse,
  type Role,
} from "./sync/api";
import { setPipelineUser } from "./sync/pipelineStore";
import { getWorkspaceSlug, setWorkspaceSlug, setWorkspaceIsFallback } from "./sync/workspace";
import {
  WorkspaceChoiceDialog,
  markChooseWsPending,
  isChooseWsPending,
} from "./components/WorkspaceChoiceDialog";

type Location =
  | { view: "chapter"; book: string; chapter: number; verse: number }
  | { view: "article"; resource: "tw" | "ta"; articleId: string | null }
  | { view: "templates"; templateId: string | null }
  | { view: "import"; book: string | null; chapter: number | null; verse: number | null }
  | { view: "preferences"; section: PrefsSection }
  | { view: "review"; book: string; chapter: number }
  | { view: "home" }
  | { view: "scripture"; book: string; chapter: number; verse: number }
  | { view: "align"; book: string; chapter: number; verse: number }
  | { view: "flowArticles" }
  | { view: "words"; book: string; chapter: number; verse: number }
  | { view: "ai" }
  | { view: "style" }
  | { view: "curate"; templateId: string | null }
  | { view: "setup" }
  | { view: "books" }
  | { view: "team" }
  | { view: "observe" }
  | { view: "verse"; book: string; chapter: number; verse: number }
  | { view: "notes"; book: string; chapter: number; verse: number | null }
  | { view: "questions"; book: string; chapter: number }
  | { view: "package"; book: string }
  | { view: "translateWords"; book: string }
  | { view: "translateScripture"; book: string; chapter: number }
  | { view: "translateAlign"; book: string; chapter: number; verse: number; mode: "single" | "dual" }
  | { view: "admin"; section: "team" | "setup" | "workflow" | "progress" };

// Flow screens (docs/flows port) are lazy so their weight isn't paid on the
// classic editor routes. Stubs today; replaced screen-by-screen in this stack.
const HomeScreen = lazy(() => import("./components/flows/HomeScreen"));
const ScriptureScreen = lazy(() => import("./components/flows/ScriptureScreen"));
const AlignScreen = lazy(() => import("./components/flows/AlignScreen"));
const ArticlesScreen = lazy(() => import("./components/flows/ArticlesScreen"));
const WordsScreen = lazy(() => import("./components/flows/WordsScreen"));
const AiScreen = lazy(() => import("./components/flows/AiScreen"));
const StyleScreen = lazy(() => import("./components/flows/StyleScreen"));
const CurateScreen = lazy(() => import("./components/flows/CurateScreen"));
const SetupScreen = lazy(() => import("./components/flows/SetupScreen"));
const BooksScreen = lazy(() => import("./components/flows/BooksScreen"));
const TeamScreen = lazy(() => import("./components/flows/TeamScreen"));
const ObserveScreen = lazy(() => import("./components/flows/ObserveScreen"));
const VerseScreen = lazy(() => import("./components/flows/VerseScreen"));
const TranslateNotesScreen = lazy(() => import("./components/flows/TranslateNotesScreen"));
const TranslateQuestionsScreen = lazy(() => import("./components/flows/TranslateQuestionsScreen"));
const TranslateScriptureScreen = lazy(() => import("./components/flows/TranslateScriptureScreen"));
const TranslateWordsScreen = lazy(() => import("./components/flows/TranslateWordsScreen"));
const PackageHubScreen = lazy(() => import("./components/flows/PackageHubScreen"));
const TranslateAlignScreen = lazy(() => import("./components/flows/TranslateAlignScreen"));
const AdminTeamScreen = lazy(() => import("./components/flows/AdminTeamScreen"));
const AdminSetupScreen = lazy(() => import("./components/flows/AdminSetupScreen"));
const AdminWorkflowScreen = lazy(() => import("./components/flows/AdminWorkflowScreen"));
const AdminProgressScreen = lazy(() => import("./components/flows/AdminProgressScreen"));

// OBA (Obadiah) is the shortest book in the canon — one chapter, 21 verses.
// Used as the fallback book code for partial routes (e.g. a hash with a
// chapter/verse but no book) and as the initial book for useBook before a
// chapter view is active. The default landing page is Books (#/books), not
// a chapter view, so this no longer controls landing-page load weight.
const DEFAULT_BOOK = "OBA";

// Set when the user explicitly clicks "Sign out". Read at boot to suppress
// the dev-mode silent re-mint and show the signed-out screen instead.
// This is a UX flag only — auth state lives in HttpOnly cookies and is
// gone by the time we read this. Cleared on next successful sign-in.
const SIGNED_OUT_KEY = "bible-editor.signed_out";

// Guards the boot-time workspace reconciliation below from looping forever
// if the server and localStorage can never agree (shouldn't happen, but a
// persistent mismatch must not reload-loop the tab). Cleared once the two
// agree so a later genuine mismatch (e.g. a stale cookie from another tab)
// still gets one reconciliation attempt.
const WS_RECONCILED_KEY = "bible-editor.ws-reconciled";

function parseHash(): Location {
  const pm = location.hash.match(/^#\/preferences(?:\/(\w+))?$/);
  if (pm) {
    const s = pm[1] as PrefsSection | undefined;
    return { view: "preferences", section: s && PREFS_SECTIONS.includes(s) ? s : "brief" };
  }
  const am = location.hash.match(/^#\/articles\/(tw|ta)(?:\/(.+))?$/);
  if (am) {
    return {
      view: "article",
      resource: am[1] as "tw" | "ta",
      articleId: decodeURIComponent(am[2] ?? "") || null,
    };
  }
  const tm = location.hash.match(/^#\/templates(?:\/(.+))?$/);
  if (tm) {
    return { view: "templates", templateId: decodeURIComponent(tm[1] ?? "") || null };
  }
  const im = location.hash.match(/^#\/import(?:\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?)?$/);
  if (im) {
    return {
      view: "import",
      book: im[1] ? im[1].toUpperCase() : null,
      chapter: im[2] ? parseInt(im[2], 10) : null,
      verse: im[3] ? parseInt(im[3], 10) : null,
    };
  }
  const rv = location.hash.match(/^#\/review\/([A-Za-z0-9]+)(?:\/(\d+))?$/);
  if (rv) {
    return { view: "review", book: rv[1].toUpperCase(), chapter: rv[2] ? parseInt(rv[2], 10) : 1 };
  }
  const nt = location.hash.match(/^#\/notes\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?$/);
  if (nt) {
    return {
      view: "notes",
      book: nt[1].toUpperCase(),
      chapter: nt[2] ? parseInt(nt[2], 10) : 1,
      verse: nt[3] ? parseInt(nt[3], 10) : null,
    };
  }
  const qn = location.hash.match(/^#\/questions\/([A-Za-z0-9]+)(?:\/(\d+))?$/);
  if (qn) {
    return { view: "questions", book: qn[1].toUpperCase(), chapter: qn[2] ? parseInt(qn[2], 10) : 1 };
  }
  // Flow screens (docs/flows port). Parameterless routes are single reserved
  // tokens; none collide with 3-letter USFM book codes in the catch-all below.
  if (/^#\/home$/.test(location.hash)) return { view: "home" };
  if (/^#\/articles$/.test(location.hash)) return { view: "flowArticles" };
  if (/^#\/ai$/.test(location.hash)) return { view: "ai" };
  if (/^#\/style$/.test(location.hash)) return { view: "style" };
  if (/^#\/setup$/.test(location.hash)) return { view: "setup" };
  if (/^#\/books$/.test(location.hash)) return { view: "books" };
  if (/^#\/team$/.test(location.hash)) return { view: "team" };
  if (/^#\/observe$/.test(location.hash)) return { view: "observe" };
  const cu = location.hash.match(/^#\/curate(?:\/(.+))?$/);
  if (cu) {
    return { view: "curate", templateId: decodeURIComponent(cu[1] ?? "") || null };
  }
  // Titus-redesign routes. These deliberately claim the short arities of
  // #/scripture and #/words ahead of the fv catch-all below: the 1–2 segment
  // forms open the new translate screens, while the 3-segment (verse-level)
  // forms still open the old flows screens until those are retired.
  const pk = location.hash.match(/^#\/package\/([A-Za-z0-9]+)$/);
  if (pk) {
    return { view: "package", book: pk[1].toUpperCase() };
  }
  const wb = location.hash.match(/^#\/words\/([A-Za-z0-9]+)$/);
  if (wb) {
    return { view: "translateWords", book: wb[1].toUpperCase() };
  }
  const ts = location.hash.match(/^#\/scripture\/([A-Za-z0-9]+)(?:\/(\d+))?$/);
  if (ts) {
    return {
      view: "translateScripture",
      book: ts[1].toUpperCase(),
      chapter: ts[2] ? parseInt(ts[2], 10) : 1,
    };
  }
  // Redesigned admin desk (#/admin/{section}); AdminDesk renders the rail.
  const ad = location.hash.match(/^#\/admin\/(team|setup|workflow|progress)$/);
  if (ad) {
    return { view: "admin", section: ad[1] as "team" | "setup" | "workflow" | "progress" };
  }
  // #/alignment (redesign) is distinct from the old 3-segment #/align, which
  // still flows to the fv catch-all below. Must sit above the final book-code
  // catch-all, which is unanchored and would swallow "alignment" as a book.
  const al = location.hash.match(/^#\/alignment\/([A-Za-z0-9]+)\/(\d+)(?:\/(\d+))?(\/dual)?$/);
  if (al) {
    return {
      view: "translateAlign",
      book: al[1].toUpperCase(),
      chapter: parseInt(al[2], 10),
      verse: al[3] ? parseInt(al[3], 10) : 1,
      mode: al[4] ? "dual" : "single",
    };
  }
  const fv = location.hash.match(
    /^#\/(scripture|align|words|verse)(?:\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?)?$/,
  );
  if (fv) {
    return {
      view: fv[1] as "scripture" | "align" | "words" | "verse",
      book: fv[2] ? fv[2].toUpperCase() : DEFAULT_BOOK,
      chapter: fv[3] ? parseInt(fv[3], 10) : 1,
      verse: fv[4] ? parseInt(fv[4], 10) : 1,
    };
  }
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  if (!m) return { view: "books" };
  return {
    view: "chapter",
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
  };
}

// Auth gate. The API requires a valid Access cookie for every write, so we
// must have one before mounting the editor — otherwise every save 401s.
//
// Boot sequence:
//   1. If the URL has ?_auth_denied=1, the OAuth callback rejected this DCS
//      account (not on the editor allowlist). Show the denied screen.
//   2. Otherwise call /api/auth/me. The HttpOnly Access cookie is sent
//      automatically; we never see the token itself. On 200 → ready; on
//      401 → fall through.
//   3. If the user explicitly signed out (SIGNED_OUT_KEY), stay in missing
//      — block the dev silent re-mint so the "Sign in with Door43" flow
//      is required after logout.
//   4. In dev mode, attempt /api/auth/dev silent mint. If 404 (disabled)
//      or any other failure → missing.
//   5. In prod, fall straight to missing.
type AuthState =
  | { kind: "loading" }
  | { kind: "ready"; me: MeResponse | null; role: Role }
  | { kind: "missing" }                            // not signed in — show "Sign in with Door43"
  | { kind: "denied"; username: string | null }    // signed in but not on editor allowlist
  | { kind: "error"; message: string };

function isSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function clearSignedOutFlag() {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* private mode */
  }
}

function useAuthGate(): [AuthState, (s: AuthState) => void] {
  const [state, setState] = useState<AuthState>(() => {
    const params = new URLSearchParams(location.search);
    // Step 1: OAuth callback rejected this account (not on the allowlist).
    if (params.get("_auth_denied")) {
      const username = params.get("u");
      history.replaceState(null, "", location.pathname + location.hash);
      return { kind: "denied", username };
    }
    return { kind: "loading" };
  });

  // loading → /api/auth/me probe → ready/missing/denied/error. The Access
  // cookie (if any) rides automatically. A successful 200 also clears any
  // stale signed_out flag — implicit "we got back in" signal.
  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;
    fetchAuthMe()
      .then(async (me) => {
        if (cancelled) return;
        if (me && (me.role === "admin" || me.role === "editor" || me.role === "viewer")) {
          clearSignedOutFlag();
          setReadOnly(me.role === "viewer");
          setIsAdmin(me.role === "admin");
          setState({ kind: "ready", me, role: me.role });
          return;
        }
        if (me && !me.role) {
          setState({ kind: "denied", username: me.username });
          return;
        }
        // me === null → 401, no cookie. Decide whether to silent-mint (dev)
        // or land on the sign-in screen.
        if (isSignedOut() || !import.meta.env.DEV) {
          setState({ kind: "missing" });
          return;
        }
        try {
          const devMe = await devSignIn("dev");
          if (cancelled) return;
          if (devMe.role !== "admin" && devMe.role !== "editor" && devMe.role !== "viewer") {
            setState({ kind: "denied", username: devMe.username });
            return;
          }
          clearSignedOutFlag();
          setReadOnly(devMe.role === "viewer");
          setIsAdmin(devMe.role === "admin");
          setState({ kind: "ready", me: devMe, role: devMe.role });
        } catch (err: unknown) {
          if (cancelled) return;
          const status = (err as { status?: number })?.status;
          if (status === 404) {
            // DEV_AUTH_ENABLED=false (e.g. running prod build locally).
            setState({ kind: "missing" });
          } else {
            setState({ kind: "error", message: String(err) });
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        if (status === 403) {
          setState({ kind: "denied", username: null });
        } else {
          setState({ kind: "error", message: String(err) });
        }
      });
    return () => { cancelled = true; };
  }, [state.kind]);

  return [state, setState];
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());
  // ?_choose_ws=1: the OAuth callback matched this account to SEVERAL Door43
  // orgs with no usable history and landed the session in the first match —
  // offer a one-time picker. Persisted to sessionStorage (markChooseWsPending)
  // because the workspace-reconciliation effect below may reload the tab once
  // before the dialog is seen; the initializer runs before useAuthGate's so
  // the flag survives its own history.replaceState URL cleanup too.
  const [chooseWs, setChooseWs] = useState<boolean>(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("_choose_ws")) {
      history.replaceState(null, "", location.pathname + location.hash);
      markChooseWsPending();
      return true;
    }
    return isChooseWsPending();
  });
  const [auth, setAuth] = useAuthGate();
  const [sessionExpired, setSessionExpired] = useState(false);
  // useBook is hoisted here so its chapter cache survives Shell remounts
  // (which happen when the user navigates between chapters via the URL).
  // Don't initialize it until auth is ready — the BookSummary fetch is now
  // gated and would otherwise burn a 401 every reload.
  const bookHook = useBook(
    loc.view === "chapter" ? loc.book : DEFAULT_BOOK,
    auth.kind === "ready" && loc.view === "chapter",
  );

  useEffect(() => {
    const handler = () => setLoc(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  useEffect(() => onAuthError(() => setSessionExpired(true)), []);

  const navigate = (book: string, chapter: number, verse?: number) => {
    location.hash =
      verse !== undefined && verse > 1
        ? `#/${book}/${chapter}/${verse}`
        : `#/${book}/${chapter}`;
  };

  // Remember the last scripture location so leaving preferences/articles
  // returns here instead of the default landing book (Obadiah). Only tracks
  // chapter views; a fresh load straight into preferences keeps the default.
  const lastScriptureRef = useRef<{ book: string; chapter: number; verse: number }>({
    book: DEFAULT_BOOK,
    chapter: 1,
    verse: 1,
  });
  if (loc.view === "chapter") {
    lastScriptureRef.current = { book: loc.book, chapter: loc.chapter, verse: loc.verse };
  }
  const backToScripture = () => {
    const { book, chapter, verse } = lastScriptureRef.current;
    navigate(book, chapter, verse);
  };

  // Workspace reconciliation. The server's be_ws cookie is the source of
  // truth for which org's D1 database we're talking to; localStorage is just
  // the client's mirror, and the outbox's IndexedDB name is derived from it
  // (see sync/outbox.ts). If they disagree — e.g. localStorage predates this
  // feature, or was left over from a different session on this device — pull
  // the server's value into localStorage and reload ONCE so the outbox opens
  // under the correct name from a cold start. Absent `me.workspace` means an
  // older cached /api/auth/me response; do nothing.
  useEffect(() => {
    if (auth.kind !== "ready") return;
    const serverWs = auth.me?.workspace;
    if (serverWs === undefined) return;
    const serverIsFallback = auth.me?.workspaceIsFallback;
    if (serverWs === getWorkspaceSlug()) {
      // Slug already agrees — still sync the fallback flag (it's cheap and
      // keeps outbox.ts's outboxDbName() correct even if it was never set,
      // e.g. an install that predates the fallback flag).
      if (serverIsFallback !== undefined) setWorkspaceIsFallback(serverIsFallback);
      try { sessionStorage.removeItem(WS_RECONCILED_KEY); } catch { /* private mode */ }
      return;
    }
    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(WS_RECONCILED_KEY) === "1"; } catch { /* private mode */ }
    if (alreadyTried) return; // already reloaded once this session — don't loop
    setWorkspaceSlug(serverWs);
    if (serverIsFallback !== undefined) setWorkspaceIsFallback(serverIsFallback);
    try { sessionStorage.setItem(WS_RECONCILED_KEY, "1"); } catch { /* private mode */ }
    location.reload();
  }, [auth]);

  // Debounced push of the current location to the server so the next sign-in
  // on a different device / after a logout can land back here.
  useEffect(() => {
    if (auth.kind !== "ready" || loc.view !== "chapter") return;
    const { book, chapter, verse } = loc;
    const t = setTimeout(() => {
      void updateLastLocation(book, chapter, verse);
    }, 1500);
    return () => clearTimeout(t);
  }, [auth.kind, loc]);

  // Must run before any of the early returns below — otherwise the hook is
  // conditionally invoked across renders (loading → ready calls one extra
  // hook), which violates Rules of Hooks. The hook itself no-ops while
  // auth is not "ready".
  const { alerts, dismiss } = useAlerts(auth.kind === "ready");

  useEffect(() => {
    setPipelineUser(auth.kind === "ready" ? auth.me?.userId ?? null : null);
  }, [auth]);

  if (auth.kind === "loading") {
    return (
      // 100dvh with a 100vh fallback — see the height comment on the main Shell
      // Box further down; plain 100vh sits under mobile browsers' URL bar.
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" } }}
        spacing={2}
      >
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">signing in…</Typography>
      </Stack>
    );
  }
  if (auth.kind === "missing") {
    // After an explicit logout (signed_out flag set) we surface a "queued
    // edits are safe" reassurance line. First-time visitors with no token
    // see the bare "Sign in to continue" screen instead — they have no
    // queued edits to worry about.
    const wasSignedOut = isSignedOut();
    const devSignInClick = () => {
      clearSignedOutFlag();
      setAuth({ kind: "loading" });
    };
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" } }}
        spacing={2}
      >
        <Typography variant="h6">
          {wasSignedOut ? "You're signed out" : "Sign in to continue"}
        </Typography>
        {wasSignedOut && (
          <Typography variant="body2" color="text.secondary">
            Queued edits stay in your browser until you sign back in.
          </Typography>
        )}
        <Button variant="contained" href="/api/auth/dcs/start" size="large">
          Sign in with Door43
        </Button>
        {import.meta.env.DEV && (
          <Button variant="text" size="small" onClick={devSignInClick}>
            Sign in (dev)
          </Button>
        )}
      </Stack>
    );
  }
  if (auth.kind === "denied") {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ height: "100vh", "@supports (height: 100dvh)": { height: "100dvh" }, px: 4 }}
        spacing={2}
      >
        <Typography variant="h6">Not authorized</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
          {auth.username
            ? `Your DCS account "${auth.username}" isn't on the editor allowlist for this app yet.`
            : `Your DCS account isn't on the editor allowlist for this app yet.`}
          {" "}If you should have access, ask an admin to add you.
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            // Server-side: clear cookies via logout, then start the OAuth
            // dance. The user still has to sign out of DCS separately to
            // actually switch accounts (DCS session cookie is sticky).
            void authLogout().finally(() => {
              location.href = "/api/auth/dcs/start";
            });
          }}
          size="small"
        >
          Sign in with a different Door43 account
        </Button>
      </Stack>
    );
  }
  if (auth.kind === "error") {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">auth failed: {auth.message}</Alert>
      </Box>
    );
  }

  const handleSignOut = async () => {
    // Server-side cleanup clears all three session cookies, revokes the
    // session row, and best-effort revokes the DCS access token. Set the
    // local UX flag so the next boot doesn't silent-mint in dev.
    await authLogout();
    try {
      localStorage.setItem(SIGNED_OUT_KEY, "1");
    } catch {
      /* private mode */
    }
    // Strip the URL hash too: leaving #/JON/3 around would confuse the next
    // boot into thinking the user requested a specific verse. Mirror that
    // into React state (replaceState doesn't fire hashchange) so the next
    // sign-in lands on the default Books screen instead of a stale deep link.
    history.replaceState(null, "", location.pathname);
    setLoc({ view: "books" });
    setAuth({ kind: "missing" });
  };

  const handleSessionExpired = () => {
    // Cookies are still set but the Access token expired and refresh failed
    // (e.g. session revoked). Send the user through OAuth in both dev and
    // prod — there's no silent recovery from this state.
    location.href = "/api/auth/dcs/start";
  };

  const isViewer = auth.kind === "ready" && auth.role === "viewer";

  return (
    <Box
      sx={{
        // 100dvh with a 100vh fallback — plain 100vh includes mobile browsers'
        // retractable URL bar, so the bottom of the app sits under it.
        height: "100vh",
        "@supports (height: 100dvh)": { height: "100dvh" },
        display: "flex",
        flexDirection: "column",
      }}
    >
      <LocalizationInspector />
      {alerts.length > 0 && (
        // Float the alert stack so it doesn't push Shell down — the outer
        // flex column's children can't actually shrink (Shell's internal
        // box rejects flex:1 minHeight:0 sizing), and any added in-flow
        // height makes <html> scroll the banner above the viewport.
        // Fixed positioning keeps the banner visible regardless of scroll
        // state and accepts the tradeoff of obscuring the top 44px of the
        // TopBar — appropriate UX for a "Benjamin fix this" alert.
        <Box
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: (theme) => theme.zIndex.appBar + 2,
          }}
        >
          {alerts.map((a) => (
            <Alert
              key={a.id}
              severity={a.severity}
              variant="filled"
              onClose={() => void dismiss(a.id)}
              sx={{ borderRadius: 0, py: 0.5 }}
            >
              {a.message}
              {/* Scheme check: linkUrl is server-authored, but React doesn't
                  block javascript: hrefs — only render a link for https. */}
              {a.linkUrl && /^https:\/\//.test(a.linkUrl) && (
                <>
                  {" — "}
                  <Link
                    href={a.linkUrl}
                    target="_blank"
                    rel="noopener"
                    color="inherit"
                    underline="always"
                  >
                    view run
                  </Link>
                </>
              )}
            </Alert>
          ))}
        </Box>
      )}
      {isViewer && (
        <Alert severity="info" variant="filled" sx={{ borderRadius: 0, py: 0.5 }}>
          You're signed in as an <strong>unfoldingWord</strong> member — read-only access.
          Edits won't be saved. Ask an admin to add you to the editor allowlist if you need to edit.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loc.view === "preferences" ? (
          <PreferencesWorkspace
            section={loc.section}
            role={auth.role}
            onBack={backToScripture}
            onNavigate={(s) => {
              location.hash = `#/preferences/${s}`;
            }}
          />
        ) : loc.view === "article" ? (
          // The article workspace keeps the app's top bar so navigating here
          // doesn't drop the user out of the shell chrome (status, More,
          // account, theme/font/language). Book navigation is switched off —
          // an article has no book/chapter. The bar is fed the last scripture
          // position so "back" targets and status scope stay coherent; the
          // chapter-scoped controls Shell owns (AI pipeline menu, layout
          // switcher, export, verse-list toggle, lint counts) are simply not
          // passed, so each hides itself.
          <Stack sx={{ height: "100%", minHeight: 0 }}>
            <TopBar
              showNavigation={false}
              book={lastScriptureRef.current.book}
              chapter={lastScriptureRef.current.chapter}
              verse={lastScriptureRef.current.verse}
              onNavigate={navigate}
              username={auth.kind === "ready" ? auth.me?.username ?? null : null}
              onLogout={handleSignOut}
            />
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <ArticleWorkspace
                resource={loc.resource}
                articleId={loc.articleId}
                onBack={backToScripture}
                onNavigate={(r, a) => {
                  // Empty articleId (e.g. switching resource with nothing selected)
                  // must not emit a trailing slash — `#/articles/ta/` fails the
                  // article regex and misparses as a chapter.
                  location.hash = a ? `#/articles/${r}/${encodeURIComponent(a)}` : `#/articles/${r}`;
                }}
              />
            </Box>
          </Stack>
        ) : loc.view === "templates" ? (
          <TemplateWorkspace
            templateId={loc.templateId}
            onBack={backToScripture}
            onNavigate={(id) => {
              location.hash = id ? `#/templates/${encodeURIComponent(id)}` : `#/templates`;
            }}
          />
        ) : loc.view === "import" ? (
          <ImportWorkspace
            book={loc.book}
            target={loc.chapter ? { chapter: loc.chapter, verse: loc.verse ?? 1 } : null}
            onBack={backToScripture}
            onNavigate={(b) => {
              location.hash = b ? `#/import/${b}` : `#/import`;
            }}
            onOpenBook={(b, chapter, verse) => navigate(b, chapter ?? 1, verse ?? undefined)}
          />
        ) : loc.view === "review" ? (
          <ReviewQueue book={loc.book} chapter={loc.chapter} onNavigate={navigate} />
        ) : loc.view === "home" ||
          loc.view === "scripture" ||
          loc.view === "align" ||
          loc.view === "flowArticles" ||
          loc.view === "words" ||
          loc.view === "ai" ||
          loc.view === "style" ||
          loc.view === "curate" ||
          loc.view === "setup" ||
          loc.view === "books" ||
          loc.view === "team" ||
          loc.view === "observe" ||
          loc.view === "notes" ||
          loc.view === "questions" ||
          loc.view === "package" ||
          loc.view === "translateWords" ||
          loc.view === "translateScripture" ||
          loc.view === "translateAlign" ||
          loc.view === "admin" ||
          loc.view === "verse" ? (
          <Suspense
            fallback={
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
                <CircularProgress />
              </Stack>
            }
          >
            {loc.view === "home" ? (
              <HomeScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "scripture" ? (
              <ScriptureScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} />
            ) : loc.view === "align" ? (
              <AlignScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} />
            ) : loc.view === "flowArticles" ? (
              <ArticlesScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "words" ? (
              <WordsScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} />
            ) : loc.view === "ai" ? (
              <AiScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "style" ? (
              <StyleScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "curate" ? (
              <CurateScreen role={auth.role} me={auth.me} onNavigate={navigate} templateId={loc.templateId} />
            ) : loc.view === "setup" ? (
              <SetupScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "books" ? (
              <BooksScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "team" ? (
              <TeamScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "observe" ? (
              <ObserveScreen role={auth.role} me={auth.me} onNavigate={navigate} />
            ) : loc.view === "notes" ? (
              <TranslateNotesScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse ?? undefined} />
            ) : loc.view === "questions" ? (
              <TranslateQuestionsScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} />
            ) : loc.view === "package" ? (
              <PackageHubScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} />
            ) : loc.view === "translateWords" ? (
              <TranslateWordsScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} />
            ) : loc.view === "translateScripture" ? (
              <TranslateScriptureScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} />
            ) : loc.view === "translateAlign" ? (
              <TranslateAlignScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} mode={loc.mode} />
            ) : loc.view === "admin" ? (
              loc.section === "team" ? (
                <AdminTeamScreen role={auth.role} me={auth.me} onNavigate={navigate} />
              ) : loc.section === "setup" ? (
                <AdminSetupScreen role={auth.role} me={auth.me} onNavigate={navigate} />
              ) : loc.section === "workflow" ? (
                <AdminWorkflowScreen role={auth.role} me={auth.me} onNavigate={navigate} />
              ) : (
                <AdminProgressScreen role={auth.role} me={auth.me} onNavigate={navigate} />
              )
            ) : (
              <VerseScreen role={auth.role} me={auth.me} onNavigate={navigate} book={loc.book} chapter={loc.chapter} verse={loc.verse} />
            )}
          </Suspense>
        ) : (
          <Shell
            key={loc.book}
            book={loc.book}
            chapter={loc.chapter}
            initialVerse={loc.verse}
            onNavigate={navigate}
            bookHook={bookHook}
            onLogout={handleSignOut}
            meUserId={auth.kind === "ready" ? auth.me?.userId ?? null : null}
            meUsername={auth.kind === "ready" ? auth.me?.username ?? null : null}
          />
        )}
      </Box>
      <Snackbar
        open={sessionExpired}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          severity="warning"
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={handleSessionExpired}>
              Sign in
            </Button>
          }
        >
          Your session expired — sign in to keep saving. Queued edits will sync after sign-in.
        </Alert>
      </Snackbar>
      {chooseWs && <WorkspaceChoiceDialog onClose={() => setChooseWs(false)} />}
    </Box>
  );
}
