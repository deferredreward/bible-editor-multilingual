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
import { normalizeRowIds } from "./translateOptions.ts";

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
  return db
    .prepare(
      `SELECT j.job_id, j.user_id
         FROM pipeline_jobs j
        WHERE j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
          AND j.pipeline_type = ?4
          AND (?5 IS NULL OR COALESCE(json_extract(j.options_json, '$.resourceType'), 'tn') = ?5)
          AND (?6 IS NULL OR COALESCE(json_extract(j.options_json, '$.rowIds'), 'ALL') = ?6)
          AND j.state IN ('queued','dispatching','running','paused_for_outage','paused_for_usage_limit')
        ORDER BY j.created_at ASC
        LIMIT 1`,
    )
    .get("MRK", 5, 5, "translate", dedupResourceType, dedupRowScope);
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

console.log("\npipelineRowScopeDedup: all assertions passed");
