// Unit + storage tests for per-book / per-chapter-range source overrides
// (bookSource.ts, issue #103 Tier 1 + Tier 2 + the Aquifer-per-range follow-up).
// Covers resolution PRECEDENCE, SECURITY guards (non-ident org/repo and invalid
// Aquifer langs never yield a usable source), the range planner + hold-out
// derivation, per-chapter partitioning, and the storage layer against a real
// SQLite (node:sqlite) with the 0060→0061→0062 migration chain applied. Run
// from api/:
//   node --experimental-strip-types --no-warnings src/bookSource.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  resolveEffectiveNoteSource,
  resolveRangeSource,
  isBookSourceResource,
  rangeCoversChapter,
  rangesOverlap,
  planNoteSourcesFromRanges,
  sourceRefForChapter,
  heldOutChaptersFromRanges,
  isChapterHeldOut,
  getBookSourceRanges,
  getBookSourceOverride,
  setBookSourceOverride,
  setBookSourceRange,
  clearBookSourceOverride,
  clearBookSourceRange,
  listBookSourceOverrides,
  listRangeHeldOutKeys,
  WHOLE_BOOK_START,
  WHOLE_BOOK_END,
} from "./bookSource.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ref = (owner, repo) => ({ owner, repo, ref: "master" });
const dcsSrc = (owner, repo) => ({ kind: "dcs", ref: ref(owner, repo) });
const aqSrc = (aqLang) => ({ kind: "aquifer", aqLang });
// Stored-range builders (what getBookSourceRanges returns / the plan consumes).
const dcsRange = (cs, ce, org, repo) => ({ chapter_start: cs, chapter_end: ce, kind: "dcs", org, repo });
const aqRange = (cs, ce, aqLang) => ({ chapter_start: cs, chapter_end: ce, kind: "aquifer", org: "aquifer", repo: aqLang });

