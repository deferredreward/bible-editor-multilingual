// Mirror of api/src/alignmentDelta.ts. Keep behavior in sync: the web copy
// prevents optimistic local/outbox writes, and the API copy is the backstop.
export type AlignmentIntent =
  | "text_edit"
  | "find_replace"
  | "section_edit"
  | "alignment_edit";

export interface AlignmentLoss {
  index: number;
  text: string;
  reason: "lost" | "changed_source";
}

export interface AlignmentDelta {
  beforeAligned: number;
  afterAligned: number;
  wordSequenceUnchanged: boolean;
  unexpectedLosses: AlignmentLoss[];
}

interface WordInfo {
  text: string;
  sourceKey: string | null;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").normalize("NFC");
}

function sourcePart(node: Record<string, unknown>): string {
  return [
    normalizedText(node["strong"]),
    normalizedText(node["occurrence"] ?? "1"),
    normalizedText(node["occurrences"] ?? "1"),
    normalizedText(node["content"]),
  ].join("|");
}

function verseObjectsOf(content: unknown): unknown[] {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vos) ? vos : [];
}

export function collectAlignmentWords(content: unknown): WordInfo[] {
  const words: WordInfo[] = [];
  const walk = (nodes: unknown[], sourceChain: string[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const isZaln = o["type"] === "milestone" && o["tag"] === "zaln";
      const nextChain = isZaln ? [...sourceChain, sourcePart(o)] : sourceChain;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push({
          text: normalizedText(o["text"]),
          sourceKey: sourceChain.length > 0 ? sourceChain.join(">") : null,
        });
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children, nextChain);
    }
  };
  walk(verseObjectsOf(content), []);
  return words;
}

function countsByText(words: WordInfo[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word.text, (counts.get(word.text) ?? 0) + 1);
  return counts;
}

