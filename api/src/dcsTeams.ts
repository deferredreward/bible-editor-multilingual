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
import { listWorkspaces } from "./workspaces.ts";

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
 * GET /api/v1/user/orgs with the user's own token — the set of Door43 orgs
 * they belong to, lowercased for case-insensitive compare against workspace
 * org names. (In Gitea, team membership implies org membership, so this set
 * is sufficient for workspace matching.)
 *
 * Returns `null` (never an empty set) on ANY failure — network, non-2xx,
 * unparseable body, or a paginated list truncated at the page cap — so
 * callers can distinguish "confirmed no orgs" from "couldn't check". The
 * latter must fail soft (keep the current/cookie workspace, keep cached
 * roles), never hard to "denied everywhere".
 *
 * Shared by the OAuth callback's login-time workspace resolution (auth.ts)
 * and the workspace switcher (workspaceRoutes.ts).
 */
export async function fetchMemberOrgs(
  env: Env,
  accessToken: string,
  deps?: { fetch?: typeof fetch },
): Promise<Set<string> | null> {
  const doFetch = deps?.fetch ?? fetch;
  const base = (env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const orgs = new Set<string>();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(
        `${base}/api/v1/user/orgs?limit=${PAGE_SIZE}&page=${page}`,
        { headers: { Authorization: `token ${accessToken}`, Accept: "application/json" } },
      );
      if (!res.ok) {
        console.warn(`[dcsTeams] /user/orgs page ${page} returned ${res.status}`);
        return null;
      }
      const batch = (await res.json()) as unknown;
      if (!Array.isArray(batch)) {
        console.warn("[dcsTeams] /user/orgs returned a non-array body");
        return null;
      }
      for (const o of batch as Array<{ username?: string }>) {
        const name = (o?.username ?? "").toLowerCase();
        if (name) orgs.add(name);
      }
      if (batch.length < PAGE_SIZE) return orgs;
    }
  } catch (err) {
    console.warn(`[dcsTeams] /user/orgs fetch failed: ${String(err)}`);
    return null;
  }
  console.warn(`[dcsTeams] /user/orgs exceeded ${MAX_PAGES} pages; treating as unknown`);
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
  const names = teamRoleNames(env);
  const role = roleFromTeams(teams, org, names);
  if (role === null) {
    // Near-miss diagnostic: the user IS on teams in this org, just none whose
    // name matches the configured admin/editor team names. Without this line
    // a misnamed team (real case: a Door43 team created as "BE-Admin" while
    // the default is the plural "BE-Admins") silently degrades every member
    // to viewer/denied and is indistinguishable, from the outside, from "not
    // on any team". `wrangler tail` is the intended diagnostic; the fix is to
    // rename the team or set DCS_TEAM_ADMIN / DCS_TEAM_EDITOR.
    const wantOrg = org.trim().toLowerCase();
    const inOrg = teams
      .filter((t) => (t?.organization?.username ?? "").toLowerCase() === wantOrg)
      .map((t) => (t?.name ?? "").trim())
      .filter(Boolean);
    if (inOrg.length > 0) {
      console.warn(
        `[dcsTeams] user has teams in org "${org}" but none match the configured role teams ` +
          `(admin="${names.admin}", editor="${names.editor}"); their teams there: ${inOrg.join(", ")}`,
      );
    }
  }
  return { known: true, role };
}

