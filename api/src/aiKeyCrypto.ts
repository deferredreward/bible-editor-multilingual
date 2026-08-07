// AES-256-GCM wrap/unwrap for the per-org AI provider API key (migration 0066).
// The only encryption-at-rest surface in this codebase: everything else in D1
// is plaintext by design, an org's API key can't be.
//
// The wrapping key is the AI_KEY_WRAPPING_KEY Worker secret — base64 of exactly
// 32 random bytes (`openssl rand -base64 32`). Every function takes that SECRET
// STRING rather than Env so this module has no Workers dependency and runs under
// the node strip-types test runner unchanged.
//
// No KDF: the secret is already 256 bits of entropy, so stretching it would add
// cost without adding strength. No AAD: there is exactly one ciphertext per
// workspace DB in a column that means one thing, so there is no context to bind
// against confusion. No rotation scaffolding: rotating AI_KEY_WRAPPING_KEY means
// decrypting every workspace's stored key with the old secret and re-encrypting
// with the new one — a one-off script, deliberately out of scope here.
//
// Callers must never put plaintext, ciphertext, or the secret into an error
// message, log line, or HTTP response; decrypt failures are indistinguishable
// (tamper vs wrong key) on purpose.

const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

// Imported CryptoKeys memoized on the secret string — importKey is pure, and a
// Worker isolate handles many requests with the same secret.
const keyCache = new Map<string, Promise<CryptoKey>>();

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null; // not valid base64
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Is the wrapping-key secret usable? Set, valid base64, and exactly 32 bytes.
// A misconfigured secret must surface as "encryption unavailable" (503) rather
// than as an importKey throw halfway through a write.
export function wrappingKeyAvailable(secret: string | undefined): boolean {
  if (!secret) return false;
  const raw = decodeBase64(secret);
  return raw != null && raw.length === KEY_BYTES;
}

function importWrappingKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const raw = decodeBase64(secret);
  if (!raw || raw.length !== KEY_BYTES) {
    // Never echo the secret (or its length) outward from here.
    return Promise.reject(new Error("ai key wrapping secret is not 32 base64-decoded bytes"));
  }
  const p = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  // Never leave a rejected promise cached — a transient importKey failure would
  // otherwise poison every future call with this secret, even after whatever
  // caused it (e.g. a momentary WebCrypto hiccup) has passed.
  p.catch(() => keyCache.delete(secret));
  keyCache.set(secret, p);
  return p;
}

// Encrypt one API key. The IV is freshly generated per call and returned with
// the ciphertext: reusing an IV under the same key breaks GCM catastrophically
// (it leaks the authentication subkey), so there is no path here that accepts a
// caller-supplied IV.
export async function encryptApiKey(
  secret: string,
  plaintext: string,
): Promise<{ ciphertextB64: string; ivB64: string }> {
  const key = await importWrappingKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertextB64: encodeBase64(new Uint8Array(ct)), ivB64: encodeBase64(iv) };
}

// Decrypt a stored key. Throws on a tampered ciphertext, a mangled IV, or the
// wrong secret — GCM's tag makes those one failure, and the message deliberately
// carries no detail beyond that.
export async function decryptApiKey(secret: string, ciphertextB64: string, ivB64: string): Promise<string> {
  const key = await importWrappingKey(secret);
  const ct = decodeBase64(ciphertextB64);
  const iv = decodeBase64(ivB64);
  if (!ct || !iv || iv.length !== IV_BYTES) throw new Error("stored ai key is malformed");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
