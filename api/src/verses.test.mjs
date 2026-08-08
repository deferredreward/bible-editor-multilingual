// Unit tests for verses.ts's buildPatchSchema — the per-verse content
// validation used by PATCH /api/verses/:book/:chapter/:verse/:bibleVersion.
// Pins the verse-0 ("chapter-front" pseudo-verse) carve-out added for
// issue #154 §1 (upstream PR #369): headings/Psalm titles live in verse 0
// and must be deletable to empty, while ordinary verses (verse >= 1) must
// still refuse to be saved with zero verse-objects. Run from api/:
//   node --experimental-strip-types --no-warnings src/verses.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { buildPatchSchema } from "./verses.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const emptyBody = { content: { verseObjects: [] } };
const nonEmptyBody = { content: { verseObjects: [{ type: "text", text: "hello" }] } };

// --- verse 0 (chapter-front pseudo-verse): empty content is a heading delete, allowed ---
{
  const schema = buildPatchSchema(0);
  assert(schema.safeParse(emptyBody).success, "verse 0 accepts an emptied verseObjects array (heading deleted)");
  assert(schema.safeParse(nonEmptyBody).success, "verse 0 still accepts a populated verseObjects array");
}

// --- ordinary verses (1+): empty content is still rejected ---
for (const verse of [1, 2, 176]) {
  const schema = buildPatchSchema(verse);
  assert(!schema.safeParse(emptyBody).success, `verse ${verse} rejects an emptied verseObjects array`);
  assert(schema.safeParse(nonEmptyBody).success, `verse ${verse} accepts a populated verseObjects array`);
}

// --- shape checks unaffected by the min-length change ---
{
  const schema = buildPatchSchema(1);
  assert(!schema.safeParse({}).success, "missing content is still rejected");
  assert(!schema.safeParse({ content: {} }).success, "missing verseObjects is still rejected");
  assert(
    schema.safeParse({ content: { verseObjects: [{}] }, plain_text: "x", alignment_intent: "text_edit" }).success,
    "optional plain_text/alignment_intent still accepted",
  );
  assert(
    !schema.safeParse({ content: { verseObjects: [{}] }, plain_text: null }).success,
    "explicit null plain_text is still rejected (would silently mean 'keep' via COALESCE)",
  );
}

console.log("verses.test.mjs: all assertions passed");
