// Unit tests for contextExport.ts + contextExportLib.ts (pure renderer + gates).
// Run: node --experimental-strip-types --no-warnings src/contextExport.test.mjs

import {
  renderManifestYaml,
  renderBriefMd,
  renderContextPack,
  renderInstructionsMd,
  buildValidatedExamples,
  renderValidatedJsonl,
  hasMinimumContent,
  hasSemanticContent,
  buildContextRef,
  contextRepoOwner,
  sourceRowKey,
} from "./contextExport.ts";
import {
  contextShrinkRefused,
  shrinkDetailCode,
  nfc,
  contentFileCount,
  briefHasSemanticValue,
  stalePackPaths,
} from "./contextExportLib.ts";
import { applyContextRef } from "./assistedContextRef.ts";
import { tsvLooksTruncated } from "./contextSourceFetch.ts";
import { PRESETS } from "./projectConfig.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const cfg = {
  languageCode: "ar",
  languageName: "Arabic",
  languageTitle: "العربية",
  direction: "rtl",
  exportOrg: "BSOJ",
  org: "BSOJ",
};

console.log("contextExport — manifest / brief");
{
  const m = renderManifestYaml({
    languageCode: "ar",
    direction: "rtl",
    exportedAt: new Date("2026-07-14T12:00:00.000Z"),
  });
  assert(m.includes("format: 1"), "manifest has format: 1");
  assert(m.includes("language: ar"), "manifest has language");
  assert(m.includes("direction: rtl"), "manifest has direction");
  assert(m.includes("exported_by: bible-editor"), "manifest has exported_by");
  assert(m.includes("exported_at: 2026-07-14T12:00:00Z"), "manifest ISO time without ms");

  const brief = renderBriefMd(
    { audience: "teams", purpose: "notes", register: "formal", script_notes: "RTL", instructions_md: null, common_issues_md: null },
    "العربية",
    "ar",
  );
  assert(brief.includes("**Register:** formal"), "brief Register line for bot parse");
  assert(brief.includes("**Audience:** teams"), "brief audience");
}

console.log("contextExport — NFC + examples");
{
  // Hebrew with combining marks in legacy vs NFC order.
  const legacy = "\u05D1\u05BC\u05B8"; // bet + dagesh + qamats (common UHB order)
  const already = legacy.normalize("NFC");
  assert(nfc(legacy) === already, "nfc() folds Hebrew combining marks");

  const ex = buildValidatedExamples(
    [
      {
        id: "abcd",
        book: "OBA",
        ref_raw: "1:1",
        support_reference: "figs-metaphor",
        quote: null,
        note: "هذا مجاز.",
        updated_at: 100,
      },
    ],
    [],
    {
      tn: new Map([[sourceRowKey("OBA", "abcd"), { note: "This is a metaphor.", quote: null }]]),
      tq: new Map(),
    },
  );
  assert(ex.ok === true, "examples ok with EN source");
  assert(ex.ok && ex.lines[0].source === "This is a metaphor.", "example source from EN map");

  const miss = buildValidatedExamples(
    [{ id: "zzzz", book: "OBA", ref_raw: "1:1", support_reference: null, quote: null, note: "x", updated_at: 1 }],
    [],
    { tn: new Map(), tq: new Map() },
  );
  assert(miss.ok === false && miss.reason.includes("missing_en_source"), "missing EN aborts");

  // Collision regression: identical 4-char IDs in two books must not cross-pair.
  const collision = buildValidatedExamples(
    [
      {
        id: "abcd",
        book: "OBA",
        ref_raw: "1:1",
        support_reference: null,
        quote: null,
        note: "oba-target",
        updated_at: 10,
      },
      {
        id: "abcd",
        book: "ZEC",
        ref_raw: "1:1",
        support_reference: null,
        quote: null,
        note: "zec-target",
        updated_at: 20,
      },
    ],
    [],
    {
      tn: new Map([
        [sourceRowKey("OBA", "abcd"), { note: "OBA English source", quote: null }],
        [sourceRowKey("ZEC", "abcd"), { note: "ZEC English source", quote: null }],
      ]),
      tq: new Map(),
    },
  );
  assert(collision.ok === true, "same id across books resolves");
  assert(
    collision.ok &&
      collision.lines.find((l) => l.book === "OBA")?.source === "OBA English source" &&
      collision.lines.find((l) => l.book === "ZEC")?.source === "ZEC English source",
    "book:id key prevents cross-book EN source overwrite",
  );
  assert(sourceRowKey("oba", "abcd") === "OBA:abcd", "sourceRowKey uppercases book");

  const jsonl = renderValidatedJsonl(ex.ok ? ex.lines : []);
  assert(jsonl.includes('"resource":"tn"'), "jsonl serializes resource");
  assert(jsonl.endsWith("\n"), "jsonl trailing newline");
}

