// Unit tests for the pre-draft snapshot semantics (preDraftSnapshot.ts,
// migration 0049): unapproved AI content must never reach DCS — the export
// substitutes the snapshotted last-published content for non-validated rows,
// and the snapshot lifecycle (fresh on first draft, carried on draft-over-
// draft, fresh again after validate) makes that substitution correct.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/preDraftSnapshot.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  nextPreDraftJson,
  exportGateDecision,
  gateTsvRowForExport,
  gateArticleForExport,
} from "./preDraftSnapshot.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log("[nextPreDraftJson] snapshot lifecycle");
{
  // NULL → ai_draft: fresh snapshot of the current (about-to-be-overwritten)
  // content — this is the published content the export must keep shipping.
  const fresh = nextPreDraftJson(null, null, { note: "published note", tags: "x" });
  assert(fresh === JSON.stringify({ note: "published note", tags: "x" }),
    "prior NULL → fresh snapshot of current content");

  // validated → ai_draft (re-run after approval): the validated content became
  // the published content, so a FRESH snapshot of it is taken.
  const reFresh = nextPreDraftJson("validated", null, { note: "approved note", tags: null });
  assert(reFresh === JSON.stringify({ note: "approved note", tags: null }),
    "prior 'validated' → fresh snapshot (approved content is now published)");

  // draft-over-draft: the existing snapshot (the real last-published content)
  // is carried through unchanged — NOT replaced with the intermediate draft.
  const carried = nextPreDraftJson("ai_draft", '{"note":"published note","tags":"x"}', {
    note: "draft v1",
    tags: "x",
  });
  assert(carried === '{"note":"published note","tags":"x"}',
    "prior 'ai_draft' → existing snapshot carried through unchanged");
  const carriedEdited = nextPreDraftJson("edited", '{"note":"published"}', { note: "edited draft" });
  assert(carriedEdited === '{"note":"published"}',
    "prior 'edited' → existing snapshot carried through unchanged");

  // legacy draft-over-draft: snapshot was never captured (pre-migration) —
  // stays NULL, it must NOT be back-filled from the intermediate draft.
  assert(nextPreDraftJson("ai_draft", null, { note: "draft v1" }) === null,
    "legacy draft-over-draft → snapshot stays NULL (never back-filled from a draft)");

  // article with a never-translated target: null target_md is a meaningful
  // snapshot ("omit the file at export"), distinct from no snapshot.
  assert(nextPreDraftJson(null, null, { target_md: null }) === '{"target_md":null}',
    "article never translated → explicit {target_md: null} snapshot");
}

console.log("[exportGateDecision] per-state routing");
{
  assert(exportGateDecision(null, null).kind === "current", "state NULL → current");
  assert(exportGateDecision("validated", '{"note":"old"}').kind === "current",
    "validated → current (even if a stale snapshot lingers)");
  assert(exportGateDecision("ai_draft", '{"note":"old"}').kind === "snapshot", "ai_draft + snapshot → snapshot");
  assert(exportGateDecision("edited", '{"note":"old"}').kind === "snapshot", "edited + snapshot → snapshot");
  assert(exportGateDecision("ai_draft", null).kind === "legacy", "ai_draft, no snapshot → legacy");
  assert(exportGateDecision("edited", "not json").kind === "legacy", "unparseable snapshot → legacy");
}

console.log("[gateTsvRowForExport] tn/tq substitution");
{
  const tnDraft = {
    id: "ab1c", note: "AI draft note", tags: "ai-tags",
    quote: "q", occurrence: 1,
    translation_state: "ai_draft",
    pre_draft_json: JSON.stringify({ note: "published note", tags: "pub-tags" }),
  };
  const { row: sub, legacy } = gateTsvRowForExport(tnDraft, ["note", "tags"]);
  assert(!legacy, "snapshot present → not legacy");
  assert(sub.note === "published note" && sub.tags === "pub-tags",
    "ai_draft row exports the snapshotted note/tags");
  assert(sub.quote === "q" && sub.occurrence === 1 && sub.id === "ab1c",
    "structural columns pass through untouched");

  const tqEdited = {
    id: "cd2e", question: "AI q", response: "AI r",
    translation_state: "edited",
    pre_draft_json: JSON.stringify({ question: "pub q", response: "pub r" }),
  };
  const tq = gateTsvRowForExport(tqEdited, ["question", "response"]);
  assert(tq.row.question === "pub q" && tq.row.response === "pub r",
    "edited tq row exports the snapshotted question/response");

  const validated = {
    id: "ef3g", note: "approved AI note", tags: null,
    translation_state: "validated",
    pre_draft_json: null,
  };
  const v = gateTsvRowForExport(validated, ["note", "tags"]);
  assert(v.row.note === "approved AI note" && !v.legacy,
    "validated row exports its current (approved) content");

  const untouched = { id: "gh4i", note: "plain", tags: null, translation_state: null, pre_draft_json: null };
  const u = gateTsvRowForExport(untouched, ["note", "tags"]);
  assert(u.row === untouched && !u.legacy, "state-NULL row is returned as-is");

  const legacyRow = { id: "ij5k", note: "AI note", translation_state: "ai_draft", pre_draft_json: null };
  const l = gateTsvRowForExport(legacyRow, ["note"]);
  assert(l.legacy && l.row.note === "AI note",
    "legacy draft (no snapshot) exports current content, flagged for logging");

  // Snapshot missing a field → substituted as null, not left as the draft value.
  const partial = {
    id: "kl6m", note: "AI note", tags: "ai-tags",
    translation_state: "ai_draft",
    pre_draft_json: JSON.stringify({ note: "pub note" }),
  };
  const pr = gateTsvRowForExport(partial, ["note", "tags"]);
  assert(pr.row.note === "pub note" && pr.row.tags === null,
    "field absent from snapshot → null (never leaks the draft value)");
}

console.log("[gateArticleForExport] substitute / omit / legacy");
{
  const sub = gateArticleForExport("ai_draft", '{"target_md":"published md"}', "AI draft md");
  assert(sub.content === "published md" && !sub.legacy, "draft with published snapshot → snapshot md");

  const omit = gateArticleForExport("ai_draft", '{"target_md":null}', "AI draft md");
  assert(omit.content === null && !omit.legacy,
    "draft, never previously translated → file OMITTED");

  const legacy = gateArticleForExport("edited", null, "current md");
  assert(legacy.content === "current md" && legacy.legacy,
    "legacy draft (no snapshot) → current md, flagged for logging");

  const cur = gateArticleForExport("validated", '{"target_md":"old"}', "approved md");
  assert(cur.content === "approved md" && !cur.legacy, "validated → current (approved) md");

  const untouched = gateArticleForExport(null, null, "human md");
  assert(untouched.content === "human md" && !untouched.legacy, "state NULL → current md");
}

console.log("\npreDraftSnapshot: all assertions passed");
