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
import { requireAuth, requireAdmin, currentUserId, lookupUserRole } from "./auth.ts";
import { sharedDb } from "./workspaces.ts";
import { getProjectConfig } from "./projectConfig.ts";

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

type OrgMember = { login: string; fullName: string; avatarUrl: string };

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
adminUsers.get("/org-members", async (c) => {
  const { org } = await getProjectConfig(c.env);
  const base = (c.env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");

  if (!org) {
    // No org configured (e.g. an unconfigured workspace) — nothing to list, but
    // this isn't an error the admin can act on, so report an empty roster.
    return c.json({ org, members: [], truncated: false });
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (c.env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${c.env.DCS_SERVICE_TOKEN}`;

  const members: OrgMember[] = [];
  try {
    let truncated = false;
    for (let page = 1; page <= MEMBERS_MAX_PAGES; page++) {
      const res = await fetch(
        `${base}/api/v1/orgs/${encodeURIComponent(org)}/members?limit=${MEMBERS_PAGE_SIZE}&page=${page}`,
        { headers },
      );
      if (!res.ok) {
        return c.json({ org, members: [], error: `dcs_${res.status}`, truncated: false });
      }
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) {
        return c.json({ org, members: [], error: "dcs_bad_body", truncated: false });
      }
      for (const m of batch as Array<{ login?: string; full_name?: string; avatar_url?: string }>) {
        if (m.login) {
          members.push({ login: m.login, fullName: m.full_name ?? "", avatarUrl: m.avatar_url ?? "" });
        }
      }
      if (batch.length < MEMBERS_PAGE_SIZE) break;
      // Last allowed page still full — the roster is longer than we fetched.
      if (page === MEMBERS_MAX_PAGES) truncated = true;
    }
    return c.json({ org, members, truncated });
  } catch {
    return c.json({ org, members: [], error: "network", truncated: false });
  }
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
