-- Rolling-deploy compatibility: old Workers insert held leases without claiming
-- exclusive_owner. After a new Worker has claimed the slot (or a replacement
-- has frozen the lane), those inserts must abort so both sides cannot become
-- authoritative. New Workers set exclusive_owner = 'lease:<id>' before INSERT,
-- so their own lease row is allowed.

CREATE TRIGGER IF NOT EXISTS scripture_export_leases_honor_exclusive_owner
BEFORE INSERT ON scripture_export_leases
FOR EACH ROW
WHEN NEW.status = 'held'
BEGIN
  SELECT RAISE(ABORT, 'lane_exclusive_owner_conflict')
  WHERE EXISTS (
    SELECT 1 FROM scripture_lane_state s
     WHERE s.lane = NEW.lane
       AND (
         s.replacement_job_id IS NOT NULL
         OR (
           s.exclusive_owner IS NOT NULL
           AND s.exclusive_owner != ('lease:' || NEW.lease_id)
         )
       )
  );
END;
