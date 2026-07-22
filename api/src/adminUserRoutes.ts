// Admin-only CRUD over the user_roles allowlist (api/migrations/0016_user_roles.sql).
// Until now the only way to grant/revoke admin/editor access was raw SQL
// against D1; this gives admins an in-app REST surface, modeled on
// projectConfigRoutes.ts (zod validation, {error:"snake_code"} bodies).

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
// Explicit .ts extension (tsconfig has allowImportingTsExtensions) so this
// module can also be loaded directly by node's strip-types test runner —
// see adminUsers.test.mjs, which imports this file rather than re-testing
// its logic in isolation.
import { requireAuth, requireAdmin, currentUserId, currentUserDcsToken, lookupUserRole } from "./auth.ts";
import type { Role } from "./auth.ts";
import { sharedDb } from "./workspaces.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { teamRoleNames, type TeamRoleNames } from "./dcsTeams.ts";

export const adminUsers = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

adminUsers.use("*", requireAuth, requireAdmin);

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// Raw user_roles row before the added_by user id is resolved to a username.
// `source` is 'manual' (granted here) or 'dcs_team' (derived from Door43 team
// membership at sign-in — see api/src/dcsTeams.ts). Deleting a 'dcs_team' row
// only lasts until that user's next login; remove them from the Door43 team to
// make it stick.
type RoleRow = {
  username: string;
  role: string;
  addedAt: number;
  addedBy: number | null;
  source: string | null;
};

// user_roles is per-org (env.DB); the users table it used to LEFT JOIN for
// added_by's display name is shared across workspaces (SHARED_DB) — the two
// can no longer live in one SQL statement, so this fetches user_roles rows
// first and resolves added_by usernames from the shared DB as a second step.
const ROLE_ROW_SELECT = `SELECT dcs_username AS username, role AS role, added_at AS addedAt, added_by AS addedBy,
         source AS source
    FROM user_roles`;

// Batch-resolves a set of users.id -> dcs_username from the shared DB. Used to
// fill in addedBy display names for a list of user_roles rows.
async function lookupAddedByUsernames(env: Env, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids.filter((id): id is number => id != null))];
  const map = new Map<number, string>();
  if (uniqueIds.length === 0) return map;
  const placeholders = uniqueIds.map((_v, i) => `?${i + 1}`).join(",");
  const rs = await sharedDb(env)
    .prepare(`SELECT id, dcs_username FROM users WHERE id IN (${placeholders})`)
    .bind(...uniqueIds)
    .all<{ id: number; dcs_username: string }>();
  for (const row of rs.results ?? []) map.set(row.id, row.dcs_username);
  return map;
}

// GET /api/admin/users — the allowlist, admins first then alpha (COLLATE
// NOCASE matches the PK's collation so casing doesn't affect sort order).
adminUsers.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `${ROLE_ROW_SELECT}
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, dcs_username COLLATE NOCASE`,
  ).all<RoleRow>();

  const addedByUsernames = await lookupAddedByUsernames(c.env, results.map((r) => r.addedBy));

  return c.json({
    users: results.map((r) => ({
      username: r.username,
      role: r.role,
      addedAt: r.addedAt ?? null,
      addedBy: r.addedBy != null ? (addedByUsernames.get(r.addedBy) ?? null) : null,
      source: r.source ?? "manual",
    })),
  });
});

// Gitea caps page size at 50; loop pages until a short one. MAX_PAGES bounds
// the subrequest budget on a single Worker request — 20 * 50 = 1000 members is
// far more than any real GL org, and exhausting it just means we flag the
// result `truncated` rather than pretending the list is complete.
const MEMBERS_PAGE_SIZE = 50;
const MEMBERS_MAX_PAGES = 20;

// `teamRole` is the LIVE Door43 team-derived role for this member, resolved by
// listing the org's role-teams (see resolveOrgTeamRoles). It is present only
// when team membership could actually be read (the authenticated fetch paths),
// and is independent of whether the member has ever signed in — that is the
// whole point of the fix: a BE-Admins member who never logged in has no
// user_roles row yet, but their effective role is still admin.
type OrgMember = { login: string; fullName: string; avatarUrl: string; teamRole?: Role };

