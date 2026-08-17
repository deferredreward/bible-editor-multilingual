// Enforces that adminSurfaceMap.ts stays honest — see adminSurfaceMap.ts for
// why this exists. Reads the actual source text of PreferencesWorkspace.tsx
// and AdminDesk.tsx rather than importing them (they're JSX/MUI React
// components, not runnable in a plain node test), so the map is checked
// against the real, current nav arrays rather than a copy that can drift.
//
// Run from repo root:
//   npm --workspace web run test

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_SURFACE_MAP } from "./adminSurfaceMap.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// this file lives at web/src/adminSurfaceMap.test.mjs -> web/src -> web -> repo root
const REPO_ROOT = path.resolve(__dirname, "../..");

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function extractQuoted(str) {
  return [...str.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function sliceBetween(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${JSON.stringify(startMarker)}`);
  const end = content.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found after start: ${JSON.stringify(endMarker)}`);
  return content.slice(start, end);
}

test("classic PreferencesWorkspace ALL_SECTIONS are all covered by the surface map", () => {
  const prefs = readRepoFile("web/src/components/PreferencesWorkspace.tsx");

  const sectionsSlice = sliceBetween(prefs, "export const SECTIONS: Section[] = [", "];");
  const sectionsIds = extractQuoted(sectionsSlice);
  assert.ok(sectionsIds.length > 0, "expected at least one id in PreferencesWorkspace's SECTIONS");

  const allSectionsSlice = sliceBetween(prefs, "export const ALL_SECTIONS: Section[] = [", "];");
  const extraIds = extractQuoted(allSectionsSlice);
  const allSectionIds = allSectionsSlice.includes("...SECTIONS") ? [...sectionsIds, ...extraIds] : extraIds;
  assert.ok(allSectionIds.length >= sectionsIds.length, "expected ALL_SECTIONS to be at least as large as SECTIONS");

  const mappedClassicIds = new Set(
    ADMIN_SURFACE_MAP.filter((e) => e.classic).map((e) => e.classic.id),
  );

  for (const id of allSectionIds) {
    assert.ok(
      mappedClassicIds.has(id),
      `PreferencesWorkspace section "${id}" has no adminSurfaceMap entry — register it in ` +
        `web/src/adminSurfaceMap.ts (and wire it into the admin desk, or record a gap citing an issue number)`,
    );
  }
});

test("AdminDesk nav entries (both arrays) are all covered by the surface map", () => {
  const deskFile = readRepoFile("web/src/components/flows/AdminDesk.tsx");

  const sectionsSlice = sliceBetween(deskFile, "const SECTIONS: Array<{ key: AdminSection", "\n];");
  const deskKeyIds = [...sectionsSlice.matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(deskKeyIds.length > 0, "expected at least one key in AdminDesk's SECTIONS");

  const moreToolsSlice = sliceBetween(deskFile, '{ hash: "#/ai"', "] as const");
  const moreToolsHashes = [...new Set([...moreToolsSlice.matchAll(/hash:\s*"([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(moreToolsHashes.length >= 4, "expected the four MORE TOOLS hash links");

  const mappedDeskIds = new Set(ADMIN_SURFACE_MAP.filter((e) => e.desk).map((e) => e.desk.id));

  for (const id of [...deskKeyIds, ...moreToolsHashes]) {
    assert.ok(
      mappedDeskIds.has(id),
      `AdminDesk nav entry "${id}" has no adminSurfaceMap entry — register it in ` +
        `web/src/adminSurfaceMap.ts (and wire it to a classic section, or record a gap citing an issue number)`,
    );
  }
});

test("every map pointer's file exists and actually contains its claimed id", () => {
  for (const entry of ADMIN_SURFACE_MAP) {
    for (const side of /** @type {const} */ (["classic", "desk"])) {
      const pointer = entry[side];
      if (!pointer) continue;
      const fullPath = path.join(REPO_ROOT, pointer.file);
      assert.ok(fs.existsSync(fullPath), `${entry.feature}.${side}.file does not exist: ${pointer.file}`);
      const content = fs.readFileSync(fullPath, "utf8");
      assert.ok(
        content.includes(`"${pointer.id}"`),
        `${entry.feature}.${side}.id "${pointer.id}" was not found (as a quoted literal) in ` +
          `${pointer.file} — the map has rotted`,
      );
    }
  }
});

test("every gap entry cites a real issue number and a valid side", () => {
  for (const entry of ADMIN_SURFACE_MAP) {
    if (!entry.gap) continue;
    assert.ok(
      Number.isInteger(entry.gap.issue) && entry.gap.issue > 0,
      `${entry.feature}'s gap record must cite a real issue number`,
    );
    assert.ok(
      entry.gap.side === "classic" || entry.gap.side === "desk",
      `${entry.feature}'s gap.side must be "classic" or "desk"`,
    );
  }
});

test("known current gaps (AI service, Localization, full Terminology editing) are declared", () => {
  const byFeature = Object.fromEntries(ADMIN_SURFACE_MAP.map((e) => [e.feature, e]));
  assert.equal(byFeature.aiService?.gap?.issue, 188, "aiService gap should cite #188");
  assert.equal(byFeature.localization?.gap?.issue, 189, "localization gap should cite #189");
  assert.equal(byFeature.terminology?.gap?.issue, 190, "terminology gap should cite #190");
});
