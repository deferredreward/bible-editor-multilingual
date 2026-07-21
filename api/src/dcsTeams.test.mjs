// Unit tests for dcsTeams.ts — Door43 team membership as a role source.
//
// Two layers are exercised:
//   1. Pure mapping (roleFromTeams) and the paginated fetch (listUserTeams)
//      against an injected fetch, including the fail-closed-to-"unknown" path.
//   2. syncTeamRole against REAL SQLite (node:sqlite, same adapter shape as
//      adminUsers.test.mjs) because the manual-vs-team precedence and the
//      last-admin guard live inside single atomic SQL statements — a string
//      matching fake wouldn't actually test them.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/dcsTeams.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  listUserTeams,
  roleFromTeams,
  resolveTeamRole,
  orgForTeamSync,
  syncTeamRole,
  fetchMemberOrgs,
  teamRoleNames,
  DEFAULT_ADMIN_TEAM,
  DEFAULT_EDITOR_TEAM,
} from "./dcsTeams.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NAMES = { admin: DEFAULT_ADMIN_TEAM, editor: DEFAULT_EDITOR_TEAM };
const team = (name, org) => ({ name, organization: { username: org } });

// ── D1 adapter over node:sqlite ───────────────────────────────────────────────

// user_roles comes from the REAL migration SQL (0016 creates it, 0055 adds
// source/synced_at) so the precedence tests below exercise the exact schema —
// CHECK constraint, NOCASE collation, defaults — production has. 0016's seed
// rows are cleared so each test starts from an empty allowlist.
const MIGRATION_0016 = readFileSync(
  new URL("../migrations/0016_user_roles.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0055 = readFileSync(
  new URL("../migrations/0055_user_roles_source.sql", import.meta.url),
  "utf8",
);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(MIGRATION_0016);
  db.exec(MIGRATION_0055);
  db.exec("DELETE FROM user_roles;");
  db.exec(`
    CREATE TABLE project_config (
      id INTEGER PRIMARY KEY,
      preset TEXT NOT NULL,
      overrides_json TEXT
    );
  `);
  return db;
}

function makeD1(db) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              const st = db.prepare(sql);
              const r = st.run(...params);
              return { meta: { changes: Number(r.changes) } };
            },
            async first() {
              return db.prepare(sql).get(...params) ?? null;
            },
          };
        },
        async first() {
          return db.prepare(sql).get() ?? null;
        },
      };
    },
  };
}

function rolesIn(db) {
  return db
    .prepare("SELECT dcs_username, role, source, synced_at FROM user_roles ORDER BY dcs_username")
    .all();
}

// ── 1. Name resolution ────────────────────────────────────────────────────────

console.log("teamRoleNames");
assert(
  teamRoleNames({}).admin === "BE-Admins" && teamRoleNames({}).editor === "BE-Editors",
  "defaults to BE-Admins / BE-Editors",
);
assert(
  teamRoleNames({ DCS_TEAM_ADMIN: " Owners ", DCS_TEAM_EDITOR: "Writers" }).admin === "Owners",
  "env override wins and is trimmed",
);
assert(
  teamRoleNames({ DCS_TEAM_ADMIN: "   " }).admin === "BE-Admins",
  "blank env override falls back to the default",
);

// ── 2. roleFromTeams ──────────────────────────────────────────────────────────

