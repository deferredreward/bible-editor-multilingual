// Auto-claim a spare-pool workspace at first admin login (issue #81, PR-3).
//
// PR-2 built the mechanism (registerPoolSlot / claimWorkspace in workspaces.ts)
// and a super-admin API to drive it by hand. This module is the automatic
// caller: when someone signs in who is an ADMIN of a Door43 org that has no
// workspace in the registry yet, one `available` pool slot is flipped to
// `claimed` for that org — so the org onboards itself with no redeploy and no
// operator round-trip. Full dynamic provisioning (create a D1 over the HTTP API
// at runtime) stays parked; the pool is pre-provisioned by an operator.
//
// "ADMIN" here means exactly what it means everywhere else in this codebase:
// membership of the org's configured admin team (`BE-Admins` by default,
// DCS_TEAM_ADMIN to override), as decided by roleFromTeams. Being an org
// *Owner* in Door43 is NOT admin — Gitea's built-in Owners team is not the
// admin team, and no other team name grants it either. Editors don't claim:
// onboarding an org is an administrative act.
//
// NOTHING here may break sign-in. Every failure mode — DCS unreachable, an
// exhausted pool, a D1 error, a malformed org name — returns an outcome and
// lets the caller proceed with today's no-workspace behavior (the user resolves
// against the existing roster exactly as before this feature existed). That is
// why the whole body sits under one try/catch and why `teams === null` is read
// as "unknown", never as "not an admin".
//
// It lives in its own module rather than in workspaces.ts because the admin
// decision needs dcsTeams.ts, which already imports workspaces.ts — putting it
// there would create an import cycle.

import type { Env } from "./index";
import { claimWorkspace, explicitWorkspaces, listWorkspaces } from "./workspaces.ts";
import { listUserTeams, roleFromTeams, teamRoleNames, type DcsTeam } from "./dcsTeams.ts";
import { isIdent } from "./repoUrl.ts";

export type AutoClaimOutcome =
  | "disabled" // WORKSPACE_AUTOCLAIM is not "true" — the default
  | "roster_not_configured" // no explicit roster to add to; writing a row would evict the live default
  | "no_candidate_org" // every org they belong to already has a workspace (or membership unknown)
  | "teams_unknown" // DCS didn't answer the teams call — never read as "not an admin"
  | "not_admin" // candidate orgs exist, but they're not on any of their admin teams
  | "pool_exhausted" // admin of an unregistered org, but no claimable `available` slot
  | "already_claimed" // the org already owned a slot (idempotent re-login / race loser)
  | "claimed" // a slot was claimed for the org
  | "error"; // unexpected failure — logged; login proceeds unchanged

export interface AutoClaimResult {
  outcome: AutoClaimOutcome;
  /** Canonical (DCS-cased) org name, when a candidate was acted on. */
  org?: string;
  /** Slug of the claimed workspace, on "claimed" / "already_claimed". */
  slug?: string;
  /**
   * The DCS `/user/teams` listing, when one was fetched — so the caller's own
   * team-role sync can reuse it instead of paying a second paginated listing
   * on the login path. `undefined` = not fetched; `null` = DCS didn't answer
   * (which callers must read as "unknown", never as "no teams").
   */
  teams?: DcsTeam[] | null;
}

// DCS's own casing for `orgLower`, taken from the teams payload we already hold
// (`organization.username`). Issue #306: the claimed `workspaces.org` becomes
// VIEWER_ORG for every downstream comparison, so it must carry DCS's casing —
// and the teams response is DCS, so this needs no extra round-trip the way the
// manual claim route's canonicalOrgName lookup does.
function canonicalOrgFromTeams(teams: DcsTeam[], orgLower: string): string | null {
  for (const t of teams) {
    const name = (t?.organization?.username ?? "").trim();
    if (name && name.toLowerCase() === orgLower) return name;
  }
  return null;
}

/**
 * Claim a pool slot for a signing-in admin's un-onboarded org.
 *
 * Call this from the OAuth callback AFTER the user's org memberships are known
 * and BEFORE login-time workspace resolution, then re-read `listWorkspaces(env)`
 * — a successful claim re-primes this isolate's registry cache, so the new
 * workspace is immediately resolvable and the user lands in it.
 *
 * At most ONE slot is claimed per login: candidate orgs are tried in sorted
 * order and the first admin match wins. That bounds what a single sign-in can
 * consume from an operator-provisioned pool; an admin of two new orgs onboards
 * the second on their next login, which is self-healing and needs no operator.
 *
 * Idempotent: on the next login the org is in the roster, so it isn't a
 * candidate at all and the DCS teams call is never even made. `claimWorkspace`
 * is itself idempotent (COLLATE NOCASE org lookup) as the second layer, which
 * is also what recovers the loser of a two-isolate race.
 */
