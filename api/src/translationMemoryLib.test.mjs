// Unit tests for translationMemoryLib.ts — CSV round-trip, closed-picklist
// validation, and term dedup. Pure functions only (no D1), so runnable under the
// strip-types runner like the other api tests.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/translationMemoryLib.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  TERM_STATUSES,
  REGISTERS,
  isTermStatus,
  parseCsvRows,
  sqlFold,
  parseTermsCsv,
  serializeTermsCsv,
  dedupeTerms,
  termKey,
  termInvariantError,
  parseIfMatch,
  escapeLikeParam,
} from "./translationMemoryLib.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log("[picklists] closed enums guard bad values");
{
  assert(isTermStatus("preferred") && isTermStatus("forbidden") && isTermStatus("do_not_translate"), "valid statuses accepted");
  assert(!isTermStatus("banned") && !isTermStatus("") && !isTermStatus(3), "invalid statuses rejected");
  assert(TERM_STATUSES.length === 5, "exactly 5 term statuses");
  assert(REGISTERS.length === 3, "exactly 3 registers");
}

console.log("[parseCsvRows] RFC-4180 quoting");
{
  const rows = parseCsvRows('a,b,c\r\n"quoted, comma","has ""quote""","line\nbreak"\n');
  assert(rows.length === 2, "two rows parsed");
  assert(rows[0].cells.join("|") === "a|b|c", "plain header row");
  assert(rows[1].cells[0] === "quoted, comma", "quoted comma preserved");
  assert(rows[1].cells[1] === 'has "quote"', "escaped double-quote unescaped");
  assert(rows[1].cells[2] === "line\nbreak", "embedded newline preserved");
}

console.log("[parseCsvRows] BOM + trailing blank line");
{
  const rows = parseCsvRows("﻿concept_id,source_term\nkt/god,God\n\n");
  assert(rows.length === 2, "BOM stripped, trailing blank line dropped");
  assert(rows[0].cells[0] === "concept_id", "BOM not attached to first header cell");
}

console.log("[parseTermsCsv] happy path with all columns");
{
  const csv =
    "concept_id,source_term,target_term,status,replacement,comment,tw_link\n" +
    "kt/god,God,الله,preferred,,the standard rendering,rc://*/tw/dict/bible/kt/god\n" +
    "kt/god,god,إله,forbidden,الله,pagan sense,\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(errors.length === 0, "no parse errors");
  assert(terms.length === 2, "two terms parsed");
  assert(terms[0].target_term === "الله" && terms[0].tw_link.includes("kt/god"), "row 1 fields");
  assert(terms[1].status === "forbidden" && terms[1].replacement === "الله", "forbidden row carries replacement");
  assert(terms[0].comment === "the standard rendering", "comment parsed");
}

console.log("[parseTermsCsv] column reordering + missing optional columns");
{
  const csv = "source_term,concept_id,status\nGod,kt/god,admitted\nLord,kt/lord,\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(errors.length === 0, "no errors with reordered/missing columns");
  assert(terms[0].concept_id === "kt/god" && terms[0].status === "admitted", "columns matched by header name");
  assert(terms[1].status === "preferred", "empty status defaults to preferred");
  assert(terms[0].target_term === null, "missing optional column is null");
}

console.log("[parseTermsCsv] error rows are reported, not guessed");
{
  // Row 4 (kt/lord, forbidden, no replacement) is now also an error — the
  // forbidden->replacement invariant applies during import too, not just the
  // create/update routes.
  const csv =
    "concept_id,source_term,status\nkt/god,God,banned\n,Empty,preferred\nkt/lord,Lord,forbidden\nkt/law,Law,preferred\n";
  const { terms, errors } = parseTermsCsv(csv);
  assert(terms.length === 1, "only the one valid row is kept");
  assert(terms[0].source_term === "Law", "the valid row survived");
  assert(errors.length === 3, "three error rows reported");
  assert(errors[0].line === 2 && /invalid status/.test(errors[0].message), "bad status reported with line number");
  assert(errors[1].line === 3 && /required/.test(errors[1].message), "missing concept_id reported");
  assert(errors[2].line === 4 && /replacement/.test(errors[2].message), "forbidden-without-replacement reported");
}

