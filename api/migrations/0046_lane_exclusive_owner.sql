-- Shared mutual-exclusion token for export/import leases and replacement
-- reservation. Both paths CAS this column so a check-then-act race cannot
-- interleave (lease after freeze-check, or freeze after lease-check).
--
-- Backfill: any lease already held by the pre-0046 code path must claim the
-- slot so a rolling deploy cannot treat the lane as free while an old Worker
-- still holds scripture_export_leases.status='held'. Runtime CAS also keeps a
-- NOT EXISTS (fresh held lease) predicate for the same reason.

ALTER TABLE scripture_lane_state ADD COLUMN exclusive_owner TEXT;

-- Oldest fresh-ish held lease wins the slot when exclusive_owner is still NULL.
-- Stale heartbeats are left for reclaimStaleExclusiveOwner / abandonStaleHeldLeases.
UPDATE scripture_lane_state
   SET exclusive_owner = (
         SELECT 'lease:' || l.lease_id
           FROM scripture_export_leases l
          WHERE l.lane = scripture_lane_state.lane
            AND l.status = 'held'
          ORDER BY l.created_at ASC, l.lease_id ASC
          LIMIT 1
       )
 WHERE exclusive_owner IS NULL
   AND EXISTS (
         SELECT 1 FROM scripture_export_leases l
          WHERE l.lane = scripture_lane_state.lane AND l.status = 'held'
       );