const CFG = {
  org: "BSOJ",
  repos: { lit: "ar_avd", sim: "ar_nav", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl", tw: "ar_tw", ta: "ar_ta" },
  translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn", tq: "en_tq" } },
};
const CFG_NO_SRC = { ...CFG, translationSource: null };

function runPure() {
  const aquifer = { org: "BibleAquifer", repo: "arb_tn" };

  // ── PRECEDENCE (Tier 1, resolveEffectiveNoteSource) ───────────────────────
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", aquifer, false), ref("BibleAquifer", "arb_tn")),
    "override applies even when translateFromSource is false",
  );
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", aquifer, true), ref("BibleAquifer", "arb_tn")),
    "override beats the project-wide translationSource",
  );
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", null, true), ref("unfoldingWord", "en_tn")),
    "no override + translateFromSource → project-wide ref",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", null, false) === null,
    "no override + no translateFromSource → null (org's own repo)",
  );
  assert(
    eq(resolveEffectiveNoteSource(CFG_NO_SRC, "tn", aquifer, false), ref("BibleAquifer", "arb_tn")),
    "override works with no translationSource configured",
  );
  // tQ resolves symmetrically (widened resource).
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tq", { org: "unfoldingWord", repo: "en_tq" }, false), ref("unfoldingWord", "en_tq")),
    "tQ override resolves symmetrically to tN",
  );

  // org's-own-repo override → no-op
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "BSOJ", repo: "ar_tn" }, false) === null,
    "override == org's own repo → null (not held out)",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "bsoj", repo: "AR_TN" }, false) === null,
    "override == org's own repo (casing) → still a no-op",
  );

  // SECURITY: traversal / non-ident → null-through
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "uW/../../evil", repo: "x_tn" }, false) === null,
    "traversal in override org → null",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "unfoldingWord", repo: "../../../etc" }, false) === null,
    "traversal in override repo → null",
  );
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", { org: "uW/../../evil", repo: "x_tn" }, true), ref("unfoldingWord", "en_tn")),
    "traversal override dropped → falls through to project-wide, no leak",
  );

  // ── resolveRangeSource (dcs + aquifer discriminator) ──────────────────────
  assert(
    eq(resolveRangeSource(CFG, "tn", dcsRange(12, 16, "BibleAquifer", "arb_tn")), dcsSrc("BibleAquifer", "arb_tn")),
    "resolveRangeSource: dcs cross-org → { kind:'dcs', ref }",
  );
  assert(
    resolveRangeSource(CFG, "tn", dcsRange(1, 11, "BSOJ", "ar_tn")) === null,
    "resolveRangeSource: dcs org's-own → null (no-op)",
  );
  assert(
    resolveRangeSource(CFG, "tn", dcsRange(12, 16, "a/../b", "x")) === null,
    "resolveRangeSource: dcs non-ident → null",
  );
  assert(
    eq(resolveRangeSource(CFG, "tn", aqRange(12, 16, "arb")), aqSrc("arb")),
    "resolveRangeSource: aquifer/tn valid lang → { kind:'aquifer', aqLang }",
  );
  assert(
    resolveRangeSource(CFG, "tq", aqRange(12, 16, "arb")) === null,
    "resolveRangeSource: aquifer/tq → null (Aquifer is tN-only)",
  );
  assert(
    resolveRangeSource(CFG, "tn", aqRange(12, 16, "zzz")) === null,
    "resolveRangeSource: aquifer with unknown lang → null (allowlist guard)",
  );
  assert(
    resolveRangeSource(CFG, "tn", aqRange(12, 16, "../../etc")) === null,
    "resolveRangeSource: aquifer with traversal lang → null (no path-traversal)",
  );

  // ── isBookSourceResource: tn + tq only ────────────────────────────────────
  assert(isBookSourceResource("tn") === true, "isBookSourceResource: tn → true");
  assert(isBookSourceResource("tq") === true, "isBookSourceResource: tq → true");
  assert(isBookSourceResource("tw") === false, "isBookSourceResource: tw → false (language-neutral)");
  assert(isBookSourceResource("scripture") === false, "isBookSourceResource: scripture → false (lane model)");
  assert(isBookSourceResource("") === false, "isBookSourceResource: empty → false");

  // ── Range helpers ─────────────────────────────────────────────────────────
  assert(rangeCoversChapter({ chapter_start: 12, chapter_end: 16 }, 12) === true, "rangeCovers: start inclusive");
  assert(rangeCoversChapter({ chapter_start: 12, chapter_end: 16 }, 16) === true, "rangeCovers: end inclusive");
  assert(rangeCoversChapter({ chapter_start: 12, chapter_end: 16 }, 11) === false, "rangeCovers: below → false");
  assert(rangeCoversChapter({ chapter_start: 12, chapter_end: 16 }, 17) === false, "rangeCovers: above → false");
  assert(
    rangesOverlap({ chapter_start: 1, chapter_end: 11 }, { chapter_start: 11, chapter_end: 16 }) === true,
    "rangesOverlap: touching at 11 → true",
  );
  assert(
    rangesOverlap({ chapter_start: 1, chapter_end: 11 }, { chapter_start: 12, chapter_end: 16 }) === false,
    "rangesOverlap: adjacent 1-11 / 12-16 → false",
  );

  // ── planNoteSourcesFromRanges ─────────────────────────────────────────────
  // No ranges + org's own base.
  assert(
    eq(planNoteSourcesFromRanges(CFG, "tn", [], false), { base: null, ranges: [] }),
    "plan: no ranges, no translateFromSource → base null, no ranges",
  );
  // No ranges + project-wide base.
  assert(
    eq(planNoteSourcesFromRanges(CFG, "tn", [], true), { base: ref("unfoldingWord", "en_tn"), ranges: [] }),
    "plan: no ranges + translateFromSource → base = project-wide",
  );
  // Whole-book override collapses into base, yields no per-chapter ranges (Tier 1 path).
  assert(
    eq(
      planNoteSourcesFromRanges(CFG, "tn", [dcsRange(WHOLE_BOOK_START, WHOLE_BOOK_END, "BibleAquifer", "arb_tn")], false),
      { base: ref("BibleAquifer", "arb_tn"), ranges: [] },
    ),
    "plan: whole-book override → base = override, no per-chapter ranges",
  );
  // The BSOJ shape: 1-11 org's own (dropped as no-op), 12-16 Aquifer (DCS repo).
  const bsoj = planNoteSourcesFromRanges(
    CFG,
    "tn",
    [dcsRange(1, 11, "BSOJ", "ar_tn"), dcsRange(12, 16, "BibleAquifer", "arb_tn")],
    false,
  );
  assert(
    bsoj.base === null &&
      bsoj.ranges.length === 1 &&
      eq(bsoj.ranges[0], { chapter_start: 12, chapter_end: 16, source: dcsSrc("BibleAquifer", "arb_tn") }),
    "plan: BSOJ shape → base null (org's own for 1-11), one cross-org range 12-16",
  );
  // Non-ident range dropped.
  assert(
    eq(planNoteSourcesFromRanges(CFG, "tn", [dcsRange(12, 16, "a/../b", "x")], false), { base: null, ranges: [] }),
    "plan: non-ident range dropped",
  );

  // The literal BSOJ test-drive with AQUIFER: 12-16 from Aquifer, base = org's own.
  const bsojAq = planNoteSourcesFromRanges(CFG, "tn", [aqRange(12, 16, "arb")], false);
  assert(
    bsojAq.base === null &&
      bsojAq.ranges.length === 1 &&
      eq(bsojAq.ranges[0], { chapter_start: 12, chapter_end: 16, source: aqSrc("arb") }),
    "plan: Aquifer range 12-16 → base null, one aquifer range",
  );
  // A defensive whole-book Aquifer range (write-rejected, but resolver-safe) never
  // becomes a base and is skipped.
  assert(
    eq(planNoteSourcesFromRanges(CFG, "tn", [aqRange(WHOLE_BOOK_START, WHOLE_BOOK_END, "arb")], false), {
      base: null,
      ranges: [],
    }),
    "plan: whole-book aquifer range → skipped (never a base)",
  );

  // Mixed three-way partition: 1-4 cross-org DCS, 12-16 Aquifer, rest = base(null).
  const mixed = planNoteSourcesFromRanges(
    CFG,
    "tn",
    [dcsRange(1, 4, "unfoldingWord", "en_tn"), aqRange(12, 16, "arb")],
    false,
  );
  assert(mixed.base === null && mixed.ranges.length === 2, "plan: mixed dcs+aquifer → base null, two ranges");
  assert(eq(sourceRefForChapter(mixed, 2), dcsSrc("unfoldingWord", "en_tn")), "partition: ch 2 → dcs uW en_tn");
  assert(sourceRefForChapter(mixed, 8) === null, "partition: ch 8 → base (org's own, null)");
  assert(eq(sourceRefForChapter(mixed, 14), aqSrc("arb")), "partition: ch 14 → aquifer arb");

  // sourceRefForChapter on the DCS-only BSOJ shape
  assert(sourceRefForChapter(bsoj, 11) === null, "sourceRefForChapter: ch 11 → base (null)");
  assert(eq(sourceRefForChapter(bsoj, 14), dcsSrc("BibleAquifer", "arb_tn")), "sourceRefForChapter: ch 14 → Aquifer repo");

  // ── heldOutChaptersFromRanges ─────────────────────────────────────────────
  assert(
    eq(heldOutChaptersFromRanges(CFG, "tn", [], "source:unfoldingWord/en_tn"), { all: true }),
    "heldOut: book-level marker → all",
  );
  assert(
    eq(heldOutChaptersFromRanges(CFG, "tn", [], null), { all: false, ranges: [] }),
    "heldOut: no marker, no ranges → nothing",
  );
  assert(
    eq(
      heldOutChaptersFromRanges(CFG, "tn", [dcsRange(WHOLE_BOOK_START, WHOLE_BOOK_END, "BibleAquifer", "arb_tn")], null),
      { all: true },
    ),
    "heldOut: whole-book cross-org range (no marker yet) → all",
  );
  const held = heldOutChaptersFromRanges(
    CFG,
    "tn",
    [dcsRange(1, 11, "BSOJ", "ar_tn"), dcsRange(12, 16, "BibleAquifer", "arb_tn")],
    null,
  );
  assert(eq(held, { all: false, ranges: [{ start: 12, end: 16 }] }), "heldOut: BSOJ shape → only 12-16 held out");
  assert(isChapterHeldOut(held, 11) === false, "isChapterHeldOut: ch 11 (org's own) → false");
  assert(isChapterHeldOut(held, 12) === true, "isChapterHeldOut: ch 12 (Aquifer) → true");
  assert(isChapterHeldOut(held, 16) === true, "isChapterHeldOut: ch 16 → true");
  assert(isChapterHeldOut(held, 17) === false, "isChapterHeldOut: ch 17 → false");
  assert(isChapterHeldOut({ all: true }, 999) === true, "isChapterHeldOut: all → any chapter true");

  // Aquifer range → held out (it is never the org's own repo).
  const heldAq = heldOutChaptersFromRanges(CFG, "tn", [aqRange(12, 16, "arb")], null);
  assert(eq(heldAq, { all: false, ranges: [{ start: 12, end: 16 }] }), "heldOut: aquifer range 12-16 → held out");
  // Aquifer on tq never resolves → not held out.
  assert(
    eq(heldOutChaptersFromRanges(CFG, "tq", [aqRange(12, 16, "arb")], null), { all: false, ranges: [] }),
    "heldOut: aquifer range on tq → not held out (tN-only)",
  );

  console.log("bookSource/pure: all assertions passed");
}

