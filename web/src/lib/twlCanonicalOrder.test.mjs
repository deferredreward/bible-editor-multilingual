// Smoke test for the client canonicalTwlOrder — the ULT-position TWL ordering
// used to render the Words list + drop approved suggestions into the right slot.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/twlCanonicalOrder.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors twlResolve.test.mjs.
//
// PARITY: the fixtures + expected orderings below intentionally duplicate
// api/src/twlCanonicalOrder.test.mjs so the two implementations are pinned to the
// same canonical order (cross-workspace import under the strip-types runner is
// awkward). If you change one, change both. The one shape difference: the web
// buildUltSequenceMap/canonicalTwlOrder take verseObjects directly (web verse
// content is pre-parsed), so fixtures here are the verseObjects array, not a
// VerseRow.

import { canonicalTwlOrder, buildUltSequenceMap, twlSortPosition } from "./twlCanonicalOrder.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// verseObjects: each { content, text } becomes one \zaln milestone (content =
// Hebrew word) wrapping one \w word, in document order.
function ultVerseObjects(words) {
  return words.map((w) => ({
    type: "milestone",
    tag: "zaln",
    content: w.content,
    children: [{ type: "word", tag: "w", text: w.text }],
  }));
}

function twl(id, orig_words, occurrence, sort_order) {
  return { id, orig_words, occurrence, sort_order };
}

const ids = (rows) => rows.map((r) => r.id);

// ─── ULT-position ordering ───────────────────────────────────────────────────
{
  console.log("\n[ordering] rows sequenced by ULT word position");
  const vo = ultVerseObjects([
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
    { content: "ג", text: "third" },
  ]);
  // Stored out of ULT order (g/a/b) — canonical order is a, b, g.
  const rows = [twl("g", "ג", 1, 100), twl("a", "א", 1, 200), twl("b", "ב", 1, 300)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b", "g"]),
    `canonical order a,b,g (got ${JSON.stringify(ordered)})`);
}

// ─── Occurrence keying (word#1 vs word#2) ────────────────────────────────────
{
  console.log("\n[occurrence] same OrigWords disambiguated by Occurrence");
  const vo = ultVerseObjects([
    { content: "ד", text: "x" }, // ד occurrence 1 → position 0
    { content: "ד", text: "y" }, // ד occurrence 2 → position 1
  ]);
  const rows = [twl("d2", "ד", 2, 100), twl("d1", "ד", 1, 200)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["d1", "d2"]),
    `ד#1 before ד#2 (got ${JSON.stringify(ordered)})`);

  const map = buildUltSequenceMap(vo);
  assert(twlSortPosition({ orig_words: "ד", occurrence: 1 }, map) === 0, "ד#1 → index 0");
  assert(twlSortPosition({ orig_words: "ד", occurrence: 2 }, map) === 1, "ד#2 → index 1");
}

// ─── Unaligned rows fall to the end, ordered by sort_order ───────────────────
{
  console.log("\n[unaligned] rows with no ULT match sink to the end by sort_order");
  const vo = ultVerseObjects([{ content: "ה", text: "h" }]);
  const rows = [
    twl("h", "ה", 1, 100),   // aligned → position 0
    twl("z1", "zz", 1, 300), // unaligned
    twl("z2", "yy", 1, 200), // unaligned, lower sort_order → before z1
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["h", "z2", "z1"]),
    `aligned first, then unaligned by sort_order (got ${JSON.stringify(ordered)})`);
}

// ─── Already-canonical input is stable ───────────────────────────────────────
{
  console.log("\n[stable] already-ordered rows keep their order");
  const vo = ultVerseObjects([
    { content: "א", text: "first" },
    { content: "ב", text: "second" },
  ]);
  const rows = [twl("a", "א", 1, 100), twl("b", "ב", 1, 200)];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b"]),
    `stable a,b (got ${JSON.stringify(ordered)})`);
  // Input not mutated.
  assert(JSON.stringify(ids(rows)) === JSON.stringify(["a", "b"]), "input array not mutated");
}

// ─── Null / missing ULT → falls back to sort_order ───────────────────────────
{
  console.log("\n[fallback] no ULT verse → order by sort_order");
  const rows = [twl("b", "ב", 1, 200), twl("a", "א", 1, 100)];
  const ordered = ids(canonicalTwlOrder(rows, null));
  assert(JSON.stringify(ordered) === JSON.stringify(["a", "b"]),
    `sort_order fallback a,b (got ${JSON.stringify(ordered)})`);
}

// ─── Nested alignment: OUTER milestone word resolves (ZEC 3:1 "high priest") ──
// The English words sit under the inner milestone; recording only the innermost
// left the outer word unresolved → sunk to the end. Now every stack level is
// recorded, so the outer word resolves to its span's first English index.
{
  console.log("\n[nested] OUTER word of a nested alignment resolves (not sunk to end)");
  const vo = [
    { type: "milestone", tag: "zaln", content: "ראשון", children: [{ type: "word", tag: "w", text: "joshua" }] },
    {
      type: "milestone", tag: "zaln", content: "חיצון", // OUTER — no direct \w
      children: [
        {
          type: "milestone", tag: "zaln", content: "פנימי", // INNER
          children: [
            { type: "word", tag: "w", text: "high" },
            { type: "word", tag: "w", text: "priest" },
          ],
        },
      ],
    },
    { type: "milestone", tag: "zaln", content: "אחרון", children: [{ type: "word", tag: "w", text: "standing" }] },
  ];
  const rows = [
    twl("first", "ראשון", 1, 100),
    twl("inner", "פנימי", 1, 200),
    twl("outer", "חיצון", 1, 300),
    twl("last", "אחרון", 1, 400),
  ];
  const ordered = ids(canonicalTwlOrder(rows, vo));
  assert(JSON.stringify(ordered) === JSON.stringify(["first", "inner", "outer", "last"]),
    `outer resolves before last (got ${JSON.stringify(ordered)})`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll twlCanonicalOrder (web) tests passed.");
