// Unit tests for resolveLoginWorkspace (workspaces.ts) — the OAuth callback's
// login-time workspace resolution order:
//   (a) valid be_ws cookie the user is allowed in → keep it
//   (b) persisted last-used workspace, still allowed
//   (c) exactly one configured workspace matches their Door43 orgs
//   (d) several match, no usable history → first match + promptChoice
//   (e) zero matches → fail to the cookie/first fallback, matched:false
//   and: memberships UNKNOWN (orgs fetch failed) → fail soft, matched:false
//
// Pure function, no I/O — this is the resolution ORDER contract, extracted so
// it's testable without standing up the whole OAuth callback.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceLogin.test.mjs

import { resolveLoginWorkspace } from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const WS = [
  { slug: "bsoj", label: "BSOJ", org: "BSOJ", binding: "DB" },
  { slug: "mltest", label: "ML Test", org: "BibleEditorMLTest", binding: "DB_MLTEST" },
  { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB_UW" },
];

const orgs = (...names) => new Set(names.map((n) => n.toLowerCase()));

console.log("(a) valid cookie for an allowed workspace wins over everything");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "uw",
    lastUsedSlug: "mltest",
    memberOrgs: orgs("unfoldingWord", "BibleEditorMLTest"),
  });
  assert(r.workspace.slug === "uw" && r.reason === "cookie", "cookie slug kept");
  assert(r.matched === true && r.promptChoice === false, "cookie: matched, no prompt");
}

console.log("(a→b) cookie for a workspace the user is NOT allowed in is skipped");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "bsoj",
    lastUsedSlug: "mltest",
    memberOrgs: orgs("BibleEditorMLTest"),
  });
  assert(
    r.workspace.slug === "mltest" && r.reason === "last_used",
    "disallowed cookie falls through to last-used",
  );
}

console.log("(b) last-used workspace, still allowed");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: "uw",
    memberOrgs: orgs("unfoldingWord", "BibleEditorMLTest"),
  });
  assert(r.workspace.slug === "uw" && r.reason === "last_used", "last-used wins with no cookie");
  assert(r.promptChoice === false, "history suppresses the multi-match prompt");
}

console.log("(b→c) stale last-used (no longer allowed) is skipped");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: "uw",
    memberOrgs: orgs("BibleEditorMLTest"),
  });
  assert(
    r.workspace.slug === "mltest" && r.reason === "single_match",
    "stale last-used falls through to the single org match",
  );
}

console.log("(c) exactly one org match auto-selects — THE first-login fix");
{
  // The real observed failure: first-time user, no cookie, in
  // BibleEditorMLTest only — used to land in list[0] (BSOJ) and get denied.
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("BibleEditorMLTest", "SomeUnrelatedOrg"),
  });
  assert(r.workspace.slug === "mltest", "lands in the matching workspace, not list[0]");
  assert(r.reason === "single_match" && r.matched === true, "single_match, matched");
  assert(r.promptChoice === false, "no prompt for a single match");
}

console.log("(c) org compare is case-insensitive");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("BIBLEEDITORMLTEST"),
  });
  assert(r.workspace.slug === "mltest", "org names compare case-insensitively");
}

console.log("(d) multiple matches, no history → FIRST match + promptChoice");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("BibleEditorMLTest", "unfoldingWord"),
  });
  assert(r.workspace.slug === "mltest", "lands in the first ALLOWED workspace (registry order)");
  assert(r.promptChoice === true, "SPA is told to prompt");
  assert(r.matched === true, "still a positive match");
}

console.log("(e) zero matches → fallback (cookie or list[0]), matched:false");
{
  const noCookie = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("SomeUnrelatedOrg"),
  });
  assert(
    noCookie.workspace.slug === "bsoj" && noCookie.reason === "no_match",
    "no cookie → list[0] fallback",
  );
  assert(noCookie.matched === false && noCookie.promptChoice === false, "no_match: not matched");

  const withCookie = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "uw",
    lastUsedSlug: null,
    memberOrgs: orgs("SomeUnrelatedOrg"),
  });
  assert(
    withCookie.workspace.slug === "uw" && withCookie.matched === false,
    "a real-but-disallowed cookie still shapes the fallback (pre-existing behavior)",
  );
}

