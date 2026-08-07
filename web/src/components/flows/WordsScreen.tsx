// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// t6-words: the per-verse translationWords link (TWL) screen, ported from
// docs/flows/ui/t6-words.html onto the app's real data + save machinery.
//
// Two things this screen deliberately does NOT have:
//   * an approve lifecycle — there is no validate endpoint for TWL rows, so
//     Save (and Delete) are the only state-changing actions here. The mockup's
//     note to that effect is rendered, not dropped.
//   * manual reorder — TWL is canonically ordered by source-word position
//     (lib/twlCanonicalOrder.ts), which is what the list uses.
//
// Everything comes from real endpoints: twl rows + verses from useChapter, the
// tW article catalog from useCatalogs, suggestions from the shared
// TwlSuggestions component, lexicon entries from useLexicon. Where the backend
// genuinely has nothing (empty lexicon table, a quarantined ULT lane, no
// suggestions) the UI says so rather than inventing content.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";

import { FlowNav } from "./FlowNav";
import { FlowActionBar } from "./FlowActionBar";
import { LockBanner } from "./FlowBanners";
import { WordsLexiconStrip, collectSourceWords } from "./WordsLexiconStrip";
import type { FlowScreenContext } from "./types";

import { useChapter } from "../../hooks/useChapter";
import { useCatalogs } from "../../hooks/useCatalogs";
import { useTwlFilters } from "../../hooks/useTwlFilters";
import { useLexicon } from "../../hooks/useLexicon";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { drafts, rowKey } from "../../sync/drafts";
import { api, ApiError, type ChapterLockedBody, type TwlRow, type TwlSuggestion } from "../../sync/api";
import { canonicalTwlOrder } from "../../lib/twlCanonicalOrder";
import { resolveSpanToSource } from "../../lib/twlResolve";
import { buildQuoteFromSelection, collectTargetTokens, selectionFromQuote } from "../../lib/quoteBuilder";
import type { HighlightKey } from "../../lib/highlight";
import { nfc } from "../../lib/hebrew";
import { isHebrewBook } from "../../lib/sourceSearch";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import { QuoteBuilderPopper } from "../QuoteBuilderPopper";
import { TwlSuggestions } from "../TwlSuggestions";

export interface WordsScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

// rc://*/tw/dict/bible/kt/god  <->  kt/god
function twLinkToId(link: string | null | undefined): string {
  if (!link) return "";
  const m = /^rc:\/\/\*\/tw\/dict\/bible\/(.+)$/.exec(link);
  return m ? m[1] : link;
}
function idToTwLink(id: string): string | null {
  const trimmed = id.trim();
  return trimmed ? `rc://*/tw/dict/bible/${trimmed}` : null;
}

interface LinkForm {
  quote: string;
  occurrence: string;
  article: string;
}

function formFromRow(row: TwlRow): LinkForm {
  return {
    quote: row.orig_words ?? "",
    occurrence: String(row.occurrence ?? 1),
    article: twLinkToId(row.tw_link),
  };
}

function sameForm(a: LinkForm, b: LinkForm): boolean {
  return a.quote === b.quote && a.occurrence === b.occurrence && a.article === b.article;
}

const EMPTY_FORM: LinkForm = { quote: "", occurrence: "1", article: "" };

