// Unit tests for twArticle.ts — TW id/link parsing and DCS URL building.
// tw_link is a shared, editor-writable TWL row field, so parseTwId is a
// security boundary: a crafted value must not steer the built git.door43.org
// URL to a different path than the dialog labels it as.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/twArticle.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { parseTwId, twShort, twArticleDcsUrl, twArticleRawUrl } from "./twArticle.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log("[parseTwId] accepts real id and rc-link shapes");
{
  const fromRc = parseTwId("rc://*/tw/dict/bible/names/moab");
  assert(fromRc && fromRc.cat === "names" && fromRc.art === "moab", "rc:// link parsed");
  const bare = parseTwId("kt/god");
  assert(bare && bare.cat === "kt" && bare.art === "god", "bare cat/art id parsed");
  const withMd = parseTwId("kt/call-speakloudly.md");
  assert(withMd && withMd.art === "call-speakloudly", ".md suffix stripped, hyphens allowed");
  assert(twShort("rc://*/tw/dict/bible/kt/god") === "kt/god", "twShort collapses to cat/art");
}

console.log("[parseTwId] rejects path-steering segments");
{
  assert(parseTwId("rc://*/tw/dict/bible/../secrets") === null, "dot-dot cat rejected");
  assert(parseTwId("bible/..%2F..%2Fother/x") === null, "percent-encoded slash rejected");
  assert(parseTwId("kt/god?raw=1") === null, "query string rejected");
  assert(parseTwId("kt/god#frag") === null, "fragment rejected");
  assert(parseTwId(null) === null && parseTwId("") === null, "empty input rejected");
}

console.log("[twArticleDcsUrl/RawUrl] pinned host and shape");
{
  const dcs = twArticleDcsUrl("kt/god");
  const raw = twArticleRawUrl("rc://*/tw/dict/bible/names/moab");
  assert(dcs === "https://git.door43.org/unfoldingWord/en_tw/src/branch/master/bible/kt/god.md", "DCS preview URL exact");
  assert(raw === "https://git.door43.org/unfoldingWord/en_tw/raw/branch/master/bible/names/moab.md", "raw URL exact");
  assert(twArticleDcsUrl("bad input with spaces") === "", "unparseable id yields empty string, not a URL");
}

console.log("twArticle: all assertions passed");
