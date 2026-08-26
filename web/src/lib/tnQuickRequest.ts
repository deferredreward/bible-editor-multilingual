// Build a TnQuickRequest payload from a translation-note row and the
// chapter it lives in. Pure — all the data the bot needs is already in
// the loaded ChapterPayload, so the Worker can stay a thin proxy.
//
// Two flows depending on what the user has put in the QUOTE field:
//
//   English mode (typical first-time path): user typed the English
//   support phrase from ULT into QUOTE before clicking sparkles. The
//   English IS `ult.selection`; we look it up against the ULT
//   alignment to derive `hebrewGuess`, then use that Hebrew to find
//   the parallel `ust.selection`. If the English doesn't align to
//   anything, fail fast — the bot would 422 no_rtl on an empty guess
//   and the user deserves a clearer message.
//
//   Source-language mode (regenerate path): after the AI has run once,
//   QUOTE contains the original-language quote — Hebrew (OT) or Greek
//   (NT). We use it as `hebrewGuess` (name kept for the bot contract) and
//   derive ULT/UST selections from it via the same alignment lookup that
//   drives verse highlighting. Lets a translator tweak the issue type and
//   re-run without retyping English.
//
// Context: prev/next 5 verses within the current chapter; we don't
// fetch neighboring chapters here (spec allows shorter arrays at
// chapter edges).

import type { ChapterPayload, TnRow, TnQuickRequest, VerseDto } from "../sync/api";
import {
  extractTargetSelectionText,
  findSourceForTargetText,
} from "./highlight.ts";
import { shortSupport } from "./supportReference.ts";
import { buildVerseIndex } from "./verseRange.ts";

const CONTEXT_WINDOW = 5;
const SOURCE_GAP = /[&…]+|\.{3}/g;
// Original-language Unicode ranges: Hebrew (U+0590–U+05FF), Greek and Coptic
// (U+0370–U+03FF), and Greek Extended (U+1F00–U+1FFF). Presence of even one
// such char flips us into "regenerate from the existing source-language quote"
// mode. Greek matters because NT (UGNT) notes carry Greek quotes — without it
// every quoted NT note fell through to the English path and aborted as
// hebrew_not_found (Redo broken for the whole New Testament).
const SOURCE_LANG_CHAR = /[\u0590-\u05FF\u0370-\u03FF\u1F00-\u1FFF]/;

// True when the quote is written in an original language (Hebrew or Greek),
// i.e. this is the "regenerate from the existing source quote" path rather
// than the "user typed English support text" path.
export function hasSourceLangQuote(s: string): boolean {
  return SOURCE_LANG_CHAR.test(s);
}