// Paginates one of DCS's org-member-listing endpoints ("members" — full
// roster, requires the caller to be a member/owner of the org — or
// "public_members", visible to anyone). Returns either the full member list
// or the non-ok status that stopped pagination, so the caller can decide
// whether to fall back.
async function fetchOrgMembers(
  base: string,
  org: string,
  endpoint: "members" | "public_members",
  headers: Record<string, string>,
): Promise<{ ok: true; members: OrgMember[]; truncated: boolean } | { ok: false; status: number }> {
  const members: OrgMember[] = [];
  let truncated = false;
  for (let page = 1; page <= MEMBERS_MAX_PAGES; page++) {
    const res = await fetch(
      `${base}/api/v1/orgs/${encodeURIComponent(org)}/${endpoint}?limit=${MEMBERS_PAGE_SIZE}&page=${page}`,
      { headers },
    );
    if (!res.ok) return { ok: false, status: res.status };
    const batch = (await res.json()) as unknown;
    if (!Array.isArray(batch)) return { ok: false, status: 0 };
    for (const m of batch as Array<{ login?: string; full_name?: string; avatar_url?: string }>) {
      if (m.login) members.push({ login: m.login, fullName: m.full_name ?? "", avatarUrl: m.avatar_url ?? "" });
    }
    if (batch.length < MEMBERS_PAGE_SIZE) break;
    // Last allowed page still full — the roster is longer than we fetched.
    if (page === MEMBERS_MAX_PAGES) truncated = true;
  }
  return { ok: true, members, truncated };
}

type DcsTeamSummary = { id?: number; name?: string };
type DcsTeamMember = { login?: string };

// Resolves each org member's LIVE team-derived role by reading the org's
// role-teams directly, so the roster can show the correct effective role
// BEFORE a member has ever signed in (their user_roles row only appears at
// their own first login/switch — see syncTeamRoleForUser in dcsTeams.ts).
//
// Cheap: list the org's teams once, then fetch members of only the two teams
// whose names match the configured admin/editor teams. Admin wins over editor,
// matching roleFromTeams' precedence in dcsTeams.ts.
//
// Best-effort: returns an empty map on ANY failure (non-2xx, network,
// unparseable). A team read that can't complete must degrade the APP ROLE
// column to "whatever user_roles says", never break the roster — the same
// fail-soft posture the org-members route already takes for the member list.
// Requires the same membership as /orgs/{org}/members, so it's only called on
// the authenticated fetch paths, never the public_members last resort.
async function resolveOrgTeamRoles(
  base: string,
  org: string,
  headers: Record<string, string>,
  names: TeamRoleNames,
): Promise<Map<string, Role>> {
  const roles = new Map<string, Role>();
  const adminTeam = names.admin.trim().toLowerCase();
  const editorTeam = names.editor.trim().toLowerCase();
  try {
    const teams: DcsTeamSummary[] = [];
    for (let page = 1; page <= MEMBERS_MAX_PAGES; page++) {
      const res = await fetch(
        `${base}/api/v1/orgs/${encodeURIComponent(org)}/teams?limit=${MEMBERS_PAGE_SIZE}&page=${page}`,
        { headers },
      );
      if (!res.ok) return roles; // can't establish team membership — degrade
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) return roles;
      teams.push(...(batch as DcsTeamSummary[]));
      if (batch.length < MEMBERS_PAGE_SIZE) break;
    }

    // Only the two role-teams matter. Map each to the app role it grants so a
    // team read is done at most twice regardless of how many teams the org has.
    const roleTeams: Array<{ id: number; role: Role }> = [];
    for (const t of teams) {
      if (typeof t.id !== "number") continue;
      const name = (t.name ?? "").trim().toLowerCase();
      if (name === adminTeam) roleTeams.push({ id: t.id, role: "admin" });
      else if (name === editorTeam) roleTeams.push({ id: t.id, role: "editor" });
    }

    for (const { id, role } of roleTeams) {
      for (let page = 1; page <= MEMBERS_MAX_PAGES; page++) {
        const res = await fetch(
          `${base}/api/v1/teams/${id}/members?limit=${MEMBERS_PAGE_SIZE}&page=${page}`,
          { headers },
        );
        if (!res.ok) break; // this team's members are unknown; keep what we have
        const batch = (await res.json()) as unknown;
        if (!Array.isArray(batch)) break;
        for (const m of batch as DcsTeamMember[]) {
          const login = (m.login ?? "").toLowerCase();
          if (!login) continue;
          // Admin wins: never let an editor-team row downgrade an admin-team row.
          if (role === "admin" || !roles.has(login)) roles.set(login, role);
        }
        if (batch.length < MEMBERS_PAGE_SIZE) break;
      }
    }
  } catch {
    return roles; // network error — degrade to user_roles-only APP ROLE
  }
  return roles;
}

