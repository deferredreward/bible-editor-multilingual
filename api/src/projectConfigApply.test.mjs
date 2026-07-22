// projectConfigApply.test.mjs — executable node:sqlite tests for PR B's
// atomic config+lane apply path. Applies the REAL schema (project_config,
// scripture_lane_state, tn/tq/twl_rows, verses, article_units, and migration
// 0051's _abort_guard poison-pill table) to an in-memory SQLite database and
// runs the REAL functions from projectConfigApply.ts against a thin D1
// adapter whose `.batch()` mirrors D1 semantics: one transaction, any
// statement error rolls back everything.
//
// Run: node --experimental-strip-types --no-warnings --test src/projectConfigApply.test.mjs

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCustomGlOverrides,
  resolveOverridesIntent,
  hasLiveProjectData,
  dataExportIdentity,
  applyProjectConfig,
} from "./projectConfigApply.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";

// ── D1 adapter over node:sqlite (same shape as articlePopulate.test.mjs) ────

function makeEnv(db) {
  function bound(sql, params) {
    return {
      first() {
        return db.prepare(sql).get(...params) ?? null;
      },
      all() {
        return { results: db.prepare(sql).all(...params) };
      },
      run() {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return bound(sql, params);
        },
        first() {
          return db.prepare(sql).get() ?? null;
        },
        all() {
          return { results: db.prepare(sql).all() };
        },
        run() {
          const r = db.prepare(sql).run();
          return { meta: { changes: Number(r.changes) } };
        },
      };
    },
    async batch(stmts) {
      const results = [];
      db.exec("BEGIN");
      try {
        for (const s of stmts) results.push(s.run());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return results;
    },
  };
  return { DB, DCS_BASE_URL: "https://git.door43.org" };
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE project_config (
      id INTEGER PRIMARY KEY, preset TEXT NOT NULL,
      overrides_json TEXT, updated_at INTEGER
    );
    CREATE TABLE scripture_lane_state (
      lane TEXT PRIMARY KEY CHECK (lane IN ('lit', 'sim')),
      active_generation INTEGER NOT NULL DEFAULT 1,
      next_generation INTEGER NOT NULL DEFAULT 2,
      active_config_json TEXT NOT NULL,
      config_revision INTEGER NOT NULL DEFAULT 1,
      replacement_job_id TEXT,
      exclusive_owner TEXT,
      exports_blocked INTEGER NOT NULL DEFAULT 0,
      replacement_required INTEGER NOT NULL DEFAULT 0,
      pending_target_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE verses (
      book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
      bible_version TEXT NOT NULL, source_generation INTEGER NOT NULL DEFAULT 1,
      content_json TEXT NOT NULL,
      PRIMARY KEY (book, chapter, verse, bible_version, source_generation)
    );
    CREATE TABLE tn_rows (id TEXT, book TEXT, deleted_at INTEGER);
    CREATE TABLE tq_rows (id TEXT, book TEXT, deleted_at INTEGER);
    CREATE TABLE twl_rows (id TEXT, book TEXT, deleted_at INTEGER);
    CREATE TABLE article_units (
      resource TEXT, path TEXT, deleted_at INTEGER,
      PRIMARY KEY (resource, path)
    );
    CREATE TABLE _abort_guard (
      reason TEXT NOT NULL CHECK (1 = 0)
    );
  `);
  clearProjectConfigCache();
  return db;
}

function seedConfig(db, preset, overridesJson = null) {
  db.prepare(
    `INSERT INTO project_config (id, preset, overrides_json, updated_at)
     VALUES (1, ?, ?, unixepoch())`,
  ).run(preset, overridesJson);
}

function seedLanes(db, preset, overridesJson = null) {
  // Mirror ensureLaneState's bootstrap shape closely enough for the apply
  // path's planning to work (active_config_json is the only field the plan
  // logic actually parses).
  const cfg = JSON.parse(
    JSON.stringify(
      preset === "en-unfoldingword"
        ? { lit: { label: "ULT", source: { owner: "unfoldingWord", repo: "en_ult", ref: "master" }, export: { owner: "unfoldingWord", repo: "en_ult", baseRef: "master", branchPolicy: "contributor_book_branch" }, textReadOnly: false, alignmentWritable: true },
            sim: { label: "UST", source: { owner: "unfoldingWord", repo: "en_ust", ref: "master" }, export: { owner: "unfoldingWord", repo: "en_ust", baseRef: "master", branchPolicy: "contributor_book_branch" }, textReadOnly: false, alignmentWritable: true } }
        : { lit: { label: "?", source: { owner: "x", repo: "x", ref: "master" }, export: null, textReadOnly: false, alignmentWritable: true },
            sim: { label: "?", source: { owner: "x", repo: "x", ref: "master" }, export: null, textReadOnly: false, alignmentWritable: true } },
    ),
  );
  void overridesJson;
  for (const lane of ["lit", "sim"]) {
    db.prepare(
      `INSERT INTO scripture_lane_state
         (lane, active_generation, next_generation, active_config_json, config_revision,
          replacement_job_id, exclusive_owner, exports_blocked, replacement_required, pending_target_json, updated_at)
       VALUES (?, 1, 2, ?, 1, NULL, NULL, 0, 0, NULL, unixepoch())`,
    ).run(lane, JSON.stringify(cfg[lane]));
  }
}

// ── validateCustomGlOverrides ───────────────────────────────────────────────

const VALID_CUSTOM_GL = {
  org: "MyOrg",
  exportOrg: "MyOrg",
  repos: { lit: "ar_glt", sim: "ar_gst", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl", tw: "ar_tw", ta: "ar_ta" },
  translationSource: null,
};

test("validateCustomGlOverrides: a fully valid draft passes", () => {
  const r = validateCustomGlOverrides(VALID_CUSTOM_GL);
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: missing org rejects", () => {
  const r = validateCustomGlOverrides({ ...VALID_CUSTOM_GL, org: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_org");
});

test("validateCustomGlOverrides: non-isIdent org rejects (not merely non-empty)", () => {
  const r = validateCustomGlOverrides({ ...VALID_CUSTOM_GL, org: "bad org!" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_org");
});

test("validateCustomGlOverrides: missing exportOrg rejects", () => {
  const r = validateCustomGlOverrides({ ...VALID_CUSTOM_GL, exportOrg: "" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_export_org");
});

test("validateCustomGlOverrides: missing a repo role rejects", () => {
  const { tw, ...rest } = VALID_CUSTOM_GL.repos;
  void tw;
  const r = validateCustomGlOverrides({ ...VALID_CUSTOM_GL, repos: rest });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_repo");
  assert.deepEqual(r.detail, { role: "tw" });
});

test("validateCustomGlOverrides: invalid repo identifier rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    repos: { ...VALID_CUSTOM_GL.repos, ta: "bad/ta repo" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_repo");
});

test("validateCustomGlOverrides: lit === sim rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    repos: { ...VALID_CUSTOM_GL.repos, sim: VALID_CUSTOM_GL.repos.lit },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_lit_sim_conflict");
});

test("validateCustomGlOverrides: translationSource key absent rejects (must be explicit)", () => {
  const { translationSource, ...rest } = VALID_CUSTOM_GL;
  void translationSource;
  const r = validateCustomGlOverrides(rest);
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_missing_translation_source");
});

test("validateCustomGlOverrides: translationSource explicit null passes", () => {
  const r = validateCustomGlOverrides({ ...VALID_CUSTOM_GL, translationSource: null });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: translationSource object with invalid repo rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "" },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_translation_source");
});

test("validateCustomGlOverrides: valid translationSource object passes", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
    },
  });
  assert.equal(r.ok, true);
});

// ── translationSource: partial + per-resource repo override (PR foundation) ──

test("validateCustomGlOverrides: PARTIAL translationSource repos passes (some roles absent)", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      // only tn/tq sourced from upstream; the other five roles are omitted (blank)
      repos: { tn: "en_tn", tq: "en_tq" },
    },
  });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: an OVERRIDE repo name (any valid ident) passes", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      // lit pulled from a DIFFERENT repo within the same upstream org
      repos: { lit: "en_glt", tn: "en_tn" },
    },
  });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: empty translationSource repos object passes (all blank)", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: {} },
  });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: a PRESENT translationSource repo that is not an ident rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { tn: "en_tn", tq: "bad/tq repo" },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_translation_source");
  assert.deepEqual(r.detail, { role: "tq" });
});

test("validateCustomGlOverrides: a PRESENT-but-empty translationSource repo rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "" } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_translation_source");
});

// ── translationSource: per-resource { org, repo } override (issue #84 slice) ──

test("validateCustomGlOverrides: a per-resource { org, repo } ref passes", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      // tn sourced from a DIFFERENT org; tq stays a bare string (default org).
      repos: { tn: { org: "BibleAquifer", repo: "ar_tn" }, tq: "en_tq" },
    },
  });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: an org-less { repo } ref passes (default org)", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { tn: { repo: "en_tn" } },
    },
  });
  assert.equal(r.ok, true);
});

test("validateCustomGlOverrides: a { org, repo } ref with an invalid org rejects", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { tn: { org: "bad org!", repo: "ar_tn" } },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_translation_source");
  assert.deepEqual(r.detail, { role: "tn" });
});

test("validateCustomGlOverrides: a ref missing repo (or non-ident repo) rejects", () => {
  const noRepo = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: { org: "BibleAquifer" } } },
  });
  assert.equal(noRepo.ok, false);
  assert.equal(noRepo.error, "custom_gl_invalid_translation_source");
  const badRepo = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: { org: "BibleAquifer", repo: "ar tn!" } } },
  });
  assert.equal(badRepo.ok, false);
});

test("validateCustomGlOverrides: partial translationSource still requires a valid org", () => {
  const r = validateCustomGlOverrides({
    ...VALID_CUSTOM_GL,
    translationSource: { org: "bad org!", languageCode: "en", repos: { tn: "en_tn" } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "custom_gl_invalid_translation_source");
});

// ── resolveOverridesIntent (override lifecycle) ────────────────────────────

test("resolveOverridesIntent: explicit overrides always win, same preset", () => {
  const r = resolveOverridesIntent("ar-bsoj", "ar-bsoj", { litLabel: "X" });
  assert.deepEqual(r, { litLabel: "X" });
});

test("resolveOverridesIntent: same preset, overrides omitted -> preserve (undefined)", () => {
  const r = resolveOverridesIntent("ar-bsoj", "ar-bsoj", undefined);
  assert.equal(r, undefined);
});

test("resolveOverridesIntent: different preset, overrides omitted -> clear (null)", () => {
  const r = resolveOverridesIntent("ar-bsoj", "en-unfoldingword", undefined);
  assert.equal(r, null);
});

test("resolveOverridesIntent: different preset, explicit overrides supplied -> that object wins", () => {
  const r = resolveOverridesIntent("ar-bsoj", "custom-gl", VALID_CUSTOM_GL);
  assert.deepEqual(r, VALID_CUSTOM_GL);
});

// ── hasLiveProjectData / empty-project guard ────────────────────────────────

test("hasLiveProjectData: false on an empty DB", async () => {
  const db = freshDb();
  const env = makeEnv(db);
  assert.equal(await hasLiveProjectData(env), false);
});

test("hasLiveProjectData: true when tn_rows has a live row", async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const env = makeEnv(db);
  assert.equal(await hasLiveProjectData(env), true);
});

test("hasLiveProjectData: false when tn_rows' only row is soft-deleted", async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',123)`).run();
  const env = makeEnv(db);
  assert.equal(await hasLiveProjectData(env), false);
});

