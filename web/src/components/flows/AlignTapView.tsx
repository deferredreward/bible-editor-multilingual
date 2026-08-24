// Tap-to-pair alignment, ported from the #tapView half of
// docs/flows/ui/t4-align.html and the interaction spec in
// docs/flows/04-mobile-alignment.md. Phone-first, keyboard-accessible: every
// step is a discrete button press, so this is also the switch/keyboard mode on
// desktop.
//
// It edits the SAME AlignmentState the drag canvas (AlignmentPanel) edits, via
// the tested primitives in web/src/lib/alignment.ts — moveTargets, clearGroup,
// mergeGroupsToGroups. It never constructs or patches verse JSON; the owner
// (AlignScreen) serializes through serializeAlignment on save.
//
// Two mockup controls are deliberately absent:
//   * "✂ Split words" — the mockup's target chips were whole milestone texts
//     that could hold several words. Here a chip IS one parsed target word
//     (lib/alignment's TargetWord), so there is nothing to split.
//   * the fabricated suggestion queue — the mockup left `state.suggestions`
//     empty because it couldn't turn /api/align/suggest's per-Strong's
//     candidates into pairings. The app can: computeGhosts (shared with the
//     drag canvas and the offline eval) scores them into real source↔target
//     proposals, so the queue here is real or it is empty.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import WrapTextIcon from "@mui/icons-material/WrapText";

