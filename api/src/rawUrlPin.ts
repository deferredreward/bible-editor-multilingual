// Origin pin for pipeline-output fetches. rawUrl arrives verbatim from the
// upstream bot's poll response; without the pin a compromised or misbehaving
// bot could point the Worker at an arbitrary host and stage that content into
// pending_imports (and from there into the live tables and nightly export).
//
// Kept dependency-free so pipelineImport.test.mjs can load it under the
// strip-types runner (pipelineImport.ts itself pulls in the whole Workers
// import graph).

// Returns null when rawUrl is on the same origin as dcsBaseUrl, else a
// human-readable skip reason. Origin compare includes the scheme, so an
// http:// downgrade of the right host is also rejected.
export function rawUrlOriginError(rawUrl: string, dcsBaseUrl: string): string | null {
  let rawOrigin: string;
  try {
    rawOrigin = new URL(rawUrl).origin;
  } catch {
    return `invalid rawUrl: ${rawUrl}`;
  }
  const dcsOrigin = new URL(dcsBaseUrl).origin;
  if (rawOrigin !== dcsOrigin) {
    return `rawUrl origin ${rawOrigin} rejected (expected ${dcsOrigin})`;
  }
  return null;
}
