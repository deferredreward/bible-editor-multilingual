// Door43 PR web-URL derivation for export snapshot rows (GET /api/exports).
//
// A snapshot row stores `pr_number` + `branch` but NOT the destination
// owner/repo the PR was opened against — that is derived at export time
// (exportWorkflow.exportOne): scripture lanes (ult/ust) publish to the live
// lane config's `export` destination, everything else to the project config's
// per-resource repo under `exportOwnerFor`. The route handler resolves those
// destinations through the same functions the export uses and hands them to
// this pure helper, which only assembles the Gitea web URL
// (`{base}/{owner}/{repo}/pulls/{n}` — the convention exportWorkflow's alert
// links already rely on).
//
// Caveat (deliberate): destinations are resolved from the CURRENT config, so a
// historical row exported before an org/lane retarget can link to the wrong
// repo. Best-effort enrichment — a null prUrl (unknown destination) makes the
// client fall back to plain "PR #n · branch" text.

export interface PrDestination {
  owner: string;
  repo: string;
}

/** Destination per resource; null/undefined = unknown (e.g. lane export disabled). */
export type PrDestinationMap = Partial<Record<string, PrDestination | null>>;

export function snapshotPrUrl(
  baseUrl: string | undefined,
  dest: PrDestination | null | undefined,
  prNumber: number | null,
): string | null {
  if (prNumber == null || !dest || !baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(dest.owner)}/${encodeURIComponent(dest.repo)}/pulls/${prNumber}`;
}
