// Unit test for the scope terms of the /api/pipelines/start conflict queries
// (issue #316 row scope, #347 item 2 verse range, #347 item 1 coverage).
//
// The queries live inline in the Hono route in pipelines.ts, so this test drives
// them against an in-memory node:sqlite DB (the schema-invariant testing pattern
// noted in STATE.md). It used to hand-copy the WHERE clause, which could drift
// from the real query while still passing (flagged in the #356 review); the
// clauses are now IMPORTED from pipelineDedupSql.ts — the same strings the route
// executes — and only the bound values are reproduced here.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineRowScopeDedup.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DatabaseSync } from "node:sqlite";
import { normalizeRowIds, normalizeTranslateRowIdsJson } from "./translateOptions.ts";
import {
  PIPELINE_COVERAGE_WHERE,
  PIPELINE_DEDUP_WHERE,
  coverageVerseRange,
  isNarrowerTranslateScope,
} from "./pipelineDedupSql.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// One isolated in-memory DB plus the bind-value logic the route computes around
// the shared clauses. Each block makes its own so seeded jobs never leak.
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pipeline_jobs (
      job_id TEXT PRIMARY KEY,
      user_id INTEGER,
      pipeline_type TEXT,
      book TEXT,
      start_chapter INTEGER,
      end_chapter INTEGER,
      options_json TEXT,
      state TEXT,
      created_at INTEGER
    );
  `);
  let seq = 0;

  // Mirror buildTranslateOptions' persistence: rowIds stored normalized, omitted
  // entirely for a chapter-wide job; verseStart/verseEnd only when present.
  function seed(jobId, userId, translate, pipelineType = "translate", state = "running") {
    const opts =
      pipelineType === "translate" ? { resourceType: translate?.resourceType ?? "tn" } : {};
    const norm = normalizeRowIds(translate?.rowIds);
    if (norm) opts.rowIds = norm;
    if (translate?.verseStart != null) opts.verseStart = translate.verseStart;
    if (translate?.verseEnd != null) opts.verseEnd = translate.verseEnd;
    db.prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, options_json, state, created_at)
       VALUES (?, ?, ?, 'MRK', 5, 5, ?, ?, ?)`,
    ).run(jobId, userId, pipelineType, JSON.stringify(opts), state, seq++);
  }

  // Exact-identity dedupe — the route's PIPELINE_DEDUP_WHERE, bound the way the
  // route binds it (book/chapter fixed to the seeded scope).
  function findDup(translate, pipelineType = "translate") {
    const isTranslate = pipelineType === "translate";
    const norm = normalizeRowIds(translate?.rowIds);
    return db
      .prepare(
        `SELECT j.job_id, j.user_id
           FROM pipeline_jobs j
          WHERE ${PIPELINE_DEDUP_WHERE}
          ORDER BY j.created_at ASC
          LIMIT 1`,
      )
      .get(
        "MRK",
        5,
        5,
        pipelineType,
        isTranslate ? (translate?.resourceType ?? "tn") : null,
        isTranslate ? (norm ? JSON.stringify(norm) : "ALL") : null,
        isTranslate ? (translate?.verseStart ?? 0) : null,
        isTranslate ? (translate?.verseEnd ?? 0) : null,
      );
  }

  // Coverage conflict — the route's PIPELINE_COVERAGE_WHERE, bound through the
  // route's own coverageVerseRange (imported, not re-typed).
  function findCovering(translate) {
    const verses = coverageVerseRange(translate?.verseStart, translate?.verseEnd);
    return db
      .prepare(
        `SELECT j.job_id, j.user_id
           FROM pipeline_jobs j
          WHERE ${PIPELINE_COVERAGE_WHERE}
          ORDER BY j.created_at ASC
          LIMIT 1`,
      )
      .get("MRK", 5, 5, translate?.resourceType ?? "tn", verses.start, verses.end);
  }

  // The route's full decision: exact identity first, then — only when the route's
  // own isNarrowerTranslateScope says the incoming request is the narrower side —
  // the coverage query.
  function resolveConflict(translate, pipelineType = "translate") {
    const exact = findDup(translate, pipelineType);
    if (exact) return exact;
    const verses = coverageVerseRange(translate?.verseStart, translate?.verseEnd);
    const narrower = isNarrowerTranslateScope(
      pipelineType,
      normalizeRowIds(translate?.rowIds),
      verses.start,
    );
    return narrower ? findCovering(translate) : undefined;
  }

  return { seed, findDup, findCovering, resolveConflict };
}