export async function autoClaimWorkspaceForAdmin(
  env: Env,
  opts: {
    /** Lowercased Door43 orgs from fetchMemberOrgs; null = the fetch failed. */
    memberOrgs: Set<string> | null;
    accessToken: string;
    dcsUsername: string;
    deps?: { fetch?: typeof fetch };
  },
): Promise<AutoClaimResult> {
  try {
    // Off unless a deployment opts in. Checked FIRST so a deployment that
    // hasn't enabled it pays nothing at all — not even the DCS teams listing.
    if ((env.WORKSPACE_AUTOCLAIM ?? "").trim() !== "true") return { outcome: "disabled" };
    if (!opts.memberOrgs || opts.memberOrgs.size === 0) return { outcome: "no_candidate_org" };

    // Refuse while the roster is only the synthetic implicit default. There,
    // the deployment's live database is NOT a registry row — it materializes
    // only while the registry is empty — so the first claimed row written
    // would become the entire roster and evict it: every existing user's
    // be_ws cookie would resolve to the newly claimed (empty) database, and
    // their next login would land in another tenant's workspace or be denied.
    // An operator makes the existing workspace explicit first (seed WORKSPACES
    // with it; primeWorkspaces persists it as a claimed row), and only then is
    // adding a row an ADDITION rather than a replacement.
    if (explicitWorkspaces(env).length === 0) {
      console.warn(
        `[autoClaim] refusing to claim: this deployment has no explicit workspace roster ` +
          `(registry empty and WORKSPACES unset), so a claim would evict the default workspace`,
      );
      return { outcome: "roster_not_configured" };
    }

    const known = new Set(listWorkspaces(env).map((w) => w.org.trim().toLowerCase()));
    const candidates = [...opts.memberOrgs].filter((o) => o && !known.has(o)).sort();
    // The overwhelmingly common path — every repeat login, and every user whose
    // orgs are already onboarded — costs one in-memory set diff and no I/O.
    if (candidates.length === 0) return { outcome: "no_candidate_org" };

    const teams = await listUserTeams(env, opts.accessToken, opts.deps);
    if (teams === null) return { outcome: "teams_unknown", teams: null };

    const names = teamRoleNames(env);
    for (const orgLower of candidates) {
      if (roleFromTeams(teams, orgLower, names) !== "admin") continue;
      const org = canonicalOrgFromTeams(teams, orgLower) ?? orgLower;
      // claimWorkspace throws on a non-ident org rather than persisting a
      // corrupt row; skip such a candidate so one odd org name can't stop a
      // later, valid one from onboarding.
      if (!isIdent(org) || org.length > 64) {
        console.warn(`[autoClaim] skipping org with unusable name for ${opts.dcsUsername}: ${JSON.stringify(org)}`);
        continue;
      }
      const result = await claimWorkspace(env, { org, label: org });
      if (!result) {
        // Pool exhausted. Fail SOFT: the admin still signs in (against the
        // existing roster, exactly as before this feature), and an operator
        // provisions another slot — see docs/workspace-pool.md.
        console.warn(`[autoClaim] pool exhausted; no slot available for org "${org}" (${opts.dcsUsername})`);
        return { outcome: "pool_exhausted", org, teams };
      }
      console.log(
        `[autoClaim] ${result.alreadyClaimed ? "org already had" : "claimed"} workspace ` +
          `"${result.workspace.slug}" for org "${result.workspace.org}" (${opts.dcsUsername})`,
      );
      return {
        outcome: result.alreadyClaimed ? "already_claimed" : "claimed",
        org: result.workspace.org,
        slug: result.workspace.slug,
        teams,
      };
    }
    return { outcome: "not_admin", teams };
  } catch (err) {
    // A throw here would 500 the OAuth callback and lock everyone out, which is
    // strictly worse than the feature silently not applying.
    console.warn(`[autoClaim] failed for ${opts.dcsUsername}: ${String(err)}`);
    return { outcome: "error" };
  }
}
