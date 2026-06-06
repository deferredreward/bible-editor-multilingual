// Smoke test for pipelineSession.ts. Run from repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/pipelineSession.test.mjs

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function installLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(String(key), String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
  return data;
}

const data = installLocalStorage();
const { currentPipelineUserId, getSessionKey, setPipelineUser } = await import("./pipelineSession.ts");

setPipelineUser(null);
const anon = getSessionKey();
assert(anon.startsWith("bible-editor/anon/"), `anonymous fallback is explicit`);
assert(data.has("bible-editor.pipeline.sessionKey"), `anonymous key uses legacy global storage slot`);

data.set("bible-editor.pipeline.sessionKey", "bible-editor/anon/legacy");
setPipelineUser(7);
const user7 = getSessionKey();
assert(currentPipelineUserId() === 7, `current pipeline user is bound`);
assert(user7.startsWith("bible-editor/7/"), `signed-in key includes user id`);
assert(user7 !== "bible-editor/anon/legacy", `signed-in user ignores old global key`);
assert(data.get("bible-editor.pipeline.sessionKey.7") === user7, `signed-in key is stored per user`);

const user7Again = getSessionKey();
assert(user7Again === user7, `same user reuses stored key`);

setPipelineUser(8);
const user8 = getSessionKey();
assert(user8.startsWith("bible-editor/8/"), `second user gets their own key`);
assert(user8 !== user7, `different user does not reuse prior key`);
assert(data.get("bible-editor.pipeline.sessionKey.8") === user8, `second user key is stored separately`);

setPipelineUser(Number.NaN);
assert(currentPipelineUserId() === null, `invalid user id resets binding`);

console.log("\nAll pipeline session smoke checks passed.");
