// Pure, framework-free core for the per-user work-mode toggle (PR C). No
// React, no api.ts, no DOM — kept dependency-free so it's directly
// unit-testable under the plain node --test / strip-types runner without
// dragging in the whole sync/api.ts import graph. useWorkMode.ts wraps this
// in the React hook + module-level cache.

export type WorkMode = "translate" | "author";
export type StoredWorkMode = WorkMode | null;

export interface WorkModeCacheEntry {
  userId: number;
  mode: StoredWorkMode;
  // Monotonic per-userId sequence. Bumped on every optimistic set so a stale
  // (older) PUT failure arriving after a newer successful set can recognize
  // it's stale and skip the rollback — see reconcileFailure.
  seq: number;
  // Session generation. Bumped on every seed (sign-in) — see seedWorkMode.
  // seq alone is unsafe across sign-out/sign-in because seedWorkMode resets
  // seq to 0, so the SAME user re-logging-in quickly would collide at seq 1
  // with an old session's in-flight failure. epoch changes on every session,
  // so a failure captured in a prior session never matches the current one.
  epoch: number;
}

// Effective mode shown/enforced across the app. Defaults are byte-identical
// to pre-PR-C behavior: a non-translation project (translationSource == null)
// is always "author" (today's non-translation UI, unchanged); a translation
// project with no stored preference defaults to "translate" (today's only
// mode for such projects).
export function effectiveMode(stored: StoredWorkMode, translationSource: unknown): WorkMode {
  if (translationSource == null) return "author";
  return stored ?? "translate";
}

export interface OptimisticSetResult {
  next: WorkModeCacheEntry;
  prevMode: StoredWorkMode;
  seq: number;
}

// Compute the optimistic next cache state for a `setWorkMode(mode)` call,
// without performing the PUT or touching any shared cache.
export function applyOptimisticSet(state: WorkModeCacheEntry, mode: WorkMode): OptimisticSetResult {
  const seq = state.seq + 1;
  return { next: { userId: state.userId, mode, seq, epoch: state.epoch }, prevMode: state.mode, seq };
}

// Given the CURRENT cache entry, a failed request's captured seq, and the
// value to roll back to, return the entry that should be published. If a
// newer set has already superseded this request (current.seq !== failedSeq),
// the failure is stale — return `current` unchanged so it doesn't clobber a
// later successful set.
export function reconcileFailure(
  current: WorkModeCacheEntry,
  failedSeq: number,
  prevMode: StoredWorkMode,
): WorkModeCacheEntry {
  if (current.seq !== failedSeq) return current;
  return { userId: current.userId, mode: prevMode, seq: current.seq, epoch: current.epoch };
}

// Session-AWARE rollback for the React wrapper. A failed PUT is only ours to
// roll back if the cache still belongs to the same session generation (epoch)
// AND user AND the set hasn't been superseded (seq). epoch is the load-bearing
// guard: seq resets to 0 on every seed, so without epoch a quick sign-out/in
// — even as the SAME user — would collide at seq 1 with a prior session's
// in-flight failure. If epoch/user don't match (a different session or user is
// now cached, or the cache is gone), the failure is stale — return unchanged
// with rolledBack=false so the wrapper neither publishes nor shows the banner.
export function reconcileFailureForUser(
  current: WorkModeCacheEntry | null,
  capturedEpoch: number,
  capturedUserId: number,
  failedSeq: number,
  prevMode: StoredWorkMode,
): { entry: WorkModeCacheEntry | null; rolledBack: boolean } {
  if (!current || current.epoch !== capturedEpoch || current.userId !== capturedUserId) {
    return { entry: current, rolledBack: false };
  }
  const entry = reconcileFailure(current, failedSeq, prevMode);
  // reconcileFailure returns the SAME ref when seq didn't match (superseded by
  // a newer set) and a NEW object when it rolled back — so identity tells us
  // whether a rollback actually happened.
  return { entry, rolledBack: entry !== current };
}
