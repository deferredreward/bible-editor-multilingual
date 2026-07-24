// Local STUB of the bp-assistant translate pipeline upstream — lets the Bible
// Editor side of the `translate` contract be exercised end-to-end (start →
// poll → apply) WITHOUT the real bot, a GL org, or an ANTHROPIC key.
//
// It mirrors the real contract (bp-bot/translate-pipeline/PLAN.md §1):
//   POST /api/pipeline/start           → { jobId }
//   GET  /api/pipeline/:jobId          → StatusResponse (running → done)
//   GET  /stub/tn/:jobId.tsv           → the produced whole-book TSV (rawUrl target)
//
// It does NOT call an LLM: it fetches the real source tN TSV from Door43 raw
// (per the start body's `sourceRef`), then "translates" the Note column of the
// requested chapter range by prefixing a marker (default "[AR-STUB] ") while
// leaving Reference/ID/Tags/SupportReference/Quote/Occurrence byte-identical —
// exactly the column-preservation the contract guarantees. That makes the
// editor's apply path (applyTranslateTnRow → translation_state='ai_draft')
// observable against real row IDs.
//
// Usage:
//   node scripts/translate-stub-server.mjs [--port 8799] [--marker "[AR-STUB] "] [--delay-ms 1500]
// Then point the API at it:  PIPELINE_API_BASE=http://127.0.0.1:8799  BT_API_TOKEN=stub
//
// Flags:
//   --fixture <path>  serve this TSV as the whole-book output instead of
//                     fetching+marking from Door43 (offline mode).
//   --fail            make every run end in state:failed (error-path testing).

import http from "node:http";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const PORT = Number(opt("--port", "8799"));
const MARKER = opt("--marker", "[AR-STUB] ");
const DELAY_MS = Number(opt("--delay-ms", "1200"));
const FIXTURE = opt("--fixture", null);
const FORCE_FAIL = has("--fail");
const DCS_RAW = "https://git.door43.org";
// The pipeline apply path pins bot-supplied rawUrls to env.DCS_BASE_URL's
// origin (api/src/rawUrlPin.ts — a deliberate anti-SSRF guard, not something
// to weaken). To satisfy it in the smoke suite, dev-smoke.mjs points
// DCS_BASE_URL at THIS server's own origin, so the TSV rawUrls this stub
// hands back are same-origin. That means this server must also transparently
// stand in for the real DCS host for everything else (org manifests, book
// USFM/TN/TQ/TWL) — hence the reverse-proxy fallback below.
const DCS_PROXY_TARGET = opt("--dcs-base", DCS_RAW).replace(/\/$/, "");

// jobId → { book, startChapter, endChapter, options, createdAt, tsv|null, error|null }
const jobs = new Map();

function num(n) {
  return `${n}`;
}

// Which TSV columns carry translatable free text, per resource (0-indexed).
//   tn: Reference ID Tags SupportReference Quote Occurrence Note   → [6]
//   tq: Reference ID Tags Quote Occurrence Question Response       → [5,6]
// Structural columns (Reference/ID/Tags/Quote/Occurrence/SupportReference) are
// left byte-identical, exactly the column-preservation the contract guarantees.
const TRANSLATABLE_COLS = { tn: [6], tq: [5, 6] };

