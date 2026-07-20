// Note-template translation routes (template_units, migration 0053). Mirrors
// articles.ts's If-Match CAS / 428 / 409 / validate mechanics, applied to
// note templates instead of tW/tA markdown. GET /api/note-templates (the
// existing read-only English sheet proxy) is untouched — this is additive.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { TemplateUnit } from "./types";
import { currentUserId, requireEditor, requireAdmin } from "./auth";
import { syncTemplates } from "./templateSync";

export const templates = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^"?(\d+)"?$/.exec(header.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// GET /api/templates — list unit metadata for the rail (source_md/target_md
// excluded for weight). Ordered by support_ref then sheet_order.
templates.get("/", requireEditor, async (c) => {
  const includeDeleted = c.req.query("includeDeleted") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT template_id, support_ref, type, sheet_order,
            (target_md IS NOT NULL) AS has_target,
            translation_state, version,
            COALESCE(json_extract(draft_meta_json, '$.stale_source'), 0) AS stale_source
       FROM template_units
      WHERE (?1 = 1 OR deleted_at IS NULL)
      ORDER BY support_ref, sheet_order`,
  )
    .bind(includeDeleted ? 1 : 0)
    .all();
  return c.json({ units: rows.results ?? [] });
});

// GET /api/templates/unit?id=... — full unit (source_md + target_md).
templates.get("/unit", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const unit = await c.env.DB.prepare(
    `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<TemplateUnit>();
  if (!unit) return c.json({ error: "not_found" }, 404);
  return c.json(unit);
});

const PatchBody = z.object({ target_md: z.string() });

// PATCH /api/templates/unit?id=... — update the translation. Requires If-Match
// (bare int version); CAS inside the UPDATE; a human edit demotes an AI draft
// (or a validated unit) to 'edited' and clears the stale_source flag left by a
// source-change demotion. 409 on version mismatch, 404 if gone.
templates.patch("/unit", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE template_units
            SET target_md = ?1,
                translation_state = CASE
                  WHEN translation_state IS NULL AND ?1 <> '' THEN 'edited'
                  WHEN translation_state IN ('ai_draft','validated') THEN 'edited'
                  ELSE translation_state END,
                draft_meta_json = CASE
                  WHEN draft_meta_json IS NOT NULL THEN json_remove(draft_meta_json, '$.stale_source')
                  ELSE draft_meta_json END,
                version = version + 1,
                updated_at = ?2,
                updated_by = ?3
          WHERE template_id = ?4 AND deleted_at IS NULL AND version = ?5`,
      )
      .bind(parsed.data.target_md, now, userId ?? null, id, expected),
    c.env.DB
      .prepare(
        // Audit gated on the CAS having won (changes() in the same batch).
        // payload_json carries the full patch so /unit/history can replay it.
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
         SELECT 'template', ?1, NULL, ?2, ?3, ?3 + 1, 'update', NULL, ?4
          WHERE (SELECT changes()) > 0`,
      )
      .bind(id, userId ?? null, expected, JSON.stringify({ target_md: parsed.data.target_md })),
  ]);

  if (!updateRes.meta.changes) {
    // Distinguish 404 (gone) from 409 (version moved on).
    const cur = await c.env.DB.prepare(
      `SELECT version FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
    )
      .bind(id)
      .first<{ version: number }>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const fresh = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
      .bind(id)
      .first<TemplateUnit>();
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  const updated = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
    .bind(id)
    .first<TemplateUnit>();
  return c.json(updated);
});

const ValidateBody = z.object({ value: z.union([z.literal(0), z.literal(1), z.boolean()]) });

// POST /api/templates/unit/validate?id=... — the "Approve" action. value=1 ->
// validated; value=0 -> edited. Non-version-bumping; guarded on
// translation_state IS NOT NULL; audit source=NULL (human approval).
templates.post("/unit/validate", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = ValidateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const state = parsed.data.value === true || parsed.data.value === 1 ? "validated" : "edited";
  const action = state === "validated" ? "validate" : "unvalidate";
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  // Approval snapshots the now-published md into pre_draft_json (mirrors
  // article_units / tn_rows) — a later human edit demotes 'validated' ->
  // 'edited', and export can ship this snapshot until re-approval.
  const snapshotClause = state === "validated"
    ? ", pre_draft_json = json_object('target_md', target_md)"
    : "";
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE template_units SET translation_state = ?1, updated_at = ?2${snapshotClause}
          WHERE template_id = ?3 AND deleted_at IS NULL AND translation_state IS NOT NULL`,
      )
      .bind(state, now, id),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         SELECT 'template', ?1, NULL, ?2, version, version, ?3, NULL
           FROM template_units
          WHERE template_id = ?1 AND deleted_at IS NULL AND translation_state IS NOT NULL`,
      )
      .bind(id, userId ?? null, action),
  ]);
  if (!updateRes.meta.changes) return c.json({ error: "not_found" }, 404);
  const updated = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
    .bind(id)
    .first<TemplateUnit>();
  return c.json(updated);
});

// GET /api/templates/unit/history?id=... — English source revisions
// (template_source_history, newest first) plus the target-side edit history
// replayed from edit_log, in the same response-shape family rows.ts:356
// already produces (so the existing word-diff history UI can render it).
templates.get("/unit/history", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);

  const currentRow = await c.env.DB.prepare(
    `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<TemplateUnit>();
  if (!currentRow) return c.json({ error: "not_found" }, 404);

  const sourceRs = await c.env.DB.prepare(
    `SELECT source_hash, source_md, seen_at FROM template_source_history
      WHERE template_id = ?1 ORDER BY id DESC`,
  )
    .bind(id)
    .all<{ source_hash: string; source_md: string; seen_at: number }>();

  const logRs = await c.env.DB.prepare(
    `SELECT el.new_version AS version,
            el.action,
            el.created_at,
            el.payload_json,
            el.restored_from_version,
            u.id AS user_id,
            u.dcs_username AS username,
            u.dcs_full_name AS full_name
       FROM edit_log el
       LEFT JOIN users u ON u.id = el.user_id
      WHERE el.kind = 'template' AND el.row_key = ?1
        AND el.new_version IS NOT NULL
        AND el.action IN ('update', 'validate', 'unvalidate', 'restore')
      ORDER BY el.new_version ASC`,
  )
    .bind(id)
    .all<{
      version: number;
      action: string;
      created_at: number;
      payload_json: string | null;
      restored_from_version: number | null;
      user_id: number | null;
      username: string | null;
      full_name: string | null;
    }>();

  const logEntries = logRs.results ?? [];
  const hasBaselineAtV1 = logEntries.some((e) => e.version === 1);
  type Entry = (typeof logEntries)[number] & { synthetic?: boolean };
  // A template_units row is always born from the sheet sync with target_md
  // NULL and no edit_log 'create' entry, so the v1 baseline is ALWAYS
  // synthesized — and it must be the empty translation, not currentRow's
  // target_md. Seeding from the current row (as rows.ts does for imported tN
  // rows, which genuinely do have content at v1) would replay the newest text
  // as the oldest snapshot and make every diff wrong.
  const entries: Entry[] = hasBaselineAtV1
    ? logEntries
    : [
        {
          version: 1,
          action: "imported",
          created_at: 0,
          payload_json: JSON.stringify({ target_md: null }),
          restored_from_version: null,
          user_id: null,
          username: null,
          full_name: null,
          synthetic: true,
        },
        ...logEntries.filter((e) => e.version > 1),
      ];

  const snapshot: Record<string, unknown> = {};
  const target = entries.map((e) => {
    let payload: Record<string, unknown> = {};
    if (e.payload_json) {
      try {
        payload = JSON.parse(e.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    for (const k of Object.keys(payload)) snapshot[k] = payload[k];
    return {
      version: e.version,
      action: e.action,
      created_at: e.created_at,
      user: e.user_id ? { id: e.user_id, username: e.username, full_name: e.full_name } : null,
      patch: { target_md: "target_md" in payload ? payload.target_md : undefined },
      snapshot: { target_md: snapshot.target_md ?? null },
      synthetic: e.synthetic ?? false,
      restored_from_version: e.restored_from_version ?? null,
    };
  });

  return c.json({ source: sourceRs.results ?? [], target });
});

// POST /api/templates/sync — manual sync trigger (admin only, mirrors the
// existing requireAdmin guard used elsewhere).
templates.post("/sync", requireAdmin, async (c) => {
  const result = await syncTemplates(c.env);
  return c.json(result);
});
