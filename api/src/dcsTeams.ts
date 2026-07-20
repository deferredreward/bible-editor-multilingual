// Reads Door43 (Gitea) team membership and maps it to an app role.
//
// This is the READ-ONLY half of "Door43 teams as role source" (docs/deferred.md):
// teams are created and managed in Door43's own team UI; the editor never writes
// membership. At OAuth callback we ask DCS which teams the signing-in user
// belongs to (with the *user's own* access token — no elevated service-token
// scope needed), keep only the teams inside the configured project org, and map
// the team name to admin/editor. The result is cached into `user_roles` so the
// refresh path (api/src/auth.ts) keeps working off a plain D1 read.
//
// Team names are conventional, not hardcoded policy: DCS_TEAM_ADMIN /
// DCS_TEAM_EDITOR override them per environment, mirroring the VIEWER_ORG idiom
// already used for the viewer-org check.

import type { Env } from "./index";
import type { Role } from "./auth.ts";
import { materialize } from "./projectConfig.ts";

export const DEFAULT_ADMIN_TEAM = "BE-Admins";
export const DEFAULT_EDITOR_TEAM = "BE-Editors";

export interface TeamRoleNames {
  admin: string;
  editor: string;
}

export function teamRoleNames(env: Env): TeamRoleNames {
  return {
    admin: (env.DCS_TEAM_ADMIN ?? "").trim() || DEFAULT_ADMIN_TEAM,
    editor: (env.DCS_TEAM_EDITOR ?? "").trim() || DEFAULT_EDITOR_TEAM,
  };
}

export interface DcsTeam {
  name?: string;
  organization?: { username?: string } | null;
}

// Gitea caps page size; 50 matches listOrgRepos in orgInference.ts. A user in
// more than MAX_PAGES*PAGE_SIZE teams is not a real case — the cap just bounds
// the worst case on a login round-trip. Exhausting the cap is treated as an
// INCOMPLETE answer (null), not as a complete one: a truncated list that
// happens to omit the project org's team would otherwise look exactly like
// "not on any team" and revoke a legitimate role.
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

// A cached team role is re-checked against DCS this often (see maybeResync in
// api/src/auth.ts). Without it, removing someone from a Door43 team wouldn't
// take effect until their next *full* sign-in — up to the 14-day refresh
// window — because refresh reads only user_roles.
export const RESYNC_AFTER_SECONDS = 3600;

/**
 * GET /api/v1/user/teams for the signed-in user.
 *
 * Returns `null` on ANY failure (network, non-2xx, unparseable body). Callers
 * MUST treat null as "unknown", not as "no teams" — a DCS outage must never be
 * read as a revocation, or every login during the outage would strip cached
 * team roles out of `user_roles`.
 */
export async function listUserTeams(
  env: Env,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<DcsTeam[] | null> {
  const doFetch = deps?.fetch ?? fetch;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const teams: DcsTeam[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(
        `${base}/api/v1/user/teams?limit=${PAGE_SIZE}&page=${page}`,
        { headers: { Authorization: `token ${accessToken}`, Accept: "application/json" } },
      );
      if (!res.ok) {
        // Logged, not silent: a persistent 403 here (e.g. the OAuth grant not
        // carrying org-read scope) would otherwise make the whole feature a
        // no-op that is indistinguishable, from the outside, from "this user
        // is on no teams". `wrangler tail` is the intended diagnostic.
        console.warn(`[dcsTeams] /user/teams page ${page} returned ${res.status}`);
        return null;
      }
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) {
        console.warn("[dcsTeams] /user/teams returned a non-array body");
        return null;
      }
      teams.push(...(batch as DcsTeam[]));
      if (batch.length < PAGE_SIZE) return teams;
    }
  } catch (err) {
    console.warn(`[dcsTeams] /user/teams fetch failed: ${String(err)}`);
    return null;
  }
  // Ran out of pages with the last one still full — the list is truncated, so
  // we don't know the user's full membership. Unknown, not empty.
  console.warn(`[dcsTeams] /user/teams exceeded ${MAX_PAGES} pages; treating as unknown`);
  return null;
}

/**
 * Highest role granted by the user's teams *within `org`*. Team names and org
 * names both compare case-insensitively (Gitea itself is case-insensitive on
 * org names). Membership in neither team → null.
 */
