// Note-template translation sync (migration 0053) — mirrors articlePopulate.ts's
// upsert/drift-detection semantics, applied to the note-templates Google Sheet
// instead of a DCS repo. The sheet stays the single source of truth for the
// English template text; this diffs it into template_units so a translation
// team can work against a stable, version-tracked D1 row per template while
// the sheet keeps evolving underneath.
//
// Sheet columns: A=support reference, B=type, C=note template body,
// D=stable id (e.g. "figs-metaphor-01"). GET /api/note-templates (the existing
// read-only English proxy) is untouched — this is a separate, additive path.

import type { Env } from "./index";
import { SHEET_CSV_URL, fetchSheetCsv, parseCsv } from "./noteTemplates.ts";

const WRITE_ITEM_BATCH = 20; // mirrors articlePopulate.ts's subrequest-budget batching

export { SHEET_CSV_URL };

// ── Pure row parsing (sync — safe to unit test without D1 or crypto) ────────

export interface ParsedTemplateRow {
  templateId: string;
  supportRef: string;
  type: string;
  body: string;
  sheetOrder: number;
}

// Row -> {templateId, supportRef, type, body}, skipping blank ref/body rows
// (same as noteTemplates.ts's buildTemplates).
//
// Identity comes exclusively from column D. If the sheet has no `id` header
// there, `aborted` is returned and the caller MUST make no writes at all: a
// positional fallback id would be a trap, not a kindness. Translations keyed on
// sheet position would be silently orphaned the moment the real ids landed (the
// positional rows soft-delete, fresh untranslated rows insert), and orphaning a
// translator's work is strictly worse than doing nothing until the column
// exists. Same reasoning for an individual row with a blank id: skip + warn.
// A templateId collision keeps the first occurrence and warns about the duplicate.
export function parseTemplateRows(rows: string[][]): {
  rows: ParsedTemplateRow[];
  warnings: string[];
  aborted: boolean;
} {
  const warnings: string[] = [];
  const out: ParsedTemplateRow[] = [];
  const seenIds = new Set<string>();

  const idHeader = (rows[0]?.[3] ?? "").trim().toLowerCase();
  if (idHeader !== "id") {
    return {
      rows: [],
      warnings: [
        `sheet has no "id" header in column D (found "${idHeader}") — sync skipped; ` +
          `run Templates > Stamp missing IDs on the sheet to create it`,
      ],
      aborted: true,
    };
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const supportRef = (r[0] ?? "").trim();
    const body = (r[2] ?? "").trim();
    if (!supportRef || !body) continue;
    const type = (r[1] ?? "").trim();

    const templateId = (r[3] ?? "").trim();
    if (!templateId) {
      warnings.push(`row ${i + 1}: blank template id (support ref "${supportRef}") — row skipped`);
      continue;
    }
    if (seenIds.has(templateId)) {
      warnings.push(`row ${i + 1}: duplicate template id "${templateId}" — keeping first occurrence`);
      continue;
    }
    seenIds.add(templateId);
    out.push({ templateId, supportRef, type, body, sheetOrder: out.length });
  }
  return { rows: out, warnings, aborted: false };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Pure diff/plan (the executable-testable core) ───────────────────────────

export interface SheetRow extends ParsedTemplateRow {
  sourceHash: string;
}

export interface DbTemplateRow {
  template_id: string;
  support_ref: string;
  sheet_order: number | null;
  type: string | null;
  source_md: string;
  source_hash: string;
  translation_state: string | null;
  draft_meta_json: string | null;
  deleted_at: number | null;
}

export interface UpsertAction {
  templateId: string;
  supportRef: string;
  type: string;
  sheetOrder: number;
  sourceMd: string;
  sourceHash: string;
  isNew: boolean;
  hashChanged: boolean; // drives version bump + history row
  clearDeletedAt: boolean;
  demote: boolean; // hashChanged && prior translation_state in (ai_draft, validated)
  draftMetaJson: string | null; // new draft_meta_json when demote; else pass-through unchanged value
}

export interface TemplateSyncPlan {
  upserts: UpsertAction[];
  removeIds: string[];
  unchanged: number;
  warnings: string[];
}

// Diff the freshly-parsed sheet rows against the current template_units table.
// Pure — no D1, no crypto — so it's directly unit-testable.
export function planTemplateSync(sheetRows: SheetRow[], dbRows: DbTemplateRow[]): TemplateSyncPlan {
  const dbById = new Map(dbRows.map((r) => [r.template_id, r]));
  const sheetIds = new Set(sheetRows.map((r) => r.templateId));
  const upserts: UpsertAction[] = [];
  let unchanged = 0;

  for (const row of sheetRows) {
    const existing = dbById.get(row.templateId);
    if (!existing) {
      upserts.push({
        templateId: row.templateId,
        supportRef: row.supportRef,
        type: row.type,
        sheetOrder: row.sheetOrder,
        sourceMd: row.body,
        sourceHash: row.sourceHash,
        isNew: true,
        hashChanged: true,
        clearDeletedAt: false,
        demote: false,
        draftMetaJson: null,
      });
      continue;
    }

    const hashChanged = existing.source_hash !== row.sourceHash;
    const wasDeleted = existing.deleted_at != null;
    // Metadata can move without the body changing — a corrected support ref in
    // column A, a retyped column B, or a row inserted above shifting the order.
    // Those still need writing through or the catalog drifts from the sheet
    // forever, but they are NOT an English revision: no version bump, no
    // history row, no demotion of an approved translation.
    const metaChanged =
      existing.support_ref !== row.supportRef ||
      (existing.type ?? "") !== row.type ||
      existing.sheet_order !== row.sheetOrder;
    if (!hashChanged && !wasDeleted && !metaChanged) {
      unchanged++;
      continue;
    }

    const demote =
      hashChanged &&
      (existing.translation_state === "ai_draft" || existing.translation_state === "validated");
    let draftMetaJson = existing.draft_meta_json;
    if (demote) {
      let meta: Record<string, unknown> = {};
      if (existing.draft_meta_json) {
        try {
          meta = JSON.parse(existing.draft_meta_json) as Record<string, unknown>;
        } catch {
          meta = {};
        }
      }
      meta.stale_source = true;
      meta.prior_source_hash = existing.source_hash;
      draftMetaJson = JSON.stringify(meta);
    }

    upserts.push({
      templateId: row.templateId,
      supportRef: row.supportRef,
      type: row.type,
      sheetOrder: row.sheetOrder,
      sourceMd: row.body,
      sourceHash: row.sourceHash,
      isNew: false,
      hashChanged,
      clearDeletedAt: wasDeleted,
      demote,
      draftMetaJson,
    });
  }

  const removeIds: string[] = [];
  for (const existing of dbRows) {
    if (!sheetIds.has(existing.template_id) && existing.deleted_at == null) {
      removeIds.push(existing.template_id);
    }
  }

  return { upserts, removeIds, unchanged, warnings: [] };
}

// ── D1 write + sync driver ───────────────────────────────────────────────────

export interface SyncTemplatesResult {
  inserted: number;
  revised: number;
  removed: number;
  restored: number;
  unchanged: number;
  warnings: string[];
  aborted: boolean;
}

export interface SyncTemplatesOptions {
  deps?: { fetchCsv?: () => Promise<string> };
}

function upsertStmt(env: Env, u: UpsertAction, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO template_units
       (template_id, support_ref, sheet_order, type, source_md, source_hash, version, translation_state, draft_meta_json, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, NULL, ?7, NULL)
     ON CONFLICT(template_id) DO UPDATE SET
       support_ref = excluded.support_ref,
       sheet_order = excluded.sheet_order,
       type        = excluded.type,
       source_md   = excluded.source_md,
       source_hash = excluded.source_hash,
       version     = template_units.version + (?8),
       translation_state = CASE WHEN ?9 = 1 THEN 'edited' ELSE template_units.translation_state END,
       draft_meta_json   = CASE WHEN ?9 = 1 THEN ?10 ELSE template_units.draft_meta_json END,
       updated_at  = excluded.updated_at,
       deleted_at  = NULL`,
  ).bind(
    u.templateId,
    u.supportRef,
    u.sheetOrder,
    u.type,
    u.sourceMd,
    u.sourceHash,
    now,
    u.hashChanged ? 1 : 0,
    u.demote ? 1 : 0,
    u.draftMetaJson,
  );
}

function historyStmt(env: Env, u: UpsertAction, now: number): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO template_source_history (template_id, source_hash, source_md, support_ref, type, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(u.templateId, u.sourceHash, u.sourceMd, u.supportRef, u.type, now);
}

function removeStmt(env: Env, templateId: string, now: number): D1PreparedStatement {
  return env.DB
    .prepare(`UPDATE template_units SET deleted_at = ?1 WHERE template_id = ?2 AND deleted_at IS NULL`)
    .bind(now, templateId);
}

// Fetch + parse the sheet, diff against template_units, and write the result.
// Never throws on a malformed row (blank id / duplicate id) — those become
// warnings. Writes are batched (WRITE_ITEM_BATCH) to stay under D1's
// subrequest budget for a large sheet.
export async function syncTemplates(
  env: Env,
  opts: SyncTemplatesOptions = {},
): Promise<SyncTemplatesResult> {
  const doFetch = opts.deps?.fetchCsv ?? fetchSheetCsv;
  const csv = await doFetch();
  const { rows: parsed, warnings: parseWarnings, aborted } = parseTemplateRows(parseCsv(csv));

  // No id column -> write NOTHING. Falling through would hand planTemplateSync an
  // empty sheet and soft-delete every existing unit. Still stamp the watermark so
  // the 6h cron gate doesn't re-fetch the sheet every five minutes.
  if (aborted) {
    const result: SyncTemplatesResult = {
      inserted: 0, revised: 0, removed: 0, restored: 0, unchanged: 0,
      warnings: parseWarnings, aborted: true,
    };
    await writeSyncState(env, Math.floor(Date.now() / 1000), result);
    return result;
  }

  const sheetRows: SheetRow[] = await Promise.all(
    parsed.map(async (p) => ({ ...p, sourceHash: await sha256Hex(p.body) })),
  );

  const dbRs = await env.DB.prepare(
    `SELECT template_id, support_ref, sheet_order, type, source_md, source_hash, translation_state, draft_meta_json, deleted_at
       FROM template_units`,
  ).all<DbTemplateRow>();
  const dbRows = dbRs.results ?? [];

  const plan = planTemplateSync(sheetRows, dbRows);

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let revised = 0;
  let restored = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const u of plan.upserts) {
    if (u.isNew) inserted++;
    else {
      if (u.hashChanged) revised++;
      if (u.clearDeletedAt) restored++;
    }
    stmts.push(upsertStmt(env, u, now));
    if (u.hashChanged) stmts.push(historyStmt(env, u, now));
  }
  for (const id of plan.removeIds) stmts.push(removeStmt(env, id, now));

  for (let i = 0; i < stmts.length; i += WRITE_ITEM_BATCH) {
    await env.DB.batch(stmts.slice(i, i + WRITE_ITEM_BATCH));
  }

  const result: SyncTemplatesResult = {
    inserted,
    revised,
    removed: plan.removeIds.length,
    restored,
    unchanged: plan.unchanged,
    warnings: [...parseWarnings, ...plan.warnings],
    aborted: false,
  };

  await writeSyncState(env, now, result);
  return result;
}

function writeSyncState(env: Env, now: number, result: SyncTemplatesResult): Promise<unknown> {
  return env.DB
    .prepare(
      `INSERT INTO template_sync_state (id, last_synced_at, last_result_json) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_result_json = excluded.last_result_json`,
    )
    .bind(now, JSON.stringify(result))
    .run();
}
