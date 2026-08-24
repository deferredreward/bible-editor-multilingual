// Unit tests for the provenance-aware row-level publish gate (publishGate.ts,
// docs/ux-simplification.md §1.4 — the durable #236 fix). The export drops the
// tn/tq pair-level held-out skip and instead decides per row:
//
//   own-provenance chapter                                → old review-state gate, unchanged
//   foreign chapter + validated                           → export live content
//   foreign chapter + draft with usable snapshot          → export the snapshot
//   foreign chapter + anything else (pristine/NULL state,
//     or draft with no/unparseable snapshot)              → OMIT the row
//
// "Foreign" comes from the same HeldOut set the pair skip used (whole-book
// marker → { all: true }; range overrides → inclusive chapter ranges, with
// whole-book = (0, 999) so chapter-0 front matter follows the same test).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/publishGate.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { publishGateDecision, gateTsvRowForPublish } from "./publishGate.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const snap = JSON.stringify({ note: "published note", tags: "grammar" });

console.log("[publishGateDecision] own-provenance rows: existing gate, unchanged");
{
  assert(publishGateDecision(false, null, null).kind === "current",
    "own + never-drafted (NULL state) → current");
  assert(publishGateDecision(false, "validated", null).kind === "current",
    "own + validated → current");
  const d = publishGateDecision(false, "ai_draft", snap);
  assert(d.kind === "snapshot" && d.snapshot.note === "published note",
    "own + ai_draft with snapshot → snapshot (0049 gate)");
  assert(publishGateDecision(false, "edited", null).kind === "legacy",
    "own + edited without snapshot → legacy (export current + log), NOT omit");
}

console.log("[publishGateDecision] foreign rows");
{
  assert(publishGateDecision(true, "validated", null).kind === "current",
    "foreign + validated → current (approved content publishes live)");
  const d = publishGateDecision(true, "ai_draft", snap);
  assert(d.kind === "snapshot" && d.snapshot.note === "published note",
    "foreign + ai_draft with snapshot → snapshot (last-published content)");
  const e = publishGateDecision(true, "edited", snap);
  assert(e.kind === "snapshot",
    "foreign + edited with snapshot → snapshot");
  assert(publishGateDecision(true, "ai_draft", null).kind === "omit",
    "foreign + ai_draft with NO snapshot (Aquifer-import signature) → omit, never legacy-passthrough");
  assert(publishGateDecision(true, "edited", "not json{{{").kind === "omit",
    "foreign + edited with unparseable snapshot → omit");
  assert(publishGateDecision(true, "ai_draft", JSON.stringify([1, 2])).kind === "omit",
    "foreign + draft with non-object snapshot → omit");
  assert(publishGateDecision(true, null, null).kind === "omit",
    "foreign + pristine (NULL state, DCS-range import signature) → omit — English text must not export");
  assert(publishGateDecision(true, "", null).kind === "omit",
    "foreign + empty-string state → omit");
  assert(publishGateDecision(true, "bogus_state", null).kind === "omit",
    "foreign + unknown state → omit (fail closed)");
  // A stray snapshot on a pristine foreign row does not rescue it: only
  // validated or draft-with-snapshot may publish.
  assert(publishGateDecision(true, null, snap).kind === "omit",
    "foreign + NULL state with a stray snapshot → still omit");
}

console.log("[gateTsvRowForPublish] chapter membership drives foreignness");
{
  const ranges = { all: false, ranges: [{ start: 13, end: 16 }] };
  const mk = (chapter, state, pre) => ({
    id: `x-${chapter}`, chapter, verse: 1,
    note: "live note", tags: "live-tags",
    translation_state: state, pre_draft_json: pre,
  });

  // Own chapter (outside the range): pristine row exports current content.
  const own = gateTsvRowForPublish(mk(12, null, null), ["note", "tags"], ranges);
  assert(own.row !== null && own.row.note === "live note" && !own.legacy,
    "chapter 12 outside range 13-16 → own-provenance passthrough");

  // Range boundaries are inclusive.
  assert(gateTsvRowForPublish(mk(13, null, null), ["note", "tags"], ranges).row === null,
    "chapter 13 (range start) → foreign pristine → omitted");
  assert(gateTsvRowForPublish(mk(16, null, null), ["note", "tags"], ranges).row === null,
    "chapter 16 (range end, inclusive) → omitted");
  const after = gateTsvRowForPublish(mk(17, null, null), ["note", "tags"], ranges);
  assert(after.row !== null, "chapter 17 (past range end) → own-provenance, kept");

  // Chapter-0 front matter: NOT covered by a 13-16 range…
  const front = gateTsvRowForPublish(mk(0, null, null), ["note", "tags"], ranges);
  assert(front.row !== null, "chapter 0 outside range 13-16 → own-provenance, kept");
  // …but covered by the whole-book (0, 999) range sentinel.
  const wholeBookRange = { all: false, ranges: [{ start: 0, end: 999 }] };
  assert(gateTsvRowForPublish(mk(0, null, null), ["note", "tags"], wholeBookRange).row === null,
    "chapter 0 under whole-book range (0,999) → foreign pristine → omitted");

  // Foreign + validated in-range publishes LIVE content.
  const val = gateTsvRowForPublish(mk(14, "validated", null), ["note", "tags"], ranges);
  assert(val.row !== null && val.row.note === "live note",
    "chapter 14 validated → live content exported");

  // Foreign + draft with snapshot publishes the SNAPSHOT fields.
  const withSnap = gateTsvRowForPublish(mk(15, "ai_draft", snap), ["note", "tags"], ranges);
  assert(withSnap.row !== null && withSnap.row.note === "published note" && withSnap.row.tags === "grammar",
    "chapter 15 ai_draft+snapshot → snapshot fields substituted");
  assert(withSnap.row.id === "x-15" && withSnap.row.chapter === 15,
    "snapshot substitution keeps row identity fields");

  // Foreign + draft with NO snapshot is omitted (no legacy fall-through).
  const noSnap = gateTsvRowForPublish(mk(15, "ai_draft", null), ["note", "tags"], ranges);
  assert(noSnap.row === null && !noSnap.legacy,
    "chapter 15 ai_draft without snapshot → omitted, not flagged legacy");
}

console.log("[gateTsvRowForPublish] whole-book marker ({ all: true }) and no-foreign (null)");
{
  const all = { all: true };
  const row = (state, pre) => ({
    id: "q1", chapter: 3, verse: 2,
    question: "live q", response: "live r",
    translation_state: state, pre_draft_json: pre,
  });

  assert(gateTsvRowForPublish(row(null, null), ["question", "response"], all).row === null,
    "whole-book marker: pristine row on any chapter → omitted");
  const v = gateTsvRowForPublish(row("validated", null), ["question", "response"], all);
  assert(v.row !== null && v.row.question === "live q",
    "whole-book marker: validated row → live content");
  const s = gateTsvRowForPublish(
    row("edited", JSON.stringify({ question: "old q", response: null })),
    ["question", "response"],
    all,
  );
  assert(s.row !== null && s.row.question === "old q" && s.row.response === null,
    "whole-book marker: edited+snapshot → snapshot substituted (missing field → null)");

  // foreignChapters null = book with no foreign provenance: pure passthrough
  // of the old gate, including the legacy branch.
  const legacy = gateTsvRowForPublish(row("ai_draft", null), ["question", "response"], null);
  assert(legacy.row !== null && legacy.legacy,
    "null foreign set: draft without snapshot → kept + legacy flag (old behavior)");
}

console.log("publishGate tests passed");
