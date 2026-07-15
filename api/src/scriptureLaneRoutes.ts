// Hono routes for scripture lane management.
// Mounted at /api/project-config/lanes in index.ts (via projectConfigRoutes).

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAuth, requireAdmin } from "./auth";
import { normalizeDoor43RepoUrl } from "./repoUrl";
import type { LaneKey, ScriptureLaneConfig } from "./scriptureLane";
import {
  requireLaneState,
  activeLaneConfig,
  parseLaneConfig,
  lanePublicState,
  assertLaneWritable,
} from "./scriptureLane";
import {
  startReplacement,
  stageBook,
  markReadyIfComplete,
  activateReplacement,
  cancelReplacement,
  retryBook,
  waiveBook,
  getJob,
  getJobBooks,
} from "./scriptureLaneReplacement";
import { broadcastLaneEvent } from "./wsEvents";
import type { WsEvent } from "./wsEvents";

export const scriptureLaneRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

scriptureLaneRoutes.use("*", requireAuth);

function isLaneKey(s: string): s is LaneKey {
  return s === "lit" || s === "sim";
}

// Build a lane freeze/settled WS event from the current lane + job state. Read
// fresh so activeGeneration / configRevision reflect the post-mutation state.
async function buildLaneEvent(
  env: Env,
  lane: LaneKey,
  jobId: string,
  type: "lane.replacement_freeze" | "lane.replacement_settled",
): Promise<WsEvent> {
  const state = await requireLaneState(env, lane);
  const job = await getJob(env, jobId);
  return {
    type,
    lane,
    jobId,
    predecessorGeneration: job?.predecessor_generation ?? 0,
    activeGeneration: state.active_generation,
    configRevision: state.config_revision,
    status: job?.status ?? "unknown",
  };
}

