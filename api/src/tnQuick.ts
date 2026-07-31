// Thin proxy for the unfoldingWord bot-platform `/api/tn-quick` endpoint
// (https://uw-bt-bot.fly.dev). The bot drafts translation notes from a
// verse + issue type + Hebrew quote. We forward the user's body to the
// bot using the shared service token (BT_API_TOKEN secret) so the
// token never reaches the browser.
//
// This route stays dumb on purpose: auth gate, env check, swap the
// Authorization header, forward, return the bot's response verbatim.
// All business logic — request validation, Hebrew normalization, note
// drafting — lives in the bot.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireEditor } from "./auth";
import { getProjectConfig } from "./projectConfig";
import { getLatestSuccessfulContextExport } from "./contextExportResults";
import { applyTnQuickContext } from "./assistedContextRef";

export const tnQuick = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const DEFAULT_URL = "https://uw-bt-bot.fly.dev/api/tn-quick";
const MAX_BODY_BYTES = 32 * 1024;

tnQuick.post("/", requireEditor, async (c) => {
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "tn_quick_disabled" }, 503);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return c.json({ error: "body_too_large", maxBytes: MAX_BODY_BYTES }, 413);
  }

  // Fold the org's curated preferences (brief, terminology, instructions) into
  // the drafting request via the pinned contextRef, plus targetLang/direction
  // for the pack's language header — mirrors the translate pipeline
  // (pipelines.ts's "translate" branch). No successful export → forward the
  // body unchanged, exactly as before; the bot then drafts unsteered.
  let body = rawBody;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const cfg = await getProjectConfig(c.env);
    const latest = await getLatestSuccessfulContextExport(c.env);
    body = JSON.stringify(applyTnQuickContext(parsed, latest, cfg));
  } catch {
    // Malformed JSON — forward unchanged and let the bot's own validation reject it.
  }

  const url = c.env.TN_QUICK_URL || DEFAULT_URL;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.BT_API_TOKEN}`,
      },
      body,
    });
  } catch {
    return c.json({ error: "model_call_failed" }, 502);
  }

  const text = await upstream.text();
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  };
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(text, { status: upstream.status, headers });
});
