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
// - Only state-changing methods are gated; reads stay untouched (they are
//   deliberately unauthenticated — public-export destiny).
// - Only the "viewer" role is gated. Unauthenticated / missing-role requests
//   pass through unchanged so each route's own requireAuth/requireEditor
//   keeps deciding between 401 and 403 exactly as before.
// - Self-scoped, per-user state stays viewer-writable via the prefix
//   allowlist below: auth/session endpoints, the user's own last-location,
//   workspace switching, and dismissing the user's own banner alerts (the
//   dismiss UPDATE is WHERE username = ? — strictly per-user).
import type { Context, MiddlewareHandler } from "hono";
import { currentUserRole } from "./auth.ts";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Prefixes a viewer may send writes to. Everything here is per-user state —
// nothing under these paths mutates shared project/content rows.
const VIEWER_WRITABLE_PREFIXES = [
  "/api/auth/", // login, refresh, logout, dev mint — viewers must be able to hold a session
  "/api/users/me/", // own reading position (PUT /api/users/me/location)
  "/api/workspaces/", // workspace switch (POST /api/workspaces/:slug) — per-user cookie + role re-mint
  "/api/alerts/", // dismiss own banner alert (POST /api/alerts/:id/dismiss, username-scoped UPDATE)
];

export function isViewerWritablePath(path: string): boolean {
  return VIEWER_WRITABLE_PREFIXES.some((p) => path.startsWith(p));
}

export const blockViewerWrites: MiddlewareHandler = async (c: Context, next) => {
  if (!WRITE_METHODS.has(c.req.method.toUpperCase())) return next();
  if (currentUserRole(c) !== "viewer") return next();
  if (isViewerWritablePath(c.req.path)) return next();
  return c.json({ error: "forbidden", reason: "viewer_read_only" }, 403);
};