console.log("contextExport — full pack + omission rules");
{
  const emptyInstructions = renderContextPack({
    cfg,
    prefs: {
      audience: "a",
      purpose: "p",
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: null,
    },
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    exportedAt: new Date("2026-07-14T12:00:00Z"),
  });
  assert(emptyInstructions.ok === true, "pack renders with brief alone");
  assert(
    emptyInstructions.ok && !emptyInstructions.files.some((f) => f.path === "instructions.md"),
    "omits empty instructions.md",
  );
  assert(
    emptyInstructions.ok && !emptyInstructions.files.some((f) => f.path === "examples/validated.jsonl"),
    "omits empty examples",
  );
  assert(emptyInstructions.ok && hasMinimumContent(emptyInstructions.files), "brief counts as file-level content");
  // Scaffold-only prefs (empty fields + default register) must NOT enable assisted.
  assert(
    !hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
    }),
    "scaffold-only prefs fail semantic gate",
  );
  assert(
    hasSemanticContent({
      prefs: {
        audience: "a",
        purpose: "p",
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
    }),
    "audience+purpose count as semantic",
  );
  assert(!briefHasSemanticValue({ audience: null, purpose: null, register: "default", script_notes: null }), "default register alone is not semantic");
  assert(briefHasSemanticValue({ audience: null, purpose: null, register: "formal", script_notes: null }), "non-default register is semantic");
  assert(
    hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: null,
      },
      terms: 1,
      examplesTn: 0,
      examplesTq: 0,
    }),
    "one term satisfies semantic gate",
  );
  // Common issues alone (everything else null/default/zero) must satisfy the
  // semantic gate — a project whose only content is a pasted "common issues"
  // doc must not be discarded as scaffold-only.
  assert(
    hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: "Translators keep confusing grace and mercy.",
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
    }),
    "common_issues_md alone satisfies semantic gate",
  );
  assert(
    !hasSemanticContent({
      prefs: {
        audience: null,
        purpose: null,
        register: "default",
        script_notes: null,
        instructions_md: null,
        common_issues_md: "   ",
      },
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
    }),
    "whitespace-only common_issues_md fails semantic gate",
  );

  const withTerms = renderContextPack({
    cfg,
    prefs: {
      audience: null,
      purpose: null,
      register: "informal",
      script_notes: null,
      instructions_md: "Do the thing\n",
      common_issues_md: null,
    },
    terms: [
      {
        concept_id: "kt/grace",
        source_term: "grace",
        target_term: "نعمة",
        status: "preferred",
        replacement: null,
        comment: null,
        tw_link: null,
      },
    ],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
  });
  assert(withTerms.ok && withTerms.stats.terms === 1, "terms count");
  assert(
    withTerms.ok && withTerms.files.some((f) => f.path === "terminology/terms.csv"),
    "emits terms.csv",
  );
  assert(
    withTerms.ok && withTerms.files.some((f) => f.path === "instructions.md"),
    "emits instructions when present",
  );
}

