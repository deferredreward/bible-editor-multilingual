// UI-string localization override routes (migration 0052; Localization tab in
// the Preferences panel). Interface strings ship as static per-language JSON
// bundled at build time; this is a server-side fast lane layered on top at
// startup (web/src/i18n/overrides.ts applies it via addResourceBundle). Edits
// are exported to drop-in locale JSON and folded back via PR — see the migration
// header for the full lifecycle.
//
//   GET /overrides         — any authed user (everyone benefits from the org's
//                            latest wording); returns all languages at once.
//   PUT /overrides/:lang   — admin-only, If-Match version CAS, mirroring
//                            translationMemory PUT /prefs (0040).

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireAdmin } from "./auth.ts";
import { parseIfMatch } from "./translationMemoryLib.ts";
import { sharedDb } from "./workspaces.ts";

export const l10n = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

type OverrideRow = { lang: string; overrides_json: string; version: number };

// A recursive {namespace:{key:"text"}} bag — object nodes or string leaves only.
// Matches the i18next resource shape so it deep-merges directly. Depth is
// naturally bounded by the locale files (~3 levels); the size cap is the real
// abuse guard.
type L10nBag = { [k: string]: string | L10nBag };
const L10nBagSchema: z.ZodType<L10nBag> = z.lazy(() =>
  z.record(z.string(), z.union([z.string().max(20000), L10nBagSchema])),
);
const MAX_BAG_BYTES = 512 * 1024; // generous: whole en.json is ~40KB

// GET /overrides — any authenticated user (no role gate: every reader picks up
// overrides at boot, but we don't serve them anonymously). Returns a stable
// empty shape when nothing is stored yet.
l10n.get("/overrides", async (c) => {
  if (!currentUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const rows = await sharedDb(c.env).prepare(
    `SELECT lang, overrides_json, version FROM l10n_overrides`,
  ).all<OverrideRow>();
  const overrides: Record<string, L10nBag> = {};
  const versions: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    try {
      overrides[row.lang] = JSON.parse(row.overrides_json) as L10nBag;
    } catch {
      overrides[row.lang] = {};
    }
    versions[row.lang] = row.version;
  }
  return c.json({ overrides, versions });
});

// PUT /overrides/:lang — admin-only. Whole-bag replace for one language with
// If-Match CAS. First write (row absent) is valid only against If-Match: 0 and
// inserts version 1; thereafter the UPDATE bumps version guarded on `expected`.
l10n.put("/overrides/:lang", requireAdmin, async (c) => {
  const lang = c.req.param("lang");
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) {
    return c.json({ error: "invalid_lang" }, 400);
  }
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = L10nBagSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const json = JSON.stringify(parsed.data);
  if (json.length > MAX_BAG_BYTES) return c.json({ error: "too_large" }, 413);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const existing = await sharedDb(c.env).prepare(
    `SELECT lang, overrides_json, version FROM l10n_overrides WHERE lang = ?1`,
  )
    .bind(lang)
    .first<OverrideRow>();

  if (!existing) {
    if (expected !== 0) return c.json({ error: "version_mismatch", current: { version: 0 } }, 409);
    const insertRes = await sharedDb(c.env).prepare(
      `INSERT INTO l10n_overrides (lang, overrides_json, version, updated_at, updated_by)
       VALUES (?1, ?2, 1, ?3, ?4)
       ON CONFLICT(lang) DO NOTHING`,
    )
      .bind(lang, json, now, userId ?? null)
      .run();
    if (!insertRes.meta.changes) {
      // Lost a concurrent first-write race — report the winner as a 409.
      const current = await sharedDb(c.env).prepare(
        `SELECT lang, overrides_json, version FROM l10n_overrides WHERE lang = ?1`,
      )
        .bind(lang)
        .first<OverrideRow>();
      return c.json({ error: "version_mismatch", current }, 409);
    }
    return c.json({ version: 1 });
  }

  const res = await sharedDb(c.env).prepare(
    `UPDATE l10n_overrides
        SET overrides_json = ?1, version = version + 1, updated_at = ?2, updated_by = ?3
      WHERE lang = ?4 AND version = ?5`,
  )
    .bind(json, now, userId ?? null, lang, expected)
    .run();
  if (!res.meta.changes) return c.json({ error: "version_mismatch", current: existing }, 409);
  return c.json({ version: expected + 1 });
});
