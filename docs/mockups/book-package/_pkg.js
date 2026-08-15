/* Book package view — derivation layer.
 *
 * Everything the two screens display is computed here from window.ZEC (the real
 * unfoldingWord fixtures). Nothing is hand-typed: if a number appears on screen
 * it came out of this file, and if a value cannot be derived the screens say
 * "unknown" rather than inventing one.
 *
 * The one genuinely interesting derivation is quote location. A tN Quote is
 * original-language text; the ULT stores its own alignment (\zaln-s x-content),
 * so a Hebrew quote can be resolved to the exact English words that render it.
 * When that resolution fails, it fails visibly — see status "none".
 */
(function () {
  "use strict";

  var Z = window.ZEC;
  if (!Z) throw new Error("_zec.js must load before _pkg.js");

  // ------------------------------------------------------------ text utils

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var HEB_RANGE = /[֐-׿]/;
  function isHebrew(s) {
    return HEB_RANGE.test(s || "");
  }

  // Consonantal skeleton. Separators are replaced BEFORE points are stripped —
  // the maqqef (U+05BE) sits inside the accent range and would otherwise glue
  // two words into one.
  function skel(s) {
    return String(s || "")
      .normalize("NFC")
      .replace(/[־​‌‍⁠﻿\s]/g, " ")
      .replace(/[֑-ׇ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function skelTight(s) {
    return skel(s).replace(/ /g, "");
  }

  function normEng(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[’'“”"]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ------------------------------------------------------------ note markup

  // tN notes are markdown-ish: **bold**, [alt translation] brackets,
  // [text](link), and (See: [[rc://...]]) references.
  function renderNote(text) {
    var s = esc(text || "");
    s = s.replace(/\\n/g, "\n");
    s = s.replace(/\[\[rc:\/\/[^\]]*?\/([^\/\]]+)\]\]/g, '<span class="mono">$1</span>');
    s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/^#+\s*(.+)$/gm, "<b>$1</b>");
    s = s.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
    return s;
  }

  function firstSentence(text, max) {
    var s = String(text || "").replace(/\\n/g, "\n");
    s = s.replace(/^#+\s*/gm, ""); // markdown headings read as noise in one line
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/\*\*/g, "");
    s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
    var cut = s.indexOf(". ");
    if (cut > 30 && cut < max) return s.slice(0, cut + 1);
    return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, "") + "…" : s;
  }

  // ------------------------------------------------------------ segments

  function segsFor(ref) {
    return Z.segs[ref] || null;
  }
  function plainFor(ref) {
    var segs = segsFor(ref);
    if (!segs) return null;
    return segs
      .map(function (s) {
        return s.e;
      })
      .join("");
  }

  // Collapse consecutive segments sharing the same x-content into one alignment
  // group, so a Hebrew word rendered by discontiguous English counts once.
  function alignGroups(segs) {
    var groups = [];
    for (var i = 0; i < segs.length; i++) {
      if (!segs[i].h) continue;
      var prev = groups[groups.length - 1];
      if (prev && prev.h === segs[i].h) prev.segs.push(i);
      else groups.push({ h: segs[i].h, tight: skelTight(segs[i].h), segs: [i] });
    }
    return groups;
  }

  // Resolve one quote part against a verse.
  //   Hebrew  -> indices of the aligned segments that render it
  //   English -> character range in the reading text
  // Returns null when the part cannot be located, which is a real outcome and
  // is reported as such.
  function locatePart(ref, part) {
    var segs = segsFor(ref);
    if (!segs || !part) return null;

    if (isHebrew(part)) {
      // Two structural facts about the ULT's alignment make naive matching wrong:
      //   1. one Hebrew group can align to discontiguous English, so the same
      //      x-content repeats across several consecutive segments;
      //   2. segment order follows ENGLISH word order, so the Hebrew groups of a
      //      contiguous Hebrew phrase need not be contiguous or in order here.
      // So: collapse repeats into groups, then cover the quote's WORDS greedily.
      //
      // Word-level, not whole-group: a group's x-content often holds more than the
      // quote does — ZEC 1:12 aligns "את ירושלם" as one unit while the quote is only
      // "ירושלם" — so whole-group containment silently under-matches. Taking each
      // group solely for the words it still owes also stops a frequent word ("יהוה")
      // from dragging in every other group that happens to contain it.
      var target = skelTight(part);
      if (!target) return null;

      var groups = alignGroups(segs);

      var need = skel(part).split(" ").filter(function (t) { return t.length >= 2; });
      if (!need.length) need = skel(part).split(" ").filter(Boolean);

      var remaining = need.slice();
      var picked = [];
      for (var g = 0; g < groups.length && remaining.length; g++) {
        var gTokens = skel(groups[g].h).split(" ");
        var took = false;
        for (var k = 0; k < gTokens.length; k++) {
          var at = remaining.indexOf(gTokens[k]);
          if (at >= 0) {
            remaining.splice(at, 1);
            took = true;
          }
        }
        if (took) picked.push(groups[g]);
      }
      // Reverse containment: a short quote can sit inside one larger aligned
      // group (the ULT rendered several Hebrew words as one unit).
      if (!picked.length) {
        for (var r2 = 0; r2 < groups.length; r2++) {
          if (groups[r2].tight.indexOf(target) >= 0) {
            return { kind: "aligned", segs: groups[r2].segs.slice(), complete: true, left: "" };
          }
        }
        return null;
      }

      var segIdx = [];
      picked.forEach(function (p) {
        p.segs.forEach(function (i) { segIdx.push(i); });
      });
      return {
        kind: "aligned",
        segs: segIdx,
        complete: remaining.length === 0,
        left: remaining.join(" "),
      };
    }

    var text = plainFor(ref);
    if (!text) return null;
    var at = text.indexOf(part);
    if (at >= 0) return { kind: "text", start: at, end: at + part.length, exact: true };
    // normalized retry: the ULT may have been revised since the note was written
    var nt = normEng(text);
    var np = normEng(part);
    var nAt = np ? nt.indexOf(np) : -1;
    if (nAt < 0) return null;
    return { kind: "text-normalized", start: -1, end: -1, exact: false };
  }

  // A quote may be discontinuous: Hebrew parts are joined by "&", English by "…".
  function locate(ref, quote) {
    if (!quote) return { status: "no-quote", parts: [] };
    if (!segsFor(ref)) return { status: "no-verse", parts: [] };
    var raw = String(quote).split(/\s*(?:&|…|\.\.\.)\s*/).filter(Boolean);
    var parts = [];
    var missing = 0;
    var normalized = 0;
    var incomplete = 0;
    for (var i = 0; i < raw.length; i++) {
      var hit = locatePart(ref, raw[i]);
      if (!hit) missing++;
      else if (hit.kind === "text-normalized") normalized++;
      else if (hit.kind === "aligned" && hit.complete === false) incomplete++;
      parts.push({ text: raw[i], hit: hit });
    }
    var status = "located";
    if (missing === raw.length) status = "none";
    else if (missing || incomplete) status = "partial";
    else if (normalized) status = "normalized";
    return { status: status, parts: parts, lang: isHebrew(quote) ? "heb" : "eng" };
  }

  // Verse HTML with the located quote marked. Marking is driven entirely by
  // locate() — an unlocatable quote produces a plain verse, never a fake match.
  function verseHtml(ref, quote) {
    var segs = segsFor(ref);
    if (!segs) return "";
    var res = locate(ref, quote);
    var markSeg = {};
    var ranges = [];
    res.parts.forEach(function (p) {
      if (!p.hit) return;
      if (p.hit.kind === "aligned") p.hit.segs.forEach(function (i) { markSeg[i] = true; });
      else if (p.hit.kind === "text") ranges.push([p.hit.start, p.hit.end]);
    });

    var out = "";
    var pos = 0;
    for (var i = 0; i < segs.length; i++) {
      var e = segs[i].e;
      var startPos = pos;
      pos += e.length;
      var on = !!markSeg[i];
      if (!on) {
        for (var r = 0; r < ranges.length; r++) {
          if (startPos < ranges[r][1] && pos > ranges[r][0]) { on = true; break; }
        }
      }
      out += on ? "<mark>" + esc(e) + "</mark>" : esc(e);
    }
    return out;
  }

  function hebrewHtml(ref, quote) {
    var res = locate(ref, quote);
    if (res.lang !== "heb") return "";
    return '<span class="heb">' + esc(String(quote).replace(/&/g, " … ")) + "</span>";
  }

  // ------------------------------------------------------------ row index

  function refParts(ref) {
    if (/^front/i.test(ref)) return { ch: 0, v: 0, intro: true, label: "front" };
    var m = /^(\d+):(intro|\d+)/.exec(ref);
    if (!m) return { ch: 0, v: 0, intro: false, label: ref };
    var intro = m[2] === "intro";
    return {
      ch: parseInt(m[1], 10),
      v: intro ? 0 : parseInt(m[2], 10),
      intro: intro,
      label: ref,
    };
  }

  function shortArticle(rc) {
    if (!rc) return "";
    var bits = String(rc).split("/");
    return bits[bits.length - 1];
  }
  function twCategory(rc) {
    var m = /\/tw\/dict\/bible\/([^\/]+)\//.exec(rc || "");
    return m ? m[1] : "";
  }

  var notes = Z.tn.map(function (r) {
    var p = refParts(r.ref);
    var loc = r.quote && !p.intro ? locate(r.ref, r.quote) : { status: r.quote ? "no-verse" : "no-quote", parts: [] };
    return {
      kind: "tn",
      ref: r.ref,
      ch: p.ch,
      verse: p.v,
      intro: p.intro,
      id: r.id,
      tags: r.tags,
      article: shortArticle(r.sr),
      sr: r.sr,
      quote: r.quote,
      occ: r.occ,
      note: r.note,
      qlang: r.quote ? (isHebrew(r.quote) ? "heb" : "eng") : "",
      loc: loc.status,
    };
  });

  var questions = Z.tq.map(function (r) {
    var p = refParts(r.ref);
    return { kind: "tq", ref: r.ref, ch: p.ch, verse: p.v, id: r.id, q: r.q, a: r.a, quote: r.quote };
  });

  var links = Z.twl.map(function (r) {
    var p = refParts(r.ref);
    return {
      kind: "twl",
      ref: r.ref,
      ch: p.ch,
      verse: p.v,
      id: r.id,
      tags: r.tags,
      words: r.words,
      occ: r.occ,
      link: r.link,
      term: shortArticle(r.link),
      cat: twCategory(r.link),
    };
  });

  // Questions for one reference — the fourth resource in the package, and the
  // reason the context pane can claim to show a whole package location.
  function questionsAt(ref) {
    return questions.filter(function (q) { return q.ref === ref; });
  }

  // ------------------------------------------------------------ aggregates

  function tally(list, key) {
    var m = {};
    list.forEach(function (x) {
      var k = key(x);
      if (k === "" || k == null) return;
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  }

  var chapters = Z.chapters.map(function (c) {
    var n = c.n;
    var cn = notes.filter(function (r) { return r.ch === n; });
    var cq = questions.filter(function (r) { return r.ch === n; });
    var cl = links.filter(function (r) { return r.ch === n; });
    var quoted = cn.filter(function (r) { return r.quote && !r.intro; });
    return {
      n: n,
      verses: c.verses,
      tn: cn.length,
      tnIntro: cn.filter(function (r) { return r.intro; }).length,
      tq: cq.length,
      twl: cl.length,
      articles: Object.keys(tally(cn, function (r) { return r.article; })).length,
      terms: Object.keys(tally(cl, function (r) { return r.term; })).length,
      quoteHeb: quoted.filter(function (r) { return r.qlang === "heb"; }).length,
      quoteEng: quoted.filter(function (r) { return r.qlang === "eng"; }).length,
      unlocatable: quoted.filter(function (r) { return r.loc === "none"; }).length,
      drifted: quoted.filter(function (r) { return r.loc === "normalized" || r.loc === "partial"; }).length,
      flagged: cn.filter(function (r) { return /ISSUE/.test(r.tags || ""); }).length,
      adapted: cn.filter(function (r) { return /at-fit/.test(r.tags || ""); }).length,
      noArticle: cn.filter(function (r) { return !r.intro && !r.article; }).length,
    };
  });

  var frontNotes = notes.filter(function (r) { return r.ch === 0; });

  function articleIndex() {
    var m = {};
    notes.forEach(function (r) {
      if (!r.article) return;
      if (!m[r.article]) m[r.article] = { id: r.article, sr: r.sr, count: 0, chapters: {}, rows: [] };
      var a = m[r.article];
      a.count++;
      a.chapters[r.ch] = (a.chapters[r.ch] || 0) + 1;
      a.rows.push(r);
    });
    return Object.keys(m)
      .map(function (k) { return m[k]; })
      .sort(function (a, b) { return b.count - a.count || a.id.localeCompare(b.id); });
  }

  function termIndex() {
    var m = {};
    links.forEach(function (r) {
      if (!m[r.term]) m[r.term] = { id: r.term, cat: r.cat, link: r.link, count: 0, chapters: {}, rows: [], forms: {} };
      var t = m[r.term];
      t.count++;
      t.chapters[r.ch] = (t.chapters[r.ch] || 0) + 1;
      t.rows.push(r);
      var f = skel(r.words);
      if (f) t.forms[f] = (t.forms[f] || 0) + 1;
    });
    return Object.keys(m)
      .map(function (k) {
        var t = m[k];
        t.formCount = Object.keys(t.forms).length;
        t.spread = Object.keys(t.chapters).length;
        return t;
      })
      .sort(function (a, b) { return b.count - a.count || a.id.localeCompare(b.id); });
  }

  var articles = articleIndex();
  var terms = termIndex();

  var quotedNotes = notes.filter(function (r) { return r.quote && !r.intro; });
  var totals = {
    chapters: chapters.length,
    verses: chapters.reduce(function (a, c) { return a + c.verses; }, 0),
    tn: notes.length,
    tnIntro: notes.filter(function (r) { return r.intro; }).length,
    tq: questions.length,
    twl: links.length,
    articles: articles.length,
    terms: terms.length,
    quoted: quotedNotes.length,
    quoteHeb: quotedNotes.filter(function (r) { return r.qlang === "heb"; }).length,
    quoteEng: quotedNotes.filter(function (r) { return r.qlang === "eng"; }).length,
    located: quotedNotes.filter(function (r) { return r.loc === "located"; }).length,
    normalized: quotedNotes.filter(function (r) { return r.loc === "normalized"; }).length,
    partial: quotedNotes.filter(function (r) { return r.loc === "partial"; }).length,
    unlocatable: quotedNotes.filter(function (r) { return r.loc === "none"; }).length,
    noArticle: notes.filter(function (r) { return !r.intro && !r.article; }).length,
    flagged: notes.filter(function (r) { return /ISSUE/.test(r.tags || ""); }).length,
    adapted: notes.filter(function (r) { return /at-fit/.test(r.tags || ""); }).length,
    alignedSegments: Object.keys(Z.segs).reduce(function (a, k) {
      return a + Z.segs[k].filter(function (s) { return s.h; }).length;
    }, 0),
  };

  // ------------------------------------------------------------ chrome bits

  function head(current) {
    var pages = [
      { href: "ledger.html", label: "Ledger" },
      { href: "sweep.html", label: "Sweep" },
      { href: "index.html", label: "About" },
    ];
    return pages
      .map(function (p) {
        return (
          '<a href="' + p.href + '"' + (p.href === current ? ' aria-current="page"' : "") + ">" + p.label + "</a>"
        );
      })
      .join("");
  }

  function mountHead(el, current) {
    var nav = el.querySelector("nav");
    if (nav) nav.innerHTML = head(current);
    var toggle = el.querySelector('[data-action="toggle-theme"]');
    if (toggle) {
      toggle.addEventListener("click", function () {
        var root = document.documentElement;
        var now = root.dataset.theme;
        if (!now) now = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        root.dataset.theme = now === "dark" ? "light" : "dark";
      });
    }
  }

  window.PKG = {
    esc: esc,
    isHebrew: isHebrew,
    skel: skel,
    renderNote: renderNote,
    firstSentence: firstSentence,
    plainFor: plainFor,
    segsFor: segsFor,
    locate: locate,
    verseHtml: verseHtml,
    hebrewHtml: hebrewHtml,
    shortArticle: shortArticle,
    notes: notes,
    questions: questions,
    questionsAt: questionsAt,
    links: links,
    chapters: chapters,
    frontNotes: frontNotes,
    articles: articles,
    terms: terms,
    totals: totals,
    meta: Z.meta,
    mountHead: mountHead,
  };
})();
