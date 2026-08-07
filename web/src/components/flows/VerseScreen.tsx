// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Verse fidelity overview — "is this verse coherent?" — ported from
// docs/mockups/book-package/verse.html onto the app's real chapter data.
//
// THE ONE DESIGN IDEA (docs/mockups/book-package/README.md): the literal and
// simplified texts are each already aligned to the SAME original words, so they
// can be JOINED on that alignment instead of merely shown side by side. Click a
// word anywhere and the same place lights up in all three texts; an original
// word that no target words render is a hole the join can simply report.
//
// Two modes, exactly as the mockup: Read (three texts as prose) and Audit (one
// row per original word, with what each lane made of it).
//
// WHAT CHANGES FROM THE MOCKUP:
//   - The mockup declared itself desktop-only below 1100px. That is a defect to
//     inherit, not a decision: here the detail area moves below the text on the
//     narrow bands (system bands only — tablet=560, md=900) and every part
//     stays reachable.
//   - Article prose (tA / tW) is not inlined. The mockup carried a build-time
//     snapshot of en_ta / en_tw; the app has its own Door43-backed viewer, so
//     the detail pane links there instead of shipping a second copy.
//   - Nothing here writes. This is a reading and checking surface; the flags
//     are observations computed from the alignment, never stored statuses and
//     never verdicts — a word the simplified text does not render is often
//     correct.
//
// `me` / `onNavigate` arrive with the shared flow-screen contract; verse
// movement stays on this screen's own hash route, so neither is read here.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { alpha, useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { FlowNav } from "./FlowNav";
import { ORIGINAL_FONT_STACK, VerseDetailPane, type VerseSelection } from "./VerseDetailPane";
import {
  buildLane,
  buildResources,
  coherence,
  collectOriginalWords,
  laneTextFor,
  type CoherenceFlag,
  type LaneModel,
  type OriginalWord,
  type ResourceItem,
} from "./VerseSpineModel";
import type { FlowScreenContext } from "./types";

import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { VerseDto } from "../../sync/api";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionLabel } from "../../lib/versionLabels";
import { buildVerseIndex, noteCoveredVerses } from "../../lib/verseRange";

export interface VerseScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

type Mode = "read" | "audit";

function verseObjectsOf(dto: VerseDto | undefined | null): unknown[] | null {
  const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return Array.isArray(vo) ? vo : null;
}

function activeGroupIds(lane: LaneModel, positions: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const p of positions) {
    for (const r of lane.byPosition.get(p) ?? []) out.add(r.groupId);
  }
  return out;
}