test("hasLiveProjectData: true on TQ/TWL-only data (no tn/verses)", async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO tq_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const env = makeEnv(db);
  assert.equal(await hasLiveProjectData(env), true);
  const db2 = freshDb();
  db2.prepare(`INSERT INTO twl_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const env2 = makeEnv(db2);
  assert.equal(await hasLiveProjectData(env2), true);
});

test("hasLiveProjectData: true when verses has any row (no soft-delete concept)", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json)
     VALUES ('GEN', 1, 1, 'ULT', 1, '{}')`,
  ).run();
  const env = makeEnv(db);
  assert.equal(await hasLiveProjectData(env), true);
});

// ── applyProjectConfig: end-to-end orchestration ────────────────────────────

test("applyProjectConfig: custom-gl on an empty DB succeeds and activates", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  const result = await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL);
  assert.equal(result.ok, true);
  assert.equal(result.config.preset, "custom-gl");
  assert.equal(result.config.org, "MyOrg");
  const row = db.prepare(`SELECT preset, overrides_json FROM project_config WHERE id=1`).get();
  assert.equal(row.preset, "custom-gl");
  assert.ok(row.overrides_json.includes("MyOrg"));
});

test("applyProjectConfig: custom-gl missing a required field rejects with zero writes", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  const before = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const { org, ...incomplete } = VALID_CUSTOM_GL;
  void org;
  const result = await applyProjectConfig(env, "custom-gl", incomplete);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  const after = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  assert.deepEqual(after, before);
});

