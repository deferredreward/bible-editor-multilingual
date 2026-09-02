// End-to-end journey for the admin bulk review-state sweep (#296) and its three
// recorded follow-ups (#393 Aquifer stamp, #394 reimport pristine, #395 fanout),
// against the REAL production schema (every file in api/migrations, applied in
// order) and the REAL functions — not hand-copied SQL.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/reviewState.test.mjs
//
// WHY A JOURNEY AND NOT ONLY UNIT TESTS. Every claim this feature makes is a
// claim about SQL that a pure test cannot check:
//   * `admin_bulk_state = COALESCE(admin_bulk_state, translation_state, 'none')`
//     in the same UPDATE that overwrites translation_state only records the
//     PRE-sweep state because SQLite evaluates SET right-hand sides against the
//     original row. If that ever stopped being true the stamp would silently
//     record the sweep's own output and the audit value would be worthless.
//   * the sweep must NOT bump `version` (open editors' If-Match preconditions
//     stay valid) and must NOT claim `updated_by` — both are absences, which no
//     unit test on a pure function can observe.
//   * "bulk-approved rows are excluded from few-shot gold" is a property of the
//     selector SQL meeting the stamped rows, so it is asserted by running the
//     real VALIDATED_TN/TQ_EXAMPLES_SQL against a real swept database.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runReviewStateSweep,
  parseSweepRequest,
  stateForTarget,
  sweepUpdateSql,
  ADMIN_BULK_SOURCE,
} from "./reviewState.ts";
import { VALIDATED_TN_EXAMPLES_SQL, VALIDATED_TQ_EXAMPLES_SQL } from "./contextExport.ts";
import { isReimportableRow } from "./reimportClassify.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite (same slice as reimportJourney.test.mjs) ─
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  seedUsers(sqlite);
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "ZEC";
// tn_rows.updated_by and edit_log.user_id are FKs onto users(id).
const ADMIN = 42;
const TRANSLATOR = 7;