export default function VerseScreen({ role, book, chapter, verse }: VerseScreenProps) {
  const theme = useTheme();
  // System bands only (web/src/lib/layoutBands.ts): tablet=560, md=900.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const isTablet = useMediaQuery(theme.breakpoints.up("tablet"));

  const { status, data, error, refetch } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  const [mode, setMode] = useState<Mode>("read");
  const [selection, setSelection] = useState<VerseSelection | null>(null);

  // A selection names words of THIS verse; stepping verses invalidates it.
  useEffect(() => {
    setSelection(null);
  }, [book, chapter, verse]);

  const sourceLane = isHebrewBook(book) ? "UHB" : "UGNT";
  const rtl = sourceLane === "UHB";
  const originalLabel = versionLabel(projectConfig, sourceLane);
  const litLabel = versionLabel(projectConfig, "ULT");
  const simLabel = versionLabel(projectConfig, "UST");

  const sourceIndex = useMemo(
    () => buildVerseIndex(data?.verses?.[sourceLane]),
    [data, sourceLane],
  );
  const litIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data]);
  const simIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data]);

  const sourceVO = useMemo(() => verseObjectsOf(sourceIndex[verse]), [sourceIndex, verse]);
  const words = useMemo(() => collectOriginalWords(sourceVO), [sourceVO]);

  const lit = useMemo(
    () => buildLane("ULT", verseObjectsOf(litIndex[verse]), sourceVO, words),
    [litIndex, verse, sourceVO, words],
  );
  const sim = useMemo(
    () => buildLane("UST", verseObjectsOf(simIndex[verse]), sourceVO, words),
    [simIndex, verse, sourceVO, words],
  );

  const resources = useMemo(() => {
    if (!data) return [] as ResourceItem[];
    const here = (row: { verse: number; ref_raw?: string | null }) =>
      noteCoveredVerses(row).includes(verse);
    return buildResources(
      data.tn.filter((r) => here(r) && !r.trashed_at),
      data.twl.filter(here),
      data.tq.filter(here),
      sourceVO,
      words,
    );
  }, [data, verse, sourceVO, words]);

  const flags = useMemo(
    () => coherence(words, lit, sim, resources),
    [words, lit, sim, resources],
  );

  const strongs = useMemo(
    () => [...new Set(words.map((w) => w.strong).filter(Boolean))],
    [words],
  );
  const lexicon = useLexicon(strongs);

  // Verse list for the stepper + picker. The source lane anchors "which verses
  // exist" (it is present even when a target lane is mid-replacement); ULT is
  // the fallback.
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);

  const go = useCallback(
    (delta: number) => {
      if (verseNums.length === 0) return;
      const i = verseNums.indexOf(verse);
      const from = i >= 0 ? i : 0;
      const next = Math.max(0, Math.min(verseNums.length - 1, from + delta));
      if (verseNums[next] === verse) return;
      location.hash = `#/verse/${book}/${chapter}/${verseNums[next]}`;
    },
    [verseNums, verse, book, chapter],
  );

  // ← / → step verses, r / a switch mode, Esc clears — the mockup's keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      // MUI Select renders its trigger as a div[role="combobox"] (not a real
      // <select>) and its open popper as role="listbox"/"option" — neither is
      // caught by the tag check above.
      if (el?.closest('[role="combobox"], [role="listbox"], [role="option"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "Escape") {
        setSelection(null);
      } else if (e.key === "r" || e.key === "a") {
        setMode(e.key === "a" ? "audit" : "read");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // --- selection → highlight sets ------------------------------------------
  const selectedPositions = useMemo(() => {
    if (!selection) return new Set<number>();
    if (selection.kind === "word") return new Set(selection.positions);
    const item = resources.find((r) => r.key === selection.key);
    return new Set(item?.positions ?? []);
  }, [selection, resources]);

  const litOn = useMemo(() => activeGroupIds(lit, selectedPositions), [lit, selectedPositions]);
  const simOn = useMemo(() => activeGroupIds(sim, selectedPositions), [sim, selectedPositions]);

  // Words carrying a note or a term link get a quiet underline, so the reader
  // can see where the helps attach before clicking anything.
  const markedPositions = useMemo(() => {
    const s = new Set<number>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) s.add(p);
    }
    return s;
  }, [resources]);

  const selectWord = useCallback((positions: number[]) => {
    setSelection(positions.length ? { kind: "word", positions } : null);
  }, []);

  const selectGroup = useCallback(
    (lane: LaneModel, groupId: string | null) => {
      if (!groupId) {
        // A supplied word — no original behind it, so nothing to anchor to.
        setSelection(null);
        return;
      }
      selectWord(lane.positionsByGroup.get(groupId) ?? []);
    },
    [selectWord],
  );

  // --- states ---------------------------------------------------------------
  const refLabel = `${book} ${chapter}:${verse}`;

  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        paddingBlock: 1,
        paddingInline: { xs: 1.5, tablet: 2.5 },
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <IconButton
        aria-label="Previous verse"
        title="Previous verse (←)"
        size="small"
        onClick={() => go(-1)}
        disabled={verseNums.length === 0 || verse <= verseNums[0]}
        sx={{ minInlineSize: 32, minBlockSize: 32 }}
      >
        <ChevronLeftIcon fontSize="small" />
      </IconButton>
      <Typography
        component="span"
        sx={{ fontWeight: 700, fontSize: "1.05rem", fontVariantNumeric: "tabular-nums" }}
      >
        {refLabel}
      </Typography>
      <IconButton
        aria-label="Next verse"
        title="Next verse (→)"
        size="small"
        onClick={() => go(1)}
        disabled={verseNums.length === 0 || verse >= verseNums[verseNums.length - 1]}
        sx={{ minInlineSize: 32, minBlockSize: 32 }}
      >
        <ChevronRightIcon fontSize="small" />
      </IconButton>
      <Select
        size="small"
        value={verseNums.includes(verse) ? String(verse) : ""}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (v) location.hash = `#/verse/${book}/${chapter}/${v}`;
        }}
        displayEmpty
        inputProps={{ "aria-label": "Go to verse" }}
        sx={{ fontSize: "0.82rem", "& .MuiSelect-select": { paddingBlock: 0.5 } }}
      >
        {verseNums.length === 0 && (
          <MenuItem value="">
            <em>no verses loaded</em>
          </MenuItem>
        )}
        {verseNums.map((v) => (
          <MenuItem key={v} value={String(v)}>
            {book} {chapter}:{v}
          </MenuItem>
        ))}
      </Select>

      <Box sx={{ flex: 1 }} />

      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_e, v) => v && setMode(v as Mode)}
        aria-label="View"
      >
        <ToggleButton value="read" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
          Read
        </ToggleButton>
        <ToggleButton value="audit" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
          Audit
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );

  const modeLine = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        flexWrap: "wrap",
        paddingBlock: 1,
        paddingInline: { xs: 1.5, tablet: 2.5 },
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem" }}>
        {mode === "read"
          ? "Read the verse three ways. Click any word to see what the other texts do with it."
          : "One row per original word: what the literal text made of it, and what the simplified text made of it."}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <FlagRow flags={flags} onPick={(f) => {
        if (!f.positions.length) return;
        setMode("audit");
        selectWord(f.positions);
      }} />
    </Box>
  );

  let body: ReactNode;
  if (status === "loading" || status === "retrying" || (status === "idle" && !data)) {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Skeleton variant="text" width={180} height={22} />
        <Skeleton variant="rectangular" height={72} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
      </Box>
    );
  } else if (status === "error") {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        >
          {book} {chapter} could not be loaded{error ? ` (${error})` : ""}.
        </Alert>
      </Box>
    );
  } else {
    const textColumn = (
      <Box
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.5 },
          paddingBlockEnd: 5,
        }}
      >
        {words.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            No {originalLabel} text is loaded for {refLabel} in this workspace, so nothing can be
            anchored to original words. The resources below still list what exists.
          </Alert>
        )}
        {mode === "read" ? (
          <ReadMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            originalLabel={originalLabel}
            rtl={rtl}
            selectedPositions={selectedPositions}
            markedPositions={markedPositions}
            litOn={litOn}
            simOn={simOn}
            onSelectWord={selectWord}
            onSelectGroup={selectGroup}
          />
        ) : (
          <AuditMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            resources={resources}
            rtl={rtl}
            compact={!isTablet}
            selectedPositions={selectedPositions}
            onSelectWord={selectWord}
          />
        )}
        <ResourceList
          resources={resources}
          selection={selection}
          rtl={rtl}
          onSelect={setSelection}
        />
      </Box>
    );

    const detailColumn = (
      <Box
        component="aside"
        aria-label="Detail"
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          bgcolor: "background.paper",
          borderInlineStart: isDesktop ? "1px solid" : "none",
          borderBlockStart: isDesktop ? "none" : "1px solid",
          borderColor: "divider",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.25 },
          paddingBlockEnd: 5,
        }}
      >
        <VerseDetailPane
          refLabel={refLabel}
          selection={selection}
          words={words}
          lit={lit}
          sim={sim}
          litLabel={litLabel}
          simLabel={simLabel}
          originalLabel={originalLabel}
          resources={resources}
          lexicon={lexicon}
          rtl={rtl}
          onSelect={setSelection}
        />
      </Box>
    );

    body = isDesktop ? (
      <Box
        component="main"
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 440px",
          minBlockSize: 520,
          blockSize: "calc(100dvh - 200px)",
        }}
      >
        {textColumn}
        {detailColumn}
      </Box>
    ) : (
      <Box component="main">
        {textColumn}
        {detailColumn}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minBlockSize: "100%" }}>
      <FlowNav current="verse" book={book} chapter={chapter} verse={verse} role={role} />
      {header}
      {modeLine}
      {body}
      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ paddingBlock: 2, paddingInline: { xs: 1.5, tablet: 2.5 }, maxInlineSize: 900 }}
      >
        Nothing on this screen writes. The observations above are computed from the alignment in
        this workspace&rsquo;s own verse data — they are not stored statuses and not verdicts: an
        original word the simplified text does not render is often correct.
      </Typography>
    </Box>
  );
}