const USER = 1;

console.log("[#316] row scope is part of dedupe identity");
{
  const { seed, findDup } = makeDb();
  // Row A in flight for this user.
  seed("jobA", USER, { rowIds: ["rowA"] });

  // Bullet 1: a DIFFERENT row → NOT a dup (row B must get its own job).
  assert(findDup({ rowIds: ["rowB"] }) === undefined, "row B does not dedup onto row A's job (the bug)");

  // Bullet 2: the SAME row → still already_running (dup found).
  const same = findDup({ rowIds: ["rowA"] });
  assert(same && same.job_id === "jobA", "row A again → dedups onto jobA (already_running preserved)");

  // Order-independence: same set, different order → still dups.
  seed("jobAB", USER, { rowIds: ["p", "q"] });
  const reorder = findDup({ rowIds: ["q", "p"] });
  assert(reorder && reorder.job_id === "jobAB", "[q,p] dedups onto stored [p,q] (order-independent)");

  // Bullet 3: a chapter-wide translate is unaffected by row-scoped jobs...
  assert(findDup(undefined) === undefined, "chapter-wide request does not dedup against row-scoped jobs");
  // ...and a row-scoped request has no EXACT dup against a chapter-wide job.
  // (#347 item 1 layers a coverage conflict on top of that; see its block below.)
  seed("jobAll", USER, undefined);
  assert(
    findDup({ rowIds: ["rowZ"] }) === undefined,
    "row-scoped request has no exact dup against a chapter-wide job",
  );
  // Chapter-wide DOES still dedup against another chapter-wide (unchanged behavior).
  const allDup = findDup(undefined);
  assert(allDup && allDup.job_id === "jobAll", "chapter-wide dedups against chapter-wide (unchanged)");

  // resourceType still separates work: a tq row-scoped job for the same row does
  // not collide with the tn one.
  seed("jobTqA", USER, { resourceType: "tq", rowIds: ["rowA"] });
  const tnA = findDup({ resourceType: "tn", rowIds: ["rowA"] });
  assert(tnA && tnA.job_id === "jobA", "tn row A dedups onto the tn job, not the tq one");
  const tqA = findDup({ resourceType: "tq", rowIds: ["rowA"] });
  assert(tqA && tqA.job_id === "jobTqA", "tq row A dedups onto the tq job (resourceType still separates)");
}

console.log("\n[#347 item 2] verse-range scope is part of dedupe identity");
{
  const { seed, findDup } = makeDb();
  // A verse-range translate for verses 6-7 in flight (no rowIds → row scope 'ALL').
  seed("jobV67", USER, { verseStart: 6, verseEnd: 7 });

  // Different verse range in the same chapter → NOT a dup (the bug: both resolve
  // to row scope 'ALL', so without a verse-range term they would collapse).
  assert(
    findDup({ verseStart: 8, verseEnd: 9 }) === undefined,
    "verses 8-9 do not dedup onto the 6-7 job (verse range is part of identity)",
  );
  // Same verse range → still already_running.
  const sameRange = findDup({ verseStart: 6, verseEnd: 7 });
  assert(sameRange && sameRange.job_id === "jobV67", "verses 6-7 again → dedups onto jobV67");
  // A single-verse range that shares verseStart but differs on verseEnd is distinct.
  assert(
    findDup({ verseStart: 6, verseEnd: 6 }) === undefined,
    "verse 6 alone has no exact dup on the 6-7 range (verseEnd separates)",
  );
  // Verse-range vs chapter-wide are distinct identities (consistent with #316's
  // row-scoped vs chapter-wide choice): a chapter-wide request binds verseStart 0.
  seed("jobAll", USER, undefined);
  const chapWide = findDup(undefined);
  assert(
    chapWide && chapWide.job_id === "jobAll",
    "chapter-wide request does not dedup onto the verse-range job",
  );
  // A verse-range request resolves to its own verse-range job, not the chapter-wide one.
  const rangeDup = findDup({ verseStart: 6, verseEnd: 7 });
  assert(
    rangeDup && rangeDup.job_id === "jobV67",
    "verse-range request resolves to its verse-range job, not a chapter-wide one",
  );
  // A verse-range request has no exact dup against a row-scoped job in the chapter.
  seed("jobRowX", USER, { rowIds: ["rX"] });
  assert(
    findDup({ verseStart: 3, verseEnd: 3 }) === undefined,
    "verse-range request has no exact dup against a row-scoped job",
  );
}

