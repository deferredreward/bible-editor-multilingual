// A REAL Cloudflare Workflows runtime for the translate runner's tests.
//
// Why this exists: `TranslateWorkflow.run()` is the one part of the internal
// runner that no unit test can execute. `step.do`, its retry policy, and the
// engine's `NonRetryableError` fatality check are runtime behaviour — a
// WorkflowEntrypoint cannot be constructed by hand, and a hand-rolled fake
// `step` object proves nothing about the engine that will actually run it.
// (That gap already cost us once: `new NonRetryableError(msg, kind)` sets
// `.name = kind`, and the engine decides fatality with
// `err.name === "NonRetryableError" || err.message.startsWith(...)`, so every
// "deterministic, do not retry" failure was silently retried — re-billing the
// org. Source-shape assertions cannot see that; this harness can.)
//
// What it runs: workerd, via miniflare, with the real `cloudflare:workflows`
// engine, the real D1 (every migration applied), the real R2, and the real
// `translateWorkflow.ts` class — not a copy or a subclass. Nothing about the
// Workflow is stubbed. The only fakes are OUTSIDE the worker: every outbound
// fetch (DCS raw endpoints, the Anthropic Messages API) is served by an
// in-process handler through miniflare's `outboundService`, so the suite makes
// no network calls while still exercising the real `@anthropic-ai/sdk`
// streaming client inside the Worker.
//
// miniflare and esbuild are exact, pinned dependencies of `wrangler`, which is
// api's devDependency — they are present wherever `npm test` can run, which is
// why they are used here without being declared separately.
//
// This file is test-only and is never imported by `api/src/index.ts`; the
// worker entry it bundles (`workflowHarnessWorker.ts`) is not in the deployed
// bundle either. Verified by `wrangler deploy --dry-run` size parity.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(API_ROOT, "..");

// Resolved by absolute path: these live in the ROOT workspace's node_modules
// (hoisted from wrangler), and this file sits two directories deep in api/src.
const nodeModule = (name) => `file:///${join(REPO_ROOT, "node_modules", name).replace(/\\/g, "/")}`;

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

let bundlePromise = null;

/**
 * esbuild the test worker entry (which re-exports the real TranslateWorkflow)
 * into one ESM module workerd can load. Built once per test process.
 */
export function workerBundle() {
  bundlePromise ??= (async () => {
    const esbuild = await import(nodeModule("esbuild/lib/main.js"));
    const result = await esbuild.build({
      entryPoints: [join(HERE, "workflowHarnessWorker.ts")],
      bundle: true,
      format: "esm",
      target: "es2022",
      platform: "browser",
      conditions: ["workerd", "worker", "browser", "import", "module"],
      mainFields: ["module", "main"],
      // Provided by the runtime, not bundled — exactly as wrangler treats them.
      external: ["cloudflare:workers", "cloudflare:workflows", "node:*"],
      write: false,
      logLevel: "silent",
      absWorkingDir: API_ROOT,
    });
    return result.outputFiles[0].text;
  })();
  return bundlePromise;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

let migrationsCache = null;

function migrations() {
  if (migrationsCache) return migrationsCache;
  const dir = join(API_ROOT, "migrations");
  migrationsCache = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    // Trailing `-- comment` lines leave workerd's multi-statement prepare with
    // "SQL code did not contain a statement"; a terminating no-op statement
    // makes every file end on real SQL (0042 is the one that trips this).
    .map((f) => `${readFileSync(join(dir, f), "utf8")}\nSELECT 1;`);
  return migrationsCache;
}

/** Apply every api/migrations/*.sql to a miniflare D1 handle, in order. */
export async function migrate(d1) {
  for (const sql of migrations()) await d1.prepare(sql).run();
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (streaming) — served to the real SDK over SSE
// ---------------------------------------------------------------------------

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The wire form of one successful `client.messages.stream(...)` completion, as
 * the SDK's MessageStream accumulates it. Returned by the outbound handler, so
 * the adapter under test is the real one end to end: real SDK, real SSE parse,
 * real usage / stop_reason plumbing.
 */
export function anthropicStreamResponse({ text, model, inputTokens = 5000, outputTokens = 3000, stopReason = "end_turn" }) {
  const body =
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_harness", type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
    + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
    + sse("content_block_stop", { type: "content_block_stop", index: 0 })
    + sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    })
    + sse("message_stop", { type: "message_stop" });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** An Anthropic API error the SDK will classify (401 -> invalid_key, 429 -> rate_limited, ...). */
export function anthropicErrorResponse(status, type, message) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["complete", "errored", "terminated", "unknown"]);

