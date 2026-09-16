// TEST-ONLY Worker entry: the smallest module that lets a real Workflows
// runtime (workerd, under miniflare) instantiate and drive the REAL
// TranslateWorkflow class.
//
// It is NOT part of the deployed Worker: `api/src/index.ts` never imports it,
// so `wrangler deploy` does not bundle it. It exists because a
// WorkflowEntrypoint cannot be constructed by hand — `step.do`, its retry
// policy and `NonRetryableError`'s fatality check are engine behaviour, so the
// only way to execute `TranslateWorkflow.run()` is to hand the class to an
// engine and ask it to create an instance.
//
// The harness that bundles this file, starts miniflare and drives these two
// routes lives in translate/workflowHarness.mjs; the proofs are in
// translate/workflowEngine.test.mjs.

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { TranslateWorkflow, type TranslateWorkflowParams, type TranslateWorkflowResult } from "../translateWorkflow.ts";

export { TranslateWorkflow };

/**
 * TEST-ONLY subclass, bound separately and used by exactly one proof: the one
 * that has to make an R2 write fail AFTER a batch has been paid for, to show
 * that its retry replays the persisted output instead of re-buying it. Nothing
 * about the Workflow is overridden — run() is the real one — and the only
 * substitution is an R2 binding that refuses one put of a batch output. Every
 * other proof drives the real class through the real binding.
 */
export class FlakyR2TranslateWorkflow extends TranslateWorkflow {
  async run(event: WorkflowEvent<TranslateWorkflowParams>, step: WorkflowStep): Promise<TranslateWorkflowResult> {
    const self = this as unknown as { env: Record<string, unknown> };
    const real = self.env.BLOBS as R2Bucket;
    // The R2 key holding "how many more batch-output puts to refuse"; the
    // harness owns the literal (workflowHarness.FAIL_PUTS_KEY) and passes it as
    // a var. The budget lives in R2, not in a module-level counter, because the
    // engine may resume an instance in a different isolate between attempts —
    // and a counter that resets on resume would never exhaust.
    const budgetKey = String(self.env.HARNESS_FAIL_PUTS_KEY ?? "");
    self.env = {
      ...self.env,
      BLOBS: {
        get: (key: string) => real.get(key),
        async put(key: string, value: string, opts?: unknown) {
          if (budgetKey && key.endsWith("-out.tsv")) {
            const obj = await real.get(budgetKey);
            const left = obj ? Number(await obj.text()) : 0;
            if (left > 0) {
              if (left > 1) await real.put(budgetKey, String(left - 1));
              else await real.delete(budgetKey);
              throw new Error(`R2 PutObject: 500 internal error (harness, ${left} refusal(s) left)`);
            }
          }
          return real.put(key, value, opts as R2PutOptions);
        },
      },
    };
    return super.run(event, step);
  }
}

type WorkflowBinding = {
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{ status(): Promise<unknown> }>;
};

type HarnessEnv = Record<string, WorkflowBinding>;

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    const wf = env[url.searchParams.get("binding") ?? "TRANSLATE_WORKFLOW"];
    try {
      if (url.pathname === "/create") {
        const body = (await request.json()) as { id: string; params: unknown };
        const instance = await wf.create({ id: body.id, params: body.params });
        return Response.json({ id: instance.id });
      }
      if (url.pathname === "/status") {
        const instance = await wf.get(url.searchParams.get("id") ?? "");
        return Response.json(await instance.status());
      }
    } catch (err) {
      return Response.json({ harnessError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
};
