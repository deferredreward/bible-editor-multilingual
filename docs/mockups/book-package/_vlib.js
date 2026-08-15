/* Verse-level exegete screens — shared derivation and rendering.
 *
 * Anchoring model: every resource points at ORIGINAL-LANGUAGE WORDS. Notes and
 * word links carry UHB word indices; units carry the literal and simplified
 * alignment groups that render those same words. So a selection in any one text
 * resolves to a selection in all of them, and "does the simplified text actually
 * render this?" becomes a lookup rather than a judgement call.
 *
 * Nothing here invents content. Article prose is the real en_ta / en_tw text,
 * morphology is decoded by the product's own web/src/lib/morph.ts, and any
 * coherence observation is computed from the alignment.
 */
(function () {
  "use strict";

  var V = window.VERSE;
  if (!V) throw new Error("_verse.js must load before _vlib.js");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------- markdown

  // Enough markdown for real tA / tW article bodies: headings, blockquotes,
  // bullets, bold/italic, links, and rc:// cross-references.
  function md(text) {
    var src = String(text || "").replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var inList = false;
    var inQuote = false;

    function closeList() { if (inList) { out.push("</ul>"); inList = false; } }
    function closeQuote() { if (inQuote) { out.push("</blockquote>"); inQuote = false; } }

    function inline(s) {
      s = esc(s);
      s = s.replace(/\[\[rc:\/\/[^\]]*?\/([^\/\]]+)\]\]/g, '<span class="mono">$1</span>');
      s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
      s = s.replace(/_([^_\n]+)_/g, "<i>$1</i>");
      return s;
    }

    src.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (!line.trim()) { closeList(); closeQuote(); return; }

      var h = /^(#{1,6})\s*(.+)$/.exec(line);
      if (h) {
        closeList(); closeQuote();
        var lvl = Math.min(6, h[1].length + 2);
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        return;
      }
      var q = /^>\s?(.*)$/.exec(line);
      if (q) {
        closeList();
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push("<p>" + inline(q[1]) + "</p>");
        return;
      }
      var li = /^\s*[*\-]\s+(.+)$/.exec(line);
      if (li) {
        closeQuote();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + inline(li[1]) + "</li>");
        return;
      }
      var oli = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (oli) {
        closeQuote();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + inline(oli[1]) + "</li>");
        return;
      }
      closeList(); closeQuote();
      out.push("<p>" + inline(line) + "</p>");
    });
    closeList(); closeQuote();
    return out.join("");
  }

  // tN notes are one field, not a document: bold, bracketed alternates, rc refs.
  function note(text) {
    var s = esc(String(text || "").replace(/\\n/g, "\n"));
    s = s.replace(/\[\[rc:\/\/[^\]]*?\/([^\/\]]+)\]\]/g, '<span class="mono">$1</span>');
    s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/^#+\s*(.+)$/gm, "<b>$1</b>");
    // "Alternate translation: [x]" — the bracket is the payload, so set it apart.
    s = s.replace(/(Alternate translation:)\s*\[([^\]]*)\]/g,
      '$1 <span class="alt">$2</span>');
    s = s.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
    return s;
  }

  // ------------------------------------------------------------- verse index

  var refs = Object.keys(V.verses).sort(function (a, b) {
    return parseInt(a.split(":")[1], 10) - parseInt(b.split(":")[1], 10);
  });

  // Resolve each resource to the literal/simplified alignment groups that render
  // its words, so selecting a note highlights the right text in both.
  function decorate(ref) {
    var v = V.verses[ref];
    if (v._done) return v;

    var unitOfWord = {};
    v.units.forEach(function (u) {
      u.words.forEach(function (i) { unitOfWord[i] = u.n; });
    });

    function groupsFor(words) {
      var ult = {}, ust = {}, units = {};
      words.forEach(function (i) {
        var u = v.units[unitOfWord[i]];
        if (!u) return;
        units[u.n] = true;
        u.ult.forEach(function (g) { ult[g] = true; });
        u.ust.forEach(function (g) { ust[g] = true; });
      });
      return {
        ult: Object.keys(ult).map(Number),
        ust: Object.keys(ust).map(Number),
        units: Object.keys(units).map(Number),
      };
    }

    v.tn.forEach(function (r, i) { r.k = "tn" + i; r.spans = groupsFor(r.words); });
    v.twl.forEach(function (r, i) { r.k = "twl" + i; r.spans = groupsFor(r.words); });
    v.tq.forEach(function (r, i) { r.k = "tq" + i; });
    v.unitOfWord = unitOfWord;
    v.groupsFor = groupsFor;
    v._done = true;
    return v;
  }

  // ------------------------------------------------------------- coherence
  //
  // Observations, not verdicts. Each one is a fact computed from the alignment
  // that an exegete would otherwise have to reconstruct by eye.
  function coherence(ref) {
    var v = decorate(ref);
    var out = [];

    // An unrendered particle, preposition or object marker is normal and not worth
    // interrupting anyone for; an unrendered noun or verb is. Split them using the
    // real morphology so the loud flag stays rare enough to mean something.
    var CONTENT = /^(noun|verb|adjective|adverb|pronoun)/;
    function isFunctionOnly(u) {
      return u.words.every(function (i) {
        var w = v.words[i];
        if (!w.gloss || !w.gloss.length) return false;
        return !w.gloss.some(function (g) { return CONTENT.test(g); });
      });
    }

    var noUst = v.units.filter(function (u) { return !u.ustText; });
    var noUlt = v.units.filter(function (u) { return !u.ultText; });
    var ustContent = noUst.filter(function (u) { return !isFunctionOnly(u); });
    var ustFunction = noUst.filter(isFunctionOnly);
    var ultContent = noUlt.filter(function (u) { return !isFunctionOnly(u); });
    var ultFunction = noUlt.filter(isFunctionOnly);

    out.push({
      id: "ust-holes",
      level: ustContent.length ? "attention" : "ok",
      label: "Simplified text renders every original word",
      detail: ustContent.length
        ? ustContent.length + " content word" + (ustContent.length === 1 ? "" : "s") +
          " not rendered: " + ustContent.map(function (u) { return hebOf(v, u); }).join(" · ")
        : noUst.length
        ? "every content word rendered; " + noUst.length + " function word" +
          (noUst.length === 1 ? "" : "s") + " not (normal)"
        : "all " + v.units.length + " units rendered",
      units: ustContent.map(function (u) { return u.n; }),
      contentWords: true,
    });

    if (ustFunction.length) {
      out.push({
        id: "ust-function",
        level: "note",
        label: "Function words the simplified text drops",
        detail: ustFunction.map(function (u) { return hebOf(v, u); }).join(" · "),
        units: ustFunction.map(function (u) { return u.n; }),
      });
    }

    if (ultContent.length) {
      out.push({
        id: "ult-holes",
        level: "attention",
        label: "Literal text renders every original word",
        detail: ultContent.length + " content word" + (ultContent.length === 1 ? "" : "s") +
          " not rendered: " + ultContent.map(function (u) { return hebOf(v, u); }).join(" · "),
        units: ultContent.map(function (u) { return u.n; }),
        contentWords: true,
      });
    }
    if (ultFunction.length) {
      out.push({
        id: "ult-function",
        level: "note",
        label: "Function words the literal text drops",
        detail: ultFunction.map(function (u) { return hebOf(v, u); }).join(" · "),
        units: ultFunction.map(function (u) { return u.n; }),
      });
    }

    // One original word carried by widely separated English — a restructure.
    var spread = v.units.filter(function (u) {
      return u.ust.length > 1 || u.ult.length > 1;
    });
    if (spread.length) {
      out.push({
        id: "spread",
        level: "note",
        label: "Word rendered in more than one place",
        detail: spread.length + " unit" + (spread.length === 1 ? "" : "s") + ": " +
          spread.map(function (u) { return hebOf(v, u); }).join(" · "),
        units: spread.map(function (u) { return u.n; }),
      });
    }

    var unanchored = v.tn.filter(function (r) { return r.quote && !r.words.length; });
    out.push({
      id: "tn-anchor",
      level: unanchored.length ? "attention" : "ok",
      label: "Every note's quote is found in the original",
      detail: unanchored.length
        ? unanchored.length + " unanchored"
        : v.tn.filter(function (r) { return r.quote; }).length + " of " +
          v.tn.filter(function (r) { return r.quote; }).length + " anchored",
      units: [],
    });

    var noArticle = v.tn.filter(function (r) { return !r.article; });
    if (noArticle.length) {
      out.push({
        id: "tn-article",
        level: "note",
        label: "Notes with no translationAcademy article",
        detail: noArticle.length + " of " + v.tn.length,
        units: [],
      });
    }

    var supplied = v.unalignedUlt.filter(function (t) { return /[A-Za-z]/.test(t); });
    if (supplied.length) {
      out.push({
        id: "supplied",
        level: "note",
        label: "Literal words with no original behind them",
        detail: supplied.join(" · "),
        units: [],
      });
    }

    var suppliedUst = v.unalignedUst.filter(function (t) { return /[A-Za-z]/.test(t); });
    if (suppliedUst.length) {
      out.push({
        id: "supplied-ust",
        level: "note",
        label: "Simplified words with no original behind them",
        detail: suppliedUst.join(" · "),
        units: [],
      });
    }

    return out;
  }

  function hebOf(v, unit) {
    return unit.words
      .map(function (i) { return v.words[i].w; })
      .join(" ");
  }

  // ------------------------------------------------------------- rendering

  function morphText(word) {
    if (!word.gloss || !word.gloss.length) return word.morph || "";
    return word.gloss.join("  +  ");
  }

  // Hebrew line, right-to-left, one span per word. dir=rtl on the container does
  // the visual reordering; word order in the DOM stays ascending.
  function hebrewHtml(ref, opts) {
    var v = decorate(ref);
    var o = opts || {};
    var selUnits = o.units || {};
    var marked = o.marked || {};
    return v.words
      .map(function (w) {
        var u = v.unitOfWord[w.i];
        var cls = "hw";
        if (selUnits[u]) cls += " on";
        if (marked[w.i]) cls += " marked";
        return (
          '<span class="' + cls + '" data-word="' + w.i + '" data-unit="' + u + '" ' +
          'title="' + esc(w.lemma + "  ·  " + morphText(w)) + '">' +
          esc(w.w) + "</span>" + (w.after ? esc(w.after) : "")
        );
      })
      .join(" ");
  }

  // Literal / simplified prose, built from the alignment groups so a selection
  // can light up exactly the words that render the chosen original word.
  function proseHtml(ref, which, opts) {
    var v = decorate(ref);
    var o = opts || {};
    var on = o.groups || {};
    var groups = which === "ult" ? v.ult : v.ust;
    return groups
      .map(function (g) {
        var cls = on[g.id] ? "pg on" : "pg";
        if (!g.h.length) cls += " supplied";
        return '<span class="' + cls + '" data-group="' + g.id + '">' + esc(g.e) + "</span>";
      })
      .join("");
  }

  function unitRows(ref) {
    var v = decorate(ref);
    var noteOf = {}, termOf = {};
    v.tn.forEach(function (r) { r.spans.units.forEach(function (n) { (noteOf[n] = noteOf[n] || []).push(r); }); });
    v.twl.forEach(function (r) { r.spans.units.forEach(function (n) { (termOf[n] = termOf[n] || []).push(r); }); });
    return v.units.map(function (u) {
      return {
        unit: u,
        heb: hebOf(v, u),
        words: u.words.map(function (i) { return v.words[i]; }),
        ult: u.ultText,
        ust: u.ustText,
        notes: noteOf[u.n] || [],
        terms: termOf[u.n] || [],
      };
    });
  }

  function articleFor(row) {
    if (row.kind === "twl" || row.key) return V.tw[row.key] || null;
    return row.article ? V.ta[row.article] || null : null;
  }

  function head(current) {
    var pages = [
      { href: "verse.html", label: "Verse" },
      { href: "focus.html", label: "Focus" },
      { href: "index.html", label: "About" },
    ];
    return pages
      .map(function (p) {
        return '<a href="' + p.href + '"' + (p.href === current ? ' aria-current="page"' : "") + ">" + p.label + "</a>";
      })
      .join("");
  }

  function mountHead(el, current) {
    var nav = el.querySelector("nav");
    if (nav) nav.innerHTML = head(current);
    var t = el.querySelector('[data-action="toggle-theme"]');
    if (t) {
      t.addEventListener("click", function () {
        var root = document.documentElement;
        var now = root.dataset.theme ||
          (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        root.dataset.theme = now === "dark" ? "light" : "dark";
      });
    }
  }

  window.VL = {
    V: V,
    refs: refs,
    esc: esc,
    md: md,
    note: note,
    decorate: decorate,
    coherence: coherence,
    hebOf: hebOf,
    morphText: morphText,
    hebrewHtml: hebrewHtml,
    proseHtml: proseHtml,
    unitRows: unitRows,
    articleFor: articleFor,
    mountHead: mountHead,
  };
})();