console.log("roleFromTeams");
assert(roleFromTeams([], "BibleEditorMLTest", NAMES) === null, "no teams → no role");
assert(
  roleFromTeams([team("BE-Editors", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === "editor",
  "BE-Editors → editor",
);
assert(
  roleFromTeams([team("BE-Admins", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === "admin",
  "BE-Admins → admin",
);
assert(
  roleFromTeams(
    [team("BE-Editors", "BibleEditorMLTest"), team("BE-Admins", "BibleEditorMLTest")],
    "BibleEditorMLTest",
    NAMES,
  ) === "admin",
  "admin outranks editor regardless of order",
);
assert(
  roleFromTeams([team("be-admins", "bibleeditormltest")], "BibleEditorMLTest", NAMES) === "admin",
  "team and org names compare case-insensitively",
);
assert(
  roleFromTeams([team("BE-Admins", "SomeOtherOrg")], "BibleEditorMLTest", NAMES) === null,
  "a same-named team in ANOTHER org grants nothing",
);
assert(
  roleFromTeams([team("Owners", "BibleEditorMLTest")], "BibleEditorMLTest", NAMES) === null,
  "an unmapped team name grants nothing",
);
assert(
  roleFromTeams([{}, { organization: null }, { name: "BE-Admins" }], "BibleEditorMLTest", NAMES) === null,
  "malformed team entries are ignored, not crashed on",
);

// ── 3. listUserTeams ──────────────────────────────────────────────────────────

console.log("listUserTeams");
{
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return { ok: true, json: async () => [team("BE-Editors", "BibleEditorMLTest")] };
  };
  const teams = await listUserTeams({ DCS_BASE_URL: "https://git.door43.org/" }, "tok", {
    fetch: fakeFetch,
  });
  assert(teams.length === 1, "returns the single page of teams");
  assert(
    seen[0].url === "https://git.door43.org/api/v1/user/teams?limit=50&page=1",
    "hits /api/v1/user/teams with the trailing slash stripped from the base URL",
  );
  assert(seen[0].auth === "token tok", "authenticates with the USER's access token");
  assert(seen.length === 1, "a short page stops pagination");
}

{
  // Two full pages then a short one.
  const page = (n) => Array.from({ length: n }, (_, i) => team(`T${i}`, "Org"));
  const bodies = [page(50), page(50), page(3)];
  let calls = 0;
  const teams = await listUserTeams({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => bodies[calls++] }),
  });
  assert(teams.length === 103 && calls === 3, "follows pagination until a short page");
}

{
  // Every page full → the cap is hit with the list still possibly incomplete.
  // Returning the partial list would make a user whose BE-Editors entry sits
  // past the cap look like they're on no teams, and revoke them.
  const page = (n) => Array.from({ length: n }, (_, i) => team(`T${i}`, "Org"));
  let calls = 0;
  const teams = await listUserTeams({}, "tok", {
    fetch: async () => {
      calls++;
      return { ok: true, json: async () => page(50) };
    },
  });
  assert(
    teams === null && calls === 5,
    "exhausting the page cap → null (truncated ≠ complete), after MAX_PAGES requests",
  );
}

assert(
  (await listUserTeams({}, "tok", { fetch: async () => ({ ok: false, json: async () => ({}) }) })) === null,
  "non-2xx → null (unknown), not an empty list",
);
assert(
  (await listUserTeams({}, "tok", {
    fetch: async () => {
      throw new Error("network down");
    },
  })) === null,
  "network throw → null (unknown)",
);
assert(
  (await listUserTeams({}, "tok", { fetch: async () => ({ ok: true, json: async () => ({ message: "nope" }) }) })) === null,
  "non-array body → null (unknown)",
);

console.log("resolveTeamRole");
{
  const ok = await resolveTeamRole({}, "Org", "tok", {
    fetch: async () => ({ ok: true, json: async () => [team("BE-Admins", "Org")] }),
  });
  assert(ok.known === true && ok.role === "admin", "reachable DCS → known:true with the mapped role");
  const down = await resolveTeamRole({}, "Org", "tok", { fetch: async () => ({ ok: false }) });
  assert(
    down.known === false && down.role === null,
    "unreachable DCS → known:false so the caller skips the sync entirely",
  );
}

console.log("resolveTeamRole — near-miss diagnostic for misnamed teams");
{
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    // The real-world case: the Door43 team is "BE-Admin" (singular) while the
    // configured default is "BE-Admins" — no role, but the mismatch must be
    // loudly diagnosable in `wrangler tail`, not silent.
    const res = await resolveTeamRole({}, "BibleEditorMLTest", "tok", {
      fetch: async () => ({
        ok: true,
        json: async () => [team("BE-Admin", "BibleEditorMLTest"), team("Owners", "BibleEditorMLTest")],
      }),
    });
    assert(res.known === true && res.role === null, "near-miss still resolves to no role (no aliasing)");
    const hit = warnings.find((w) => w.includes("none match the configured role teams"));
    assert(!!hit, "a near-miss logs a diagnostic warning");
    assert(
      hit.includes("BE-Admin") && hit.includes("BE-Admins") && hit.includes("BibleEditorMLTest"),
      "the warning names the org, the configured names, and the user's actual teams",
    );

    warnings.length = 0;
    const none = await resolveTeamRole({}, "BibleEditorMLTest", "tok", {
      fetch: async () => ({ ok: true, json: async () => [team("BE-Admin", "SomeOtherOrg")] }),
    });
    assert(none.role === null, "teams only in OTHER orgs → no role");
    assert(
      !warnings.some((w) => w.includes("none match the configured role teams")),
      "no teams in the resolved org → no near-miss warning (nothing to diagnose)",
    );
  } finally {
    console.warn = realWarn;
  }
}

// ── 4. syncTeamRole ───────────────────────────────────────────────────────────

console.log("syncTeamRole — grants");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "alice", "editor");
  assert(
    rolesIn(db)[0].role === "editor" && rolesIn(db)[0].source === "dcs_team",
    "first login in BE-Editors inserts a dcs_team row",
  );
  await syncTeamRole(env, "alice", "admin");
  assert(rolesIn(db)[0].role === "admin", "promotion in Door43 updates the cached role");
  // A second admin, so the demotion below isn't refused by the last-admin guard
  // (which is exercised on its own further down).
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('zoe','admin','manual')");
  await syncTeamRole(env, "ALICE", "editor");
  const alice = rolesIn(db).filter((r) => r.dcs_username.toLowerCase() === "alice");
  assert(
    alice.length === 1 && alice[0].role === "editor",
    "username match is case-insensitive (no duplicate row)",
  );
}

