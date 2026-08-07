// Assemble artifact.html — one self-contained file, no sibling requests.
//
// Artifacts are served under a strict CSP that blocks every external host, so the
// stylesheet, the data and the derivation layer all have to be inlined. This keeps
// the sources separate on disk and does the inlining at build time.
//
//   node docs/mockups/book-package/_build-artifact.mjs

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");

// A literal "</script" inside injected JS would close the wrapping <script> tag.
// Escaping it is invisible to JS string semantics and cannot occur in real code.
const scriptSafe = (js) => js.replace(/<\/script/gi, "<\\/script");

const src = read("_artifact-src.html");
const css = read("_pkg.css");
const data = read("_verse.js");
const lib = read("_vlib.js");

const parts = [
  ["/*__PKG_CSS__*/", css],
  ["/*__VERSE_DATA__*/", scriptSafe(data)],
  ["/*__VLIB__*/", scriptSafe(lib)],
];

let out = src;
for (const [token, payload] of parts) {
  if (!out.includes(token)) throw new Error(`placeholder ${token} not found in _artifact-src.html`);
  out = out.replace(token, () => payload);
}

// Nothing may reference a sibling file — check rather than assume.
const offenders = [];
const linkRe = /<(?:link|img|iframe|source|video|audio)\b[^>]*>/gi;
let m;
while ((m = linkRe.exec(out)) !== null) offenders.push(m[0].slice(0, 90));
const scriptSrc = /<script[^>]*\ssrc=/i.test(out);
if (scriptSrc) offenders.push("<script src=…>");

writeFileSync(join(here, "artifact.html"), out, "utf8");

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log("artifact.html written");
console.log("  css   ", kb(css.length));
console.log("  data  ", kb(data.length));
console.log("  lib   ", kb(lib.length));
console.log("  total ", kb(statSync(join(here, "artifact.html")).size));
console.log("  external references:", offenders.length ? offenders : "none");
console.log("  doctype/html/head/body tags:",
  /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(out) ? "PRESENT — must be removed" : "none");
console.log("  has <title>:", /<title>/i.test(out));
