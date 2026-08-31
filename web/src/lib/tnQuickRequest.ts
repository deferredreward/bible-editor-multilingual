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
// Context: prev/next 5 verses within the current chapter, bracketing the
// verses the note covers rather than its leading verse — a bridged note's
// trailing verses are already in `verse`, so repeating them as context would
// send the same scripture twice (#411). We don't fetch neighboring chapters
// here (spec allows shorter arrays at chapter edges).

import type { ChapterPayload, TnRow, TnQuickRequest, VerseDto } from "../sync/api";
import {
  extractTargetSelectionText,
  findSourceForTargetText,
} from "./highlight.ts";
import { GREEK, HEBREW } from "./scriptDetect.ts";
import { shortSupport } from "./supportReference.ts";
import {
  buildVerseIndex,
  clampCoveredForRender,
  noteCoveredVerses,
  verseObjectsOf,
} from "./verseRange.ts";

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
//
// Dedupes by DTO identity: when the lane row is itself a USFM bridge (`verse_end`),
// buildVerseIndex maps every integer in its span to the SAME DTO reference, so a
// note covering "26-27" reads keys 26 and 27 — both the one bridge object — and a
// naive per-verse join would append its whole text twice (#388). Same guard the
// slice builder uses (`coveredLaneSlices` in verseRange.ts).
//
// Returns the rows it consumed alongside the text: `gatherContext` skips them so
// a lane row that straddles the edge of the covered range (a `\v 24-26` bridge
// under a note covering 26-27) can't be emitted a second time as context (#411).
function joinCoveredText(
  laneIndex: Record<number, VerseDto>,
  coveredVerses: number[],
): { text: string; used: Set<VerseDto> } {
  const parts: string[] = [];
  const used = new Set<VerseDto>();
  for (const v of coveredVerses) {
    const dto = laneIndex[v];
    if (!dto || used.has(dto)) continue;
    used.add(dto);
    const text = plainOf(dto);
    if (text) parts.push(text);
  }
  return { text: parts.join(" "), used };
}

// Prev/next context verses AROUND the covered range — never inside it. The
// `verse` field already carries every covered verse joined, so anchoring both
// windows to the leading verse handed the AI verse 27 twice for a bridged
// "13:26-27" note: once inside `ult.verse`, once as `next5[0]` (#411). Anchor
// prev5 before the FIRST rendered verse and next5 after the LAST one, and skip
// any row the join already consumed.
//
// `byVerse` is deliberately the RAW per-version map (keyed by verse_start), not
// the expanded index: an expanded index repeats a `\v 28-30` row under three
// keys, which would push the same text into next5 three times — the duplication
// this function exists to avoid.
//
// A discontinuous ref ("13:26,30") leaves its interior verses (27-29) out of
// both the covered join and this window. That matches what the lanes render — a
// discontinuous note paints only its listed verses — so context stays "what
// surrounds the card", not "what fills its gaps".
function gatherContext(
  byVerse: Record<number, VerseDto> | undefined,
  firstVerse: number,
  lastVerse: number,
  used: Set<VerseDto>,
): { prev5: string[]; next5: string[] } {
  if (!byVerse) return { prev5: [], next5: [] };
  const prev5: string[] = [];
  for (let v = Math.max(1, firstVerse - CONTEXT_WINDOW); v < firstVerse; v++) {
    const dto = byVerse[v];
    if (!dto || used.has(dto)) continue;
    const text = plainOf(dto);
    if (text) prev5.push(text);
  }
  const next5: string[] = [];
  for (let v = lastVerse + 1; v <= lastVerse + CONTEXT_WINDOW; v++) {
    const dto = byVerse[v];
    if (!dto) break;
    if (used.has(dto)) continue;
    const text = plainOf(dto);
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
  //
  // Capped at LANE_RENDER_CAP, the same bound (and the same helper) #385 put on
  // what one note card paints into a lane. `ref_raw` is free-typed, so a typo
  // like "13:26-1000" would otherwise join the entire chapter into the prompt —
  // NOTE_SPAN_CAP (400) only bounds the Set-building work, not the payload. The
  // clamp keeps the head of the list, so the leading verse (which every
  // selection/alignment lookup below anchors on) always survives, and the AI
  // never receives more scripture than the card shows.
  const coveredVerses = clampCoveredForRender(noteCoveredVerses(row)).verses;
  const ult = joinCoveredText(ultIndex, coveredVerses);
  const ust = joinCoveredText(ustIndex, coveredVerses);
  const ultText = ult.text;
  const ustText = ust.text;
  if (!ultText) return { ok: false, error: { reason: "missing_ult_verse" } };
  if (!ustText) return { ok: false, error: { reason: "missing_ust_verse" } };

  const ultVo = verseObjectsOf(ultVerse);
  const ustVo = verseObjectsOf(ustVerse);
  // The UST whole-verse SELECTION fallback (used when the UST alignment carries
  // no matching run) must stay anchored to the leading verse, even though
  // ust.verse context now spans the whole covered range (#388). ustText widened
  // to the joined range, so slicing it would hand the AI the entire bridge as the
  // "selection"; the quote's occurrence is counted per verse against the leading
  // verse, so the leading verse's text is the correct fallback scope. Identical to
  // ustText for a singleton note (noteCoveredVerses is `[verse]`), so non-bridged
  // rows are unchanged.
  //
  // Falls back to the joined range only when the UST lane has no row at the
  // leading verse at all (a bridged note over an incomplete UST). Handing the bot
  // the wider text is still better than handing it an empty selection, which is
  // what the bare `plainOf(ustVerse)` produced there — the whole point of keeping
  // a whole-verse fallback is to let the bot work rather than reject a draft the
  // ULT already anchored (#411).
  const ustLeadText = plainOf(ustVerse) || ustText;
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
      ustLeadText.slice(0, 500);
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
      ustLeadText.slice(0, 500);
  }

  // Context brackets the rendered range, not the leading verse: for a bridged
  // note the trailing covered verses are already inside ult.verse/ust.verse.
  // coveredVerses is sorted ascending and always non-empty (noteCoveredVerses
  // seeds it with row.verse), so first/last reduce to row.verse for a singleton.
  const firstCovered = coveredVerses[0] ?? row.verse;
  const lastCovered = coveredVerses[coveredVerses.length - 1] ?? row.verse;
  const ultCtx = gatherContext(ultByVerse, firstCovered, lastCovered, ult.used);
  const ustCtx = gatherContext(ustByVerse, firstCovered, lastCovered, ust.used);

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
