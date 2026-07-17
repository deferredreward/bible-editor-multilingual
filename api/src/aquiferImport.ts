// Pull a book's translationNotes from Aquifer and MERGE them into the existing
// ar_tn as unapproved drafts, on the current unfoldingWord/en_tn skeleton.
//
//   POST /api/books/:book/aquifer-drafts        (admin only)
//
// Merge-and-preserve (NOT wipe-and-rebuild):
//  - Existing ar_tn notes already in the TARGET language are APPROVED content:
//    they are marked translation_state='validated' and NEVER overwritten.
//  - English-placeholder rows and prior Aquifer/AI drafts are replaceable: an
//    Aquifer note for the same (reference, quote) replaces them.
//  - Aquifer notes that join to an en_tn row inherit its sticky id / quote /
//    occurrence / SupportReference (alignment works). Notes with NO en_tn match
//    are still imported (minted id, Aquifer's own extracted quote, flagged).
//  - Dedup is by (reference, NFC quote): Aquifer never lands a duplicate where an
//    approved note already covers that note.
//
// Provenance is distinct (edit_log source='aquifer', draft_meta_json.source=
// 'aquifer') so drafts read as "Aquifer draft", never AI. The book is stamped
// tn_source='aquifer:<lang>' so the nightly DCS reimport skips tn for it.

import type { Context } from "hono";
import type { Env } from "./index";
import { currentUserId } from "./auth";
import { BOOK_NUMBERS, dcsRawUrl, fetchText } from "./dcsSources";
import { getProjectConfig } from "./projectConfig.ts";
import { makeVerseSortOrder, parseTsv, refParts } from "./importParsers";
import { aquiferJsonUrl, aquiferLangFor } from "./aquiferSources.ts";
import { convertAquiferBook, nfc, type EnRow } from "./aquiferConvert.ts";

export const AQUIFER_SOURCE = "aquifer"; // edit_log.source tag (keeps the AI chip off)
const CHUNK = 40;

// Target-language script detector. A non-Latin target lets us tell a genuine
// translation from an English placeholder by script alone (the Arabic pilot).
// Latin-script GLs return null → caller falls back to "differs from en note".
function targetScriptRegex(languageCode: string): RegExp | null {
  const base = languageCode.split("-")[0];
  const byBase: Record<string, RegExp> = {
    ar: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/,
    fa: /[؀-ۿ]/,
    ur: /[؀-ۿ]/,
    hi: /[ऀ-ॿ]/,
    ne: /[ऀ-ॿ]/,
    mr: /[ऀ-ॿ]/,
    bn: /[ঀ-৿]/,
    ta: /[஀-௿]/,
    zh: /[一-鿿]/,
    ru: /[Ѐ-ӿ]/,
    th: /[฀-๿]/,
  };
  return byBase[base] ?? null;
}

function isTranslatedNote(note: string | null, languageCode: string, enNote: string | undefined): boolean {
  const n = (note ?? "").trim();
  if (!n) return false;
  const re = targetScriptRegex(languageCode);
  if (re) return re.test(n);
  return nfc(n) !== nfc(enNote ?? "");
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = ALPHA + "0123456789";
function mintId(live: Set<string>): string {
  for (let tries = 0; tries < 100; tries++) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    let id = ALPHA[buf[0] % 26];
    for (let i = 1; i < 4; i++) id += ALNUM[buf[i] % 36];
    if (!live.has(id)) { live.add(id); return id; }
  }
  throw new Error("could not mint a free tn id");
}
function pickId(preferred: string | null, live: Set<string>): string {
  if (preferred && !live.has(preferred)) { live.add(preferred); return preferred; }
  return mintId(live);
}