console.log("syncTeamRole — revocation");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('root','admin','manual')");
  await syncTeamRole(env, "bob", "editor");
  await syncTeamRole(env, "bob", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "bob"),
    "leaving the Door43 team removes the cached row",
  );
}

console.log("syncTeamRole — teams WIN over manual rows; manual is only a no-signal fallback");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  // A second admin so carol's demotion below isn't refused by the last-admin
  // guard (exercised on its own further down).
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('root','admin','manual')");
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('carol','admin','manual')");
  await syncTeamRole(env, "carol", "editor");
  let carol = rolesIn(db).find((r) => r.dcs_username === "carol");
  assert(carol.role === "editor", "a team signal DEMOTES a manual admin (teams win)");
  assert(carol.source === "dcs_team", "the overwritten row is now team-owned");
  await syncTeamRole(env, "carol", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "carol"),
    "leaving the team then removes it — Door43 became authoritative for carol",
  );

  // No team signal at all: an untouched manual row survives as the fallback.
  await syncTeamRole(env, "root", null);
  const root = rolesIn(db).find((r) => r.dcs_username === "root");
  assert(
    root && root.role === "admin" && root.source === "manual",
    "no team signal leaves a manual row alone — it stays the fallback grant",
  );

  // The legacy-allowlist promotion case: every row predating migration 0055 is
  // 'manual', so a pre-existing editor added to BE-Admins gets promoted — and
  // handed to team control.
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('legacy','editor','manual')");
  await syncTeamRole(env, "legacy", "admin");
  const legacy = rolesIn(db).find((r) => r.dcs_username === "legacy");
  assert(legacy.role === "admin", "a team promotes a manual editor to admin");
  assert(legacy.source === "dcs_team", "...and the row is now team-owned (teams win)");
}

console.log("syncTeamRole — last-admin guard");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "dave", "admin");
  await syncTeamRole(env, "dave", null);
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].role === "admin",
    "DELETE path: removing the SOLE admin from the team does not lock everyone out",
  );
  // Regression: the UPDATE path used to lack this guard entirely, so moving the
  // only admin from BE-Admins to BE-Editors emptied the admin set — and
  // /api/admin/users is admin-gated, so recovery needed raw SQL.
  await syncTeamRole(env, "dave", "editor");
  assert(
    rolesIn(db)[0].role === "admin",
    "UPDATE path: demoting the SOLE admin to editor is refused too",
  );
  await syncTeamRole(env, "erin", "admin");
  await syncTeamRole(env, "dave", "editor");
  assert(
    rolesIn(db).find((r) => r.dcs_username === "dave").role === "editor",
    "with a second admin present, the demotion goes through",
  );
  await syncTeamRole(env, "dave", null);
  assert(
    !rolesIn(db).some((r) => r.dcs_username === "dave"),
    "and so does the deletion",
  );

  // A guard-refused demotion of a MANUAL sole admin must not flip the row to
  // dcs_team either — that would hand a still-admin row to team ownership.
  const db2 = freshDb();
  const env2 = { DB: makeD1(db2) };
  db2.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('solo','admin','manual')");
  await syncTeamRole(env2, "solo", "editor");
  const solo = rolesIn(db2)[0];
  assert(
    solo.role === "admin" && solo.source === "manual",
    "refused demotion of the sole (manual) admin leaves role AND source untouched",
  );
}

console.log("syncTeamRole — synced_at freshness stamp");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "fred", "editor");
  assert(rolesIn(db)[0].synced_at > 0, "a successful sync stamps synced_at");
  db.exec("UPDATE user_roles SET synced_at = 1 WHERE dcs_username = 'fred'");
  await syncTeamRole(env, "fred", "editor");
  assert(
    rolesIn(db)[0].synced_at > 1,
    "an unchanged role still refreshes synced_at (else refresh re-hits DCS forever)",
  );
  // A refused change must ALSO restamp, for the same reason.
  const db2 = freshDb();
  const env2 = { DB: makeD1(db2) };
  await syncTeamRole(env2, "sole", "admin");
  db2.exec("UPDATE user_roles SET synced_at = 1 WHERE dcs_username = 'sole'");
  await syncTeamRole(env2, "sole", "editor");
  assert(
    rolesIn(db2)[0].role === "admin" && rolesIn(db2)[0].synced_at > 1,
    "a guard-refused demotion still refreshes synced_at",
  );
}

