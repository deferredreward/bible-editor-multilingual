// Unit tests for the per-book source-override resolver (bookSource.ts, issue
// #103). Covers the resolution PRECEDENCE (per-book → project-wide → org default)
// and the SECURITY guards (non-ident org/repo must never yield a usable ref —
// the stored value is re-validated on read, never trusted raw). Pure function,
// no D1. Run from api/:
//   node --experimental-strip-types --no-warnings src/bookSource.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  resolveEffectiveNoteSource,
  isBookSourceResource,
  getBookSourceOverride,
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

// Minimal ProjectConfig — only the fields the resolver reads (org, repos[role],
// translationSource). org's own tN repo is BSOJ/ar_tn; project-wide source is
// unfoldingWord/en_tn.
const CFG = {
  org: "BSOJ",
  repos: { lit: "ar_avd", sim: "ar_nav", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl", tw: "ar_tw", ta: "ar_ta" },
  translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn", tq: "en_tq" } },
};
// A project with NO translationSource (authored / not-a-translation project).
const CFG_NO_SRC = { ...CFG, translationSource: null };

function run() {
  const aquifer = { org: "BibleAquifer", repo: "arb_tn" };

  // ── PRECEDENCE ──────────────────────────────────────────────────────────

  // 1. Per-book override + translateFromSource=false → the override wins. An
  //    explicit per-book decision applies even without the project-level flag.
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", aquifer, false), ref("BibleAquifer", "arb_tn")),
    "per-book override applies even when translateFromSource is false",
  );

  // 2. Per-book override + translateFromSource=true → per-book still wins over
  //    the project-wide translationSource ref.
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", aquifer, true), ref("BibleAquifer", "arb_tn")),
    "per-book override beats the project-wide translationSource",
  );

  // 3. No override + translateFromSource=true → the project-wide ref.
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", null, true), ref("unfoldingWord", "en_tn")),
    "no override + translateFromSource → project-wide translationSource ref",
  );

  // 4. No override + translateFromSource=false → null (fetch from org's own repo).
  assert(
    resolveEffectiveNoteSource(CFG, "tn", null, false) === null,
    "no override + no translateFromSource → null (org's own repo)",
  );

  // 5. Per-book override applies on a NON-translation project too (self-contained;
  //    does not need a translationSource).
  assert(
    eq(resolveEffectiveNoteSource(CFG_NO_SRC, "tn", aquifer, false), ref("BibleAquifer", "arb_tn")),
    "per-book override works with no translationSource configured",
  );

  // ── NO-OP: an override equal to the org's own repo ────────────────────────
  // Must NOT be returned as an override (would spuriously stamp source:… and
  // hold the book out of reimport/export). Case-insensitive (DCS is).
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "BSOJ", repo: "ar_tn" }, false) === null,
    "override == org's own repo → null (not a real override, not held out)",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "bsoj", repo: "AR_TN" }, false) === null,
    "override == org's own repo (different casing) → still a no-op",
  );
  // And it falls THROUGH to the project-wide ref when translateFromSource is set.
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", { org: "BSOJ", repo: "ar_tn" }, true), ref("unfoldingWord", "en_tn")),
    "org's-own-repo override falls through to project-wide when translateFromSource",
  );

  // ── SECURITY: non-ident override must never leave the resolver as a ref ────
  // A path-traversal org/repo re-validates to null (never trusted raw) and falls
  // through — exactly as an unvalidated project-wide override does.
  const evilOrg = { org: "uW/../../evil", repo: "x_tn" };
  const evilRepo = { org: "unfoldingWord", repo: "../../../etc" };
  assert(
    resolveEffectiveNoteSource(CFG, "tn", evilOrg, false) === null,
    "traversal in override org → null (no source), translateFromSource=false",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", evilRepo, false) === null,
    "traversal in override repo → null (no source)",
  );
  // The bad override is DROPPED, but a valid project-wide ref still resolves —
  // the traversal never leaks in place of it.
  assert(
    eq(resolveEffectiveNoteSource(CFG, "tn", evilOrg, true), ref("unfoldingWord", "en_tn")),
    "traversal override dropped → falls through to project-wide ref, no leak",
  );
  // Blank / malformed values → null-through too.
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "", repo: "" }, false) === null,
    "blank override org/repo → null",
  );
  assert(
    resolveEffectiveNoteSource(CFG, "tn", { org: "has space", repo: "x_tn" }, false) === null,
    "non-ident (space) override org → null",
  );

  // ── isBookSourceResource: only tN is supported in this increment ──────────
  assert(isBookSourceResource("tn") === true, "isBookSourceResource: tn → true");
  assert(isBookSourceResource("tq") === false, "isBookSourceResource: tq → false (fast-follow)");
  assert(isBookSourceResource("scripture") === false, "isBookSourceResource: scripture → false");
  assert(isBookSourceResource("") === false, "isBookSourceResource: empty → false");

  console.log("bookSource/resolver: all assertions passed");
}

// getBookSourceOverride read-failure policy (regression for the Codex #106
// finding): a "no such table" error (migration not applied) → null (safe: no
// table means no override), but ANY OTHER read error must THROW rather than be
// swallowed as "no override" — swallowing would let an import of an overridden
// book silently pull from the wrong repo and clobber its notes + hold-out.
async function runReadFailurePolicy() {
  const envThatThrows = (msg) => ({
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first() {
                throw new Error(msg);
              },
            };
          },
        };
      },
    },
  });

  const missing = await getBookSourceOverride(
    envThatThrows("D1_ERROR: no such table: book_source_overrides"),
    "MRK",
    "tn",
  );
  assert(missing === null, "getBookSourceOverride: missing table → null (safe no-override)");

  let threw = false;
  try {
    await getBookSourceOverride(envThatThrows("D1_ERROR: network connection lost"), "MRK", "tn");
  } catch {
    threw = true;
  }
  assert(threw, "getBookSourceOverride: transient error → THROWS (never a silent no-override)");

  console.log("bookSource/read-failure policy: all assertions passed");
}

run();
runReadFailurePolicy().catch((e) => {
  console.error("threw:", e);
  process.exit(1);
});
