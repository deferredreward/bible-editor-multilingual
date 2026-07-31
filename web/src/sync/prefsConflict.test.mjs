// Tests for currentPrefsFromConflict (web/src/sync/prefsConflict.ts) — the pure
// extraction behind PreferencesWorkspace's 409 handling. Regression coverage
// for issue #145: a 409 on one section must adopt the server's fresh prefs row
// directly (no refetch) so it can't clobber unsaved edits in a sibling section.

import assert from "node:assert/strict";
import { currentPrefsFromConflict } from "./prefsConflict.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const validPrefs = {
  id: 1,
  audience: "General readers",
  purpose: null,
  register: "default",
  script_notes: null,
  instructions_md: null,
  common_issues_md: null,
  notes: null,
  assisted_mode: 0,
  version: 4,
  updated_at: 1700000000,
  updated_by: 2,
};

check(
  currentPrefsFromConflict({ error: "version_mismatch", current: validPrefs }) === validPrefs,
  "valid conflict body returns the current prefs row",
);

check(
  currentPrefsFromConflict({ error: "chapter_locked", current: validPrefs }) === null,
  "wrong error code -> null",
);

check(
  currentPrefsFromConflict({ error: "version_mismatch" }) === null,
  "missing current -> null",
);

check(
  currentPrefsFromConflict({ error: "version_mismatch", current: "not-an-object" }) === null,
  "non-object current -> null",
);

check(
  currentPrefsFromConflict({ error: "version_mismatch", current: null }) === null,
  "null current -> null",
);

check(
  currentPrefsFromConflict({ error: "version_mismatch", current: { audience: "x" } }) === null,
  "current without numeric version -> null",
);

check(
  currentPrefsFromConflict({ error: "version_mismatch", current: { ...validPrefs, version: "4" } }) === null,
  "current with non-numeric version -> null",
);

check(currentPrefsFromConflict(null) === null, "null body -> null");
check(currentPrefsFromConflict(undefined) === null, "undefined body -> null");
check(currentPrefsFromConflict("nope") === null, "string body -> null");
check(currentPrefsFromConflict(42) === null, "number body -> null");

console.log(`\n${passed} checks passed`);
