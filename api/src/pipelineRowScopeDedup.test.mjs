// Unit test for the row-scope term of the /api/pipelines/start dedupe query
// (issue #316). The dedupe SELECT lives inline in the Hono route in
// pipelines.ts, so this test reconstructs its exact WHERE clause against an
// in-memory node:sqlite DB (the schema-invariant testing pattern noted in
// STATE.md) and drives it with the same bound values the route computes via
// normalizeRowIds, proving row scope is part of dedupe identity.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineRowScopeDedup.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DatabaseSync } from "node:sqlite";
import { normalizeRowIds, normalizeTranslateRowIdsJson } from "./translateOptions.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

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

// Mirror buildTranslateOptions' persistence: rowIds stored normalized, omitted
// entirely for a chapter-wide job.
let seq = 0;
function seed(jobId, userId, translate) {
  const opts = { resourceType: translate?.resourceType ?? "tn" };
  const norm = normalizeRowIds(translate?.rowIds);
  if (norm) opts.rowIds = norm;
  // Mirror buildTranslateOptions: verseStart/verseEnd persisted only when present.
  if (translate?.verseStart != null) opts.verseStart = translate.verseStart;
  if (translate?.verseEnd != null) opts.verseEnd = translate.verseEnd;
  db.prepare(
    `INSERT INTO pipeline_jobs
       (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, options_json, state, created_at)
     VALUES (?, ?, 'translate', 'MRK', 5, 5, ?, 'running', ?)`,
  ).run(jobId, userId, JSON.stringify(opts), seq++);
}

// The EXACT translate branch of the route's dedupe SELECT (book/chapter fixed to
// the seeded scope; resourceType + rowScope bound as the route binds them).
function findDup(userId, translate) {
  const dedupResourceType = translate?.resourceType ?? "tn";
  const norm = normalizeRowIds(translate?.rowIds);
  const dedupRowScope = norm ? JSON.stringify(norm) : "ALL";
  const dedupVerseStart = translate?.verseStart ?? 0;
  const dedupVerseEnd = translate?.verseEnd ?? 0;
  return db
    .prepare(
      `SELECT j.job_id, j.user_id
         FROM pipeline_jobs j
        WHERE j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
          AND j.pipeline_type = ?4
          AND (?5 IS NULL OR COALESCE(json_extract(j.options_json, '$.resourceType'), 'tn') = ?5)
          AND (?6 IS NULL OR COALESCE(json_extract(j.options_json, '$.rowIds'), 'ALL') = ?6)
          AND (?7 IS NULL OR COALESCE(json_extract(j.options_json, '$.verseStart'), 0) = ?7)
          AND (?8 IS NULL OR COALESCE(json_extract(j.options_json, '$.verseEnd'), 0) = ?8)
          AND j.state IN ('queued','dispatching','running','paused_for_outage','paused_for_usage_limit')
        ORDER BY j.created_at ASC
        LIMIT 1`,
    )
    .get("MRK", 5, 5, "translate", dedupResourceType, dedupRowScope, dedupVerseStart, dedupVerseEnd);
}

const USER = 1;

console.log("[#316] row scope is part of dedupe identity");
{
  // Row A in flight for this user.
  seed("jobA", USER, { rowIds: ["rowA"] });

  // Bullet 1: a DIFFERENT row → NOT a dup (row B must get its own job).
  assert(findDup(USER, { rowIds: ["rowB"] }) === undefined, "row B does not dedup onto row A's job (the bug)");

  // Bullet 2: the SAME row → still already_running (dup found).
  const same = findDup(USER, { rowIds: ["rowA"] });
  assert(same && same.job_id === "jobA", "row A again → dedups onto jobA (already_running preserved)");

  // Order-independence: same set, different order → still dups.
  seed("jobAB", USER, { rowIds: ["p", "q"] });
  const reorder = findDup(USER, { rowIds: ["q", "p"] });
  assert(reorder && reorder.job_id === "jobAB", "[q,p] dedups onto stored [p,q] (order-independent)");

  // Bullet 3: a chapter-wide translate is unaffected by row-scoped jobs...
  assert(findDup(USER, undefined) === undefined, "chapter-wide request does not dedup against row-scoped jobs");
  // ...and a row-scoped request does not dedup against a chapter-wide job.
  seed("jobAll", USER, undefined);
  assert(findDup(USER, { rowIds: ["rowZ"] }) === undefined, "row-scoped request does not dedup against a chapter-wide job");
  // Chapter-wide DOES still dedup against another chapter-wide (unchanged behavior).
  const allDup = findDup(USER, undefined);
  assert(allDup && allDup.job_id === "jobAll", "chapter-wide dedups against chapter-wide (unchanged)");

  // resourceType still separates work: a tq row-scoped job for the same row does
  // not collide with the tn one.
  seed("jobTqA", USER, { resourceType: "tq", rowIds: ["rowA"] });
  const tnA = findDup(USER, { resourceType: "tn", rowIds: ["rowA"] });
  assert(tnA && tnA.job_id === "jobA", "tn row A dedups onto the tn job, not the tq one");
  const tqA = findDup(USER, { resourceType: "tq", rowIds: ["rowA"] });
  assert(tqA && tqA.job_id === "jobTqA", "tq row A dedups onto the tq job (resourceType still separates)");
}

console.log("\n[#347 item 2] verse-range scope is part of dedupe identity");
{
  // A verse-range translate for verses 6-7 in flight (no rowIds → row scope 'ALL').
  seed("jobV67", USER, { verseStart: 6, verseEnd: 7 });

  // Different verse range in the same chapter → NOT a dup (the bug: both resolve
  // to row scope 'ALL', so without a verse-range term they would collapse).
  assert(
    findDup(USER, { verseStart: 8, verseEnd: 9 }) === undefined,
    "verses 8-9 do not dedup onto the 6-7 job (verse range is part of identity)",
  );
  // Same verse range → still already_running.
  const sameRange = findDup(USER, { verseStart: 6, verseEnd: 7 });
  assert(sameRange && sameRange.job_id === "jobV67", "verses 6-7 again → dedups onto jobV67");
  // A single-verse range that shares verseStart but differs on verseEnd is distinct.
  assert(
    findDup(USER, { verseStart: 6, verseEnd: 6 }) === undefined,
    "verse 6 alone does not dedup onto the 6-7 range (verseEnd separates)",
  );
  // Verse-range vs chapter-wide never collide (consistent with #316's row-scoped
  // vs chapter-wide choice): a chapter-wide request binds verseStart 0, so it
  // resolves to a chapter-wide job (jobAll from above), never the verse-range one.
  const chapWide = findDup(USER, undefined);
  assert(
    !chapWide || chapWide.job_id !== "jobV67",
    "chapter-wide request does not dedup onto the verse-range job",
  );
  // A verse-range request resolves to its own verse-range job, not the chapter-wide one.
  const rangeDup = findDup(USER, { verseStart: 6, verseEnd: 7 });
  assert(
    rangeDup && rangeDup.job_id === "jobV67",
    "verse-range request resolves to its verse-range job, not a chapter-wide one",
  );
  // A verse-range request must not dedup against a row-scoped job in the chapter.
  seed("jobRowX", USER, { rowIds: ["rX"] });
  assert(
    findDup(USER, { verseStart: 3, verseEnd: 3 }) === undefined,
    "verse-range request does not dedup against a row-scoped job",
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
