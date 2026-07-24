// Unit tests for the open-endpoint bulk-key caps (PR: open-endpoint-limits).
// /api/lexicon and /api/align/suggest are unauthenticated reads where each key
// fans out to a D1 query chunk, so an unbounded list lets one request trigger
// hundreds of subrequests. The cap rejects an over-long list BEFORE any DB
// access — each test wires a DB stub that THROWS if used, proving the guard
// short-circuits first. Runs under the strip-types + node:test glob runner.
//
// (The verses.ts numeric-ref guard from the same PR can't be unit-tested here:
// verses.ts has extensionless value imports that the Worker bundler resolves
// but node --test does not. lexicon/align import only Hono + a type-only Env,
// so they load standalone. The verses guard is a Number.isFinite check covered
// by tsc + the existing route behavior.)
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/openEndpointLimits.test.mjs

import { lexicon, MAX_STRONGS } from "./lexicon.ts";
import { align, MAX_ALIGN_KEYS } from "./align.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A DB that fails the test if any query runs — the reject paths must return
// before reaching it.
const explodingDb = {
  prepare() {
    throw new Error("DB was queried on a path that should have rejected first");
  },
};
const env = { DB: explodingDb };

console.log("[lexicon] bulk ?strongs cap");
{
  const overList = Array.from({ length: MAX_STRONGS + 1 }, (_v, i) => `H${i + 1}`).join(",");
  const res = await lexicon.request(`/?strongs=${overList}`, {}, env);
  assert(res.status === 400, `over-cap (${MAX_STRONGS + 1}) → 400 before any DB hit`);
  const body = await res.json();
  assert(body.error === "too_many_keys" && body.max === MAX_STRONGS, "error names the cap");

  // Empty list is the documented no-op — returns [] without touching the DB.
  const empty = await lexicon.request(`/?strongs=`, {}, env);
  assert(empty.status === 200 && (await empty.json()).entries.length === 0, "empty list → 200 []");
}

console.log("[align] /suggest keys cap");
{
  const overKeys = Array.from({ length: MAX_ALIGN_KEYS + 1 }, (_v, i) => `H${i + 1}`).join(";");
  const res = await align.request(`/suggest?keys=${overKeys}`, {}, env);
  assert(res.status === 400, `over-cap (${MAX_ALIGN_KEYS + 1}) → 400 before any DB hit`);
  const body = await res.json();
  assert(body.error === "too_many_keys" && body.max === MAX_ALIGN_KEYS, "error names the cap");

  const empty = await align.request(`/suggest`, {}, env);
  assert(empty.status === 200, "no keys → 200 (empty suggestions)");
}

console.log("openEndpointLimits: all assertions passed");
