// Workspace switcher API: list which orgs the signed-in user may switch to,
// and flip the be_ws cookie that index.ts's fetch() wrapper reads on every
// subsequent request to pick the D1 binding for that org (see workspaces.ts).

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, currentUserId, effectiveRole, ensureWorkspaceUser, isSuperAdmin, mintToken, rotateAccessCookie, clearAccessCookie, type Role } from "./auth.ts";
import { listWorkspaces, sharedDb, serializeWorkspaceCookie, workspaceEnv, type Workspace } from "./workspaces.ts";

export const workspaceRoutes = new Hono<{
  Bindings: Env;
  // Variables shape matches auth.ts's AppContext exactly (see mintToken /
  // rotateAccessCookie / clearAccessCookie) so `c` can be passed straight
  // through to those helpers without a cast.
  Variables: { userId?: number; username?: string; role?: Role };
}>();

workspaceRoutes.use("*", requireAuth);

// Fetches the stored DCS access token for the current user from the SHARED
// db (users is shared, not per-workspace). Null when there's no session/user
// row/token — callers treat that as "membership unknown", not "denied".
async function currentAccessToken(env: Env, userId: number | null): Promise<string | null> {
  if (userId === null) return null;
  const row = await sharedDb(env)
    .prepare(`SELECT dcs_access_token FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ dcs_access_token: string | null }>();
  return row?.dcs_access_token ?? null;
}

// One DCS call per request: GET /api/v1/user/orgs with the caller's own
// token. Returns null (not an empty array) on any failure so callers can
// distinguish "confirmed no orgs" from "couldn't check" — the latter must
// fail closed to "current workspace only", never to "denied everywhere".
async function fetchMemberOrgs(env: Env, accessToken: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${env.DCS_BASE_URL}/api/v1/user/orgs`, {
      headers: { Authorization: `token ${accessToken}` },
    });
    if (!res.ok) return null;
    const orgs = (await res.json()) as Array<{ username?: string }>;
    return new Set(orgs.map((o) => (o.username ?? "").toLowerCase()));
  } catch {
    return null;
  }
}

// GET /api/workspaces — the switcher's list, with an `allowed` flag per
// workspace so the UI can show-but-disable orgs the user isn't a member of.
workspaceRoutes.get("/", async (c) => {
  const workspaces = listWorkspaces(c.env);
  const current = c.env.WORKSPACE_SLUG ?? "default";
  const username = c.get("username");
  // The FALLBACK workspace (first entry in WORKSPACES, or the sole implicit
  // "default" one) is the one whose outbox keeps the legacy unsuffixed
  // IndexedDB name (see web/src/sync/outbox.ts's outboxDbName()). Surfaced
  // per-entry so the client can persist it alongside the slug it switches to.
  const fallbackSlug = workspaces[0]?.slug ?? "default";

  if (username && isSuperAdmin(c.env, username)) {
    return c.json({
      current,
      workspaces: workspaces.map((w) => ({
        slug: w.slug,
        label: w.label,
        org: w.org,
        allowed: true,
        isFallback: w.slug === fallbackSlug,
      })),
    });
  }

  const accessToken = await currentAccessToken(c.env, currentUserId(c));
  const memberOrgs = accessToken ? await fetchMemberOrgs(c.env, accessToken) : null;

  if (!memberOrgs) {
    // No token, or the DCS lookup failed — fail closed but don't strand the
    // user: they keep the workspace they're already in.
    return c.json({
      current,
      workspaces: workspaces.map((w) => ({
        slug: w.slug,
        label: w.label,
        org: w.org,
        allowed: w.slug === current,
        isFallback: w.slug === fallbackSlug,
      })),
      membershipUnknown: true,
    });
  }

  return c.json({
    current,
    workspaces: workspaces.map((w) => ({
      slug: w.slug,
      label: w.label,
      org: w.org,
      allowed: memberOrgs.has(w.org.toLowerCase()),
      isFallback: w.slug === fallbackSlug,
    })),
  });
});

// POST /api/workspaces/:slug — switch the caller's active workspace. CSRF is
// already enforced globally (index.ts's app-wide requireCsrf) for every
// write, this route included.
workspaceRoutes.post("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const ws: Workspace | undefined = listWorkspaces(c.env).find((w) => w.slug === slug);
  if (!ws) return c.json({ error: "unknown_workspace" }, 404);

  const username = c.get("username");
  let allowed = !!username && isSuperAdmin(c.env, username);
  if (!allowed) {
    const accessToken = await currentAccessToken(c.env, currentUserId(c));
    const memberOrgs = accessToken ? await fetchMemberOrgs(c.env, accessToken) : null;
    allowed = !!memberOrgs && memberOrgs.has(ws.org.toLowerCase());
  }
  if (!allowed) return c.json({ error: "workspace_forbidden" }, 403);

  const secure = !c.req.url.startsWith("http://");
  // append: true — a second Set-Cookie (the re-minted be_access below) must
  // land alongside this one, not replace it. c.header()'s default (no
  // {append}) uses Headers.set, which clobbers any prior Set-Cookie.
  c.header("Set-Cookie", serializeWorkspaceCookie(ws.slug, secure), { append: true });

  // user_roles is per-org, but the Access JWT's `role` claim is what
  // requireAdmin/requireEditor read off the request — without this, the old
  // token (minted for the PREVIOUS workspace) keeps its old-org role for up
  // to its 1h TTL after the switch above, so e.g. an admin in org A who is
  // merely a member of org B could use that stale role against org B's DB
  // until the token naturally expired. Re-resolve the role against the
  // TARGET workspace's DB and re-mint the Access cookie so the new token can
  // never carry a role that doesn't apply to the org it's now scoped to.
  //
  // `allowed` above already established the caller is either a super admin
  // or a confirmed DCS member of the target org — so a missing user_roles
  // row here means "plain org member", i.e. the same 'viewer' default the
  // OAuth callback / refresh flow grants for org-only access (see
  // isViewerOrgMember in auth.ts). It is NOT "deny" — they were just cleared
  // to switch here.
  if (username) {
    try {
      const targetEnv = workspaceEnv(c.env, ws);
      const userId = currentUserId(c);
      // Mirror the user's row into the TARGET workspace's local `users`
      // table before responding, so the very first request after the
      // switch (which will carry the new be_ws cookie) can't race this and
      // find no local row to satisfy tn_rows/tq_rows/etc.'s FK.
      if (userId !== null) {
        await ensureWorkspaceUser(targetEnv, userId);
      }
      const role: Role = (await effectiveRole(targetEnv, username)) ?? "viewer";
      if (userId !== null) {
        const newAccessToken = await mintToken(c, userId, username, role);
        rotateAccessCookie(c, newAccessToken);
      }
    } catch {
      // Couldn't cleanly re-mint (e.g. the target workspace's D1 binding is
      // unreachable) — fail safe by clearing the Access cookie rather than
      // leaving the stale, wrong-org role live. The client is forced through
      // /api/auth/refresh, which re-resolves the role against the
      // per-request DB — now the target workspace's, since the be_ws cookie
      // set above has already taken effect for that follow-up request.
      clearAccessCookie(c);
    }
  }

  return c.json({ ok: true, slug: ws.slug });
});
