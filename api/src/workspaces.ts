// Workspace resolution — the org-per-D1 layer that lets one deployed Worker
// serve multiple Door43 orgs, each backed by its own D1 database, while a
// signed-in user switches which one their requests talk to via a cookie.
//
// Overriding constraint: when WORKSPACES is unset/empty/malformed, behavior
// must be byte-for-byte identical to today — a single implicit "default"
// workspace pointed at the existing DB binding. Every function here degrades
// to that shape rather than throwing, so a bad env var can never 500 the API.
//
// The actual DB swap happens in ONE place: index.ts's `fetch` wrapper calls
// workspaceEnv() before handing the request to the Hono app. Every route file
// still just reads `c.env.DB` — it has no idea a swap happened.

import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";
import { isIdent } from "./repoUrl.ts";

export interface Workspace {
  slug: string; // url/cookie-safe id
  label: string; // human label for the switcher
  org: string; // Door43 org name — also the viewer-membership org
  binding: string; // name of the D1 binding on Env holding this org's content
  exportOwner?: string; // optional per-workspace DCS_EXPORT_OWNER override
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function implicitWorkspace(env: Env): Workspace {
  const org = (env.VIEWER_ORG ?? "unfoldingWord").trim() || "unfoldingWord";
  return { slug: "default", label: org, org, binding: "DB" };
}

// Validates one raw WORKSPACES entry, logging (not throwing) on rejection —
// a malformed entry must never 500 the whole API, it just doesn't get a
// workspace.
function parseEntry(env: Env, entry: unknown): Workspace | null {
  if (!entry || typeof entry !== "object") {
    console.warn("workspaces: dropping non-object entry", entry);
    return null;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.slug !== "string" || !SLUG_RE.test(e.slug)) {
    console.warn("workspaces: dropping entry with invalid slug", e.slug);
    return null;
  }
  if (typeof e.org !== "string" || !isIdent(e.org)) {
    console.warn("workspaces: dropping entry with invalid org", e.slug, e.org);
    return null;
  }
  if (typeof e.label !== "string" || e.label.length === 0 || e.label.length > 64) {
    console.warn("workspaces: dropping entry with invalid label", e.slug);
    return null;
  }
  if (typeof e.binding !== "string") {
    console.warn("workspaces: dropping entry with invalid binding", e.slug);
    return null;
  }
  const bound = (env as unknown as Record<string, unknown>)[e.binding] as
    | { prepare?: unknown }
    | undefined;
  if (typeof bound?.prepare !== "function") {
    console.warn("workspaces: dropping entry whose binding isn't a D1Database", e.slug, e.binding);
    return null;
  }
  if (e.exportOwner !== undefined && typeof e.exportOwner !== "string") {
    console.warn("workspaces: dropping entry with invalid exportOwner", e.slug);
    return null;
  }
  const ws: Workspace = { slug: e.slug, label: e.label, org: e.org, binding: e.binding };
  if (typeof e.exportOwner === "string") ws.exportOwner = e.exportOwner;
  return ws;
}

// Memoized per `env` object — this runs on every request, and re-parsing the
// same JSON string per-request would be wasteful.
const cache = new WeakMap<object, Workspace[]>();

export function listWorkspaces(env: Env): Workspace[] {
  const cached = cache.get(env as object);
  if (cached) return cached;

  let result: Workspace[] = [];
  const raw = (env.WORKSPACES ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        for (const entry of parsed) {
          const ws = parseEntry(env, entry);
          if (!ws) continue;
          if (seen.has(ws.slug)) {
            console.warn("workspaces: dropping duplicate slug", ws.slug);
            continue;
          }
          seen.add(ws.slug);
          result.push(ws);
        }
      } else {
        console.warn("workspaces: WORKSPACES var is not a JSON array");
      }
    } catch (e) {
      console.warn("workspaces: failed to parse WORKSPACES var", e instanceof Error ? e.message : String(e));
    }
  }
  if (result.length === 0) result = [implicitWorkspace(env)];

  cache.set(env as object, result);
  return result;
}

// Exact slug match; unknown/null slug falls back to the first workspace
// (the implicit default when WORKSPACES is unset).
export function resolveWorkspace(env: Env, slug: string | null): Workspace {
  const list = listWorkspaces(env);
  if (slug) {
    const found = list.find((w) => w.slug === slug);
    if (found) return found;
  }
  return list[0];
}

