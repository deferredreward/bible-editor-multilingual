// Admin routes for the per-project source configuration (projectConfig.ts).
// GET is editor-readable (the web chrome needs org/language/direction/labels
// to render); PUT is admin-only because switching a live database's org/preset
// changes what every import/reimport/export targets.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAuth, requireAdmin } from "./auth";
import { getProjectConfig, writeProjectConfig, PRESETS } from "./projectConfig.ts";
import { overlayLaneLabels } from "./scriptureLane";
import { scriptureLaneRoutes } from "./scriptureLaneRoutes";

export const projectConfig = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

projectConfig.use("*", requireAuth);

// Any authenticated user may read the active config (it drives UI labels and
// direction). Also exposes the preset catalog so an admin UI can offer choices.
projectConfig.route("/lanes", scriptureLaneRoutes);

projectConfig.get("/", async (c) => {
  const raw = await getProjectConfig(c.env);
  const cfg = await overlayLaneLabels(c.env, raw);
  return c.json({
    config: cfg,
    presets: Object.values(PRESETS).map((p) => ({
      preset: p.preset,
      org: p.org,
      languageCode: p.languageCode,
      languageName: p.languageName,
      languageTitle: p.languageTitle,
      direction: p.direction,
      reposVerified: p.reposVerified,
      isTranslation: p.translationSource !== null,
    })),
  });
});

const PutBody = z.object({
  preset: z.string().min(1),
  // Partial overrides merged over the preset. Loosely typed here; materialize()
  // in projectConfig.ts only honors known keys, so an unknown key is dropped
  // rather than trusted. Three intents (see writeProjectConfig): the field
  // OMITTED preserves existing overrides, `null` clears them, an object
  // replaces them. A bare preset switch must not silently erase overrides.
  overrides: z.record(z.string(), z.unknown()).nullable().optional(),
});

projectConfig.put("/", requireAdmin, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.issues }, 400);
  }
  if (!PRESETS[parsed.data.preset]) {
    return c.json({ error: "unknown_preset", preset: parsed.data.preset }, 400);
  }
  try {
    // Preserve `undefined` (field omitted) vs `null` (explicit clear) — do NOT
    // collapse them with `?? null`, or a preset switch would wipe overrides.
    const cfg = await writeProjectConfig(
      c.env,
      parsed.data.preset,
      parsed.data.overrides as Record<string, unknown> | null | undefined,
    );
    return c.json({ config: cfg });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "write_failed", detail: msg }, 500);
  }
});
