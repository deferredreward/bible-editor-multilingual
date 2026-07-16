import assert from "node:assert/strict";
import { normalizeDoor43RepoUrl, repoRefEquals, repoRefKey } from "./repoUrl.ts";

// ── normalizeDoor43RepoUrl ───────────────────────────────────────────────────

// Short owner/repo
{
  const r = normalizeDoor43RepoUrl("BSOJ/ar_avd");
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ref, { owner: "BSOJ", repo: "ar_avd", ref: "master" });
}

// Full URL, no branch
{
  const r = normalizeDoor43RepoUrl("https://git.door43.org/BSOJ/ar_avd");
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ref, { owner: "BSOJ", repo: "ar_avd", ref: "master" });
}

// Full URL with trailing slash
{
  const r = normalizeDoor43RepoUrl("https://git.door43.org/BSOJ/ar_avd/");
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ref, { owner: "BSOJ", repo: "ar_avd", ref: "master" });
}

// URL with branch ref
{
  const r = normalizeDoor43RepoUrl("https://git.door43.org/BSOJ/ar_avd/src/branch/develop/38-ZEC.usfm");
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ref, { owner: "BSOJ", repo: "ar_avd", ref: "develop" });
}

// Raw branch
{
  const r = normalizeDoor43RepoUrl("https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/01-GEN.usfm");
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ref, { owner: "unfoldingWord", repo: "en_ult", ref: "master" });
}

// Custom defaultRef
{
  const r = normalizeDoor43RepoUrl("BSOJ/ar_nav", "develop");
  assert.ok(r.ok);
  assert.equal(r.ref.ref, "develop");
}

// Rejects empty
{
  const r = normalizeDoor43RepoUrl("");
  assert.ok(!r.ok);
  assert.equal(r.error, "empty_url");
}

// Rejects unsupported host
{
  const r = normalizeDoor43RepoUrl("https://github.com/foo/bar");
  assert.ok(!r.ok);
  assert.equal(r.error, "unsupported_host");
}

// Rejects bare owner
{
  const r = normalizeDoor43RepoUrl("BSOJ");
  assert.ok(!r.ok);
}

// ── repoRefEquals ────────────────────────────────────────────────────────────

{
  assert.ok(repoRefEquals(
    { owner: "BSOJ", repo: "ar_avd", ref: "master" },
    { owner: "bsoj", repo: "AR_AVD", ref: "master" },
  ));
  assert.ok(!repoRefEquals(
    { owner: "BSOJ", repo: "ar_avd", ref: "master" },
    { owner: "BSOJ", repo: "ar_avd", ref: "develop" },
  ));
}

// ── repoRefKey ───────────────────────────────────────────────────────────────

{
  assert.equal(
    repoRefKey({ owner: "BSOJ", repo: "ar_avd", ref: "master" }),
    "BSOJ/ar_avd@master",
  );
}

console.log("repoUrl tests passed");
