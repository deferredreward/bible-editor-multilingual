// Module-level shared store behind `useContextExportStatus` (issue #206).
//
// `useContextExportStatus` is called independently from up to 4 places at
// once (StyleScreen's ExamplesPanel + PackStatusBar, PreferencesWorkspace's
// ContextPackStatusControls + ExamplesSection). Each used to own private
// `useState`, so every mount fired its own GET, and calling `refetch()` from
// one instance (e.g. after running an export) never reached the others —
// their chip stayed stale until they happened to remount. Fixed with one
// in-flight fetch promise plus one subscriber set, shared by every call
// site: one fetch, one `refetch()` broadcast.
//
// Deliberately unkeyed by workspace: WorkspaceSwitcher does a hard
// `location.reload()` on switch (see `sync/workspace.ts`), which tears down
// this module along with every other in-memory cache — an unkeyed singleton
// can't leak status across workspaces.
//
// Split into its own file (rather than living inline in
// useTranslationMemory.ts) so it has zero runtime dependency on React or on
// `sync/api.ts` — the latter is pulled in only as an erased `import type`.
// `sync/api.ts` (and modules it imports, e.g. `lib/layoutSpec`) uses
// extensionless relative imports, which Vite/tsc resolve but bare
// `node --experimental-strip-types` cannot; keeping this module import-free
// at runtime is what lets `contextExportStatusStore.test.mjs` exercise the
// dedupe/broadcast logic directly under this repo's `node --test` harness.
import type { ContextExportStatus } from "../sync/api";

export interface ContextExportStatusState {
  status: ContextExportStatus | null;
  loading: boolean;
  error: Error | null;
}

const INITIAL_STATE: ContextExportStatusState = {
  status: null,
  loading: false,
  error: null,
};

export interface ContextExportStatusStore {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => ContextExportStatusState;
  /** Kick off a fetch, or join the one already in flight. Safe to call from
   *  any number of subscribers concurrently — only one GET goes out. */
  fetch: () => Promise<void>;
}

export function createContextExportStatusStore(
  fetcher: () => Promise<ContextExportStatus>,
): ContextExportStatusStore {
  let state = INITIAL_STATE;
  let inFlight: Promise<void> | null = null;
  const subscribers = new Set<() => void>();

  const notify = () => {
    for (const fn of subscribers) fn();
  };

  const fetchStatus = (): Promise<void> => {
    if (inFlight) return inFlight;
    state = { ...state, loading: true, error: null };
    notify();
    inFlight = fetcher()
      .then((res) => {
        state = { status: res, loading: false, error: null };
      })
      .catch((e: unknown) => {
        state = { ...state, loading: false, error: e instanceof Error ? e : new Error(String(e)) };
      })
      .finally(() => {
        inFlight = null;
        notify();
      });
    return inFlight;
  };

  return {
    subscribe(onStoreChange) {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
    getSnapshot: () => state,
    fetch: fetchStatus,
  };
}