export function roleFromTeams(
  teams: DcsTeam[],
  org: string,
  names: TeamRoleNames,
): Role | null {
  const wantOrg = org.trim().toLowerCase();
  const adminTeam = names.admin.toLowerCase();
  const editorTeam = names.editor.toLowerCase();
  let role: Role | null = null;
  for (const t of teams) {
    if ((t?.organization?.username ?? "").toLowerCase() !== wantOrg) continue;
    const name = (t?.name ?? "").trim().toLowerCase();
    if (name === adminTeam) return "admin"; // highest — nothing can beat it
    if (name === editorTeam) role = "editor";
  }
  return role;
}

/** Convenience: fetch + map. `null` means "no team role, or DCS didn't answer". */
export async function resolveTeamRole(
  env: Env,
  org: string,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<{ known: boolean; role: Role | null }> {
  const teams = await listUserTeams(env, accessToken, deps);
  if (teams === null) return { known: false, role: null };
  return { known: true, role: roleFromTeams(teams, org, teamRoleNames(env)) };
}

/**
 * Sync the team-derived role into `user_roles` so /api/auth/refresh (which
 * re-reads that table) needs no DCS round-trip on every request.
 *
 * Precedence, stated as one rule: **a row belongs to whoever created it, and
 * Door43 teams may only ever raise access on rows they don't own.**
 *
 *  - `source = 'dcs_team'` rows track their team exactly, in both directions —
 *    including removal once the user leaves the team.
 *  - `source = 'manual'` rows belong to the admin who added them. A team can
 *    PROMOTE such a user (editor → admin, e.g. adding a legacy allowlist entry
 *    to BE-Admins) but can never demote or delete them; only an admin can do
 *    that, in the Preferences panel.
 *  - `source` itself never changes after insert, so a row stays under the
 *    management of whoever created it. (An earlier revision flipped a team row
 *    to 'manual' on any admin edit, which silently detached it from team sync
 *    and made removal-from-team stop revoking — the documented management path
 *    would have quietly done nothing.)
 *  - The last remaining admin is never demoted OR deleted, matching the guards
 *    in adminUserRoutes.ts. Leaving a Door43 team must not be able to empty the
 *    admin set: `/api/admin/users` is itself admin-gated, so a zero-admin
 *    project can only be repaired with raw SQL against D1.
 *
 * `synced_at` is stamped on every successful sync (even a no-op one) so the
 * refresh path can tell a freshly-checked row from a stale one.
 */
export async function syncTeamRole(
  env: Env,
  dcsUsername: string,
  role: Role | null,
): Promise<void> {
  if (role === "admin" || role === "editor") {
    // The role decision is a CASE inside SET rather than a WHERE on the whole
    // UPDATE so that `synced_at` is refreshed even when the role is unchanged
    // or the change is refused — otherwise a declined update would leave the
    // row permanently stale and re-hit DCS on every single refresh.
    await env.DB.prepare(
      `INSERT INTO user_roles (dcs_username, role, source, synced_at)
       VALUES (?1, ?2, 'dcs_team', unixepoch())
       ON CONFLICT(dcs_username) DO UPDATE SET
         synced_at = unixepoch(),
         role = CASE
           WHEN user_roles.source = 'dcs_team'
                AND NOT (user_roles.role = 'admin' AND excluded.role = 'editor'
                         AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)
             THEN excluded.role
           WHEN user_roles.source <> 'dcs_team'
                AND user_roles.role = 'editor' AND excluded.role = 'admin'
             THEN excluded.role
           ELSE user_roles.role
         END`,
    )
      .bind(dcsUsername, role)
      .run();
    return;
  }
  await env.DB.prepare(
    `DELETE FROM user_roles
      WHERE dcs_username = ?1
        AND source = 'dcs_team'
        AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)`,
  )
    .bind(dcsUsername)
    .run();
}

/**
 * The org to match teams against — read straight from D1 rather than through
 * getProjectConfig, which deliberately swallows read errors and falls back to
 * the default (unfoldingWord/en) preset. That fallback is right for import and
 * export paths but catastrophic here: matching a GL project's users against
 * unfoldingWord's teams would revoke every team-derived role on a transient D1
 * hiccup, and could grant admin to an unfoldingWord BE-Admins member on a
 * project they have nothing to do with.
 *
 * Returns null when the org can't be established (read failed, or the project
 * has never been onboarded) — callers must skip the sync entirely, not guess.
 */
export async function orgForTeamSync(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT preset, overrides_json FROM project_config WHERE id = 1",
    ).first<{ preset: string; overrides_json: string | null }>();
    if (!row) return null;
    return materialize(row.preset, row.overrides_json).org || null;
  } catch {
    return null;
  }
}
