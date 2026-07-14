// Unit tests for articleExport.ts — the PURE pieces of tW/tA article export:
// the step (resource × top-level dir) fan-out, the LIKE-prefix + label helpers,
// the shrink-guard analogue, and the git-blob-sha used for change detection.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/articleExport.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  ARTICLE_RESOURCES,
  ARTICLE_TOP_DIRS,
  articleStepUnits,
  topDirLikePrefix,
  articleStepLabel,
  shrinkRefused,
  gitBlobSha,
} from "./articleExport.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- Step fan-out: 3 tw dirs + 4 ta dirs, resource-major ---
const all = articleStepUnits();
assert(all.length === 7, "articleStepUnits(): 3 tw + 4 ta = 7 steps");
assert(
  all.slice(0, 3).every((u) => u.resource === "tw") && all.slice(3).every((u) => u.resource === "ta"),
  "articleStepUnits(): resource-major (all tw before all ta)",
);
assert(
  JSON.stringify(all.map((u) => u.topDir)) ===
    JSON.stringify(["bible/kt", "bible/names", "bible/other", "translate", "checking", "process", "intro"]),
  "articleStepUnits(): topDirs match the importer's walk roots",
);
assert(
  articleStepUnits(["ta"]).length === 4 && articleStepUnits(["ta"]).every((u) => u.resource === "ta"),
  "articleStepUnits(['ta']): narrows to the 4 ta manuals",
);
assert(articleStepUnits([]).length === 7, "articleStepUnits([]): empty → all resources (not zero)");
assert(ARTICLE_RESOURCES.length === 2 && ARTICLE_TOP_DIRS.tw.length === 3 && ARTICLE_TOP_DIRS.ta.length === 4, "constants shape");

// --- LIKE prefix anchors at the dir boundary ---
assert(topDirLikePrefix("bible/kt") === "bible/kt/%", "topDirLikePrefix: appends /% so 'bible/kt' ≠ 'bible/kthing'");
assert(topDirLikePrefix("translate") === "translate/%", "topDirLikePrefix: ta manual");

// --- Step label is git-ref-safe (slashes → dashes) ---
assert(articleStepLabel("tw", "bible/kt") === "tw-bible-kt", "articleStepLabel: tw dir → 'tw-bible-kt'");
assert(articleStepLabel("ta", "translate") === "ta-translate", "articleStepLabel: ta manual → 'ta-translate'");

// --- Shared shrink guard (backs both exportTsvShrinkRefused and the article guard) ---
assert(!shrinkRefused(500, 0), "empty target (existing 0) → never refuse (first export / growth)");
assert(!shrinkRefused(500, 480), "growth (500 vs 480) → not a shrink");
assert(!shrinkRefused(480, 500), "20-file trim (480 vs 500) → ≤25 lost, allowed");
assert(!shrinkRefused(475, 500), "25-file trim (475 vs 500) → exactly 25 lost, allowed (>25 only)");
assert(shrinkRefused(470, 500), "30-file drop (470 vs 500, 6%) → refuse (>25 lost AND >5%)");
assert(shrinkRefused(0, 500), "truncated-to-zero (0 vs 500) → refuse (the clobber signature)");
assert(!shrinkRefused(0, 25), "tiny dir (25 existing) → 25 lost ≤ 25 floor, exempt");
assert(shrinkRefused(0, 26), "just above the floor (26 existing) → refuse");

// --- git blob sha matches canonical git hashes ---
// The empty blob's well-known sha1 (`git hash-object` of an empty file).
const emptySha = await gitBlobSha("");
assert(emptySha === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", `empty blob sha (${emptySha})`);
// "hello\n" → the canonical git hash-object result.
const helloSha = await gitBlobSha("hello\n");
assert(helloSha === "ce013625030ba8dba906f756967f9e9ca394464a", `"hello\\n" blob sha (${helloSha})`);
// Determinism + sensitivity: identical content → identical sha; one byte differs → differs.
assert((await gitBlobSha("# God\n")) === (await gitBlobSha("# God\n")), "same content → same sha");
assert((await gitBlobSha("# God\n")) !== (await gitBlobSha("# god\n")), "one byte differs → sha differs");
// Multi-byte UTF-8 length is BYTE length, not code-point count (Arabic sample).
const ar = await gitBlobSha("الله\n");
assert(/^[0-9a-f]{40}$/.test(ar), `utf-8 content yields a 40-hex sha (${ar})`);

console.log("articleExport: all assertions passed");
