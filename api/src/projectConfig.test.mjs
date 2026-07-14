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

test("writeProjectConfig persists and materializes the selected preset", async () => {
  let bound = null;
  const env = {
    DB: {
      prepare() {
        return {
          bind(...values) {
            bound = values;
            return this;
          },
          async run() {
            return { success: true };
          },
        };
      },
    },
  };

  const config = await writeProjectConfig(env, "ar-bsoj", null);
  assert.deepEqual(bound, ["ar-bsoj", null]);
  assert.equal(config.preset, "ar-bsoj");
  assert.equal(config.translationSource?.languageCode, "en");
});

test("writeProjectConfig rejects unknown presets", async () => {
  await assert.rejects(
    writeProjectConfig({ DB: {} }, "not-a-preset", null),
    /unknown preset/,
  );
});
