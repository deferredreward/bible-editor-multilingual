// templateSync.test.mjs — unit tests for the pure diff/plan logic in
// templateSync.ts (migration 0053). planTemplateSync and parseTemplateRows
// take no D1/crypto dependency, so they're tested directly here without a
// fake database.

import assert from "node:assert/strict";
import test from "node:test";
import { parseTemplateRows, planTemplateSync } from "./templateSync.ts";

function dbRow(overrides = {}) {
  return {
    template_id: "figs-metaphor-01",
    support_ref: "figs-metaphor",
    sheet_order: 0,
    type: "Note",
    source_md: "Original body",
    source_hash: "hash-original",
    translation_state: null,
    draft_meta_json: null,
    deleted_at: null,
    ...overrides,
  };
}

function sheetRow(overrides = {}) {
  return {
    templateId: "figs-metaphor-01",
    supportRef: "figs-metaphor",
    type: "Note",
    body: "Original body",
    sheetOrder: 0,
    sourceHash: "hash-original",
    ...overrides,
  };
}

test("planTemplateSync inserts a row not in the DB", () => {
  const plan = planTemplateSync([sheetRow()], []);
  assert.equal(plan.upserts.length, 1);
  const u = plan.upserts[0];
  assert.equal(u.isNew, true);
  assert.equal(u.hashChanged, true);
  assert.equal(u.clearDeletedAt, false);
  assert.equal(u.demote, false);
  assert.equal(plan.unchanged, 0);
  assert.deepEqual(plan.removeIds, []);
});

test("planTemplateSync treats an unchanged row as a no-op", () => {
  const plan = planTemplateSync([sheetRow()], [dbRow()]);
  assert.equal(plan.upserts.length, 0);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.removeIds, []);
});

test("planTemplateSync bumps version, demotes validated->edited, and records history on a changed body", () => {
  const existing = dbRow({ translation_state: "validated", source_hash: "hash-original" });
  const changed = sheetRow({ body: "New body", sourceHash: "hash-new" });
  const plan = planTemplateSync([changed], [existing]);
  assert.equal(plan.upserts.length, 1);
  const u = plan.upserts[0];
  assert.equal(u.isNew, false);
  assert.equal(u.hashChanged, true);
  assert.equal(u.demote, true);
  assert.equal(u.sourceHash, "hash-new");
  const meta = JSON.parse(u.draftMetaJson);
  assert.equal(meta.stale_source, true);
  assert.equal(meta.prior_source_hash, "hash-original");
});

test("planTemplateSync also demotes ai_draft->edited on a changed body", () => {
  const existing = dbRow({ translation_state: "ai_draft" });
  const changed = sheetRow({ body: "New body", sourceHash: "hash-new" });
  const plan = planTemplateSync([changed], [existing]);
  assert.equal(plan.upserts[0].demote, true);
});

test("planTemplateSync does not demote an 'edited' (human-translated) row on a source change", () => {
  const existing = dbRow({ translation_state: "edited" });
  const changed = sheetRow({ body: "New body", sourceHash: "hash-new" });
  const plan = planTemplateSync([changed], [existing]);
  assert.equal(plan.upserts[0].hashChanged, true);
  assert.equal(plan.upserts[0].demote, false);
});

test("planTemplateSync soft-deletes a row missing from the sheet", () => {
  const existing = dbRow();
  const plan = planTemplateSync([], [existing]);
  assert.equal(plan.upserts.length, 0);
  assert.deepEqual(plan.removeIds, ["figs-metaphor-01"]);
});

test("planTemplateSync does not re-soft-delete an already-deleted row", () => {
  const existing = dbRow({ deleted_at: 1767225600 });
  const plan = planTemplateSync([], [existing]);
  assert.deepEqual(plan.removeIds, []);
});

test("planTemplateSync restores a soft-deleted row that reappears in the sheet", () => {
  const existing = dbRow({ deleted_at: 1767225600 });
  const plan = planTemplateSync([sheetRow()], [existing]);
  assert.equal(plan.upserts.length, 1);
  const u = plan.upserts[0];
  assert.equal(u.clearDeletedAt, true);
  assert.equal(u.hashChanged, false); // body unchanged, only restore
});

test("a metadata-only change upserts without bumping version or demoting", () => {
  const existing = dbRow({ support_ref: "figs-metaphor", translation_state: "validated" });
  const moved = { ...sheetRow(), supportRef: "figs-simile", sourceHash: existing.source_hash };
  const plan = planTemplateSync([moved], [existing]);
  assert.equal(plan.unchanged, 0);
  assert.equal(plan.upserts.length, 1);
  const u = plan.upserts[0];
  assert.equal(u.supportRef, "figs-simile");
  assert.equal(u.hashChanged, false); // no version bump, no history row
  assert.equal(u.demote, false); // an approved translation survives a ref correction
});

test("parseTemplateRows skips an individual row whose id cell is blank", () => {
  const rows = [
    ["ref", "type", "body", "id"], // header
    ["figs-metaphor", "Note", "First body", "figs-metaphor-01"],
    ["figs-metaphor", "Note", "Second body", ""],
  ];
  const { rows: parsed, warnings, aborted } = parseTemplateRows(rows);
  assert.equal(aborted, false);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].templateId, "figs-metaphor-01");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /blank template id/);
});

// The id column is the whole basis of identity. Without it we must write
// nothing at all: positional ids would be silently re-keyed (and every
// interim translation orphaned) the moment the real ids appeared.
test("parseTemplateRows aborts when the sheet has no id header in column D", () => {
  const rows = [
    ["ref", "type", "body"], // no column D at all
    ["figs-metaphor", "Note", "First body"],
    ["figs-irony", "Note", "Second body"],
  ];
  const { rows: parsed, warnings, aborted } = parseTemplateRows(rows);
  assert.equal(aborted, true);
  assert.equal(parsed.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no "id" header/);
});

test("parseTemplateRows aborts when column D exists but is not the id column", () => {
  const rows = [
    ["ref", "type", "body", "notes"],
    ["figs-metaphor", "Note", "First body", "some annotation"],
  ];
  const { aborted, rows: parsed } = parseTemplateRows(rows);
  assert.equal(aborted, true);
  assert.equal(parsed.length, 0);
});

test("parseTemplateRows keeps the first occurrence of a duplicate id and warns", () => {
  const rows = [
    ["ref", "type", "body", "id"],
    ["figs-metaphor", "Note", "First body", "dup-1"],
    ["figs-irony", "Note", "Second body", "dup-1"],
  ];
  const { rows: parsed, warnings } = parseTemplateRows(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].body, "First body");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate template id/);
});

test("parseTemplateRows skips rows with a blank ref or blank body", () => {
  const rows = [
    ["ref", "type", "body", "id"],
    ["", "Note", "Body without ref", "id-1"],
    ["figs-metaphor", "Note", "", "id-2"],
    ["figs-metaphor", "Note", "Real body", "id-3"],
  ];
  const { rows: parsed } = parseTemplateRows(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].templateId, "id-3");
});
