// Regression tests for overlayFindMarks / isPaintableHtml (#642 upstream),
// ported from upstream unfoldingWord/bible-editor's highlight.test.mjs
// additions in bf21183c. The Find overlay must paint match marks onto the
// chip-bearing render, not substitute marker-free plain text for it.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/overlayFindMarks.test.mjs
//
// Not a test framework; failures exit non-zero.

import { isPaintableHtml, overlayFindMarks, renderEditableHTML } from "./highlight.ts";

// Aligned target-word node, matching the shape usfm-js produces.
const tgt = (text, occurrence = 1) => ({
  type: "word",
  tag: "w",
  text,
  occurrence: String(occurrence),
});

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
// --- 17. overlayFindMarks (#642): the Find overlay must paint match marks
// onto the chip-bearing render, not substitute marker-free plain text for
// it — the editable cell stays contentEditable throughout, so whatever HTML
// lands here is exactly what a keystroke's save capture reads back. A
// marker-free substitute would delete every `\q`/`\p` chip from that
// capture the moment Find is open.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "For the LORD is good to those who wait." },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const stripped = chipHtml.replace(/<[^>]*>/g, "");
  assert(
    stripped.includes("\\q1"),
    `sanity: the chip render's own textContent carries the \\q1 chip (got ${JSON.stringify(stripped)})`,
  );

  const painted = overlayFindMarks(chipHtml, /good/gi, null);
  const paintedText = painted.replace(/<[^>]*>/g, "");
  assert(
    paintedText.includes("\\q1"),
    `painted HTML's textContent still carries the \\q1 chip (got ${JSON.stringify(paintedText)})`,
  );
  assert(
    paintedText === stripped,
    `painting find marks changes only markup, never the underlying textContent a save capture reads (before=${JSON.stringify(stripped)}, after=${JSON.stringify(paintedText)})`,
  );
  assert(
    painted.includes('<mark class="be-find">good</mark>'),
    `the match is wrapped in a be-find mark (got ${JSON.stringify(painted)})`,
  );
}

// --- 18. overlayFindMarks: activeRange still flags the right occurrence as
// `be-find-active` when the run has no leading markers (the common case —
// verses with markers are documented as a known coordinate-mismatch, since
// activeRange is computed against marker-free plain_text).
{
  const verseObjects = [{ type: "text", text: "good news, very good." }];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /good/gi, { start: 16, end: 20 });
  const activeMarks = (painted.match(/<mark class="be-find be-find-active">good<\/mark>/g) || []).length;
  const plainMarks = (painted.match(/<mark class="be-find">good<\/mark>/g) || []).length;
  assert(activeMarks === 1, `exactly one occurrence is flagged active (got ${activeMarks} in ${JSON.stringify(painted)})`);
  assert(plainMarks === 1, `the other occurrence is flagged non-active (got ${plainMarks} in ${JSON.stringify(painted)})`);
}

// --- 19. overlayFindMarks: a match that would span two text runs (crossing
// a chip's own tag markup) is left undecorated rather than force-split —
// decoration only, and a botched split risks corrupting the markup a save
// capture reads.
{
  const html = '<span class="be-tok" data-tag="p">a</span>bc';
  const painted = overlayFindMarks(html, /ab/, null);
  assert(
    painted.replace(/<[^>]*>/g, "") === "abc",
    `textContent is unchanged when a match is skipped (got ${JSON.stringify(painted)})`,
  );
  assert(
    !painted.includes("<mark"),
    `no mark is inserted when the match would split a chip's markup (got ${JSON.stringify(painted)})`,
  );
}

// --- 20. overlayFindMarks: escaped punctuation round-trips through the
// decode/re-escape untouched (the entity decoder only understands this
// module's own fixed escaping, so a mismatch here would corrupt text).
{
  const verseObjects = [{ type: "text", text: `A & "B" good` }];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /good/, null);
  const strippedBefore = chipHtml.replace(/<[^>]*>/g, "");
  const strippedAfter = painted.replace(/<[^>]*>/g, "");
  assert(
    strippedAfter === strippedBefore,
    `textContent is byte-identical before/after painting (before=${JSON.stringify(strippedBefore)}, after=${JSON.stringify(strippedAfter)})`,
  );
}

