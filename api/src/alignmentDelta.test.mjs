import { analyzeAlignmentDelta, guardBlocksSave } from "./alignmentDelta.ts";

let failed = 0;
function assert(ok, msg) {
  if (!ok) {
    failed++;
    console.error("FAIL:", msg);
  }
}

const w = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  type: "milestone",
  tag: "zaln",
  strong,
  occurrence: "1",
  occurrences: "1",
  content: strong,
  children,
});
const content = (verseObjects) => ({ verseObjects });

{
  console.log("[alignmentDelta api] punctuation save cannot drop unchanged alignment");
  const before = content([zaln("H1", [w("He")]), t(" "), zaln("H2", [w("came")])]);
  const after = content([zaln("H1", [w("He")]), t(", "), w("came")]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.wordSequenceUnchanged, "word sequence is unchanged");
  assert(delta.unexpectedLosses.length === 1, "one unchanged word lost alignment");
  assert(delta.unexpectedLosses[0]?.text === "came", "lost word is came");
}

{
  console.log("[alignmentDelta api] edited word may unalign without blocking survivors");
  const before = content([
    zaln("H1", [w("He")]), t(" "),
    zaln("H2", [w("came")]), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const after = content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.unexpectedLosses.length === 0, "only the changed word unaligned");
}

{
  console.log("[alignmentDelta api] collateral loss after a word edit is blocked");
  const before = content([
    zaln("H1", [w("He")]), t(" "),
    zaln("H2", [w("came")]), t(" "),
    zaln("H3", [w("home")]),
  ]);
  const after = content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    w("home"),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.unexpectedLosses.length === 1, "unchanged survivor loss is unexpected");
  assert(delta.unexpectedLosses[0]?.text === "home", "lost survivor is home");
  // The ENFORCED predicate must actually fire here. Pre-#227-fix this case only
  // asserted the analyzer's report, not the guard — and the guard's
  // `wordSequenceUnchanged` narrowing (here "went" changed the sequence) meant
  // it never fired. Assert the real thing now.
  assert(guardBlocksSave(delta, "text_edit"), "guard BLOCKS a text_edit with collateral loss");
  assert(!guardBlocksSave(delta, "alignment_edit"), "alignment_edit is still exempt");
}