console.log("orgForTeamSync");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  assert(
    (await orgForTeamSync(env)) === null,
    "no project_config row (never onboarded) → null, so the caller skips the sync",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "reads the org from the active preset",
  );
  db.exec(`UPDATE project_config SET overrides_json = '{"org":"BibleEditorMLTest"}' WHERE id = 1`);
  assert(
    (await orgForTeamSync(env)) === "BibleEditorMLTest",
    "an org override wins over the preset",
  );
  // The whole point: unlike getProjectConfig, a read failure must NOT silently
  // resolve to unfoldingWord — that would revoke every GL project's team roles.
  const broken = {
    DB: {
      prepare() {
        throw new Error("no such table: project_config");
      },
    },
  };
  assert(
    (await orgForTeamSync(broken)) === null,
    "a D1 error → null, NOT a silent fallback to the default preset's org",
  );
}

console.log("orgForTeamSync — workspace-aware: registry wins over project_config");
{
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "org2",
  };
  // project_config claims a DIFFERENT org than the workspace registry entry —
  // the registry must win.
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "OrgTwo",
    "active workspace's registry org wins over project_config's org",
  );
}

console.log("orgForTeamSync — workspace-aware: fresh workspace with no project_config row");
{
  // project_config table exists (migrations ran) but has no row yet — the
  // bootstrap case for a brand-new workspace.
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "org2",
  };
  assert(
    (await orgForTeamSync(env)) === "OrgTwo",
    "empty project_config still resolves the registry org, not null — this is the case that matters most",
  );
}

console.log("orgForTeamSync — WORKSPACES unset/empty: unchanged single-org production behavior");
{
  const db = freshDb();
  const env = { DB: makeD1(db), WORKSPACES: "" };
  assert(
    (await orgForTeamSync(env)) === null,
    "WORKSPACES empty + no project_config row → null (regression guard for production)",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "WORKSPACES empty → still reads project_config as before",
  );
}

console.log("orgForTeamSync — WORKSPACES configured but WORKSPACE_SLUG matches no entry: falls back to project_config");
{
  const db = freshDb();
  const env = {
    DB: makeD1(db),
    WORKSPACES: JSON.stringify([
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB" },
    ]),
    WORKSPACE_SLUG: "no-such-slug",
  };
  assert(
    (await orgForTeamSync(env)) === null,
    "no matching registry entry + no project_config row → null",
  );
  db.exec(
    "INSERT INTO project_config (id, preset, overrides_json) VALUES (1, 'en-unfoldingword', NULL)",
  );
  assert(
    (await orgForTeamSync(env)) === "unfoldingWord",
    "no matching registry entry → falls back to reading project_config",
  );
}

// ── 5. fetchMemberOrgs ───────────────────────────────────────────────────────

console.log("fetchMemberOrgs");
{
  const seen = [];
  const orgs = await fetchMemberOrgs({ DCS_BASE_URL: "https://git.door43.org/" }, "tok", {
    fetch: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return { ok: true, json: async () => [{ username: "BibleEditorMLTest" }, { username: "BSOJ" }] };
    },
  });
  assert(
    seen[0].url === "https://git.door43.org/api/v1/user/orgs?limit=50&page=1",
    "hits /api/v1/user/orgs with the trailing slash stripped",
  );
  assert(seen[0].auth === "token tok", "authenticates with the USER's access token");
  assert(
    orgs.has("bibleeditormltest") && orgs.has("bsoj") && orgs.size === 2,
    "returns a lowercased org-name set",
  );
}
{
  // Two full pages then a short one — pagination is followed.
  const page = (n, prefix) => Array.from({ length: n }, (_, i) => ({ username: `${prefix}${i}` }));
  const bodies = [page(50, "a"), page(50, "b"), page(3, "c")];
  let calls = 0;
  const orgs = await fetchMemberOrgs({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => bodies[calls++] }),
  });
  assert(orgs.size === 103 && calls === 3, "follows pagination until a short page");
}
{
  // Cap exhausted with every page still full → unknown, not a truncated set.
  const page = (n) => Array.from({ length: n }, (_, i) => ({ username: `o${i}` }));
  const orgs = await fetchMemberOrgs({}, "tok", {
    fetch: async () => ({ ok: true, json: async () => page(50) }),
  });
  assert(orgs === null, "exhausting the page cap → null (truncated ≠ complete)");
}
assert(
  (await fetchMemberOrgs({}, "tok", { fetch: async () => ({ ok: false }) })) === null,
  "non-2xx → null (unknown), not an empty set",
);
assert(
  (await fetchMemberOrgs({}, "tok", {
    fetch: async () => {
      throw new Error("network down");
    },
  })) === null,
  "network throw → null (unknown)",
);
assert(
  (await fetchMemberOrgs({}, "tok", { fetch: async () => ({ ok: true, json: async () => ({ message: "nope" }) }) })) === null,
  "non-array body → null (unknown)",
);

console.log("all dcsTeams tests passed");