// ─── flags ──────────────────────────────────────────────────────────────────

function FlagRow({
  flags,
  onPick,
}: {
  flags: CoherenceFlag[];
  onPick: (f: CoherenceFlag) => void;
}) {
  const theme = useTheme();
  if (flags.length === 0) return null;
  const paint = (level: CoherenceFlag["level"]) => {
    if (level === "ok") return { bg: theme.palette.flows.ok.soft, fg: theme.palette.flows.ok.ink };
    if (level === "attention")
      return { bg: theme.palette.flows.warn.soft, fg: theme.palette.flows.warn.ink };
    return {
      bg: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18),
      fg: theme.palette.mode === "dark" ? theme.palette.primary.light : theme.palette.primary.dark,
    };
  };
  return (
    <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
      {flags.map((f) => {
        const { bg, fg } = paint(f.level);
        const clickable = f.positions.length > 0;
        return (
          <Tooltip key={f.id} title={f.detail}>
            <Box
              component="button"
              type="button"
              onClick={() => onPick(f)}
              aria-disabled={!clickable}
              sx={{
                appearance: "none",
                border: 0,
                font: "inherit",
                fontSize: "0.72rem",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.625,
                minBlockSize: 24,
                paddingBlock: 0.375,
                paddingInline: 1.125,
                borderRadius: 999,
                bgcolor: bg,
                color: fg,
                cursor: clickable ? "pointer" : "default",
                textAlign: "start",
              }}
            >
              {f.level === "ok" ? `✓ ${f.label}` : f.label}
              {clickable ? ` · ${f.positions.length}` : ""}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

// ─── read mode ──────────────────────────────────────────────────────────────

function LaneLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
        marginBlockEnd: 0.75,
      }}
    >
      {children}
    </Typography>
  );
}

function ReadMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  originalLabel,
  rtl,
  selectedPositions,
  markedPositions,
  litOn,
  simOn,
  onSelectWord,
  onSelectGroup,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  rtl: boolean;
  selectedPositions: Set<number>;
  markedPositions: Set<number>;
  litOn: Set<string>;
  simOn: Set<string>;
  onSelectWord: (positions: number[]) => void;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  return (
    <Box sx={{ marginBlockEnd: 3 }}>
      <LaneLabel>Original · {originalLabel}</LaneLabel>
      {words.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
          No original-language words for this verse.
        </Typography>
      ) : (
        <Box
          dir={rtl ? "rtl" : "ltr"}
          sx={{
            fontFamily: ORIGINAL_FONT_STACK,
            fontSize: "1.55rem",
            lineHeight: 2.05,
            textAlign: "start",
            marginBlockEnd: 2.5,
          }}
        >
          {words.map((w) => (
            <Box
              key={w.position}
              component="button"
              type="button"
              onClick={() => onSelectWord([w.position])}
              title={[w.lemma, w.glosses.join(" · ")].filter(Boolean).join("  ·  ")}
              sx={{
                appearance: "none",
                border: 0,
                background: selectedPositions.has(w.position) ? hl : "transparent",
                boxShadow: selectedPositions.has(w.position)
                  ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                  : markedPositions.has(w.position)
                    ? `inset 0 -2px 0 ${theme.palette.flows.ok.main}`
                    : "none",
                font: "inherit",
                color: "text.primary",
                cursor: "pointer",
                borderRadius: 1,
                paddingInline: 0.375,
                marginInlineEnd: 0.5,
                "&:hover, &:focus-visible": { bgcolor: "action.hover" },
              }}
            >
              {w.text}
            </Box>
          ))}
        </Box>
      )}

      <LaneLabel>Literal · {litLabel}</LaneLabel>
      <Prose lane={lit} on={litOn} onSelectGroup={onSelectGroup} laneName={litLabel} />

      <LaneLabel>Simplified · {simLabel}</LaneLabel>
      <Prose lane={sim} on={simOn} onSelectGroup={onSelectGroup} laneName={simLabel} />
    </Box>
  );
}