// Slice a 7-col TSV to [startCh,endCh] and prefix each translatable column with
// the marker. Header row is kept as-is. Reference is "C:V" or "front:intro";
// chapter = the part before the first ":".
function markChapterRange(tsv, startCh, endCh, resource) {
  const cols7 = TRANSLATABLE_COLS[resource] ?? TRANSLATABLE_COLS.tn;
  const lines = tsv.split(/\r?\n/);
  if (lines.length === 0) return tsv;
  const out = [lines[0]]; // header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") {
      out.push(line);
      continue;
    }
    const cols = line.split("\t");
    const ref = cols[0] ?? "";
    const chStr = ref.split(":")[0];
    const ch = chStr === "front" ? 0 : parseInt(chStr, 10);
    const inRange = Number.isFinite(ch) && ch >= startCh && ch <= endCh;
    if (inRange && cols.length >= 7) {
      for (const ci of cols7) {
        const val = cols[ci] ?? "";
        // Preserve empty cells; only mark non-empty ones (matches "no empty
        // translations" guarantee — an already-empty source cell stays empty).
        cols[ci] = val ? MARKER + val : val;
      }
      out.push(cols.join("\t"));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function fetchSourceTsv(sourceRef, book, resource) {
  // sourceRef = "org/repo@ref"
  const [orgRepo, ref = "master"] = sourceRef.split("@");
  const [org, repo] = orgRepo.split("/");
  const url = `${DCS_RAW}/${org}/${repo}/raw/branch/${ref}/${resource}_${book}.tsv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`source fetch ${url} → ${r.status}`);
  return await r.text();
}

// tw|ta articleId → repo-relative .md path (matches the bot's conventions).
function articlePath(resource, articleId) {
  let id = articleId;
  if (resource === "tw") {
    if (!id.startsWith("bible/")) id = `bible/${id}`;
    return id.endsWith(".md") ? id : `${id}.md`;
  }
  // ta: a folder → the body file (01.md); the stub does one file per run.
  return id.endsWith(".md") ? id : `${id}/01.md`;
}

// Fetch a source article's markdown by articleId (via sourceRef repo) or by a
// direct git.door43.org articleUrl. Returns { path, md }.
async function fetchArticle(sourceRef, resource, articleId, articleUrl) {
  if (articleUrl) {
    const raw = articleUrl.replace("/src/", "/raw/");
    const r = await fetch(raw);
    if (!r.ok) throw new Error(`article fetch ${raw} → ${r.status}`);
    const after = raw.split(/\/raw\/(?:branch|commit|tag)\/[^/]+\//)[1];
    return { path: after ?? articlePath(resource, articleId ?? "unknown"), md: await r.text() };
  }
  const [orgRepo, ref = "master"] = sourceRef.split("@");
  const [org, repo] = orgRepo.split("/");
  const path = articlePath(resource, articleId);
  const url = `${DCS_RAW}/${org}/${repo}/raw/branch/${ref}/${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`article fetch ${url} → ${r.status}`);
  return { path, md: await r.text() };
}

// Mark an article "translated": prefix the FIRST heading's text with the marker,
// preserving heading structure, rc:// links and everything else byte-identical
// (mirrors the article checks' preservation guarantees).
function markArticle(md) {
  return md.replace(/^(#+[ \t]+)(.+)$/m, (_, h, t) => `${h}${MARKER}${t}`);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // --- health (Playwright webServer readiness probe) ---
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  // --- start ---
  if (req.method === "POST" && url.pathname === "/api/pipeline/start") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      if (body.pipelineType !== "translate") {
        return send(res, 400, { error: "stub_only_handles_translate", got: body.pipelineType });
      }
      const jobId = `stub-${Math.floor(performance.now() * 1000)}-${jobs.size}`;
      const startChapter = body.startChapter ?? 1;
      const endChapter = body.endChapter ?? startChapter;
      const options = body.options ?? {};
      const resource = ["tq", "tw", "ta"].includes(options.resourceType) ? options.resourceType : "tn";
      const isArticle = resource === "tw" || resource === "ta";
      const scopeLabel = isArticle ? (options.articleId ?? options.articleUrl) : `${body.book} ${startChapter}-${endChapter}`;
      console.log(
        `[stub] start ${resource} ${scopeLabel} → ${options.targetOrg}/${options.targetLang}` +
          ` src=${options.sourceRef} ctx=${options.contextRef} delivery=${options.delivery}`,
      );
      const job = {
        book: body.book,
        startChapter,
        endChapter,
        options,
        resource,
        isArticle,
        createdAt: Date.now(),
        tsv: null,
        article: null, // { path, md } for tw/ta
        error: FORCE_FAIL ? "forced_failure (--fail)" : null,
      };
      jobs.set(jobId, job);
      // Produce the output asynchronously (fetch + mark), so the first polls
      // see 'running' like the real bot.
      if (!FORCE_FAIL) {
        (async () => {
          try {
            if (isArticle) {
              const { path, md } = await fetchArticle(
                options.sourceRef ?? `unfoldingWord/en_${resource}@master`,
                resource,
                options.articleId,
                options.articleUrl,
              );
              job.article = { path, md: markArticle(md) };
              console.log(`[stub] ${jobId} ready (article ${path}, ${job.article.md.length} chars)`);
            } else {
              job.tsv = FIXTURE
                ? readFileSync(FIXTURE, "utf8")
                : markChapterRange(
                    await fetchSourceTsv(
                      options.sourceRef ?? `unfoldingWord/en_${resource}@master`,
                      body.book,
                      resource,
                    ),
                    startChapter,
                    endChapter,
                    resource,
                  );
              console.log(`[stub] ${jobId} ready (${job.tsv.split(/\r?\n/).length} lines)`);
            }
          } catch (e) {
            job.error = String(e && e.message ? e.message : e);
            console.log(`[stub] ${jobId} FAILED: ${job.error}`);
          }
        })();
      }
      send(res, 202, { jobId });
    });
    return;
  }

  // --- status ---
  const mStatus = url.pathname.match(/^\/api\/pipeline\/([^/]+)$/);
  if (req.method === "GET" && mStatus) {
    const jobId = decodeURIComponent(mStatus[1]);
    const job = jobs.get(jobId);
    if (!job) return send(res, 404, { error: "unknown_job", jobId });
    const scope = { book: job.book, startChapter: job.startChapter, endChapter: job.endChapter };
    const base = {
      jobId,
      pipelineType: "translate",
      scope,
      updatedAt: new Date(job.createdAt).toISOString(),
      createdAt: new Date(job.createdAt).toISOString(),
    };
    const resource = job.resource ?? "tn";
    if (job.error) {
      return send(res, 200, {
        ...base,
        state: "failed",
        current: { chapter: job.startChapter, skill: `translate-${resource}`, status: "failed", startedAt: base.createdAt, error: job.error },
      });
    }
    // Simulate work: 'running' until DELAY_MS has elapsed AND the output is ready.
    const ready = job.isArticle ? !!job.article : !!job.tsv;
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < DELAY_MS || !ready) {
      return send(res, 200, {
        ...base,
        state: "running",
        current: { chapter: job.startChapter, skill: `translate-${resource}`, status: "translating", startedAt: base.createdAt },
      });
    }
    // done — output[] points at the branch file this stub serves. repo tail is
    // {targetLang}_{resource} so the editor's classify() routes it to the
    // matching kind (tn|tq → row apply; tw|ta → article apply by path).
    const targetOrg = job.options.targetOrg ?? "gl";
    const targetLang = job.options.targetLang ?? "xx";
    const repo = `${targetOrg}/${targetLang}_${resource}`;
    if (job.isArticle) {
      const branch = `AI-translate-${targetLang}-${resource}-${encodeURIComponent(job.options.articleId ?? "art")}`;
      return send(res, 200, {
        ...base,
        state: "done",
        output: [
          {
            type: resource, // real bot uses 'article'; editor classifies by repo tail, not type
            repo,
            branch,
            path: job.article.path, // repo-relative markdown path = the round-trip id
            rawUrl: `http://127.0.0.1:${PORT}/stub/article/${encodeURIComponent(jobId)}.md`,
            prNumber: 0,
            mergedAt: "",
            commitSha: "stubsha",
          },
        ],
      });
    }
    const branch = `AI-translate-${targetLang}-${job.book}-${job.startChapter}`;
    const rawUrl = `http://127.0.0.1:${PORT}/stub/${resource}/${encodeURIComponent(jobId)}.tsv`;
    return send(res, 200, {
      ...base,
      state: "done",
      output: [
        {
          type: resource,
          repo,
          branch,
          path: `${resource}_${job.book}.tsv`,
          rawUrl,
          prNumber: 0,
          mergedAt: "",
          commitSha: "stubsha",
        },
      ],
    });
  }

  // --- serve the produced article markdown (the rawUrl target the editor fetches) ---
  const mArticle = url.pathname.match(/^\/stub\/article\/([^/]+)\.md$/);
  if (req.method === "GET" && mArticle) {
    const jobId = decodeURIComponent(mArticle[1]);
    const job = jobs.get(jobId);
    if (!job || !job.article) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not ready");
    }
    const buf = Buffer.from(job.article.md, "utf8");
    res.writeHead(200, { "Content-Type": "text/markdown", "Content-Length": buf.length });
    return res.end(buf);
  }

  // --- serve the produced TSV (the rawUrl target the editor fetches) ---
  const mTsv = url.pathname.match(/^\/stub\/(?:tn|tq)\/([^/]+)\.tsv$/);
  if (req.method === "GET" && mTsv) {
    const jobId = decodeURIComponent(mTsv[1]);
    const job = jobs.get(jobId);
    if (!job || !job.tsv) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not ready");
    }
    const buf = Buffer.from(job.tsv, "utf8");
    res.writeHead(200, { "Content-Type": "text/tab-separated-values", "Content-Length": buf.length });
    return res.end(buf);
  }

  // --- reverse-proxy anything else to the real DCS host (see DCS_PROXY_TARGET
  // comment above) — org manifests, book raw USFM/TSV, repo listings, etc. All
  // real DCS reads the app makes are GET, so that's all this forwards. ---
  if (req.method === "GET" || req.method === "HEAD") {
    try {
      const target = `${DCS_PROXY_TARGET}${url.pathname}${url.search}`;
      const upstream = await fetch(target, { method: req.method });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const headers = {};
      const ct = upstream.headers.get("content-type");
      if (ct) headers["Content-Type"] = ct;
      res.writeHead(upstream.status, headers);
      return res.end(buf);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end(`proxy error: ${e}`);
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[stub] translate upstream on http://127.0.0.1:${PORT}` +
      ` (marker=${JSON.stringify(MARKER)}, delay=${DELAY_MS}ms${FIXTURE ? `, fixture=${FIXTURE}` : ""}${FORCE_FAIL ? ", FORCE-FAIL" : ""})`,
  );
  console.log(`[stub] point the API at it: PIPELINE_API_BASE=http://127.0.0.1:${PORT}  BT_API_TOKEN=stub`);
});
