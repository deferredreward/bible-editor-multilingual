// scripture.ts: fetching source/target USFM and building per-verse text maps,
// plus the renderBatchPack scripture section. Ported 1:1 from bp-assistant
// test/scripture-verses.test.js, with direct cases for the two USFM helpers
// that came along from verse-data.js.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/scripture.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScripturePack, collectVerseRefs, extractChapterVerse, stripMarkup } from "./scripture.ts";
import { renderBatchPack } from "./core.ts";

const ULT_USFM = "\\c 1\n\\v 1 \\w In|x-occurrence=\"1\"\\w* \\w the|x-occurrence=\"1\"\\w* \\w beginning|x-occurrence=\"1\"\\w*.\n"
  + "\\v 2 \\w And|x-occurrence=\"1\"\\w* \\w the|x-occurrence=\"2\"\\w* \\w earth|x-occurrence=\"1\"\\w* \\w was|x-occurrence=\"1\"\\w* \\w void|x-occurrence=\"1\"\\w*.\n";
const UST_USFM = "\\c 1\n\\v 1 \\w When|x-occurrence=\"1\"\\w* \\w God|x-occurrence=\"1\"\\w* \\w started|x-occurrence=\"1\"\\w*.\n"
  + "\\v 2 \\w The|x-occurrence=\"1\"\\w* \\w earth|x-occurrence=\"1\"\\w* \\w was|x-occurrence=\"1\"\\w* \\w empty|x-occurrence=\"1\"\\w*.\n";

// Mirrors the fetch-like impl shape fetchResourceFile expects: { status, ok, text() }.
function fakeFetch(byRef) {
  return async (url) => {
    for (const [ref, body] of Object.entries(byRef)) {
      if (url.includes(ref)) {
        if (body === null) return { status: 404, ok: false };
        return { status: 200, ok: true, text: async () => body };
      }
    }
    return { status: 404, ok: false };
  };
}

test("buildScripturePack fetches source + target USFM and builds byRef maps; missing target is absent", async () => {
  const urls = [];
  const inner = fakeFetch({
    en_ult: ULT_USFM,
    en_ust: UST_USFM,
    // no en_gl_glt entry → target literal 404s
  });
  const fetchImpl = async (url) => { urls.push(url); return inner(url); };

  const rows = [
    { Reference: "1:1", ID: "a1" },
    { Reference: "1:2", ID: "a2" },
  ];

  const pack = await buildScripturePack({
    book: "GEN",
    rows,
    sourceLiteralRef: "unfoldingWord/en_ult@master",
    sourceSimplifiedRef: "unfoldingWord/en_ust@master",
    targetLiteralRef: "ar_gl/ar_glt@master",
    targetSimplifiedRef: null,
  }, { fetchImpl });

  assert.equal(pack.targetLiteralFound, false);
  assert.equal(pack.targetSimplifiedFound, false);
  assert.equal(pack.versions.length, 2);

  const sourceLiteral = pack.versions.find((v) => v.role === "source-literal");
  assert.ok(sourceLiteral);
  assert.equal(sourceLiteral.label, "Source literal (ULT)");
  assert.equal(sourceLiteral.byRef["1:1"], "In the beginning");
  assert.equal(sourceLiteral.byRef["1:2"], "And the earth was void");

  const sourceSimplified = pack.versions.find((v) => v.role === "source-simplified");
  assert.ok(sourceSimplified);
  assert.equal(sourceSimplified.byRef["1:1"], "When God started");

  // Book-number file naming from dcsSources BOOK_NUMBERS.
  assert.ok(urls.some((u) => u.endsWith("/unfoldingWord/en_ult/raw/branch/master/01-GEN.usfm")), urls.join("\n"));
});

test("buildScripturePack includes target versions when present, with repo-derived labels", async () => {
  const fetchImpl = fakeFetch({
    en_ult: ULT_USFM,
    en_ust: UST_USFM,
    ar_glt: ULT_USFM,
    ar_gst: UST_USFM,
  });

  const rows = [{ Reference: "1:1", ID: "a1" }];

  const pack = await buildScripturePack({
    book: "GEN",
    rows,
    sourceLiteralRef: "unfoldingWord/en_ult@master",
    sourceSimplifiedRef: "unfoldingWord/en_ust@master",
    targetLiteralRef: "ar_gl/ar_glt@master",
    targetSimplifiedRef: "ar_gl/ar_gst@master",
  }, { fetchImpl });

  assert.equal(pack.targetLiteralFound, true);
  assert.equal(pack.targetSimplifiedFound, true);
  assert.equal(pack.versions.length, 4);
  const targetLiteral = pack.versions.find((v) => v.role === "target-literal");
  assert.equal(targetLiteral.label, "Target literal (ar_glt)");
  const targetSimplified = pack.versions.find((v) => v.role === "target-simplified");
  assert.equal(targetSimplified.label, "Target simplified (ar_gst)");
});

