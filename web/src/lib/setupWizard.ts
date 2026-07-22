// Pure (React-free) helpers behind the Setup wizard's owner-confirmed flow.
// Kept in a plain .ts module (no JSX) so the node --strip-types web test runner
// can import and unit-test the load-bearing decisions directly: step gating
// after Apply, the import-error → replacement-step routing, the per-resource
// source-URL verify state machine, and the lane upstream-choice mapping.

import {
  RESOURCE_KEYS,
  type ResourceSource,
  type ResourceSourceMode,
  type ResourceSourceMap,
  type ResourceKey,
} from "./orgDraft.ts";

// The wizard's step order (configure-only flow). Setup NEVER stages/overwrites
// scripture text: a populated-lane source change is rejected by the backend
// (lane_source_change_requires_migration), not quarantined here, and content
// import happens later in the editor / the forthcoming Import surface. A
// deliberate source migration is the separate "Change scripture source" tool.
export const SETUP_STEPS = {
  organization: 0,
  sources: 1,
  lanes: 2,
  review: 3,
  done: 4,
} as const;

export type SetupStepName = keyof typeof SETUP_STEPS;
export type SetupStepIndex = (typeof SETUP_STEPS)[SetupStepName];

export type LaneKey = "lit" | "sim";

// ── Per-resource source-URL verify state machine (Step 2 "Use a different
// source"). A pasted Door43 URL is verified on blur via GET
// /api/orgs/verify-source; the states drive the inline UI. ────────────────────
export type SourceVerifyErrorKind = "invalid" | "not_found" | "unreachable";

export type SourceVerifyState =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "verified"; org: string; repo: string; fullName?: string }
  | { status: "error"; kind: SourceVerifyErrorKind };

// Classify the HTTP status of a failed verify-source call. A transient DCS
// failure (503) — or any unexpected status — is "unreachable" (retry), NOT
// "invalid": we must never tell the admin a real repo doesn't exist because of a
// DCS blip. 400 = garbage/unsupported host; 404 = genuine repo_not_found.
export function verifyErrorKind(httpStatus: number | undefined): SourceVerifyErrorKind {
  if (httpStatus === 400) return "invalid";
  if (httpStatus === 404) return "not_found";
  return "unreachable";
}

// ── Lane upstream choice ↔ resourceSource mode (Step 3). A lane's "Upstream for
// this lane" control (unfoldingWord / a URL / None) is the SAME per-resource
// selection Step 2 drives for the lit/sim role — keep them consistent. ─────────
export type LaneUpstreamChoice = "unfoldingWord" | "url" | "none";

export function laneChoiceFromMode(mode: ResourceSourceMode): LaneUpstreamChoice {
  return mode === "upstream" ? "unfoldingWord" : mode === "override" ? "url" : "none";
}

// The resourceSource entry a Step-2 checkbox produces when toggled. Checked =
// pull from the default upstream (mode 'upstream'); unchecked defaults to blank
// until the admin opts into an override URL.
export function toggleResourceChecked(checked: boolean): ResourceSource {
  return checked ? { mode: "upstream" } : { mode: "blank" };
}

// Selecting "A URL" for a lane's upstream (Step 3) must make the choice read as
// 'url' so the SourceOverrideField renders — an 'override' with NO repo yet does
// exactly that (laneChoiceFromMode('override') === 'url') while staying safe:
// buildTranslationSource skips an override whose repo is empty, so nothing is
// committed until a URL verifies.
export function laneUrlChoiceSelection(): ResourceSource {
  return { mode: "override" };
}

// The selection an override field resets to when its URL is cleared: back to
// upstream when the owning row is checked, otherwise blank. Prevents a cleared
// field from leaving a stale verified override in the draft. This is the ONLY
// path that blanks a resource that was pointed at a URL — a genuine user clear.
export function clearedOverrideSelection(rowChecked: boolean): ResourceSource {
  return rowChecked ? { mode: "upstream" } : { mode: "blank" };
}

// The selection to persist when a pasted URL FAILS to verify (400/404 invalid OR
// 503/unreachable transient). Critically NOT blank — a valid custom source that
// hit a DCS blip must not be silently persisted as omitted. It stays an override
// with NO repo (pending), which `isUnverifiedOverride` flags so Apply is blocked
// until the user re-verifies or explicitly clears.
export function pendingOverrideSelection(): ResourceSource {
  return { mode: "override" };
}

