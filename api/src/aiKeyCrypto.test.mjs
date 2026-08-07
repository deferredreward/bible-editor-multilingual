// Unit tests for aiKeyCrypto.ts — the AES-256-GCM wrap/unwrap used to keep a
// per-org AI provider API key out of D1 in plaintext (migration 0065).
// The module takes the secret as a STRING rather than Env precisely so this
// runs in plain node against the same crypto.subtle the Worker uses.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aiKeyCrypto.test.mjs

import assert from "node:assert/strict";
import { wrappingKeyAvailable, encryptApiKey, decryptApiKey } from "./aiKeyCrypto.ts";

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const SECRET = b64(crypto.getRandomValues(new Uint8Array(32)));
const OTHER_SECRET = b64(crypto.getRandomValues(new Uint8Array(32)));
const PLAINTEXT = "sk-ant-api03-notarealkey-0123456789";

await t("round-trips a key", async () => {
  const { ciphertextB64, ivB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  assert.equal(await decryptApiKey(SECRET, ciphertextB64, ivB64), PLAINTEXT);
});

await t("ciphertext is not the plaintext (and hides it)", async () => {
  const { ciphertextB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  assert.notEqual(ciphertextB64, PLAINTEXT);
  assert.ok(!Buffer.from(ciphertextB64, "base64").toString("utf8").includes(PLAINTEXT));
});

await t("two encryptions of the same plaintext differ — fresh IV per call", async () => {
  const a = await encryptApiKey(SECRET, PLAINTEXT);
  const b = await encryptApiKey(SECRET, PLAINTEXT);
  assert.notEqual(a.ivB64, b.ivB64, "IV must never repeat under one key (GCM hard requirement)");
  assert.notEqual(a.ciphertextB64, b.ciphertextB64);
  // Both still decrypt — distinct IVs, same key.
  assert.equal(await decryptApiKey(SECRET, a.ciphertextB64, a.ivB64), PLAINTEXT);
  assert.equal(await decryptApiKey(SECRET, b.ciphertextB64, b.ivB64), PLAINTEXT);
});

await t("IV is 12 bytes", async () => {
  const { ivB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  assert.equal(Buffer.from(ivB64, "base64").length, 12);
});

await t("decrypting with a different wrapping key throws", async () => {
  const { ciphertextB64, ivB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  await assert.rejects(() => decryptApiKey(OTHER_SECRET, ciphertextB64, ivB64));
});

await t("tampered ciphertext throws (GCM tag)", async () => {
  const { ciphertextB64, ivB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  const bytes = Buffer.from(ciphertextB64, "base64");
  bytes[0] ^= 0xff;
  await assert.rejects(() => decryptApiKey(SECRET, bytes.toString("base64"), ivB64));
});

await t("tampered IV throws", async () => {
  const { ciphertextB64, ivB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  const iv = Buffer.from(ivB64, "base64");
  iv[0] ^= 0xff;
  await assert.rejects(() => decryptApiKey(SECRET, ciphertextB64, iv.toString("base64")));
});

await t("malformed stored values throw rather than returning garbage", async () => {
  await assert.rejects(() => decryptApiKey(SECRET, "!!!not base64!!!", b64(new Uint8Array(12))));
  // Right-length-looking IV that isn't 12 bytes.
  const { ciphertextB64 } = await encryptApiKey(SECRET, PLAINTEXT);
  await assert.rejects(() => decryptApiKey(SECRET, ciphertextB64, b64(new Uint8Array(16))));
});

await t("wrappingKeyAvailable: only a base64 32-byte secret qualifies", () => {
  assert.equal(wrappingKeyAvailable(SECRET), true);
  assert.equal(wrappingKeyAvailable(undefined), false, "unset");
  assert.equal(wrappingKeyAvailable(""), false, "empty");
  assert.equal(wrappingKeyAvailable("!!! not base64 !!!"), false, "not base64");
  assert.equal(wrappingKeyAvailable(b64(new Uint8Array(16))), false, "16 bytes is too short");
  assert.equal(wrappingKeyAvailable(b64(new Uint8Array(64))), false, "64 bytes is not AES-256");
});

await t("encrypt with an unusable secret rejects without echoing it", async () => {
  await assert.rejects(
    () => encryptApiKey(b64(new Uint8Array(16)), PLAINTEXT),
    (err) => !err.message.includes(PLAINTEXT),
  );
});

console.log(`aiKeyCrypto: ${passed} assertions passed`);