test("buildScripturePack never throws when a fetch fails (network error)", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  const rows = [{ Reference: "1:1", ID: "a1" }];
  const pack = await buildScripturePack({
    book: "GEN",
    rows,
    sourceLiteralRef: "unfoldingWord/en_ult@master",
    sourceSimplifiedRef: "unfoldingWord/en_ust@master",
    targetLiteralRef: "ar_gl/ar_glt@master",
    targetSimplifiedRef: "ar_gl/ar_gst@master",
  }, { fetchImpl });
  assert.equal(pack.versions.length, 0);
  assert.equal(pack.targetLiteralFound, false);
  assert.equal(pack.targetSimplifiedFound, false);
});

test("renderBatchPack appends the scripture section with per-verse bullets", () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: "1:1", ID: "a1", SupportReference: "" }];
  const scripture = {
    targetLiteralFound: true,
    targetSimplifiedFound: false,
    versions: [
      { role: "source-literal", label: "Source literal (ULT)", byRef: { "1:1": "In the beginning" } },
      { role: "target-literal", label: "Target literal (ar_glt)", byRef: { "1:1": "في البدء" } },
    ],
  };
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl", scripture,
  });
  assert.match(rendered.markdown, /## Scripture for these verses/);
  assert.match(rendered.markdown, /### 1:1/);
  assert.match(rendered.markdown, /Source literal \(ULT\): In the beginning/);
  assert.match(rendered.markdown, /Target literal \(ar_glt\): في البدء/);
});

test("renderBatchPack notes when no target scripture is available", () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: "1:1", ID: "a1", SupportReference: "" }];
  const scripture = {
    targetLiteralFound: false,
    targetSimplifiedFound: false,
    versions: [
      { role: "source-literal", label: "Source literal (ULT)", byRef: { "1:1": "In the beginning" } },
    ],
  };
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl", scripture,
  });
  assert.match(rendered.markdown, /No target-language literal\/simplified Bible is available/);
});

test("renderBatchPack omits the scripture section when scripture is not provided", () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const batchRows = [{ Reference: "1:1", ID: "a1", SupportReference: "" }];
  const rendered = renderBatchPack({
    batchRows, pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl",
  });
  assert.ok(!/## Scripture for these verses/.test(rendered.markdown));
});

test("buildScripturePack builds maps for every covered verse (no silent global cap)", async () => {
  // A large run (>80 distinct verses across chapters) must not silently drop
  // scripture for later verses — regression for the removed MAX_TOTAL_VERSES cap.
  let usfm = "";
  const rows = [];
  for (let ch = 1; ch <= 3; ch++) {
    usfm += `\\c ${ch}\n`;
    for (let v = 1; v <= 40; v++) {
      usfm += `\\v ${v} \\w word${ch}_${v}|x-occurrence="1"\\w*.\n`;
      rows.push({ Reference: `${ch}:${v}`, ID: `r${ch}_${v}` });
    }
  }
  // 120 distinct verses total.
  const fetchImpl = fakeFetch({ en_ult: usfm, en_ust: usfm });

  const pack = await buildScripturePack({
    book: "GEN",
    rows,
    sourceLiteralRef: "unfoldingWord/en_ult@master",
    sourceSimplifiedRef: "unfoldingWord/en_ust@master",
    targetLiteralRef: null,
    targetSimplifiedRef: null,
  }, { fetchImpl });

  const lit = pack.versions.find((v) => v.role === "source-literal");
  assert.equal(Object.keys(lit.byRef).length, 120);
  // A verse well past the old 80-verse cap is still present.
  assert.equal(lit.byRef["3:40"], "word3_40");
});

test("collectVerseRefs de-duplicates, skips intro rows, and caps a single row's span at 10 verses", () => {
  const refs = collectVerseRefs([
    { Reference: "front:intro" }, { Reference: "1:intro" },
    { Reference: "1:2" }, { Reference: "1:2" }, { Reference: "1:1-30" },
  ]);
  assert.deepEqual(refs.map((r) => `${r.chapter}:${r.verse}`), ["1:2", "1:1", "1:3", "1:4", "1:5", "1:6", "1:7", "1:8", "1:9", "1:10"]);
});

test("extractChapterVerse / stripMarkup handle aligned and unaligned USFM", () => {
  const usfm = "\\id GEN\n\\c 1\n\\p\n\\v 1 \\zaln-s |x-content=\"בְּ\"\\*\\w In|x-occurrence=\"1\"\\w*\\zaln-e\\* \\w the|x-occurrence=\"1\"\\w* beginning.\n\\v 2 Plain \\nd Lord\\nd* text.\n\\c 2\n\\v 1 Second chapter.\n";
  assert.equal(stripMarkup(extractChapterVerse(usfm, 1, 1)), "In the");
  // Bot parity: the marker regex swallows trailing whitespace, so "\nd* text" → "Lordtext." (unaligned text only).
  assert.equal(stripMarkup(extractChapterVerse(usfm, 1, 2)), "Plain Lordtext.");
  assert.equal(stripMarkup(extractChapterVerse(usfm, 2, 1)), "Second chapter.");
  assert.equal(extractChapterVerse(usfm, 3, 1), null);
  assert.equal(extractChapterVerse(usfm, 1, 9), null);
  // "\c 1" must not match "\c 12".
  assert.equal(extractChapterVerse("\\c 12\n\\v 1 twelve\n", 1, 1), null);
});