function Prose({
  lane,
  on,
  laneName,
  onSelectGroup,
}: {
  lane: LaneModel;
  on: Set<string>;
  laneName: string;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  if (!lane.present) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        No {laneName} text exists for this verse in this workspace. That is normal in a
        translation-mode workspace whose target lanes have not been drafted yet.
      </Typography>
    );
  }
  if (lane.prose.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        The {laneName} verse row exists but carries no text.
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.06rem",
        lineHeight: 1.62,
        textAlign: "start",
        marginBlockEnd: 2.5,
      }}
    >
      {lane.prose.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={`t${i}`}>{tok.text}</span>
        ) : (
          <Box
            key={tok.id}
            component="button"
            type="button"
            onClick={() => onSelectGroup(lane, tok.groupId)}
            sx={{
              appearance: "none",
              border: 0,
              font: "inherit",
              // A word with no original behind it — supplied by the
              // translator. Marked quietly, because it is information, not a
              // fault.
              color: tok.groupId ? "text.primary" : "text.secondary",
              background: tok.groupId && on.has(tok.groupId) ? hl : "transparent",
              boxShadow:
                tok.groupId && on.has(tok.groupId)
                  ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                  : "none",
              borderRadius: 0.5,
              padding: 0,
              cursor: "pointer",
              "&:hover, &:focus-visible": { bgcolor: "action.hover" },
            }}
          >
            {tok.text}
          </Box>
        ),
      )}
    </Box>
  );
}