console.log("[termInvariantError] forbidden requires a non-empty replacement");
{
  assert(termInvariantError({ status: "forbidden", replacement: null }) !== null, "forbidden + null replacement rejected");
  assert(termInvariantError({ status: "forbidden", replacement: "" }) !== null, "forbidden + empty replacement rejected");
  assert(termInvariantError({ status: "forbidden", replacement: "   " }) !== null, "forbidden + whitespace-only replacement rejected");
  assert(termInvariantError({ status: "forbidden", replacement: "use X" }) === null, "forbidden + real replacement accepted");
  assert(termInvariantError({ status: "preferred", replacement: null }) === null, "non-forbidden status never requires a replacement");
}

console.log("[parseTermsCsv] header without required columns");
{
  const { terms, errors } = parseTermsCsv("foo,bar\n1,2\n");
  assert(terms.length === 0 && errors.length === 1, "no terms, one header error");
  assert(/concept_id and source_term/.test(errors[0].message), "header error names the missing columns");
}

console.log("[serializeTermsCsv] round-trips through parse");
{
  const original =
    "concept_id,source_term,target_term,status,replacement,comment,tw_link\n" +
    'kt/god,God,"الله, the One",preferred,,"has, comma",\n';
  const { terms } = parseTermsCsv(original);
  const out = serializeTermsCsv(terms);
  const reparsed = parseTermsCsv(out).terms;
  assert(reparsed.length === 1, "one row survives round-trip");
  assert(reparsed[0].target_term === "الله, the One", "comma-bearing target survives quoting");
  assert(reparsed[0].comment === "has, comma", "comma-bearing comment survives quoting");
  assert(out.startsWith("concept_id,source_term,target_term,status,replacement,comment,tw_link"), "canonical header emitted");
}

console.log("[termKey + dedupeTerms] identity is (concept, source, target, status)");
{
  const a = { concept_id: "kt/God", source_term: "God ", target_term: " \u0627\u0644\u0644\u0647", status: "preferred" };
  const b = { concept_id: "kt/god", source_term: "god", target_term: "\u0627\u0644\u0644\u0647 ", status: "preferred" };
  assert(termKey(a) === termKey(b), "termKey is case/space-insensitive on concept+source+target");

  const row = (target_term, status, extra = {}) => ({
    concept_id: "kt/god",
    source_term: "God",
    target_term,
    status,
    replacement: null,
    comment: null,
    tw_link: null,
    ...extra,
  });

  // Rows that differ only by target_term are distinct renderings now, not a
  // collision (CONTEXT-REPO-CONTRACT.md section 3.3).
  const distinct = dedupeTerms([row("first", "preferred"), row("second", "preferred")]);
  assert(distinct.length === 2, "rows differing only by target_term are distinct renderings");

  // Status is still part of the identity.
  const byStatus = dedupeTerms([row("x", "preferred"), row("x", "forbidden", { replacement: "y" })]);
  assert(byStatus.length === 2, "same rendering under a different status is still distinct");

  // A true full-key duplicate still collapses last-wins.
  const dupes = dedupeTerms([
    row(" \u0646\u0639\u0645\u0629", "preferred", { comment: "first upload" }),
    row("\u0646\u0639\u0645\u0629 ", "preferred", { comment: "second upload" }),
  ]);
  assert(dupes.length === 1, "full-key duplicate collapses to one row");
  assert(dupes[0].comment === "second upload", "last-wins on a true collision");
}

console.log("[termKey] null-safe target_term (the do_not_translate case)");
{
  const base = { concept_id: "names/yhwh", source_term: "YHWH", status: "do_not_translate" };
  const k = termKey({ ...base, target_term: null });
  assert(termKey({ ...base, target_term: undefined }) === k, "undefined target_term matches null");
  assert(termKey({ ...base }) === k, "absent target_term matches null");
  assert(termKey({ ...base, target_term: "" }) === k, "empty-string target_term matches null");
  assert(termKey({ ...base, target_term: "   " }) === k, "whitespace-only target_term matches null");
  assert(termKey({ ...base, target_term: "\u064a\u0647\u0648\u0647" }) !== k, "a real rendering differs from the empty one");

  const dnt = (target_term) => ({
    concept_id: "names/yhwh",
    source_term: "YHWH",
    target_term,
    status: "do_not_translate",
    replacement: null,
    comment: null,
    tw_link: null,
  });
  assert(dedupeTerms([dnt(null), dnt(""), dnt("  ")]).length === 1, "empty-target DNT rows still collide with each other");
}

