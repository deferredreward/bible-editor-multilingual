// Workspace switcher API: list which orgs the signed-in user may switch to,
// and flip the be_ws cookie that index.ts's fetch() wrapper reads on every
// subsequent request to pick the D1 binding for that org (see workspaces.ts).

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth, currentUserId, effectiveRole, ensureWorkspaceUser, isSuperAdmin, mintToken, rotateAccessCookie, clearAccessCookie, type Role } from "./auth.ts";
import { fetchMemberOrgs, syncTeamRoleForUser, RESYNC_AFTER_SECONDS } from "./dcsTeams.ts";
import { listWorkspaces, sharedDb, serializeWorkspaceCookie, workspaceEnv, type Workspace } from "./workspaces.ts";
import { presetForOrg, seedProjectConfigIfAbsent } from "./projectConfig.ts";

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

// The GET /api/v1/user/orgs membership lookup lives in dcsTeams.ts
// (fetchMemberOrgs) — shared with the OAuth callback's login-time workspace
// resolution. Null (never an empty set) on any failure so callers can
// distinguish "confirmed no orgs" from "couldn't check" — the latter must
// fail closed to "current workspace only", never to "denied everywhere".

// A workspace is allowed to a user if they're a Door43 member of its org OR
// they already hold a user_roles row in that workspace's database (a manual
// allowlist grant, or a cached team role). Org membership alone would evict
// manually allowlisted outsiders. Best-effort: an unreachable workspace DB
// (or a mid-migration missing table) reads as "no row seen".
async function hasRoleRow(env: Env, ws: Workspace, username: string | undefined): Promise<boolean> {
  if (!username) return false;
  try {
    const row = await workspaceEnv(env, ws)
      .DB.prepare(`SELECT 1 AS present FROM user_roles WHERE dcs_username = ?1`)
      .bind(username)
      .first<{ present: number }>();
    return !!row;
  } catch {
    return false;
  }
}

// GET /api/workspaces — the switcher's list. Super admins see every
// configured workspace; everyone else sees ONLY the workspaces they may
// actually enter. Non-members must not even learn the names of other orgs
// (issue #93 — the previous "show-but-disable" behavior leaked the existence
// and labels of every configured org to non-members). The currently-active
// workspace is always included so a user can never be stranded with an empty
// switcher. Every surfaced entry carries `allowed: true`.
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

  // Org membership OR an existing role row allows a workspace (see
  // hasRoleRow) — checked per workspace so a manually allowlisted outsider's
  // own org isn't shown as off-limits. Small bounded fan-out (one D1 read per
  // configured workspace the org check didn't already allow).
  const roleAllowed = new Set<string>();
  for (const w of workspaces) {
    if (memberOrgs?.has(w.org.toLowerCase())) continue; // already allowed
    if (await hasRoleRow(c.env, w, username)) roleAllowed.add(w.slug);
  }

  // A workspace is visible when the user may actually switch to it: their
  // current workspace (never strand them), a workspace a role row vouches for,
  // or — when membership was confirmed — their DCS org. When membership is
  // unknown (no token / DCS lookup failed) we fail closed to current-only plus
  // role grants, exactly as before, but omit the rest rather than showing them
  // disabled. Mirrors the POST /:slug allow logic so the list only ever offers
  // workspaces the switch endpoint would accept.
  const isVisible = (w: Workspace): boolean =>
    w.slug === current ||
    roleAllowed.has(w.slug) ||
    (!!memberOrgs && memberOrgs.has(w.org.toLowerCase()));

  const visible = workspaces.filter(isVisible).map((w) => ({
    slug: w.slug,
    label: w.label,
    org: w.org,
    allowed: true,
    isFallback: w.slug === fallbackSlug,
  }));

  if (!memberOrgs) {
    // Signal the client that the `allowed`/visible set may be incomplete
    // because we couldn't confirm membership — the switcher shows a hint.
    return c.json({ current, workspaces: visible, membershipUnknown: true });
  }

  return c.json({ current, workspaces: visible });
});

