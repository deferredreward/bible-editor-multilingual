import assert from "node:assert/strict";
import test from "node:test";
import { PRESETS, writeProjectConfig } from "./projectConfig.ts";

test("preset catalog identifies authoring and translation projects", () => {
  assert.equal(PRESETS["en-unfoldingword"].translationSource, null);
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (id === "en-unfoldingword") continue;
    assert.equal(preset.translationSource?.languageCode, "en", `${id} translates from English`);
  }
});

// Fake D1: `.first()` returns the pre-seeded row (the preserve path reads
// existing overrides_json); `.run()` captures the INSERT bind values.
function fakeDb(existingOverridesJson = null) {
  const state = { bound: null };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...values) {
          state.bound = values;
          return this;
        },
        async first() {
          return sql.includes("SELECT")
            ? { overrides_json: existingOverridesJson }
            : null;
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
  return db;
}

test("writeProjectConfig persists and materializes the selected preset", async () => {
  const db = fakeDb();
  const config = await writeProjectConfig({ DB: db }, "ar-bsoj", null);
  assert.deepEqual(db.state.bound, ["ar-bsoj", null]);
  assert.equal(config.preset, "ar-bsoj");
  assert.equal(config.translationSource?.languageCode, "en");
});

test("writeProjectConfig preserves existing overrides when overrides is undefined", async () => {
  const existing = JSON.stringify({ litLabel: "AVD" });
  const db = fakeDb(existing);
  // A bare preset switch (overrides omitted) must not erase the stored blob.
  const config = await writeProjectConfig({ DB: db }, "ar-bsoj", undefined);
  assert.deepEqual(db.state.bound, ["ar-bsoj", existing]);
  assert.equal(config.litLabel, "AVD");
});

test("writeProjectConfig clears overrides when overrides is null", async () => {
  const db = fakeDb(JSON.stringify({ litLabel: "AVD" }));
  const config = await writeProjectConfig({ DB: db }, "ar-bsoj", null);
  assert.deepEqual(db.state.bound, ["ar-bsoj", null]);
  assert.equal(config.litLabel, "AVD");
});

test("writeProjectConfig replaces overrides when an object is passed", async () => {
  const db = fakeDb(JSON.stringify({ litLabel: "AVD" }));
  const config = await writeProjectConfig({ DB: db }, "ar-bsoj", { litLabel: "NEW" });
  assert.deepEqual(db.state.bound, ["ar-bsoj", JSON.stringify({ litLabel: "NEW" })]);
  assert.equal(config.litLabel, "NEW");
});

test("writeProjectConfig rejects unknown presets", async () => {
  await assert.rejects(
    writeProjectConfig({ DB: {} }, "not-a-preset", null),
    /unknown preset/,
  );
});
