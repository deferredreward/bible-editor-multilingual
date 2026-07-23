// Auto-provisioning at first admin login (issue #81, PR-3).
//
// When a Door43 admin (BE-Admins team member) of an org that has no workspace
// yet signs in, the OAuth callback would otherwise deny them — there's no
// database for their org. This claims a pre-provisioned spare-pool slot for that
// org (PR-2's claimWorkspace) so they land in a freshly provisioned workspace
// instead. The callback then re-resolves the login against the refreshed roster.
//
// Hard rule (inherited from syncTeamRoleForUser): NOTHING here may break sign-in.
// The caller wraps this in try/catch and treats any failure as "no claim" — the
// pre-existing deny path stands. This module never throws for the ordinary
// "DCS unknown" / "pool exhausted" / "not an admin" cases; it returns null.

import type { Env } from "./index";
import { listUserTeams as realListUserTeams, teamRoleNames } from "./dcsTeams.ts";
import { claimWorkspace as realClaimWorkspace, type Workspace } from "./workspaces.ts";
import { isIdent } from "./repoUrl.ts";

export interface AutoClaimInput {
  accessToken: string;
  // Lowercased Door43 orgs the user belongs to; null = orgs fetch failed
  // ("unknown"). Null MUST NOT trigger a claim — we never guess membership.
  memberOrgs: Set<string> | null;
  // Lowercased orgs that already have a workspace (claimed or configured) — a
  // claim is only for an org with NO workspace yet.
  existingOrgs: Set<string>;
}

// Injectable for tests (avoids DCS + D1).
export interface AutoClaimDeps {
  listUserTeams?: typeof realListUserTeams;
  claimWorkspace?: typeof realClaimWorkspace;
}

// Canonical org names (DCS casing) the user administers, that have no workspace
// yet, and that they're a confirmed member of — deterministically ordered.
export function selectClaimableAdminOrgs(
  teams: Array<{ name?: string; organization?: { username?: string } | null }>,
  adminTeamName: string,
  input: AutoClaimInput,
): string[] {
  const adminTeam = adminTeamName.trim().toLowerCase();
  const memberOrgs = input.memberOrgs;
  const out = new Set<string>();
  for (const t of teams) {
    if ((t?.name ?? "").trim().toLowerCase() !== adminTeam) continue;
    const org = (t?.organization?.username ?? "").trim();
    if (!org || !isIdent(org)) continue;
    const lower = org.toLowerCase();
    if (input.existingOrgs.has(lower)) continue; // already has a workspace
    if (!memberOrgs || !memberOrgs.has(lower)) continue; // must be a confirmed member
    out.add(org);
  }
  return [...out].sort();
}

// Claims a spare-pool slot for the first org the user administers that lacks a
// workspace. Returns the claimed Workspace, or null when nothing was claimed
// (orgs unknown, DCS unreachable, not an admin of any unclaimed org, or the pool
// is exhausted). The caller re-resolves the login workspace afterward.
export async function autoClaimAdminOrg(
  env: Env,
  input: AutoClaimInput,
  deps: AutoClaimDeps = {},
): Promise<Workspace | null> {
  if (!input.memberOrgs) return null; // orgs unknown — never guess

  const listUserTeams = deps.listUserTeams ?? realListUserTeams;
  const claimWorkspace = deps.claimWorkspace ?? realClaimWorkspace;

  const teams = await listUserTeams(env, input.accessToken);
  if (teams === null) return null; // DCS didn't answer — don't guess

  const candidates = selectClaimableAdminOrgs(teams, teamRoleNames(env).admin, input);
  for (const org of candidates) {
    const result = await claimWorkspace(env, { org, label: org });
    if (result) return result.workspace;
    // null = the spare pool is exhausted. Every further claim would fail the
    // same way, so stop and let the deny path stand — the operator needs to add
    // pool capacity (see docs/workspace-pool.md).
    console.warn(
      `[workspaces] admin login for org "${org}" but the spare pool is exhausted — add capacity (docs/workspace-pool.md)`,
    );
    return null;
  }
  return null;
}
