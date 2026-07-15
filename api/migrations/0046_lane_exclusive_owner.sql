-- Shared mutual-exclusion token for export/import leases and replacement
-- reservation. Both paths CAS this column so a check-then-act race cannot
-- interleave (lease after freeze-check, or freeze after lease-check).

ALTER TABLE scripture_lane_state ADD COLUMN exclusive_owner TEXT;