console.log("contextExport — partial source: sourceless resource is SKIPPED, export still succeeds");
{
  // Regression (PR #86 review): tN source blank in Setup (skipped:['tn']) with a
  // VALIDATED tN row + a sourced tQ row. The empty tn source map must NOT trip
  // missing_en_source — the tN row is skipped, and tQ examples + prefs + terms
  // still export. Before the fix, this failed the WHOLE context export.
  const r = renderContextPack({
    cfg,
    prefs: {
      audience: "teams",
      purpose: "notes",
      register: "formal",
      script_notes: null,
      instructions_md: "Keep it simple\n",
      common_issues_md: null,
    },
    terms: [
      {
        concept_id: "kt/grace",
        source_term: "grace",
        target_term: "نعمة",
        status: "preferred",
        replacement: null,
        comment: null,
        tw_link: null,
      },
    ],
    // A validated tN row with NO EN source (tn skipped) + a tQ row WITH source.
    tnRows: [
      { id: "n1", book: "TIT", ref_raw: "1:1", support_reference: "figs-metaphor", quote: null, note: "ملاحظة", updated_at: 10 },
    ],
    tqRows: [
      { id: "q1", book: "TIT", ref_raw: "1:1", question: "من؟", response: "الله.", updated_at: 20 },
    ],
    sources: {
      tn: new Map(), // empty — tn was skipped (no upstream source)
      tq: new Map([[sourceRowKey("TIT", "q1"), { question: "Who?", response: "God." }]]),
    },
    skipped: ["tn"],
  });
  assert(r.ok, "export SUCCEEDS despite a sourceless tN with validated rows (no missing_en_source)");
  assert(r.ok && r.stats.examplesTn === 0, "tN examples empty (skipped resource)");
  assert(r.ok && r.stats.examplesTq === 1, "tQ example still exported (sourced resource)");
  assert(r.ok && r.stats.terms === 1, "terms still exported");
  assert(r.ok && r.files.some((f) => f.path === "instructions.md"), "prefs/instructions still exported");
  assert(
    r.ok && r.files.some((f) => f.path === "examples/validated.jsonl"),
    "validated.jsonl emitted from the tQ example",
  );

  // Without skipped, the same empty tn map WOULD fail (proves skipped is what saves it).
  const wouldFail = renderContextPack({
    cfg,
    prefs: { audience: null, purpose: null, register: "default", script_notes: null, instructions_md: null, common_issues_md: null },
    terms: [],
    tnRows: [
      { id: "n1", book: "TIT", ref_raw: "1:1", support_reference: null, quote: null, note: "ملاحظة", updated_at: 10 },
    ],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
  });
  assert(!wouldFail.ok && wouldFail.reason.includes("missing_en_source:tn"), "empty tn map without skipped still hard-fails (control)");
}

console.log("contextExport — renderInstructionsMd");
{
  const basePrefs = { audience: null, purpose: null, register: "default", script_notes: null };

  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: null, common_issues_md: null }) === null,
    "both empty → null",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: "  ", common_issues_md: "   " }) === null,
    "both whitespace-only → null",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: "Do the thing", common_issues_md: null }) ===
      "Do the thing\n",
    "only instructions_md → its text + trailing newline, no heading",
  );
  assert(
    renderInstructionsMd({ ...basePrefs, instructions_md: null, common_issues_md: "Watch for false friends." }) ===
      "## Common issues\n\nWatch for false friends.\n",
    "only common_issues_md → heading followed by the text",
  );
  assert(
    renderInstructionsMd({
      ...basePrefs,
      instructions_md: "Do the thing",
      common_issues_md: "Watch for false friends.",
    }) === "Do the thing\n\n## Common issues\n\nWatch for false friends.\n",
    "both → instructions first, blank line, then heading + issues",
  );

  // Regression: common_issues_md alone must not be silently dropped from the
  // rendered pack — instructions.md must still be emitted.
  const onlyCommonIssues = renderContextPack({
    cfg,
    prefs: {
      audience: null,
      purpose: null,
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: "Avoid the colloquial future particle in narrative.",
    },
    terms: [],
    tnRows: [],
    tqRows: [],
    sources: { tn: new Map(), tq: new Map() },
    exportedAt: new Date("2026-07-14T12:00:00Z"),
  });
  assert(
    onlyCommonIssues.ok &&
      onlyCommonIssues.files.find((f) => f.path === "instructions.md")?.content ===
        "## Common issues\n\nAvoid the colloquial future particle in narrative.\n",
    "renderContextPack emits instructions.md when only common_issues_md is set",
  );
}

