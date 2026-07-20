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
// more than MAX_PAGES*50 teams is not a real case — the cap just bounds the
// worst case on a login round-trip.
const PAGE_SIZE = 50;
const MAX_PAGES = 5;

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
      if (!res.ok) return null;
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) return null;
      teams.push(...(batch as DcsTeam[]));
      if (batch.length < PAGE_SIZE) break;
    }
  } catch {
    return null;
  }
  return teams;
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
 * re-reads that table) needs no DCS round-trip.
 *
 * Rules:
 *  - Rows added by an admin through the in-app UI (`source = 'manual'`) are
 *    authoritative and are never overwritten or deleted here. Door43 teams add
 *    access; they don't take away what an admin granted directly.
 *  - Rows we previously derived from a team (`source = 'dcs_team'`) are kept in
 *    step with DCS on every login, including removal when the user has left the
 *    team.
 *  - The last remaining admin is never deleted, matching the guard in
 *    adminUserRoutes.ts — otherwise leaving a Door43 team could lock everyone
 *    out of the admin surface.
 */
export async function syncTeamRole(
  env: Env,
  dcsUsername: string,
  role: Role | null,
): Promise<void> {
  if (role === "admin" || role === "editor") {
    await env.DB.prepare(
      `INSERT INTO user_roles (dcs_username, role, source) VALUES (?1, ?2, 'dcs_team')
       ON CONFLICT(dcs_username) DO UPDATE SET role = excluded.role
       WHERE user_roles.source = 'dcs_team' AND user_roles.role <> excluded.role`,
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
