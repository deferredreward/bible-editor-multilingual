// Repair the markdown formatting of notes ALREADY imported from Aquifer.
//
//   POST /api/books/:book/aquifer-repair        (admin only)
//
// Notes imported before the emphasis fix in aquiferConvert.ts carry stray `****`
// runs and words glued together by a swallowed space (arb MRK 3:1 note 197002
// was the reported case; ~18% of Aquifer notes across every language edition
// were affected). Re-running the import (POST /:book/aquifer-drafts) repairs
// untouched drafts — they sit in translation_state 'ai_draft' and are
// replaceable — but a row a translator has since approved ('validated') or
// edited ('edited') is protected there and keeps the damage.
//
// This rewrites those rows in place, and ONLY the rows whose text is still, word
// for word, the converter's own output (planFormattingRepair proves that by
// comparing with emphasis markers and whitespace removed). A note whose wording
// a human changed is counted as `humanEdited` and left alone for a person to
// fix. Nothing else about the row moves: reference, quote, occurrence, support
// reference, and translation_state all stay as they are.

import type { Context } from "hono";
import type { Env } from "./index";
import { currentUserId } from "./auth";
import { BOOK_NUMBERS, fetchText } from "./dcsSources";
import { getProjectConfig } from "./projectConfig.ts";
import { aquiferJsonUrl, aquiferLangFor } from "./aquiferSources.ts";
import { planFormattingRepair, type StoredAquiferRow } from "./aquiferConvert.ts";
import { AQUIFER_SOURCE } from "./aquiferImport.ts";

const PAIRS_PER_BATCH = 20; // each repair is an UPDATE + its gated audit row

export async function aquiferRepairFormatting(
  c: Context<{ Bindings: Env; Variables: { userId?: number } }>,
) {
  const env = c.env;
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const cfg = await getProjectConfig(env);
  const aqLang = aquiferLangFor(cfg.languageCode);
  if (!aqLang) return c.json({ error: "aquifer_language_unavailable", languageCode: cfg.languageCode }, 400);

  // Same lock as the import: a repair must not race a merge over the same book.
  const lock = await env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by) VALUES (?1, ?2, ?3)`,
  ).bind(book, Math.floor(Date.now() / 1000), userId).run();
  if (!lock.meta.changes) return c.json({ error: "import_in_progress", book }, 409);

  try {
    const aqUrl = aquiferJsonUrl(aqLang, book);
    if (!aqUrl) return c.json({ error: "aquifer_book_unnumbered", book }, 400);
    const aqRaw = await fetchText(aqUrl);
    if (!aqRaw) return c.json({ error: "aquifer_book_not_available", book, aqLang }, 404);
    let aqItems: unknown;
    try {
      aqItems = JSON.parse(aqRaw);
    } catch {
      return c.json({ error: "aquifer_json_parse", book, aqLang }, 502);
    }
    if (!Array.isArray(aqItems)) return c.json({ error: "aquifer_json_shape", book }, 502);

    const existing = await env.DB.prepare(
      `SELECT id, version, note, draft_meta_json, pre_draft_json
         FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL`,
    ).bind(book).all<{
      id: string; version: number; note: string | null;
      draft_meta_json: string | null; pre_draft_json: string | null;
    }>();

    const rows: StoredAquiferRow[] = (existing.results ?? []).map((r) => ({
      id: r.id,
      version: r.version,
      note: r.note,
      draftMetaJson: r.draft_meta_json,
      preDraftJson: r.pre_draft_json,
    }));

    const { repairs, report } = planFormattingRepair(rows, aqItems as Parameters<typeof planFormattingRepair>[1], aqLang);
    const dryRun = c.req.query("dryRun") === "1";
    if (dryRun || repairs.length === 0) {
      return c.json({ ok: true, book, aqLang, dryRun, applied: 0, ...report });
    }

    const now = Math.floor(Date.now() / 1000);
    // The version guard is a CAS: if a translator saved between the SELECT and
    // this write, the UPDATE matches nothing and the audit row is skipped with
    // it — their save wins and the row is simply reported as not applied.
    //
    // `updated_by` is deliberately NOT touched (same rule as rows.ts): standing
    // authorship is whoever wrote the note, and a machine formatting repair is
    // not authorship. Leaving it alone also keeps a master-owned row (updated_by
    // NULL) master-owned, so the nightly reimport keeps re-seeding it.
    const updateStmt = env.DB.prepare(
      `UPDATE tn_rows
          SET note = ?3, pre_draft_json = COALESCE(?4, pre_draft_json),
              version = version + 1, updated_at = ?5
        WHERE book = ?1 AND id = ?2 AND deleted_at IS NULL AND version = ?6`,
    );
    // changes() reflects the statement immediately before it in the SAME batch,
    // so the audit row can never land without its write (or vice versa).
    const auditStmt = env.DB.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
        WHERE changes() > 0`,
    );

    const pairs = repairs.map((r) => [
      updateStmt.bind(book, r.id, r.note, r.preDraftJson, now, r.version),
      auditStmt.bind(
        r.id, book, userId, r.version, r.version + 1,
        JSON.stringify({ repair: "formatting", aqLang, note: r.note, before: r.before }), AQUIFER_SOURCE,
      ),
    ]);

    // A D1 failure part-way through leaves the earlier batches committed, so the
    // count has to travel with the error — otherwise the operator cannot tell a
    // no-op failure from a half-done one. Re-running is safe either way: repaired
    // rows come back as alreadyClean.
    let applied = 0;
    for (let i = 0; i < pairs.length; i += PAIRS_PER_BATCH) {
      const slice = pairs.slice(i, i + PAIRS_PER_BATCH);
      let res;
      try {
        res = await env.DB.batch(slice.flat());
      } catch (e) {
        return c.json({
          error: "repair_partial", book, aqLang, applied,
          detail: e instanceof Error ? e.message : String(e),
          ...report,
        }, 500);
      }
      for (let j = 0; j < res.length; j += 2) applied += res[j].meta.changes ?? 0;
    }

    return c.json({ ok: true, book, aqLang, dryRun: false, applied, ...report });
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`).bind(book).run();
  }
}