function extractPlainText(verseObjects: unknown[]): string {
  let out = "";
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      const type = o["type"];
      if (type === "text") {
        out += String(o["text"] ?? "");
      } else if (type === "word") {
        out += String(o["text"] ?? "");
      } else if (type === "milestone") {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return out.replace(/\s+/g, " ").trim();
}

function plainOf(v: VerseDto | undefined): string {
  if (!v) return "";
  if (v.plain_text) return v.plain_text;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? extractPlainText(vo) : "";
}

function verseObjectsOf(v: VerseDto | undefined): unknown[] | null {
  if (!v) return null;
  const vo = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

function gatherContext(
  byVerse: Record<number, VerseDto> | undefined,
  verse: number,
): { prev5: string[]; next5: string[] } {
  if (!byVerse) return { prev5: [], next5: [] };
  const prev5: string[] = [];
  for (let v = Math.max(1, verse - CONTEXT_WINDOW); v < verse; v++) {
    const text = plainOf(byVerse[v]);
    if (text) prev5.push(text);
  }
  const next5: string[] = [];
  for (let v = verse + 1; v <= verse + CONTEXT_WINDOW; v++) {
    if (!byVerse[v]) break;
    const text = plainOf(byVerse[v]);
    if (text) next5.push(text);
  }
  return { prev5, next5 };
}

function cleanSourceQuote(quote: string): string {
  return quote.replace(SOURCE_GAP, " ").replace(/\s+/g, " ").trim();
}

export interface BuildTnQuickRequestError {
  reason:
    | "missing_support_reference"
    | "missing_quote"
    | "missing_ult_verse"
    | "missing_ust_verse"
    | "hebrew_not_found";
}

export type BuildTnQuickRequestResult =
  | { ok: true; request: TnQuickRequest }
  | { ok: false; error: BuildTnQuickRequestError };

export function buildTnQuickRequest(
  row: TnRow,
  data: ChapterPayload,
): BuildTnQuickRequestResult {
  if (!row.support_reference) {
    return { ok: false, error: { reason: "missing_support_reference" } };
  }
  const rawQuote = (row.quote ?? "").trim();
  if (!rawQuote) {
    return { ok: false, error: { reason: "missing_quote" } };
  }

  const ultByVerse = data.verses.ULT;
  const ustByVerse = data.verses.UST;
  // Resolve through the expanded index — verses[bv] is keyed by verse_start,
  // so a direct [row.verse] lookup misses bridged ranges (\v 8-9).
  const ultVerse = buildVerseIndex(ultByVerse)[row.verse];
  const ustVerse = buildVerseIndex(ustByVerse)[row.verse];

  const ultText = plainOf(ultVerse);
  const ustText = plainOf(ustVerse);
  if (!ultText) return { ok: false, error: { reason: "missing_ult_verse" } };
  if (!ustText) return { ok: false, error: { reason: "missing_ust_verse" } };

  const ultVo = verseObjectsOf(ultVerse);
  const ustVo = verseObjectsOf(ustVerse);
  // UHB/UGNT verse for OL-anchoring the selection lookups — without it,
  // extractTargetSelectionText permanently degrades to GL-only matching
  // even though the source is already in the payload.
  const sourceVo =
    verseObjectsOf(buildVerseIndex(data.verses.UHB ?? data.verses.UGNT)[row.verse]) ?? undefined;

  let ultSelection: string;
  let ustSelection: string;
  let hebrewGuess: string;

  if (hasSourceLangQuote(rawQuote)) {
    // Regenerate path: the row already has an original-language quote —
    // Hebrew (OT) or Greek (NT) — typically from a previous AI run. Derive
    // English from the same alignment that drives highlighting. `hebrewGuess`
    // keeps its name for the bot request contract but carries either language.
    const occurrence = row.occurrence ?? 1;
    hebrewGuess = cleanSourceQuote(rawQuote);
    ultSelection =
      (ultVo && extractTargetSelectionText(ultVo, rawQuote, occurrence, sourceVo)) ||
      ultText.slice(0, 500);
    ustSelection =
      (ustVo && extractTargetSelectionText(ustVo, rawQuote, occurrence, sourceVo)) ||
      ustText.slice(0, 500);
  } else {
    // English path: user typed English from ULT. The English IS the
    // ULT selection; look it up against ULT alignment for the Hebrew
    // guess, then use the Hebrew to find the parallel UST phrase.
    if (!ultVo) {
      return { ok: false, error: { reason: "hebrew_not_found" } };
    }
    const derivedHebrew = findSourceForTargetText(ultVo, rawQuote);
    if (!derivedHebrew) {
      return { ok: false, error: { reason: "hebrew_not_found" } };
    }
    hebrewGuess = derivedHebrew;
    ultSelection = rawQuote;
    ustSelection =
      (ustVo && extractTargetSelectionText(ustVo, derivedHebrew, 1, sourceVo)) ||
      ustText.slice(0, 500);
  }

  const ultCtx = gatherContext(ultByVerse, row.verse);
  const ustCtx = gatherContext(ustByVerse, row.verse);

  const request: TnQuickRequest = {
    ref: {
      book: row.book,
      chapter: row.chapter,
      verse: row.verse,
    },
    issueType: shortSupport(row.support_reference),
    ult: {
      selection: ultSelection.slice(0, 500),
      verse: ultText,
      context: ultCtx,
    },
    ust: {
      selection: ustSelection.slice(0, 500),
      verse: ustText,
      context: ustCtx,
    },
    hebrewGuess: hebrewGuess.slice(0, 500),
  };

  return { ok: true, request };
}
