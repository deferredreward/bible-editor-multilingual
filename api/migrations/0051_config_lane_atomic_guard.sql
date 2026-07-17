-- PR B: generic in-batch abort mechanism for atomic multi-table D1 batches.
-- INSERTing any row into this table always violates the CHECK (a poison
-- pill) — used as a conditional guard: an INSERT ... SELECT ... WHERE <bad
-- condition> rolls back the WHOLE batch when the condition is true, and is a
-- no-op otherwise (same technique as article_fetch_state's
-- 'abort_config_changed' sentinel in migration 0050, generalized here for
-- reuse outside articles — the project-config PUT uses it to make a lane's
-- fenced UPDATE a real CAS: a fenced UPDATE matching zero rows is still
-- SUCCESSFUL SQL, so a guard row that raises on the same "did this row
-- change as expected" predicate is what actually rolls the batch back).
-- The CHECK is an unconditional falsehood: ANY row inserted here, regardless
-- of its content, violates it. Callers wrap the INSERT in `SELECT ... WHERE
-- <bad condition>` — when the condition is false the SELECT yields zero rows
-- (a true no-op, nothing to violate); when it's true the SELECT yields one
-- row and the INSERT of that row unconditionally trips the CHECK.
CREATE TABLE _abort_guard (
  reason TEXT NOT NULL CHECK (1 = 0)
);
