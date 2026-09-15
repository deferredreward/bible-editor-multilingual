// prompts/: the checked-in SKILL.md bodies and the API-mode system prompt.
// The bot's buildTranslatePrompt "strips frontmatter and appends the API mode
// override" case (translate-llm.test.js) is covered here for the system half;
// the user-message half lands with llm.ts (step 2). When a bp-assistant-skills
// checkout is present, the constants are compared byte-for-byte against it
// (design risk 5: prompt drift); otherwise that case is skipped, not failed.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/prompts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  API_MODE_OVERRIDE, BEGIN_OUTPUT, END_OUTPUT, SKILL_BODIES, skillBody, systemPromptFor, stripFrontmatter,
} from "./prompts/index.ts";
import { RESOURCE_TYPES } from "./resourceTypes.ts";

const SKILLS_DIR = [process.env.BP_SKILLS_DIR, "C:/GH/bp-bot/bp-assistant-skills"].filter(Boolean).find((d) => existsSync(d));

test("every registry skill has a non-empty body with its iron rules", () => {
  for (const rt of Object.values(RESOURCE_TYPES)) {
    const body = skillBody(rt.skill);
    assert.ok(body.length > 1000, `${rt.skill} body present`);
    assert.ok(!body.startsWith("---"), `${rt.skill} frontmatter stripped`);
    assert.ok(!/^name: translate-/m.test(body), `${rt.skill} frontmatter fields gone`);
    assert.match(body, /## The iron rules \(deterministic checks WILL reject violations\)/);
    assert.equal(body, body.trim(), "body is trimmed");
  }
  assert.match(SKILL_BODIES["translate-tn"], /^# translate-tn — gateway-language translation of tN rows/);
  assert.match(SKILL_BODIES["translate-tq"], /^# translate-tq — /);
  assert.match(SKILL_BODIES["translate-article"], /^# translate-article — /);
  // The tN skill quotes the header with real tabs; JSON round-trip must keep them.
  assert.match(SKILL_BODIES["translate-tn"], /Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote/);
});

test("no prompt constant contains a carriage return (bot reads LF blobs; a CRLF checkout must not leak in)", () => {
  for (const [skill, body] of Object.entries(SKILL_BODIES)) {
    assert.equal((body.match(/\r/g) || []).length, 0, `${skill} body has \\r — regenerate with scripts/sync-translate-prompts.mjs`);
  }
  assert.ok(!API_MODE_OVERRIDE.includes("\r"));
  assert.ok(!systemPromptFor("translate-tq").includes("\r"));
});

test("skillBody rejects unknown / missing skill names", () => {
  assert.throws(() => skillBody(""), /no skill name/);
  assert.throws(() => skillBody("translate-zulip"), /unknown skill "translate-zulip"/);
  assert.throws(() => skillBody("constructor"), /unknown skill/);
});

test("systemPromptFor = body + blank line + API mode override + newline (bot translate-llm.js:156)", () => {
  const system = systemPromptFor("translate-tn");
  assert.equal(system, `${SKILL_BODIES["translate-tn"]}\n\n${API_MODE_OVERRIDE}\n`);
  assert.ok(system.includes("## API mode override (supersedes the Input/Output mechanics above)"));
  assert.ok(system.includes(`\n${BEGIN_OUTPUT}\n(the complete output file content)\n${END_OUTPUT}\n`));
  assert.equal(BEGIN_OUTPUT, "-----BEGIN OUTPUT-----");
  assert.equal(END_OUTPUT, "-----END OUTPUT-----");
  assert.ok(API_MODE_OVERRIDE.endsWith("corrected file between the same markers."));
});

test("stripFrontmatter matches the bot algorithm", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\n\n# Body\n"), "# Body");
  assert.equal(stripFrontmatter("\uFEFF---\r\nname: x\r\n---\r\n# Body"), "# Body");
  assert.equal(stripFrontmatter("# No frontmatter\n"), "# No frontmatter");
  assert.equal(stripFrontmatter("---\nunterminated"), "---\nunterminated");
  assert.equal(stripFrontmatter("---\nname: x\n---"), "");
});

test("checked-in bodies match the skills checkout byte-for-byte after LF normalization (skipped without a checkout)", (t) => {
  if (!SKILLS_DIR) {
    t.skip("no bp-assistant-skills checkout (set BP_SKILLS_DIR)");
    return;
  }
  for (const [skill, body] of Object.entries(SKILL_BODIES)) {
    const src = path.join(SKILLS_DIR, ".claude", "skills", skill, "SKILL.md");
    assert.ok(existsSync(src), src);
    // The skills repo stores LF; a core.autocrlf=true checkout hands back CRLF.
    // Compare the LF form so this test is line-ending independent, like the generator.
    const expected = stripFrontmatter(readFileSync(src, "utf8").replace(/\r\n/g, "\n"));
    assert.equal(body, expected, `${skill} body drifted from ${src} — run node scripts/sync-translate-prompts.mjs`);
    // The generator stamps sha256(body) into the module header; keep it honest.
    const modFile = fileURLToPath(new URL(`./prompts/${{ "translate-tn": "translateTn", "translate-tq": "translateTq", "translate-article": "translateArticle" }[skill]}.ts`, import.meta.url));
    const stamped = /sha256\(body\) = ([0-9a-f]{64})/.exec(readFileSync(modFile, "utf8"))?.[1];
    assert.equal(stamped, createHash("sha256").update(body, "utf8").digest("hex"), `${skill} header sha256 matches body`);
  }
});