// --- 21. overlayFindMarks (#646 review F2): `activeRange` arrives in
// marker-free plain_text coordinates, but the chip render carries the
// literal "\q1 " label — 4 characters that exist in no plain_text. Without
// translating between the two, `be-find-active` lands on the wrong
// occurrence (or, as here, on none at all) in every marker-bearing verse.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "good news, very good." },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  // plain_text for this verse is "good news, very good." — the second "good"
  // sits at 16 there, and at 20 in the chip render.
  const painted = overlayFindMarks(chipHtml, /good/gi, { start: 16, end: 20 });
  const actives = painted.match(/<mark class="be-find be-find-active">good<\/mark>/g) || [];
  assert(actives.length === 1, `exactly one occurrence is flagged active (got ${actives.length} in ${JSON.stringify(painted)})`);
  // The active one must be the SECOND — assert on position, not just count.
  const activeAt = painted.indexOf('<mark class="be-find be-find-active">');
  const plainAt = painted.indexOf('<mark class="be-find">');
  assert(
    plainAt !== -1 && plainAt < activeAt,
    `the ACTIVE mark is the second occurrence, not the first (got ${JSON.stringify(painted)})`,
  );
  assert(
    painted.replace(/<[^>]*>/g, "").includes("\\q1"),
    `the \\q1 chip survives the paint (got ${JSON.stringify(painted.replace(/<[^>]*>/g, ""))})`,
  );
}

// --- 22. overlayFindMarks (#646 review F3): a query that matches inside a
// chip's own literal label ("q" in "\q1") must not paint there. The chip is
// editor chrome, not verse text; the Find overlay counted no such match, so
// decorating one shows a hit the results list does not have.
{
  const verseObjects = [
    { type: "paragraph", tag: "q1" },
    { type: "text", text: "quiet waters" },
  ];
  const chipHtml = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(chipHtml, /q/gi, null);
  const marks = painted.match(/<mark class="be-find[^"]*">/g) || [];
  assert(marks.length === 1, `only the verse-text hit is painted, not the chip label (got ${marks.length} in ${JSON.stringify(painted)})`);
  assert(
    painted.includes('<span class="be-tok be-tok-q1" data-tag="q1">\\q1</span>'),
    `the chip label is left byte-for-byte alone (got ${JSON.stringify(painted)})`,
  );
}

// --- 23. overlayFindMarks (#646 review F1): note highlights split the chip
// render into separate text runs, and a find hit crossing a run boundary is
// deliberately skipped (see 19). So a multi-word query spanning a
// note-highlighted word paints NOTHING unless the editable cell renders with
// an empty highlight set while Find is open. This pins both halves: the
// highlighted render drops the phrase, the find-open render keeps it.
{
  const verseObjects = [
    { type: "text", text: "hold " },
    tgt("fast", 1),
    { type: "text", text: " to hope" },
  ];
  const withNoteHl = renderEditableHTML(verseObjects, new Set(["fast|1"]));
  assert(
    withNoteHl.includes('<mark class="be-hl">fast</mark>'),
    `sanity: the note highlight splits the run (got ${JSON.stringify(withNoteHl)})`,
  );
  const paintedOverHl = overlayFindMarks(withNoteHl, /hold fast/gi, null);
  assert(
    !paintedOverHl.includes("be-find"),
    `a phrase crossing a note highlight cannot be painted — which is why the cell must drop note highlights while Find is open (got ${JSON.stringify(paintedOverHl)})`,
  );

  const findOpen = renderEditableHTML(verseObjects, new Set());
  const painted = overlayFindMarks(findOpen, /hold fast/gi, null);
  assert(
    painted.includes('<mark class="be-find">hold fast</mark>'),
    `with no note highlights in the way the phrase paints (got ${JSON.stringify(painted)})`,
  );
}

// --- 24. isPaintableHtml (#646 review F5, #568 trap): a literal zero-width
// space must classify exactly like the `&#8203;` entity it decodes from.
// overlayFindMarks re-escapes the runs it touches, turning entities into
// literal characters — if only the entity form counted as invisible, a
// painted render could be judged "paintable" where its unpainted twin is not,
// and the pane would paint text-free markup.
{
  assert(
    isPaintableHtml('<div class="be-q-1">&#8203;</div>') === false,
    "the entity form of a caret-filler-only render is not paintable",
  );
  assert(
    isPaintableHtml('<div class="be-q-1">​</div>') === false,
    "the literal-character form classifies identically",
  );
  assert(
    isPaintableHtml('<div class="be-q-1">​word</div>') === true,
    "a filler next to real text is still paintable",
  );
}


if (failed > 0) {
  console.error(`\n${failed} overlayFindMarks assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll overlayFindMarks tests passed.");
