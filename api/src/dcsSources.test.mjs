// Unit tests for fetchText (dcsSources.ts) — the truncated-fetch transport
// guard. Stubs global fetch with crafted responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  fetchText,
  dcsUrls,
  sourceProvenance,
  translationSourceRepoRef,
  heldOutNoteResources,
  shouldFallBackOnStatus,
} from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A minimal Response stand-in with full control over the content-length header.
function res({ ok = true, body = "", contentLength = undefined }) {
  return {
    ok,
    headers: {
      get: (k) => (k.toLowerCase() === "content-length" ? (contentLength ?? null) : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

// Queue responses; each fetch() call shifts the next one.
let queue = [];
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (queue.length === 0) throw new Error("fetch called more times than queued");
  return queue.shift();
};

// Silence the expected console.error/warn noise so the test output stays clean.
const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

async function run() {
  // 1. Body matches declared content-length → returned as-is.
  queue = [res({ body: "hello world", contentLength: "11" })];
  calls = 0;
  assert((await fetchText("u")) === "hello world", "exact content-length → body returned");
  assert(calls === 1, "  ...single fetch, no retry");

  // 2. Body shorter than declared content-length → truncated → retry, second
  //    attempt is complete → returns the complete body.
  queue = [
    res({ body: "partial", contentLength: "999" }), // truncated
    res({ body: "the whole file", contentLength: "14" }), // complete
  ];
  calls = 0;
  assert((await fetchText("u")) === "the whole file", "short-vs-declared → retry yields complete body");
  assert(calls === 2, "  ...retried exactly once");

  // 3. Truncated on BOTH attempts → null (never accept a partial body).
  queue = [
    res({ body: "partial", contentLength: "999" }),
    res({ body: "still partial", contentLength: "999" }),
  ];
  calls = 0;
  assert((await fetchText("u")) === null, "short on both attempts → null");
  assert(calls === 2, "  ...two attempts then give up");

  // 4. No content-length at all (the HAB blind spot) → body is returned (the
  //    transport layer can't verify completeness; the reimport row-count gate
  //    is the backstop). The point of this case: a missing header is NOT, by
  //    itself, treated as a transport failure — so we don't break every file
  //    served without content-length.
  queue = [res({ body: "no-length body", contentLength: undefined })];
  calls = 0;
  assert((await fetchText("u")) === "no-length body", "missing content-length → body still returned");
  assert(calls === 1, "  ...no retry on missing content-length alone");

  // 5. Non-OK response → null immediately.
  queue = [res({ ok: false, body: "404", contentLength: "3" })];
  calls = 0;
  assert((await fetchText("u")) === null, "non-ok response → null");
  assert(calls === 1, "  ...no retry on non-ok");

  // 6. Longer-than-declared body (transparent gzip decode) → accepted, NOT
  //    treated as truncation.
  queue = [res({ body: "decoded is longer", contentLength: "5" })];
  calls = 0;
  assert((await fetchText("u")) === "decoded is longer", "longer-than-declared → accepted (gzip case)");

  console.error = origError;
  console.warn = origWarn;
  console.log("dcsSources/fetchText: all assertions passed");

  runPure();
}

// ── Pure helpers: URL overrides + note-source provenance (no fetch/env/DB) ──

const ENV = { DCS_BASE_URL: "https://git.door43.org" };
const CFG = {
  org: "BSOJ",
  repos: {
    lit: "ar_avd", sim: "ar_nav", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl",
    tw: "ar_tw", ta: "ar_ta",
  },
  translationSource: {
    org: "unfoldingWord",
    languageCode: "en",
    repos: {
      lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl",
      tw: "en_tw", ta: "en_ta",
    },
  },
};

function runPure() {
  // No overrides → every URL points at the project's own org on master.
  const plain = dcsUrls(ENV, CFG, "ZEC");
  assert(plain.tn === "https://git.door43.org/BSOJ/ar_tn/raw/branch/master/tn_ZEC.tsv", "no overrides → tn from org repo");
  assert(plain.tq === "https://git.door43.org/BSOJ/ar_tq/raw/branch/master/tq_ZEC.tsv", "no overrides → tq from org repo");
  assert(plain.twl === "https://git.door43.org/BSOJ/ar_twl/raw/branch/master/twl_ZEC.tsv", "no overrides → twl from org repo");
  assert(plain.ult === "https://git.door43.org/BSOJ/ar_avd/raw/branch/master/38-ZEC.usfm", "no overrides → lit from org repo");

  // tn/tq overrides → those two URLs move to the override owner/repo/ref;
  // twl and lit/sim are untouched.
  const over = dcsUrls(ENV, CFG, "ZEC", {
    tn: { owner: "unfoldingWord", repo: "en_tn", ref: "v86" },
    tq: { owner: "unfoldingWord", repo: "en_tq", ref: "master" },
  });
  assert(over.tn === "https://git.door43.org/unfoldingWord/en_tn/raw/branch/v86/tn_ZEC.tsv", "tn override → owner/repo/ref honoured");
  assert(over.tq === "https://git.door43.org/unfoldingWord/en_tq/raw/branch/master/tq_ZEC.tsv", "tq override → owner/repo honoured");
  assert(over.twl === plain.twl, "tn/tq overrides leave twl on the org repo");
  assert(over.ult === plain.ult && over.ust === plain.ust, "tn/tq overrides leave lit/sim untouched");

  // Provenance marker + source repo refs.
  assert(sourceProvenance("unfoldingWord", "en_tn") === "source:unfoldingWord/en_tn", "sourceProvenance shape");
  const tnRef = translationSourceRepoRef(CFG, "tn");
  assert(
    tnRef.owner === "unfoldingWord" && tnRef.repo === "en_tn" && tnRef.ref === "master",
    "translationSourceRepoRef(tn) → source org + en_tn on master",
  );
  assert(translationSourceRepoRef(CFG, "tq").repo === "en_tq", "translationSourceRepoRef(tq) → en_tq");
  assert(
    translationSourceRepoRef({ ...CFG, translationSource: null }, "tn") === null,
    "no translationSource → null (authored project)",
  );

  // Held-out predicate — any non-null marker means "don't sync with the org repo".
  const setOf = (p) => [...heldOutNoteResources(p)].sort().join(",");
  assert(setOf(null) === "", "null provenance → nothing held out");
  assert(setOf(undefined) === "", "undefined provenance → nothing held out");
  assert(setOf({ tn_source: null, tq_source: null }) === "", "all-null provenance → nothing held out");
  assert(setOf({ tn_source: "aquifer:arb" }) === "tn", "aquifer tn → tn held out");
  assert(
    setOf({ tn_source: "source:unfoldingWord/en_tn", tq_source: "source:unfoldingWord/en_tq" }) === "tn,tq",
    "source-sourced tn+tq → both held out",
  );
  assert(setOf({ tq_source: "source:unfoldingWord/en_tq" }) === "tq", "source-sourced tq only → tq held out");

  // Auto-fallback trigger: ONLY a hard 404 means "the org genuinely has no such
  // file". Every transient failure must keep the import failing + retrying
  // rather than silently substituting English notes.
  assert(shouldFallBackOnStatus(404) === true, "404 → fall back to translation source");
  assert(shouldFallBackOnStatus(0) === false, "network error (status 0) → no fallback");
  assert(shouldFallBackOnStatus(500) === false, "5xx → no fallback");
  assert(shouldFallBackOnStatus(502) === false, "502 → no fallback");
  assert(shouldFallBackOnStatus(429) === false, "rate limit → no fallback");
  // A truncated read surfaces as {status:200, text:null} — must not fall back.
  assert(shouldFallBackOnStatus(200) === false, "truncated 200 → no fallback");
  assert(shouldFallBackOnStatus(403) === false, "403 (auth) → no fallback");

  console.log("dcsSources/pure helpers: all assertions passed");
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});
