// Route + SQL tests for the bulk chapter/book review-state sweep (issue #296).
//
//   POST /api/books/:book/review-state   (admin only)
//
// Harness shape follows workspacePoolRoutes.test.mjs: a real node:sqlite DB
// behind a thin D1 shim, the REAL migration applied on top of the pre-migration
// schema, real Hono + JWT wiring, and the REAL production SQL for the few-shot
// selector (imported from contextExport.ts, not retyped here).
//
// What it pins down:
//   - admin gating (401 unauthenticated, 403 editor)
//   - NULL-state (never-drafted, imported) rows CAN be bulk-validated — the
//     Option 1 decision — and every row so validated carries the
//     `admin_bulk_state` provenance stamp
//   - the few-shot example selectors EXCLUDE stamped rows, and a row whose
//     stamp is retired (what a per-row human approval does) comes back
//   - trashed / deleted rows are never touched
//   - already-human-validated rows are left alone (a sweep can't demote them)
//   - counts per category are exact
//   - needs_review restores the PRE-SWEEP state, not a flat 'edited'
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/reviewState.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf, requireAdmin } from "./auth.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import {
  bulkReviewState,
  parseReviewStateBody,
  ADMIN_BULK_SOURCE,
} from "./reviewState.ts";
import {
  VALIDATED_TN_EXAMPLES_SQL,
  VALIDATED_TQ_EXAMPLES_SQL,
} from "./contextExport.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";
// The real migration under test — the columns the route writes must come from
// it, not from a hand-written CREATE TABLE that could drift.
const MIGRATION_0069 = readFileSync(new URL("../migrations/0069_admin_bulk_state.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // Pre-0069 shape (no admin_bulk_state) — the migration adds it below.
  db.exec(`CREATE TABLE tn_rows (
    id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
    tags TEXT, support_reference TEXT, quote TEXT, occurrence INTEGER,
    note TEXT, version INTEGER NOT NULL DEFAULT 1,
    translation_state TEXT, pre_draft_json TEXT,
    updated_at INTEGER, trashed_at INTEGER, deleted_at INTEGER,
    PRIMARY KEY (book, id)
  )`);
  db.exec(`CREATE TABLE tq_rows (
    id TEXT, book TEXT, chapter INTEGER, verse INTEGER, ref_raw TEXT,
    question TEXT, response TEXT, version INTEGER NOT NULL DEFAULT 1,
    translation_state TEXT, pre_draft_json TEXT,
    updated_at INTEGER, deleted_at INTEGER,
    PRIMARY KEY (book, id)
  )`);
  db.exec(`CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, row_key TEXT NOT NULL, book TEXT,
    user_id INTEGER, prev_version INTEGER, new_version INTEGER,
    action TEXT NOT NULL, payload_json TEXT, source TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, dcs_user_id INTEGER UNIQUE,
    dcs_username TEXT, dcs_access_token TEXT
  )`);
  db.exec(MIGRATION_0069);
  db.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1,1,'ada')`).run();
  db.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (2,2,'bob')`).run();
  return db;
}

