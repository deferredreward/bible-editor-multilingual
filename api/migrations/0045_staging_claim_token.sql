-- Staging claim token: a slow Worker reclaimed after STAGING_CLAIM_STALE_SECONDS
-- must not resume deletes/inserts/finalization. New claim overwrites the token;
-- subsequent writes require an exact token match.

ALTER TABLE scripture_lane_replacement_books ADD COLUMN staging_claim_token TEXT;
