// Global viewer read-only gate — defense-in-depth behind the per-route
// requireEditor / requireAdmin guards.
//
// A "viewer" (DCS org member who isn't on the BE-Admins / BE-Editors teams)
// may log in and read everything, but must never mutate content state. Every
// content-write route already carries requireEditor/requireAdmin; this
// middleware is the backstop so a future write route added WITHOUT a
// per-route guard fails closed for viewers instead of silently becoming
// viewer-writable.
//
// Scope rules:
// - Registered on "/api/*" only (index.ts) — non-API paths keep their normal
//   SPA/asset fallthrough for every caller, so a viewer's response never
//   diverges from anyone else's outside the API surface.
// - Only state-changing methods are gated; reads stay untouched (they are
//   deliberately unauthenticated — public-export destiny).
// - Fail closed on role: only "admin" and "editor" pass. A viewer — or any
//   unknown/future role value — is blocked. Unauthenticated requests (no
//   userId) pass through unchanged so each route's own requireAuth /
//   requireEditor keeps deciding 401 vs 403 exactly as before (and the
//   frontend's silent-refresh-on-401 flow keeps working).
// - Self-scoped, per-user writes are allowlisted by EXACT method + path
//   pattern, not by router prefix — a future unguarded write route added
//   under /api/users/, /api/workspaces/, or /api/alerts/ must be added here
//   deliberately or it fails closed. The one prefix exemption is /api/auth/:
//   that router is entirely session lifecycle (start/callback are GETs;
//   refresh/logout act only on the caller's own session; dev mint is
//   DEV_AUTH_ENABLED + localhost gated) and viewers must be able to hold a
//   session.
import type { Context, MiddlewareHandler } from "hono";
import { currentUserId, currentUserRole } from "./auth.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Exact self-scoped write endpoints a viewer may call. Nothing here mutates
// shared project/content rows:
// - own reading position (auth.ts updateLastLocation)
// - workspace switch (workspaceRoutes.ts — per-user cookie + role re-mint)
// - dismiss own banner alert (alerts.ts — username-scoped UPDATE)
const VIEWER_WRITABLE: Array<{ method: string; pattern: RegExp }> = [
  { method: "PUT", pattern: /^\/api\/users\/me\/location$/ },
  { method: "POST", pattern: /^\/api\/workspaces\/[A-Za-z0-9._-]+$/ },
  { method: "POST", pattern: /^\/api\/alerts\/\d+\/dismiss$/ },
];

export function isViewerWritable(method: string, path: string): boolean {
  if (path.startsWith("/api/auth/")) return true;
  return VIEWER_WRITABLE.some((e) => e.method === method && e.pattern.test(path));
}

export const blockViewerWrites: MiddlewareHandler = async (c: Context, next) => {
  const method = c.req.method.toUpperCase();
  if (!WRITE_METHODS.has(method)) return next();
  if (currentUserId(c) === null) return next(); // anonymous → per-route 401
  const role = currentUserRole(c);
  if (role === "admin" || role === "editor") return next();
  if (isViewerWritable(method, c.req.path)) return next();
  return c.json({ error: "forbidden", reason: "viewer_read_only" }, 403);
};
