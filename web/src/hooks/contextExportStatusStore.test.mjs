// Regression coverage for issue #206: `useContextExportStatus` used to have
// no shared cache — 4 independent call sites (StyleScreen's ExamplesPanel +
// PackStatusBar, PreferencesWorkspace's ContextPackStatusControls +
// ExamplesSection) each fired their own GET on mount, and `refetch()` from
// one instance never reached the others.
//
// `createContextExportStatusStore` (in `./contextExportStatusStore.ts`) is
// the pure store behind the fix — it's exercised directly here rather than
// through `useContextExportStatus` for two independent reasons: (1) this
// repo's test runner (`node --experimental-strip-types --no-warnings --test`)
// has no jsdom/React Testing Library, so a hook that calls
// `useSyncExternalStore`/`useEffect` can't be mounted and rendered in this
// harness; (2) `useTranslationMemory.ts` imports `sync/api.ts`, which (like
// several of its own transitive imports, e.g. `lib/layoutSpec`) uses
// extensionless relative imports — Vite/tsc resolve those, but bare Node ESM
// resolution does not, so importing that file directly from a `--test` file
// throws `ERR_MODULE_NOT_FOUND` before any test code runs. The store module
// has zero runtime imports (only an erased `import type` of
// `ContextExportStatus`), so it sidesteps both problems while still covering
// the dedupe/broadcast logic that actually fixes the bug.

import assert from "node:assert/strict";
import { createContextExportStatusStore } from "./contextExportStatusStore.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// ── concurrent "mounts" collapse onto one fetch ─────────────────────────────
{
  let calls = 0;
  let resolveFetch;
  const fetcher = () =>
    new Promise((resolve) => {
      calls++;
      resolveFetch = resolve;
    });
  const store = createContextExportStatusStore(fetcher);

  // Simulate 4 call sites all mounting in the same tick, each seeing no
  // cached status yet and asking the store to fetch — the real bug this
  // reproduces (4 independent GETs).
  const p1 = store.fetch();
  const p2 = store.fetch();
  const p3 = store.fetch();
  const p4 = store.fetch();

  check(calls === 1, "4 concurrent store.fetch() calls issue exactly one underlying fetch");
  check(p1 === p2 && p2 === p3 && p3 === p4, "concurrent callers share the same in-flight promise");
  check(store.getSnapshot().loading === true, "store reports loading while the shared fetch is in flight");

  const status = { status: "success", sha: "abc123", terms: 1, examplesTn: 2, examplesTq: 3 };
  resolveFetch(status);
  await p1;

  check(store.getSnapshot().status === status, "snapshot reflects the resolved status once the fetch settles");
  check(store.getSnapshot().loading === false, "loading clears once the fetch settles");
}

// ── refetch() broadcasts to every subscriber ────────────────────────────────
{
  let calls = 0;
  const statuses = [
    { status: "dry_run", sha: null },
    { status: "success", sha: "deadbeef" },
  ];
  const fetcher = () => Promise.resolve(statuses[calls++]);
  const store = createContextExportStatusStore(fetcher);

  // Two subscribers stand in for two independently-mounted call sites (e.g.
  // ExamplesPanel and PackStatusBar on StyleScreen).
  let notifiedA = 0;
  let notifiedB = 0;
  const unsubA = store.subscribe(() => notifiedA++);
  const unsubB = store.subscribe(() => notifiedB++);

  await store.fetch();
  check(store.getSnapshot().status === statuses[0], "initial fetch populates the shared status");
  check(notifiedA > 0 && notifiedB > 0, "both subscribers are notified of the initial fetch");

  const beforeA = notifiedA;
  const beforeB = notifiedB;

  // Simulate PackStatusBar calling refetch() after running an export — this
  // is exactly the case where the old per-instance hooks left every other
  // instance's chip stale.
  await store.fetch();

  check(store.getSnapshot().status === statuses[1], "refetch's new status lands in the shared snapshot");
  check(notifiedA > beforeA, "subscriber A (standing in for a sibling call site) is notified of the refetch");
  check(notifiedB > beforeB, "subscriber B (standing in for a sibling call site) is notified of the refetch");

  unsubA();
  unsubB();
}

// ── unsubscribed listeners are not notified (mirrors unmount cleanup) ──────
{
  let calls = 0;
  const fetcher = () => Promise.resolve({ status: "success", call: calls++ });
  const store = createContextExportStatusStore(fetcher);

  let notified = 0;
  const unsub = store.subscribe(() => notified++);
  await store.fetch();
  const afterFirst = notified;
  check(afterFirst > 0, "subscriber notified while subscribed");

  unsub();
  await store.fetch();
  check(notified === afterFirst, "unsubscribed listener receives no further notifications (unmount cleanup)");
}

// ── a failed fetch surfaces an error and leaves status untouched ───────────
{
  const boom = new Error("network down");
  let attempt = 0;
  const fetcher = () => {
    attempt++;
    if (attempt === 1) return Promise.reject(boom);
    return Promise.resolve({ status: "success", attempt });
  };
  const store = createContextExportStatusStore(fetcher);

  await store.fetch();
  check(store.getSnapshot().status === null, "a failed fetch leaves status null");
  check(store.getSnapshot().error === boom, "a failed fetch surfaces the error on the snapshot");
  check(store.getSnapshot().loading === false, "loading clears after a failed fetch");

  // A later retry (e.g. a remounted, still-null-status call site) succeeds
  // and clears the error for everyone.
  await store.fetch();
  check(store.getSnapshot().status?.attempt === 2, "a subsequent fetch can recover from a prior failure");
  check(store.getSnapshot().error === null, "error clears once a later fetch succeeds");
}

console.log(`\n${passed} checks passed`);
