// Editor-delivery output fetch (docs/plan Design 1): pull a finished translate
// result file from the bot's authenticated output endpoint instead of Door43.
// Pure module (fetch/sleep injectable) so the retry/backoff contract can be
// unit-tested under the node strip-types runner — same split rationale as
// translateOptions.ts.
//
//   GET {base}/api/pipeline/{upstreamJobId}/output?file={urlencoded}
//   Authorization: Bearer <BT_API_TOKEN>
//   200 → raw bytes; 404 → not_found; 429 → rate-limited (retry).
//
// The bot rate-limits at 60 RPM; a multi-file tW/tA pull can trip it, so 429s
// are retried (up to MAX_ATTEMPTS total, honoring Retry-After when present).
// Any other failure throws immediately — the import's caller-side retry-once
// path handles transient errors, and staging is idempotent.

const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1000, 2000];
const MAX_RETRY_AFTER_MS = 30_000;

export async function fetchBotOutputWith(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  upstreamJobId: string,
  file: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const url =
    `${base}/api/pipeline/${encodeURIComponent(upstreamJobId)}/output` +
    `?file=${encodeURIComponent(file)}`;
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) return await r.text();
    lastStatus = r.status;
    if (r.status !== 429 || attempt === MAX_ATTEMPTS - 1) break;
    const retryAfter = Number(r.headers.get("Retry-After"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
        : DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)];
    await sleep(waitMs);
  }
  throw new Error(`fetch bot output ${upstreamJobId}/${file} -> ${lastStatus}`);
}