// Non-null verseObjects array for a lane's verse, or null when the lane has no
// content for it (a lane pending replacement is omitted from the payload).
function verseObjectsOf(
  verses: Record<string, Record<number, { content: unknown }>> | undefined,
  bibleVersion: string,
  verse: number,
): unknown[] | null {
  const content = verses?.[bibleVersion]?.[verse]?.content as
    | { verseObjects?: unknown[] }
    | null
    | undefined;
  const vo = content?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// `me` / `onNavigate` come with the shared flow-screen contract but this screen
// needs neither: identity is not shown here, and verse navigation moves the
// hash (#/words/…) so the user stays on this screen rather than jumping to the
// editor. Both are left undestructured rather than accepted-and-ignored.
export default function WordsScreen({ role, book, chapter, verse }: WordsScreenProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md")); // >=900: list + detail side by side
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560: table rather than cards

  const { status, data, applyLocalRowPatch, applyLocalRowDelete, applyLocalRowInsert } = useChapter(
    book,
    chapter,
  );
  const catalogs = useCatalogs();
  const twlFilters = useTwlFilters(book);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<LinkForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<LinkForm>(EMPTY_FORM);
  // A ref, not state: setting it must not re-run the hydration effect, whose
  // cleanup would otherwise cancel its own in-flight drafts.get().
  const hydratedKeyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lock, setLock] = useState<ChapterLockedBody | null>(null);
  // <900 only: which of the two panes the single column is showing.
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [linksSheet, setLinksSheet] = useState(false);
  const [verseSheet, setVerseSheet] = useState(false);

  // Quote builder (reuses the app's QuoteBuilderPopper). "add" creates a new
  // row on commit; "edit" only updates the form, which commits on Save.
  const [qb, setQb] = useState<{ mode: "add" | "edit"; anchor: HTMLElement } | null>(null);
  const [qbKeys, setQbKeys] = useState<Set<HighlightKey>>(new Set());

  const sourceIsHebrew = isHebrewBook(book);
  const sourceLane = sourceIsHebrew ? "UHB" : "UGNT";

  const uhbVo = useMemo(
    () => verseObjectsOf(data?.verses, sourceLane, verse),
    [data, sourceLane, verse],
  );
  const ultVo = useMemo(() => verseObjectsOf(data?.verses, "ULT", verse), [data, verse]);
  const ustVo = useMemo(() => verseObjectsOf(data?.verses, "UST", verse), [data, verse]);
  const ultPlain = data?.verses?.ULT?.[verse]?.plain_text ?? null;
  const ustPlain = data?.verses?.UST?.[verse]?.plain_text ?? null;

  const sourceWords = useMemo(() => collectSourceWords(uhbVo), [uhbVo]);
  const strongs = useMemo(
    () => sourceWords.map((w) => w.strong).filter((s) => s.length > 0),
    [sourceWords],
  );
  const lexicon = useLexicon(strongs);

  // Canonical order (ULT word position, then sort_order) — the same ordering
  // export/reimport compute, which is why manual reorder stays off here.
  const links = useMemo(() => {
    const rows = (data?.twl ?? []).filter((r) => r.verse === verse && r.deleted_at == null);
    return canonicalTwlOrder(rows, ultVo);
  }, [data, verse, ultVo]);

  // Verse range for prev/next. The source lane is present even when a target
  // lane is quarantined, so it anchors the range; ULT is the fallback.
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);

  const selectedIndex = selectedId ? links.findIndex((r) => r.id === selectedId) : -1;
  const selectedRow = selectedIndex >= 0 ? links[selectedIndex] : null;

  // Keep the selection valid: first row when nothing is selected, or when the
  // selected row disappeared (deleted here or by a peer).
  useEffect(() => {
    if (links.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !links.some((r) => r.id === selectedId)) {
      setSelectedId(links[0].id);
    }
  }, [links, selectedId]);

  // Hydrate the edit form from the row, then from any persisted draft (unsaved
  // typing from this browser) — same explicit-Save-only shape as ReviewQueue.
  useEffect(() => {
    if (!selectedRow) {
      hydratedKeyRef.current = null;
      return;
    }
    const key = rowKey("twl", book, selectedRow.id);
    if (hydratedKeyRef.current === key) return;
    const base = formFromRow(selectedRow);
    hydratedKeyRef.current = key;
    setBaseline(base);
    setForm(base);
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== key) return;
      const patch = (rec?.payload as { patch?: Record<string, unknown> } | undefined)?.patch;
      if (!patch) return;
      setForm((f) => ({
        quote: typeof patch.orig_words === "string" ? patch.orig_words : f.quote,
        occurrence: patch.occurrence == null ? f.occurrence : String(patch.occurrence),
        article:
          typeof patch.tw_link === "string"
            ? twLinkToId(patch.tw_link)
            : patch.tw_link === null
              ? ""
              : f.article,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRow, book]);

  const dirty = Boolean(selectedRow) && !sameForm(form, baseline);

  // Stash every keystroke to the drafts store. This never writes to the server
  // on its own — Save does — but it means unsaved text survives a reload.
  useEffect(() => {
    if (!selectedRow) return;
    const key = rowKey("twl", book, selectedRow.id);
    if (hydratedKeyRef.current !== key) return;
    if (sameForm(form, baseline)) {
      void drafts.clear(key);
      return;
    }
    void drafts.set(
      key,
      {
        patch: {
          orig_words: form.quote,
          occurrence: Number(form.occurrence) || 1,
          tw_link: idToTwLink(form.article),
        },
        baseline: {
          orig_words: baseline.quote,
          occurrence: Number(baseline.occurrence) || 1,
          tw_link: idToTwLink(baseline.article),
        },
      },
      selectedRow.version,
      {
        kind: "row",
        rowKind: "twl",
        id: selectedRow.id,
        book,
        chapter: selectedRow.chapter,
        verse: selectedRow.verse,
      },
    );
  }, [form, baseline, selectedRow, book]);

  // Reactive lock banner. A Save/Delete goes out through the outbox, so its
  // 409 `chapter_locked` never reaches this component's own catch — it comes
  // back as an outbox result. Listen for it so the banner reflects a real
  // server body (pipeline + start time), never a guess.
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "locked") return;
      if (op.target.kind !== "row" || op.target.book !== book) return;
      setLock(result.lockBody);
    });
  }, [book]);

  function goVerse(delta: number) {
    if (verseNums.length === 0) return;
    let idx = verseNums.indexOf(verse);
    if (idx === -1) idx = 0;
    const next = Math.max(0, Math.min(verseNums.length - 1, idx + delta));
    if (verseNums[next] === verse) return;
    // Stay on this screen — the route drives the `verse` prop.
    location.hash = `#/words/${book}/${chapter}/${verseNums[next]}`;
  }

  function selectLink(id: string) {
    setSelectedId(id);
    setMobilePane("detail");
  }

  function reportError(prefix: string, err: unknown) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | undefined;
      if (err.status === 409 && body?.error === "chapter_locked") {
        setLock(err.body as ChapterLockedBody);
        setNotice(`${prefix} blocked — an AI run currently holds this chapter.`);
        return;
      }
      setNotice(`${prefix} failed (HTTP ${err.status}${body?.error ? ` ${body.error}` : ""}).`);
      return;
    }
    setNotice(`${prefix} failed.`);
  }

  async function handleSave() {
    if (!selectedRow || !dirty || busy) return;
    setBusy(true);
    try {
      const patch = {
        orig_words: form.quote,
        occurrence: Number(form.occurrence) || 1,
        tw_link: idToTwLink(form.article),
      };
      applyLocalRowPatch("twl", selectedRow.id, patch);
      // The outbox owns If-Match, the 409 merge prompt, the 401 refresh and the
      // retry/backoff — never PATCH straight past it.
      await outbox.enqueueRow("twl", selectedRow.id, selectedRow.version, patch, {
        book,
        baseline: {
          orig_words: baseline.quote,
          occurrence: Number(baseline.occurrence) || 1,
          tw_link: idToTwLink(baseline.article),
        },
      });
      setBaseline(form);
      setNotice("Word link queued for save.");
    } finally {
      setBusy(false);
    }
  }

  function handleUndo() {
    if (!selectedRow || !dirty) return;
    setForm(baseline);
    setNotice("Reverted to the last saved values.");
  }

  async function handleDelete() {
    if (!selectedRow || busy) return;
    setBusy(true);
    try {
      const id = selectedRow.id;
      const version = selectedRow.version;
      applyLocalRowDelete("twl", id);
      void drafts.clear(rowKey("twl", book, id));
      // The chapter lock applies to DELETE for every kind — api/src/rows.ts's
      // delete handler has no tn carve-out (only PATCH does, and only for tn).
      // So this can 409 exactly like Save; the outbox surfaces what the server
      // actually returned rather than us pre-judging it.
      await outbox.enqueueDeleteRow("twl", id, version, book);
      setMobilePane("list");
      setNotice("Word link deleted.");
    } finally {
      setBusy(false);
    }
  }

  const openQuoteBuilder = useCallback(
    (mode: "add" | "edit", anchor: HTMLElement) => {
      setQbKeys(
        mode === "edit"
          ? selectionFromQuote(uhbVo, form.quote, Number(form.occurrence) || 1)
          : new Set<HighlightKey>(),
      );
      setQb({ mode, anchor });
    },
    [uhbVo, form.quote, form.occurrence],
  );

  function nextSortOrder(): number {
    const max = links.reduce((acc, r) => Math.max(acc, r.sort_order ?? 0), 0);
    return max + 100;
  }

  async function handleQuoteCommit() {
    if (!qb) return;
    const built = buildQuoteFromSelection(uhbVo, qbKeys);
    if (!built) return;
    if (qb.mode === "edit") {
      setForm((f) => ({ ...f, quote: built.quote, occurrence: String(built.occurrence) }));
      setQb(null);
      setNotice("Quote updated locally — commits on Save.");
      return;
    }
    setQb(null);
    setBusy(true);
    try {
      const created = await api.createRow<TwlRow>("twl", {
        book,
        chapter,
        verse,
        ref_raw: verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`,
        orig_words: built.quote,
        occurrence: built.occurrence,
        tw_link: null,
        sort_order: nextSortOrder(),
      });
      applyLocalRowInsert("twl", created);
      setSelectedId(created.id);
      setMobilePane("detail");
      setNotice("Word link created — now set its tW article.");
    } catch (err) {
      reportError("Create", err);
    } finally {
      setBusy(false);
    }
  }

  // --- suggestions wiring ------------------------------------------------

  const suggestionQuote = useCallback(
    (s: TwlSuggestion) => resolveSpanToSource(ultVo, uhbVo, s.matchedText, s.glOccurrence),
    [ultVo, uhbVo],
  );

  const isSuggestionExcluded = useCallback(
    (s: TwlSuggestion) => {
      const resolved = suggestionQuote(s);
      if (resolved && twlFilters.isDeletedHere(`${chapter}:${verse}`, resolved.orig_words)) {
        return true;
      }
      if (links.length === 0) return false;
      if (!resolved) return links.some((r) => r.tw_link === s.twLink);
      return links.some((r) => nfc(r.orig_words ?? "") === nfc(resolved.orig_words));
    },
    [suggestionQuote, twlFilters, chapter, verse, links],
  );

  const blockedArticleIds = useCallback(
    (s: TwlSuggestion, candidateIds?: string[]) => {
      const blocked = new Set<string>();
      const resolved = suggestionQuote(s);
      if (!resolved) return blocked;
      for (const id of candidateIds ?? [s.articleId]) {
        const link = idToTwLink(id);
        if (link && twlFilters.isUnlinked(resolved.orig_words, link)) blocked.add(id);
      }
      return blocked;
    },
    [suggestionQuote, twlFilters],
  );

  const handleAddSuggestion = useCallback(
    async (s: TwlSuggestion, chosenArticleId: string) => {
      const resolved = suggestionQuote(s);
      if (!resolved || !resolved.orig_words) {
        setNotice(
          `Couldn't resolve “${s.matchedText}” to an original-language quote — add it manually with “Build from source”.`,
        );
        return;
      }
      const category = chosenArticleId.split("/")[0];
      const tag = category === "kt" ? "keyterm" : category === "names" ? "name" : "";
      try {
        const created = await api.createRow<TwlRow>("twl", {
          book,
          chapter,
          verse,
          ref_raw: verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`,
          orig_words: resolved.orig_words,
          occurrence: resolved.occurrence,
          tw_link: idToTwLink(chosenArticleId),
          ...(tag ? { tags: tag } : {}),
          sort_order: nextSortOrder(),
        });
        applyLocalRowInsert("twl", created);
        setSelectedId(created.id);
        setNotice("Word link added from suggestion.");
      } catch (err) {
        reportError("Add", err);
      }
    },
    // nextSortOrder / reportError close over state that changes each render;
    // recreating the callback per render is cheaper than memoizing them all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggestionQuote, book, chapter, verse, applyLocalRowInsert, links],
  );

  // --- render helpers ----------------------------------------------------

  const articleOptions = useMemo(
    () => catalogs.twLinks.map((l) => twLinkToId(l)),
    [catalogs.twLinks],
  );

  const scriptureSx = {
    fontFamily: SCRIPTURE_FONT_STACK,
    textAlign: "start" as const,
  };

  function targetContext(quote: string) {
    if (!ultVo) {
      return (
        <em>
          ULT verse content isn&rsquo;t available for this verse in this environment (the lane is
          omitted while it awaits replacement). Nothing is shown here rather than guessing.
        </em>
      );
    }
    const tokens = collectTargetTokens(ultVo);
    if (tokens.length === 0) return <em>No alignment data on this verse.</em>;
    const want = nfc(quote);
    const marked = tokens.map((t) => ({
      text: t.text,
      hit: want.length > 0 && t.sources.some((s) => nfc(s.content) === want),
    }));
    if (!marked.some((m) => m.hit)) {
      return (
        <>
          {ultPlain ?? ""}
          <br />
          <em>
            No exact alignment-milestone match for “{quote}” — a quote spanning partial or merged
            milestones isn&rsquo;t resolved here.
          </em>
        </>
      );
    }
    return (
      <>
        {marked.map((m, i) => (
          <Box
            key={`${i}|${m.text}`}
            component="span"
            sx={m.hit ? { bgcolor: "action.selected", borderRadius: 0.5, px: 0.25 } : undefined}
          >
            {m.text}{" "}
          </Box>
        ))}
      </>
    );
  }

  const detailPanel = selectedRow ? (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
        bgcolor: "background.paper",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ p: 1.5, borderBlockEnd: "1px solid", borderColor: "divider" }}
      >
        {!isDesktop && (
          <Button size="small" onClick={() => setMobilePane("list")} sx={{ minHeight: 44 }}>
            ← Links
          </Button>
        )}
        <Typography
          variant="overline"
          sx={{ color: "text.secondary", fontWeight: 700, letterSpacing: "0.07em" }}
        >
          Edit word link
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {selectedIndex + 1} of {links.length}
        </Typography>
      </Stack>

      <Box sx={{ p: 2 }}>
        <Typography
          variant="caption"
          component="div"
          sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}
        >
          Quote (original-language)
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
          <Box
            dir={sourceIsHebrew ? "rtl" : "ltr"}
            sx={{
              ...scriptureSx,
              fontSize: "1.05rem",
              bgcolor: "action.hover",
              borderRadius: 1,
              paddingBlock: 0.5,
              paddingInline: 1,
              minWidth: 40,
            }}
          >
            {form.quote || "—"}
          </Box>
          <Button
            size="small"
            variant="outlined"
            sx={{ minHeight: 44 }}
            onClick={(e) => openQuoteBuilder("edit", e.currentTarget)}
          >
            Build from source
          </Button>
        </Stack>

        <TextField
          label="Occurrence"
          type="number"
          size="small"
          value={form.occurrence}
          inputProps={{ min: 1 }}
          onChange={(e) => setForm((f) => ({ ...f, occurrence: e.target.value }))}
          sx={{ mt: 2, width: 120 }}
        />

        <Box sx={{ mt: 2 }}>
          <Autocomplete
            freeSolo
            options={articleOptions}
            value={form.article}
            onChange={(_e, v) => setForm((f) => ({ ...f, article: v ?? "" }))}
            onInputChange={(_e, v) => setForm((f) => ({ ...f, article: v }))}
            renderInput={(params) => (
              <TextField {...params} size="small" label="tW article link" placeholder="kt/god" />
            )}
          />
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 0.5, flexWrap: "wrap" }}>
            {form.article ? (
              <Box
                component="a"
                href={`#/articles/tw/${encodeURIComponent(form.article)}`}
                sx={{ fontSize: "0.8rem", fontWeight: 600, color: "primary.main" }}
              >
                Read article →
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary">
                No tW article linked.
              </Typography>
            )}
            {articleOptions.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
                The tW catalog is empty here — no autocomplete options available.
              </Typography>
            )}
          </Stack>
        </Box>

        <Box sx={{ mt: 2 }}>
          <Typography
            variant="caption"
            component="div"
            sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}
          >
            In target (ULT)
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {targetContext(form.quote)}
          </Typography>
        </Box>

        {/* Actions live in the FlowActionBar below 900px, inline above it. */}
        {isDesktop && (
          <Stack direction="row" spacing={1} sx={{ mt: 2.5, flexWrap: "wrap" }}>
            <Button variant="outlined" disabled={!dirty || busy} onClick={handleUndo} sx={{ flex: 1, minHeight: 44 }}>
              Undo
            </Button>
            <Button variant="contained" disabled={!dirty || busy} onClick={handleSave} sx={{ flex: 1, minHeight: 44 }}>
              {busy ? "Working…" : "Save"}
            </Button>
            <Button color="warning" variant="outlined" disabled={busy} onClick={handleDelete} sx={{ flex: 1, minHeight: 44 }}>
              Delete
            </Button>
          </Stack>
        )}

        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          Manual reorder is off — TWL is canonically ordered by source-word position.
        </Typography>
      </Box>
    </Box>
  ) : (
    <Alert severity="info">
      No word link selected. {links.length === 0 ? "This verse has none yet — use “Add link”." : ""}
    </Alert>
  );

  const linkRows = links.map((row) => ({
    id: row.id,
    quote: row.orig_words ?? "",
    occurrence: row.occurrence ?? 1,
    article: twLinkToId(row.tw_link),
  }));

  const listPane = (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.25, flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ fontWeight: 600, color: "text.secondary" }}>
          {links.length === 1 ? "1 word link on this verse" : `${links.length} word links on this verse`}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          size="small"
          sx={{ minHeight: 44, borderRadius: 999, fontWeight: 700 }}
          onClick={(e) => openQuoteBuilder("add", e.currentTarget)}
          disabled={busy || !uhbVo}
        >
          + Add link
        </Button>
      </Stack>

      {links.length === 0 ? (
        <Alert severity="info">No word links on this verse yet.</Alert>
      ) : isTabletUp ? (
        <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 460 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ textAlign: "start" }}>Quote</TableCell>
                <TableCell sx={{ textAlign: "start" }}>Occ</TableCell>
                <TableCell sx={{ textAlign: "start" }}>tW link</TableCell>
                <TableCell sx={{ textAlign: "start" }}>Article</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {linkRows.map((r) => (
                <TableRow
                  key={r.id}
                  hover
                  selected={r.id === selectedId}
                  onClick={() => selectLink(r.id)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Edit word link ${r.quote}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectLink(r.id);
                    }
                  }}
                  sx={{ cursor: "pointer" }}
                >
                  <TableCell dir={sourceIsHebrew ? "rtl" : "ltr"} sx={scriptureSx}>
                    {r.quote}
                  </TableCell>
                  <TableCell>{r.occurrence}</TableCell>
                  <TableCell sx={{ textAlign: "start" }}>{r.article || "—"}</TableCell>
                  <TableCell sx={{ textAlign: "start" }}>
                    {r.article ? (
                      <Box
                        component="a"
                        href={`#/articles/tw/${encodeURIComponent(r.article)}`}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        sx={{ color: "primary.main", fontSize: "0.8rem" }}
                      >
                        {r.article} →
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
                        no article linked
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ) : (
        // <560: one card per link so nothing scrolls sideways.
        <Stack spacing={1.25} role="list" aria-label="Word links">
          {linkRows.map((r) => (
            <Box
              key={r.id}
              role="listitem"
              component="button"
              type="button"
              onClick={() => selectLink(r.id)}
              sx={{
                textAlign: "start",
                border: 1,
                borderColor: r.id === selectedId ? "primary.main" : "divider",
                bgcolor: r.id === selectedId ? "action.selected" : "background.paper",
                borderRadius: 1,
                p: 1.5,
                cursor: "pointer",
                font: "inherit",
                color: "inherit",
                minHeight: 44,
              }}
            >
              <Typography
                dir={sourceIsHebrew ? "rtl" : "ltr"}
                sx={{ ...scriptureSx, fontSize: "1.05rem" }}
              >
                {r.quote || "—"}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                occurrence {r.occurrence} · {r.article || "no article linked"}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        component="p"
        sx={{ fontStyle: "italic", mt: 1 }}
      >
        Word links have no approve lifecycle — there is no validate endpoint for TWL rows, so Save
        and Delete are the only state-changing actions here. Suggestions below are unsaved
        candidates until you add one.
      </Typography>

      {/* Suggestions — the mockup merges them into the same list; here they
          reuse the app's tested TwlSuggestions block directly beneath it. */}
      <TwlSuggestions
        book={book}
        chapter={chapter}
        verse={verse}
        refreshKey={links.map((r) => `${r.tw_link ?? ""}|${r.orig_words ?? ""}|${r.occurrence ?? 1}`).join("~")}
        onAdd={handleAddSuggestion}
        isExcluded={isSuggestionExcluded}
        blockedArticleIds={blockedArticleIds}
        filtersReady={twlFilters.settled}
      />
    </Box>
  );

  // --- loading / error ---------------------------------------------------

  if (status === "idle" || status === "loading" || status === "retrying") {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="words" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ p: 2, maxWidth: 1180, marginInline: "auto", width: "100%" }}>
          <Skeleton variant="text" width={180} height={38} />
          <Skeleton variant="rounded" height={44} sx={{ mt: 2 }} />
          <Skeleton variant="rounded" height={220} sx={{ mt: 2 }} />
        </Box>
      </Stack>
    );
  }

  if (status === "error" || !data) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <FlowNav current="words" book={book} chapter={chapter} verse={verse} role={role} />
        <Box sx={{ p: 3 }}>
          <Alert severity="error">
            Could not load {book} {chapter}. Word links can&rsquo;t be shown until the chapter loads.
          </Alert>
        </Box>
      </Stack>
    );
  }

  const showList = isDesktop || mobilePane === "list";
  const showDetail = isDesktop || mobilePane === "detail";

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <FlowNav current="words" book={book} chapter={chapter} verse={verse} role={role} />

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Box
          sx={{
            maxWidth: 1180,
            marginInline: "auto",
            paddingInline: 2,
            paddingBlockStart: 2,
            paddingBlockEnd: isDesktop ? 4 : 14,
          }}
        >
          {/* Verse navigation — stays on this screen, only the hash verse moves. */}
          <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.75, flexWrap: "wrap" }}>
            <IconButton
              aria-label="Previous verse"
              onClick={() => goVerse(-1)}
              disabled={verseNums.length === 0 || verse === verseNums[0]}
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              {book} {chapter}:{verse}
            </Typography>
            <IconButton
              aria-label="Next verse"
              onClick={() => goVerse(1)}
              disabled={verseNums.length === 0 || verse === verseNums[verseNums.length - 1]}
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <ChevronRightIcon />
            </IconButton>
            <Box sx={{ flex: 1 }} />
            {!isDesktop && (
              <>
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => setLinksSheet(true)}>
                  Links list
                </Button>
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => setVerseSheet(true)}>
                  This verse
                </Button>
              </>
            )}
          </Stack>

          {lock && (
            <Box sx={{ mb: 2 }}>
              <LockBanner
                pipelineType={lock.pipelineType}
                startedAt={lock.startedAt ? new Date(lock.startedAt * 1000).toISOString() : null}
              />
            </Box>
          )}

          <WordsLexiconStrip
            words={sourceWords}
            rtl={sourceIsHebrew}
            label={sourceIsHebrew ? "Hebrew" : "Greek"}
            lexicon={lexicon}
          />

          <Box
            sx={{
              display: "grid",
              gap: 2,
              alignItems: "start",
              gridTemplateColumns: isDesktop ? "minmax(0, 1.3fr) minmax(280px, 1fr)" : "minmax(0, 1fr)",
            }}
          >
            {showList && listPane}
            {showDetail && (
              <Box sx={isDesktop ? { position: "sticky", top: 8 } : undefined}>{detailPanel}</Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* <900: the detail actions live in the fixed bar (FlowActionBar renders
          nothing at >=900, where they are inline in the panel above). */}
      {showDetail && selectedRow && (
        <FlowActionBar>
          <Button variant="outlined" disabled={!dirty || busy} onClick={handleUndo}>
            Undo
          </Button>
          <Button variant="contained" disabled={!dirty || busy} onClick={handleSave}>
            {busy ? "Working…" : "Save"}
          </Button>
          <Button color="warning" variant="outlined" disabled={busy} onClick={handleDelete}>
            Delete
          </Button>
        </FlowActionBar>
      )}

      {/* Mobile "Links" sheet — jump straight to a link's detail. */}
      <Drawer anchor="bottom" open={linksSheet} onClose={() => setLinksSheet(false)}>
        <Box sx={{ p: 2, maxHeight: "78vh", overflowY: "auto" }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" sx={{ flex: 1 }}>
              Word links — {book} {chapter}:{verse}
            </Typography>
            <IconButton aria-label="Close" onClick={() => setLinksSheet(false)} sx={{ minWidth: 44, minHeight: 44 }}>
              <CloseIcon />
            </IconButton>
          </Stack>
          {links.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No word links on this verse yet.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {linkRows.map((r) => (
                <Button
                  key={r.id}
                  variant="outlined"
                  sx={{ justifyContent: "flex-start", textAlign: "start", minHeight: 44 }}
                  onClick={() => {
                    setLinksSheet(false);
                    selectLink(r.id);
                  }}
                >
                  <Box component="span" dir={sourceIsHebrew ? "rtl" : "ltr"} sx={scriptureSx}>
                    {r.quote || "—"}
                  </Box>
                  <Box component="span" sx={{ ml: 1, opacity: 0.7 }}>
                    {r.article || "no article"}
                  </Box>
                </Button>
              ))}
            </Stack>
          )}
        </Box>
      </Drawer>

      {/* Mobile "This verse" read-only context sheet. */}
      <Drawer anchor="bottom" open={verseSheet} onClose={() => setVerseSheet(false)}>
        <Box sx={{ p: 2, maxHeight: "78vh", overflowY: "auto" }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" sx={{ flex: 1 }}>
              This verse — read-only context
            </Typography>
            <IconButton aria-label="Close" onClick={() => setVerseSheet(false)} sx={{ minWidth: 44, minHeight: 44 }}>
              <CloseIcon />
            </IconButton>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            ULT
          </Typography>
          <Typography variant="body2" sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1, mb: 1.5, textAlign: "start" }}>
            {ultPlain ?? <em>ULT verse content isn&rsquo;t available for this verse right now.</em>}
          </Typography>
          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="caption" color="text.secondary">
            UST
          </Typography>
          <Typography variant="body2" sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1, textAlign: "start" }}>
            {ustPlain ?? <em>UST verse content isn&rsquo;t available for this verse right now.</em>}
          </Typography>
        </Box>
      </Drawer>

      <QuoteBuilderPopper
        open={Boolean(qb)}
        anchorEl={qb?.anchor ?? null}
        book={book}
        chapter={chapter}
        verse={verse}
        uhbVerseObjects={uhbVo}
        ultVerseObjects={ultVo}
        ustVerseObjects={ustVo}
        lexiconMap={lexicon}
        selectedKeys={qbKeys}
        onToggleKey={(key) =>
          setQbKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        onSelectKeys={(keys) =>
          setQbKeys((prev) => {
            const next = new Set(prev);
            for (const k of keys) next.add(k);
            return next;
          })
        }
        onCancel={() => setQb(null)}
        onCommit={() => void handleQuoteCommit()}
      />

      {busy && (
        <Box sx={{ position: "fixed", insetBlockStart: 8, insetInlineEnd: 8, zIndex: theme.zIndex.snackbar }}>
          <CircularProgress size={20} />
        </Box>
      )}

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice ?? ""}
      />
    </Stack>
  );
}