/**
 * Write a count to this key to make the FLAKY_R2_WORKFLOW binding refuse that
 * many puts of keys ending in `failPutsSuffix` (default `-out.tsv`;
 * workflowHarnessWorker.FlakyR2TranslateWorkflow reads the key name from the
 * HARNESS_FAIL_PUTS_KEY var and the suffix from HARNESS_FAIL_PUTS_SUFFIX). Each
 * refusal spends one, and the key is deleted when the budget runs out, so the
 * run eventually succeeds against a healthy bucket — and a test can assert the
 * budget was fully spent, which is what proves the failures really happened.
 */
export const FAIL_PUTS_KEY = "__harness__/refuse-out-puts";

/**
 * Boot a workerd instance with the real TranslateWorkflow bound.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.d1   binding name -> database id (one per workspace)
 * @param {string[]} opts.r2                R2 binding names
 * @param {Record<string,string>} opts.vars plain env vars (WORKSPACES, AI_KEY_WRAPPING_KEY...)
 * @param {(req: Request) => Promise<Response>} opts.outbound serves EVERY fetch the worker makes
 * @param {string} [opts.persistDir] write the engine's instance state here, so a
 *        test can read back every byte the Workflows runtime put on disk
 * @param {string} [opts.failPutsSuffix] which R2 keys FLAKY_R2_WORKFLOW refuses
 *        (default `-out.tsv`); the budget itself lives at FAIL_PUTS_KEY
 */
export async function startEngine({ d1, r2 = ["BLOBS"], vars = {}, outbound, persistDir, failPutsSuffix = "-out.tsv" }) {
  const { Miniflare } = await import(nodeModule("miniflare/dist/src/index.js"));
  const contents = await workerBundle();
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "index.mjs", contents }],
    modulesRoot: "/",
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: d1,
    r2Buckets: r2,
    bindings: { ...vars, HARNESS_FAIL_PUTS_KEY: FAIL_PUTS_KEY, HARNESS_FAIL_PUTS_SUFFIX: failPutsSuffix },
    workflows: {
      TRANSLATE_WORKFLOW: { name: "bible-editor-translate-test", className: "TranslateWorkflow" },
      // Same real run(), one R2 binding that refuses a single batch-output put
      // — see workflowHarnessWorker.FlakyR2TranslateWorkflow. Bound separately
      // so no other proof can accidentally run through it.
      FLAKY_R2_WORKFLOW: { name: "bible-editor-translate-flaky-test", className: "FlakyR2TranslateWorkflow" },
    },
    ...(persistDir ? { workflowsPersist: persistDir } : {}),
    outboundService: (request) => outbound(request),
  });
  await mf.ready;

  for (const binding of Object.keys(d1)) await migrate(await mf.getD1Database(binding));

  let disposed = false;
  return {
    mf,
    d1: (binding) => mf.getD1Database(binding),
    r2: (binding = "BLOBS") => mf.getR2Bucket(binding),

    /**
     * Ask the engine to create an instance of the real Workflow. `binding`
     * selects which class the engine instantiates; it defaults to the real
     * TranslateWorkflow and only the one-shot-R2-failure proof passes anything
     * else (FLAKY_R2_WORKFLOW).
     */
    async create(id, params, binding = "TRANSLATE_WORKFLOW") {
      const res = await mf.dispatchFetch(`http://harness/create?binding=${encodeURIComponent(binding)}`, { method: "POST", body: JSON.stringify({ id, params }) });
      const body = await res.json();
      if (!res.ok) throw new Error(`create(${id}) failed: ${JSON.stringify(body)}`);
      return body;
    },

    async status(id, binding = "TRANSLATE_WORKFLOW") {
      const res = await mf.dispatchFetch(`http://harness/status?id=${encodeURIComponent(id)}&binding=${encodeURIComponent(binding)}`);
      return res.json();
    },

    /** Poll the engine until the instance reaches a terminal status. */
    async run(id, params, { timeoutMs = 300000, pollMs = 100, binding = "TRANSLATE_WORKFLOW" } = {}) {
      await this.create(id, params, binding);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const s = await this.status(id, binding);
        if (TERMINAL.has(s.status)) return s;
        if (Date.now() > deadline) throw new Error(`instance ${id} still ${s.status} after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    /** Idempotent: the key-leak proof disposes early to flush the persist dir. */
    async dispose() {
      if (disposed) return;
      disposed = true;
      await mf.dispose();
    },
  };
}

/** Every key currently in an R2 bucket (the suite's buckets hold tens of objects). */
export async function r2Keys(bucket) {
  const out = [];
  let cursor;
  for (;;) {
    const page = await bucket.list(cursor ? { cursor } : {});
    for (const o of page.objects) out.push(o.key);
    if (!page.truncated) return out.sort();
    cursor = page.cursor;
  }
}

export async function r2Text(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? obj.text() : null;
}
