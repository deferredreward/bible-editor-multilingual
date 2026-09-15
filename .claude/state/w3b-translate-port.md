# w3b-translate-port — in-flight status

Branch `feat/w3b-translate-port` (cut from main at 60e8bb0). Issue #445
"Release W3b: run the translate pipeline inside the Worker". Design of record:
`docs/translate-internal-runner.md` (PR series in section F).

## Status by step

- Step 1 — pure ports + ported tests + replay invariant: **done on this branch**
  (`api/src/translate/`, `api/test-fixtures/translate/`,
  `scripts/sync-translate-prompts.mjs`). Not pushed; no PR yet.
- Step 2 — `llm.ts` Anthropic adapter (`@anthropic-ai/sdk`, stubbed-transport
  tests; translate-llm.test.js prompt/extract/classify/scrub/retry cases port
  here): not started.
- Step 3 — migration 0073 (`runner`, `wf_status_json`) + `storage.ts` + `status.ts`: not started.
- Step 4 — `translateWorkflow.ts` + wrangler `[[workflows]]` (dev only): not started.
- Step 5 — `dispatchNext` / `pollPipelineJob` / `pipelineImport` branches behind `PIPELINE_MODE`: not started.
- Step 6 — live OBA→Arabic dry run on the dev worker + compare: not started.
- Step 7 — tq, then tw/ta (`articleResolver.ts`, article steps): not started.

## Notes for the next session

- `package-lock.json` carries a 26-line local modification from the worktree's
  `npm install`; it predates this work and is deliberately uncommitted.
- Regenerate prompt constants after any translate-* SKILL.md change:
  `node scripts/sync-translate-prompts.mjs` (needs a bp-assistant-skills
  checkout; `prompts.test.mjs` compares bytes when one is present).
- Delete this file in the PR that merges the last step of the series (or
  when the branch is abandoned).
