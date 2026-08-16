import { analyzeAlignmentDelta, guardBlocksSave, lostAlignedWords } from "./alignmentDelta.ts";

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
  console.log("[alignmentDelta] punctuation save cannot drop unchanged alignment");
  const before = content([zaln("H1", [w("He")]), t(" "), zaln("H2", [w("came")])]);
  const after = content([zaln("H1", [w("He")]), t(", "), w("came")]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.wordSequenceUnchanged, "word sequence is unchanged");
  assert(delta.unexpectedLosses.length === 1, "one unchanged word lost alignment");
  assert(delta.unexpectedLosses[0]?.text === "came", "lost word is came");
}

{
  console.log("[alignmentDelta] edited word may unalign without blocking survivors");
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
  console.log("[alignmentDelta] collateral loss after a word edit is blocked");
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
  console.log("[alignmentDelta] 1CH 4:21 shape: one-word edit + collateral de-align fires the guard");
  const before = content([
    zaln("H1", [w("Lekah")]), t(" "),
    zaln("H2", [w("and")]), t(" "),
    zaln("H3", [w("Shelah")]),
  ]);
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
  assert(guardBlocksSave(delta, "text_edit"), "de-narrowed guard FIRES on the 1CH 4:21 shape");
}

{
  console.log("[alignmentDelta] duplicate changed-word ambiguity is allowed");
  const before = content([
    zaln("H1", [w("is")]), t(" "),
    zaln("H2", [w("good")]), t(" "),
    zaln("H3", [w("is")]),
  ]);
  const after = content([
    w("is"), t(" "),
    w("better"), t(" "),
    zaln("H3", [w("is")]),
  ]);
  const delta = analyzeAlignmentDelta(before, after);
  assert(delta.unexpectedLosses.length === 0, "duplicate is ambiguous after a real word edit");
}

{
  // lostAlignedWords drives the aligner-panel "you're about to unalign X"
  // confirm. It reports ONLY previously-aligned words that go fully bare
  // (reason "lost") — the JER 30:1 "Jeremiah" incident shape — and ignores
  // re-pointed sources (changed_source = normal re-alignment).
  console.log("[alignmentDelta] lostAlignedWords flags a previously-aligned word going bare");
  const before = content([
    zaln("H1", [w("to")]), t(" "),
    zaln("H2", [w("Jeremiah")]),
  ]);
  const afterBare = content([
    zaln("H1", [w("to")]), t(" "),
    w("Jeremiah"),
  ]);
  assert(
    JSON.stringify(lostAlignedWords(before, afterBare)) === JSON.stringify(["Jeremiah"]),
    "unaligning Jeremiah is reported as a lost word",
  );
  // No change → nothing to warn about.
  assert(lostAlignedWords(before, before).length === 0, "an unchanged save reports no losses");
  // Re-pointing a source (changed_source) is normal re-alignment, NOT a loss.
  const afterRepointed = content([
    zaln("H1", [w("to")]), t(" "),
    zaln("H9", [w("Jeremiah")]),
  ]);
  assert(
    lostAlignedWords(before, afterRepointed).length === 0,
    "re-pointing a source is not flagged as an unalign",
  );
}

// ── Total wipe (the empty-after hole) ────────────────────────────────────────
// Mirror of the API suite. Regression for the ZEC 1:8 receipt: a whole-verse
// flatten took 38 aligned words to 0 and the API answered 200 (dev `edit_log`
// id 1458, delta `{"beforeAligned":38,"afterAligned":0,"unexpectedLosses":[]}`)
// because both scoring paths only report words that SURVIVE the edit — and in a
// wipe none do. Total wipe is the MAXIMUM loss case.

const alignedTrio = () => content([
  zaln("H1", [w("He")]), t(" "),
  zaln("H2", [w("came")]), t(" "),
  zaln("H3", [w("home")]),
]);

{
  console.log("[alignmentDelta] ZEC 1:8 shape: whole-verse flatten is blocked, not zero-loss");
  // The exact payload the flattening save built: one text node, whole verse.
  const delta = analyzeAlignmentDelta(alignedTrio(), content([t("He came home")]));
  assert(delta.beforeAligned === 3 && delta.afterAligned === 0, "3 aligned words → 0");
  assert(delta.unexpectedLosses.length === 3, "EVERY previously-aligned word is reported lost");
  assert(delta.unexpectedLosses.every((l) => l.reason === "lost"), "all wipe losses use reason 'lost'");
  assert(guardBlocksSave(delta, "text_edit"), "guard BLOCKS the flatten as a text_edit");
  assert(guardBlocksSave(delta, "find_replace"), "guard BLOCKS the flatten as a find_replace");
  assert(guardBlocksSave(delta, "section_edit"), "guard BLOCKS the flatten as a section_edit");
  assert(
    !guardBlocksSave(delta, "alignment_edit"),
    "alignment_edit stays exempt — unaligning everything from the panel is legitimate",
  );
  // The Shell confirm lists delta.unexpectedLosses.map(l => l.text); a wipe must
  // therefore name the destroyed words rather than show an empty list.
  assert(
    JSON.stringify(lostAlignedWords(alignedTrio(), content([t("He came home")])))
      === JSON.stringify(["He", "came", "home"]),
    "lostAlignedWords names every annihilated word (it used to report none)",
  );
}

{
  console.log("[alignmentDelta] emptied verse / absent verseObjects are blocked");
  assert(
    guardBlocksSave(analyzeAlignmentDelta(alignedTrio(), content([])), "text_edit"),
    "emptying an aligned verse is blocked",
  );
  assert(
    guardBlocksSave(analyzeAlignmentDelta(alignedTrio(), {}), "text_edit"),
    "absent verseObjects is blocked too, not thrown on",
  );
}

{
  // Negative control: an UNALIGNED resource must stay freely editable.
  console.log("[alignmentDelta] wiping an UNALIGNED verse is not a loss");
  const before = content([w("He"), t(" "), w("came")]);
  const delta = analyzeAlignmentDelta(before, content([t("Something else entirely")]));
  assert(delta.beforeAligned === 0 && delta.unexpectedLosses.length === 0, "nothing aligned was lost");
  assert(!guardBlocksSave(delta, "text_edit"), "guard does NOT fire on an unaligned verse");
}

{
  // Negative control: the wipe branch must not swallow the ordinary case.
  console.log("[alignmentDelta] partial loss still routes through the LCS path");
  const delta = analyzeAlignmentDelta(alignedTrio(), content([
    zaln("H1", [w("He")]), t(" "),
    w("went"), t(" "),
    w("home"),
  ]));
  assert(delta.afterAligned === 1, "one aligned word survives — not a wipe");
  assert(delta.unexpectedLosses.length === 1, "only the untouched survivor is reported");
  assert(delta.unexpectedLosses[0]?.text === "home", "collateral loss is home, not the edited word");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll alignmentDelta tests passed.");

