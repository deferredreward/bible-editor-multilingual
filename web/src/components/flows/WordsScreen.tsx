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
import { useTranslation } from "react-i18next";
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
import { useProjectConfig } from "../../hooks/useProjectConfig";
import { useTwlFilters } from "../../hooks/useTwlFilters";
import { useLexicon } from "../../hooks/useLexicon";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { drafts, rowKey } from "../../sync/drafts";
import {
  api,
  ApiError,
  type ChapterLockedBody,
  type TwlRow,
  type TwlSuggestion,
  type VerseDto,
} from "../../sync/api";
import { canonicalTwlOrder } from "../../lib/twlCanonicalOrder";
import { resolveSpanToSource } from "../../lib/twlResolve";
import { buildQuoteFromSelection, collectTargetTokens, selectionFromQuote } from "../../lib/quoteBuilder";
import type { HighlightKey } from "../../lib/highlight";
import { nfc } from "../../lib/hebrew";
import { isHebrewBook } from "../../lib/sourceSearch";
import { buildVerseIndex, formatVerseLabel, isRangeRow } from "../../lib/verseRange";
import { versionLabel } from "../../lib/versionLabels";
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

// Non-null verseObjects array for a resolved verse row, or null when the lane
// has no content for it (a lane pending replacement is omitted from the
// payload). Callers pass a row resolved through `buildVerseIndex`, never a raw
// `verses[bv][n]` lookup — see the `verseIndexes` memo below.
function verseObjectsOf(dto: VerseDto | undefined | null): unknown[] | null {
  const content = dto?.content as { verseObjects?: unknown[] } | null | undefined;
  const vo = content?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

// `me` / `onNavigate` come with the shared flow-screen contract but this screen
// needs neither: identity is not shown here, and verse navigation moves the
// hash (#/words/…) so the user stays on this screen rather than jumping to the
// editor. Both are left undestructured rather than accepted-and-ignored.
export default function WordsScreen({ role, book, chapter, verse }: WordsScreenProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md")); // >=900: list + detail side by side
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560: table rather than cards

  const { status, data, applyLocalRowPatch, applyLocalRowDelete, applyLocalRowInsert } = useChapter(
    book,
    chapter,
  );
  const catalogs = useCatalogs();
  const twlFilters = useTwlFilters(book);
  const projectConfig = useProjectConfig();

  // Viewers must not be able to start a write. The outbox no-ops for a viewer,
  // so an ungated Save applies the patch locally, moves the baseline and says
  // "queued for save" while nothing ever leaves the browser. Same gate
  // ScriptureScreen uses.
  const canEdit = role === "admin" || role === "editor";

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

  // Every per-verse row read on this screen goes through buildVerseIndex. A
  // bridged row (`\v 15-16`) is keyed by verse_start only, so a raw
  // `verses[bv][16]` lookup returns nothing — which made this screen claim "No
  // ULT text exists for this verse" and permanently disable "+ Add link" on a
  // verse whose text is right there in the payload. Same fix ScriptureScreen
  // carries; see web/src/lib/verseRange.ts.
  const verseIndexes = useMemo<Record<string, Record<number, VerseDto>>>(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    for (const bv of Object.keys(data?.verses ?? {})) {
      out[bv] = buildVerseIndex(data?.verses?.[bv]);
    }
    return out;
  }, [data]);

  const uhbRow = verseIndexes[sourceLane]?.[verse] ?? null;
  const ultRow = verseIndexes.ULT?.[verse] ?? null;
  const ustRow = verseIndexes.UST?.[verse] ?? null;

  const uhbVo = useMemo(() => verseObjectsOf(uhbRow), [uhbRow]);
  const ultVo = useMemo(() => verseObjectsOf(ultRow), [ultRow]);
  const ustVo = useMemo(() => verseObjectsOf(ustRow), [ustRow]);
  const ultPlain = ultRow?.plain_text ?? null;
  const ustPlain = ustRow?.plain_text ?? null;

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

  // `op` is an identity, never a translated string: it selects the message key
  // so each operation gets its own natural sentence rather than an English verb
  // interpolated into a translated frame.
  function reportError(op: "create" | "add", err: unknown) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | undefined;
      if (err.status === 409 && body?.error === "chapter_locked") {
        setLock(err.body as ChapterLockedBody);
        setNotice(t(`flowVerse.words.error.${op}.locked`));
        return;
      }
      setNotice(
        t(`flowVerse.words.error.${op}.http`, {
          status: err.status,
          detail: body?.error ? ` ${body.error}` : "",
        }),
      );
      return;
    }
    setNotice(t(`flowVerse.words.error.${op}.failed`));
  }

  async function handleSave() {
    if (!canEdit) {
      setNotice(t("flowVerse.words.viewOnlySave"));
      return;
    }
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
      setNotice(t("flowVerse.words.queuedForSave"));
    } finally {
      setBusy(false);
    }
  }

  function handleUndo() {
    if (!selectedRow || !dirty) return;
    setForm(baseline);
    setNotice(t("flowVerse.words.reverted"));
  }

  async function handleDelete() {
    if (!canEdit) {
      setNotice(t("flowVerse.words.viewOnlyDelete"));
      return;
    }
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
      setNotice(t("flowVerse.words.deleted"));
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
    if (!canEdit) {
      setQb(null);
      setNotice(t("flowVerse.words.viewOnlyChange"));
      return;
    }
    const built = buildQuoteFromSelection(uhbVo, qbKeys);
    if (!built) return;
    if (qb.mode === "edit") {
      setForm((f) => ({ ...f, quote: built.quote, occurrence: String(built.occurrence) }));
      setQb(null);
      setNotice(t("flowVerse.words.quoteUpdated"));
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
      setNotice(t("flowVerse.words.created"));
    } catch (err) {
      reportError("create", err);
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
      if (!canEdit) {
        setNotice(t("flowVerse.words.viewOnlyAdd"));
        return;
      }
      const resolved = suggestionQuote(s);
      if (!resolved || !resolved.orig_words) {
        setNotice(t("flowVerse.words.cantResolve", { text: s.matchedText }));
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
        setNotice(t("flowVerse.words.addedFromSuggestion"));
      } catch (err) {
        reportError("add", err);
      }
    },
    // nextSortOrder / reportError close over state that changes each render;
    // recreating the callback per render is cheaper than memoizing them all.
    // `t` is deliberately NOT a dep either: react-i18next hands out a new `t`
    // identity on every language change, and this callback creates a row on the
    // server — re-identifying it on a language switch buys nothing and invites
    // re-runs in any future effect that depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, suggestionQuote, book, chapter, verse, applyLocalRowInsert, links],
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

  // ULT is the "lit" lane in ProjectConfig.laneState. `pendingTarget` is the
  // only evidence this screen has that a replacement is actually underway;
  // without it, an empty ULT lane is simply undrafted, and saying "awaiting
  // replacement" would be a guess.
  const ultLanePending = Boolean(projectConfig?.laneState?.lit?.pendingTarget);

  function targetContext(quote: string) {
    if (!ultVo) {
      return ultLanePending ? (
        <em>{t("flowVerse.words.ultPending", { lane: versionLabel(projectConfig, "ULT") })}</em>
      ) : (
        <em>{t("flowScripture.laneNoText", { lane: versionLabel(projectConfig, "ULT") })}</em>
      );
    }
    const tokens = collectTargetTokens(ultVo);
    if (tokens.length === 0) return <em>{t("flowVerse.words.noAlignmentData")}</em>;
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
          <em>{t("flowVerse.words.noMilestoneMatch", { quote })}</em>
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
            {t("flowVerse.words.backToLinks")}
          </Button>
        )}
        <Typography
          variant="overline"
          sx={{ color: "text.secondary", fontWeight: 700, letterSpacing: "0.07em" }}
        >
          {t("flowVerse.words.editTitle")}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {t("flowScripture.ofTotal", { n: selectedIndex + 1, total: links.length })}
        </Typography>
      </Stack>

      <Box sx={{ p: 2 }}>
        <Typography
          variant="caption"
          component="div"
          sx={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" }}
        >
          {t("flowVerse.words.quoteOriginal")}
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
            {t("flowVerse.words.buildFromSource")}
          </Button>
        </Stack>

        <TextField
          label={t("flowVerse.words.occurrenceLabel")}
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
              // "kt/god" is a tW article SLUG, shown as the input's example —
              // it is an id, not prose, so it stays as-is in every language.
              <TextField
                {...params}
                size="small"
                label={t("flowVerse.words.articleLinkLabel")}
                placeholder="kt/god"
              />
            )}
          />
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 0.5, flexWrap: "wrap" }}>
            {form.article ? (
              <Box
                component="a"
                href={`#/articles/tw/${encodeURIComponent(form.article)}`}
                sx={{ fontSize: "0.8rem", fontWeight: 600, color: "primary.main" }}
              >
                {t("flowVerse.words.readArticleArrow")}
              </Box>
            ) : (
              <Typography variant="caption" color="text.secondary">
                {t("flowVerse.words.noArticleLinked")}
              </Typography>
            )}
            {articleOptions.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
                {t("flowVerse.words.catalogEmpty")}
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
            {t("flowVerse.words.inTarget", { lane: versionLabel(projectConfig, "ULT") })}
            {ultRow && isRangeRow(ultRow)
              ? ` ${t("flowVerse.words.versesSuffix", { label: formatVerseLabel(ultRow) })}`
              : ""}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
            {targetContext(form.quote)}
          </Typography>
        </Box>

        {/* Actions live in the FlowActionBar below 900px, inline above it. */}
        {isDesktop && (
          <Stack direction="row" spacing={1} sx={{ mt: 2.5, flexWrap: "wrap" }}>
            <Button variant="outlined" disabled={!dirty || busy} onClick={handleUndo} sx={{ flex: 1, minHeight: 44 }}>
              {t("common.undo")}
            </Button>
            <Button variant="contained" disabled={!canEdit || !dirty || busy} onClick={handleSave} sx={{ flex: 1, minHeight: 44 }}>
              {busy ? t("flowVerse.words.working") : t("common.save")}
            </Button>
            <Button color="warning" variant="outlined" disabled={!canEdit || busy} onClick={handleDelete} sx={{ flex: 1, minHeight: 44 }}>
              {t("common.delete")}
            </Button>
          </Stack>
        )}

        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          {t("flowVerse.words.reorderOff")}
        </Typography>
      </Box>
    </Box>
  ) : (
    <Alert severity="info">
      {t("flowVerse.words.noneSelected")}{" "}
      {links.length === 0 ? t("flowVerse.words.noneYetUseAdd") : ""}
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
          {t("flowVerse.words.linkCount", { count: links.length })}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          size="small"
          sx={{ minHeight: 44, borderRadius: 999, fontWeight: 700 }}
          onClick={(e) => openQuoteBuilder("add", e.currentTarget)}
          disabled={!canEdit || busy || !uhbVo}
        >
          {t("flowVerse.words.addLink")}
        </Button>
      </Stack>

      {links.length === 0 ? (
        <Alert severity="info">{t("flowVerse.words.emptyList")}</Alert>
      ) : isTabletUp ? (
        <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 460 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ textAlign: "start" }}>{t("words.quote")}</TableCell>
                <TableCell sx={{ textAlign: "start" }}>{t("flowVerse.words.colOcc")}</TableCell>
                <TableCell sx={{ textAlign: "start" }}>{t("flowVerse.words.colTwLink")}</TableCell>
                <TableCell sx={{ textAlign: "start" }}>{t("flowVerse.words.colArticle")}</TableCell>
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
                  aria-label={t("flowVerse.words.editAria", { quote: r.quote })}
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
                        {t("flowVerse.words.noArticleLinkedShort")}
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
        <Stack spacing={1.25} role="list" aria-label={t("flowVerse.words.listAria")}>
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
                {t("flowVerse.words.cardMeta", {
                  occurrence: r.occurrence,
                  article: r.article || t("flowVerse.words.noArticleLinkedShort"),
                })}
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
        {t("flowVerse.words.noApproveLifecycle")}
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
          <Alert severity="error">{t("flowVerse.words.chapterLoadError", { book, chapter })}</Alert>
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
              aria-label={t("flowScripture.prevVerse")}
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
              aria-label={t("flowScripture.nextVerse")}
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
                  {t("flowVerse.words.linksListBtn")}
                </Button>
                <Button size="small" variant="outlined" sx={{ minHeight: 44 }} onClick={() => setVerseSheet(true)}>
                  {t("flowVerse.words.thisVerseBtn")}
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

          {!canEdit && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t("flowVerse.words.viewOnlyBanner")}
            </Alert>
          )}

          <WordsLexiconStrip
            words={sourceWords}
            rtl={sourceIsHebrew}
            label={sourceIsHebrew ? t("flowTranslate.hebrew") : t("flowTranslate.greek")}
            lexicon={lexicon}
          />

          {uhbRow && isRangeRow(uhbRow) && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t("flowVerse.words.bridgedNotice", {
                label: formatVerseLabel(uhbRow),
                ref: `${chapter}:${verse}`,
              })}
            </Alert>
          )}

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
            {t("common.undo")}
          </Button>
          <Button variant="contained" disabled={!canEdit || !dirty || busy} onClick={handleSave}>
            {busy ? t("flowVerse.words.working") : t("common.save")}
          </Button>
          <Button color="warning" variant="outlined" disabled={!canEdit || busy} onClick={handleDelete}>
            {t("common.delete")}
          </Button>
        </FlowActionBar>
      )}

      {/* Mobile "Links" sheet — jump straight to a link's detail. */}
      <Drawer anchor="bottom" open={linksSheet} onClose={() => setLinksSheet(false)}>
        <Box sx={{ p: 2, maxHeight: "78vh", overflowY: "auto" }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" sx={{ flex: 1 }}>
              {t("flowVerse.words.sheetTitle", { ref: `${book} ${chapter}:${verse}` })}
            </Typography>
            <IconButton aria-label={t("common.close")} onClick={() => setLinksSheet(false)} sx={{ minWidth: 44, minHeight: 44 }}>
              <CloseIcon />
            </IconButton>
          </Stack>
          {links.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t("flowVerse.words.emptyList")}
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
                    {r.article || t("flowVerse.words.noArticleShort")}
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
              {t("flowVerse.words.verseSheetTitle")}
            </Typography>
            <IconButton aria-label={t("common.close")} onClick={() => setVerseSheet(false)} sx={{ minWidth: 44, minHeight: 44 }}>
              <CloseIcon />
            </IconButton>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {versionLabel(projectConfig, "ULT")}
          </Typography>
          <Typography variant="body2" sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1, mb: 1.5, textAlign: "start" }}>
            {ultPlain ?? <em>{t("flowVerse.words.laneUnavailable", { lane: versionLabel(projectConfig, "ULT") })}</em>}
          </Typography>
          <Divider sx={{ mb: 1.5 }} />
          <Typography variant="caption" color="text.secondary">
            {versionLabel(projectConfig, "UST")}
          </Typography>
          <Typography variant="body2" sx={{ bgcolor: "action.hover", borderRadius: 1, p: 1, textAlign: "start" }}>
            {ustPlain ?? <em>{t("flowVerse.words.laneUnavailable", { lane: versionLabel(projectConfig, "UST") })}</em>}
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
