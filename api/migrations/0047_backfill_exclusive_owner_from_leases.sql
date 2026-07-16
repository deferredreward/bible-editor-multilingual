-- Transition safety for DBs that already applied bare 0046 (column only, no
-- backfill). Re-run the held-lease → exclusive_owner backfill so a rolling
-- deploy cannot see a free slot while a pre-exclusive_owner Worker still holds
-- a lease. Idempotent when exclusive_owner is already set.

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