console.log("[sqlFold + termKey] normalization mirrors SQLite LOWER(TRIM(...)), not JS Unicode folding");
{
  assert(sqlFold("  God  ") === "god", "ASCII lowercased and outer spaces trimmed");
  assert(sqlFold("Élohim") === "Élohim", "non-ASCII case is left alone (SQLite LOWER is ASCII-only)");
  assert(sqlFold("\tGod\t") === "\tgod\t", "tabs are not trimmed (SQLite TRIM strips U+0020 only)");
  assert(sqlFold("\u00a0God\u00a0") === "\u00a0god\u00a0", "NBSP is not trimmed either");

  const t = (target_term) => ({ concept_id: "kt/god", source_term: "God", target_term, status: "preferred" });
  // The SQL index treats these as two rows, so termKey must too — otherwise the
  // dry-run would promise "updated" and the apply would insert.
  assert(termKey(t("Élohim")) !== termKey(t("élohim")), "cased non-ASCII renderings stay distinct, matching the SQL index");
  // ASCII case and outer spaces still fold, exactly as LOWER(TRIM()) does.
  const g = (concept_id, source_term) => ({ concept_id, source_term, target_term: "x", status: "preferred" });
  assert(termKey(g("kt/god", "God")) === termKey(g("kt/god", "GOD")), "ASCII case folds on source_term");
  assert(termKey(g("kt/god", "God")) === termKey(g(" kt/god ", " god ")), "outer U+0020 trimmed on concept + source");
  // A tab-padded stored rendering (reachable via PATCH, which does not trim) is
  // genuinely a different row in SQL, so it must not fold to the untabbed one.
  assert(termKey(t("\t\u0646\u0639\u0645\u0629")) !== termKey(t("\u0646\u0639\u0645\u0629")), "tab-padded rendering is not folded onto the untabbed one");
  assert(termKey(t(" \u0646\u0639\u0645\u0629 ")) === termKey(t("\u0646\u0639\u0645\u0629")), "space-padded rendering still folds");
}

console.log("[parseCsvRows] rows report their physical line, not their index");
{
  // A wholly-blank line is dropped from the row list but still consumed a line.
  const withBlank = parseTermsCsv("concept_id,source_term,target_term,status\n\nkt/x,x,,badstatus\n");
  assert(withBlank.errors.length === 1, "the bad-status row is the only error");
  assert(withBlank.errors[0].line === 3, "blank line counted: the row is physically on line 3");

  // A quoted field containing a newline spans two physical lines.
  const withEmbedded = parseTermsCsv(
    "concept_id,source_term,target_term,status,comment\n" +
      'kt/a,a,x,preferred,"two\nlines"\n' +
      "kt/b,b,,badstatus\n",
  );
  assert(withEmbedded.terms.length === 1, "the good row parsed");
  assert(withEmbedded.terms[0].line === 2, "the multi-line row reports its starting line");
  assert(withEmbedded.terms[0].comment === "two\nlines", "the embedded newline stayed in the cell");
  assert(withEmbedded.errors.length === 1 && withEmbedded.errors[0].line === 4, "the next row is line 4, not line 3");

  // Header = line 1, first data row = line 2 (unchanged arithmetic).
  const plain = parseTermsCsv("concept_id,source_term,target_term,status\nkt/x,x,y,preferred\n");
  assert(plain.terms[0].line === 2, "first data row is line 2");
}

