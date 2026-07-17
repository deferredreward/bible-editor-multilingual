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
