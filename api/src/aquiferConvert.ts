// Pure converter: Aquifer translationNotes JSON -> resolved notes to merge onto
// the unfoldingWord/en_tn skeleton. Split out (like translateOptions.ts) so it
// runs under the node strip-types test runner without importing the Hono modules.
//
// LANGUAGE-AGNOSTIC. Every Aquifer language edition shares the same schema, the
// same per-verse ordinal (#N), and the same embedded original-language quote
// (Greek/Hebrew). Only the note prose differs. So one converter serves all.
//
// Join strategy (validated by scripts/aquifer-join-census.mjs over all 47 books,
// arb + hin): QUOTE-PRIMARY, ordinal-fallback, and unmatched notes still returned
// (minted downstream) so nothing is silently dropped.
//  - The embedded quote is the only language-independent correctness anchor.
//  - The (#N) ordinal is reliable in Arabic but SCRAMBLED in Hindi, so it is
//    only a fallback, never the primary key.
//  - Hebrew-OT quotes often quote a different/longer span than en_tn, so those
//    fall to the ordinal fallback and are flagged for human review.

export type AquiferItem = {
  content_id?: string | number;
  title?: string;
  index_reference?: string;
  content?: string;
  associations?: { passage?: Array<{ start_ref_usfm?: string; end_ref_usfm?: string }> };
};

// One en_tn TSV row (canonical header: Reference/ID/Tags/SupportReference/Quote/Occurrence/Note).
export type EnRow = {
  Reference: string;
  ID: string;
  Tags: string;
  SupportReference: string;
  Quote: string;
  Occurrence: string;
  Note: string;
};

export type JoinMethod = "quote" | "ordinal" | "intro" | "unmatched" | null;

// One resolved Aquifer note. Matched notes carry the en_tn row's sticky id and
// structural columns (alignment works); unmatched notes have enId=null (the
// importer mints an id) and carry Aquifer's own extracted quote.
export type ResolvedNote = {
  ref: string;
  enId: string | null;
  quote: string | null;
  occurrence: number | null;
  supportReference: string | null;
  tags: string | null;
  note: string; // translated markdown
  joinMethod: JoinMethod;
  reviewReason: string | null; // non-null -> flag (review_kind/review_reason)
  aquiferContentId: string | null;
};

export type ConvertReport = {
  enRows: number;
  aqItems: number;
  matchedQuote: number;
  matchedOrdinal: number;
  matchedIntro: number;
  unmatched: number;
  flagged: number;
};

// ---------- small pure helpers (exported for unit tests) ----------

export const nfc = (s: string | null | undefined): string =>
  (s || "").normalize("NFC").trim();

const DIGIT_MAP: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  DIGIT_MAP[String.fromCharCode(0x0660 + i)] = String(i); // Arabic-indic ٠-٩
  DIGIT_MAP[String.fromCharCode(0x0966 + i)] = String(i); // Devanagari ०-९
}
const normDigits = (s: string): string =>
  s.replace(/[٠-٩०-९]/g, (d) => DIGIT_MAP[d] ?? d);