console.log("[dedupeTerms] a ParsedTerm keeps its line through dedup");
{
  const csv =
    "concept_id,source_term,target_term,status,comment\n" +
    "kt/grace,grace,\u0646\u0639\u0645\u0629,preferred,first\n" +
    "kt/grace,grace,\u0646\u0639\u0645\u0629,preferred,second\n";
  const { terms } = parseTermsCsv(csv);
  const deduped = dedupeTerms(terms);
  assert(deduped.length === 1, "the true duplicate collapses");
  assert(deduped[0].comment === "second" && deduped[0].line === 3, "the surviving row keeps its own line");
}

console.log("[contract \u00a73.3] one concept holds several equally-valid renderings");
{
  // Straight from the real Arabic termbase: three preferred renderings of
  // "therefore", two admitted renderings of "pastor". None may be lost.
  const mk = (concept_id, source_term, target_term, status) => ({
    concept_id,
    source_term,
    target_term,
    status,
    replacement: null,
    comment: null,
    tw_link: null,
  });
  const batch = [
    mk("other/therefore", "therefore", "\u0645\u0646 \u062b\u064e\u0645\u064e\u0651", "preferred"),
    mk("other/therefore", "therefore", "\u0648\u0628\u0630\u0644\u0643", "preferred"),
    mk("other/therefore", "therefore", "\u0648\u0647\u0643\u0630\u0627", "preferred"),
    mk("kt/pastor", "pastor", "\u0642\u0627\u0626\u062f \u0627\u0644\u0643\u0646\u064a\u0633\u0629", "admitted"),
    mk("kt/pastor", "pastor", "\u0627\u0644\u0645\u0639\u0644\u0650\u0651\u0645", "admitted"),
  ];
  const deduped = dedupeTerms(batch);
  assert(deduped.length === 5, "all five sibling renderings survive dedup");
  const therefore = deduped.filter((t) => t.concept_id === "other/therefore");
  assert(therefore.length === 3, "three preferred renderings kept under one concept");
  assert(new Set(therefore.map((t) => t.target_term)).size === 3, "the three renderings are the three distinct strings");
  assert(deduped.filter((t) => t.concept_id === "kt/pastor").length === 2, "two admitted renderings kept");
}

console.log("[parseTermsCsv] duplicate rows warn (but still last-wins)");
{
  const csv =
    "concept_id,source_term,target_term,status\n" +
    "kt/grace,grace,\u0646\u0639\u0645\u0629,preferred\n" +
    "kt/grace,grace,\u0646\u0639\u0645\u0629,preferred\n";
  const { terms, errors, warnings } = parseTermsCsv(csv);
  assert(errors.length === 0, "a duplicate is not a hard error");
  assert(warnings.length === 1, "one duplicate warning");
  assert(warnings[0].line === 3, "warning carries the later row's line");
  assert(/line 2/.test(warnings[0].message), "warning names the first occurrence's line");
  assert(/later row wins/.test(warnings[0].message), "warning states the last-wins outcome");
  assert(dedupeTerms(terms).length === 1, "still collapses to one term");
}

console.log("[parseTermsCsv] near-miss (same concept+source+status, different rendering) never warns");
{
  const csv =
    "concept_id,source_term,target_term,status\n" +
    "other/therefore,therefore,\u0648\u0628\u0630\u0644\u0643,preferred\n" +
    "other/therefore,therefore,\u0648\u0647\u0643\u0630\u0627,preferred\n";
  const { terms, errors, warnings } = parseTermsCsv(csv);
  assert(errors.length === 0 && warnings.length === 0, "sibling renderings produce no errors and no warnings");
  assert(dedupeTerms(terms).length === 2, "both renderings survive");
}

console.log("[parseTermsCsv] warnings is total across early-return paths");
{
  assert(Array.isArray(parseTermsCsv("").warnings), "empty file still returns a warnings array");
  assert(parseTermsCsv("").warnings.length === 0, "empty file has no warnings");
  assert(Array.isArray(parseTermsCsv("foo,bar\n1,2\n").warnings), "bad header still returns a warnings array");
  assert(parseTermsCsv("foo,bar\n1,2\n").warnings.length === 0, "bad header has no warnings");
}