import {
  clearGroup,
  mergeGroupsToGroups,
  moveTargets,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "../../lib/alignment";
import type { Ghost } from "../../lib/alignmentSuggest";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import { cardStateGroups, orderDisplayGroups, resolveSourcePos } from "./AlignSourceModel";

type Selection = { side: "source" | "target" | null; ids: string[] };
const NO_SELECTION: Selection = { side: null, ids: [] };

export interface AlignTapViewProps {
  state: AlignmentState;
  onChange: (next: AlignmentState) => void;
  /**
   * False for viewers. Below this component alignmentDrafts.set early-returns
   * and outbox.enqueueVerse no-ops for a viewer, so an ungated view would apply
   * pairings locally and look saved while the work is silently dropped. Every
   * mutation funnels through `commit`, which refuses when this is false.
   */
  canEdit: boolean;
  /** From buildSourceIndexMap(sourceVerse) — card ordering + fused-card identity. */
  sourceIndexMap: Map<string, number>;
  /** Source script direction: Hebrew RTL, Greek LTR. Never a blanket UI flip. */
  sourceRtl: boolean;
  /** Target lane direction, from versionIsRtl(projectConfig, bibleVersion). */
  targetRtl: boolean;
  /** Real suggestions keyed by group id (computeGhosts). Empty map = none. */
  ghosts: Map<string, Ghost>;
  onDismissGhost: (ghost: Ghost) => void;
}

export function AlignTapView({
  state,
  onChange,
  canEdit,
  sourceIndexMap,
  sourceRtl,
  targetRtl,
  ghosts,
  onDismissGhost,
}: AlignTapViewProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  // >=560 matches AlignScreen's own "tablet" band (docs/flows/04-mobile-alignment):
  // the reporter's stated preference is wrap on tablet/desktop, scroll on phone.
  // This is plain component state — deliberately not persisted — so the icon
  // button below just lets someone flip it to compare both while iterating on
  // the "feel" themselves (issue #202).
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet"));
  const [wrapRibbon, setWrapRibbon] = useState(isTabletUp);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  // Suggestions the user stepped past this session. Skipping only hides the
  // card; it never edits the verse. Ghost ids are groupId+text and so are only
  // meaningful for the current verse's parse — AlignScreen therefore mounts
  // this component with a per-verse `key`, which discards this set (and the
  // selection) on every verse change.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const cards = useMemo(
    () => orderDisplayGroups(state, sourceIndexMap),
    [state, sourceIndexMap],
  );
  const sourcePos = useMemo(
    () => (s: SourceWord) => resolveSourcePos(s, sourceIndexMap),
    [sourceIndexMap],
  );

  // Targets not attached to any group, in document order (state.unaligned is
  // already stream-ordered).
  const pool = state.unaligned;
  const totalTargets = useMemo(
    () => state.stream.filter((it) => it.kind === "word").length,
    [state],
  );
  const alignedCount = totalTargets - pool.length;

  const queue = useMemo(
    () => [...ghosts.values()].filter((g) => !skipped.has(ghostId(g))),
    [ghosts, skipped],
  );
  const current = queue[0] ?? null;

  const cardById = useMemo(() => {
    const m = new Map<string, AlignmentGroup>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  // The single choke point for every state-changing action here (attach,
  // unalign, combine, split, accept-suggestion). A viewer's edit is refused at
  // this one place rather than applied locally and quietly lost on save.
  function commit(next: AlignmentState) {
    if (!canEdit) {
      setSelection(NO_SELECTION);
      return;
    }
    if (next !== state) onChange(next);
    setSelection(NO_SELECTION);
  }

  function attach(targetIds: string[], cardId: string) {
    if (targetIds.length === 0) return;
    commit(moveTargets(state, targetIds, `g:${cardId}`));
  }

  function handleTargetTap(tid: string) {
    // Order-forgiving: with exactly one source card selected, tapping a target
    // commits the pairing (mockup's onTargetChipClick).
    if (selection.side === "source") {
      if (selection.ids.length === 1) {
        attach([tid], selection.ids[0]);
        return;
      }
      // >1 source selected means the user is mid-combine; don't guess.
      return;
    }
    setSelection((cur) => toggle(cur, "target", tid));
  }

  function handleCardTap(cardId: string) {
    if (selection.side === "target" && selection.ids.length > 0) {
      attach(selection.ids, cardId);
      return;
    }
    const card = cardById.get(cardId);
    // A combined card is selected alone (its members move together); single
    // words multi-select so they can be combined.
    if (card && card.source.length > 1) {
      setSelection((cur) =>
        cur.side === "source" && cur.ids.length === 1 && cur.ids[0] === cardId
          ? NO_SELECTION
          : { side: "source", ids: [cardId] },
      );
      return;
    }
    setSelection((cur) => toggle(cur, "source", cardId));
  }

  function handleUnalign() {
    if (selection.side !== "target" || selection.ids.length === 0) return;
    commit(moveTargets(state, selection.ids, "u"));
  }

  // Combine ≥2 source cards into one group. Cards fold left-to-right in source
  // order so the merged Hebrew chain reads in verse order; each side resolves
  // to EVERY state group its card collapsed (cardStateGroups), the same
  // resolution AlignmentPanel's card merge uses.
  function handleCombine() {
    if (selection.side !== "source" || selection.ids.length < 2) return;
    const order = cards.map((c) => c.id);
    const ordered = [...selection.ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    let next = state;
    const survivor = ordered[0];
    for (const eaten of ordered.slice(1)) {
      next = mergeGroupsToGroups(
        next,
        cardStateGroups(next, survivor, sourceIndexMap),
        cardStateGroups(next, eaten, sourceIndexMap),
        sourcePos,
      );
    }
    commit(next);
  }

  // Split a combined card back into single-word groups. clearGroup is the
  // library's own split: it detaches the card's targets and re-emits one group
  // per source word, so the translator re-pairs each word explicitly.
  function handleSplit(cardId: string) {
    let next = state;
    for (const gid of cardStateGroups(state, cardId, sourceIndexMap)) {
      next = clearGroup(next, gid);
    }
    commit(next);
  }

  function handleAcceptSuggestion(g: Ghost) {
    commit(moveTargets(state, g.wordIds, `g:${g.groupId}`));
  }

  function jumpToUnaligned() {
    const el = document.querySelector<HTMLElement>('[data-align-unaligned="true"]');
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ inline: "center", block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }

  const ok = theme.palette.flows.ok;
  const warn = theme.palette.flows.warn;

  return (
    <Box sx={{ minWidth: 0 }}>
      {/* ── suggestion queue: real proposals only ─────────────────────── */}
      {current ? (
        <Box
          aria-live="polite"
          sx={{
            border: `1.5px solid ${theme.palette.primary.main}`,
            borderRadius: "12px",
            bgcolor: "background.paper",
            padding: 2,
            marginBlockEnd: 2,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              display: "block",
              fontWeight: 700,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "text.secondary",
              marginBlockEnd: 1,
            }}
          >
            {t("flowAlign.tap.suggestionOf", { total: queue.length })}
          </Typography>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.25,
              flexWrap: "wrap",
              marginBlockEnd: 1.5,
            }}
          >
            <Box
              component="span"
              dir={sourceRtl ? "rtl" : "ltr"}
              sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: 18 }}
            >
              {sourceTextOf(cardById.get(current.groupId))}
            </Box>
            <Box component="span" aria-hidden="true" sx={{ color: "primary.main", fontWeight: 700 }}>
              ↔
            </Box>
            <Box
              component="span"
              dir={targetRtl ? "rtl" : "ltr"}
              sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: 17, fontWeight: 600 }}
            >
              {current.text}
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              onClick={() => handleAcceptSuggestion(current)}
              disabled={!canEdit}
              sx={{ flex: 1, minHeight: 44, fontWeight: 700 }}
            >
              {t("flowAlign.tap.accept")}
            </Button>
            <Button
              variant="outlined"
              onClick={() => {
                setSkipped((prev) => new Set(prev).add(ghostId(current)));
                onDismissGhost(current);
              }}
              sx={{ flex: 1, minHeight: 44, fontWeight: 700 }}
            >
              {t("flowAlign.tap.skip")}
            </Button>
          </Box>
        </Box>
      ) : (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            bgcolor: "action.hover",
            border: "1px dashed",
            borderColor: "divider",
            borderRadius: "9px",
            paddingBlock: 1.25,
            paddingInline: 1.75,
            marginBlockEnd: 2,
          }}
        >
          {ghosts.size === 0
            ? t("flowAlign.tap.noSuggestions")
            : t("flowAlign.tap.allReviewed")}
        </Typography>
      )}

      {/* ── toolbar ───────────────────────────────────────────────────── */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          flexWrap: "wrap",
          marginBlockEnd: 1.5,
        }}
      >
        <Box
          component="span"
          sx={{
            fontSize: "0.78rem",
            fontWeight: 700,
            color: ok.ink,
            bgcolor: ok.soft,
            borderRadius: 999,
            paddingBlock: 0.5,
            paddingInline: 1.25,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {t("flowAlign.tap.alignedOf", { aligned: alignedCount, total: totalTargets })}
        </Box>
        <Button
          onClick={jumpToUnaligned}
          sx={{
            minHeight: 44,
            borderRadius: 999,
            border: `1px solid ${warn.main}`,
            bgcolor: warn.soft,
            color: warn.ink,
            fontSize: "0.75rem",
            fontWeight: 700,
          }}
        >
          {t("flowAlign.tap.jumpToUnaligned")}
        </Button>
      </Box>

      {/* ── source ribbon: one card per source word/group, always visible ── */}
      <Box sx={{ display: "flex", justifyContent: "flex-end", marginBlockEnd: 0.5 }}>
        <Tooltip
          title={
            wrapRibbon ? t("flowAlign.tap.scrollInstead") : t("flowAlign.tap.wrapInstead")
          }
        >
          <IconButton
            size="small"
            aria-label={t("flowAlign.tap.toggleWrapAria")}
            aria-pressed={wrapRibbon}
            onClick={() => setWrapRibbon((v) => !v)}
          >
            <WrapTextIcon fontSize="small" color={wrapRibbon ? "primary" : "inherit"} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box
        dir={sourceRtl ? "rtl" : "ltr"}
        sx={{
          ...(wrapRibbon ? {} : { overflowX: "auto" }),
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "12px",
          bgcolor: "background.paper",
          marginBlockEnd: 1.5,
        }}
      >
        <Box
          role="list"
          aria-label={t("flowAlign.tap.sourceGroupsAria")}
          sx={{
            display: "flex",
            gap: 1.25,
            padding: 1.5,
            ...(wrapRibbon ? { flexWrap: "wrap" } : { minWidth: "min-content" }),
          }}
        >
          {cards.map((card) => {
            const isSelected = selection.side === "source" && selection.ids.includes(card.id);
            const unaligned = card.targets.length === 0;
            return (
              <Box
                key={card.id}
                role="listitem"
                data-align-unaligned={unaligned ? "true" : undefined}
                sx={{
                  flex: "none",
                  minWidth: 108,
                  border: "1.5px solid",
                  borderColor: isSelected ? "primary.main" : "divider",
                  borderBlockEndWidth: unaligned ? 3 : undefined,
                  borderBlockEndColor: unaligned ? warn.main : undefined,
                  borderRadius: "9px",
                  bgcolor: isSelected ? "action.selected" : "action.hover",
                  padding: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.75,
                }}
              >
                <Box
                  component="button"
                  type="button"
                  onClick={() => handleCardTap(card.id)}
                  aria-pressed={isSelected}
                  dir={sourceRtl ? "rtl" : "ltr"}
                  sx={{
                    appearance: "none",
                    border: "none",
                    background: "transparent",
                    color: "text.primary",
                    cursor: "pointer",
                    minHeight: 44,
                    padding: 0.5,
                    borderRadius: "7px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 0.5,
                    justifyContent: "center",
                    fontFamily: SCRIPTURE_FONT_STACK,
                    fontSize: 16,
                    lineHeight: 1.3,
                  }}
                >
                  {card.source.map((s) => (
                    <Box component="span" key={s.id}>
                      {s.content ?? ""}
                    </Box>
                  ))}
                </Box>

                <Box
                  dir={targetRtl ? "rtl" : "ltr"}
                  sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, minHeight: 30 }}
                >
                  {card.targets.length === 0 ? (
                    // UI chrome in the UI language — `dir="auto"` so it follows
                    // its own text rather than inheriting the surrounding
                    // scripture-direction box (issue #163).
                    <Typography
                      variant="caption"
                      dir="auto"
                      sx={{ color: "text.secondary", fontStyle: "italic", alignSelf: "center", textAlign: "start" }}
                    >
                      {t("flowAlign.tap.unaligned")}
                    </Typography>
                  ) : (
                    card.targets.map((t) => {
                      const sel = selection.side === "target" && selection.ids.includes(t.id);
                      return (
                        <Chip
                          key={t.id}
                          label={t.text}
                          selected={sel}
                          tone="aligned"
                          onClick={() => handleTargetTap(t.id)}
                        />
                      );
                    })
                  )}
                </Box>

                {card.source.length > 1 && canEdit && (
                  <Button
                    size="small"
                    onClick={() => handleSplit(card.id)}
                    sx={{
                      alignSelf: "flex-start",
                      minHeight: 44,
                      borderRadius: 999,
                      border: "1px dashed",
                      borderColor: "divider",
                      color: "text.secondary",
                      fontSize: "0.69rem",
                      fontWeight: 700,
                    }}
                  >
                    {t("flowAlign.tap.split")}
                  </Button>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* ── target pool ───────────────────────────────────────────────── */}
      <Box
        role="list"
        aria-label={t("flowAlign.tap.poolAria")}
        dir={targetRtl ? "rtl" : "ltr"}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 1,
          padding: 1.5,
          bgcolor: "background.paper",
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "12px",
          minHeight: 60,
          marginBlockEnd: 1.5,
        }}
      >
        {pool.length === 0 ? (
          // UI chrome in the UI language — `dir="auto"` so it follows its own
          // text rather than inheriting the surrounding scripture-direction
          // box (issue #163).
          <Typography variant="body2" dir="auto" sx={{ color: "text.secondary", fontStyle: "italic", textAlign: "start" }}>
            {t("flowAlign.tap.allAligned")}
          </Typography>
        ) : (
          pool.map((t) => (
            <Chip
              key={t.id}
              label={t.text}
              selected={selection.side === "target" && selection.ids.includes(t.id)}
              tone="pool"
              onClick={() => handleTargetTap(t.id)}
            />
          ))
        )}
      </Box>

      {/* ── selection action bar ──────────────────────────────────────── */}
      {selection.ids.length > 0 && (
        <Box
          role="region"
          aria-label={t("flowAlign.tap.actionsAria")}
          sx={{
            position: "sticky",
            insetBlockEnd: 0,
            zIndex: 2,
            display: "flex",
            gap: 1,
            alignItems: "center",
            flexWrap: "wrap",
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "primary.main",
            borderRadius: "12px",
            paddingBlock: 1.25,
            paddingInline: 1.75,
            marginBlockEnd: 1.5,
          }}
        >
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {/* The side is part of the sentence, so it gets its own key per
                side rather than a spliced-in noun — plural agreement and word
                order differ per language. `selection.side` stays the English
                identity used in logic; only the sentence is translated. */}
            {t(
              selection.side === "target"
                ? "flowAlign.tap.selectedTarget"
                : "flowAlign.tap.selectedSource",
              {
                count: selection.ids.length,
                hint: !canEdit
                  ? t("flowAlign.tap.hintViewOnly")
                  : selection.side === "target"
                    ? t("flowAlign.tap.hintTapSource")
                    : t("flowAlign.tap.hintTapTarget"),
              },
            )}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {selection.side === "target" && (
            <Button
              onClick={handleUnalign}
              disabled={!canEdit}
              sx={{ minHeight: 44, bgcolor: warn.soft, color: warn.ink, fontWeight: 700 }}
            >
              {t("flowAlign.tap.unalign")}
            </Button>
          )}
          {selection.side === "source" && selection.ids.length >= 2 && (
            <Button
              variant="outlined"
              onClick={handleCombine}
              disabled={!canEdit}
              sx={{ minHeight: 44, fontWeight: 700 }}
            >
              {t("flowAlign.tap.combine")}
            </Button>
          )}
          <Button
            variant="outlined"
            onClick={() => setSelection(NO_SELECTION)}
            sx={{ minHeight: 44, fontWeight: 700 }}
          >
            {t("aligner.clear")}
          </Button>
        </Box>
      )}
    </Box>
  );
}

// ── small pieces ───────────────────────────────────────────────────────
function Chip({
  label,
  selected,
  tone,
  onClick,
}: {
  label: string;
  selected: boolean;
  tone: "pool" | "aligned";
  onClick: () => void;
}) {
  const theme = useTheme();
  const ok = theme.palette.flows.ok;
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      sx={{
        appearance: "none",
        cursor: "pointer",
        borderRadius: 999,
        border: "1.5px solid",
        borderColor: selected ? "primary.main" : tone === "aligned" ? ok.main : "divider",
        bgcolor: selected ? "primary.main" : tone === "aligned" ? ok.soft : "action.hover",
        color: selected ? "primary.contrastText" : tone === "aligned" ? ok.ink : "text.primary",
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: tone === "aligned" ? 14 : 15,
        fontWeight: 600,
        minHeight: 44,
        paddingBlock: 0.75,
        paddingInline: 1.5,
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      {label}
    </Box>
  );
}

function toggle(cur: Selection, side: "source" | "target", id: string): Selection {
  if (cur.side !== side) return { side, ids: [id] };
  const ids = cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id];
  return ids.length ? { side, ids } : NO_SELECTION;
}

function ghostId(g: Ghost): string {
  return `${g.groupId}${g.text}`;
}

function sourceTextOf(card: AlignmentGroup | undefined): string {
  if (!card) return "";
  return card.source.map((s) => s.content ?? "").join(" ");
}
