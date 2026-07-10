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

// jobId → { book, startChapter, endChapter, options, createdAt, tsv|null, error|null }
const jobs = new Map();

function num(n) {
  return `${n}`;
}

// Slice a 7-col tN TSV to [startCh,endCh] and prefix the Note column with the
// marker. Header row (Reference\tID\t…\tNote) is kept as-is. Reference is
// "C:V" or "front:intro"; chapter = the part before the first ":".
function markChapterRange(tsv, startCh, endCh) {
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
    // 7 columns: Reference ID Tags SupportReference Quote Occurrence Note
    const ref = cols[0] ?? "";
    const chStr = ref.split(":")[0];
    const ch = chStr === "front" ? 0 : parseInt(chStr, 10);
    const inRange = Number.isFinite(ch) && ch >= startCh && ch <= endCh;
    if (inRange && cols.length >= 7) {
      const note = cols[6] ?? "";
      // Preserve empty notes; only mark non-empty ones (matches "no empty
      // translations" guarantee — an already-empty source note stays empty).
      cols[6] = note ? MARKER + note : note;
      out.push(cols.join("\t"));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function fetchSourceTsv(sourceRef, book) {
  // sourceRef = "org/repo@ref"
  const [orgRepo, ref = "master"] = sourceRef.split("@");
  const [org, repo] = orgRepo.split("/");
  const url = `${DCS_RAW}/${org}/${repo}/raw/branch/${ref}/tn_${book}.tsv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`source fetch ${url} → ${r.status}`);
  return await r.text();
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

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
      console.log(
        `[stub] start ${body.book} ${startChapter}-${endChapter} → ${options.targetOrg}/${options.targetLang}` +
          ` src=${options.sourceRef} ctx=${options.contextRef} delivery=${options.delivery}`,
      );
      const job = {
        book: body.book,
        startChapter,
        endChapter,
        options,
        createdAt: Date.now(),
        tsv: null,
        error: FORCE_FAIL ? "forced_failure (--fail)" : null,
      };
      jobs.set(jobId, job);
      // Produce the output asynchronously (fetch + mark), so the first polls
      // see 'running' like the real bot.
      if (!FORCE_FAIL) {
        (async () => {
          try {
            const tsv = FIXTURE
              ? readFileSync(FIXTURE, "utf8")
              : markChapterRange(
                  await fetchSourceTsv(options.sourceRef ?? `unfoldingWord/en_tn@master`, body.book),
                  startChapter,
                  endChapter,
                );
            job.tsv = tsv;
            console.log(`[stub] ${jobId} ready (${tsv.split(/\r?\n/).length} lines)`);
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
    if (job.error) {
      return send(res, 200, {
        ...base,
        state: "failed",
        current: { chapter: job.startChapter, skill: "translate-tn", status: "failed", startedAt: base.createdAt, error: job.error },
      });
    }
    // Simulate work: 'running' until DELAY_MS has elapsed AND the tsv is ready.
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < DELAY_MS || !job.tsv) {
      return send(res, 200, {
        ...base,
        state: "running",
        current: { chapter: job.startChapter, skill: "translate-tn", status: "translating", startedAt: base.createdAt },
      });
    }
    // done — output[] points at the branch TSV this stub serves. repo tail
    // is {targetLang}_tn so the editor's classify() routes it to the tn kind.
    const targetOrg = job.options.targetOrg ?? "gl";
    const targetLang = job.options.targetLang ?? "xx";
    const repo = `${targetOrg}/${targetLang}_tn`;
    const branch = `AI-translate-${targetLang}-${job.book}-${job.startChapter}`;
    const rawUrl = `http://127.0.0.1:${PORT}/stub/tn/${encodeURIComponent(jobId)}.tsv`;
    return send(res, 200, {
      ...base,
      state: "done",
      output: [
        {
          type: "tn",
          repo,
          branch,
          path: `tn_${job.book}.tsv`,
          rawUrl,
          prNumber: 0,
          mergedAt: "",
          commitSha: "stubsha",
        },
      ],
    });
  }

  // --- serve the produced TSV (the rawUrl target the editor fetches) ---
  const mTsv = url.pathname.match(/^\/stub\/tn\/([^/]+)\.tsv$/);
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
