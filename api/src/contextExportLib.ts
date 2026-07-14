// Shared predicates + shrink guard for the translation-context pack export.
// Pure (no Hono/D1 imports) so unit tests stay under the strip-types runner.

export type ContextExportStatus =
  | "queued"
  | "success"
  | "failed"
  | "shrink_refused"
  | "no_content"
  | "dry_run";

export type ContextPackStats = {
  terms: number;
  examplesTn: number;
  examplesTq: number;
  contentFiles: number;
  totalBytes: number;
};

export type SuccessfulContextExport = {
  sha: string;
  completedAt: number;
  terms: number;
  examplesTn: number;
  examplesTq: number;
  contentFiles: number;
  totalBytes: number;
  owner: string;
};

export type ContextFile = { path: string; content: string };

/** Content files excluding manifest.yaml (bot empty-pack check). */
export function contentFileCount(files: readonly ContextFile[]): number {
  return files.filter((f) => f.path !== "manifest.yaml").length;
}

export function totalBytes(files: readonly ContextFile[]): number {
  let n = 0;
  for (const f of files) n += new TextEncoder().encode(f.content).byteLength;
  return n;
}

export function hasMinimumContent(files: readonly ContextFile[]): boolean {
  return contentFileCount(files) > 0;
}

export type ShrinkDetail = {
  metric: "terms" | "examples" | "totalBytes" | "contentFiles";
  previous: number;
  next: number;
};

/**
 * Semantic shrink guard vs the prior successful pack.
 * Refuse a substantial reduction unless shrinkOverride is set.
 * Thresholds from the plan: terms >5% AND >5; examples >5% AND >3;
 * bytes >10%; contentFiles strictly fewer.
 */
export function contextShrinkRefused(
  next: ContextPackStats,
  previous: ContextPackStats | null,
): ShrinkDetail | null {
  if (!previous) return null;
  if (previous.terms > 0) {
    const lost = previous.terms - next.terms;
    if (lost > 5 && lost / previous.terms > 0.05) {
      return { metric: "terms", previous: previous.terms, next: next.terms };
    }
  }
  const prevEx = previous.examplesTn + previous.examplesTq;
  const nextEx = next.examplesTn + next.examplesTq;
  if (prevEx > 0) {
    const lost = prevEx - nextEx;
    if (lost > 3 && lost / prevEx > 0.05) {
      return { metric: "examples", previous: prevEx, next: nextEx };
    }
  }
  if (previous.totalBytes > 0) {
    const lost = previous.totalBytes - next.totalBytes;
    if (lost / previous.totalBytes > 0.1) {
      return { metric: "totalBytes", previous: previous.totalBytes, next: next.totalBytes };
    }
  }
  if (previous.contentFiles > 0 && next.contentFiles < previous.contentFiles) {
    return {
      metric: "contentFiles",
      previous: previous.contentFiles,
      next: next.contentFiles,
    };
  }
  return null;
}

export function shrinkDetailCode(d: ShrinkDetail): string {
  return `shrink_guard:${d.metric}_${d.previous}->${d.next}`;
}

/** NFC for any string field that may carry Hebrew/Greek (contract §6.3). */
export function nfc(s: string | null | undefined): string {
  return s == null ? "" : String(s).normalize("NFC");
}
