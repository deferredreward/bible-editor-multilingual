import { useEffect, useState } from "react";
import { putMyPrefs, type ProjectConfig, type WorkMode } from "../sync/api";
import {
  effectiveMode,
  applyOptimisticSet,
  reconcileFailureForUser,
  type StoredWorkMode,
  type WorkModeCacheEntry,
} from "./workModeCore";

export type { StoredWorkMode } from "./workModeCore";
export { effectiveMode } from "./workModeCore";

// Per-user Translate/Author view toggle (PR C). Mirrors useProjectConfig's
// module-level cache + subscriber pattern, but keyed by userId (this is a
// per-user preference, not a shared project setting) and seeded synchronously
// from the boot MeResponse — see seedWorkMode below — so the very first
// render already has the real mode instead of defaulting to Translate and
// firing a source-language request that gets thrown away a tick later.
//
// The sequencing/rollback math itself lives in workModeCore.ts (no React, no
// api.ts) so it's directly unit-testable; this file is the thin React +
// network wrapper around it.

let cache: WorkModeCacheEntry | null = null;
// Session generation, bumped on every seed. Stamped onto the cache entry so a
// failed PUT from a prior session (which reset seq to 0) can't roll back the
// current one — see reconcileFailureForUser.
let epochCounter = 0;
const subscribers = new Set<(entry: WorkModeCacheEntry | null) => void>();

function publish(entry: WorkModeCacheEntry | null): void {
  cache = entry;
  for (const s of subscribers) s(entry);
}

// Seed the cache from a freshly-landed MeResponse. Call this synchronously
// BEFORE marking auth "ready" (see App.tsx's useAuthGate) — both the OAuth
// and dev sign-in paths land a MeResponse the same way. Always resets seq to
// 0: a fresh /me or /auth/dev response is authoritative server state, so any
// in-flight optimistic set from a previous session is moot (sign-out/sign-in
// also calls clearWorkMode, so this is mostly a defensive reset).
export function seedWorkMode(userId: number, mode: StoredWorkMode): void {
  publish({ userId, mode, seq: 0, epoch: ++epochCounter });
}

// Clear on sign-out, on landing in an unauthenticated/denied state, or
// whenever the signed-in user changes — no cross-account inheritance within
// one tab.
export function clearWorkMode(): void {
  publish(null);
}

export interface UseWorkMode {
  // Stored (raw) preference — null when no explicit choice has been made.
  // Callers combine this with the active project's translationSource via
  // effectiveMode() / effectiveModeFor() to get the mode that should
  // actually gate UI.
  workMode: StoredWorkMode;
  setWorkMode: (mode: WorkMode) => void;
  // True right after a PUT failed and the rollback fired; cleared on the next
  // successful set. Callers show a preferences.workMode.failed message.
  failed: boolean;
}

export function useWorkMode(): UseWorkMode {
  const [entry, setEntry] = useState<WorkModeCacheEntry | null>(cache);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const sub = (e: WorkModeCacheEntry | null) => setEntry(e);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  const setWorkMode = (mode: WorkMode) => {
    if (!entry) return; // not signed in yet — nothing to toggle
    const capturedUserId = entry.userId;
    const capturedEpoch = entry.epoch;
    const { next, prevMode, seq } = applyOptimisticSet(entry, mode);
    setFailed(false);
    publish(next);
    putMyPrefs(mode).catch(() => {
      // Guard on the captured epoch + userId + seq: a failure is only ours to
      // roll back if the current cache is the same session generation and user
      // and hasn't been superseded. A stale failure from a prior session (even
      // the same user re-logging-in, where seq resets to 0) must NOT clobber
      // the current cache or flash a failure banner.
      const { entry: rolled, rolledBack } = reconcileFailureForUser(
        cache,
        capturedEpoch,
        capturedUserId,
        seq,
        prevMode,
      );
      if (rolledBack) {
        publish(rolled);
        setFailed(true);
      }
    });
  };

  return { workMode: entry?.mode ?? null, setWorkMode, failed };
}

// Convenience: effective mode from the current project config's
// translationSource, so components only need one import for the common case.
export function effectiveModeFor(workMode: StoredWorkMode, cfg: ProjectConfig | null): WorkMode {
  return effectiveMode(workMode, cfg?.translationSource ?? null);
}
