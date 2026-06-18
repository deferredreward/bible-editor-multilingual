import { analyzeAlignmentDelta } from "./alignmentDelta.ts";

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
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll API alignmentDelta tests passed.");

