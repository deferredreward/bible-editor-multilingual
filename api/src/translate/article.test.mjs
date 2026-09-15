// Article resources (tW/tA): the markdown structure/link checks and the
// in-memory article artifacts/validation.
// Ported from bp-assistant test/translate-article.test.js — the six
// runArticleChecks cases. The resolver (resolveArticle / parseDoor43Url /
// deriveArticleId), translateArticles and the Zulip resolveParams cases belong
// to articleResolver.ts / the article Workflow steps (design §F step 7) and are
// not ported in step 1.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/article.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { runArticleChecks } from "./checks.ts";
import { buildArticleArtifacts, validateArticleOutput, renderArticlePack } from "./core.ts";
import { fixture } from "./fixtures.mjs";

const GOD = fixture("tw_kt_god.md");
const TA01 = fixture("ta_figs-aside/01.md");
const TATITLE = fixture("ta_figs-aside/title.md");

// A "perfect translation" of a markdown body: keep every link + heading, change prose.
function fakeArticleTr(md) {
  return md
    .replace(/^(#{1,6}\s).*/gm, "$1عنوان") // translate heading text, keep level
    .replace(/\[([^\]]+)\]\(/g, "[نص](") // translate link TEXT, keep target
    .replace(/(^|[^\]])\b(created|refers|Definition|Translation)\b/g, "$1كلمة"); // some prose
}

// ---- Article checks ----------------------------------------------------

test("perfect article translation passes error checks (links + headings preserved)", () => {
  const tgt = fakeArticleTr(GOD);
  const res = runArticleChecks(GOD, tgt, { articleId: "kt/god", path: "bible/kt/god.md" });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors.slice(0, 5), null, 2));
});

test("a dropped rc:// link is a blocking error", () => {
  const tgt = GOD.replace(/rc:\/\/en\/ta\/man\/translate\/translate-names/, "REMOVED");
  const res = runArticleChecks(GOD, tgt);
  assert.ok(res.errors.some((e) => e.check === "rc-links"));
});

test("a changed markdown link target is a blocking error", () => {
  const src = "See [create](../other/creation.md) here.";
  const tgt = "انظر [إنشاء](../other/WRONG.md) هنا.";
  const res = runArticleChecks(src, tgt);
  assert.ok(res.errors.some((e) => e.check === "markdown-links"));
});

test("a changed [[wiki]] link is a blocking error", () => {
  const src = "x [[rc://*/tw/dict/bible/kt/god]] y";
  const tgt = "x [[rc://*/tw/dict/bible/kt/GONE]] y";
  const res = runArticleChecks(src, tgt);
  // rc:// multiset also catches this; assert at least one link error fires
  assert.ok(res.errors.some((e) => e.check === "rc-links" || e.check === "wiki-links"));
});

test("empty target body is a blocking error; heading-count drift is a warning", () => {
  const empty = runArticleChecks(TA01, "   ");
  assert.ok(empty.errors.some((e) => e.check === "empty-translation"));
  const fewerHeadings = runArticleChecks(TA01, TA01.replace(/^### .*/m, "no longer a heading"));
  assert.ok(fewerHeadings.warnings.some((w) => w.check === "heading-parity"));
  assert.ok(fewerHeadings.ok); // warning does not block
});

test("a one-line title file translates without spurious errors", () => {
  const res = runArticleChecks(TATITLE, "الاستطراد");
  assert.deepEqual(res.errors, []);
});

// ---- In-memory artifacts (bot: writeArticleFiles / readArticleOutput) -----

test("buildArticleArtifacts mirrors the bot task JSON under logical names", () => {
  const pack = { templates: new Map(), terms: [], examples: [] };
  const rendered = renderArticlePack({ articleId: "translate/figs-aside", pack, targetLang: "ar", targetLangName: "Arabic", direction: "rtl" });
  assert.equal(rendered.slug, "figs-aside");
  assert.deepEqual(rendered.templateFallbacks, ["figs-aside"]);
  const art = buildArticleArtifacts(0, {
    sourceMarkdown: TA01, packMarkdown: rendered.markdown, articleId: "translate/figs-aside",
    filePath: "translate/figs-aside/01.md", targetLang: "ar", targetLangName: "Arabic", direction: "rtl",
  });
  assert.equal(art.nn, "01");
  assert.deepEqual(art.names, { srcFile: "article-01.md", packFile: "article-01-pack.md", taskFile: "article-01-task.json", outputFile: "article-01-out.md" });
  const task = JSON.parse(art.taskJson);
  assert.deepEqual(Object.keys(task), ["task", "articleId", "filePath", "targetLang", "targetLangName", "sourceLangName", "direction", "sourceFile", "packFile", "outputFile"]);
  assert.equal(task.task, "translate-article");
  assert.equal(task.sourceFile, "article-01.md");
  assert.equal(art.sourceMarkdown, TA01);
});

test("validateArticleOutput runs the article checks and refuses missing output", () => {
  const { markdown, checks } = validateArticleOutput(fakeArticleTr(GOD), GOD, { articleId: "kt/god", path: "bible/kt/god.md" });
  assert.ok(checks.ok, JSON.stringify(checks.errors));
  assert.equal(markdown, fakeArticleTr(GOD));
  assert.throws(() => validateArticleOutput(null, GOD), /no output/);
});