export async function aquiferDrafts(c: Context<{ Bindings: Env; Variables: { userId?: number } }>) {
  const env = c.env;
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const cfg = await getProjectConfig(env);
  if (!cfg.translationSource) {
    return c.json({ error: "not_a_translation_project", detail: "the English root project cannot pull drafts" }, 400);
  }
  const aqLang = aquiferLangFor(cfg.languageCode);
  if (!aqLang) return c.json({ error: "aquifer_language_unavailable", languageCode: cfg.languageCode }, 400);

  const imported = await env.DB.prepare(`SELECT 1 FROM book_imports WHERE book = ?1`).bind(book).first();
  if (!imported) return c.json({ error: "book_not_imported", book, detail: "run POST /api/books/:book/import first" }, 409);

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

    const src = cfg.translationSource;
    const enRaw = await fetchText(dcsRawUrl(env, src.org, src.repos.tn, `tn_${book}.tsv`));
    if (!enRaw) return c.json({ error: "en_tn_fetch_failed", book, org: src.org, repo: src.repos.tn }, 502);
    const enRows: EnRow[] = parseTsv(enRaw).rows.map((r) => ({
      Reference: r["Reference"] ?? "",
      ID: r["ID"] ?? "",
      Tags: r["Tags"] ?? "",
      SupportReference: r["SupportReference"] ?? "",
      Quote: r["Quote"] ?? "",
      Occurrence: r["Occurrence"] ?? "",
      Note: r["Note"] ?? "",
    })).filter((r) => r.ID);
    const enNoteById = new Map(enRows.map((r) => [r.ID, r.Note]));

    const { notes, report } = convertAquiferBook(aqItems as Parameters<typeof convertAquiferBook>[0], enRows);

    const existing = await env.DB.prepare(
      `SELECT id, ref_raw, quote, occurrence, note, translation_state FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL`,
    ).bind(book).all<{ id: string; ref_raw: string; quote: string | null; occurrence: number | null; note: string | null; translation_state: string | null }>();

    // Ids in use for this book INCLUDING soft-deleted rows: the PK is (book,id)
    // and a tombstoned row keeps its slot, so minting/pickId must avoid those ids
    // or the INSERT hits a primary-key constraint. (deleted_at-filtered `existing`
    // is only for classification.)
    const usedIds = new Set(
      ((await env.DB.prepare(`SELECT id FROM tn_rows WHERE book = ?1`).bind(book).all<{ id: string }>()).results ?? [])
        .map((r) => r.id),
    );

    // Dedup/replace key includes occurrence: a verse can carry the SAME quote at
    // occurrence 1 and 2 (distinct notes). Keying on (ref,quote) alone would let
    // an approved occ-1 suppress the occ-2 draft, and collide the two existing
    // rows in replaceableByKey (Map.set overwrite → an orphaned leftover row).
    const key = (ref: string, quote: string | null, occ: number | null) => `${ref}\t${nfc(quote)}\t${occ ?? ""}`;
    const protectedKeys = new Set<string>();
    const approveIds: string[] = [];
    const replaceableByKey = new Map<string, string>();

    for (const row of existing.results ?? []) {
      const st = row.translation_state;
      const k = key(row.ref_raw, row.quote, row.occurrence);
      if (st === "validated" || st === "edited") {
        protectedKeys.add(k);
      } else if (st === "ai_draft") {
        replaceableByKey.set(k, row.id);
      } else if (isTranslatedNote(row.note, cfg.languageCode, enNoteById.get(row.id))) {
        approveIds.push(row.id);
        protectedKeys.add(k);
      } else {
        replaceableByKey.set(k, row.id);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const nextSort = makeVerseSortOrder();
    const stmts: D1PreparedStatement[] = [];

    // 1. Approve existing target-language notes (state flip + publish snapshot).
    for (const id of approveIds) {
      stmts.push(
        env.DB.prepare(
          `UPDATE tn_rows SET translation_state = 'validated',
             pre_draft_json = json_object('note', note, 'tags', tags), updated_at = ?3
           WHERE book = ?1 AND id = ?2 AND translation_state IS NULL`,
        ).bind(book, id, now),
      );
    }

    // 2. Merge Aquifer notes.
    const insertStmt = env.DB.prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note,
          version, updated_by, updated_at, sort_order, preserve,
          translation_state, draft_meta_json, pre_draft_json, review_kind, review_reason)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, 1,?11,?12,?13,1, 'ai_draft',?14,?15,?16,?17)`,
    );
    const auditStmt = env.DB.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
    );
    const counts = { inserted: 0, replaced: 0, skippedApproved: 0 };

    for (const note of notes) {
      const k = key(note.ref, note.quote, note.occurrence);
      if (protectedKeys.has(k)) { counts.skippedApproved++; continue; }

      const replacedId = replaceableByKey.get(k);
      if (replacedId) {
        stmts.push(env.DB.prepare(`DELETE FROM tn_rows WHERE book = ?1 AND id = ?2`).bind(book, replacedId));
        usedIds.delete(replacedId);
        replaceableByKey.delete(k);
        counts.replaced++;
      }

      const id = pickId(note.enId, usedIds);
      const [ch, v] = refParts(note.ref);
      const draftMeta = JSON.stringify({
        source: AQUIFER_SOURCE, aqLang, aquiferContentId: note.aquiferContentId, joinMethod: note.joinMethod,
      });
      const preDraft = JSON.stringify({ note: "", tags: null });
      const reviewKind = note.reviewReason ? "aquifer_unverified" : null;
      stmts.push(
        insertStmt.bind(
          id, book, ch, v, note.ref,
          note.tags, note.supportReference, note.quote, note.occurrence, note.note,
          userId, now, nextSort(ch, v),
          draftMeta, preDraft, reviewKind, note.reviewReason,
        ),
        auditStmt.bind(id, book, userId, JSON.stringify({ ref: note.ref, source: AQUIFER_SOURCE }), AQUIFER_SOURCE),
      );
      counts.inserted++;
    }

    // 3. Mark tn provenance so the DCS reimport skips tn for this book.
    stmts.push(
      env.DB.prepare(`UPDATE book_imports SET tn_source = ?2 WHERE book = ?1`).bind(book, `${AQUIFER_SOURCE}:${aqLang}`),
    );

    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }

    return c.json({ ok: true, book, aqLang, approved: approveIds.length, ...counts, report });
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`).bind(book).run();
  }
}
