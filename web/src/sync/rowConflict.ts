// Decide whether a row-patch 409 (version_mismatch) is *spurious* — the
// concurrent server change does not actually conflict with our edit — and can
// be auto-healed (re-armed against the server version and retried) instead of
// surfacing a conflict prompt.
//
// Why this exists: optimistic concurrency 409s fire whenever the server row's
// version advanced under us, even when the change that advanced it doesn't
// touch the fields we're editing (another tab/device saving a *different*
// field, a bit-toggle, a reorder, a background reimport, or simply our own
// edit having already landed). Those are safe to resolve automatically —
// last-write-wins on our own fields, everyone else's untouched. Surfacing a
// prompt for them is the "conflict with almost every edit, resolves by just
// clicking" symptom. Genuine conflicts — the server changed a field we're also
// changing, to a different value — still prompt.
//
// The decision is pure so it can be unit-tested without the outbox / IndexedDB
// / cloudflare runtime (see rowConflict.test.mjs).

export type RowConflictResolution = "auto_heal" | "conflict";

// null and undefined are the same "absent" value here: the server serializes an
// empty column as null, while an un-set optimistic field is undefined. Types are
// otherwise primitives (string | number) straight from JSON, so === is right.
function valuesEqual(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  return na === nb;
}

/**
 * @param patch     the fields this op is writing (the PATCH body)
 * @param baseline  the row's values for those fields at the moment we enqueued
 *                  (the version we branched from). Undefined for ops queued
 *                  before baselines were captured, or non-Shell callers.
 * @param serverRow the server's current row from the 409 body (`current`).
 *
 * Auto-heal iff EVERY patched field is non-conflicting, where a field is
 * non-conflicting when the server's current value is either
 *   (a) already equal to what we're setting (our edit is idempotent / already
 *       landed — applying it is a genuine no-op), or
 *   (b) equal to our pre-edit baseline (the server never touched this field —
 *       the version advanced for an unrelated reason, so our edit applies
 *       cleanly on top and clobbers nothing).
 * Any patched field the server moved to a value different from BOTH our target
 * and our baseline is a real conflict → prompt. With no baseline, only (a) can
 * prove safety; anything else is treated conservatively as a conflict.
 */
export function classifyRowPatchConflict(
  patch: Record<string, unknown>,
  baseline: Record<string, unknown> | undefined,
  serverRow: Record<string, unknown> | null | undefined,
): RowConflictResolution {
  // No server row to compare against (e.g. the 409 body carried no `current`) —
  // we can't prove the change is safe, so leave it to the user.
  if (!serverRow || typeof serverRow !== "object") return "conflict";
  const keys = Object.keys(patch);
  // An empty patch shouldn't reach here (the server rejects it 400), but if it
  // does there's nothing of ours to conflict — treat as healable.
  for (const key of keys) {
    const ours = patch[key];
    const server = (serverRow as Record<string, unknown>)[key];
    if (valuesEqual(server, ours)) continue; // (a) idempotent
    if (baseline && valuesEqual(server, baseline[key])) continue; // (b) untouched
    return "conflict";
  }
  return "auto_heal";
}
