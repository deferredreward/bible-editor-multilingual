// Serialized master commit for {owner}/translation-context.
// Expected-parent CAS + retry so manual and nightly exports can't publish a
// SHA that does not represent the rendered D1 snapshot they just produced.

import { commitFilesToDcs, type DcsCommitConfig } from "./export.ts";
import { stalePackPaths, type ContextFile } from "./contextExportLib.ts";

export type ContextDcsConfig = {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
};

export type CommitContextResult = {
  commitSha: string;
  parentSha: string;
  changed: boolean;
  committedCount: number;
};

/**
 * Ensure {owner}/translation-context exists, creating it when missing so the
 * translator never has to know a git repo is involved. auto_init is required:
 * commitFilesToDcs needs a master branch to exist before it can commit.
 *
 * Assumption (by design): the export owner is always an ORG (BibleEditorMLTest,
 * BSOJ, DCS_EXPORT_OWNER…) — there is deliberately no POST /user/repos
 * fallback, because the service token's own account is never the export owner.
 */
export async function ensureContextRepoExists(cfg: ContextDcsConfig): Promise<{ created: boolean }> {
  const headers: Record<string, string> = {
    Authorization: `token ${cfg.token}`,
    Accept: "application/json",
  };
  const repoUrl = `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  const probe = await fetch(repoUrl, { headers });
  if (probe.ok) return { created: false };
  if (probe.status !== 404) {
    throw new Error(`context_repo_probe_failed: GET ${probe.status} ${await probe.text()}`);
  }

  const createRes = await fetch(
    `${cfg.baseUrl}/api/v1/orgs/${encodeURIComponent(cfg.owner)}/repos`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: cfg.repo,
        auto_init: true,
        default_branch: "master",
        private: false,
        description: "Translation context pack (managed by bible-editor; brief/instructions/terminology exported from the editor's preferences)",
      }),
    },
  );
  if (createRes.status === 403) {
    throw new Error(`context_repo_create_forbidden: token lacks repo-create permission for org ${cfg.owner}`);
  }
  if (createRes.status === 404) {
    throw new Error(`context_repo_owner_not_org_or_missing: ${cfg.owner}`);
  }
  if (createRes.status === 409 || createRes.status === 422) {
    // Lost a creation race — fine as long as the repo now exists.
    const recheck = await fetch(repoUrl, { headers });
    if (recheck.ok) return { created: false };
    throw new Error(`context_repo_create_conflict_unresolved: ${createRes.status} ${await createRes.text()}`);
  }
  if (!createRes.ok) {
    throw new Error(`context_repo_create_failed: POST ${createRes.status} ${await createRes.text()}`);
  }

  // Wait for the auto_init commit so the immediate pack commit doesn't race
  // Gitea's async repo initialization.
  for (let i = 0; i < 5; i++) {
    const tip = await getBranchTipSha(cfg, "master").catch(() => null);
    if (tip) return { created: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`context_repo_init_timeout: ${cfg.owner}/${cfg.repo} master not visible after create`);
}

async function getBranchTipSha(cfg: ContextDcsConfig, branch: string): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/` +
    `${encodeURIComponent(cfg.repo)}/branches/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`dcs_branch_tip_failed: GET ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { commit?: { id?: string } };
  return body.commit?.id ?? null;
}

async function getCommitParentSha(cfg: ContextDcsConfig, sha: string): Promise<string | null> {
  const url =
    `${cfg.baseUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/` +
    `${encodeURIComponent(cfg.repo)}/git/commits/${encodeURIComponent(sha)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`dcs_commit_parent_failed: GET ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { parents?: Array<{ sha?: string }> };
  return body.parents?.[0]?.sha ?? null;
}

/**
 * Commit pack files to master with expected-parent compare-and-swap.
 * On parent mismatch (concurrent writer), throws `context_cas_conflict` so the
 * caller can re-render from D1 and retry (max attempts live in the workflow).
 */
export async function commitContextPackToMaster(
  cfg: ContextDcsConfig,
  files: ContextFile[],
  message: string,
  expectedParentSha: string | null,
): Promise<CommitContextResult> {
  const tip = await getBranchTipSha(cfg, "master");
  if (expectedParentSha != null && tip != null && tip !== expectedParentSha) {
    throw new Error(`context_cas_conflict:expected=${expectedParentSha}:actual=${tip}`);
  }

  const dcsCfg: DcsCommitConfig = {
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    owner: cfg.owner,
    repo: cfg.repo,
    branch: "master",
  };

  // Pack-managed files omitted from this render have an empty D1 source —
  // delete any stale copy in the same commit (never touches runs/, candidates/
  // or README.md; see PACK_MANAGED_PATHS).
  const result = await commitFilesToDcs(dcsCfg, files, message, {
    deletePaths: stalePackPaths(files),
  });

  if (!result.changed) {
    // Byte-identical to tip — the trustworthy SHA is the current tip.
    const sha = tip ?? (await getBranchTipSha(cfg, "master"));
    if (!sha) throw new Error("context_master_tip_missing_after_noop");
    return {
      commitSha: sha,
      parentSha: tip ?? sha,
      changed: false,
      committedCount: 0,
    };
  }

  const commitSha = result.commitSha;
  if (!commitSha) throw new Error("context_commit_sha_missing");

  // Verify the new commit's parent is the tip we read (CAS).
  const parent = await getCommitParentSha(cfg, commitSha);
  const expected = tip;
  if (expected != null && parent != null && parent !== expected) {
    throw new Error(`context_cas_conflict:expected_parent=${expected}:got_parent=${parent}`);
  }

  // Tip after commit should be our SHA; otherwise someone raced past us.
  const tipAfter = await getBranchTipSha(cfg, "master");
  if (tipAfter && tipAfter !== commitSha) {
    throw new Error(`context_cas_conflict:tip_after=${tipAfter}:ours=${commitSha}`);
  }

  return {
    commitSha,
    parentSha: parent ?? expected ?? "",
    changed: true,
    committedCount: result.committedCount,
  };
}

export { getBranchTipSha };