console.log("(unknown) orgs fetch failed → fail SOFT to cookie/first, never lock out cached roles");
{
  const noCookie = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: "mltest",
    memberOrgs: null,
  });
  assert(
    noCookie.workspace.slug === "bsoj" && noCookie.reason === "unknown",
    "unknown + no cookie → list[0] (exactly today's behavior)",
  );
  assert(noCookie.matched === false, "unknown is never a positive match (don't persist it)");

  const withCookie = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "mltest",
    lastUsedSlug: null,
    memberOrgs: null,
  });
  assert(
    withCookie.workspace.slug === "mltest" && withCookie.reason === "unknown",
    "unknown + cookie → keep the cookie workspace",
  );
}

console.log("role rows (manual allowlist) keep a workspace allowed without org membership");
{
  // The eviction bug: a manually-allowlisted user who is NOT a Door43 member
  // of their workspace's org must not be bounced out of it at login.
  const cookieKept = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "bsoj",
    lastUsedSlug: null,
    memberOrgs: orgs("SomeUnrelatedOrg"),
    roleSlugs: new Set(["bsoj"]),
  });
  assert(
    cookieKept.workspace.slug === "bsoj" && cookieKept.reason === "cookie",
    "a role row in the cookie workspace keeps it, org membership or not",
  );
  assert(cookieKept.matched === true, "role-row retention is a positive match");

  const lastKept = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: "bsoj",
    memberOrgs: orgs(),
    roleSlugs: new Set(["bsoj"]),
  });
  assert(
    lastKept.workspace.slug === "bsoj" && lastKept.reason === "last_used",
    "a role row in the last-used workspace keeps it too",
  );

  // And WITHOUT the role row, the same inputs still evict (org rule applies).
  const evicted = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "bsoj",
    lastUsedSlug: null,
    memberOrgs: orgs("BibleEditorMLTest"),
  });
  assert(
    evicted.workspace.slug === "mltest" && evicted.reason === "single_match",
    "no role row + no org membership -> the cookie workspace is not retained",
  );
}

console.log("would-deny fan-out re-resolve: role rows alone can drive single/multi match");
{
  // The callback's rescue path: first resolution came back no_match, it fanned
  // the user_roles lookup across ALL workspaces, and re-resolves with the
  // expanded roleSlugs — no cookie, no history, no org membership at all.
  const single = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs(),
    roleSlugs: new Set(["mltest"]),
  });
  assert(
    single.workspace.slug === "mltest" && single.reason === "single_match",
    "one role row, zero org matches -> that workspace is the single match",
  );
  assert(single.matched === true && single.promptChoice === false, "treated as a positive single match");

  const multi = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs(),
    roleSlugs: new Set(["mltest", "uw"]),
  });
  assert(
    multi.workspace.slug === "mltest" && multi.reason === "multi_match" && multi.promptChoice === true,
    "several role rows -> first (registry order) + the picker prompt",
  );
}

console.log("garbage slugs never crash resolution");
{
  const r = resolveLoginWorkspace({
    workspaces: WS,
    cookieSlug: "no-such-workspace",
    lastUsedSlug: "also-gone",
    memberOrgs: orgs("BibleEditorMLTest"),
  });
  assert(r.workspace.slug === "mltest", "unknown slugs are skipped, matching continues");
}

console.log("single-workspace deployment (implicit default) keeps working");
{
  const only = [{ slug: "default", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" }];
  const member = resolveLoginWorkspace({
    workspaces: only,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("unfoldingWord"),
  });
  assert(
    member.workspace.slug === "default" && member.reason === "single_match",
    "member of the single org → that workspace",
  );
  const outsider = resolveLoginWorkspace({
    workspaces: only,
    cookieSlug: null,
    lastUsedSlug: null,
    memberOrgs: orgs("Elsewhere"),
  });
  assert(
    outsider.workspace.slug === "default" && outsider.matched === false,
    "non-member still resolves the only workspace (deny decision stays with the callback)",
  );
}

console.log("workspaceLogin: all assertions passed");