// POST /:lane/validate — normalize a pasted URL and return source/export/impact
scriptureLaneRoutes.post("/:lane/validate", async (c) => {
  const lane = c.req.param("lane");
  if (!isLaneKey(lane)) return c.json({ error: "invalid_lane" }, 400);

  let body: { url?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const result = normalizeDoor43RepoUrl(body.url ?? "");
  if (!result.ok) return c.json({ error: result.error }, 400);

  const state = await requireLaneState(c.env, lane);
  const currentCfg = activeLaneConfig(state);

  // Count verses that would be affected
  const bv = lane === "lit" ? "ULT" : "UST";
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT book) AS books, COUNT(*) AS verses
       FROM verses WHERE bible_version = ?1 AND source_generation = ?2`,
  ).bind(bv, state.active_generation).first<{ books: number; verses: number }>();

  return c.json({
    source: result.ref,
    currentSource: currentCfg.source,
    impactBooks: countRow?.books ?? 0,
    impactVerses: countRow?.verses ?? 0,
    laneState: lanePublicState(state),
  });
});

// POST /:lane/replacements — start a replacement job (admin)
const StartBody = z.object({
  config: z.object({
    label: z.string().min(1),
    source: z.object({ owner: z.string(), repo: z.string(), ref: z.string() }),
    export: z.object({
      owner: z.string(),
      repo: z.string(),
      baseRef: z.string(),
      branchPolicy: z.literal("contributor_book_branch"),
    }).nullable(),
    textReadOnly: z.boolean(),
    alignmentWritable: z.boolean(),
  }),
  confirm: z.boolean(),
});

scriptureLaneRoutes.post("/:lane/replacements", requireAdmin, async (c) => {
  const lane = c.req.param("lane");
  if (!isLaneKey(lane)) return c.json({ error: "invalid_lane" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = StartBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.issues }, 400);
  }

  try {
    const result = await startReplacement(
      c.env,
      lane,
      parsed.data.config as ScriptureLaneConfig,
      parsed.data.confirm,
    );
    const jobId = result.job.job_id;
    const books = result.books.map((b) => b.book);
    // After the freeze lands: tell open tabs to quarantine their edits, then
    // stage each required book and mark the job ready once complete. All out of
    // the request's hot path (waitUntil) so the admin gets an immediate 201.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await broadcastLaneEvent(
            c.env,
            await buildLaneEvent(c.env, lane, jobId, "lane.replacement_freeze"),
          );
          for (const book of books) {
            try {
              await stageBook(c.env, jobId, book);
            } catch {
              // stageBook records per-book retryable_error itself; a throw here
              // is an unexpected job-state race — leave the book pending so an
              // admin retry can re-run it.
            }
          }
          await markReadyIfComplete(c.env, jobId);
        } catch (err) {
          console.error("replacement staging kickoff failed", {
            lane,
            jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
    return c.json(result, 201);
  } catch (e: unknown) {
    const err = e as Error & { status?: number; detail?: unknown };
    return c.json(
      { error: err.message, detail: err.detail },
      (err.status as 400 | 409 | 422) ?? 500,
    );
  }
});

// GET /:lane/replacements/:jobId
scriptureLaneRoutes.get("/:lane/replacements/:jobId", async (c) => {
  const jid = c.req.param("jobId");
  const job = await getJob(c.env, jid);
  if (!job) return c.json({ error: "not_found" }, 404);
  const books = await getJobBooks(c.env, jid);
  return c.json({ job, books });
});

// POST /:lane/replacements/:jobId/retry-book
const BookBody = z.object({ book: z.string().min(1) });

scriptureLaneRoutes.post("/:lane/replacements/:jobId/retry-book", requireAdmin, async (c) => {
  const jid = c.req.param("jobId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = BookBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  try {
    const result = await retryBook(c.env, jid, parsed.data.book.toUpperCase());
    // Check if all books ready
    const readiness = await markReadyIfComplete(c.env, jid);
    return c.json({ ...result, ...readiness });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return c.json({ error: err.message }, (err.status as 404 | 409) ?? 500);
  }
});

// POST /:lane/replacements/:jobId/waive-book
scriptureLaneRoutes.post("/:lane/replacements/:jobId/waive-book", requireAdmin, async (c) => {
  const jid = c.req.param("jobId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = BookBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  try {
    await waiveBook(c.env, jid, parsed.data.book.toUpperCase());
    const readiness = await markReadyIfComplete(c.env, jid);
    return c.json(readiness);
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return c.json({ error: err.message }, (err.status as 404 | 409) ?? 500);
  }
});

// POST /:lane/replacements/:jobId/activate
const ActivateBody = z.object({ fencingToken: z.string().min(1) });

scriptureLaneRoutes.post("/:lane/replacements/:jobId/activate", requireAdmin, async (c) => {
  const lane = c.req.param("lane");
  if (!isLaneKey(lane)) return c.json({ error: "invalid_lane" }, 400);
  const jid = c.req.param("jobId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = ActivateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  try {
    const result = await activateReplacement(c.env, jid, parsed.data.fencingToken);
    // Freeze lifted + generation flipped — tell open tabs to refresh.
    c.executionCtx.waitUntil(
      (async () => {
        await broadcastLaneEvent(
          c.env,
          await buildLaneEvent(c.env, lane, jid, "lane.replacement_settled"),
        );
      })(),
    );
    return c.json(result);
  } catch (e: unknown) {
    const err = e as Error & { status?: number; detail?: unknown };
    return c.json(
      { error: err.message, detail: err.detail },
      (err.status as 404 | 409) ?? 500,
    );
  }
});

// POST /:lane/replacements/:jobId/cancel
scriptureLaneRoutes.post("/:lane/replacements/:jobId/cancel", requireAdmin, async (c) => {
  const lane = c.req.param("lane");
  if (!isLaneKey(lane)) return c.json({ error: "invalid_lane" }, 400);
  const jid = c.req.param("jobId");
  try {
    await cancelReplacement(c.env, jid);
    // Freeze lifted (reverted to the predecessor generation) — refresh tabs.
    c.executionCtx.waitUntil(
      (async () => {
        await broadcastLaneEvent(
          c.env,
          await buildLaneEvent(c.env, lane, jid, "lane.replacement_settled"),
        );
      })(),
    );
    return c.json({ ok: true });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return c.json({ error: err.message }, (err.status as 404) ?? 500);
  }
});

// PATCH /:lane — label/lock updates with configRevision CAS
const LanePatch = z.object({
  label: z.string().min(1).optional(),
  textReadOnly: z.boolean().optional(),
  alignmentWritable: z.boolean().optional(),
  configRevision: z.number().int().min(1),
});

scriptureLaneRoutes.patch("/:lane", requireAdmin, async (c) => {
  const lane = c.req.param("lane");
  if (!isLaneKey(lane)) return c.json({ error: "invalid_lane" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = LanePatch.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.issues }, 400);
  }

  const gate = await assertLaneWritable(c.env, lane, "config_patch");
  if (!gate.ok) return c.json({ error: gate.error, detail: gate.detail }, gate.status);

  const state = await requireLaneState(c.env, lane);
  if (state.config_revision !== parsed.data.configRevision) {
    return c.json(
      { error: "config_revision_mismatch", current: state.config_revision },
      409,
    );
  }

  // Frozen check
  if (state.replacement_job_id) {
    return c.json({ error: "lane_frozen" }, 409);
  }

  const cfg = parseLaneConfig(state.active_config_json);
  if (parsed.data.label !== undefined) cfg.label = parsed.data.label;
  if (parsed.data.textReadOnly !== undefined) cfg.textReadOnly = parsed.data.textReadOnly;
  if (parsed.data.alignmentWritable !== undefined) cfg.alignmentWritable = parsed.data.alignmentWritable;

  const result = await c.env.DB.prepare(
    `UPDATE scripture_lane_state
        SET active_config_json = ?1,
            config_revision = config_revision + 1,
            updated_at = unixepoch()
      WHERE lane = ?2 AND config_revision = ?3`,
  ).bind(JSON.stringify(cfg), lane, parsed.data.configRevision).run();

  if (!result.meta.changes) {
    return c.json({ error: "config_revision_mismatch" }, 409);
  }

  const updated = await requireLaneState(c.env, lane);
  return c.json({ laneState: lanePublicState(updated) });
});
