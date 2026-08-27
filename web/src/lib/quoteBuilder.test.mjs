// Regression tests for issue #355 — the quote picker / builder walks
// (`collectUhbWords`, `collectTargetTokens`) must descend `\qs`-style
// character wrappers the same way the highlight matchers do, or a
// `\qs`-wrapped `\w` is invisible to the picker while the matcher sees it.
//
// These PARSE REAL USFM with usfm-js rather than hand-building trees —
// hand-building is exactly how #331's inverted-nesting premise slipped
// through twice. The production ULT Selah shape is `\qs → \zaln → \w`
// (wrapper OUTSIDE the milestone); the byte-identical fixture is
// `alignment.test.mjs` Case 1.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/quoteBuilder.test.mjs
// (also picked up by `npm --workspace web run test`)

import usfm from "usfm-js";
import {
  collectTargetTokens,
  buildQuoteFromSelection,
  tokenKey,
  collectSourceWordNodes,
} from "./quoteBuilder.ts";
import { matchSourceTokens } from "./highlight.ts";
import { isCharacterWrapper } from "./usfm.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function verseObjectsOf(rawUsfm, ch, v) {
  const json = usfm.toJSON(rawUsfm);
  return json.chapters[ch][v].verseObjects;
}

// ─── Case A: target side — collectTargetTokens over `\qs → \zaln → \w` ───
{
  console.log("\n[Case A] collectTargetTokens descends the \\qs (Selah) wrapper — production ULT shape");
  const target = String.raw`\id PSA
\c 3
\p
\v 8 \q1 \zaln-s |x-strong="H3068" x-content="יְהוָה"\*\w Salvation belongs to Yahweh|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*. \qs \zaln-s |x-strong="H5542" x-lemma="סֶלָה" x-content="סֶלָה"\*\w Selah|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*\qs*
`;
  const tvo = verseObjectsOf(target, "3", "8");

  // Premise guards — stop the case silently testing the wrong thing if
  // usfm-js ever changes how it nests the wrapper. The `\qs` must be a
  // top-level node and the `\zaln` must sit INSIDE it.
  const qs = tvo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists");
  assert(
    !!qs && Array.isArray(qs.children) && qs.children.some((c) => c && c.tag === "zaln"),
    "premise: the \\zaln milestone sits inside the \\qs wrapper",
  );

  const tokens = collectTargetTokens(tvo);
  // Before the fix the wrapped "Selah" token is skipped → only 1 token.
  assert(tokens.length === 2, `both target tokens collected across the wrapper (got ${tokens.length})`);

  const selah = tokens.find((t) => t.text === "Selah");
  assert(!!selah, "the \\qs-wrapped target word 'Selah' is present in the picker token list");
  assert(!!selah && selah.sources.length === 1, "'Selah' carries its single \\zaln source ancestor");
  assert(
    !!selah && selah.sources[0] && selah.sources[0].content === "סֶלָה",
    "'Selah' resolves to source content סֶלָה",
  );
  assert(
    !!selah && selah.sources[0] && selah.sources[0].key === tokenKey("סֶלָה", 1),
    "'Selah' source ancestor key matches tokenKey(סֶלָה, 1)",
  );

  // Control — the unwrapped sibling token in the SAME verse is unchanged.
  const salvation = tokens.find((t) => t.text.startsWith("Salvation"));
  assert(!!salvation, "control: the unwrapped 'Salvation…' token still collects");
  assert(
    !!salvation && salvation.sources[0] && salvation.sources[0].content === "יְהוָה",
    "control: unwrapped token still resolves to יְהוָה",
  );
}

