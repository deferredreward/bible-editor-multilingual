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
//   QUOTE contains the original-language text (Hebrew for OT, Greek
//   for NT). We use that as `hebrewGuess` (field name predates NT
//   support; still just "the source-language guess") and derive
//   ULT/UST selections from it via the same alignment lookup that
//   drives verse highlighting. Lets a translator tweak the issue
//   type and re-run without retyping English.
//
// Context: prev/next 5 verses within the current chapter; we don't
// fetch neighboring chapters here (spec allows shorter arrays at
// chapter edges).

import type { ChapterPayload, TnRow, TnQuickRequest, VerseDto } from "../sync/api";
import {
  extractTargetSelectionText,
  findSourceForTargetText,
} from "./highlight.ts";
import { GREEK, HEBREW } from "./scriptDetect.ts";
import { shortSupport } from "./supportReference.ts";
import { buildVerseIndex, noteCoveredVerses, verseObjectsOf } from "./verseRange.ts";

const CONTEXT_WINDOW = 5;
const HEBREW_GAP = /[&…]+|\.{3}/g;

// Presence of even one Hebrew char (or, for NT quotes, one Greek char —
// Greek and Coptic U+0370-03FF plus Greek Extended U+1F00-1FFF, e.g.
// βλέπεις) flips us into "regenerate from existing source quote" mode.
// The script regexes live once in sourceSearch.ts.
function hasHebrew(s: string): boolean {
  return HEBREW.test(s);
}

function hasGreek(s: string): boolean {
  return GREEK.test(s);
}

// True when the quote is already in an original-language script
// (Hebrew or Greek) rather than an English support phrase — flips us
// into "regenerate from existing source quote" mode.
export function isOriginalLanguageQuote(s: string): boolean {
  return hasHebrew(s) || hasGreek(s);
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

// Join the scripture text of every verse a note covers into one running string.
// A bridged note (ref_raw e.g. "13:26-27") must feed the AI the same scripture
// the translator sees, not just its leading verse (issue #388). Verses join with
// a plain space rather than a `\v` boundary marker: the marker is USFM plumbing
// that would only add noise to a natural-language prompt — the model reasons over
// running text. Reduces to the single leading verse for the common singleton, so
// non-bridged rows are unchanged.
function joinCoveredText(
  laneIndex: Record<number, VerseDto>,
  coveredVerses: number[],
): string {
  const parts: string[] = [];
  for (const v of coveredVerses) {
    const text = plainOf(laneIndex[v]);
    if (text) parts.push(text);
  }
  return parts.join(" ");
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
  return quote.replace(HEBREW_GAP, " ").replace(/\s+/g, " ").trim();
}

export interface BuildTnQuickRequestError {
  // `hebrew_not_found` is the ENGLISH path's failure: the user typed an
  // English support phrase that doesn't align, so "copy the phrase exactly
  // from the literal text" is actionable advice.
  // `source_quote_not_found` is the SOURCE-LANGUAGE path's failure (added by
  // #339, split out in #346): the quote is already Hebrew/Greek and simply
  // doesn't resolve against the alignment. The English advice is meaningless
  // there, so call sites must render script-appropriate copy — keeping one
  // reason for both paths is what produced the wrong-copy defect.
  reason:
    | "missing_support_reference"
    | "missing_quote"
    | "missing_ult_verse"
    | "missing_ust_verse"
    | "hebrew_not_found"
    | "source_quote_not_found";
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
  const ultIndex = buildVerseIndex(ultByVerse);
  const ustIndex = buildVerseIndex(ustByVerse);
  const ultVerse = ultIndex[row.verse];
  const ustVerse = ustIndex[row.verse];

  // The scripture the AI reasons over spans every verse the note covers (issue
  // #388); selection/hebrewGuess resolution below still anchors on the leading
  // verse's alignment (the quote's occurrence is counted per verse), so only the
  // `verse` context text widens. `noteCoveredVerses` returns `[row.verse]` for a
  // singleton, so ultText/ustText are byte-identical to the old leading-verse
  // `plainOf(ultVerse)` for non-bridged rows.
  const coveredVerses = noteCoveredVerses(row);
  const ultText = joinCoveredText(ultIndex, coveredVerses);
  const ustText = joinCoveredText(ustIndex, coveredVerses);
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

  if (isOriginalLanguageQuote(rawQuote)) {
    // Regenerate path: the row already has an original-language quote
    // (Hebrew or Greek, typically from a previous AI run). Derive
    // English from the same alignment that drives highlighting.
    const occurrence = row.occurrence ?? 1;
    hebrewGuess = cleanSourceQuote(rawQuote);
    // The ULT selection is THE phrase the note is about. A quote that
    // classified as source-language on a single OL char but doesn't
    // resolve to any ULT word — most commonly a mixed English+Greek
    // paste like "the word λόγος" — must fail loudly, exactly as the
    // English path does when it can't align. Falling back to the whole
    // verse (ultText.slice) would silently draft a note about the entire
    // verse while looking like a phrase draft. (#332)
    //
    // Distinct reason from the English path below: the quote is already in an
    // original-language script, so telling the user to "copy the support
    // phrase exactly from the literal text" is not actionable. (#346)
    const ultResolved =
      (ultVo && extractTargetSelectionText(ultVo, rawQuote, occurrence, sourceVo)) || "";
    if (!ultResolved) {
      return { ok: false, error: { reason: "source_quote_not_found" } };
    }
    ultSelection = ultResolved;
    // The UST is a looser, simplified translation whose alignment often
    // doesn't carry the same word run; keep the whole-verse fallback here
    // rather than reject a draft the ULT already anchored.
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
