// Read-only classifier for bible-editor nightly-export PRs (`{BOOK}-be-*`).
//
// The export renders D1 and proposes it over master. When D1 and master
// disagree on a row, we must know whether master's version is:
//   - AI / bible-editor origin  → D1 lineage; D1 may safely supersede it.
//   - a foreign HUMAN edit       → made on Door43 with legacy tooling; letting
//                                  D1 win would silently revert it.
// This script answers that for one PR (or all open -be- PRs) WITHOUT writing
// anything: it diffs the branch file vs master by row id, then blames each
// dropped/changed master row against the master commits that landed since the
// branch's base, and labels the PR SAFE or HOLD.
//
// Discriminator (see docs / the approved plan):
//   - author email === bot@unfoldingword.org, or message has `X-AI-Pipeline:` → AI
//   - message `bible-editor export:` / `Merge pull request '…bible-editor:`     → D1 origin
//   - anything else                                                            → human (HOLD)
//
// Auth: env DCS_TOKEN (a Door43 token). Base: https://git.door43.org/api/v1.
//
// Usage:
//   node scripts/classify-be-pr.mjs                 # scan all open -be- PRs in the 5 repos
//   node scripts/classify-be-pr.mjs en_tn 7129      # one PR
//
// TSV resources (tn/tq/twl) get row-level blame. USFM resources (ult/ust) have
// no row ids, so they get a coarser commit-level verdict (all master commits to
// the file since the branch base classified; HOLD if any is human).

const BASE = "https://git.door43.org/api/v1";
const TOKEN = process.env.DCS_TOKEN;
if (!TOKEN) {
  console.error("DCS_TOKEN not set — aborting (no credential to read Door43).");
  process.exit(1);
}
const REPOS = ["en_tn", "en_tq", "en_twl", "en_ult", "en_ust"];
const H = { Authorization: `token ${TOKEN}` };

async function api(path, accept) {
  const res = await fetch(`${BASE}${path}`, { headers: accept ? { ...H, Accept: accept } : H });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return accept === "text/plain" ? await res.text() : await res.json();
}

// repo → resource family + the file path for a book.
function fileFor(repo, book) {
  switch (repo) {
    case "en_tn": return { kind: "tsv", path: `tn_${book}.tsv` };
    case "en_tq": return { kind: "tsv", path: `tq_${book}.tsv` };
    case "en_twl": return { kind: "tsv", path: `twl_${book}.tsv` };
    case "en_ult": return { kind: "usfm", path: usfmName(book) };
    case "en_ust": return { kind: "usfm", path: usfmName(book) };
    default: return null;
  }
}
const BOOK_NUM = {
  GEN:"01",EXO:"02",LEV:"03",NUM:"04",DEU:"05",JOS:"06",JDG:"07",RUT:"08","1SA":"09","2SA":"10",
  "1KI":"11","2KI":"12","1CH":"13","2CH":"14",EZR:"15",NEH:"16",EST:"17",JOB:"18",PSA:"19",PRO:"20",
  ECC:"21",SNG:"22",ISA:"23",JER:"24",LAM:"25",EZK:"26",DAN:"27",HOS:"28",JOL:"29",AMO:"30",OBA:"31",
  JON:"32",MIC:"33",NAM:"34",HAB:"35",ZEP:"36",HAG:"37",ZEC:"38",MAL:"39",MAT:"41",MRK:"42",LUK:"43",
  JHN:"44",ACT:"45",ROM:"46","1CO":"47","2CO":"48",GAL:"49",EPH:"50",PHP:"51",COL:"52","1TH":"53",
  "2TH":"54","1TI":"55","2TI":"56",TIT:"57",PHM:"58",HEB:"59",JAS:"60","1PE":"61","2PE":"62",
  "1JN":"63","2JN":"64","3JN":"65",JUD:"66",REV:"67",
};
const usfmName = (b) => `${BOOK_NUM[b] ?? "00"}-${b}.usfm`;

