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
  const originalDb = env.DB;
  return {
    ...env,
    DB: (env as unknown as Record<string, unknown>)[ws.binding] as D1Database,
    SHARED_DB: env.SHARED_DB ?? originalDb,
    VIEWER_ORG: ws.org,
    DCS_EXPORT_OWNER: ws.exportOwner ?? env.DCS_EXPORT_OWNER,
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
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function serializeWorkspaceCookie(slug: string, secure: boolean): string {
  const attrs = [`${WORKSPACE_COOKIE}=${slug}`, "Path=/", "Max-Age=31536000", "SameSite=Lax", "HttpOnly"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
