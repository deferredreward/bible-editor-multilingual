// Unit tests for verseHistory.ts — the pure verse version-history builder.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseHistory.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { buildVerseHistory } from "./verseHistory.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A minimal but valid verse-objects wrapper.
const vo = (text) => ({ verseObjects: [{ type: "text", text }] });

// edit_log row factory. `content` may be an object, a JSON string, or omitted.
let clock = 1000;
function logRow({ version, action = "update", source = null, content, plain_text }) {
  const payload = {};
  if (plain_text !== undefined) payload.plain_text = plain_text;
  if (content !== undefined) payload.content = content;
  return {
    version,
    action,
    source,
    created_at: clock++,
    payload_json: JSON.stringify(payload),
    user_id: null,
    username: null,
    full_name: null,
  };
}

// --- 1. Unedited verse (no log rows) → single synthetic "imported" current ---
{
  const out = buildVerseHistory([], {
    version: 1,
    content: vo("In the beginning"),
    plain_text: "In the beginning",
    updated_at: 50,
  });
  assert(out.length === 1, "unedited: one version");
  assert(out[0].version === 1 && out[0].current, "unedited: v1 is current");
  assert(out[0].action === "imported", "unedited: synthesized as imported");
  assert(out[0].restorable, "unedited: current is restorable (live content)");
}

// --- 2. Manual edits with full content → all restorable, ordered asc ---
{
  const rows = [
    logRow({ version: 2, content: vo("edit one"), plain_text: "edit one" }),
    logRow({ version: 3, content: vo("edit two"), plain_text: "edit two" }),
  ];
  const out = buildVerseHistory(rows, {
    version: 3,
    content: vo("edit two"),
    plain_text: "edit two",
    updated_at: 99,
  });
  assert(out.map((v) => v.version).join(",") === "2,3", "manual: versions 2,3 ascending");
  assert(out.every((v) => v.restorable), "manual: all restorable");
  assert(out[1].current && !out[0].current, "manual: only v3 is current");
}

// --- 3. plain_text-only entry (AI, pre-enrichment) at a historical version
//        is shown but NOT restorable ---
{
  const rows = [
    logRow({ version: 2, source: "ai_pipeline", plain_text: "ai aligned" }), // no content
    logRow({ version: 3, content: vo("human edit"), plain_text: "human edit" }),
  ];
  const out = buildVerseHistory(rows, {
    version: 3,
    content: vo("human edit"),
    plain_text: "human edit",
    updated_at: 99,
  });
  const v2 = out.find((v) => v.version === 2);
  assert(v2 && !v2.restorable, "ai plain-text-only historical: not restorable");
  assert(v2.source === "ai_pipeline", "ai entry keeps its source label");
  assert(v2.plain_text === "ai aligned", "ai entry still previews its plain text");
}

// --- 4. Current anchored with LIVE content even if its own log entry was
//        plain_text-only (a pre-enrichment AI version that is now current) ---
{
  const rows = [logRow({ version: 2, source: "ai_pipeline", plain_text: "ai now current" })];
  const out = buildVerseHistory(rows, {
    version: 2,
    content: vo("ai now current"), // live row has the real content
    plain_text: "ai now current",
    updated_at: 99,
  });
  const cur = out.find((v) => v.current);
  assert(cur && cur.version === 2 && cur.restorable, "current AI version restorable via live content");
  assert(cur.source === "ai_pipeline", "current keeps real audit source");
}

// --- 5. Two entries on one version → prefer the content-bearing one ---
{
  const rows = [
    logRow({ version: 1, source: null, content: vo("pre-ai baseline"), plain_text: "pre-ai baseline" }),
    logRow({ version: 1, source: "ai_pipeline", plain_text: "no content here" }), // same version, no content
  ];
  const out = buildVerseHistory(rows, {
    version: 2,
    content: vo("ai base"),
    plain_text: "ai base",
    updated_at: 99,
  });
  const v1 = out.find((v) => v.version === 1);
  assert(v1 && v1.restorable, "same-version collision: content-bearing entry wins");
  assert(v1.content && v1.content.verseObjects[0].text === "pre-ai baseline", "v1 keeps baseline content");
}

// --- 6. content stored as a JSON STRING (AI / re-import write path) is parsed ---
{
  const rows = [logRow({ version: 2, source: "dcs_reimport", content: JSON.stringify(vo("reimported")), plain_text: "reimported" })];
  const out = buildVerseHistory(rows, {
    version: 3,
    content: vo("after"),
    plain_text: "after",
    updated_at: 99,
  });
  const v2 = out.find((v) => v.version === 2);
  assert(v2 && v2.restorable, "string content payload normalized → restorable");
  assert(v2.content.verseObjects[0].text === "reimported", "string content parsed to object");
}

// --- 7. Future-version phantom (> current) is ignored ---
{
  const rows = [
    logRow({ version: 2, content: vo("a"), plain_text: "a" }),
    logRow({ version: 5, content: vo("phantom"), plain_text: "phantom" }), // > current
  ];
  const out = buildVerseHistory(rows, {
    version: 2,
    content: vo("a"),
    plain_text: "a",
    updated_at: 99,
  });
  assert(out.length === 1 && out[0].version === 2, "future phantom dropped");
}

// --- 8. Malformed content (not a verse-objects wrapper) → not restorable ---
{
  const rows = [logRow({ version: 2, content: { notVerseObjects: true }, plain_text: "x" })];
  const out = buildVerseHistory(rows, {
    version: 3,
    content: vo("ok"),
    plain_text: "ok",
    updated_at: 99,
  });
  const v2 = out.find((v) => v.version === 2);
  assert(v2 && !v2.restorable, "malformed content shape → not restorable");
}

// --- 9. User mapping ---
{
  const r = logRow({ version: 2, content: vo("x"), plain_text: "x" });
  r.user_id = 35;
  r.username = "beth";
  r.full_name = "Beth Oakes";
  const out = buildVerseHistory([r], {
    version: 3,
    content: vo("y"),
    plain_text: "y",
    updated_at: 99,
  });
  const v2 = out.find((v) => v.version === 2);
  assert(v2.user && v2.user.id === 35 && v2.user.full_name === "Beth Oakes", "user mapped from log row");
}

console.log("\nverseHistory.test.mjs: all assertions passed");
