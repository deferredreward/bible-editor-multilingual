// Smoke test for noteQueueSeek.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteQueueSeek.test.mjs
//
// This is the arithmetic behind issue #201: seeking the note queue cursor to
// a deep-linked verse, both on initial queue build and on a later same-chapter
// verse-prop change. The effect wiring around it (useEffect/useRef, cursor
// state) has no automated coverage — this repo's test runner is plain node
// `--experimental-strip-types` with no jsdom/@testing-library, so a real
// React render/interaction test isn't feasible here (see replace.test.mjs
// and friends: every unit-tested module in this repo is pure logic, not a
// component). This file covers the one pure piece that logic reduces to.

import { seekIndex } from "./noteQueueSeek.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Empty queue → no seek target at all.
assert(seekIndex([], 5) === null, "empty queue -> null");

// Exact match lands on it.
assert(seekIndex([1, 3, 5, 9], 5) === 2, "exact match lands on that entry");

// No exact match: first entry >= target.
assert(seekIndex([1, 3, 5, 9], 4) === 2, "no exact match -> first entry at or after target");

// Target before the first entry: lands on index 0, not skipped.
assert(seekIndex([3, 5, 9], 1) === 0, "target before first entry -> index 0");

// Target past the last entry: clamps to the last index rather than falling
// back to 0 (issue #201's "past the last note" case — RUT 1:9 when the last
// note is on verse 7 should land on the last card, not jump to the top).
assert(seekIndex([1, 3, 5], 9) === 2, "target past last entry -> clamps to last index");

// Single-entry queue, both directions.
assert(seekIndex([4], 4) === 0, "single entry, exact match");
assert(seekIndex([4], 1) === 0, "single entry, target before it");
assert(seekIndex([4], 9) === 0, "single entry, target after it -> still index 0");

// Duplicate verses (a chapter can have multiple notes on the same verse):
// lands on the first of the run, same as ordered.findIndex would.
assert(seekIndex([2, 2, 2, 5], 2) === 0, "duplicate verses -> first of the run");

console.log(failed === 0 ? "noteQueueSeek.test.mjs: all assertions passed" : `${failed} failures`);
if (failed > 0) process.exit(1);