// POST /api/workspaces/:slug — switch the caller's active workspace. CSRF is
// already enforced globally (index.ts's app-wide requireCsrf) for every
// write, this route included.
workspaceRoutes.post("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const ws: Workspace | undefined = listWorkspaces(c.env).find((w) => w.slug === slug);
  if (!ws) return c.json({ error: "unknown_workspace" }, 404);

  const username = c.get("username");
  const superAdmin = !!username && isSuperAdmin(c.env, username);
  // Hoisted past the gate: the switch-time team resync below reuses it.
  const accessToken = superAdmin ? null : await currentAccessToken(c.env, currentUserId(c));
  let allowed = superAdmin;
  if (!allowed) {
    // A role row in the TARGET workspace's database grants entry even without
    // Door43 org membership (manual allowlist grant) — and it's a local D1
    // read, so check it before spending a DCS round-trip on the org gate.
    allowed = await hasRoleRow(c.env, ws, username);
  }
  if (!allowed) {
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
      // Switch-time team resync, against the TARGET workspace's env: a user
      // entering this workspace for the first time has no user_roles row in
      // its database yet, so without this they'd land as a plain viewer until
      // their next full OAuth sign-in re-ran the team sync. Best-effort
      // (never throws); skipped for super admins, whose effectiveRole below
      // short-circuits to admin regardless — their switches stay DCS-free.
      //
      // Throttled with the same synced_at freshness the refresh path uses
      // (maybeResyncTeamRole): a dcs_team row checked within the last
      // RESYNC_AFTER_SECONDS skips the DCS round-trip, so bouncing between
      // workspaces isn't a /user/teams call per bounce. First-ever entry (no
      // row → no synced_at) and pre-migration windows (query throws) still
      // sync immediately.
      if (accessToken) {
        let fresh = false;
        try {
          const row = await targetEnv.DB.prepare(
            `SELECT synced_at AS syncedAt FROM user_roles
              WHERE dcs_username = ?1 AND source = 'dcs_team'`,
          )
            .bind(username)
            .first<{ syncedAt: number | null }>();
          fresh =
            !!row?.syncedAt &&
            Math.floor(Date.now() / 1000) - row.syncedAt < RESYNC_AFTER_SECONDS;
        } catch {
          /* pre-migration window — sync unconditionally, as before */
        }
        if (!fresh) {
          await syncTeamRoleForUser(targetEnv, username, accessToken);
        }
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

  // Seed the target workspace's project_config from its org's preset when that
  // DB has no row yet. Without this, getProjectConfig on a freshly-selected
  // workspace DB falls back to a preset with no translationSource and drops the
  // user into English authoring mode regardless of which org the workspace is.
  // Best-effort and idempotent at the SQL level (INSERT … ON CONFLICT DO
  // NOTHING inside seedProjectConfigIfAbsent), so a concurrent admin
  // PUT /api/project-config that lands a row between switches is never
  // clobbered back to NULL overrides; the read-path fallback in
  // getProjectConfig covers the same case should this write fail.
  try {
    const targetEnv = workspaceEnv(c.env, ws);
    const preset = presetForOrg(ws.org);
    if (preset) {
      await seedProjectConfigIfAbsent(targetEnv, preset);
    }
  } catch {
    // Non-fatal: the read-path fallback resolves the correct preset per request.
  }

  // Remember the choice — the (b) "last-used workspace" input the OAuth
  // callback's login resolution reads on their next sign-in. Best-effort:
  // the column arrives with migration 0056, and code deploys before
  // migrations apply.
  const switchedUserId = currentUserId(c);
  if (switchedUserId !== null) {
    try {
      await sharedDb(c.env)
        .prepare(`UPDATE users SET last_workspace_slug = ?1 WHERE id = ?2`)
        .bind(ws.slug, switchedUserId)
        .run();
    } catch {
      // Pre-migration window — nothing to do.
    }
  }

  return c.json({ ok: true, slug: ws.slug });
});
