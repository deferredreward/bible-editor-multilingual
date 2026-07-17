// Unit tests for workModeCore.ts — the pure affordance-matrix default
// (effectiveMode) and the optimistic-set/rollback sequencing used by
// useWorkMode.ts. No React, no api.ts, no DOM. Run from web/:
//   node --experimental-strip-types --no-warnings src/hooks/workModeCore.test.mjs

import {
  effectiveMode,
  applyOptimisticSet,
  reconcileFailure,
  reconcileFailureForUser,
} from "./workModeCore.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── effectiveMode: the affordance-matrix default formula ────────────────────

console.log("[effectiveMode] translationSource == null is always author (byte-identical default)");
{
  assert(effectiveMode(null, null) === "author", "no stored pref, no source → author");
  assert(effectiveMode(undefined, null) === "author", "undefined stored pref, no source → author");
  assert(effectiveMode("translate", null) === "author", "stored translate ignored when no source");
  assert(effectiveMode("author", null) === "author", "stored author + no source → author");
}

console.log("[effectiveMode] translationSource present: stored ?? translate");
{
  const src = { org: "unfoldingWord" };
  assert(effectiveMode(null, src) === "translate", "no stored pref + source → translate (today's default)");
  assert(effectiveMode(undefined, src) === "translate", "undefined stored pref + source → translate");
  assert(effectiveMode("translate", src) === "translate", "stored translate + source → translate");
  assert(effectiveMode("author", src) === "author", "stored author + source → author");
}

// ── applyOptimisticSet / reconcileFailure: rollback sequencing ─────────────

console.log("[applyOptimisticSet] bumps seq, captures prior mode as prevMode");
{
  const state = { userId: 1, mode: null, seq: 0 };
  const r1 = applyOptimisticSet(state, "author");
  assert(r1.next.mode === "author" && r1.next.seq === 1, "first set: mode=author, seq=1");
  assert(r1.prevMode === null, "prevMode captures the state before this set");
  assert(r1.seq === 1, "returned seq matches next.seq");

  const r2 = applyOptimisticSet(r1.next, "translate");
  assert(r2.next.mode === "translate" && r2.next.seq === 2, "second set: mode=translate, seq=2");
  assert(r2.prevMode === "author", "prevMode is the mode from the first set");
}

console.log("[reconcileFailure] a stale (superseded) failure does not clobber a newer set");
{
  // Simulate: set(author) [seq=1] fails AFTER set(translate) [seq=2] already
  // landed. The failure for seq=1 must not roll back the seq=2 state.
  const initial = { userId: 1, mode: null, seq: 0 };
  const first = applyOptimisticSet(initial, "author"); // optimistic seq=1, prevMode=null
  const second = applyOptimisticSet(first.next, "translate"); // optimistic seq=2, prevMode="author"

  // second.next is now "current" cache state (seq=2, mode=translate) by the
  // time the FIRST request's failure callback runs.
  const afterStaleFailure = reconcileFailure(second.next, first.seq, first.prevMode);
  assert(
    afterStaleFailure.mode === "translate" && afterStaleFailure.seq === 2,
    "stale seq=1 failure leaves the newer seq=2 state (mode=translate) untouched",
  );
}

console.log("[reconcileFailure] a non-superseded failure rolls back to prevMode");
{
  const initial = { userId: 1, mode: "translate", seq: 0 };
  const set1 = applyOptimisticSet(initial, "author"); // seq=1, prevMode="translate"
  // No newer set has happened — cache is still exactly set1.next.
  const afterFailure = reconcileFailure(set1.next, set1.seq, set1.prevMode);
  assert(
    afterFailure.mode === "translate" && afterFailure.seq === 1,
    "non-superseded failure rolls back to the pre-request mode, keeping seq stable",
  );
}

console.log("[reconcileFailure] different userId (cache moved on) is untouched regardless of seq");
{
  const state = { userId: 2, mode: "author", seq: 5 };
  // A failure captured against userId 1's seq=5 must not roll back a
  // different user's cache entry that happens to share the same seq value.
  const result = reconcileFailure(state, 5, "translate");
  // seq matches, so per the pure seq-only contract this WOULD roll back —
  // documenting that callers (useWorkMode) are responsible for discarding a
  // stale request's failure handler entirely once clearWorkMode()/reseed has
  // run for a different user (cache identity, not just seq, changes then).
  assert(result.mode === "translate", "seq-only reconciliation rolls back when seq matches (by design)");
}

console.log("[reconcileFailureForUser] a stale failure from a PRIOR user does NOT clobber the current user");
{
  // User A toggled (captured userId=1, seq=1), then signed out and user B
  // signed in and toggled — cache is now {userId:2, seq:1} (seedWorkMode resets
  // seq to 0, B's first toggle brings it to 1, colliding with A's captured seq).
  const cacheNowUserB = { userId: 2, mode: "author", seq: 1 };
  const { entry, rolledBack } = reconcileFailureForUser(cacheNowUserB, /*capturedUserId A*/ 1, 1, "translate");
  assert(rolledBack === false, "cross-user stale failure is discarded (rolledBack=false)");
  assert(entry === cacheNowUserB, "current user's cache entry is returned untouched");
}

console.log("[reconcileFailureForUser] same-user, non-superseded failure rolls back");
{
  const initial = { userId: 7, mode: "translate", seq: 0 };
  const set1 = applyOptimisticSet(initial, "author"); // seq=1
  const { entry, rolledBack } = reconcileFailureForUser(set1.next, 7, set1.seq, set1.prevMode);
  assert(rolledBack === true, "same-user, seq-matching failure rolls back");
  assert(entry.mode === "translate" && entry.seq === 1, "rolled back to pre-request mode, seq stable");
}

console.log("[reconcileFailureForUser] same-user but superseded by a newer set is NOT rolled back");
{
  const initial = { userId: 7, mode: "translate", seq: 0 };
  const set1 = applyOptimisticSet(initial, "author"); // captured seq=1
  const set2 = applyOptimisticSet(set1.next, "translate"); // newer set, seq=2
  const { entry, rolledBack } = reconcileFailureForUser(set2.next, 7, set1.seq, set1.prevMode);
  assert(rolledBack === false, "superseded (seq mismatch) failure is discarded");
  assert(entry === set2.next, "the newer set survives untouched");
}

console.log("[reconcileFailureForUser] no cache (signed out) is a no-op");
{
  const { entry, rolledBack } = reconcileFailureForUser(null, 1, 1, "translate");
  assert(rolledBack === false && entry === null, "null cache → no-op");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("workModeCore: all assertions passed");
