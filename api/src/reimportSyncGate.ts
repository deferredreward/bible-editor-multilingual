// Pure decision: should the nightly reimport stamp the (book, resource) sync
// watermark (book_resource_syncs) for this run's counts? A watermark must not
// certify data it didn't apply — the same principle as the truncated-fetch
// completeness gate in shrinkGuard.ts / bookReimport.ts's
// planAndStageBookResources (the HAB tn incident).
//
// ── Withhold conditions (issue #427, option 2) ───────────────────────────────
//
//   1. `conflict_skipped` — a master row this run meant to INSERT was refused
//      by `ON CONFLICT(id, book) DO NOTHING` (0 rows written). Its (book, id)
//      slot is held by a row the reimport's in-memory diff never saw.
//
//   2. `tombstone_blocked` — a master row was dropped because a soft-deleted
//      row holds its id, and master carries that id at a DIFFERENT reference,
//      so the id has been reissued to a genuinely different row (see
//      isReissuedTombstone in reimportClassify.ts). A SAME-reference tombstone
//      is deliberately excluded: skipping there is what preserves a deletion
//      that hasn't been exported yet, and reclaiming it would resurrect every
//      pending delete nightly.
//
// Both mean the same thing — master content this run was supposed to apply is
// NOT in D1 — so both must withhold. This is the 1CH 23 tQ case upstream hit:
// six tQ rows vanished into tombstoned ids and (1CH, tq) was stamped
// `origin='reimport'` anyway, certifying a book that was six rows short of
// master. Nothing retries it either: the next run's SHA gate sees an unchanged
// `source_sha` and skips the file, so the stamp is the only thing standing
// between the drop and a permanent silent divergence — the nightly export's
// freshness gate (exportWorkflow.ts checkMasterFreshness) then trusts stale D1
// and renders it back over master, the exact silent-revert incident class this
// fork's watermark machinery exists to prevent.
//
// A counts object is treated as fail-safe (withhold) whenever either field is
// entirely ABSENT (`undefined`) rather than a real, present `0` — this is the
// legacy/malformed case: a Workflow instance that began running before this
// fix shipped replays its memoized `step.do` results verbatim on resume, so
// mid-flight it can hand this function an object that simply never had
// `conflict_skipped` / `tombstone_blocked` in the first place. Note this is a
// presence check, NOT a `?? 0` coercion on the read — `?? 0` would turn that
// same "field absent" case into "field present and zero" and stamp the
// watermark for data we have no actual evidence is current (zero-and-stamp,
// the wrong direction). Coercion belongs in addCounts (see bookReimport.ts),
// which exists to keep the aggregate counters numeric for logging, not to
// launder an absent field into a green light here. The direction on ambiguity
// is: withhold is safe (worst case, a delayed export retry); stamp is not (it
// can certify stale data as current). See reimportSyncGate.test.mjs.
//
// Incompleteness reaches this gate by two distinct routes, and both must
// withhold:
//   1. Raw absence — the direct `undefined` check below, for a counts object
//      read straight off a single Workflow step result.
//   2. Aggregated-and-coerced — `perResource[resource]` is the running total
//      across every chunk this run (see mergePerResource/addCounts in
//      bookReimport.ts). Once a legacy/replayed chunk missing these fields is
//      folded in via `?? 0`, the absence itself is gone from the aggregate —
//      it reads as a present zero. addCounts records that loss separately on
//      `counts_incomplete`, which is checked here so the aggregate can still
//      withhold even though its own conflict_skipped/tombstone_blocked fields
//      are individually present and zero. (`counts_incomplete` is also set
//      directly by an insert whose D1 result reported no row count at all —
//      an unmeasured write must not be laundered into either a conflict or a
//      success; see tryInsertTsvRow's "unknown" outcome.)
//
// This gate does NOT fix the drop — reclaiming a reissued id is issue #427's
// option 1, and sweeping obsolete tombstones is option 3. It makes the drop
// visible and stops the run from claiming the resource is current.
//
// `apply_incomplete` (a write batch that THREW, so content this run staged is
// known-absent from D1) is deliberately a SIBLING condition checked at the
// call site (bookReimport.ts's `reimport-sync-${book}` step), not folded into
// this function — mirroring upstream's shape so the two conditions stay
// independently testable.
//
// Deliberately NOT gated on `skipped_locked`: that counter is overloaded — it
// is incremented both by the chapter-lock skip and by the row-level prune
// path, and a locked chapter defers work that the next nightly run picks up
// on its own (the SHA gate can't skip the file — no watermark was written for
// it while any drop counter was firing). Only the two drop counters above
// (plus the `counts_incomplete` taint they can leave behind after
// aggregation) gate this decision.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts for the same pattern.
export function shouldRecordResourceSync(counts: {
  conflict_skipped?: number;
  tombstone_blocked?: number;
  counts_incomplete?: boolean;
}): boolean {
  // Fail-safe presence check: "not measured" must never read as "measured
  // zero". The only production caller passes `perResource[...]`, an aggregate
  // always seeded by zeroCounts() and always `+=`-ed, so these two fields are
  // never literally undefined there — the replay case is caught one layer up,
  // by the `counts_incomplete` taint addCounts sets when a folded-in object
  // lacked them. This check is defence-in-depth for any future caller that
  // hands the gate a raw, un-aggregated object — do not rely on it as the
  // replay guard.
  if (counts.conflict_skipped === undefined || counts.tombstone_blocked === undefined) return false;
  if (counts.counts_incomplete === true) return false;
  return counts.conflict_skipped === 0 && counts.tombstone_blocked === 0;
}
