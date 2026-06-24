// Unit tests for fetchText (dcsSources.ts) — the truncated-fetch transport
// guard. Stubs global fetch with crafted responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { fetchText } from "./dcsSources.ts";

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
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});