/**
 * Sync the team-derived role into `user_roles` so /api/auth/refresh (which
 * re-reads that table) needs no DCS round-trip on every request.
 *
 * Precedence, stated as one rule: **Door43 teams win; a manual row is only a
 * fallback for users with no team signal at all.**
 *
 *  - A team role (admin/editor) OVERWRITES the row — role AND source — even
 *    when the existing row was a manual allowlist grant. Once a user has a
 *    team signal, Door43 is authoritative for them in both directions:
 *    promotion, demotion, and (below) removal. (The earlier revision let a
 *    manual admin row survive a team-says-editor sync, which meant the
 *    documented management path — move the user between teams in Door43 —
 *    silently did nothing for allowlisted users.)
 *  - No team signal (`role === null`, membership positively known) deletes
 *    ONLY `source = 'dcs_team'` rows. A manual row that team sync never
 *    claimed survives and keeps acting as the fallback grant.
 *  - The last remaining admin is never demoted OR deleted, matching the guards
 *    in adminUserRoutes.ts. Leaving a Door43 team must not be able to empty the
 *    admin set: `/api/admin/users` is itself admin-gated, so a zero-admin
 *    project can only be repaired with raw SQL against D1. A guard-refused
 *    demotion leaves role AND source untouched.
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
    // row permanently stale and re-hit DCS on every single refresh. The same
    // last-admin condition gates `source` so a refused demotion doesn't hand
    // the (still-admin) row to team ownership, where the DELETE path's guard
    // would then be the only thing standing between it and removal.
    await env.DB.prepare(
      `INSERT INTO user_roles (dcs_username, role, source, synced_at)
       VALUES (?1, ?2, 'dcs_team', unixepoch())
       ON CONFLICT(dcs_username) DO UPDATE SET
         synced_at = unixepoch(),
         role = CASE
           WHEN NOT (user_roles.role = 'admin' AND excluded.role = 'editor'
                     AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)
             THEN excluded.role
           ELSE user_roles.role
         END,
         source = CASE
           WHEN NOT (user_roles.role = 'admin' AND excluded.role = 'editor'
                     AND (SELECT COUNT(*) FROM user_roles WHERE role = 'admin') <= 1)
             THEN 'dcs_team'
           ELSE user_roles.source
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
 *
 * When workspaces are configured (one D1 per Door43 org — see workspaces.ts),
 * the registry entry for the ACTIVE workspace wins over the project_config
 * read. Two reasons: the registry is the authoritative statement of which org
 * this database belongs to, and a freshly created workspace has no
 * project_config row yet — the read below would return null and silently skip
 * team sync for exactly the org someone is trying to bootstrap. Falling back
 * to project_config keeps single-workspace deployments (production today,
 * where WORKSPACES is empty) behaving exactly as before; note VIEWER_ORG is
 * NOT a safe substitute there, since in a single-org deployment it is a
 * separate viewer-access setting that need not equal the project's own org.
 */
export async function orgForTeamSync(env: Env): Promise<string | null> {
  if ((env.WORKSPACES ?? "").trim()) {
    const active = listWorkspaces(env).find((w) => w.slug === env.WORKSPACE_SLUG);
    if (active) return active.org;
  }
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

/**
 * Full pipeline for one user: resolve the org this env belongs to, ask DCS
 * which teams they're on, cache the mapped role into user_roles.
 *
 * `env` decides WHICH workspace's org is matched and WHICH database is
 * written — callers switching/landing a user in a non-request workspace must
 * pass the derived `workspaceEnv(...)`, not the request env.
 *
 * NOTHING here may break sign-in. Every failure mode — DCS unreachable, the
 * project org unknown, a D1 error (notably `no such column: source` in the
 * window between deploying the worker and applying migration 0055, since code
 * normally ships before migrations) — must leave the existing allowlist exactly
 * as it was and let the caller fall through to the pre-existing gate. A thrown
 * error here would 500 the OAuth callback and lock EVERY user out, admins
 * included, which is strictly worse than the feature silently not applying.
 */
export async function syncTeamRoleForUser(
  env: Env,
  dcsUsername: string,
  accessToken: string,
): Promise<void> {
  try {
    const org = await orgForTeamSync(env);
    if (!org) return; // project never onboarded, or the config read failed
    const team = await resolveTeamRole(env, org, accessToken);
    if (!team.known) return; // DCS didn't answer — never read that as "no teams"
    await syncTeamRole(env, dcsUsername, team.role);
  } catch (err) {
    console.warn(`[dcsTeams] team role sync failed for ${dcsUsername}: ${String(err)}`);
  }
}
