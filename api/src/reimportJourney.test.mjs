// End-to-end journey for issue #427's option-2 instrumentation AND option 1
// (the reclaim it made visible; see api/src/bookReimport.ts's tombstone
// branch and tombstoneReclaim.test.mjs for reclaim's own dedicated coverage),
// against the REAL production schema (every file in api/migrations, applied
// in order) and the REAL functions — not hand-copied SQL.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportJourney.test.mjs
//
// WHY THIS EXISTS, and why tombstoneCollision.test.mjs alone is not enough.
// That test proves SQLite's behavior by re-typing applyTsvRows' two statements
// into the test. That proves nothing if the real SQL later drifts — and the
// single most drift-sensitive line in this whole fix is the `existing` read's
// deliberate ABSENCE of a `deleted_at IS NULL` filter. If someone "tidies" that
// filter in, a tombstoned id stops reaching the tombstone branch, the counter
// silently stops firing, and every test that re-types the SQL still passes.
// So this file drives the real applyTsvRows and the real gate.
//
// What the journey covers:
//   (a) a reissued tombstone is now RECLAIMED automatically — the case that
//       used to only produce a `tombstone_blocked` count now lands master's
//       row in the same run (option 1, upstream issue #427)
//   (a2) a reclaim that LOSES its version-CAS race falls back to
//        tombstone_blocked exactly as before this fix — never a silent drop
//   (b) the watermark is WITHHELD (now driven by the (a2) race, since a clean
//       reclaim no longer needs a withhold), and the withhold is visible in
//       the STORED book_resource_syncs row (not merely in a return value),
//       including that the taint survives the addCounts aggregation step
//   (c) the banner is QUERYABLE from system_alerts, where the UI reads it
//   (d) the HEALTHY path still stamps origin='reimport' — no false withhold
//   (e) a RECOVERED resource's stale reimport_id_blocked alert is actually
//       CLEARED once the sync-success path records a watermark for it, and
//       clearing is scoped to that (book, resource) only

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTsvRows,
  recordResourceSync,
  recordWithheldSyncIfAbsent,
} from "./bookReimport.ts";
import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite ───────────────────────────────────────
// Mirrors the slice of the D1 API bookReimport.ts uses: prepare().bind().all()
// / .first() / .run(), and batch(). `.run()` returns D1's `{ meta: { changes } }`
// shape, which is the exact signal the conflict counter reads.
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
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "1CH";
// The real id from upstream's incident: minted for a 1CH 5:4 question,
// hand-deleted 2026-07-30, then reissued by bp-assistant for 1CH 23:7.
const ID = "hoig";

// The fork's watermarks are keyed by full source identity
// (generation/owner/repo/ref — migration 0044); this is the tq identity the
// journey records/withholds under.
const SRC = { generation: 1, owner: "unfoldingWord", repo: "en_tq", ref: "master" };

function seedTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4 } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old question", "old response", 10, 1753900000);
}

// Shaped exactly like parseTsvRow's output for a tq row.
function masterRow({ id = ID, ref = "23:7", chapter = 23, verse = 7, idCoerced = false } = {}) {
  return {
    id,
    idCoerced,
    refRaw: ref,
    chapter,
    verse,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new question",
    response: "new response",
  };
}