// ─── Case B: source side — collectUhbWords over a `\qs`-wrapped UHB \w ───
{
  console.log("\n[Case B] collectUhbWords / buildQuoteFromSelection descend a \\qs-wrapped source word");
  const source = String.raw`\id PSA
\c 3
\v 8 \w שׁוֹמֵר|x-strong="H8104" x-occurrence="1" x-occurrences="1"\w* \qs \w סֶלָה|x-strong="H5542" x-occurrence="1" x-occurrences="1"\w*\qs*
`;
  const svo = verseObjectsOf(source, "3", "8");

  const qs = svo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists on the source side");

  // Select ONLY the wrapped word by its key. Before the fix collectUhbWords
  // never yields סֶלָה, so the selection filters to empty and the builder
  // returns null; after the fix it round-trips to the quote סֶלָה @ occ 1.
  const wrapped = buildQuoteFromSelection(svo, new Set([tokenKey("סֶלָה", 1)]));
  assert(!!wrapped, "buildQuoteFromSelection resolves the \\qs-wrapped source word");
  assert(!!wrapped && wrapped.quote === "סֶלָה", `built quote is סֶלָה (got ${wrapped && JSON.stringify(wrapped.quote)})`);
  assert(!!wrapped && wrapped.occurrence === 1, "built quote occurrence is 1");

  // Control — the unwrapped word still builds, before and after the fix.
  const plain = buildQuoteFromSelection(svo, new Set([tokenKey("שׁוֹמֵר", 1)]));
  assert(!!plain && plain.quote === "שׁוֹמֵר", "control: the unwrapped source word still builds");

  // Both together, in document order, joined by the disjoint-run gap (they
  // are non-consecutive because the wrapper sits between them positionally
  // only in text; collectUhbWords flattens both into one run since no other
  // \w intervenes) — proves the wrapped word takes a real document position.
  const both = buildQuoteFromSelection(
    svo,
    new Set([tokenKey("שׁוֹמֵר", 1), tokenKey("סֶלָה", 1)]),
  );
  assert(!!both && both.quote === "שׁוֹמֵר סֶלָה", `both words join in order (got ${both && JSON.stringify(both.quote)})`);
}

// ─── Case C: a wrapper-less tree is untouched ───────────────────────────
{
  console.log("\n[Case C] control — a verse with no \\qs takes the identical path");
  const target = String.raw`\id PSA
\c 1
\p
\v 1 \zaln-s |x-strong="H0835" x-content="אַשְׁרֵי"\*\w Blessed|x-occurrence="1" x-occurrences="1"\w*\zaln-e\*
`;
  const tvo = verseObjectsOf(target, "1", "1");
  const tokens = collectTargetTokens(tvo);
  assert(tokens.length === 1 && tokens[0].text === "Blessed", "wrapper-less target verse collects unchanged");
}

