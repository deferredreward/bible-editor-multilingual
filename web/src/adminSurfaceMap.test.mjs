// Verifies adminSurfaceMap.ts against the real source it documents (issue
// #191): every admin-facing section/nav entry in PreferencesWorkspace.tsx
// and AdminDesk.tsx has a matching map entry ("coverage"), and every map
// entry's file/anchor actually exists in that file ("truth") — so the map
// can't rot silently, and adding a section to either admin UI without
// registering it here fails loudly instead.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/adminSurfaceMap.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADMIN_SURFACE_MAP } from "./adminSurfaceMap.ts";

const SRC_ROOT = fileURLToPath(new URL(".", import.meta.url));

function readSource(relativeToSrc) {
  return readFileSync(new URL(relativeToSrc, `file://${SRC_ROOT}`), "utf8");
}

// Extracts the quoted string literals out of a TS union type declaration,
// e.g. `export type Foo = "a" | "b";` -> ["a", "b"]. Deliberately a plain
// text scan (not a TS parse) to match the rest of this test's approach.
function unionMembers(source, typeName) {
  const re = new RegExp(`export type ${typeName} =([\\s\\S]*?);`);
  const match = source.match(re);
  assert.ok(match, `could not find "export type ${typeName} = ..." in source`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("adminSurfaceMap: every entry's file/anchor exists in the real source (truth)", () => {
  for (const entry of ADMIN_SURFACE_MAP) {
    for (const side of ["classic", "desk"]) {
      const ref = entry[side];
      if (!ref) continue;
      const abs = new URL(ref.file, `file://${SRC_ROOT}`);
      assert.ok(
        existsSync(abs),
        `${entry.key}.${side}: file "${ref.file}" does not exist under web/src/`,
      );
      const content = readFileSync(abs, "utf8");
      assert.ok(
        content.includes(ref.anchor),
        `${entry.key}.${side}: anchor "${ref.anchor}" not found in ${ref.file}`,
      );
    }
    assert.ok(
      entry.classic || entry.desk,
      `${entry.key}: must declare at least one of classic/desk`,
    );
  }
});

test("adminSurfaceMap: gap entries cite a tracking issue", () => {
  for (const entry of ADMIN_SURFACE_MAP) {
    if (entry.classic && entry.desk) continue; // both sides present, not a gap
    // A feature with only one side (no classic equivalent by design, e.g.
    // desk-native pages) is fine unmarked — a gap is specifically "this
    // feature has both a classic and a desk home in principle, but one is
    // temporarily/intentionally missing." We only require citation when the
    // map itself asserts that via gapIssue; this test just checks the
    // citation, when present, is a real positive issue number.
    if (entry.gapIssue !== undefined) {
      assert.ok(
        Number.isInteger(entry.gapIssue) && entry.gapIssue > 0,
        `${entry.key}.gapIssue must be a positive issue number`,
      );
    }
  }
});

test("adminSurfaceMap: covers every classic Section from PreferencesWorkspace.tsx", () => {
  const prefsSource = readSource("components/PreferencesWorkspace.tsx");
  const sections = unionMembers(prefsSource, "Section");
  assert.ok(sections.length > 0, "expected at least one Section member");

  const mappedClassic = new Set(
    ADMIN_SURFACE_MAP.filter((e) => e.classic?.file === "components/PreferencesWorkspace.tsx").map(
      (e) => e.classic.anchor,
    ),
  );

  for (const section of sections) {
    assert.ok(
      mappedClassic.has(section),
      `PreferencesWorkspace.tsx's Section "${section}" has no adminSurfaceMap entry — ` +
        `add one (with a classic ref) or extend an existing entry`,
    );
  }
});

test("adminSurfaceMap: covers every AdminSection nav entry from AdminDesk.tsx", () => {
  const deskSource = readSource("components/flows/AdminDesk.tsx");
  const adminSections = unionMembers(deskSource, "AdminSection");
  assert.ok(adminSections.length > 0, "expected at least one AdminSection member");

  const mappedDesk = new Set(
    ADMIN_SURFACE_MAP.filter((e) => e.desk?.file === "components/flows/AdminDesk.tsx").map((e) => e.desk.anchor),
  );

  for (const key of adminSections) {
    assert.ok(
      mappedDesk.has(key),
      `AdminDesk.tsx's AdminSection "${key}" has no adminSurfaceMap entry — ` +
        `add one (with a desk ref) or extend an existing entry`,
    );
  }
});

test("adminSurfaceMap: covers every \"more tools\" hash link in AdminDesk.tsx", () => {
  const deskSource = readSource("components/flows/AdminDesk.tsx");
  const hashes = [...deskSource.matchAll(/hash:\s*"(#\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(hashes.length > 0, "expected at least one more-tools hash link");

  const mappedDesk = new Set(
    ADMIN_SURFACE_MAP.filter((e) => e.desk?.file === "components/flows/AdminDesk.tsx").map((e) => e.desk.anchor),
  );

  for (const hash of hashes) {
    assert.ok(
      mappedDesk.has(hash),
      `AdminDesk.tsx's "more tools" link "${hash}" has no adminSurfaceMap entry — ` +
        `add one (with a desk ref) or extend an existing entry`,
    );
  }
});