function lcsLinks(before: WordInfo[], after: WordInfo[]): number[] {
  const m = before.length;
  const n = after.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i].text === after[j].text
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const links = Array(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i].text === after[j].text) {
      links[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return links;
}

export function analyzeAlignmentDelta(beforeContent: unknown, afterContent: unknown): AlignmentDelta {
  const before = collectAlignmentWords(beforeContent);
  const after = collectAlignmentWords(afterContent);
  const beforeAligned = before.filter((w) => w.sourceKey !== null).length;
  const afterAligned = after.filter((w) => w.sourceKey !== null).length;
  const wordSequenceUnchanged =
    before.length === after.length && before.every((w, i) => w.text === after[i]?.text);
  const unexpectedLosses: AlignmentLoss[] = [];

  // ── Total wipe: the MAXIMUM loss case, not a zero-loss case ────────────────
  // Predicate: the verse HAD aligned words and now has NONE. That is broader
  // than the flatten which motivated it, deliberately — two shapes end with zero
  // surviving alignment, and both used to report ZERO losses:
  //   (a) STRUCTURAL FLATTEN — the tree becomes plain text, no `\w` nodes at all
  //       (the shipped incident below); and
  //   (b) TOTAL REWRITE — `\w` nodes exist, but every aligned word was replaced,
  //       so nothing links and nothing keeps a source.
  // Both paths below score only words that SURVIVE, which is why both shapes
  // escaped: `wordSequenceUnchanged` is false (the lengths differ), so the
  // exact-position path is skipped, and the LCS path `continue`s on
  // `links[i] < 0`. Do NOT read that as "the LCS path never sees a wipe" — it
  // still reports one whenever SOME surface survives as a bare `\w`. Only the
  // no-survivor case went unreported.
  //
  // The incident: a whole-verse-flattening save
  // (`content: { verseObjects: [{ type: "text", text: value }] }`) destroyed 38
  // aligned words on ZEC 1:8 ULT and the API answered 200 — receipt: dev
  // `edit_log` id 1458, `row_key ZEC/1/8/ULT`, v1 → v2, server-recorded delta
  // `{"beforeAligned":38,"afterAligned":0,"unexpectedLosses":[]}`.
  //
  // We report EVERY previously-aligned word as `lost`. This is the one place the
  // module knowingly breaks its own "never blame the word the translator edited"
  // rule (see guardBlocksSave): with no survivors there is nothing to diff
  // against, so an edited word and a collateral casualty are indistinguishable.
  // Reporting all of them is what makes guardBlocksSave fire and what lets
  // `lostAlignedWords` name them in the aligner's unalign confirm — a total
  // unalign used to warn about nothing. The known cost is case (b): rewording
  // every aligned word in a verse is now refused. `text_edit` gets the "Save
  // anyway" confirm (Shell.tsx); `find_replace` has no override and skips that
  // verse. The duplicate-surface ambiguity skip further down is bypassed here
  // too — safe direction (it can only add losses), but the reported list may
  // name repeated surfaces the LCS path would decline to attribute.
  // `alignment_edit` stays exempt, so the aligner panel is unaffected at write
  // time — including Clear all, which unaligns every word and therefore IS a
  // wipe by this predicate.
  if (beforeAligned > 0 && afterAligned === 0) {
    for (let i = 0; i < before.length; i++) {
      if (!before[i].sourceKey) continue;
      unexpectedLosses.push({ index: i, text: before[i].text, reason: "lost" });
    }
    return { beforeAligned, afterAligned, wordSequenceUnchanged, unexpectedLosses };
  }

  if (wordSequenceUnchanged) {
    for (let i = 0; i < before.length; i++) {
      if (!before[i].sourceKey) continue;
      if (!after[i]?.sourceKey) {
        unexpectedLosses.push({ index: i, text: before[i].text, reason: "lost" });
      } else if (after[i].sourceKey !== before[i].sourceKey) {
        unexpectedLosses.push({ index: i, text: before[i].text, reason: "changed_source" });
      }
    }
    return { beforeAligned, afterAligned, wordSequenceUnchanged, unexpectedLosses };
  }

  const beforeCounts = countsByText(before);
  const afterCounts = countsByText(after);
  const links = lcsLinks(before, after);
  for (let i = 0; i < before.length; i++) {
    const oldWord = before[i];
    if (!oldWord.sourceKey) continue;
    const j = links[i];
    if (j < 0) continue;
    // Repeated surfaces are allowed to become ambiguous after real text edits.
    if ((beforeCounts.get(oldWord.text) ?? 0) > 1 || (afterCounts.get(oldWord.text) ?? 0) > 1) {
      continue;
    }
    const newWord = after[j];
    if (!newWord.sourceKey) {
      unexpectedLosses.push({ index: i, text: oldWord.text, reason: "lost" });
    } else if (newWord.sourceKey !== oldWord.sourceKey) {
      unexpectedLosses.push({ index: i, text: oldWord.text, reason: "changed_source" });
    }
  }

  return { beforeAligned, afterAligned, wordSequenceUnchanged, unexpectedLosses };
}

export function intentAllowsUnexpectedAlignmentLoss(intent: AlignmentIntent): boolean {
  return intent === "alignment_edit";
}

// The single enforced predicate: should this save be BLOCKED for collateral
// alignment loss? Both the API PATCH handler (api/src/verses.ts) and the web
// outbox guard (web/src/components/Shell.tsx) call this so there is exactly one
// definition of "too much alignment loss" — and so the tests assert the real
// thing, not a re-derived copy.
//
// DO NOT re-add a `delta.wordSequenceUnchanged` (or any similar) narrowing
// here. That exact narrowing (commit 6980fd72) is what let 1CH 4:21 / NUM 24
// ship: a one-word spelling edit (e.g. Lekah→Lecah) flips
// wordSequenceUnchanged to false, the narrowed guard never fired, and the
// editor collaterally de-aligned untouched neighbors straight onto master.
// analyzeAlignmentDelta's LCS path only reports unexpectedLosses for words that
// existed before AND still exist after (same surface + occurrence) but lost or
// changed their \zaln source — i.e. genuine collateral loss, never the word the
// translator actually edited. ONE deliberate exception: a TOTAL WIPE (the verse
// had aligned words and now has none) leaves no survivors to diff against, so
// the edited word and a collateral casualty are indistinguishable and the wipe
// branch reports all of them. See that branch in analyzeAlignmentDelta for the
// reasoning and its cost. The guard MUST fire on collateral loss regardless
// of whether the word sequence also changed. The only exemption is
// alignment_edit (re-aligning in the aligner panel legitimately changes
// sources).
export function guardBlocksSave(delta: AlignmentDelta, intent: AlignmentIntent): boolean {
  return delta.unexpectedLosses.length > 0 && !intentAllowsUnexpectedAlignmentLoss(intent);
}

// Words that HAD a \zaln source before and are now fully bare (reason "lost"),
// i.e. a previously-aligned word that an alignment_edit just unaligned. This is
// the signal the aligner-panel "you're about to unalign X" confirm fires on —
// alignment_edit is exempt from guardBlocksSave (re-aligning legitimately
// removes/repoints sources), so a silent accidental unlink would otherwise sail
// through and only surface when the nightly export's shrink guard blocks it
// (the JER 30:1 "Jeremiah" incident). `changed_source` (a re-pointed source) is
// excluded — that is normal re-alignment, not a loss worth warning about.
export function lostAlignedWords(beforeContent: unknown, afterContent: unknown): string[] {
  return analyzeAlignmentDelta(beforeContent, afterContent)
    .unexpectedLosses.filter((l) => l.reason === "lost")
    .map((l) => l.text);
}