// ─── Case D (issue #364): the shared source-word walk `collectSourceWordNodes`
//     descends the `\qs` wrapper, keeps every word's document position, and its
//     order matches `matchSourceTokens`. This is the ONE traversal the picker
//     chips (QuoteBuilderPopper) and the flows spine (VerseSpineModel) now
//     project off, so a drift here is a drift in both.
{
  console.log("\n[Case D] collectSourceWordNodes descends \\qs; positions align with matchSourceTokens (#364)");
  // plain — wrapped — plain, so a dropped/shifted wrapped word would misplace
  // the word AFTER it (the exact #354 divergence this closes).
  const source = String.raw`\id PSA
\c 3
\v 8 \w אֶחָד|x-strong="H0259" x-occurrence="1" x-occurrences="1"\w* \qs \w סֶלָה|x-strong="H5542" x-occurrence="1" x-occurrences="1"\w*\qs* \w שָׁלוֹם|x-strong="H7965" x-occurrence="1" x-occurrences="1"\w*
`;
  const svo = verseObjectsOf(source, "3", "8");

  const qs = svo.find((o) => o && o.tag === "qs");
  assert(!!qs, "premise: a top-level \\qs node exists");
  assert(!!qs && isCharacterWrapper(qs), "premise: the \\qs node is a character wrapper");

  const nodes = collectSourceWordNodes(svo);
  const texts = nodes.map((n) => String(n.node.text ?? ""));
  const positions = nodes.map((n) => n.position);
  // Before the fix the popper/spine copies skipped the wrapper → 2 words and a
  // gap at position 1.
  assert(nodes.length === 3, `all three source words collected across the wrapper (got ${nodes.length})`);
  assert(
    texts.join("|") === "אֶחָד|סֶלָה|שָׁלוֹם",
    `words are in document order incl. the wrapped one (got ${texts.join("|")})`,
  );
  assert(positions.join(",") === "0,1,2", `positions are contiguous 0..2 (got ${positions.join(",")})`);

  // The wrapped word sits at position 1 and the word AFTER it at 2 — no drift.
  const selahPos = nodes.findIndex((n) => n.node.text === "סֶלָה");
  const shalomPos = nodes.findIndex((n) => n.node.text === "שָׁלוֹם");
  assert(selahPos === 1 && shalomPos === 2, `wrapped word at 1, following word at 2 (got ${selahPos}, ${shalomPos})`);

  // matchSourceTokens walks the SAME order (it uses the wrapper-aware
  // collectBareWords). A quote spanning the wrapper boundary resolves the two
  // words adjacently, matching their consecutive positions above.
  const m = matchSourceTokens(svo, "סֶלָה שָׁלוֹם", 1);
  assert(m.length === 2, `matchSourceTokens spans the wrapper boundary (got ${m.length})`);
  assert(
    m.map((t) => t.text).join("|") === "סֶלָה|שָׁלוֹם",
    `matcher order matches the walk across the wrapper (got ${m.map((t) => t.text).join("|")})`,
  );
  assert(shalomPos === selahPos + 1, "walk adjacency matches the matcher's adjacency");
}

// ─── Case E (issue #364, item 2): a CHILDLESS \qs parks its text on the wrapper
//     node itself, so the renderer must emit that text — the walk finds no \w.
//     This is the parsed-USFM premise behind the HebrewLine.tsx fix (the render
//     itself is a browser check; the node runner can't mount React/JSX).
{
  console.log("\n[Case E] childless / unclosed \\qs parks its text on the node, no \\w child (#364 item 2)");
  const closed = verseObjectsOf(
    String.raw`\id PSA
\c 3
\v 8 \w foo|x-occurrence="1" x-occurrences="1"\w* \qs Selah\qs*
`,
    "3",
    "8",
  );
  const closedQs = closed.find((o) => o && o.tag === "qs");
  assert(!!closedQs && isCharacterWrapper(closedQs), "premise: childless \\qs is a character wrapper");
  assert(closedQs.text === "Selah", `childless \\qs carries its text on the node (got ${JSON.stringify(closedQs && closedQs.text)})`);
  assert(
    !Array.isArray(closedQs.children) || closedQs.children.length === 0,
    "childless \\qs has no children — descending children alone renders nothing",
  );
  // The wrapper is not a \w, so the source-word walk yields nothing for it: the
  // text is only recoverable by emitting the wrapper node's own `text`.
  assert(
    collectSourceWordNodes(closed).every((n) => n.node.text !== "Selah"),
    "the walk yields no word for a childless-wrapper's text (renderer must emit node.text)",
  );

  const unclosed = verseObjectsOf(
    String.raw`\id PSA
\c 3
\v 8 \w foo|x-occurrence="1" x-occurrences="1"\w* \qs Selah
`,
    "3",
    "8",
  );
  const unclosedQs = unclosed.find((o) => o && o.tag === "qs");
  assert(!!unclosedQs && isCharacterWrapper(unclosedQs), "premise: unclosed \\qs is still a character wrapper");
  assert(
    typeof unclosedQs.text === "string" && unclosedQs.text.startsWith("Selah"),
    `unclosed \\qs also parks its text on the node (got ${JSON.stringify(unclosedQs && unclosedQs.text)})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll quoteBuilder \\qs-wrapper regression assertions passed.");
