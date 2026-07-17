import assert from "node:assert/strict";
import test from "node:test";
import { builtinLayoutsFor, CLASSIC_LAYOUT_ID } from "./workflowLayouts.ts";
import { PRESETS } from "./projectConfig.ts";

// Dependency-free structural validity check. api cannot import from web/src, so
// this mirrors the core of web/src/lib/layoutSpec.ts `validateLayoutSpec`
// (v===2, non-empty id/name, boolean builtin, rail.visible boolean, and a
// recursive node tree of splits[>=2 children] / regions[panels of {id,type}]).
// Keep in sync if the client validator's shape rules change.
const PANEL_TYPES = new Set([
  "scripture", "original", "notes", "words", "questions",
  "taArticle", "twArticle", "articleList", "alignment", "search",
]);

function isValidNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.kind === "split") {
    if (node.orientation !== "horizontal" && node.orientation !== "vertical") return false;
    if (!Array.isArray(node.children) || node.children.length < 2) return false;
    return node.children.every(isValidNode);
  }
  if (node.kind === "region") {
    if (typeof node.id !== "string" || node.id.length === 0) return false;
    if (!Array.isArray(node.panels)) return false;
    return node.panels.every(
      (p) =>
        p && typeof p.id === "string" && p.id.length > 0 && PANEL_TYPES.has(p.type),
    );
  }
  return false;
}

function isValidSpec(spec) {
  return (
    !!spec &&
    typeof spec === "object" &&
    spec.v === 2 &&
    typeof spec.id === "string" && spec.id.length > 0 &&
    typeof spec.name === "string" && spec.name.length > 0 &&
    typeof spec.builtin === "boolean" &&
    !!spec.rail && typeof spec.rail.visible === "boolean" &&
    isValidNode(spec.root)
  );
}

// Find the first scripture panel's config anywhere in a layout tree.
function findScriptureConfig(node) {
  if (node.kind === "split") {
    for (const c of node.children) {
      const found = findScriptureConfig(c);
      if (found) return found;
    }
    return null;
  }
  const panel = node.panels.find((p) => p.type === "scripture");
  return panel ? (panel.config ?? {}) : null;
}

// A translation project (translates FROM a source); an authoring project does
// not. glBibles supplies the versions Translate Notes pins.
const authoring = PRESETS["en-unfoldingword"]; // translationSource === null
const translation = {
  ...PRESETS["ar-bsoj"], // translationSource !== null
  glBibles: [
    { repo: "ar_avd", version: "AVD", title: "Van Dyke" },
    { repo: "ar_nav", version: "NAV", title: "Open NAV" },
  ],
};

test("every built-in layout passes a structural shape check", () => {
  for (const cfg of [authoring, translation]) {
    for (const spec of builtinLayoutsFor(cfg)) {
      assert.ok(isValidSpec(spec), `${spec?.id} is structurally valid`);
    }
  }
});

test("translate-* layouts are gated by translationSource", () => {
  const authoringIds = builtinLayoutsFor(authoring).map((l) => l.id);
  assert.deepEqual(authoringIds, [CLASSIC_LAYOUT_ID, "builtin:bp-review"]);
  assert.ok(!authoringIds.includes("builtin:translate-notes"));
  assert.ok(!authoringIds.includes("builtin:translate-words"));

  const translationIds = builtinLayoutsFor(translation).map((l) => l.id);
  assert.deepEqual(translationIds, [
    CLASSIC_LAYOUT_ID,
    "builtin:bp-review",
    "builtin:translate-notes",
    "builtin:translate-words",
  ]);
});

test("every translate-* layout carries requires: translation", () => {
  for (const spec of builtinLayoutsFor(translation)) {
    if (spec.id.startsWith("builtin:translate-")) {
      assert.equal(spec.requires, "translation", `${spec.id} requires translation`);
    }
  }
});

test("translate-notes pins scripture versions from glBibles", () => {
  const notes = builtinLayoutsFor(translation).find((l) => l.id === "builtin:translate-notes");
  const scriptureCfg = findScriptureConfig(notes.root);
  assert.deepEqual(scriptureCfg.versions, ["AVD", "NAV"]);
});

test("translate-notes falls back to default versions when glBibles is empty", () => {
  const noGlBibles = { ...PRESETS["ar-bsoj"], glBibles: [] };
  const notes = builtinLayoutsFor(noGlBibles).find((l) => l.id === "builtin:translate-notes");
  const scriptureCfg = findScriptureConfig(notes.root);
  assert.deepEqual(scriptureCfg.versions, ["ULT", "GLT"]);
});

test("classic scripture pane inherits versions (byte-identical to client fallback)", () => {
  const classic = builtinLayoutsFor(authoring).find((l) => l.id === CLASSIC_LAYOUT_ID);
  const scriptureCfg = findScriptureConfig(classic.root);
  assert.equal(scriptureCfg.versions, "inherit");
  assert.equal(scriptureCfg.mode, "stacked");
});
