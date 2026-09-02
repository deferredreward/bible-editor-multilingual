// #238 — the note-count denominator, pinned on the server side.
//
// OBA reported 153 / 152 / 148 / 147 notes on four surfaces at once. Two of
// those numbers come from this file: the chapter payload (`GET
// /api/chapters/:book/:chapter`) and the book-summary rollup (`GET
// /api/chapters/:book`), and they DELIBERATELY disagree:
//
//   • the payload returns trashed rows, because the trash is visible and
//     restorable — a trashed note grays out at the bottom of its verse with a
//     Restore button, and the review rail has a "Trashed" status filter. Drop
//     them here and the trash UI has nothing to render.
//   • the summary excludes them, because it is a COUNT — the denominator every
//     progress surface reads.
//
// The resolution chosen for #238 is "one denominator, at the counting site":
// clients count with reviewStats/liveRows (web/src/lib/reviewApproval.ts),
// which apply exactly the summary's rule. So this test exists to stop the
// other, tempting "fix" — narrowing the payload query to match the summary —
// which would silently delete the trash UI while making the numbers agree.
//
// Driven through the REAL Hono router against the REAL migrations, so it
// tracks the shipped SQL rather than a re-typed copy of it.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/chapterCountDenominator.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { chapters } from "./chapters.ts";

// Minimal D1 shim over node:sqlite — same shape as rowRestoreNoop.test.mjs.
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return {
        success: true,
        meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
      };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.all());
      return out;
    },
  };
}

const BOOK = "OBA";

// The reported OBA shape, in miniature: 5 live notes in chapter 1 (one of them
// validated), 1 trashed note, 1 deleted note, and 1 book-intro note in the
// phantom chapter 0 that #230 deliberately left in the summary.
function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }

  const insert = (id, chapter, verse, { trashed = null, deleted = null, state = null } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order,
                              version, trashed_at, deleted_at, translation_state)
         VALUES (?, ?, ?, ?, ?, 'n', 10, 1, ?, ?, ?)`,
      )
      .run(id, BOOK, chapter, verse, `${chapter}:${verse}`, trashed, deleted, state);

  insert("live1", 1, 1);
  insert("live2", 1, 1, { state: "ai_draft" });
  insert("live3", 1, 2, { state: "edited" });
  insert("live4", 1, 2, { state: "validated" });
  insert("live5", 1, 3);
  insert("trash1", 1, 1, { trashed: 1785800000, state: "ai_draft" });
  insert("gone1", 1, 1, { deleted: 1785800000 });
  insert("intro1", 0, 0);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/chapters", chapters);

  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const get = (path) => app.request(path, {}, env, ctx);
  return { sqlite, get };
}

test("the chapter payload KEEPS trashed rows — the trash UI is what reads them", async () => {
  const { get } = freshApp();
  const res = await get(`/api/chapters/${BOOK}/1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.tn.map((r) => r.id).sort();

  assert.deepEqual(
    ids,
    ["live1", "live2", "live3", "live4", "live5", "trash1"],
    "trashed rows are served; deleted rows are not",
  );
  assert.equal(
    body.tn.filter((r) => r.trashed_at != null).length,
    1,
    "…and the client can tell which one it is, which is how it excludes it from counts",
  );
});

test("the book summary EXCLUDES trashed rows — it is the denominator", async () => {
  const { get } = freshApp();
  const res = await get(`/api/chapters/${BOOK}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const ch1 = body.chapters.find((c) => c.chapter === 1);

  assert.equal(ch1.tn, 5, "5 live notes — not 6 (trashed) and not 7 (deleted)");
  assert.equal(ch1.tnValidated, 1, "the review rollup uses the same rule");
});

test("payload count minus its trashed rows equals the summary count — THE #238 invariant", async () => {
  // This is the equality every client surface now shows: whatever the payload
  // carries, the number on screen is the live subset, and that number is the
  // one the hub / home / progress rollups already report.
  const { get } = freshApp();
  const payload = await (await get(`/api/chapters/${BOOK}/1`)).json();
  const summary = await (await get(`/api/chapters/${BOOK}`)).json();

  const live = payload.tn.filter((r) => r.trashed_at == null).length;
  assert.equal(live, summary.chapters.find((c) => c.chapter === 1).tn);
});

test("chapter 0 intro notes stay in the summary — #230 decided that on purpose", async () => {
  // The summary has no `chapter > 0` filter and must not grow one: TopBar's
  // "Intro" selector and Shell's book mode open chapter 0 as a real
  // destination, and filtering it here broke both once already (see the header
  // of web/src/lib/bookSummary.ts). Book-level ROLLUPS drop it client-side via
  // realChapters(); that split is #230's recorded decision, not a #238 bug.
  const { get } = freshApp();
  const body = await (await get(`/api/chapters/${BOOK}`)).json();
  const ch0 = body.chapters.find((c) => c.chapter === 0);
  assert.ok(ch0, "chapter 0 is still emitted");
  assert.equal(ch0.tn, 1);
});