{
  // Regression for the bug this PR fixes: the 1CH 4:21 shape. A one-word
  // spelling edit (Lekah→Lecah) flips wordSequenceUnchanged to false, AND a
  // neighbor the translator never touched ("Shelah") loses its \zaln source.
  // The pre-fix narrowed predicate (unexpectedLosses>0 && wordSequenceUnchanged)
  // did NOT fire on this — which is exactly how it shipped to master. The
  // de-narrowed guard MUST fire.
  console.log("[alignmentDelta api] 1CH 4:21 shape: one-word edit + collateral de-align fires the guard");
  const before = content([
    zaln("H1", [w("Lekah")]), t(" "),
    zaln("H2", [w("and")]), t(" "),
    zaln("H3", [w("Shelah")]),
  ]);
  // "Lekah"→"Lecah" is the intended edit (legitimately drops its own \zaln);
  // "Shelah" is untouched but lost its milestone — collateral loss.
  const after = content([
    w("Lecah"), t(" "),
    zaln("H2", [w("and")]), t(" "),
    w("Shelah"),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(!delta.wordSequenceUnchanged, "word sequence DID change (Lekah→Lecah) — the narrowing trap");
  assert(
    delta.unexpectedLosses.some((l) => l.text === "Shelah"),
    "untouched neighbor Shelah is reported as collateral loss",
  );
  assert(
    !delta.unexpectedLosses.some((l) => l.text === "Lekah" || l.text === "Lecah"),
    "the intentionally-edited word is NOT reported as collateral loss",
  );
  assert(guardBlocksSave(delta, "text_edit"), "de-narrowed guard FIRES on the 1CH 4:21 shape");
}

// ── Total wipe (the empty-after hole) ────────────────────────────────────────
// Regression for the ZEC 1:8 receipt: a whole-verse-flattening save replaced the
// alignment tree with a single text node, 38 aligned words → 0, and the API
// answered 200 (dev `edit_log` id 1458, delta
// `{"beforeAligned":38,"afterAligned":0,"unexpectedLosses":[]}`). Every word was
// unlinked by the LCS, and unlinked words are skipped — so total annihilation
// reported as zero losses. Total wipe is the MAXIMUM loss case.

const alignedTrio = () => content([
  zaln("H1", [w("He")]), t(" "),
  zaln("H2", [w("came")]), t(" "),
  zaln("H3", [w("home")]),
]);

{
  console.log("[alignmentDelta api] ZEC 1:8 shape: whole-verse flatten is blocked, not zero-loss");
  const before = alignedTrio();
  // The exact payload the flattening save built: one text node, whole verse.
  const after = content([t("He came home")]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.beforeAligned === 3, "three aligned words before");
  assert(delta.afterAligned === 0, "zero aligned words after");
  assert(delta.unexpectedLosses.length === 3, "EVERY previously-aligned word is reported lost");
  assert(
    delta.unexpectedLosses.every((l) => l.reason === "lost"),
    "all wipe losses use reason 'lost' (what the export backstop filters on)",
  );
  assert(
    ["He", "came", "home"].every((x) => delta.unexpectedLosses.some((l) => l.text === x)),
    "each destroyed word is named so the client can list them",
  );
  assert(guardBlocksSave(delta, "text_edit"), "guard BLOCKS the flatten as a text_edit");
  assert(guardBlocksSave(delta, "find_replace"), "guard BLOCKS the flatten as a find_replace");
  assert(guardBlocksSave(delta, "section_edit"), "guard BLOCKS the flatten as a section_edit");
  assert(
    !guardBlocksSave(delta, "alignment_edit"),
    "alignment_edit stays exempt — unaligning everything from the panel is legitimate",
  );
}

{
  // The receipt's precise nastiness: the plain text did not change AT ALL. Only
  // the structure was destroyed, so nothing text-shaped signals a problem.
  console.log("[alignmentDelta api] flatten with byte-identical plain text is still blocked");
  const delta = analyzeAlignmentDelta(alignedTrio(), content([t("He came home")]));
  assert(guardBlocksSave(delta, "text_edit"), "identical text, annihilated structure → blocked");
}

{
  console.log("[alignmentDelta api] verse emptied entirely is blocked");
  const empty = analyzeAlignmentDelta(alignedTrio(), content([]));
  assert(empty.afterAligned === 0, "nothing aligned survives an emptied verse");
  assert(empty.unexpectedLosses.length === 3, "all three words reported lost");
  assert(guardBlocksSave(empty, "text_edit"), "emptying an aligned verse is blocked");
  // A missing/!array verseObjects must behave the same, not throw.
  const missing = analyzeAlignmentDelta(alignedTrio(), {});
  assert(guardBlocksSave(missing, "text_edit"), "absent verseObjects is blocked too");
}

{
  // Words kept, every \zaln stripped. This one already fired (the sequence is
  // unchanged, so the exact-position path caught it) — assert it still does and
  // that the new wipe branch reports it exactly once per word, not twice.
  console.log("[alignmentDelta api] all milestones stripped but words kept is blocked exactly once");
  const after = content([w("He"), t(" "), w("came"), t(" "), w("home")]);
  const delta = analyzeAlignmentDelta(alignedTrio(), after);
  assert(delta.unexpectedLosses.length === 3, "three losses, no double-reporting");
  assert(guardBlocksSave(delta, "text_edit"), "bare-word wipe is blocked");
}

{
  // Negative control 1: a resource with NO alignment to begin with must stay
  // freely editable. Blocking here would break every unaligned lane.
  console.log("[alignmentDelta api] wiping an UNALIGNED verse is not a loss");
  const before = content([w("He"), t(" "), w("came")]);
  const delta = analyzeAlignmentDelta(before, content([t("Something else entirely")]));
  assert(delta.beforeAligned === 0, "nothing was aligned before");
  assert(delta.unexpectedLosses.length === 0, "nothing aligned was lost");
  assert(!guardBlocksSave(delta, "text_edit"), "guard does NOT fire on an unaligned verse");
}

{
  // Negative control 2: the wipe branch must not swallow the ordinary case. One
  // aligned word survives, so the LCS path still runs and still reports only
  // genuine collateral loss — the intentionally-edited word stays exempt.
  console.log("[alignmentDelta api] partial loss still routes through the LCS path");
  const after = content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    w("home"),
  ]);
  const delta = analyzeAlignmentDelta(alignedTrio(), after);
  assert(delta.afterAligned === 1, "one aligned word survives — not a wipe");
  assert(delta.unexpectedLosses.length === 1, "only the untouched survivor is reported");
  assert(delta.unexpectedLosses[0]?.text === "home", "collateral loss is home, not the edited word");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll API alignmentDelta tests passed.");