// ─── audit mode ─────────────────────────────────────────────────────────────

function AuditMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  resources,
  rtl,
  compact,
  selectedPositions,
  onSelectWord,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  resources: ResourceItem[];
  rtl: boolean;
  compact: boolean;
  selectedPositions: Set<number>;
  onSelectWord: (positions: number[]) => void;
}) {
  const theme = useTheme();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  const notesAt = useMemo(() => {
    const m = new Map<number, ResourceItem[]>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) {
        const list = m.get(p);
        if (list) list.push(r);
        else m.set(p, [r]);
      }
    }
    return m;
  }, [resources]);

  if (words.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        The spine is one row per original word; without the original text there are no rows to
        show.
      </Typography>
    );
  }

  const th = {
    textAlign: "start" as const,
    fontSize: "0.66rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: theme.palette.text.secondary,
    paddingBlock: 0.75,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    position: "sticky" as const,
    insetBlockStart: 0,
    background: theme.palette.background.default,
  };
  const td = {
    paddingBlock: 0.875,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    verticalAlign: "baseline" as const,
  };

  let prevLit: string | null = null;
  let prevSim: string | null = null;

  const cell = (text: string, prev: string | null) => {
    if (!text) {
      return (
        <Box
          component="span"
          sx={{
            fontSize: "0.72rem",
            fontWeight: 600,
            color: theme.palette.flows.warn.ink,
            bgcolor: theme.palette.flows.warn.soft,
            borderRadius: 999,
            paddingBlock: "1px",
            paddingInline: 1,
          }}
        >
          not rendered
        </Box>
      );
    }
    // A rendering repeated from the row above is a restructure, not a second
    // translation — say so instead of printing the same phrase twice.
    if (text === prev) {
      return (
        <Box component="span" sx={{ fontSize: "0.7rem", fontStyle: "italic", color: "text.secondary" }}>
          ↑ same phrase
        </Box>
      );
    }
    return text;
  };

  return (
    <Box sx={{ marginBlockEnd: 3, overflowX: "auto" }}>
      <Box component="table" sx={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr>
            <Box component="th" sx={{ ...th, inlineSize: "24%" }}>
              Original
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "30%" }}>
              Literal · {litLabel}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "34%" }}>
              Simplified · {simLabel}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "12%" }} aria-label="Notes and terms" />
          </tr>
        </thead>
        <tbody>
          {words.map((w) => {
            const litText = lit.present ? laneTextFor(lit, w.position) : "";
            const simText = sim.present ? laneTextFor(sim, w.position) : "";
            const litCell = lit.present ? cell(litText, prevLit) : "—";
            const simCell = sim.present ? cell(simText, prevSim) : "—";
            prevLit = litText;
            prevSim = simText;
            const marks = notesAt.get(w.position) ?? [];
            const selected = selectedPositions.has(w.position);
            return (
              <Box
                component="tr"
                key={w.position}
                onClick={() => onSelectWord([w.position])}
                aria-selected={selected}
                sx={{
                  cursor: "pointer",
                  "& > td": { background: selected ? hl : "transparent" },
                  "&:hover > td": { background: selected ? hl : theme.palette.action.hover },
                }}
              >
                <Box
                  component="td"
                  dir={rtl ? "rtl" : "ltr"}
                  sx={{
                    ...td,
                    fontFamily: ORIGINAL_FONT_STACK,
                    fontSize: "1.18rem",
                    lineHeight: 1.7,
                    textAlign: "start",
                  }}
                >
                  {w.text}
                </Box>
                <Box component="td" sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK }}>
                  {litCell}
                </Box>
                <Box
                  component="td"
                  sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK, color: "text.secondary" }}
                >
                  {simCell}
                </Box>
                <Box component="td" sx={{ ...td, textAlign: "end", whiteSpace: "nowrap" }}>
                  {compact
                    ? marks.length > 0 && (
                        <Box component="span" sx={{ fontSize: "0.66rem", color: "text.secondary" }}>
                          {marks.length}
                        </Box>
                      )
                    : marks.map((r) => (
                        <Box
                          key={r.key}
                          component="span"
                          title={r.tag}
                          sx={{
                            display: "inline-block",
                            fontSize: "0.66rem",
                            fontWeight: 700,
                            paddingBlock: "1px",
                            paddingInline: 0.75,
                            borderRadius: 999,
                            marginInlineStart: 0.5,
                            bgcolor:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.soft
                                : alpha(
                                    theme.palette.primary.main,
                                    theme.palette.mode === "dark" ? 0.26 : 0.18,
                                  ),
                            color:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.ink
                                : theme.palette.mode === "dark"
                                  ? theme.palette.primary.light
                                  : theme.palette.primary.dark,
                          }}
                        >
                          {r.kind === "twl" ? "W" : "N"}
                        </Box>
                      ))}
                </Box>
              </Box>
            );
          })}
        </tbody>
      </Box>

      {(lit.supplied.length > 0 || sim.supplied.length > 0) && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem", mt: 1.25 }}>
          Supplied, with no original word behind it —{" "}
          {lit.supplied.length > 0 && `literal: ${lit.supplied.join(" · ")}`}
          {lit.supplied.length > 0 && sim.supplied.length > 0 && " · "}
          {sim.supplied.length > 0 && `simplified: ${sim.supplied.join(" · ")}`}
        </Typography>
      )}
    </Box>
  );
}