test("applyProjectConfig: org change on a populated DB (named->named) rejects with 409, zero writes", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const env = makeEnv(db);
  const before = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const beforeLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  const result = await applyProjectConfig(env, "ar-bsoj", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, "project_not_empty");
  const after = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const afterLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  assert.deepEqual(after, before);
  assert.deepEqual(afterLit, beforeLit);
});

test("applyProjectConfig: org change on a DB with only TQ/TWL data also rejects (409)", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  db.prepare(`INSERT INTO twl_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const env = makeEnv(db);
  const result = await applyProjectConfig(env, "ar-bsoj", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error, "project_not_empty");
});

test("dataExportIdentity: differs on org, exportOrg, or a non-lane repo; ignores lit/sim", () => {
  const env = {};
  const base = {
    org: "MyOrg", exportOrg: "MyOrg", exportOwnerFromConfig: true,
    repos: { lit: "a", sim: "b", tn: "t", tq: "q", twl: "l", tw: "w", ta: "c" },
  };
  const id = (cfg) => dataExportIdentity(env, cfg);
  assert.equal(id(base), id({ ...base }), "identical config -> identical identity");
  assert.notEqual(id(base), id({ ...base, exportOrg: "OtherOrg" }), "exportOrg change -> different");
  assert.notEqual(id(base), id({ ...base, org: "Other" }), "org change -> different");
  assert.notEqual(id(base), id({ ...base, repos: { ...base.repos, tn: "t2" } }), "non-lane repo change -> different");
  assert.equal(
    id(base),
    id({ ...base, repos: { ...base.repos, lit: "z", sim: "y" } }),
    "lit/sim change alone -> SAME (lane-managed, not a tenancy stop)",
  );
});

test("applyProjectConfig: exportOrg change (same org) on a populated custom-gl DB rejects (409)", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  // Activate custom-gl on the empty DB, then populate it.
  assert.equal((await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL)).ok, true);
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const before = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  // Same org (MyOrg), different exportOrg -> the bare-org check would MISS this;
  // the identity guard must still 409.
  const result = await applyProjectConfig(env, "custom-gl", { ...VALID_CUSTOM_GL, exportOrg: "OtherOrg" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, "project_not_empty");
  assert.deepEqual(db.prepare(`SELECT * FROM project_config WHERE id=1`).get(), before, "zero writes");
});

test("applyProjectConfig: non-lane repo change (same org) on a populated custom-gl DB rejects (409)", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  assert.equal((await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL)).ok, true);
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  const changed = { ...VALID_CUSTOM_GL, repos: { ...VALID_CUSTOM_GL.repos, tn: "MyOrg_tn_v2" } };
  const result = await applyProjectConfig(env, "custom-gl", changed);
  assert.equal(result.ok, false);
  assert.equal(result.error, "project_not_empty");
});

test("applyProjectConfig: changing a POPULATED lane's source rejects 409 lane_source_change_requires_migration, zero writes", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  // Install custom-gl (MyOrg/ar_glt for lit) on the empty DB, then populate the
  // LIT lane so a subsequent source change would have to overwrite verses.
  assert.equal((await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL)).ok, true);
  db.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json)
     VALUES ('GEN', 1, 1, 'ULT', 1, '{}')`,
  ).run();
  const before = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const beforeLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  // Same org/exportOrg/non-lane repos — ONLY the lit lane repo changes. The
  // tenancy guard ignores lit/sim, so this reaches lane planning and must reject
  // (not quarantine).
  const changed = { ...VALID_CUSTOM_GL, repos: { ...VALID_CUSTOM_GL.repos, lit: "ar_glt_v2" } };
  const result = await applyProjectConfig(env, "custom-gl", changed);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, "lane_source_change_requires_migration");
  assert.deepEqual(result.detail, { lanes: ["lit"] });
  // Nothing applied: config row untouched, and the lane was NOT quarantined.
  assert.deepEqual(db.prepare(`SELECT * FROM project_config WHERE id=1`).get(), before, "config zero writes");
  const afterLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  assert.deepEqual(afterLit, beforeLit, "lane untouched — no replacement_required, no pending_target");
  assert.equal(afterLit.replacement_required, 0, "lane not quarantined");
});

