// Unit tests for the editor-delivery output fetch (botOutput.ts): the URL/auth
// contract of the bot's GET /api/pipeline/{jobId}/output endpoint, and the
// 429 retry/backoff (multi-file tW/tA pulls can trip the bot's 60 RPM limit).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/botOutput.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { fetchBotOutputWith } from "./botOutput.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const noSleep = () => Promise.resolve();

function response(status, body = "", headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

console.log("[fetchBotOutputWith] URL + auth contract");
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response(200, "Reference\tID\n1:1\tab1c\n");
  };
  const body = await fetchBotOutputWith(
    fetchImpl, "https://uw-bt-bot.fly.dev", "tok-123",
    "translate-20260716-abc", "tq_OBA.tsv", noSleep,
  );
  assert(body.startsWith("Reference\tID"), "200 → returns the raw body");
  assert(calls.length === 1, "single attempt on success");
  assert(
    calls[0].url === "https://uw-bt-bot.fly.dev/api/pipeline/translate-20260716-abc/output?file=tq_OBA.tsv",
    "URL is {base}/api/pipeline/{jobId}/output?file=…",
  );
  assert(calls[0].init.headers.Authorization === "Bearer tok-123", "Bearer token header sent");
}

console.log("[fetchBotOutputWith] file key is URL-encoded (article paths contain '/')");
{
  let url = "";
  const fetchImpl = async (u) => { url = u; return response(200, "md"); };
  await fetchBotOutputWith(fetchImpl, "https://bot", "t", "job1", "bible/kt/god.md", noSleep);
  assert(url.endsWith("?file=bible%2Fkt%2Fgod.md"), "slashes in the file key are percent-encoded");
}

console.log("[fetchBotOutputWith] 429 retry with backoff");
{
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    return attempts < 3 ? response(429) : response(200, "ok-body");
  };
  const body = await fetchBotOutputWith(fetchImpl, "https://bot", "t", "j", "f.tsv",
    async (ms) => { sleeps.push(ms); });
  assert(body === "ok-body", "recovers after two 429s within the 3-attempt budget");
  assert(attempts === 3, "exactly 3 attempts");
  assert(sleeps.length === 2 && sleeps[0] > 0 && sleeps[1] >= sleeps[0], "backoff waits between retries");
}

console.log("[fetchBotOutputWith] Retry-After honored (and capped)");
{
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    attempts += 1;
    return attempts === 1 ? response(429, "", { "retry-after": "2" }) : response(200, "ok");
  };
  await fetchBotOutputWith(fetchImpl, "https://bot", "t", "j", "f", async (ms) => { sleeps.push(ms); });
  assert(sleeps[0] === 2000, "Retry-After: 2 → 2000ms wait");

  let attempts2 = 0;
  const sleeps2 = [];
  const fetchImpl2 = async () => {
    attempts2 += 1;
    return attempts2 === 1 ? response(429, "", { "retry-after": "999" }) : response(200, "ok");
  };
  await fetchBotOutputWith(fetchImpl2, "https://bot", "t", "j", "f", async (ms) => { sleeps2.push(ms); });
  assert(sleeps2[0] === 30000, "huge Retry-After capped at 30s");
}

console.log("[fetchBotOutputWith] persistent 429 exhausts the budget and throws");
{
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return response(429); };
  let threw = null;
  try {
    await fetchBotOutputWith(fetchImpl, "https://bot", "t", "j", "f.tsv", noSleep);
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof Error && threw.message.includes("429"), "throws with the last status");
  assert(attempts === 3, "stops after 3 attempts");
}

console.log("[fetchBotOutputWith] non-429 failure throws immediately (no retry)");
{
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; return response(404); };
  let threw = null;
  try {
    await fetchBotOutputWith(fetchImpl, "https://bot", "t", "j", "gone.tsv", noSleep);
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof Error && threw.message.includes("404"), "404 throws");
  assert(attempts === 1, "no retry on non-429");
}

console.log("\nbotOutput: all assertions passed");
