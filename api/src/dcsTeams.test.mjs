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
import {
  listUserTeams,
  roleFromTeams,
  resolveTeamRole,
  syncTeamRole,
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

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE user_roles (
      dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      added_by INTEGER,
      source TEXT NOT NULL DEFAULT 'manual'
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
          };
        },
      };
    },
  };
}

function rolesIn(db) {
  return db
    .prepare("SELECT dcs_username, role, source FROM user_roles ORDER BY dcs_username")
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
  await syncTeamRole(env, "ALICE", "editor");
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].role === "editor",
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

console.log("syncTeamRole — manual rows are authoritative");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('carol','admin','manual')");
  await syncTeamRole(env, "carol", "editor");
  assert(rolesIn(db)[0].role === "admin", "a team role never downgrades an admin's manual grant");
  await syncTeamRole(env, "carol", null);
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].role === "admin",
    "and never deletes a manual grant",
  );
}

console.log("syncTeamRole — last-admin guard");
{
  const db = freshDb();
  const env = { DB: makeD1(db) };
  await syncTeamRole(env, "dave", "admin");
  await syncTeamRole(env, "dave", null);
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].role === "admin",
    "removing the SOLE admin from the team does not lock everyone out",
  );
  await syncTeamRole(env, "erin", "admin");
  await syncTeamRole(env, "dave", null);
  assert(
    rolesIn(db).length === 1 && rolesIn(db)[0].dcs_username === "erin",
    "with a second admin present, the revocation goes through",
  );
}

console.log("all dcsTeams tests passed");