// BOOK from a -be- branch ref like "ISA-be-deferredreward-...".
const bookFromBranch = (ref) => (ref.split("-be")[0] || "").toUpperCase();

function classifyCommit(commit) {
  const email = (commit?.author?.email || commit?.commit?.author?.email || "").toLowerCase();
  const name = (commit?.author?.name || commit?.commit?.author?.name || "");
  const msg = commit?.commit?.message || commit?.message || "";
  if (email === "bot@unfoldingword.org" || /X-AI-Pipeline:/i.test(msg)) return "ai";
  if (/bible-editor export:/i.test(msg) || /bible-editor:/i.test(msg)) return "be";
  return `human:${name || email || "unknown"}`;
}

// Parse a TSV file into id -> full row line (skips header / id-less rows).
function parseTsvById(text) {
  const m = new Map();
  for (const ln of text.split("\n")) {
    const c = ln.split("\t");
    if (c.length < 6 || c[1] === "ID" || !c[1]) continue;
    m.set(c[1], ln);
  }
  return m;
}
// The id (column 2) on a TSV diff line, stripping the leading +/-/space.
function diffLineId(line) {
  const c = line.slice(1).split("\t");
  return c.length >= 2 ? c[1] : null;
}

// Merge base of the branch and master = the parent of the branch's oldest
// commit that isn't on master (export branches are {base}+export commits, so
// that parent is master-at-cut-time). null if the branch has no commits ahead.
async function mergeBaseSha(repo, branch) {
  const cmp = await api(`/repos/unfoldingWord/${repo}/compare/master...${encodeURIComponent(branch)}`);
  const commits = cmp?.commits ?? []; // oldest → newest
  return commits[0]?.parents?.[0]?.sha ?? null;
}

// Per-file commit history on master, newest first. Unlike compare/, this is the
// real authoring history (it flattens merges to the commits that actually wrote
// the file), with each commit's true author — the only reliable blame source.
async function fileHistory(repo, path, limit = 80) {
  return (await api(`/repos/unfoldingWord/${repo}/commits?sha=master&path=${encodeURIComponent(path)}&limit=${limit}`)) ?? [];
}

async function commitDiffTouchesIds(repo, sha, path, want, into) {
  const diff = await api(`/repos/unfoldingWord/${repo}/git/commits/${sha}.diff`, "text/plain").catch(() => null);
  if (!diff) return;
  let inFile = false;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("diff --git")) inFile = ln.includes(`/${path}`);
    if (!inFile) continue;
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      const id = diffLineId(ln);
      if (id && want.has(id) && !into.has(id)) into.set(id, sha);
    }
  }
}