console.log("[serializeTermsCsv] sibling renderings survive a CSV round-trip");
{
  const mk = (target_term) => ({
    concept_id: "other/therefore",
    source_term: "therefore",
    target_term,
    status: "preferred",
    replacement: null,
    comment: null,
    tw_link: null,
  });
  const original = [mk("\u0645\u0646 \u062b\u064e\u0645\u064e\u0651"), mk("\u0648\u0628\u0630\u0644\u0643"), mk("\u0648\u0647\u0643\u0630\u0627")];
  const reparsed = parseTermsCsv(serializeTermsCsv(original));
  assert(reparsed.errors.length === 0, "no parse errors on re-import");
  assert(reparsed.warnings.length === 0, "no duplicate warnings \u2014 they are distinct renderings");
  assert(reparsed.terms.length === 3, "all three preferred rows survive serialize -> parse");
  assert(
    reparsed.terms.map((t) => t.target_term).join("|") === original.map((t) => t.target_term).join("|"),
    "renderings round-trip in order, none lost",
  );
  assert(dedupeTerms(reparsed.terms).length === 3, "and none collapse in dedup");
}

console.log("[parseIfMatch] bare/quoted integers, rejects garbage");
{
  assert(parseIfMatch("3") === 3, "bare integer");
  assert(parseIfMatch('"3"') === 3, "quoted integer");
  assert(parseIfMatch("0") === 0, "zero (first-write sentinel)");
  assert(parseIfMatch(undefined) === null, "missing header");
  assert(parseIfMatch("abc") === null, "non-numeric header rejected");
  assert(parseIfMatch("3.5") === null, "fractional header rejected");
}

console.log("[escapeLikeParam] % and _ become literal in a LIKE pattern");
{
  assert(escapeLikeParam("100%") === "100\\%", "percent escaped");
  assert(escapeLikeParam("do_not") === "do\\_not", "underscore escaped");
  assert(escapeLikeParam("a\\b") === "a\\\\b", "backslash itself escaped");
  assert(escapeLikeParam("grace") === "grace", "plain text unchanged");
}

console.log("[serializeTermsCsv excelSafe] formula-leading cells neutralized, round-trip lossless");
{
  const hostile = [
    {
      concept_id: "attack",
      source_term: "=HYPERLINK(\"http://evil.example\",\"click\")",
      target_term: "+cmd|' /C calc'!A0",
      status: "preferred",
      replacement: null,
      comment: "-2+3+cmd|' /C calc'!A0",
      tw_link: "@SUM(1+9)",
    },
    {
      concept_id: "legit",
      source_term: "grace",
      target_term: "-suffix",
      status: "preferred",
      replacement: null,
      comment: "'til next time",
      tw_link: null,
    },
  ];

  const safe = serializeTermsCsv(hostile, { excelSafe: true });
  for (const line of safe.split("\r\n").slice(1)) {
    for (const cell of parseCsvRows(line + "\n")[0]?.cells ?? []) {
      assert(!/^[=+\-@\t\r]/.test(cell), `no cell starts with a formula char: ${JSON.stringify(cell)}`);
    }
  }

  // Round-trip: download (excelSafe) → import strips the guard back off.
  const roundTrip = parseTermsCsv(safe);
  assert(roundTrip.errors.length === 0, "guarded CSV parses without errors");
  assert(
    roundTrip.terms[0].source_term === hostile[0].source_term,
    "formula-leading source_term survives the round-trip unchanged",
  );
  assert(
    roundTrip.terms[1].target_term === "-suffix",
    "legitimate leading-hyphen term survives the round-trip unchanged",
  );
  assert(
    roundTrip.terms[1].comment === "'til next time",
    "apostrophe-leading text is NOT stripped (guard only precedes formula chars)",
  );

  // The DCS context-repo serialization is a machine-read contract — default
  // (no excelSafe) must keep emitting the raw cell bytes.
  const contract = serializeTermsCsv(hostile);
  assert(
    contract.includes("=HYPERLINK"),
    "default serialization leaves cells untouched (CONTEXT-REPO-CONTRACT)",
  );
  assert(!contract.includes("'="), "default serialization adds no guard quotes");
}

console.log("\nAll translationMemoryLib tests passed.");