// The (#N) marker's `#` precedes the digits in most books but FOLLOWS them in
// some (an RTL rendering flip, e.g. arb Titus "(1#)"). Match either order.
export function ordinalOf(title: string | undefined): number | null {
  const m = /#\s*([0-9٠-٩०-९]+)|([0-9٠-٩०-९]+)\s*#/.exec(title || "");
  if (!m) return null;
  const n = parseInt(normDigits(m[1] ?? m[2] ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

// The embedded original-language quote: the first span forced to a text
// direction (ltr=Greek, rtl=Hebrew) inside the note HTML.
export function embeddedQuote(html: string | undefined): string {
  const m = /direction:\s*(?:ltr|rtl)[^>]*>([\s\S]*?)<\/span>/.exec(html || "");
  return m ? nfc(m[1].replace(/<[^>]+>/g, "")) : "";
}

// Reference of an Aquifer item, in en_tn Reference notation.
//  - book intro (index BB000000)      -> "front:intro"
//  - chapter intro (letters in index) -> "<ch>:intro"   (passage is "BOOK ch:1")
//  - verse / range                    -> "ch:v" or "ch:v-v2"
export function aquiferRef(it: AquiferItem): { ref: string; isIntro: boolean } | null {
  const idx = it.index_reference || "";
  const passage = it.associations?.passage?.[0];
  const startUsfm = passage?.start_ref_usfm || "";
  const endUsfm = passage?.end_ref_usfm || "";
  if (/^\d{2}000000$/.test(idx)) return { ref: "front:intro", isIntro: true };
  const start = startUsfm.includes(" ") ? startUsfm.split(" ", 2)[1] : "";
  // Chapter intros carry a NON-NUMERIC index (e.g. "08Ruth000"); a verse RANGE
  // index is digits + hyphen ("64001006-64001007") and is NOT an intro.
  if (/[A-Za-z]/.test(idx)) {
    const ch = start.split(":")[0];
    return ch ? { ref: `${ch}:intro`, isIntro: true } : null;
  }
  if (!start) return null;
  const end = endUsfm.includes(" ") ? endUsfm.split(" ", 2)[1] : "";
  if (end && end !== start) {
    const [sc, sv] = start.split(":");
    const [ec, ev] = end.split(":");
    return { ref: sc === ec ? `${sc}:${sv}-${ev}` : start, isIntro: false };
  }
  return { ref: start, isIntro: false };
}

// ---------- HTML -> markdown for the note body ----------

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// Convert one Aquifer note's HTML to uW-style markdown.
//  - Verse notes: drop the leading original-language quote paragraph (that lives
//    in the inherited Quote column) and the trailing "(See: <TA>)" paragraph(s)
//    (that lives in the inherited SupportReference column); keep the prose.
//  - Intros: keep the full structure (headings/lists); they have no quote column.
export function htmlToMarkdown(html: string, opts?: { isIntro?: boolean }): string {
  let s = html || "";
  const isIntro = opts?.isIntro ?? false;

  if (!isIntro) {
    s = s.replace(/^\s*<p>\s*(?:<strong>)?\s*<span[^>]*direction:\s*(?:ltr|rtl)[\s\S]*?<\/span>\s*(?:<\/strong>)?\s*<\/p>/i, "");
    // Strip trailing "(See: <TA>)" paragraph(s). Tempered `(?!</p>)` keeps each
    // match inside one <p>…</p>, so a See-line with several TA links (or other
    // inline tags) is still removed whole instead of leaking into the prose.
    let prev: string;
    do {
      prev = s;
      s = s.replace(/<p>(?:(?!<\/p>)[\s\S])*?data-bnType="resourceReference"(?:(?!<\/p>)[\s\S])*?<\/p>\s*$/i, "");
    } while (s !== prev);
  }

  s = s
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${strip(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${strip(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${strip(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${strip(t)}\n`)
    .replace(/<\/(?:ol|ul)>/gi, "\n")
    .replace(/<(?:ol|ul)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "");

  s = inline(s);
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inline(s: string): string {
  return s
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, t) => `**${strip(t).trim()}**`)
    .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, t) => `*${strip(t).trim()}*`);
}
function strip(s: string): string {
  return decodeEntities(inline(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// ---------- the join ----------

const FLAG_ORDINAL = "Aquifer note matched by position (quote unverified) — check against the English source";
const FLAG_UNMATCHED = "Aquifer note has no matching English source note — quote/support unverified";

// Resolve every Aquifer note to its best en_tn target. Quote-primary, ordinal-
// fallback; unmatched notes are still returned (with their extracted quote) so
// the importer can mint rows for them. Emits one ResolvedNote per Aquifer item.
export function convertAquiferBook(
  aqItems: AquiferItem[],
  enRows: EnRow[],
): { notes: ResolvedNote[]; report: ConvertReport } {
  const enByRef = new Map<string, EnRow[]>();
  for (const r of enRows) {
    if (!enByRef.has(r.Reference)) enByRef.set(r.Reference, []);
    enByRef.get(r.Reference)!.push(r);
  }

  type AqNote = { ref: string; isIntro: boolean; ord: number | null; quote: string; html: string; contentId: string | null };
  const aqByRef = new Map<string, AqNote[]>();
  let aqCount = 0;
  for (const it of aqItems) {
    const rr = aquiferRef(it);
    if (!rr) continue;
    aqCount++;
    const note: AqNote = {
      ref: rr.ref,
      isIntro: rr.isIntro,
      ord: ordinalOf(it.title),
      quote: embeddedQuote(it.content),
      html: it.content || "",
      contentId: it.content_id != null ? String(it.content_id) : null,
    };
    if (!aqByRef.has(rr.ref)) aqByRef.set(rr.ref, []);
    aqByRef.get(rr.ref)!.push(note);
  }

  const report: ConvertReport = {
    enRows: enRows.length, aqItems: aqCount,
    matchedQuote: 0, matchedOrdinal: 0, matchedIntro: 0, unmatched: 0, flagged: 0,
  };
  const notes: ResolvedNote[] = [];

  const fromEn = (aq: AqNote, en: EnRow, method: JoinMethod, reviewReason: string | null): ResolvedNote => ({
    ref: aq.ref,
    enId: en.ID,
    quote: en.Quote || null,
    occurrence: en.Occurrence === "" || en.Occurrence == null ? null : parseInt(en.Occurrence, 10) || 0,
    supportReference: en.SupportReference || null,
    tags: en.Tags || null,
    note: htmlToMarkdown(aq.html, { isIntro: aq.isIntro }),
    joinMethod: method,
    reviewReason,
    aquiferContentId: aq.contentId,
  });
  const minted = (aq: AqNote): ResolvedNote => ({
    ref: aq.ref,
    enId: null,
    quote: aq.quote || null,
    occurrence: aq.quote ? 1 : null,
    supportReference: null,
    tags: null,
    note: htmlToMarkdown(aq.html, { isIntro: aq.isIntro }),
    joinMethod: "unmatched",
    reviewReason: FLAG_UNMATCHED,
    aquiferContentId: aq.contentId,
  });

  for (const [ref, aqList] of aqByRef) {
    const enList = enByRef.get(ref) || [];
    const claimed = new Array(enList.length).fill(false);
    const pending: AqNote[] = [];

    // Pass 1 — quote match (the correctness anchor).
    for (const aq of aqList) {
      if (aq.isIntro || !aq.quote) { pending.push(aq); continue; }
      let hit = -1;
      for (let j = 0; j < enList.length; j++) {
        if (!claimed[j] && nfc(enList[j].Quote) === aq.quote) { hit = j; break; }
      }
      if (hit >= 0) {
        claimed[hit] = true;
        notes.push(fromEn(aq, enList[hit], "quote", null));
        report.matchedQuote++;
      } else pending.push(aq);
    }

    // Pass 2 — fallback: the note's own ordinal slot, else the next unclaimed en
    // row. Intros are unflagged; positional verse matches are flagged. If no en
    // row remains, the note is unmatched (minted + flagged).
    for (const aq of pending) {
      let j = -1;
      if (aq.ord != null && aq.ord >= 1 && aq.ord <= enList.length && !claimed[aq.ord - 1]) j = aq.ord - 1;
      else j = claimed.indexOf(false);
      if (j < 0) {
        notes.push(minted(aq));
        report.unmatched++;
        report.flagged++;
        continue;
      }
      claimed[j] = true;
      if (aq.isIntro) {
        notes.push(fromEn(aq, enList[j], "intro", null));
        report.matchedIntro++;
      } else {
        notes.push(fromEn(aq, enList[j], "ordinal", FLAG_ORDINAL));
        report.matchedOrdinal++;
        report.flagged++;
      }
    }
  }

  return { notes, report };
}