// ── Storage layer against real SQLite (0060 → 0061 → 0062 migration chain) ───
// D1-over-node:sqlite shim: mirrors env.DB.prepare(sql).bind(...).first()/all()/run().
function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) {
          args = a.map((v) => (v === undefined ? null : v));
          return api;
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
        async all() {
          return { results: stmt.all(...args) };
        },
        async run() {
          stmt.run(...args);
          return {};
        },
      };
      return api;
    },
  };
}

async function runStorage() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1);");
  // Apply the exact migration chain that creates + reshapes the table.
  db.exec(readFileSync("migrations/0060_book_source_overrides.sql", "utf8"));
  // Seed a Tier 1 whole-book row on the OLD schema to prove 0061 migrates it to (0,999).
  db.exec("INSERT INTO book_source_overrides (book, resource, org, repo) VALUES ('LUK','tn','BibleAquifer','arb_tn');");
  db.exec(readFileSync("migrations/0061_book_source_ranges.sql", "utf8"));
  db.exec(readFileSync("migrations/0062_book_source_kind.sql", "utf8"));
  const env = { DB: d1(db) };

  // 0061 migrated the pre-existing whole-book row to (0, 999); 0062 defaulted kind='dcs'.
  const luk = await getBookSourceRanges(env, "LUK", "tn");
  assert(
    luk.length === 1 &&
      luk[0].chapter_start === WHOLE_BOOK_START &&
      luk[0].chapter_end === WHOLE_BOOK_END &&
      luk[0].kind === "dcs",
    "migration chain: pre-existing Tier 1 row → whole-book (0,999), kind='dcs'",
  );
  assert(eq(await getBookSourceOverride(env, "LUK", "tn"), { org: "BibleAquifer", repo: "arb_tn" }), "getBookSourceOverride reads the whole-book row");

  // Set the BSOJ shape on MRK: 12-16 from a DCS repo.
  await setBookSourceRange(env, "MRK", "tn", 12, 16, "dcs", "BibleAquifer", "arb_tn", 1);
  let mrk = await getBookSourceRanges(env, "MRK", "tn");
  assert(mrk.length === 1 && mrk[0].chapter_start === 12 && mrk[0].chapter_end === 16 && mrk[0].kind === "dcs", "setBookSourceRange: dcs 12-16 stored");
  // A whole-book override alongside is fine (different chapter_start) and does not overlap-check against itself.
  await setBookSourceRange(env, "MRK", "tn", 1, 11, "dcs", "unfoldingWord", "en_tn", 1);
  mrk = await getBookSourceRanges(env, "MRK", "tn");
  assert(mrk.length === 2, "setBookSourceRange: adjacent 1-11 added → two ranges");

  // Overlap rejected.
  let overlapRejected = false;
  try {
    await setBookSourceRange(env, "MRK", "tn", 5, 13, "dcs", "unfoldingWord", "en_tn", 1);
  } catch (e) {
    overlapRejected = e.message === "overlapping_range";
  }
  assert(overlapRejected, "setBookSourceRange: overlapping range (5-13 vs 1-11 & 12-16) → rejected");

  // Same start replaces (not overlap).
  await setBookSourceRange(env, "MRK", "tn", 12, 14, "dcs", "BibleAquifer", "arb_tn", 1);
  mrk = await getBookSourceRanges(env, "MRK", "tn");
  const r12 = mrk.find((r) => r.chapter_start === 12);
  assert(r12 && r12.chapter_end === 14, "setBookSourceRange: same start → replaced (end now 14)");

  // Invalid range rejected.
  let invalidRejected = false;
  try {
    await setBookSourceRange(env, "MRK", "tn", 16, 12, "dcs", "unfoldingWord", "en_tn", 1);
  } catch (e) {
    invalidRejected = e.message === "invalid_range";
  }
  assert(invalidRejected, "setBookSourceRange: end < start → invalid_range");

  // Non-ident rejected on write.
  let identRejected = false;
  try {
    await setBookSourceRange(env, "MRK", "tn", 20, 20, "dcs", "a/../b", "x", 1);
  } catch (e) {
    identRejected = e.message === "invalid_org_or_repo";
  }
  assert(identRejected, "setBookSourceRange: non-ident org → invalid_org_or_repo");

  // ── Aquifer range storage ──────────────────────────────────────────────────
  // Store an Aquifer range on TIT (tN, 1-3).
  await setBookSourceRange(env, "TIT", "tn", 1, 3, "aquifer", "aquifer", "arb", 1);
  const tit = await getBookSourceRanges(env, "TIT", "tn");
  assert(
    tit.length === 1 && tit[0].kind === "aquifer" && tit[0].org === "aquifer" && tit[0].repo === "arb",
    "setBookSourceRange: aquifer range stored (kind='aquifer', repo=aqLang)",
  );
  assert(
    eq(resolveRangeSource(CFG, "tn", tit[0]), aqSrc("arb")),
    "stored aquifer range round-trips through resolveRangeSource",
  );
  // Reject whole-book aquifer.
  let aqWholeRejected = false;
  try {
    await setBookSourceRange(env, "TIT", "tn", WHOLE_BOOK_START, WHOLE_BOOK_END, "aquifer", "aquifer", "arb", 1);
  } catch (e) {
    aqWholeRejected = e.message === "aquifer_needs_range";
  }
  assert(aqWholeRejected, "setBookSourceRange: whole-book aquifer → aquifer_needs_range");
  // Reject aquifer on tq.
  let aqTqRejected = false;
  try {
    await setBookSourceRange(env, "TIT", "tq", 1, 2, "aquifer", "aquifer", "arb", 1);
  } catch (e) {
    aqTqRejected = e.message === "aquifer_tn_only";
  }
  assert(aqTqRejected, "setBookSourceRange: aquifer on tq → aquifer_tn_only");
  // Reject unknown aquifer lang.
  let aqLangRejected = false;
  try {
    await setBookSourceRange(env, "TIT", "tn", 5, 6, "aquifer", "aquifer", "zzz", 1);
  } catch (e) {
    aqLangRejected = e.message === "invalid_aquifer_lang";
  }
  assert(aqLangRejected, "setBookSourceRange: unknown aquifer lang → invalid_aquifer_lang");

  // tQ coexists with tN independently.
  await setBookSourceOverride(env, "MRK", "tq", "unfoldingWord", "en_tq", 1);
  const list = await listBookSourceOverrides(env, "MRK");
  assert(list.some((r) => r.resource === "tq") && list.some((r) => r.resource === "tn"), "listBookSourceOverrides: tn + tq coexist");
  assert(list.every((r) => typeof r.kind === "string"), "listBookSourceOverrides: rows carry kind");

  // listRangeHeldOutKeys — the export skip's partial-book detection (the gate
  // that stops a partial book from pushing cross-sourced chapters over master).
  // State so far: LUK tn = whole-book Aquifer-repo (migrated); MRK tn = 12-14 DCS
  // + 1-11 uW; MRK tq = whole-book uW; TIT tn = 1-3 Aquifer. Add JON tn = 1-4
  // pointing at the org's OWN repo → a no-op that must NOT be held out.
  await setBookSourceRange(env, "JON", "tn", 1, 4, "dcs", "BSOJ", "ar_tn", 1);
  const keys = (await listRangeHeldOutKeys(env, CFG)).sort();
  assert(
    eq(keys, ["LUK:tn", "MRK:tn", "MRK:tq", "TIT:tn"]),
    "listRangeHeldOutKeys: partial + whole + aquifer held out, org's-own no-op excluded (JON absent)",
  );

  // Clear one range vs all.
  await clearBookSourceRange(env, "MRK", "tn", 1);
  assert((await getBookSourceRanges(env, "MRK", "tn")).length === 1, "clearBookSourceRange: 1-11 removed, 12-14 remains");
  await clearBookSourceOverride(env, "MRK", "tn");
  assert((await getBookSourceRanges(env, "MRK", "tn")).length === 0, "clearBookSourceOverride: all tn ranges removed");
  assert((await getBookSourceRanges(env, "MRK", "tq")).length === 1, "clearBookSourceOverride: tq untouched");

  console.log("bookSource/storage: all assertions passed");
}

// getBookSourceRanges read-failure policy (regression for the Codex #106 finding,
// carried to the range layer): missing table → [] (safe), transient → throw.
async function runReadFailurePolicy() {
  const envThatThrows = (msg) => ({
    DB: {
      prepare() {
        return { bind() { return { all() { throw new Error(msg); } }; } };
      },
    },
  });
  const missing = await getBookSourceRanges(envThatThrows("D1_ERROR: no such table: book_source_overrides"), "MRK", "tn");
  assert(eq(missing, []), "getBookSourceRanges: missing table → [] (safe)");
  let threw = false;
  try {
    await getBookSourceRanges(envThatThrows("D1_ERROR: network lost"), "MRK", "tn");
  } catch {
    threw = true;
  }
  assert(threw, "getBookSourceRanges: transient error → THROWS (never silent no-override)");
  console.log("bookSource/read-failure policy: all assertions passed");
}

runPure();
runStorage()
  .then(runReadFailurePolicy)
  .catch((e) => {
    console.error("threw:", e);
    process.exit(1);
  });
