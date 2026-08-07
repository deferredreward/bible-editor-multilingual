// Tests for taSupportReferences.ts. Run from api/:
//   node --experimental-strip-types --no-warnings src/taSupportReferences.test.mjs
//
// Guards the translationAcademy SupportReference picker list against dead ids.
// Upstream shipped `grammar-connect-logic-reason` to translators for selection
// even though no such article exists in unfoldingWord/en_ta — picking it created
// a note linking to a page that 404s (unfoldingWord/bible-editor#392).
//
// Upstream's own guard is a NETWORK check (taSupportReferences.check.mjs) run on
// a nightly workflow, deliberately kept out of CI. This is the offline half: it
// cannot discover a newly-dead article, but it does pin the ids we already know
// are dead so a merge or a copy-paste can't quietly reintroduce one.
// Not a test framework; failures exit non-zero.

import { TA_SUPPORT_REFERENCE_IDS, TA_SUPPORT_REFERENCES } from "./taSupportReferences.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- known-dead ids must never be offered ---
// `grammar-connect-logic-result` ("Connect — Reason-and-Result Relationship") is
// the single real article covering BOTH sides of the relationship, so the
// -reason variant is not a missing article to add, it is a wrong id to refuse.
const KNOWN_DEAD_IDS = ["grammar-connect-logic-reason"];
for (const dead of KNOWN_DEAD_IDS) {
  assert(!TA_SUPPORT_REFERENCE_IDS.includes(dead), `dead id '${dead}' is not in the picker list`);
  assert(
    !TA_SUPPORT_REFERENCES.some((link) => link.endsWith(`/${dead}`)),
    `dead id '${dead}' is not reachable through a built rc:// link`,
  );
}

// --- the real article it was confused with is still present ---
// Removing the wrong id must not take the right one with it.
assert(
  TA_SUPPORT_REFERENCE_IDS.includes("grammar-connect-logic-result"),
  `'grammar-connect-logic-result' (the real article) is still offered`,
);

// --- no duplicates ---
// A duplicate would show the same option twice in the picker.
{
  const seen = new Set();
  const dupes = TA_SUPPORT_REFERENCE_IDS.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert(dupes.length === 0, `no duplicate ids (found: ${dupes.join(", ") || "none"})`);
}

// --- every id is shaped like an en_ta article slug ---
// A stray space, uppercase letter, or full rc:// link pasted in as an "id" would
// build a link that lint.ts's SUPPORT_REFERENCE_RE accepts but DCS cannot resolve.
for (const id of TA_SUPPORT_REFERENCE_IDS) {
  assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), `id '${id}' is a lowercase-kebab article slug`);
}

// --- every id becomes exactly one full rc:// link ---
assert(
  TA_SUPPORT_REFERENCES.length === TA_SUPPORT_REFERENCE_IDS.length,
  `each id maps to exactly one rc:// link`,
);
for (const link of TA_SUPPORT_REFERENCES) {
  assert(
    link.startsWith("rc://*/ta/man/translate/"),
    `'${link}' carries the stored rc:// prefix`,
  );
}

console.log("taSupportReferences: all assertions passed");
