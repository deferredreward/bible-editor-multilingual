// Tests for fetchEnSourceMaps (contextSourceFetch.ts) partial-source guard: a
// translationSource that omits tn/tq (blank in Setup) must be reported with a
// DISTINCT `no_source_configured:<res>` reason and NEVER fetched as
// `${org}/undefined/...` — so a legitimately sourceless resource isn't
// conflated with a transient en_fetch_failed.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/contextSourceFetch.test.mjs

import { fetchEnSourceMaps } from "./contextSourceFetch.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A fetch that throws if ever called — proves the guard short-circuits BEFORE
// building a `${org}/undefined` URL.
let fetchCalls = 0;
const throwingEnv = {
  DCS_BASE_URL: "https://git.door43.org",
};
// contextSourceFetch imports fetchText from dcsSources; stub globalThis.fetch so
// any accidental network attempt is observable.
globalThis.fetch = async (url) => {
  fetchCalls++;
  return new Response("", { status: 200, headers: { "content-length": "0" } });
};

const tnRows = [{ book: "TIT", id: "n1" }];
const tqRows = [{ book: "TIT", id: "q1" }];

console.log("[fetchEnSourceMaps] no translationSource → no_translation_source");
{
  const r = await fetchEnSourceMaps(throwingEnv, { translationSource: null }, tnRows, tqRows);
  assert(!r.ok && r.reason === "no_translation_source", "null source → no_translation_source");
}

console.log("[fetchEnSourceMaps] partial source omitting tn → no_source_configured:tn (no fetch)");
{
  fetchCalls = 0;
  const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tq: "en_tq" } } };
  const r = await fetchEnSourceMaps(throwingEnv, cfg, tnRows, tqRows);
  assert(!r.ok && r.reason === "no_source_configured:tn", "missing tn repo → no_source_configured:tn");
  assert(fetchCalls === 0, "guard returns BEFORE any fetch (no undefined URL built)");
}

console.log("[fetchEnSourceMaps] partial source omitting tq (but tn present) → no_source_configured:tq");
{
  const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn" } } };
  const r = await fetchEnSourceMaps(throwingEnv, cfg, tnRows, tqRows);
  assert(!r.ok && r.reason === "no_source_configured:tq", "missing tq repo → no_source_configured:tq");
}

console.log("[fetchEnSourceMaps] omitted resource with NO rows to pair is not flagged");
{
  // tn omitted but there are no tn rows → tn isn't needed; tq present + no tq
  // rows either → nothing to fetch → ok with empty maps.
  const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tq: "en_tq" } } };
  const r = await fetchEnSourceMaps(throwingEnv, cfg, [], []);
  assert(r.ok, "no rows for the omitted resource → ok (nothing to source)");
}

console.log("\ncontextSourceFetch: all assertions passed");