function seedUsers(sqlite) {
  for (const [id, login] of [
    [ADMIN, "admin"],
    [TRANSLATOR, "translator"],
  ]) {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (?, ?, ?)`).run(id, id, login);
  }
}

function seedTn(sqlite, rows) {
  for (const r of rows) {
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, tags, version, updated_by, updated_at,
                              translation_state, deleted_at, trashed_at, preserve, hint)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        BOOK,
        r.chapter,
        r.verse ?? 1,
        `${r.chapter}:${r.verse ?? 1}`,
        r.note ?? "note text",
        null,
        r.version ?? 3,
        r.updated_by ?? null,
        1000,
        r.translation_state ?? null,
        r.deleted_at ?? null,
        r.trashed_at ?? null,
        r.preserve ?? 0,
        r.hint ?? 0,
      );
  }
}

const tnById = (sqlite, id) =>
  sqlite.prepare(`SELECT * FROM tn_rows WHERE book = ? AND id = ?`).all(BOOK, id)[0];

// ── (0) request parsing: an ambiguous or empty scope must not sweep a book ────
console.log("\n[(0) parseSweepRequest — scope must be explicit and unambiguous]");
{
  eq(parseSweepRequest({ resource: "tn", state: "approved", chapter: 3 }).range, { start: 3, end: 3 }, "single chapter");
  eq(
    parseSweepRequest({ resource: "tq", state: "needs_review", chapterStart: 2, chapterEnd: 5 }).range,
    { start: 2, end: 5 },
    "inclusive chapter range",
  );
  eq(
    parseSweepRequest({ resource: "tn", state: "approved", chapterStart: 4 }).range,
    { start: 4, end: 4 },
    "chapterEnd defaults to chapterStart",
  );
  eq(parseSweepRequest({ resource: "tn", state: "approved", allChapters: true }).range, null, "whole book → null range");
  // The dangerous shapes.
  eq(
    parseSweepRequest({ resource: "tn", state: "approved" }).error,
    "invalid_scope",
    "no scope at all is REJECTED — an empty body must never silently sweep the whole book",
  );
  eq(
    parseSweepRequest({ resource: "tn", state: "approved", chapter: 2, allChapters: true }).error,
    "invalid_scope",
    "chapter + allChapters is REJECTED rather than guessed",
  );
  eq(
    parseSweepRequest({ resource: "tn", state: "approved", chapterStart: 5, chapterEnd: 2 }).error,
    "invalid_chapter_range",
    "reversed range rejected",
  );
  eq(parseSweepRequest({ resource: "tw", state: "approved", chapter: 1 }).error, "invalid_resource", "tn/tq only");
  eq(parseSweepRequest({ resource: "tn", state: "yes", chapter: 1 }).error, "invalid_state", "unknown state rejected");
  eq(stateForTarget("approved"), "validated", "approved → validated");
  eq(stateForTarget("needs_review"), "edited", "needs review → edited (matches the per-row un-approve)");
}

// ── (1) the sweep itself ─────────────────────────────────────────────────────
console.log("\n[(1) chapter-scoped approve — every live state moves, the stamp records what it displaced]");
{
  const { sqlite, env } = freshEnv();
  seedTn(sqlite, [
    { id: "aaaa", chapter: 1, verse: 1, translation_state: null }, // never drafted (the Option 1 case)
    { id: "bbbb", chapter: 1, verse: 2, translation_state: "ai_draft" },
    { id: "cccc", chapter: 1, verse: 3, translation_state: "edited", updated_by: TRANSLATOR },
    { id: "dddd", chapter: 1, verse: 4, translation_state: "validated" },
    { id: "eeee", chapter: 1, verse: 5, translation_state: null, deleted_at: 900 }, // tombstone
    { id: "ffff", chapter: 1, verse: 6, translation_state: null, trashed_at: 900 }, // queued for deletion
    { id: "gggg", chapter: 2, verse: 1, translation_state: null }, // out of scope
  ]);

  const res = await runReviewStateSweep(env, BOOK, "tn", "approved", { start: 1, end: 1 }, ADMIN);

  eq(res.changed, 4, "4 live rows in chapter 1 swept (tombstone + trashed excluded)");
  eq(res.changedChapters, [1], "only chapter 1 reports a change");
  eq(res.translationState, "validated", "approve maps to validated");

  // THE OPTION 1 DECISION: a never-drafted imported row IS validated by the
  // sweep — the per-row route refuses this (translation_state IS NOT NULL) and
  // that refusal is exactly what this feature lifts.
  eq(tnById(sqlite, "aaaa").translation_state, "validated", "never-drafted row is validated (owner decision, Option 1)");
  eq(tnById(sqlite, "aaaa").admin_bulk_state, "none", "…and stamped 'none' — it displaced no prior state");

  // THE SQLITE CLAIM: the stamp sees the PRE-sweep translation_state even though
  // the same statement overwrites it.
  eq(tnById(sqlite, "bbbb").admin_bulk_state, "ai_draft", "stamp records the displaced 'ai_draft', not the new state");
  eq(tnById(sqlite, "cccc").admin_bulk_state, "edited", "stamp records the displaced human 'edited' state");
  eq(tnById(sqlite, "dddd").admin_bulk_state, "validated", "an already-validated row is stamped too — it was swept");

  // Documented decision 2: an in-progress human 'edited' row is overwritten.
  eq(tnById(sqlite, "cccc").translation_state, "validated", "human-edited-but-unapproved row IS overwritten (documented)");

  // Decision 4: never resurrect / never approve what is queued for deletion.
  eq(tnById(sqlite, "eeee").translation_state, null, "tombstone untouched");
  eq(tnById(sqlite, "eeee").admin_bulk_state, null, "tombstone unstamped");
  eq(tnById(sqlite, "ffff").translation_state, null, "trashed tn untouched");
  eq(tnById(sqlite, "gggg").translation_state, null, "chapter 2 out of scope — untouched");

  // Decision 5: a state flip, not a content edit.
  eq(tnById(sqlite, "aaaa").version, 3, "version NOT bumped — open editors' If-Match preconditions stay valid");
  eq(tnById(sqlite, "aaaa").updated_by, null, "updated_by NOT claimed — authorship stays with whoever wrote the note");
  eq(tnById(sqlite, "cccc").updated_by, TRANSLATOR, "an existing author is not overwritten either");
  eq(tnById(sqlite, "aaaa").note, "note text", "CONTENT is never touched by a sweep");
  eq(tnById(sqlite, "aaaa").updated_at > 1000, true, "updated_at moves so the row sorts as recently touched");
  eq(
    JSON.parse(tnById(sqlite, "aaaa").pre_draft_json).note,
    "note text",
    "approve snapshots the published content into pre_draft_json (migration 0049)",
  );

  // The audit trail: one edit_log row per swept row, distinguishable from a
  // translator's approval by its source.
  const log = sqlite
    .prepare(`SELECT row_key, action, source, user_id, prev_version, new_version FROM edit_log WHERE kind = 'tn'`)
    .all();
  eq(log.length, 4, "one edit_log row per swept row");
  eq(new Set(log.map((l) => l.source)).size === 1 && log[0].source, ADMIN_BULK_SOURCE, "source = admin_bulk_state");
  eq(log[0].action, "validate", "action reads as an approval");
  eq(log[0].user_id, ADMIN, "the acting admin is recorded");
  eq(log[0].prev_version === log[0].new_version, true, "prev_version === new_version — the sweep bumps neither");
  eq(new Set(log.map((l) => l.row_key)).size, 4, "the four audited rows are the four swept rows, not duplicates");
}

console.log("\n[(2) repeat sweep is idempotent and does not lose the original pre-sweep state]");
{
  const { sqlite, env } = freshEnv();
  seedTn(sqlite, [{ id: "aaaa", chapter: 1, translation_state: "edited" }]);
  await runReviewStateSweep(env, BOOK, "tn", "approved", { start: 1, end: 1 }, ADMIN);
  eq(tnById(sqlite, "aaaa").admin_bulk_state, "edited", "first sweep stamps the displaced 'edited'");
  await runReviewStateSweep(env, BOOK, "tn", "needs_review", { start: 1, end: 1 }, ADMIN);
  eq(tnById(sqlite, "aaaa").translation_state, "edited", "needs review puts it back in the queue as 'edited'");
  eq(
    tnById(sqlite, "aaaa").admin_bulk_state,
    "edited",
    "the stamp still records the state before the FIRST sweep, not the second sweep's own output",
  );
  eq(tnById(sqlite, "aaaa").version, 3, "still no version bump across two sweeps");
  // needs_review leaves the once-approved snapshot alone, matching the per-row
  // un-approve (docs/plan Design 2) — the export keeps shipping approved content.
  eq(
    JSON.parse(tnById(sqlite, "aaaa").pre_draft_json).note,
    "note text",
    "un-approve leaves the existing pre_draft_json snapshot in place",
  );
  eq(sweepUpdateSql("tn", "needs_review").includes("pre_draft_json"), false, "…because needs_review writes no snapshot");
}

console.log("\n[(3) whole-book sweep touches only chapters that exist, and reports them]");
{
  const { sqlite, env } = freshEnv();
  seedTn(sqlite, [
    { id: "aaaa", chapter: 1 },
    { id: "bbbb", chapter: 4 },
    { id: "cccc", chapter: 9 },
  ]);
  const res = await runReviewStateSweep(env, BOOK, "tn", "approved", null, ADMIN);
  eq(res.chapters, [1, 4, 9], "only chapters holding live rows are visited — not 1..N blind");
  eq(res.changed, 3, "all three rows swept");
  eq(res.changedChapters, [1, 4, 9], "#395: the fanout list is the chapters that actually changed");
  eq(res.broadcastChapters, 3, "…and every one of them is broadcast (whole-book fanout is NOT skipped)");
}

// ── (4) #393 / few-shot gold: the real selectors against a real swept DB ──────
console.log("\n[(4) #296+#393 — swept and Aquifer-approved rows are NOT few-shot gold]");
{
  const { sqlite, env } = freshEnv();
  seedTn(sqlite, [
    { id: "hand", chapter: 1, verse: 1, translation_state: "validated" }, // per-row human approval
    { id: "swep", chapter: 2, verse: 1, translation_state: null }, // will be bulk-swept
  ]);
  // The Aquifer bulk approve, exactly as aquiferImport.ts writes it.
  seedTn(sqlite, [{ id: "aqfr", chapter: 3, verse: 1, translation_state: null }]);
  sqlite
    .prepare(
      `UPDATE tn_rows SET translation_state = 'validated',
         admin_bulk_state = COALESCE(translation_state, 'none'),
         pre_draft_json = json_object('note', note, 'tags', tags), updated_at = ?3
       WHERE book = ?1 AND id = ?2 AND translation_state IS NULL`,
    )
    .run(BOOK, "aqfr", 2000);

  await runReviewStateSweep(env, BOOK, "tn", "approved", { start: 2, end: 2 }, ADMIN);

  const gold = sqlite.prepare(VALIDATED_TN_EXAMPLES_SQL).all().map((r) => r.id);
  eq(gold, ["hand"], "only the per-row human approval is few-shot gold");
  eq(tnById(sqlite, "swep").translation_state, "validated", "…the swept row IS validated for the review UI");
  eq(tnById(sqlite, "aqfr").translation_state, "validated", "…and so is the Aquifer-approved row");
  eq(tnById(sqlite, "aqfr").admin_bulk_state, "none", "#393: the Aquifer bulk approve now carries the stamp");

  // Same claim for tq, through the sweep's own path.
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_at, translation_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("qqq1", BOOK, 1, 1, "1:1", "q", "r", 2, 1000, "validated");
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_at, translation_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run("qqq2", BOOK, 2, 1, "2:1", "q", "r", 2, 1000, null);
  await runReviewStateSweep(env, BOOK, "tq", "approved", { start: 2, end: 2 }, ADMIN);
  eq(
    sqlite.prepare(VALIDATED_TQ_EXAMPLES_SQL).all().map((r) => r.id),
    ["qqq1"],
    "tq: the swept row is excluded, the hand-approved one is gold",
  );
}

// ── (5) #394: a bulk-approved row is no longer "pristine" to the reimport ─────
console.log("\n[(5) #394 — a swept row is not pristine, so the nightly reimport won't rewrite it]");
{
  const { sqlite, env } = freshEnv();
  seedTn(sqlite, [{ id: "aaaa", chapter: 1, translation_state: null }]);

  const before = tnById(sqlite, "aaaa");
  eq(
    isReimportableRow({
      updated_by: before.updated_by,
      latestSource: null,
      deleted_at: before.deleted_at,
      admin_bulk_state: before.admin_bulk_state,
      trashed_at: before.trashed_at,
      preserve: before.preserve,
      hint: before.hint,
      kind: "tn",
    }),
    true,
    "before the sweep the imported row is pristine (reimport may re-seed it from master)",
  );

  await runReviewStateSweep(env, BOOK, "tn", "approved", { start: 1, end: 1 }, ADMIN);
  const after = tnById(sqlite, "aaaa");
  // The sweep deliberately leaves updated_by null, which is exactly why the
  // stamp — not authorship — has to carry the signal.
  eq(after.updated_by, null, "the sweep still leaves updated_by null (it claims no authorship)");
  eq(
    isReimportableRow({
      updated_by: after.updated_by,
      latestSource: null,
      deleted_at: after.deleted_at,
      admin_bulk_state: after.admin_bulk_state,
      trashed_at: after.trashed_at,
      preserve: after.preserve,
      hint: after.hint,
      kind: "tn",
    }),
    false,
    "after the sweep it is NOT reimportable — the 'validated' label can't come to describe content nobody approved",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reviewState assertions passed.");
