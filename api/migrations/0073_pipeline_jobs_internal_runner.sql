-- Internal translate runner (issue #445; docs/translate-internal-runner.md §C).
--
-- runner: 'proxy' | 'internal' | NULL. Stamped at dispatch so a job is polled
-- and imported via the runner it actually ran on, even if PIPELINE_MODE flips
-- while it is in flight. NULL = pre-0073 rows, read as 'proxy'.
--
-- wf_status_json: owned by TranslateWorkflow (api/src/translateWorkflow.ts).
-- A bot-shaped StatusResponse fragment ({state, current, updatedAt, output})
-- that pollPipelineJob reads for runner='internal' jobs in place of the Fly
-- bot's GET /api/pipeline/:id. The Workflow writes ONLY this column plus
-- current_skill / current_status / updated_at — never `state` or
-- `output_json`: `output_json IS NULL` is the not-yet-imported flag and state
-- transitions stay owned by pollPipelineJob (design §B).
--
-- Plain additive ALTERs: no rebuild, no FK involvement, no preflight needed.
ALTER TABLE pipeline_jobs ADD COLUMN runner TEXT;
ALTER TABLE pipeline_jobs ADD COLUMN wf_status_json TEXT;