console.log("\n[#347 item 1] a broader in-flight job blocks a narrower request inside its scope");
{
  const { seed, findDup, resolveConflict } = makeDb();
  // A chapter-wide tn translate is running.
  seed("jobChapter", USER, undefined);

  // 1. chapter-wide blocks row-scoped.
  const rowInside = resolveConflict({ rowIds: ["rowA"] });
  assert(
    rowInside && rowInside.job_id === "jobChapter",
    "row-scoped request is blocked by the in-flight chapter-wide job (returns its id)",
  );
  // 2. chapter-wide blocks verse-range.
  const rangeInside = resolveConflict({ verseStart: 6, verseEnd: 7 });
  assert(
    rangeInside && rangeInside.job_id === "jobChapter",
    "verse-range request is blocked by the in-flight chapter-wide job",
  );
  // resourceType still separates: a tq narrower request is NOT blocked by the tn
  // chapter-wide job.
  assert(
    resolveConflict({ resourceType: "tq", rowIds: ["rowA"] }) === undefined,
    "tq row-scoped request is not blocked by a tn chapter-wide job",
  );

  // 3. identical-request dedupe unchanged, and exact identity wins over coverage:
  // with BOTH a chapter-wide job and the row's own job in flight, the row-scoped
  // request still resolves to its OWN job's id (no #316 mis-attribution).
  seed("jobRowA", USER, { rowIds: ["rowA"] });
  const exactWins = resolveConflict({ rowIds: ["rowA"] });
  assert(
    exactWins && exactWins.job_id === "jobRowA",
    "exact identity still wins over coverage (row A resolves to its own job)",
  );
  const chapAgain = findDup(undefined);
  assert(
    chapAgain && chapAgain.job_id === "jobChapter",
    "identical chapter-wide request still dedups onto the chapter-wide job (unchanged)",
  );
}

console.log("\n[#347 item 1] the reverse direction stays allowed");
{
  // A bulk (chapter-wide) request while a row-scoped job runs proceeds as today.
  const { seed, resolveConflict } = makeDb();
  seed("jobRowOnly", USER, { rowIds: ["rowA"] });
  assert(
    resolveConflict(undefined) === undefined,
    "chapter-wide request is NOT blocked by an in-flight row-scoped job",
  );
  assert(
    resolveConflict({ rowIds: ["rowB"] }) === undefined,
    "a row-scoped job does not block a different row-scoped request",
  );

  // A WIDER verse range (or a chapter-wide run) while a narrower range runs is
  // likewise untouched — coverage is narrower-inside-broader only.
  const { seed: seedB, resolveConflict: resolveB } = makeDb();
  seedB("jobV67", USER, { verseStart: 6, verseEnd: 7 });
  assert(
    resolveB({ verseStart: 5, verseEnd: 9 }) === undefined,
    "a wider verse-range request is not blocked by a narrower in-flight range",
  );
  assert(
    resolveB(undefined) === undefined,
    "chapter-wide request is not blocked by an in-flight verse-range job",
  );
}

