// Smoke test for computeTwlSortOrderUpdates / orderTwlRows — the canonical
// (ULT-position) TWL ordering shared by the nightly export and the reimport
// post-pass. Run from api/:
//   node --experimental-strip-types --no-warnings src/twlCanonicalOrder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs /
// reimportClassify.test.mjs.

import { computeTwlSortOrderUpdates, orderTwlRows } from "./twlCanonicalOrder.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Build a minimal ULT VerseRow whose \zaln milestones (content = Hebrew word)
// wrap \w words in document order. `words` is an array of { content, text }
// entries — each becomes one zaln milestone wrapping one \w word, in order.
function ultVerse(chapter, verse, words) {
  const verseObjects = words.map((w) => ({
    type: "milestone",
    tag: "zaln",
    content: w.content,
    children: [{ type: "word", tag: "w", text: w.text }],
  }));
  return {
    book: "GEN",
    chapter,
    verse,
    verse_end: null,
    bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_by: null,
    updated_at: 0,
  };
}

function twl(id, chapter, verse, orig_words, occurrence, sort_order) {
  return {
    id,
    book: "GEN",
    chapter,
    verse,
    ref_raw: `${chapter}:${verse}`,
    tags: null,
    orig_words,
    occurrence,
    tw_link: `rc://en/tw/dict/bible/kt/${id}`,
    sort_order,
    version: 1,
    restored_from_version: null,
    updated_by: null,
    updated_at: 0,
    deleted_at: null,
  };
}

// Turn the updates array into a { id: sort_order } map for order-insensitive
// comparison (the array order is an implementation detail).
function toMap(updates) {
  const m = {};
  for (const u of updates) m[u.id] = u.sort_order;
  return m;
}

// ─── ULT-position ordering ───────────────────────────────────────────────────
{
  console.log("\n[ordering] rows sequenced by ULT word position");
  const verse = ultVerse(1, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Rows stored out of ULT order (g/a/b) — canonical order is a, b, c.
  const rows = [
    twl("g", 1, 1, "ג", 1, 100),
    twl("a", 1, 1, "א", 1, 200),
    twl("b", 1, 1, "ב", 1, 300),
  ];
  const { referenceOrdered, versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("a") === 0, "א → canonical index 0");
  assert(versePositions.get("b") === 1, "ב → canonical index 1");
  assert(versePositions.get("g") === 2, "ג → canonical index 2");
  assert(referenceOrdered.length === 3, "all rows retained");

  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ a: 100, b: 200, g: 300 }),
    `updates canonicalize to a:100,b:200,g:300 (got ${JSON.stringify(updates)})`);
}

// ─── Occurrence keying (word#1 vs word#2) ────────────────────────────────────
{
  console.log("\n[occurrence] same OrigWords disambiguated by Occurrence");
  const verse = ultVerse(1, 2, [
    { content: "ד", text: "x" }, // ד occurrence 1 → position 0
    { content: "ד", text: "y" }, // ד occurrence 2 → position 1
  ]);
  // Stored reversed: occurrence 2 before occurrence 1.
  const rows = [
    twl("d2", 1, 2, "ד", 2, 100),
    twl("d1", 1, 2, "ד", 1, 200),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("d1") === 0, "ד#1 → index 0 (before ד#2)");
  assert(versePositions.get("d2") === 1, "ד#2 → index 1");

  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ d1: 100, d2: 200 }),
    `updates put ד#1 first (got ${JSON.stringify(updates)})`);
}

// ─── Unaligned rows fall to the end, ordered by sort_order ───────────────────
{
  console.log("\n[unaligned] rows with no ULT match sink to the end by sort_order");
  const verse = ultVerse(1, 3, [{ content: "ה", text: "h" }]);
  const rows = [
    twl("h", 1, 3, "ה", 1, 100),   // aligned → position 0
    twl("z1", 1, 3, "zz", 1, 300), // unaligned
    twl("z2", 1, 3, "yy", 1, 200), // unaligned, lower sort_order → before z1
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("h") === 0, "aligned row first");
  assert(versePositions.get("z2") === 1, "unaligned lower sort_order next");
  assert(versePositions.get("z1") === 2, "unaligned higher sort_order last");
}