// A resource is an UNVERIFIED override when it's in override mode but carries no
// verified repo yet (the user pointed it at a URL that hasn't resolved). Such a
// selection must block Apply rather than silently serialize to "no source".
export function isUnverifiedOverride(sel: ResourceSource | undefined): boolean {
  if (!sel || sel.mode !== "override") return false;
  return !(sel.repo && sel.repo.trim());
}

// Every resource currently sitting on an unverified override — used to gate
// Apply/Next and to tell the user which resources still need a valid source.
export function unverifiedOverrideResources(map: ResourceSourceMap): ResourceKey[] {
  return RESOURCE_KEYS.filter((k) => isUnverifiedOverride(map[k]));
}

export function hasUnverifiedOverride(map: ResourceSourceMap): boolean {
  return unverifiedOverrideResources(map).length > 0;
}

// ── Post-activation lane-mode confirmation (Step 4b) ─────────────────────────
// After a lane's generation flips on Activate, its edit/align choice must be
// re-applied — and CONFIRMED. A lane is only "done" when its live config matches
// the desired mode: align → text read-only + alignment writable; edit → text
// writable + alignment writable. If the post-activation lanePatch silently
// failed, this returns false and the wizard must NOT let the user Continue.
export function laneModeMatches(
  config: { textReadOnly: boolean; alignmentWritable: boolean } | null | undefined,
  desiredMode: "edit" | "align",
): boolean {
  if (!config) return false;
  const desiredReadOnly = desiredMode === "align";
  return config.textReadOnly === desiredReadOnly && config.alignmentWritable === true;
}

// The languageCode a translationSource should carry for a given upstream org:
// the org's inferred language, falling back to 'en' only when unknown. A
// non-unfoldingWord upstream must NOT keep 'en' or buildTranslationSource emits
// the wrong source language.
export function upstreamLanguageOf(inferredLanguageCode: string | null | undefined): string {
  const c = (inferredLanguageCode ?? "").trim();
  return c || "en";
}

// ── Replacement-job progress (Step 4b) ──────────────────────────────────────
// A book that hit a retryable_error / failed needs admin action (retry/waive);
// the job will otherwise sit in `staging` forever (e.g. a source repo missing a
// book's USFM → sha_unavailable). "Actionable" drives both the "Action required"
// panel and the spinner gate so the wizard never spins forever on a stuck job.
export function jobActionable(books: ReadonlyArray<{ status: string }>): boolean {
  return books.some((b) => b.status === "retryable_error" || b.status === "failed");
}

// The staging spinner shows ONLY while genuinely working: not once ready
// (awaiting Activate) and not once a book needs action.
export function replacementSpinnerVisible(
  jobStatus: string | undefined,
  books: ReadonlyArray<{ status: string }>,
): boolean {
  return jobStatus !== "ready" && !jobActionable(books);
}

export type BookErrorInfo =
  | { kind: "not_found"; location: string }
  | { kind: "other"; detail: string }
  | null;

// Explain WHY a book is stuck instead of showing a bare status. The common case
// — the new source repo has no USFM for the book — surfaces as sha_unavailable;
// map it to "Not found in <owner>/<repo>@<ref>" (location resolved from the
// pending target's source) so the admin doesn't blindly retry an empty repo.
export function describeBookError(
  errorJson: string | null | undefined,
  source: { owner: string; repo: string; ref?: string } | null | undefined,
): BookErrorInfo {
  if (!errorJson) return null;
  let code: unknown = errorJson;
  try {
    const parsed = JSON.parse(errorJson);
    code = parsed?.error ?? parsed?.code ?? parsed?.reason ?? errorJson;
  } catch {
    /* not JSON — treat the raw string as the code */
  }
  const codeStr = typeof code === "string" ? code : JSON.stringify(code);
  if (codeStr.includes("sha_unavailable")) {
    const location = source
      ? `${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}`
      : "";
    return { kind: "not_found", location };
  }
  return { kind: "other", detail: codeStr };
}

// The canonical Door43 web URL for an org/repo — used to LINK a reader-friendly
// `org: repo` chip to the actual repository.
export function door43RepoUrl(org: string, repo: string): string {
  return `https://git.door43.org/${org}/${repo}`;
}
