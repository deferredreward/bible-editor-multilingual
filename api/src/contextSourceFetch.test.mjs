// Tests for fetchEnSourceMaps (contextSourceFetch.ts) partial-source handling: a
// translationSource that omits tn/tq (blank in Setup) must be SKIPPED (empty map)
// and the OTHER, sourced resources still fetched — the whole context export must
// NOT fail just because one resource is sourceless. Only genuine fetch failures /
// truncation hard-fail. A sourceless resource is NEVER fetched as
// `${org}/undefined/...`.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/contextSourceFetch.test.mjs

import { fetchEnSourceMaps } from "./contextSourceFetch.ts";
import { sourceRowKey } from "./contextExport.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const ENV = { DCS_BASE_URL: "https://git.door43.org" };

const TQ_TSV =
  "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n" +
  "1:1\tq1\t\t\t\tWho made it?\tGod made it.\n";
const TN_TSV =
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
  "1:1\tn1\t\tfigs-metaphor\t\t\tThis is a metaphor.\n";

// A recording global fetch. `files` maps an in-repo path suffix → TSV text; any
// URL not matching returns 404. Records every requested URL so the test can
// assert a skipped resource is NEVER fetched (and no `${org}/undefined` URL).
let seenUrls = [];
function stubFetch(files) {
  seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    for (const [suffix, text] of Object.entries(files)) {
      if (String(url).endsWith(suffix)) {
        const bytes = new TextEncoder().encode(text);
        return new Response(text, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        });
      }
    }
    return new Response("", { status: 404 });
  };
}

const realFetch = globalThis.fetch;

const tnRows = [{ book: "TIT", id: "n1" }];
const tqRows = [{ book: "TIT", id: "q1" }];

try {
  console.log("[fetchEnSourceMaps] no translationSource → no_translation_source");
  {
    stubFetch({});
    const r = await fetchEnSourceMaps(ENV, { translationSource: null }, tnRows, tqRows);
    assert(!r.ok && r.reason === "no_translation_source", "null source → no_translation_source");
    assert(seenUrls.length === 0, "no fetch attempted");
  }

  console.log("[fetchEnSourceMaps] tn blank + tq present → tn SKIPPED, tq fetched, ok");
  {
    stubFetch({ "tq_TIT.tsv": TQ_TSV });
    const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tq: "en_tq" } } };
    const r = await fetchEnSourceMaps(ENV, cfg, tnRows, tqRows);
    assert(r.ok, "ok (sourceless tn does NOT fail the whole fetch)");
    assert(r.ok && r.skipped.length === 1 && r.skipped[0] === "tn", "skipped = ['tn']");
    assert(r.ok && r.sources.tn.size === 0, "tn map empty (skipped)");
    assert(r.ok && r.sources.tq.get(sourceRowKey("TIT", "q1")) != null, "tq map populated from en_tq");
    assert(!seenUrls.some((u) => /undefined/.test(u)), "no fetch URL contains 'undefined'");
    assert(!seenUrls.some((u) => /tn_TIT\.tsv/.test(u)), "sourceless tn never fetched");
    assert(seenUrls.some((u) => /en_tq\/.*tq_TIT\.tsv/.test(u)), "sourced tq WAS fetched");
  }

  console.log("[fetchEnSourceMaps] tq blank + tn present → tq SKIPPED, tn fetched, ok");
  {
    stubFetch({ "tn_TIT.tsv": TN_TSV });
    const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn" } } };
    const r = await fetchEnSourceMaps(ENV, cfg, tnRows, tqRows);
    assert(r.ok && r.skipped[0] === "tq", "skipped = ['tq']");
    assert(r.ok && r.sources.tn.get(sourceRowKey("TIT", "n1")) != null, "tn map populated");
    assert(r.ok && r.sources.tq.size === 0, "tq map empty (skipped)");
  }

  console.log("[fetchEnSourceMaps] both present → nothing skipped");
  {
    stubFetch({ "tn_TIT.tsv": TN_TSV, "tq_TIT.tsv": TQ_TSV });
    const cfg = {
      translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn", tq: "en_tq" } },
    };
    const r = await fetchEnSourceMaps(ENV, cfg, tnRows, tqRows);
    assert(r.ok && r.skipped.length === 0, "nothing skipped when both sourced");
    assert(r.ok && r.sources.tn.size === 1 && r.sources.tq.size === 1, "both maps populated");
  }

  console.log("[fetchEnSourceMaps] omitted resource with NO rows is not flagged skipped");
  {
    stubFetch({ "tq_TIT.tsv": TQ_TSV });
    // tn omitted but there are no tn rows → tn isn't needed → not skipped.
    const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tq: "en_tq" } } };
    const r = await fetchEnSourceMaps(ENV, cfg, [], tqRows);
    assert(r.ok && r.skipped.length === 0, "no tn rows → tn not flagged skipped");
    assert(r.ok && r.sources.tq.size === 1, "tq still fetched");
  }

  console.log("[fetchEnSourceMaps] genuine fetch failure on a SOURCED resource still hard-fails");
  {
    stubFetch({}); // en_tq returns 404
    const cfg = { translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tq: "en_tq" } } };
    const r = await fetchEnSourceMaps(ENV, cfg, [], tqRows);
    assert(!r.ok && /en_fetch_failed:tq/.test(r.reason), "sourced-but-404 tq → en_fetch_failed (still hard fails)");
  }

  console.log("\ncontextSourceFetch: all assertions passed");
} finally {
  globalThis.fetch = realFetch;
}
