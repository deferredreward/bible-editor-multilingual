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
  return { next: { userId: state.userId, mode, seq }, prevMode: state.mode, seq };
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
  return { userId: current.userId, mode: prevMode, seq: current.seq };
}

// userId-AWARE rollback for the React wrapper. `seq` alone is unsafe across a
// sign-out/sign-in: `seedWorkMode` resets every user to seq 0, so a stale
// failure from user A can collide with user B's later toggle at the same seq
// and roll B's cache back to A's mode. Guard on the userId captured when the
// request was fired: if the cache is gone or now belongs to a different user,
// the failure is not ours — return unchanged with rolledBack=false so the
// wrapper neither publishes nor shows the failure banner to the wrong user.
export function reconcileFailureForUser(
  current: WorkModeCacheEntry | null,
  capturedUserId: number,
  failedSeq: number,
  prevMode: StoredWorkMode,
): { entry: WorkModeCacheEntry | null; rolledBack: boolean } {
  if (!current || current.userId !== capturedUserId) {
    return { entry: current, rolledBack: false };
  }
  const entry = reconcileFailure(current, failedSeq, prevMode);
  // reconcileFailure returns the SAME ref when seq didn't match (superseded by
  // a newer set) and a NEW object when it rolled back — so identity tells us
  // whether a rollback actually happened.
  return { entry, rolledBack: entry !== current };
}