console.log("\n[#347 item 1] a covering verse range blocks a narrower range inside it");
{
  const { seed, resolveConflict } = makeDb();
  seed("jobV68", USER, { verseStart: 6, verseEnd: 8 });

  const inner = resolveConflict({ verseStart: 6, verseEnd: 7 });
  assert(inner && inner.job_id === "jobV68", "verses 6-7 blocked by the covering 6-8 job");
  const innerMid = resolveConflict({ verseStart: 7, verseEnd: 7 });
  assert(innerMid && innerMid.job_id === "jobV68", "verse 7 alone blocked by the covering 6-8 job");
  // Partial overlap is NOT containment → still allowed (narrower-inside-broader only).
  assert(
    resolveConflict({ verseStart: 8, verseEnd: 10 }) === undefined,
    "verses 8-10 (overlapping but not contained) are not blocked by the 6-8 job",
  );
  assert(
    resolveConflict({ verseStart: 1, verseEnd: 3 }) === undefined,
    "a disjoint verse range is not blocked",
  );
  // Documented GAP: a row-scoped request inside a covering verse-range job is NOT
  // detected — that needs a rowId → verse lookup the start route does not do.
  assert(
    resolveConflict({ rowIds: ["rowA"] }) === undefined,
    "row-scoped request inside a verse-range job is not blocked (documented gap)",
  );
  // An INVERTED request range ({verseStart: 8, verseEnd: 3} — the schema allows
  // it, there is no ordering refine) must not be satisfied by a job that covers
  // only the low end. coverageVerseRange clamps the end up to the start, so this
  // demands a job covering verse 8; the 6-8 job does cover it, but a 1-4 job
  // must not.
  const inverted = resolveConflict({ verseStart: 8, verseEnd: 3 });
  assert(
    inverted && inverted.job_id === "jobV68",
    "inverted range 8-3 is clamped to verse 8 and matches the covering 6-8 job",
  );
  const { seed: seedLow, resolveConflict: resolveLow } = makeDb();
  seedLow("jobV14", USER, { verseStart: 1, verseEnd: 4 });
  assert(
    resolveLow({ verseStart: 8, verseEnd: 3 }) === undefined,
    "inverted range 8-3 is NOT falsely blocked by a job covering verses 1-4",
  );
}

console.log("\n[#347 item 1] only non-terminal jobs cover");
{
  // A job that is done/failed/cancelled is not going to write anything, so it must
  // not block a narrower request. The coverage clause shares the active-state list
  // with the exact-identity clause.
  for (const state of ["done", "failed", "cancelled", "error"]) {
    const { seed, resolveConflict } = makeDb();
    seed("jobChapter", USER, undefined, "translate", state);
    assert(
      resolveConflict({ rowIds: ["rowA"] }) === undefined,
      `a '${state}' chapter-wide job does not block a row-scoped request`,
    );
  }
  // Paused states DO still count as in flight (the decision says non-terminal).
  for (const state of ["queued", "dispatching", "paused_for_outage", "paused_for_usage_limit"]) {
    const { seed, resolveConflict } = makeDb();
    seed("jobChapter", USER, undefined, "translate", state);
    const blocked = resolveConflict({ rowIds: ["rowA"] });
    assert(
      blocked && blocked.job_id === "jobChapter",
      `a '${state}' chapter-wide job blocks a row-scoped request`,
    );
  }
}

