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

import { TranslateWorkflow } from "../translateWorkflow.ts";

export { TranslateWorkflow };

type HarnessEnv = {
  TRANSLATE_WORKFLOW: {
    create(options: { id: string; params: unknown }): Promise<{ id: string }>;
    get(id: string): Promise<{ status(): Promise<unknown> }>;
  };
};

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/create") {
        const body = (await request.json()) as { id: string; params: unknown };
        const instance = await env.TRANSLATE_WORKFLOW.create({ id: body.id, params: body.params });
        return Response.json({ id: instance.id });
      }
      if (url.pathname === "/status") {
        const instance = await env.TRANSLATE_WORKFLOW.get(url.searchParams.get("id") ?? "");
        return Response.json(await instance.status());
      }
    } catch (err) {
      return Response.json({ harnessError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
};
