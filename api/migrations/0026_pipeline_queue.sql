-- Global single-concurrency queue for chapter-scale AI pipelines. The fly.io
-- bot (uw-bt-bot) can only run ONE pipeline at a time; until now every
-- POST /api/pipelines/start forwarded to the bot immediately, so two
-- translators (or two chapters) could hit it at once and it would fall over.
-- We now queue in D1 and dispatch one job to the bot at a time. See
-- docs/ai-pipeline-handoff.md and api/src/pipelines.ts (dispatchNext).
--
-- New states layered onto the existing state column (free-text TEXT, no
-- constraint to alter): 'queued' (accepted, not yet sent to the bot,
-- cancellable), 'dispatching' (claimed the single bot slot; upstream POST in
-- flight), 'cancelled' (a queued job the user withdrew; terminal).
--
-- upstream_job_id : the bot's opaque jobId, assigned on dispatch. NULL while
--                   queued/dispatching. job_id (PK) is now a locally-minted
--                   UUID for every job so a queued job (which has no bot id
--                   yet) still has a stable identity the client polls.
-- priority        : follow-up / macro-chain children get priority=1 so they
--                   jump ahead of other users' queued jobs and the macro
--                   completes as one unit (chapter locked end-to-end).
-- options_json    : the merged PipelineOptions snapshot (incl. notes hints)
--                   taken at queue time. Replayed verbatim into the upstream
--                   body when the job is finally dispatched, since dispatch
--                   happens outside the original request context.
ALTER TABLE pipeline_jobs ADD COLUMN upstream_job_id TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_jobs ADD COLUMN options_json TEXT;

-- Any job already in flight at migration time was keyed by the bot's id
-- (the old PK convention), so seed upstream_job_id = job_id for those so the
-- poller keeps reaching the bot for them.
UPDATE pipeline_jobs
   SET upstream_job_id = job_id
 WHERE upstream_job_id IS NULL
   AND state IN ('running', 'paused_for_outage', 'paused_for_usage_limit');

-- Backs both the dispatcher's "claim the oldest highest-priority queued row"
-- and the list endpoint's position ranking.
CREATE INDEX pipeline_jobs_queue
  ON pipeline_jobs(state, priority DESC, created_at ASC);
