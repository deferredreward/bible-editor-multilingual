-- Follow-up pipeline for asymmetric alignment. bp-assistant's contract has
-- mutually-exclusive align flags (noAlign | alignOnly | textOnly), so a
-- single "generate" call can't say "align ULT but not UST" (or vice versa).
-- We split into two upstream calls: parent runs first (e.g. ULT aligned),
-- then on its done-transition the poll handler fires the follow-up (e.g.
-- UST text-only) as a fresh pipeline_jobs row.
--
-- follow_up_options : JSON-encoded PipelineRequestOptions stored at start.
-- follow_up_job_id  : null until the follow-up upstream call succeeds; then
--                     holds the child's job_id (used as an idempotency
--                     guard against concurrent polls double-firing).
ALTER TABLE pipeline_jobs ADD COLUMN follow_up_options TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN follow_up_job_id TEXT;
