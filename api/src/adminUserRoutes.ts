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

export const adminUsers = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

adminUsers.use("*", requireAuth, requireAdmin);

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

// Raw user_roles row before the added_by user id is resolved to a username.
type RoleRow = { username: string; role: string; addedAt: number; addedBy: number | null };

// user_roles is per-org (env.DB); the users table it used to LEFT JOIN for
// added_by's display name is shared across workspaces (SHARED_DB) — the two
// can no longer live in one SQL statement, so this fetches user_roles rows
// first and resolves added_by usernames from the shared DB as a second step.
const ROLE_ROW_SELECT = `SELECT dcs_username AS username, role AS role, added_at AS addedAt, added_by AS addedBy
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
    })),
  });
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
  // added_by is only set on first insert; ON CONFLICT only touches role, so
  // re-promoting/demoting an existing user preserves who originally added them.
  const upsert = await c.env.DB.prepare(
    `INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?1, ?2, ?3)
     ON CONFLICT(dcs_username) DO UPDATE SET role = excluded.role
     WHERE NOT (
       role = 'admin' AND excluded.role = 'editor'
       AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1
     )`,
  )
    .bind(canonicalUsername, newRole, currentUserId(c))
    .run();

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
    },
    dcsVerified,
  });
});

// DELETE /api/admin/users/:username — remove from the allowlist. Doesn't
// touch the `users` table (that's the DCS-account cache, unrelated).
adminUsers.delete("/:username", async (c) => {
  const username = c.req.param("username");

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
    return c.json({ ok: true });
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