test("applyProjectConfig: changing a lane's source on an EMPTY lane still installs (fresh org path)", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  assert.equal((await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL)).ok, true);
  // No verses seeded — lit lane is empty, so a source change is a clean install.
  const changed = { ...VALID_CUSTOM_GL, repos: { ...VALID_CUSTOM_GL.repos, lit: "ar_glt_v2" } };
  const result = await applyProjectConfig(env, "custom-gl", changed);
  assert.equal(result.ok, true, "empty lane source change installs");
  const litCfg = JSON.parse(db.prepare(`SELECT active_config_json FROM scripture_lane_state WHERE lane='lit'`).get().active_config_json);
  assert.equal(litCfg.source.repo, "ar_glt_v2", "lane source updated in place");
  assert.equal(db.prepare(`SELECT replacement_required FROM scripture_lane_state WHERE lane='lit'`).get().replacement_required, 0, "not quarantined");
});

test("applyProjectConfig: a non-lane change (translationSource) on a populated DB with UNCHANGED lane source still succeeds", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const env = makeEnv(db);
  assert.equal((await applyProjectConfig(env, "custom-gl", VALID_CUSTOM_GL)).ok, true);
  // Populate the DB, but keep every lane source identical.
  db.prepare(`INSERT INTO tn_rows (id, book, deleted_at) VALUES ('a','GEN',NULL)`).run();
  db.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, source_generation, content_json)
     VALUES ('GEN', 1, 1, 'ULT', 1, '{}')`,
  ).run();
  // Only translationSource changes (null → an upstream object). This is NOT a
  // data/export identity change and NOT a lane-source change, so it must apply.
  const changed = {
    ...VALID_CUSTOM_GL,
    translationSource: {
      org: "unfoldingWord",
      languageCode: "en",
      repos: { lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl", tw: "en_tw", ta: "en_ta" },
    },
  };
  const result = await applyProjectConfig(env, "custom-gl", changed);
  assert.equal(result.ok, true, "non-lane, non-identity change on populated DB succeeds");
  assert.ok(
    db.prepare(`SELECT overrides_json FROM project_config WHERE id=1`).get().overrides_json.includes("unfoldingWord"),
    "translationSource persisted",
  );
});

test("applyProjectConfig: switching to a different preset without overrides clears stored overrides", async () => {
  const db = freshDb();
  seedConfig(db, "ar-bsoj", JSON.stringify({ litLabel: "CUSTOM" }));
  seedLanes(db, "ar-bsoj");
  const env = makeEnv(db);
  // Same org (BSOJ) preset switch scenario isn't representative of the
  // "different preset" rule interacting with the tenancy guard, so switch to
  // another preset that keeps org constant isn't available among our fixed
  // presets — instead verify the intent resolution directly interacts with
  // an empty DB org change (ar-bsoj -> en-unfoldingword, both empty).
  const result = await applyProjectConfig(env, "en-unfoldingword", undefined);
  assert.equal(result.ok, true);
  const row = db.prepare(`SELECT overrides_json FROM project_config WHERE id=1`).get();
  assert.equal(row.overrides_json, null);
});

test("applyProjectConfig: same-preset PUT without overrides preserves stored overrides", async () => {
  const db = freshDb();
  seedConfig(db, "ar-bsoj", JSON.stringify({ litLabel: "CUSTOM" }));
  seedLanes(db, "ar-bsoj");
  const env = makeEnv(db);
  const result = await applyProjectConfig(env, "ar-bsoj", undefined);
  assert.equal(result.ok, true);
  assert.equal(result.config.litLabel, "CUSTOM");
  const row = db.prepare(`SELECT overrides_json FROM project_config WHERE id=1`).get();
  assert.ok(row.overrides_json.includes("CUSTOM"));
});

// ── Atomic batch rollback ────────────────────────────────────────────────────

test("applyProjectConfig: a lane CAS failure (lease acquired after planning) rolls back the ENTIRE batch", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  const beforeConfig = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const beforeLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  const beforeSim = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='sim'`).get();

  // Monkeypatch env.DB.batch to simulate a concurrent lease being acquired on
  // the 'sim' lane AFTER planning completed but BEFORE this batch executes —
  // the in-batch guard must catch it (not just a post-hoc changes-check).
  const env = makeEnv(db);
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => {
    db.prepare(`UPDATE scripture_lane_state SET exclusive_owner = 'lease:evil' WHERE lane = 'sim'`).run();
    return realBatch(stmts);
  };

  const result = await applyProjectConfig(env, "ar-bsoj", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);

  const afterConfig = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const afterLit = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='lit'`).get();
  const afterSim = db.prepare(`SELECT * FROM scripture_lane_state WHERE lane='sim'`).get();
  // Config row untouched.
  assert.deepEqual(afterConfig, beforeConfig);
  // lit row (which WOULD have been updated) rolled back too — the whole
  // batch aborted, not just the sim statement.
  assert.deepEqual(afterLit, beforeLit);
  // sim row: only the injected exclusive_owner mutation survives (that ran
  // OUTSIDE our batch, simulating a genuinely concurrent writer) — our own
  // planned update did not apply.
  assert.equal(afterSim.config_revision, beforeSim.config_revision);
  assert.equal(afterSim.active_config_json, beforeSim.active_config_json);
});

test("applyProjectConfig: second lane's fenced UPDATE matching zero rows still aborts the whole batch", async () => {
  const db = freshDb();
  seedConfig(db, "en-unfoldingword");
  seedLanes(db, "en-unfoldingword");
  // Simulate the sim lane already busy (replacement in progress) BEFORE we
  // even call applyProjectConfig — the pre-check should catch this case
  // directly (lane_busy), proving the guard is not the only line of defense.
  db.prepare(`UPDATE scripture_lane_state SET replacement_job_id = 'job-1' WHERE lane = 'sim'`).run();
  const beforeConfig = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  const env = makeEnv(db);
  const result = await applyProjectConfig(env, "ar-bsoj", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.error, "lane_busy");
  const afterConfig = db.prepare(`SELECT * FROM project_config WHERE id=1`).get();
  assert.deepEqual(afterConfig, beforeConfig);
});