console.log("contextExportLib — shrink + content count");
{
  assert(contentFileCount([{ path: "manifest.yaml", content: "x" }]) === 0, "manifest alone = 0 content");
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 1000 },
      null,
    ),
    "first export: no shrink",
  );
  const refused = contextShrinkRefused(
    { terms: 2, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 1000 },
    { terms: 100, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 1000 },
  );
  assert(refused && refused.metric === "terms", "terms shrink refused");
  assert(shrinkDetailCode(refused).startsWith("shrink_guard:terms_"), "shrink code shape");

  const bytes = contextShrinkRefused(
    { terms: 10, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 100 },
    { terms: 10, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 1000 },
  );
  assert(bytes && bytes.metric === "totalBytes", "bytes shrink refused");

  // Intentional clears (fewer content files) are allowed — the stale file is
  // deleted from the repo instead of the export being refused forever.
  assert(
    !contextShrinkRefused(
      { terms: 10, examplesTn: 5, examplesTq: 0, contentFiles: 2, totalBytes: 950 },
      { terms: 10, examplesTn: 5, examplesTq: 0, contentFiles: 3, totalBytes: 1000 },
    ),
    "content-file drop alone is not refused",
  );

  assert(
    JSON.stringify(
      stalePackPaths([
        { path: "manifest.yaml", content: "x" },
        { path: "brief.md", content: "x" },
      ]),
    ) === JSON.stringify(["instructions.md", "terminology/terms.csv", "examples/validated.jsonl"]),
    "stalePackPaths lists omitted pack files only",
  );
  assert(
    stalePackPaths([
      { path: "manifest.yaml", content: "x" },
      { path: "brief.md", content: "x" },
      { path: "instructions.md", content: "x" },
      { path: "terminology/terms.csv", content: "x" },
      { path: "examples/validated.jsonl", content: "x" },
    ]).length === 0,
    "full pack has no stale paths",
  );
}

console.log("assistedContextRef + owner + tsv truncation");
{
  assert(contextRepoOwner({ DCS_EXPORT_OWNER: "X" }, cfg) === "X", "DCS_EXPORT_OWNER wins");
  assert(contextRepoOwner({}, cfg) === "BSOJ", "fallback to exportOrg");
  // exportOwnerFromConfig makes cfg.exportOrg win over the env fallback — the
  // en-bible-editor-ml-test preset exports to its own org, not the service acct.
  const mlTest = PRESETS["en-bible-editor-ml-test"];
  assert(
    contextRepoOwner({ DCS_EXPORT_OWNER: "BibleEditorService" }, mlTest) === "BibleEditorMLTest",
    "exportOwnerFromConfig: en-bible-editor-ml-test resolves to BibleEditorMLTest (ignores DCS_EXPORT_OWNER)",
  );
  assert(buildContextRef("BSOJ", "abc") === "BSOJ/translation-context@abc", "contextRef shape");

  const latestExport = {
    sha: "deadbeef",
    completedAt: 1,
    owner: "BSOJ",
    terms: 1,
    examplesTn: 0,
    examplesTq: 0,
    contentFiles: 1,
    totalBytes: 10,
  };
  const injected = applyContextRef({ sourceRef: "x" }, latestExport);
  assert(injected.contextRef === "BSOJ/translation-context@deadbeef", "injects whenever a successful export exists (no assisted gate)");

  const noSha = applyContextRef({ sourceRef: "x" }, null);
  assert(noSha.contextRef == null, "no inject without successful export");

  const override = applyContextRef({ contextRef: "other/repo@1" }, latestExport);
  assert(override.contextRef === "other/repo@1", "caller override wins");

  assert(tsvLooksTruncated("ID\tNote\n"), "header-only TSV truncated");
  assert(!tsvLooksTruncated("Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\nabcd\tx\t\t\t\t\ty\n"), "normal TSV ok");
}

console.log("ALL contextExport tests passed");