console.log("\n[(a) a reissued tombstone is now RECLAIMED — real applyTsvRows, issue #427 option 1]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);

  // Before option 1 shipped, this exact scenario (a tombstone master's file
  // now carries at a DIFFERENT reference) only counted tombstone_blocked and
  // dropped the row. Now the reimport reclaims the slot in the SAME run.
  eq(counts.tombstone_reclaimed, 1, "tombstone_reclaimed === 1 — issue #427's option 1 running automatically");
  eq(counts.tombstone_blocked, 0, "NOT counted blocked — the reclaim landed, nothing left to withhold for");
  eq(counts.inserted, 0, "not an insert — the existing (book, id) slot was reclaimed in place, not created fresh");
  eq(counts.skipped_edited, 0, "NOT counted skipped_edited — a landed reclaim is neither a skip nor a plain edit");
  eq(counts.conflict_skipped, 0, "NOT counted as a PK conflict: the tombstone branch owns this row");
  eq((counts.blocked_samples ?? []).length, 0, "no blocked sample — nothing was blocked this run");

  // Master's row genuinely lives in D1 now, in the SAME primary-key slot the
  // tombstone used to hold.
  const stored = sqlite
    .prepare(`SELECT chapter, verse, question, deleted_at, updated_by, version FROM tq_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored.length, 1, "still exactly one row for that (book, id)");
  eq(stored[0].chapter, 23, "the row now carries master's chapter — the REISSUED reference, not the tombstone's old one");
  eq(stored[0].verse, 7, "and master's verse");
  eq(stored[0].question, "new question", "and master's content — the reclaim actually landed the row, it did not just report it");
  eq(stored[0].deleted_at, null, "no longer a tombstone");
  eq(stored[0].updated_by, null, "master-owned going forward, same as a fresh insert");
  eq(stored[0].version, 2, "version bumped from the tombstone's stored version — CAS stays live for future writes");

  // THE DRIFT DETECTOR. If anyone adds `deleted_at IS NULL` to applyTsvRows'
  // `existing` read, the tombstone stops being found, this row takes the INSERT
  // path instead, and these assertions flip — which is the whole point.
  eq(
    counts.conflict_skipped + counts.tombstone_blocked + counts.tombstone_reclaimed,
    1,
    "exactly one drop-or-reclaim counted, by exactly one route",
  );
}

// Wrap an env.DB so the FIRST reclaim write this run issues is preceded by an
// out-of-band version bump on the SAME tombstoned row — exactly as a
// concurrent writer (another reimport instance, a hand-edit landing between
// applyTsvRows' initial `existing` read and this batched write) would do. The
// reclaim write is identified by its distinctive SQL shape: `updated_by =
// NULL,` in the SET clause together with `deleted_at IS NOT NULL` in the
// WHERE — only buildTsvUpdateStmt's `reclaim` mode produces that combination
// (resurrect's SET never touches updated_by; reseedAi's WHERE requires
// `deleted_at IS NULL`, the opposite). This drives a REAL, CAS-losing reclaim
// through the real function, instead of hand-asserting what "should" happen
// on a race — see api/src/bookReimport.ts's reclaim batch for the fallback
// this is meant to prove.
function withReclaimRace(env, sqlite, book, id) {
  let fired = false;
  return {
    ...env,
    DB: {
      ...env.DB,
      async batch(stmts) {
        if (
          !fired &&
          stmts.some((s) => s.sql.includes("updated_by = NULL,") && s.sql.includes("deleted_at IS NOT NULL"))
        ) {
          fired = true;
          sqlite.prepare(`UPDATE tq_rows SET version = version + 1 WHERE book = ? AND id = ?`).run(book, id);
        }
        return env.DB.batch(stmts);
      },
    },
  };
}

console.log("\n[(a2) a reclaim that LOSES its version-CAS race falls back to tombstone_blocked, never a silent drop]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);

  eq(counts.tombstone_reclaimed, 0, "the reclaim did NOT land — the race won");
  eq(counts.tombstone_blocked, 1, "falls back to tombstone_blocked — exactly as if reclaim had never been attempted");
  eq(
    (counts.blocked_samples ?? [])[0]?.includes(ID),
    true,
    "the sample still names the row, so the fallback is exactly as actionable as the pre-reclaim behavior",
  );

  // And nothing was clobbered: the row that won the race is untouched by this
  // run's reclaim attempt (still the OLD tombstone content, just at the newer
  // version the race stamped).
  const stored = sqlite.prepare(`SELECT chapter, question, deleted_at, version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "the row the race left behind is untouched by the losing reclaim write");
  eq(stored[0].question, "old question", "content untouched — a lost CAS never partially applies");
  eq(stored[0].deleted_at != null, true, "still a tombstone — the race bumped version, not deleted_at");
  eq(stored[0].version, 2, "version reflects the race's bump, not the reclaim's (failed) write");
}

console.log("\n[the same-reference tombstone must NOT count — it is a delete awaiting export]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "5:4", chapter: 5, verse: 4 })], null);
  eq(counts.tombstone_blocked, 0, "same ref → not blocked (the 4 AMO rows in upstream's production sweep)");
  eq(counts.skipped_edited, 1, "still skipped, which is what preserves the pending deletion");
  eq(shouldRecordResourceSync(counts), true, "and the watermark is NOT withheld for it");
}

console.log("\n[a COERCED id must never count as blocked]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // coerceRowId hashes a malformed master id into a 96-id space, so landing on
  // an unrelated tombstone at a different reference is an expected collision,
  // not evidence master reissued anything. Counting it would freeze the export.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "23:7", idCoerced: true })], null);
  eq(counts.tombstone_blocked, 0, "coerced id + different ref → NOT blocked (documented-benign no-op)");
  eq(counts.tombstone_reclaimed, 0, "…and NOT reclaimed either — reclaiming here would corrupt an unrelated row");
  eq(shouldRecordResourceSync(counts), true, "so a coercion collision cannot withhold the watermark");
}

console.log("\n[(b) the watermark is WITHHELD, and the STORED row proves it]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  // Force the lost-CAS fallback (see (a2) above) so this run still produces a
  // real tombstone_blocked count to withhold on — the ordinary reissue case in
  // (a) now reclaims and no longer needs (or triggers) a withhold at all.
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);

  // The gate is consulted on the AGGREGATE, not on this raw object — that is the
  // step where an absent counter could be laundered into a present zero. Prove
  // the taint survives it by folding through the real aggregation path.
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts").then((m) => ({
    zeroCountsForTest: m.zeroCountsForTest,
    addCountsForTest: m.addCountsForTest,
  }));
  const aggregate = zeroCountsForTest();
  addCountsForTest(aggregate, counts);
  eq(aggregate.tombstone_blocked, 1, "the count survives aggregation (addCounts)");
  eq(shouldRecordResourceSync(aggregate), false, "the gate refuses to stamp on the aggregate");

  // A legacy chunk result (pre-deploy Workflow replay) missing the new fields
  // must taint the aggregate — never launder into a present zero.
  const legacyAggregate = zeroCountsForTest();
  const legacy = zeroCountsForTest();
  delete legacy.conflict_skipped;
  delete legacy.tombstone_blocked;
  delete legacy.counts_incomplete;
  addCountsForTest(legacyAggregate, legacy);
  eq(legacyAggregate.counts_incomplete, true, "a folded-in legacy chunk missing the fields taints counts_incomplete");
  eq(shouldRecordResourceSync(legacyAggregate), false, "…and the gate withholds on the taint");

  // Now the real write path the reimport-sync step takes when it withholds.
  await recordWithheldSyncIfAbsent(env, BOOK, "tq", SRC);
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(row?.origin, "reimport_withheld", "STORED origin is 'reimport_withheld', NOT 'reimport'");
  eq(
    row?.source_sha,
    "withheld",
    "and the stored sha is the sentinel — a value no real commit sha can equal, so the export's " +
      "freshness gate reports master_ahead instead of the no_watermark/ok it would return for an absent row",
  );

  // The sentinel never overwrites a real watermark: record a real SHA, withhold
  // again, and the real SHA survives.
  await recordResourceSync(env, BOOK, "tq", "abc123def456", "reimport", SRC);
  await recordWithheldSyncIfAbsent(env, BOOK, "tq", SRC);
  const after = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(after?.source_sha, "abc123def456", "an existing real watermark is NOT clobbered by a later withhold");
}

console.log("\n[(c) the banner is QUERYABLE where the UI reads it]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);
  const { raiseTombstoneBlockAlertForTest } = await import("./bookReimport.ts");
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", counts);

  const alert = sqlite
    .prepare(`SELECT username, severity, source, message FROM system_alerts WHERE source = ?`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(alert !== undefined, true, "an alert row exists in system_alerts");
  eq(alert?.severity, "error", "raised at error severity");
  eq(alert?.message.includes("1CH"), true, "names the book");
  eq(alert?.message.includes("hoig"), true, "names the actual blocked row id, so it is actionable");
  // Since option 1 shipped, a `tombstone_blocked` count means the reclaim
  // LOST its version-CAS race (this scenario), not a permanent freeze — the
  // message now says so, instead of the pre-fix "does NOT clear on its own"
  // framing, which no longer describes this case honestly.
  eq(
    alert?.message.includes("should resolve automatically"),
    true,
    "states the expected-to-self-heal-on-retry consequence, not a permanent freeze",
  );
  eq(
    alert?.message.includes("does NOT clear on its own"),
    false,
    "the pre-reclaim 'does NOT clear on its own' framing no longer applies to a pure reclaim-race block",
  );
  eq(
    alert?.message.includes("re-run the sync"),
    false,
    "and does NOT repeat the export_stale banner's advice, which cannot work here",
  );
}

console.log("\n[(d) the HEALTHY path still stamps — no false withhold]");
{
  const { sqlite, env } = freshEnv();
  // No tombstone at all: master's row is genuinely new.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);
  eq(counts.inserted, 1, "the row lands normally");
  eq(counts.tombstone_blocked, 0, "nothing blocked");
  eq(counts.conflict_skipped, 0, "nothing conflicted");
  eq(shouldRecordResourceSync(counts), true, "the gate permits the stamp");

  await recordResourceSync(env, BOOK, "tq", "abc123def456", "reimport", SRC);
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(row?.origin, "reimport", "STORED origin is 'reimport' — the book IS certified in sync");
  eq(row?.source_sha, "abc123def456", "with master's real sha, not the sentinel");

  const alerts = sqlite.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source LIKE 'reimport_id_blocked:%'`).all()[0];
  eq(Number(alerts.n), 0, "and no banner is raised on a clean run");
}

console.log("\n[(e) a RECOVERED resource clears its stale reimport_id_blocked alert]");
{
  // The alert's own message promises the reclaim-race half "usually resolves
  // automatically" (see (c) above) — but without clearTombstoneBlockAlert
  // nothing would ever actually delete it once the resource recovered:
  // raiseTombstoneBlockAlert only runs while STILL withheld, so a resolved
  // alert would sit active in the banner forever, falsely claiming the
  // resource was still out of sync.
  const { sqlite, env } = freshEnv();
  const { raiseTombstoneBlockAlertForTest, clearTombstoneBlockAlertForTest } = await import("./bookReimport.ts");

  // Simulate last night: a reclaim lost its version-CAS race and raised the
  // banner, exactly like (c) above.
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const staleCounts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", staleCounts);
  const before = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(Number(before.n), 1, "sanity: the stale alert exists before recovery");

  // Also raise one for a DIFFERENT book/resource — clearing must be scoped,
  // never a blanket wipe of every open reimport_id_blocked alert.
  await raiseTombstoneBlockAlertForTest(env, "AMO", "tn", staleCounts);

  // Tonight: the race resolved (the tombstoned row is no longer contested),
  // so the resource syncs cleanly this run. Exercise exactly the two calls
  // runChunkedReimport's sync-success branch makes, in the same order:
  // recordResourceSync (the watermark stamp), then clearTombstoneBlockAlert.
  await recordResourceSync(env, BOOK, "tq", "def456abc789", "reimport", SRC);
  await clearTombstoneBlockAlertForTest(env, BOOK, "tq");

  const after = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(Number(after.n), 0, "the recovered resource's alert is cleared");

  const otherStillOpen = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:AMO:tn`)[0];
  eq(Number(otherStillOpen.n), 1, "a DIFFERENT (book, resource)'s alert is untouched — clearing is scoped, not a blanket wipe");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportJourney assertions passed.");
