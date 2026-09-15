// R2 layout for the internal translate runner (docs/translate-internal-runner.md §C).
//
//   pipeline-output/<workspaceSlug>/<jobId>/work/batch-NN{.tsv,-pack.md,-task.json,-out.tsv}
//   pipeline-output/<workspaceSlug>/<jobId>/out/<tn_OBA.tsv | bible/kt/god.md …>
//   pipeline-output/<workspaceSlug>/<jobId>/out/translate-report-<S>-<E>.json
//
// The work/ half mirrors the bot's per-run work directory file-for-file so the
// live dry-run compare (design §E) is a directory diff. The out/ half is what
// pipelineImport.fetchInternalOutput (step 5) reads back by manifest `file`, so
// every path goes through the same traversal guard the bot's article resolver
// applies to caller-derived paths (article-resolver.js assertSafeRepoPath).
//
// Slug-prefixed keys are part of the wrong-tenant defence: a Workflow that
// resolved the wrong workspace would still write under its own params.workspace,
// never under another org's prefix.

export const PIPELINE_OUTPUT_PREFIX = "pipeline-output";

/** The subset of R2Bucket this module (and the Workflow steps) touch; tests pass a Map-backed fake. */
export interface BlobStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

/**
 * Accept only a plain relative POSIX path: no empty path, no absolute or
 * drive-letter path, no empty / `.` / `..` segments, no control characters.
 * Backslashes are normalized to `/` first so a Windows-style traversal can't
 * slip past the segment check. Returns the normalized path.
 */
export function assertSafeRelPath(p: unknown, what = "path"): string {
  const norm = String(p ?? "").replace(/\\/g, "/");
  if (!norm) throw new Error(`unsafe ${what} (empty)`);
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) throw new Error(`unsafe ${what} (absolute): ${p}`);
  // Char-code loop rather than a control-char regex: an escape like \u0000 in
  // a regex literal is one editor round-trip away from becoming a raw NUL in
  // the source, which makes git's binary sniff treat the whole file as binary.
  for (let i = 0; i < norm.length; i++) {
    const code = norm.charCodeAt(i);
    if (code < 32 || code === 127) throw new Error(`unsafe ${what} (control character): ${JSON.stringify(p)}`);
  }
  const segs = norm.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`unsafe ${what} (traversal): ${p}`);
  }
  return norm;
}

/** One key segment (slug or job id): the same rules as a path, plus "no slash at all". */
export function assertSafeSegment(s: unknown, what: string): string {
  const norm = assertSafeRelPath(s, what);
  if (norm.includes("/")) throw new Error(`unsafe ${what} (slash): ${s}`);
  return norm;
}

export function jobPrefix(workspaceSlug: string, jobId: string): string {
  return `${PIPELINE_OUTPUT_PREFIX}/${assertSafeSegment(workspaceSlug, "workspace slug")}/${assertSafeSegment(jobId, "job id")}`;
}

/** Key of one work/ artifact (batch-NN.tsv, batch-NN-pack.md, …). */
export function workKey(workspaceSlug: string, jobId: string, name: string): string {
  return `${jobPrefix(workspaceSlug, jobId)}/work/${assertSafeRelPath(name, "work file")}`;
}

/** Key of one out/ deliverable, addressed by the manifest's `file` (may be nested: bible/kt/god.md). */
export function outKey(workspaceSlug: string, jobId: string, file: string): string {
  return `${jobPrefix(workspaceSlug, jobId)}/out/${assertSafeRelPath(file, "output file")}`;
}

export type BatchFileNames = { batchFile: string; packFile: string; taskFile: string; outputFile: string };

/** Logical names of one batch's artifacts — identical to core.buildBatchArtifacts's `names`. */
export function batchFileNames(nn: string): BatchFileNames {
  return {
    batchFile: `batch-${nn}.tsv`,
    packFile: `batch-${nn}-pack.md`,
    taskFile: `batch-${nn}-task.json`,
    outputFile: `batch-${nn}-out.tsv`,
  };
}

export type BatchKeys = { source: string; pack: string; task: string; output: string };

/** R2 keys of one batch's four work/ artifacts. */
export function batchKeys(workspaceSlug: string, jobId: string, nn: string): BatchKeys {
  const names = batchFileNames(nn);
  return {
    source: workKey(workspaceSlug, jobId, names.batchFile),
    pack: workKey(workspaceSlug, jobId, names.packFile),
    task: workKey(workspaceSlug, jobId, names.taskFile),
    output: workKey(workspaceSlug, jobId, names.outputFile),
  };
}

/** Zero-padded batch number, 1-based, as the bot names files (batch-01 …). */
export function batchNn(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function reportFileName(startChapter: number, endChapter: number): string {
  return `translate-report-${startChapter}-${endChapter}.json`;
}

export function contentTypeFor(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".tsv")) return "text/tab-separated-values";
  if (name.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

/** Read a text blob; null when the key is absent. */
export async function getText(store: BlobStore, key: string): Promise<string | null> {
  const obj = await store.get(key);
  if (!obj) return null;
  return obj.text();
}

/** Write a text blob with a content type derived from the key's extension. */
export async function putText(store: BlobStore, key: string, text: string): Promise<void> {
  await store.put(key, text, { httpMetadata: { contentType: `${contentTypeFor(key)}; charset=utf-8` } });
}

/** In-memory BlobStore for tests and dry runs. */
export function memoryBlobStore(seed: Record<string, string> = {}): BlobStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    async get(key) {
      if (!map.has(key)) return null;
      const text = map.get(key)!;
      return { text: async () => text };
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}
