// Admin routes for the per-project source configuration (projectConfig.ts).
// GET is editor-readable (the web chrome needs org/language/direction/labels
// to render); PUT is admin-only because switching a live database's org/preset
// changes what every import/reimport/export targets.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAuth, requireAdmin } from "./auth.ts";
import { getProjectConfig, PRESETS } from "./projectConfig.ts";
import { overlayLaneLabels } from "./scriptureLane.ts";
import { scriptureLaneRoutes } from "./scriptureLaneRoutes.ts";
import { applyProjectConfig, applyProjectMode } from "./projectConfigApply.ts";

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
  // Hidden presets (custom-gl) are dropped from the *selectable* list — they
  // can never pass the completeness guard on their own. When one IS the
  // active preset, publish a synthetic "current" entry instead (org/labels
  // from the ACTIVE materialized config, not the hidden template's blanks) so
  // the client's Select always has a matching value.
  const selectable = Object.values(PRESETS)
    .filter((p) => !p.hidden)
    .map((p) => ({
      preset: p.preset,
      org: p.org,
      languageCode: p.languageCode,
      languageName: p.languageName,
      languageTitle: p.languageTitle,
      direction: p.direction,
      reposVerified: p.reposVerified,
      isTranslation: p.translationSource !== null,
    }));
  const activePreset = PRESETS[cfg.preset];
  const presets =
    activePreset?.hidden
      ? [
          ...selectable,
          {
            preset: cfg.preset,
            org: cfg.org,
            languageCode: cfg.languageCode,
            languageName: cfg.languageName,
            languageTitle: cfg.languageTitle,
            direction: cfg.direction,
            reposVerified: cfg.reposVerified,
            isTranslation: cfg.translationSource !== null,
          },
        ]
      : selectable;
  return c.json({ config: cfg, presets });
});

// Loose shape check for translationSource only when the key is present
// (custom-gl's stricter isIdent/completeness guard runs in applyProjectConfig).
const TranslationSourceShape = z
  .object({
    org: z.string(),
    languageCode: z.string(),
    // Per-resource value is a bare repo string OR an { org?, repo } ref (a
    // resource sourced from a different org via a pasted Door43 URL). Loose here;
    // custom-gl's stricter isIdent guard runs in validateCustomGlOverrides.
    repos: z.record(
      z.string(),
      z.union([z.string(), z.object({ org: z.string().optional(), repo: z.string() })]),
    ),
  })
  .nullable();

const PutBody = z
  .object({
    preset: z.string().min(1),
    // Partial overrides merged over the preset. Loosely typed here; materialize()
    // in projectConfig.ts only honors known keys, so an unknown key is dropped
    // rather than trusted. Three intents (see resolveOverridesIntent): the field
    // OMITTED preserves/clears per the preset-switch rule, `null` clears them
    // explicitly, an object replaces them.
    overrides: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.overrides && typeof data.overrides === "object" && "translationSource" in data.overrides) {
      const ts = (data.overrides as Record<string, unknown>).translationSource;
      if (!TranslationSourceShape.safeParse(ts).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid_translation_source",
          path: ["overrides", "translationSource"],
        });
      }
    }
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
  try {
    const result = await applyProjectConfig(
      c.env,
      parsed.data.preset,
      parsed.data.overrides as Record<string, unknown> | null | undefined,
    );
    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.error };
      if (result.detail !== undefined) body.detail = result.detail;
      if (result.error === "project_not_empty") {
        body.hint = "This database already holds project data for a different org; one D1 per org/project is the current tenancy model.";
      }
      if (result.error === "lane_busy") {
        body.hint = "Finish or cancel the in-flight scripture source replacement before switching project mode.";
      }
      return c.json(body, result.status);
    }
    return c.json({ config: await overlayLaneLabels(c.env, result.config) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "write_failed", detail: msg }, 500);
  }
});

// Admin-only editor/translator mode toggle. Independent of the preset: it only
// writes the `mode` override, which is identity-preserving (never trips the
// project_not_empty guard), so it succeeds on a populated DB where a full
// preset PUT would be blocked.
const ModeBody = z.object({ mode: z.enum(["authoring", "translation"]) });

projectConfig.patch("/mode", requireAdmin, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = ModeBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.issues }, 400);
  }
  try {
    const cfg = await applyProjectMode(c.env, parsed.data.mode);
    return c.json({ config: await overlayLaneLabels(c.env, cfg) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "write_failed", detail: msg }, 500);
  }
});
