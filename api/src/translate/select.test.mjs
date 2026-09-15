// Individual-note / subset selection: selectRows and updateRowsById.
// Ported from bp-assistant test/translate-select.test.js minus the Zulip
// resolveParams grammar cases (editor-shaped equivalents: params.test.mjs;
// refVerseRange: tsvCodec.test.mjs).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/select.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTnTsv, serializeTnTsv, refVerseRange } from "./tsvCodec.ts";
import * as core from "./core.ts";
import { fixture } from "./fixtures.mjs";

const rows = () => parseTnTsv(fixture("tn_OBA.tsv"));

test("selectRows by rowIds keeps only those rows", () => {
  const all = rows();
  const ids = [all[3].ID, all[7].ID];
  const sel = core.selectRows(all, { rowIds: ids });
  assert.deepEqual(sel.map((r) => r.ID).sort(), [...ids].sort());
});

test("selectRows by verse keeps overlapping notes, drops intro", () => {
  const all = core.sliceChapterRows(rows(), 1, 1);
  const sel = core.selectRows(all, { verseStart: 1, verseEnd: 1 });
  assert.ok(sel.length >= 1);
  assert.ok(sel.every((r) => refVerseRange(r.Reference) && refVerseRange(r.Reference).start <= 1 && refVerseRange(r.Reference).end >= 1));
  assert.ok(!sel.some((r) => r.Reference === "front:intro"));
});

test("selectRows with verseStart only treats the end as the start (single verse)", () => {
  const all = core.sliceChapterRows(rows(), 1, 1);
  assert.deepEqual(core.selectRows(all, { verseStart: 5 }), core.selectRows(all, { verseStart: 5, verseEnd: 5 }));
});

test("selectRows with no criteria returns input unchanged", () => {
  const all = rows();
  assert.equal(core.selectRows(all, {}), all);
});

test("updateRowsById updates only targeted rows, preserving all others exactly", () => {
  const book = rows();
  const bookText = serializeTnTsv(book);
  const victim = book[10];
  const updated = [{ ...victim, Note: "ملاحظة محدثة" }];
  const merged = core.updateRowsById(bookText, updated);
  const mergedRows = parseTnTsv(merged);

  assert.equal(mergedRows.length, book.length); // no rows added/removed
  for (let i = 0; i < book.length; i++) {
    if (book[i].ID === victim.ID) {
      assert.equal(mergedRows[i].Note, "ملاحظة محدثة");
      assert.equal(mergedRows[i].Quote, victim.Quote); // pass-through intact
    } else {
      assert.deepEqual(mergedRows[i], book[i]); // byte-identical
    }
  }
});

test("updateRowsById throws when target book absent", () => {
  assert.throws(() => core.updateRowsById(null, [rows()[0]]), /requires an existing target book/);
});

test("updateRowsById throws when a row id is not in the target", () => {
  const bookText = serializeTnTsv(rows());
  assert.throws(
    () => core.updateRowsById(bookText, [{ ...rows()[0], ID: "zz99" }]),
    /not present in target book: zz99/,
  );
});