console.log("\n[#347 item 1] a job with an unknown extent never covers");
{
  // A stored job carrying verseEnd but NO verseStart has an extent we can't reason
  // about; the clause must treat it as non-covering rather than falsely blocking.
  const { seed, resolveConflict } = makeDb();
  seed("jobEndOnly", USER, { verseEnd: 9 });
  assert(
    resolveConflict({ verseStart: 6, verseEnd: 7 }) === undefined,
    "a job with verseEnd but no verseStart covers nothing (no false block)",
  );
  assert(
    resolveConflict({ rowIds: ["rowA"] }) === undefined,
    "a job with verseEnd but no verseStart does not block a row-scoped request",
  );
  // A job with verseStart but no verseEnd covers exactly that one verse.
  const { seed: seedS, resolveConflict: resolveS } = makeDb();
  seedS("jobStartOnly", USER, { verseStart: 6 });
  const one = resolveS({ verseStart: 6, verseEnd: 6 });
  assert(one && one.job_id === "jobStartOnly", "a job with verseStart only covers that single verse");
  assert(
    resolveS({ verseStart: 6, verseEnd: 7 }) === undefined,
    "a job with verseStart only does not cover a two-verse request",
  );
}

console.log("\n[#347 item 1] non-translate pipelines are unaffected");
{
  const { seed, resolveConflict } = makeDb();
  seed("jobNotes", USER, undefined, "notes");
  const notesDup = resolveConflict(undefined, "notes");
  assert(
    notesDup && notesDup.job_id === "jobNotes",
    "notes request dedups against the in-flight notes job (unchanged)",
  );
  // A translate request in the same scope is not blocked by a notes job.
  assert(
    resolveConflict({ rowIds: ["rowA"] }) === undefined,
    "translate row-scoped request is not blocked by a non-translate job",
  );
  // And a notes job never blocks another kind's narrower request via coverage.
  const { seed: seedG, resolveConflict: resolveG } = makeDb();
  seedG("jobGenerate", USER, undefined, "generate");
  assert(
    resolveG({ verseStart: 2, verseEnd: 3 }) === undefined,
    "verse-range translate request is not blocked by an in-flight generate job",
  );
}

console.log("\n[#347 item 3] normalizeTranslateRowIdsJson keeps follow-up rowIds canonical");
{
  // A translate child whose stored options carry un-normalized rowIds (unsorted +
  // duplicated) must come out sorted+deduped so a same-row request's dedup key
  // (JSON.stringify(normalizeRowIds([...]))) matches json_extract($.rowIds).
  const raw = JSON.stringify({ resourceType: "tn", rowIds: ["q", "p", "q", "a"] });
  const normed = normalizeTranslateRowIdsJson("translate", raw);
  assert(
    JSON.parse(normed).rowIds.join(",") === "a,p,q",
    `rowIds normalized to sorted+deduped set (got ${normed})`,
  );
  // Round-trip: the normalized $.rowIds must equal the dedup key a fresh request
  // for the same set computes — otherwise a same-row follow-up wouldn't dedup.
  assert(
    JSON.stringify(JSON.parse(normed).rowIds) === JSON.stringify(normalizeRowIds(["a", "p", "q"])),
    "normalized follow-up rowIds equals the dedup key for the same set",
  );
  // Non-translate child: untouched (a generate/notes follow-up must not be rebuilt).
  const gen = JSON.stringify({ contentTypes: ["ult"] });
  assert(normalizeTranslateRowIdsJson("generate", gen) === gen, "non-translate options returned verbatim");
  // null options → null.
  assert(normalizeTranslateRowIdsJson("translate", null) === null, "null options_json stays null");
  // translate options with no rowIds → untouched.
  const noRows = JSON.stringify({ resourceType: "tq", verseStart: 4 });
  assert(normalizeTranslateRowIdsJson("translate", noRows) === noRows, "translate options without rowIds returned verbatim");
  // Empty rowIds array → rowIds dropped (collapses to chapter-wide 'ALL').
  const empty = JSON.stringify({ resourceType: "tn", rowIds: [] });
  assert(
    !("rowIds" in JSON.parse(normalizeTranslateRowIdsJson("translate", empty))),
    "empty rowIds array is dropped (chapter-wide)",
  );
  // Unparseable JSON → returned verbatim (never throws).
  assert(normalizeTranslateRowIdsJson("translate", "{not json") === "{not json", "unparseable options returned verbatim");
}

console.log("\npipelineRowScopeDedup: all assertions passed");