// tn fixture: one of every state that matters, plus a trashed row and a
// tombstone, plus a second chapter to prove scoping.
function seed(db) {
  const tn = db.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, tags, support_reference, quote,
                          translation_state, trashed_at, deleted_at, version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  );
  //      id      bk     ch v  ref     note      tags  supp  quote  state       trashed deleted
  tn.run("n1", "ZEC", 1, 1, "1:1", "imported", null, "rc://x", "q1", null, null, null);
  tn.run("n2", "ZEC", 1, 2, "1:2", "edited", null, null, "q2", "edited", null, null);
  tn.run("n3", "ZEC", 1, 3, "1:3", "human ok", null, null, "q3", "validated", null, null);
  tn.run("n4", "ZEC", 1, 4, "1:4", "ai", null, null, "q4", "ai_draft", null, null);
  tn.run("n5", "ZEC", 1, 5, "1:5", "trashed", null, null, "q5", null, 1780000000, null);
  tn.run("n6", "ZEC", 1, 6, "1:6", "gone", null, null, "q6", null, null, 1780000000);
  tn.run("n7", "ZEC", 2, 1, "2:1", "ch2", null, null, "q7", null, null, null);

  const tq = db.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response,
                          translation_state, deleted_at, version)
     VALUES (?,?,?,?,?,?,?,?,?,1)`,
  );
  tq.run("q1", "ZEC", 1, 1, "1:1", "why?", "because", null, null);
  tq.run("q2", "ZEC", 1, 2, "1:2", "who?", "him", "validated", null);
  tq.run("q3", "ZEC", 2, 1, "2:1", "when?", "then", null, null);
}

function makeD1(db) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => bound(sql, params), ...bound(sql, []) };
    },
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function baseEnv(db) {
  const d1 = makeD1(db);
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DB: d1,
    SHARED_DB: d1,
    WORKSPACES: "",
    WORKSPACE_SLUG: "default",
    SUPER_ADMINS: "",
  };
}

async function makeToken({ sub = "1", role = "admin", username = "ada" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

// Mirrors index.ts's middleware order plus the route's own requireAdmin gate
// (registered exactly as bookImport.ts registers it).
function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.post("/api/books/:book/review-state", requireAdmin, bulkReviewState);
  return app;
}

function post(app, env, path, { token, body } = {}) {
  const cookies = ["be_csrf=tok123"];
  const headers = { "x-csrf-token": "tok123", "content-type": "application/json" };
  if (token) cookies.push(`be_access=${token}`);
  headers.cookie = cookies.join("; ");
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) }, env);
}

const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const auditFor = (db, id) =>
  db.prepare(`SELECT * FROM edit_log WHERE row_key = ? ORDER BY id`).all(id);

// ── admin gating ─────────────────────────────────────────────────────────────

console.log("[gating] the bulk sweep is admin-only");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const body = { resources: ["tn"], chapter: 1, state: "validated" };

  const anon = await post(app, env, "/api/books/ZEC/review-state", { body });
  assert(anon.status === 401, "unauthenticated -> 401");

  const editorTok = await makeToken({ sub: "2", username: "bob", role: "editor" });
  const editor = await post(app, env, "/api/books/ZEC/review-state", { token: editorTok, body });
  assert(editor.status === 403, "editor -> 403");
  assert((await editor.json()).reason === "not_an_admin", "403 says not_an_admin");

  assert(row(db, "tn_rows", "n1").translation_state === null, "no write happened on a forbidden call");

  const adminTok = await makeToken();
  const admin = await post(app, env, "/api/books/ZEC/review-state", { token: adminTok, body });
  assert(admin.status === 200, "admin -> 200");
}

// ── bulk validate a chapter, NULL-state rows included ───────────────────────

console.log("[validate] chapter sweep validates NULL-state rows and stamps them");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  const res = await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn", "tq"], chapter: 1, state: "validated" },
  });
  assert(res.status === 200, "sweep -> 200");
  const out = await res.json();

  // The Option 1 decision: a never-drafted imported row IS validated here,
  // where the per-row route refuses (translation_state IS NOT NULL guard).
  assert(row(db, "tn_rows", "n1").translation_state === "validated", "NULL-state row validated");
  assert(row(db, "tn_rows", "n1").admin_bulk_state === "none", "NULL-state row stamped 'none'");
  assert(
    JSON.parse(row(db, "tn_rows", "n1").pre_draft_json).note === "imported",
    "approval snapshots current content into pre_draft_json",
  );

  assert(row(db, "tn_rows", "n2").translation_state === "validated", "human-'edited' row overwritten to validated");
  assert(row(db, "tn_rows", "n2").admin_bulk_state === "edited", "stamp records the pre-sweep state 'edited'");
  assert(row(db, "tn_rows", "n4").admin_bulk_state === "ai_draft", "stamp records the pre-sweep state 'ai_draft'");

  // Human approvals keep their provenance — a sweep can never demote them.
  assert(row(db, "tn_rows", "n3").admin_bulk_state === null, "already-validated row NOT stamped");
  assert(row(db, "tn_rows", "n3").pre_draft_json === null, "already-validated row untouched (no snapshot rewrite)");

  assert(row(db, "tn_rows", "n5").translation_state === null, "trashed row untouched");
  assert(row(db, "tn_rows", "n6").translation_state === null, "tombstone untouched");
  assert(row(db, "tn_rows", "n7").translation_state === null, "other chapter untouched");
  assert(row(db, "tq_rows", "q1").translation_state === "validated", "tq NULL-state row validated");
  assert(row(db, "tq_rows", "q3").translation_state === null, "tq other chapter untouched");

  // counts
  const tn = out.counts.tn;
  assert(tn.total === 5, `tn total counts live rows incl. trashed (got ${tn.total})`);
  assert(tn.validated === 3, `tn validated = 3 (got ${tn.validated})`);
  assert(tn.alreadyValidated === 1, `tn alreadyValidated = 1 (got ${tn.alreadyValidated})`);
  assert(tn.skippedTrashed === 1, `tn skippedTrashed = 1 (got ${tn.skippedTrashed})`);
  assert(tn.changed === 3, "tn changed = 3");
  const tq = out.counts.tq;
  assert(tq.total === 2 && tq.validated === 1 && tq.alreadyValidated === 1, "tq counts exact");
  assert(tq.skippedTrashed === 0, "tq has no trashed concept -> 0");
  assert(out.changed === 4, "top-level changed sums both resources");

  // audit trail: an admin sweep, distinguishable from a translator approving.
  const a1 = auditFor(db, "n1");
  assert(a1.length === 1 && a1[0].action === "validate", "one 'validate' audit row for n1");
  assert(a1[0].source === ADMIN_BULK_SOURCE, `audit source = ${ADMIN_BULK_SOURCE}`);
  assert(a1[0].user_id === 1 && a1[0].book === "ZEC", "audit carries the acting admin + book");
  assert(a1[0].prev_version === a1[0].new_version, "state flip does not bump version");
  assert(auditFor(db, "n3").length === 0, "no audit row for an untouched already-validated row");
  assert(auditFor(db, "n5").length === 0, "no audit row for a trashed row");
  assert(auditFor(db, "q1").length === 1, "tq row audited too");
}

// ── the few-shot selector excludes admin-swept rows ─────────────────────────

console.log("[few-shot] the production example selectors exclude stamped rows");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  const before = db.prepare(VALIDATED_TN_EXAMPLES_SQL).all().map((r) => r.id);
  assert(before.join(",") === "n3", "before the sweep, only the human-validated row is gold");

  await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn", "tq"], chapter: 1, state: "validated" },
  });

  const tnIds = db.prepare(VALIDATED_TN_EXAMPLES_SQL).all().map((r) => r.id);
  assert(tnIds.join(",") === "n3", `admin-swept rows excluded from tn examples (got ${tnIds.join(",") || "none"})`);
  assert(!tnIds.includes("n1"), "the bulk-validated NULL-state row is NOT training gold");
  const tqIds = db.prepare(VALIDATED_TQ_EXAMPLES_SQL).all().map((r) => r.id);
  assert(tqIds.join(",") === "q2", `admin-swept rows excluded from tq examples (got ${tqIds.join(",") || "none"})`);

  // A per-row human approval retires the stamp (rows.ts setTnTranslationState
  // sets admin_bulk_state = NULL) — after which the row is gold like any other.
  db.prepare(`UPDATE tn_rows SET admin_bulk_state = NULL WHERE id = 'n1'`).run();
  const after = db.prepare(VALIDATED_TN_EXAMPLES_SQL).all().map((r) => r.id);
  assert(after.sort().join(",") === "n1,n3", "retiring the stamp restores few-shot eligibility");
}

// ── needs_review restores the pre-sweep state ───────────────────────────────

console.log("[needs_review] the clear restores what each row was before the sweep");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn", "tq"], chapter: 1, state: "validated" },
  });
  const res = await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn", "tq"], chapter: 1, state: "needs_review" },
  });
  assert(res.status === 200, "clear -> 200");
  const out = await res.json();

  assert(row(db, "tn_rows", "n1").translation_state === null, "never-drafted row goes back to NULL, not 'edited'");
  assert(row(db, "tn_rows", "n1").admin_bulk_state === null, "stamp retired on restore");
  assert(row(db, "tn_rows", "n2").translation_state === "edited", "pre-sweep 'edited' restored");
  assert(row(db, "tn_rows", "n4").translation_state === "ai_draft", "pre-sweep 'ai_draft' restored");
  // The human approval this sweep never owned clears the way per-row un-approve
  // does: to 'edited'.
  assert(row(db, "tn_rows", "n3").translation_state === "edited", "human-validated row un-approved to 'edited'");
  assert(row(db, "tn_rows", "n5").translation_state === null, "trashed row still untouched");
  assert(row(db, "tq_rows", "q1").translation_state === null, "tq never-drafted row back to NULL");
  assert(row(db, "tq_rows", "q2").translation_state === "edited", "tq human-validated row -> 'edited'");

  const tn = out.counts.tn;
  assert(tn.restored === 3, `tn restored = 3 (got ${tn.restored})`);
  assert(tn.unvalidated === 1, `tn unvalidated = 1 (got ${tn.unvalidated})`);
  assert(tn.changed === 4, "tn changed = restored + unvalidated");
  assert(tn.alreadyNeedsReview === 0, `tn alreadyNeedsReview = 0 (got ${tn.alreadyNeedsReview})`);
  assert(tn.skippedTrashed === 1, "tn skippedTrashed = 1");

  const un = auditFor(db, "n1").filter((r) => r.action === "unvalidate");
  assert(un.length === 1 && un[0].source === ADMIN_BULK_SOURCE, "un-approve audited as an admin sweep");

  // Everything is back in the review queue (its filter is state <> 'validated').
  const stillApproved = db
    .prepare(`SELECT COUNT(*) AS n FROM tn_rows WHERE book='ZEC' AND chapter=1 AND deleted_at IS NULL AND translation_state='validated'`)
    .get().n;
  assert(stillApproved === 0, "no chapter-1 tn row is left approved");
}

// ── a stamped row a human has since moved on from is not rewound ────────────

console.log("[needs_review] a swept row a human has since edited keeps its state");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn"], chapter: 1, state: "validated" },
  });
  // What a versioned content PATCH does: demote 'validated' -> 'edited'. The
  // stamp is stale from that moment on — the row's state is a human's again.
  db.prepare(`UPDATE tn_rows SET note='human rewrote it', translation_state='edited' WHERE id='n1'`).run();

  const res = await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn"], chapter: 1, state: "needs_review" },
  });
  const out = await res.json();
  const n1 = row(db, "tn_rows", "n1");
  assert(n1.translation_state === "edited", "the human's 'edited' state survives the clear");
  assert(n1.admin_bulk_state === null, "the stale stamp is retired anyway");
  assert(n1.note === "human rewrote it", "content untouched");
  assert(out.counts.tn.restored === 2, `only the still-swept rows are restored (got ${out.counts.tn.restored})`);
  assert(out.counts.tn.alreadyNeedsReview === 1, `the moved-on row counts as already needing review (got ${out.counts.tn.alreadyNeedsReview})`);
}

// ── whole-book sweep (chapter omitted) ──────────────────────────────────────

console.log("[scope] omitting chapter sweeps the whole book");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  const res = await post(app, env, "/api/books/ZEC/review-state", {
    token: tok,
    body: { resources: ["tn"], state: "validated" },
  });
  const out = await res.json();
  assert(out.chapter === null, "response echoes chapter: null for a whole-book sweep");
  assert(row(db, "tn_rows", "n7").translation_state === "validated", "chapter 2 swept too");
  assert(out.counts.tn.total === 6, `whole-book total = 6 live rows (got ${out.counts.tn.total})`);
  assert(out.counts.tn.validated === 4, `whole-book validated = 4 (got ${out.counts.tn.validated})`);
}

// ── request validation ──────────────────────────────────────────────────────

console.log("[validation] bad requests are rejected before any write");
{
  const db = freshDb();
  seed(db);
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken();

  const cases = [
    [{ resources: ["tn"], chapter: 1, state: "approved" }, "invalid_state"],
    [{ resources: [], chapter: 1, state: "validated" }, "invalid_resources"],
    [{ resources: ["twl"], state: "validated" }, "invalid_resources"],
    [{ resources: ["tn"], chapter: -1, state: "validated" }, "invalid_chapter"],
    [{ resources: ["tn"], chapter: 1.5, state: "validated" }, "invalid_chapter"],
  ];
  for (const [body, expected] of cases) {
    const r = await post(app, env, "/api/books/ZEC/review-state", { token: tok, body });
    const j = await r.json();
    assert(r.status === 400 && j.error === expected, `${JSON.stringify(body)} -> 400 ${expected} (got ${r.status} ${j.error})`);
  }
  const unknown = await post(app, env, "/api/books/XYZ/review-state", {
    token: tok,
    body: { resources: ["tn"], state: "validated" },
  });
  assert(unknown.status === 400 && (await unknown.json()).error === "unknown_book", "unknown book -> 400");

  assert(row(db, "tn_rows", "n1").translation_state === null, "no write from any rejected request");
}

// ── body parser unit checks (chapter 0 is real: front-matter rows) ──────────

console.log("[parser] chapter 0 is accepted, resources dedupe");
{
  const ok = parseReviewStateBody({ resources: ["tn", "tn", "tq"], chapter: 0, state: "validated" });
  assert(ok.ok && ok.body.chapter === 0, "chapter 0 accepted (front-matter rows)");
  assert(ok.ok && ok.body.resources.join(",") === "tn,tq", "duplicate resources deduped");
  const noChap = parseReviewStateBody({ resources: ["tn"], state: "needs_review" });
  assert(noChap.ok && noChap.body.chapter === null, "omitted chapter -> null (whole book)");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall reviewState assertions passed");