// Stamps each member's `teamRole` from a resolved login→role map (keyed
// lowercase, since Gitea logins are case-insensitive). Returns a new array.
function withTeamRoles(members: OrgMember[], teamRoles: Map<string, Role>): OrgMember[] {
  if (teamRoles.size === 0) return members;
  return members.map((m) => {
    const role = teamRoles.get(m.login.toLowerCase());
    return role ? { ...m, teamRole: role } : m;
  });
}

// GET /api/admin/users/org-members — the LIVE Door43 org roster.
//
// Unlike GET /api/admin/users (which reads the local user_roles allowlist),
// this makes a live read against DCS: it lists the actual members of the
// project's configured org. It is READ-ONLY reconciliation data — it never
// mutates user_roles. The UI cross-references it against the allowlist so the
// allowlist is no longer mistaken for "the org roster" (see issue #64).
//
// Fails soft: on any non-2xx or network error it returns HTTP 200 with an
// empty members list and an `error` string, mirroring the fail-open tolerance
// used for DCS lookups elsewhere (auth.ts, the PUT canonicalization above). A
// DCS outage must degrade the reconciliation view, not break the whole page.
//
// `/orgs/{org}/members` only returns the full roster to a caller who is
// themselves a member/owner of that org — an unauthenticated or non-member
// caller gets 401/403 even though the org and token are otherwise fine.
//
// Fetch chain, in order (each step falls through to the next on failure):
//
//   1. The signed-in admin's OWN stored DCS token. They necessarily are a
//      member of the org (that is how they became admin — via a Door43 team
//      in it), so their personal token reads the FULL roster including private
//      members. This is the primary path; it is best-effort — a missing
//      (dev-minted / logged-out session) or expired token just moves to (2),
//      NOT an error the admin sees.
//   2. The shared DCS_SERVICE_TOKEN. Returns the full roster when that
//      account is itself a member/owner of the org (issue #78: it often is
//      not, hence step 3).
//   3. `/orgs/{org}/public_members` (visible to anyone). Only the PUBLIC
//      members — so this result is flagged `partial` with a `_public_only`
//      error so the UI can explain *why* the list may be incomplete instead of
//      hiding it entirely. Last resort.
//
// A full roster from (1) or (2) is returned plainly (never `partial`); only
// the public-members fallback (3) is `partial`.
adminUsers.get("/org-members", async (c) => {
  const { org } = await getProjectConfig(c.env);
  const base = (c.env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");

  if (!org) {
    // No org configured (e.g. an unconfigured workspace) — nothing to list, but
    // this isn't an error the admin can act on, so report an empty roster.
    return c.json({ org, members: [], truncated: false });
  }

  const names = teamRoleNames(c.env);

  // (1) Admin's own DCS token — full roster (incl. private members). Any
  // failure (missing/expired token, non-2xx, network) falls through to (2).
  const adminToken = await currentUserDcsToken(c);
  if (adminToken) {
    const authHeaders = { Accept: "application/json", Authorization: `token ${adminToken}` };
    try {
      const own = await fetchOrgMembers(base, org, "members", authHeaders);
      if (own.ok) {
        const teamRoles = await resolveOrgTeamRoles(base, org, authHeaders, names);
        return c.json({ org, members: withTeamRoles(own.members, teamRoles), truncated: own.truncated });
      }
    } catch {
      // Network error on the admin-token attempt — fall through to (2).
    }
  }

  // (2) Shared service token → (3) public_members (partial) as last resort.
  const headers: Record<string, string> = { Accept: "application/json" };
  if (c.env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${c.env.DCS_SERVICE_TOKEN}`;

  try {
    const full = await fetchOrgMembers(base, org, "members", headers);
    if (full.ok) {
      const teamRoles = await resolveOrgTeamRoles(base, org, headers, names);
      return c.json({ org, members: withTeamRoles(full.members, teamRoles), truncated: full.truncated });
    }

    if (full.status === 401 || full.status === 403) {
      // public_members is readable WITHOUT auth. Deliberately omit the
      // Authorization header here: reusing the service-token header would make
      // an expired/revoked/typoed service token 401 this public endpoint too
      // (Door43 returns 200 unauthenticated but 401 for an invalid token),
      // collapsing the last-resort fallback into an empty non-partial roster.
      const pub = await fetchOrgMembers(base, org, "public_members", { Accept: "application/json" });
      if (pub.ok) {
        return c.json({
          org,
          members: pub.members,
          truncated: pub.truncated,
          error: `dcs_${full.status}_public_only`,
          partial: true,
        });
      }
    }
    return c.json({
      org,
      members: [],
      error: full.status === 0 ? "dcs_bad_body" : `dcs_${full.status}`,
      truncated: false,
    });
  } catch {
    return c.json({ org, members: [], error: "network", truncated: false });
  }
});

// POST /api/admin/users/purge-manual — bulk-clear the seeded/hand-added
// allowlist so roles come from Door43 teams instead. Removes every
// source='manual' row; team-derived rows (source='dcs_team') are untouched,
// and a team-backed user whose manual row is cleared simply re-acquires the
// role from their team on their next sign-in (teams win — see dcsTeams.ts).
//
// Admin-set safety: dcs_team admins survive the purge regardless, so the admin
// set is only at risk when EVERY admin is a manual row. In that case one manual
// admin is KEPT — the caller if they're among them (an admin must not be able
// to lock themselves out), else the first — mirroring the last-admin guard in
// PUT/DELETE. Anything kept is reported so the UI can say so. This does NOT
// refuse to remove manual-only non-admins who thereby lose access: clearing
// them is the whole intent (the UI warns which ones up front); the guard only
// protects the ability to administer the project at all.
adminUsers.post("/purge-manual", async (c) => {
  // Clear stashed manual grants on team-derived rows FIRST, and unconditionally
  // (a stash can exist even when no visible `source='manual'` row does). When a
  // team signal took over a manual row, syncTeamRole stashes the prior grant in
  // manual_role and RESTORES it if the user later leaves the Door43 team (see
  // dcsTeams.ts). Left in place, a purged grant would silently resurface on
  // team departure — handing back the very access this action revokes. After a
  // purge, teams are the source of truth in both directions, so the stash must
  // go too. Wrapped: manual_role arrives with migration 0057, and the purge
  // must still work in the deploy-before-migrate window (nothing stashed yet).
  try {
    await c.env.DB.prepare(
      `UPDATE user_roles SET manual_role = NULL WHERE source = 'dcs_team' AND manual_role IS NOT NULL`,
    ).run();
  } catch {
    // No manual_role column yet (pre-0057) — nothing could have been stashed.
  }

  const { results: manualRows } = await c.env.DB.prepare(
    `SELECT dcs_username AS username, role AS role FROM user_roles WHERE source = 'manual'`,
  ).all<{ username: string; role: string }>();

  if (manualRows.length === 0) return c.json({ removed: [], kept: [] });

  const nonManualAdmins = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_roles WHERE role = 'admin' AND source != 'manual'`,
  ).first<{ n: number }>();

  const kept: string[] = [];
  if ((nonManualAdmins?.n ?? 0) === 0) {
    const manualAdmins = manualRows.filter((r) => r.role === "admin").map((r) => r.username);
    if (manualAdmins.length > 0) {
      const caller = (c.get("username") ?? "").toLowerCase();
      const keep = manualAdmins.find((u) => u.toLowerCase() === caller) ?? manualAdmins[0];
      kept.push(keep);
    }
  }

  const keptSet = new Set(kept.map((u) => u.toLowerCase()));
  const toRemove = manualRows.map((r) => r.username).filter((u) => !keptSet.has(u.toLowerCase()));
  if (toRemove.length === 0) return c.json({ removed: [], kept });

  // Delete by explicit username list rather than a self-referential
  // `DELETE ... WHERE source='manual' AND (SELECT COUNT admins)` — a COUNT
  // subquery over the same table being deleted from is order-dependent and
  // hazardous. The kept row is already excluded from the list, so a plain
  // IN-delete is both correct and can't empty the admin set.
  const placeholders = toRemove.map((_v, i) => `?${i + 1}`).join(",");
  await c.env.DB.prepare(`DELETE FROM user_roles WHERE dcs_username IN (${placeholders})`)
    .bind(...toRemove)
    .run();

  return c.json({ removed: toRemove, kept });
});

const PutBody = z.object({
  role: z.enum(["admin", "editor"]),
});

// PUT /api/admin/users/:username — add or change a user's role. Order of
// checks matters (see CLAUDE task spec): body shape, then username shape,
// then DCS existence (canonicalizes casing, fails open on network error),
// then the last-admin guard, then the upsert.
adminUsers.put("/:username", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsedBody = PutBody.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: "invalid_body", detail: parsedBody.error.issues }, 400);
  }
  const newRole = parsedBody.data.role;

  const pathUsername = c.req.param("username");
  if (!USERNAME_RE.test(pathUsername)) {
    return c.json({ error: "invalid_username" }, 400);
  }

  // DCS existence + canonical-casing lookup. No auth required to call this
  // endpoint, but attach the service token when configured (helps with rate
  // limits / private profiles) — same pattern as auth.ts's isViewerOrgMember.
  let canonicalUsername = pathUsername;
  let dcsVerified = true;
  try {
    const headers: Record<string, string> = {};
    if (c.env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${c.env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(
      `${c.env.DCS_BASE_URL}/api/v1/users/${encodeURIComponent(pathUsername)}`,
      { headers },
    );
    if (res.status === 404) {
      return c.json({ error: "dcs_user_not_found" }, 404);
    }
    if (!res.ok) {
      // Non-404 error status: treat like a network failure — fail open.
      dcsVerified = false;
    } else {
      const dcsUser = (await res.json()) as { login?: string };
      if (dcsUser.login) canonicalUsername = dcsUser.login;
    }
  } catch {
    // Network error: fail open, proceed with the path-param username.
    dcsVerified = false;
  }

  // Last-admin guard: refuse to demote the sole remaining admin. The count
  // check and the write happen inside ONE atomic SQL statement (the UPSERT's
  // WHERE clause) instead of a separate read-then-write round trip — two
  // concurrent demote requests can no longer both observe "count > 1" and
  // both write, since there's no gap between the check and the mutation for
  // them to interleave in. `role` (unqualified) refers to the pre-update row
  // being conflicted into; `excluded.role` is the incoming value. If the
  // WHERE evaluates false, the UPDATE is skipped and meta.changes is 0.
  //
  // Read the pre-edit source so the response can tell the UI the user is
  // team-managed (`wasTeamManaged`) — after the upsert below the row reads
  // 'manual', so the post-edit row can no longer carry that warning signal.
  const preEdit = await c.env.DB.prepare(
    `SELECT source FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(canonicalUsername)
    .first<{ source: string | null }>();

  // An admin edit takes MANUAL ownership of the row: source flips to
  // 'manual' and any stashed manual_role is cleared — this edit IS the
  // manual baseline now. Under teams-win (see dcsTeams.ts's syncTeamRole)
  // that ownership lasts only until the user's next team check: a team
  // signal re-takes the row (stashing this edit as the new manual_role, so
  // it resurfaces if they ever leave the team), which is why the UI warns
  // via `wasTeamManaged` that an edit to a team member's row won't stick
  // while they remain on the team.
  //
  // added_by is only set on first insert; ON CONFLICT preserves who originally
  // added them.
  const upsertSql = (withStash: boolean) =>
    `INSERT INTO user_roles (dcs_username, role, added_by, source) VALUES (?1, ?2, ?3, 'manual')
     ON CONFLICT(dcs_username) DO UPDATE SET
       role = excluded.role,
       source = 'manual'${withStash ? ",\n       manual_role = NULL" : ""}
     WHERE NOT (
       role = 'admin' AND excluded.role = 'editor'
       AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1
     )`;
  let upsert;
  try {
    upsert = await c.env.DB.prepare(upsertSql(true))
      .bind(canonicalUsername, newRole, currentUserId(c))
      .run();
  } catch {
    // Deploy-before-migrate window: `manual_role` arrives with migration 0057.
    // Admin edits must keep working through it — retry without the stash
    // column (there's nothing stashed to clear yet anyway).
    upsert = await c.env.DB.prepare(upsertSql(false))
      .bind(canonicalUsername, newRole, currentUserId(c))
      .run();
  }

  if (upsert.meta.changes === 0) {
    return c.json({ error: "last_admin" }, 409);
  }

  const row = await c.env.DB.prepare(`${ROLE_ROW_SELECT} WHERE dcs_username = ?1`)
    .bind(canonicalUsername)
    .first<RoleRow>();
  const addedByUsernames = await lookupAddedByUsernames(c.env, [row?.addedBy ?? null]);

  return c.json({
    user: {
      username: row?.username ?? canonicalUsername,
      role: row?.role ?? newRole,
      addedAt: row?.addedAt ?? null,
      addedBy: row?.addedBy != null ? (addedByUsernames.get(row.addedBy) ?? null) : null,
      // Post-edit source — 'manual' now that an admin edit takes ownership.
      source: row?.source ?? "manual",
    },
    // Must be returned: the panel keys its "this edit will be undone at the
    // next team check" warning off it. The post-edit row reads source='manual'
    // (the admin just took ownership), so the PRE-edit source is the only
    // remaining signal that this user is team-managed and the edit will be
    // re-taken by team sync while they stay on the team.
    wasTeamManaged: preEdit?.source === "dcs_team",
    dcsVerified,
  });
});

// DELETE /api/admin/users/:username — remove from the allowlist. Doesn't
// touch the `users` table (that's the DCS-account cache, unrelated).
adminUsers.delete("/:username", async (c) => {
  const username = c.req.param("username");

  // Read the source BEFORE deleting so the response can warn that removing a
  // team-derived row is only temporary — the user's next team check re-creates
  // it. Without this the API reports a plain success for an action that does
  // not actually revoke access, which is the more dangerous failure.
  const existing = await c.env.DB.prepare(
    `SELECT source FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first<{ source: string | null }>();

  // Same atomic-guard shape as PUT: the admin-COUNT check and the DELETE
  // happen in one statement, so two concurrent deletes of the last two
  // admins can't both pass a stale count and both succeed.
  const del = await c.env.DB.prepare(
    `DELETE FROM user_roles
      WHERE dcs_username = ?1
        AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)`,
  )
    .bind(username)
    .run();

  if (del.meta.changes > 0) {
    return c.json({ ok: true, wasTeamDerived: existing?.source === "dcs_team" });
  }

  // Zero changes means either the row never existed, or it existed but was
  // blocked by the guard — distinguish for the error code (UX only; the
  // admin-count invariant itself was already enforced atomically above).
  const stillRole = await lookupUserRole(c.env, username);
  return c.json(
    { error: stillRole === "admin" ? "last_admin" : "not_found" },
    stillRole === "admin" ? 409 : 404,
  );
});
