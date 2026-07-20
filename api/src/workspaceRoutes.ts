// Workspace switcher API: list which orgs the signed-in user may switch to,
// and flip the be_ws cookie that index.ts's fetch() wrapper reads on every
// subsequent request to pick the D1 binding for that org (see workspaces.ts).

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, currentUserId } from "./auth.ts";
import { listWorkspaces, sharedDb, serializeWorkspaceCookie, type Workspace } from "./workspaces.ts";

export const workspaceRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

workspaceRoutes.use("*", requireAuth);

function superAdminSet(env: Env): Set<string> {
  return new Set(
    (env.SUPER_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

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

  if (username && superAdminSet(c.env).has(username.toLowerCase())) {
    return c.json({
      current,
      workspaces: workspaces.map((w) => ({ slug: w.slug, label: w.label, org: w.org, allowed: true })),
    });
  }

  const accessToken = await currentAccessToken(c.env, currentUserId(c));
  const memberOrgs = accessToken ? await fetchMemberOrgs(c.env, accessToken) : null;

  if (!memberOrgs) {
    // No token, or the DCS lookup failed — fail closed but don't strand the
    // user: they keep the workspace they're already in.
    return c.json({
      current,
      workspaces: workspaces.map((w) => ({ slug: w.slug, label: w.label, org: w.org, allowed: w.slug === current })),
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
  let allowed = !!username && superAdminSet(c.env).has(username.toLowerCase());
  if (!allowed) {
    const accessToken = await currentAccessToken(c.env, currentUserId(c));
    const memberOrgs = accessToken ? await fetchMemberOrgs(c.env, accessToken) : null;
    allowed = !!memberOrgs && memberOrgs.has(ws.org.toLowerCase());
  }
  if (!allowed) return c.json({ error: "workspace_forbidden" }, 403);

  const secure = !c.req.url.startsWith("http://");
  c.header("Set-Cookie", serializeWorkspaceCookie(ws.slug, secure));
  return c.json({ ok: true, slug: ws.slug });
});