// ─── resource list ──────────────────────────────────────────────────────────

function ResourceList({
  resources,
  selection,
  rtl,
  onSelect,
}: {
  resources: ResourceItem[];
  selection: VerseSelection | null;
  rtl: boolean;
  onSelect: (sel: VerseSelection) => void;
}) {
  const theme = useTheme();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);
  const currentKey = selection?.kind === "resource" ? selection.key : null;

  const groups: Array<{ kind: ResourceItem["kind"]; label: string }> = [
    { kind: "tn", label: "Notes" },
    { kind: "twl", label: "Word links" },
    { kind: "tq", label: "Questions" },
  ];

  if (resources.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.82rem", mt: 3 }}>
        No notes, word links or questions exist for this verse.
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 3 }}>
      {groups.map(({ kind, label }) => {
        const list = resources.filter((r) => r.kind === kind);
        if (list.length === 0) return null;
        return (
          <Box key={kind} sx={{ marginBlockEnd: 2.5 }}>
            <LaneLabel>
              {label} · {list.length}
            </LaneLabel>
            {list.map((r) => (
              <Box
                key={r.key}
                component="button"
                type="button"
                onClick={() => onSelect({ kind: "resource", key: r.key })}
                aria-current={currentKey === r.key}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr) auto",
                  gap: 1.25,
                  alignItems: "baseline",
                  inlineSize: "100%",
                  textAlign: "start",
                  appearance: "none",
                  border: 0,
                  borderBlockEnd: "1px solid",
                  borderColor: "divider",
                  background: currentKey === r.key ? hl : "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: "0.85rem",
                  minBlockSize: 34,
                  paddingBlock: 0.875,
                  paddingInline: 1,
                  cursor: "pointer",
                  "&:hover, &:focus-visible": {
                    bgcolor: currentKey === r.key ? undefined : "action.hover",
                  },
                }}
              >
                <Box
                  component="span"
                  sx={{
                    fontSize: "0.66rem",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    minInlineSize: 46,
                  }}
                >
                  {r.tag}
                </Box>
                <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.quote && (
                    <Box
                      component="span"
                      dir={rtl ? "rtl" : "ltr"}
                      sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1rem" }}
                    >
                      {r.quote.replace(/&/g, " … ")}{" "}
                    </Box>
                  )}
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {r.summary}
                  </Box>
                </Box>
                <Box
                  component="span"
                  sx={{ fontSize: "0.72rem", color: theme.palette.flows.warn.ink }}
                >
                  {r.kind !== "tq" && r.quote && r.positions.length === 0
                    ? "quote not anchored"
                    : ""}
                </Box>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