async function classifyPr(repo, pr) {
  const book = bookFromBranch(pr.head?.ref || "");
  const f = fileFor(repo, book);
  const label = `${repo} #${pr.number} ${book} (${pr.head?.ref})`;
  if (!f) return { label, verdict: "SKIP", reason: "unknown repo/file" };

  const baseSha = await mergeBaseSha(repo, pr.head.ref);
  const history = await fileHistory(repo, f.path);
  const clsBySha = new Map(history.map((c) => [c.sha, classifyCommit(c)]));

  if (f.kind === "usfm") {
    // No row ids — classify every master commit to the file since the base.
    const sinceBase = [];
    for (const c of history) { if (c.sha === baseSha) break; sinceBase.push(c); }
    const humans = [...new Set(sinceBase.map(classifyCommit).filter((c) => c.startsWith("human")))];
    return {
      label,
      verdict: humans.length ? "HOLD" : "SAFE",
      reason:
        `usfm: ${sinceBase.length} master commit(s) to ${f.path} since base; ` +
        (humans.length ? `human-authored: ${humans.join(", ")}` : `all AI/bible-editor origin`),
    };
  }

  // TSV: three-way (base / master / branch) by row id. A master row the branch
  // would drop or overwrite is D1's to win ONLY if master == base for that row
  // (master hasn't changed it since the branch diverged). Where master != base,
  // the AUTHOR of master's current content decides: AI/bible-editor → safe;
  // human (legacy tooling) → HOLD.
  const [masterTxt, branchTxt, baseTxt] = await Promise.all([
    api(`/repos/unfoldingWord/${repo}/raw/${f.path}?ref=master`, "text/plain"),
    api(`/repos/unfoldingWord/${repo}/raw/${f.path}?ref=${encodeURIComponent(pr.head.ref)}`, "text/plain"),
    baseSha ? api(`/repos/unfoldingWord/${repo}/raw/${f.path}?ref=${baseSha}`, "text/plain") : Promise.resolve(""),
  ]);
  if (masterTxt == null || branchTxt == null) {
    return { label, verdict: "SKIP", reason: "file missing on master or branch" };
  }
  const M = parseTsvById(masterTxt), B = parseTsvById(branchTxt), Base = parseTsvById(baseTxt ?? "");
  const dropped = [...M.keys()].filter((id) => !B.has(id));            // on master, gone in D1
  const changed = [...M.keys()].filter((id) => B.has(id) && M.get(id) !== B.get(id));
  const added = [...B.keys()].filter((id) => !M.has(id)).length;

  // Only rows where master diverged from base need an author check; the rest are
  // master-unchanged since the cut (D1 owns the divergence → safe).
  const masterChanged = [...dropped, ...changed].filter((id) => M.get(id) !== Base.get(id));
  const want = new Set(masterChanged);

  // Blame: newest history commit whose +line carries the id authored its current
  // master content (M[id] != Base[id] guarantees that commit is after the base).
  const blameSha = new Map();
  for (const c of history) {
    if (want.size === blameSha.size) break;
    await commitDiffTouchesIds(repo, c.sha, f.path, want, blameSha);
  }

  const atRisk = [];
  for (const id of masterChanged) {
    const sha = blameSha.get(id);
    const cls = sha ? clsBySha.get(sha) ?? classifyCommit({ sha }) : "human:unattributed";
    if (cls.startsWith("human")) {
      atRisk.push({ id, ref: (M.get(id) || "").split("\t")[0], cls, kind: dropped.includes(id) ? "DROP" : "CHG" });
    }
  }
  return {
    label,
    verdict: atRisk.length ? "HOLD" : "SAFE",
    reason:
      `tsv: +${added} added, ${dropped.length} dropped, ${changed.length} changed; ` +
      `${masterChanged.length} changed on master since base; ` +
      (atRisk.length
        ? `${atRisk.length} foreign-human master row(s) at risk`
        : `none human-authored — D1 may supersede safely`),
    humanRows: atRisk,
  };
}

async function openBePrs(repo) {
  const pulls = (await api(`/repos/unfoldingWord/${repo}/pulls?state=open&limit=50`)) ?? [];
  return pulls.filter((p) => /-be/.test(p.head?.ref || "") || /^bible-editor:/.test(p.title || ""));
}

async function main() {
  const [argRepo, argPr] = process.argv.slice(2);
  let work = [];
  if (argRepo && argPr) {
    const pr = await api(`/repos/unfoldingWord/${argRepo}/pulls/${argPr}`);
    if (!pr) { console.error(`PR ${argRepo} #${argPr} not found`); process.exit(1); }
    work = [{ repo: argRepo, pr }];
  } else {
    for (const repo of REPOS) for (const pr of await openBePrs(repo)) work.push({ repo, pr });
  }
  if (!work.length) { console.log("No open bible-editor PRs."); return; }

  for (const { repo, pr } of work) {
    try {
      const r = await classifyPr(repo, pr);
      console.log(`\n[${r.verdict}] ${r.label}`);
      console.log(`   ${r.reason}`);
      for (const h of r.humanRows ?? []) {
        console.log(`   ${h.kind} ${h.ref} ${h.id}  ← ${h.cls}`);
      }
    } catch (e) {
      console.log(`\n[ERROR] ${repo} #${pr.number}: ${e.message}`);
    }
  }
}
main();