// Swaps in the workspace's D1 binding as DB, resolves SHARED_DB to the
// ORIGINAL default DB binding (must be read before DB is overwritten below),
// and stamps VIEWER_ORG / WORKSPACE_SLUG / DCS_EXPORT_OWNER for this request.
export function workspaceEnv(env: Env, ws: Workspace): Env {
  // Bindings are always resolved from the ORIGINAL (never-swapped) env, kept on
  // BASE_ENV. This function can legitimately be called on an already-swapped
  // env — the workspace-switch route resolves the *target* workspace's DB from
  // the current request's env — and the first workspace's binding is literally
  // named "DB". Reading `env[ws.binding]` off a swapped env would then hand
  // back whichever database is currently active instead of the target's, which
  // silently reads the wrong org (it looked up roles in the wrong workspace).
  const base = env.BASE_ENV ?? env;
  return {
    ...base,
    BASE_ENV: base,
    DB: (base as unknown as Record<string, unknown>)[ws.binding] as D1Database,
    SHARED_DB: base.SHARED_DB ?? base.DB,
    VIEWER_ORG: ws.org,
    DCS_EXPORT_OWNER: ws.exportOwner ?? base.DCS_EXPORT_OWNER,
    WORKSPACE_SLUG: ws.slug,
  };
}

// Accounts, sessions, the lexicon, alignment frequencies, and UI-string
// overrides are not org-scoped — they must read the shared DB regardless of
// which workspace the request is in, or switching orgs would log a user out
// / force a lexicon re-import per org. Falls back to DB when SHARED_DB was
// never set (WORKSPACES unset — DB and SHARED_DB are the same database).
export function sharedDb(env: Env): D1Database {
  return env.SHARED_DB ?? env.DB;
}

// ── Workspace cookie ─────────────────────────────────────────────────────────

export const WORKSPACE_COOKIE = "be_ws";

// Reads be_ws directly off the raw Cookie header — no dependency, this runs
// before the Hono context exists (the fetch wrapper in index.ts, ahead of
// app.fetch).
export function parseWorkspaceCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === WORKSPACE_COOKIE) {
      // A malformed percent-escape (e.g. a stray "%" from a hand-edited or
      // corrupted cookie) throws a URIError out of decodeURIComponent — left
      // uncaught, that turns into an uncaught throw inside the fetch()
      // wrapper (this runs before Hono's onError handler exists), 500ing
      // every request from that browser. Treat an undecodable value the same
      // as an absent cookie — resolveWorkspace() already handles null by
      // falling back to the first/default workspace.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeWorkspaceCookie(slug: string, secure: boolean): string {
  const attrs = [`${WORKSPACE_COOKIE}=${slug}`, "Path=/", "Max-Age=31536000", "SameSite=Lax", "HttpOnly"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// ── Cross-tab workspace-mismatch guard ──────────────────────────────────────

// Paths exempt from the check below regardless of the header's value:
// /api/auth/* is hit by raw fetch() calls that never set X-Workspace (the
// refresh/dev-mint/OAuth-callback flows in web/src/sync/api.ts) AND by
// fetchAuthMe()/authLogout(), which DO go through the shared request() helper
// and so DO carry the client's (possibly stale, pre-reconciliation) slug —
// rejecting those would break the exact boot-time reconciliation this guard
// is meant to support. /api/ws/* is the WebSocket upgrade route; browsers
// don't allow custom headers on a WS handshake, so this is defensive rather
// than load-bearing.
function isWorkspaceMismatchExempt(path: string): boolean {
  return path.startsWith("/api/auth/") || path.startsWith("/api/ws/");
}

// Detects a stale tab: web/src/sync/api.ts stamps every request with an
// X-Workspace header holding its client-side notion of the active org
// (getWorkspaceSlug()). If a SIBLING tab switches orgs, THIS tab's requests
// still carry the old slug — which won't match the workspace this request
// resolved to (index.ts's fetch() wrapper already picked the D1 binding from
// the be_ws cookie before Hono ever saw the request). Reject so api.ts can
// force this tab to reconcile instead of silently reading/writing the wrong
// org's data — see outbox.ts's dispatch() for why a queued edit must survive
// this (it stays queued; it belongs to the OTHER workspace's outbox and drains
// fine once the user is back there).
//
// Absent header ALWAYS passes — older clients, curl, and the exempt paths
// above never send it. This is detection of a known-stale claim, not
// enforcement that the header be present.
export const requireWorkspaceMatch: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const claimed = c.req.header("x-workspace");
  const resolved = c.env.WORKSPACE_SLUG ?? "default";
  if (claimed && claimed !== resolved && !isWorkspaceMismatchExempt(c.req.path)) {
    return c.json({ error: "workspace_mismatch", expected: resolved }, 409);
  }
  await next();
};
