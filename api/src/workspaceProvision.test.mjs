// Unit tests for auto-provisioning at first admin login (issue #81, PR-3):
// selectClaimableAdminOrgs + autoClaimAdminOrg in workspaceProvision.ts.
//
// Pure/dep-injected — no DCS, no D1. listUserTeams + claimWorkspace are stubbed.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceProvision.test.mjs

import { selectClaimableAdminOrgs, autoClaimAdminOrg } from "./workspaceProvision.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const team = (name, org) => ({ name, organization: { username: org } });

// ── selectClaimableAdminOrgs ─────────────────────────────────────────────────

console.log("[selectClaimableAdminOrgs] picks admin-team orgs w/o a workspace the user is a member of");
{
  const teams = [
    team("BE-Admins", "AlphaOrg"), // admin, no workspace, member -> pick
    team("BE-Editors", "BetaOrg"), // editor team -> excluded
    team("BE-Admins", "GammaOrg"), // admin but already has a workspace -> excluded
    team("BE-Admins", "DeltaOrg"), // admin but not a confirmed member -> excluded
    team("BE-Admins", "AlphaOrg"), // duplicate -> deduped
  ];
  const input = {
    accessToken: "t",
    memberOrgs: new Set(["alphaorg", "betaorg", "gammaorg"]), // NOT deltaorg
    existingOrgs: new Set(["gammaorg"]),
  };
  const picked = selectClaimableAdminOrgs(teams, "BE-Admins", input);
  assert(picked.length === 1 && picked[0] === "AlphaOrg", "only AlphaOrg selected (canonical case), others excluded");
}

console.log("[selectClaimableAdminOrgs] deterministic sort + ident validation + null memberOrgs");
{
  const teams = [team("BE-Admins", "Zeta"), team("BE-Admins", "Acme"), team("BE-Admins", "bad org!")];
  const picked = selectClaimableAdminOrgs(teams, "BE-Admins", {
    accessToken: "t",
    memberOrgs: new Set(["zeta", "acme", "bad org!"]),
    existingOrgs: new Set(),
  });
  assert(picked.length === 2 && picked[0] === "Acme" && picked[1] === "Zeta", "sorted; invalid ident dropped");

  const none = selectClaimableAdminOrgs(teams, "BE-Admins", { accessToken: "t", memberOrgs: null, existingOrgs: new Set() });
  assert(none.length === 0, "null memberOrgs -> nothing selected");
}

// ── autoClaimAdminOrg (dep-injected) ─────────────────────────────────────────

const WS = { slug: "pool1", label: "AlphaOrg", org: "AlphaOrg", binding: "DB_POOL1" };

function deps({ teams = [], claim = async () => ({ workspace: WS, alreadyClaimed: false }) } = {}) {
  const calls = { list: 0, claim: [] };
  return {
    calls,
    listUserTeams: async () => {
      calls.list++;
      return teams;
    },
    claimWorkspace: async (_env, opts) => {
      calls.claim.push(opts);
      return claim(opts);
    },
  };
}

console.log("[autoClaimAdminOrg] claims the first unclaimed admin org");
{
  const d = deps({ teams: [team("BE-Admins", "AlphaOrg")] });
  const ws = await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: new Set(["alphaorg"]), existingOrgs: new Set() }, d);
  assert(ws && ws.slug === "pool1", "returns the claimed workspace");
  assert(d.calls.claim.length === 1 && d.calls.claim[0].org === "AlphaOrg" && d.calls.claim[0].label === "AlphaOrg", "claimWorkspace called with canonical org + label");
}

console.log("[autoClaimAdminOrg] fail-soft guards — never claims when it must not");
{
  // memberOrgs unknown -> no DCS call, no claim.
  const d1 = deps({ teams: [team("BE-Admins", "AlphaOrg")] });
  assert((await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: null, existingOrgs: new Set() }, d1)) === null, "memberOrgs null -> null");
  assert(d1.calls.list === 0 && d1.calls.claim.length === 0, "no teams fetch, no claim when orgs unknown");

  // listUserTeams returns null (DCS unknown) -> no claim.
  const d2 = { listUserTeams: async () => null, claimWorkspace: async () => { throw new Error("must not claim"); } };
  assert((await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: new Set(["alphaorg"]), existingOrgs: new Set() }, d2)) === null, "listUserTeams null -> null");

  // Not an admin of any unclaimed org -> no claim.
  const d3 = deps({ teams: [team("BE-Editors", "AlphaOrg")] });
  assert((await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: new Set(["alphaorg"]), existingOrgs: new Set() }, d3)) === null, "only an editor -> null");
  assert(d3.calls.claim.length === 0, "no claim when not an admin");

  // Admin org already has a workspace -> no claim.
  const d4 = deps({ teams: [team("BE-Admins", "AlphaOrg")] });
  assert((await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: new Set(["alphaorg"]), existingOrgs: new Set(["alphaorg"]) }, d4)) === null, "org already has a workspace -> null");
  assert(d4.calls.claim.length === 0, "no claim when workspace exists");
}

console.log("[autoClaimAdminOrg] pool exhausted -> null, stops");
{
  const d = deps({ teams: [team("BE-Admins", "AlphaOrg"), team("BE-Admins", "BetaOrg")], claim: async () => null });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const ws = await autoClaimAdminOrg({}, { accessToken: "t", memberOrgs: new Set(["alphaorg", "betaorg"]), existingOrgs: new Set() }, d);
    assert(ws === null, "pool exhausted -> null");
    assert(d.calls.claim.length === 1, "stops after the first exhausted claim (doesn't hammer the pool)");
  } finally {
    console.warn = realWarn;
  }
}

console.log("workspaceProvision: all assertions passed");