// ─── No-op when rows are already canonical ───────────────────────────────────
{
  console.log("\n[noop] already-canonical rows produce no updates");
  const verse = ultVerse(1, 1, [
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
  ]);
  const rows = [
    twl("a", 1, 1, "א", 1, 100),
    twl("b", 1, 1, "ב", 1, 200),
  ];
  const updates = computeTwlSortOrderUpdates(rows, [verse]);
  assert(updates.length === 0, `no updates (got ${JSON.stringify(updates)})`);
}

// ─── Reimport-path proof: content-identical but misordered → canonical diff ──
// The row loop preserves a content-identical row's local sort_order, so only
// this post-pass can adopt canonical order. Prove it emits the fixing diff.
{
  console.log("\n[reimport] content-identical-but-misordered rows get canonicalized");
  const verse = ultVerse(2, 5, [
    { content: "ראשון", text: "one" },   // position 0
    { content: "שני", text: "two" },     // position 1
    { content: "שלישי", text: "three" }, // position 2
  ]);
  // Master/D1 content identical, but sort_order is scrambled (200/300/100).
  const rows = [
    twl("r1", 2, 5, "ראשון", 1, 200),
    twl("r2", 2, 5, "שני", 1, 300),
    twl("r3", 2, 5, "שלישי", 1, 100),
  ];
  const updates = toMap(computeTwlSortOrderUpdates(rows, [verse]));
  assert(JSON.stringify(updates) === JSON.stringify({ r1: 100, r2: 200, r3: 300 }),
    `canonical diff r1:100,r2:200,r3:300 (got ${JSON.stringify(updates)})`);
}

// ─── Nested alignment: OUTER milestone word resolves (ZEC 3:1 "high priest") ──
// A TWL link can point at the OUTER word of a nested Hebrew→English alignment
// (הַכֹּהֵן wrapping הַגָּדוֹל, "high priest"). The English words sit under the
// inner milestone, so recording only the innermost left the outer word with no
// position → it sank to the end. buildUltSequenceMap now records every stack
// level, so the outer word resolves to the first English index of its span.
{
  console.log("\n[nested] a TWL link on the OUTER word of a nested alignment resolves");
  const verseObjects = [
    { type: "milestone", tag: "zaln", content: "ראשון", children: [{ type: "word", tag: "w", text: "joshua" }] },
    {
      type: "milestone", tag: "zaln", content: "חיצון", // OUTER — no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "פנימי", // INNER — wraps the English words
          children: [
            { type: "word", tag: "w", text: "high" },
            { type: "word", tag: "w", text: "priest" },
          ],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "אחרון", children: [{ type: "word", tag: "w", text: "standing" }] },
  ];
  const verse = {
    book: "GEN", chapter: 3, verse: 1, verse_end: null, bible_version: "ULT",
    content_json: JSON.stringify({ verseObjects }), plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
  const rows = [
    twl("first", 3, 1, "ראשון", 1, 100),
    twl("inner", 3, 1, "פנימי", 1, 200),
    twl("outer", 3, 1, "חיצון", 1, 300), // the "high priest" analog
    twl("last", 3, 1, "אחרון", 1, 400),
  ];
  const { versePositions } = orderTwlRows(rows, [verse]);
  assert(versePositions.get("first") === 0, "first word → index 0");
  assert(versePositions.get("inner") === 1, "inner nested word → index 1");
  assert(versePositions.get("outer") === 2, "OUTER nested word → index 2 (resolved, NOT sunk to end)");
  assert(versePositions.get("last") === 3, "last word → index 3");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll twlCanonicalOrder tests passed.");
