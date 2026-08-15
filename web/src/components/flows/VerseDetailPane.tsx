// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// The one detail area of the verse fidelity overview, ported from the
// `#detail` column of docs/mockups/book-package/verse.html. One selection model
// feeds it: an original word (with its alignment group and morphology) or one
// resource (note / word link / question).
//
// What the mockup had and this does NOT: inline translationAcademy and
// translationWords PROSE. The mockup shipped a build-time snapshot of the
// en_ta / en_tw checkouts inside its fixture; the app fetches articles from
// Door43 in its own viewer, so this pane links to that viewer rather than
// re-implementing (and possibly contradicting) it.

import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";

import { FlowStatusChip } from "./FlowStatusChip";
import {
  laneTextFor,
  supportRefId,
  twLinkId,
  type LaneModel,
  type OriginalWord,
  type ResourceItem,
} from "./VerseSpineModel";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { LexiconEntry } from "../../hooks/useLexicon";
import { taShort } from "../../lib/taArticle";

// Hebrew/Greek display face. Same stack the existing scripture panels use
// (AlignmentPanel / DocColumn / NoteCard) so the original text renders
// identically wherever it appears in the app.
export const ORIGINAL_FONT_STACK = '"Times New Roman","SBL Hebrew","Cardo",serif';

export type VerseSelection =
  | { kind: "word"; positions: number[] }
  | { kind: "resource"; key: string };

export interface VerseDetailPaneProps {
  refLabel: string;
  selection: VerseSelection | null;
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  resources: ResourceItem[];
  lexicon: Map<string, LexiconEntry | null>;
  rtl: boolean;
  onSelect: (sel: VerseSelection) => void;
}

// ─── small shared bits ──────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
        marginBlockEnd: 0.625,
      }}
    >
      {children}
    </Typography>
  );
}

function QuoteBlock({
  children,
  original,
  rtl,
}: {
  children: ReactNode;
  original?: boolean;
  rtl?: boolean;
}) {
  return (
    <Box
      dir={original && rtl ? "rtl" : undefined}
      sx={{
        fontFamily: original ? ORIGINAL_FONT_STACK : SCRIPTURE_FONT_STACK,
        fontSize: original ? "1.375rem" : "0.97rem",
        lineHeight: original ? 1.8 : 1.55,
        bgcolor: "action.hover",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        paddingBlock: 1,
        paddingInline: 1.5,
        textAlign: "start",
      }}
    >
      {children}
    </Box>
  );
}

function NotRendered() {
  const theme = useTheme();
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

// tN note bodies are one field, not a document: bold, bracketed alternates,
// rc:// refs and escaped newlines. Ported from _vlib.js's `note()` — as React
// nodes rather than an HTML string, so nothing is injected.
function inlineNodes(line: string, keyBase: string): ReactNode[] {
  const cleaned = line
    .replace(/\[\[rc:\/\/[^\]]*?\/([^/\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|(Alternate translation:)\s*\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index > last) out.push(cleaned.slice(last, m.index));
    const bold = m[1];
    const altLabel = m[2];
    const altText = m[3];
    if (bold !== undefined) {
      out.push(<b key={`${keyBase}-b${i}`}>{bold}</b>);
    } else {
      out.push(
        <span key={`${keyBase}-a${i}`}>
          {altLabel}{" "}
          <Box
            component="span"
            sx={(theme) => ({
              fontFamily: SCRIPTURE_FONT_STACK,
              bgcolor: theme.palette.flows.ok.soft,
              color: theme.palette.flows.ok.ink,
              borderRadius: 0.5,
              paddingInline: 0.5,
            })}
          >
            {altText}
          </Box>
        </span>,
      );
    }
    last = re.lastIndex;
    i += 1;
  }
  if (last < cleaned.length) out.push(cleaned.slice(last));
  return out;
}

function NoteBody({ text }: { text: string | null }) {
  if (!text || !text.trim()) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
        This note has no body text.
      </Typography>
    );
  }
  const lines = text.replace(/\\n/g, "\n").split("\n");
  return (
    <Box sx={{ fontSize: "0.86rem", lineHeight: 1.6, textAlign: "start" }}>
      {lines.map((line, i) =>
        line.trim() ? (
          <Typography key={i} variant="body2" sx={{ marginBlockEnd: 1 }}>
            {inlineNodes(line, `l${i}`)}
          </Typography>
        ) : null,
      )}
    </Box>
  );
}

function ResourceRowButton({
  item,
  onSelect,
}: {
  item: ResourceItem;
  onSelect: (sel: VerseSelection) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect({ kind: "resource", key: item.key })}
      sx={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 1.25,
        alignItems: "baseline",
        inlineSize: "100%",
        textAlign: "start",
        appearance: "none",
        border: 0,
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "0.84rem",
        minHeight: 32,
        paddingBlock: 0.875,
        paddingInline: 1,
        cursor: "pointer",
        "&:hover, &:focus-visible": { bgcolor: "action.hover" },
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
        {item.tag}
      </Box>
      <Box component="span" sx={{ color: "text.secondary" }}>
        {item.summary || "—"}
      </Box>
    </Box>
  );
}

// ─── word detail ────────────────────────────────────────────────────────────

function WordCard({ word, entry }: { word: OriginalWord; entry: LexiconEntry | null }) {
  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        bgcolor: "action.hover",
        paddingBlock: 1,
        paddingInline: 1.25,
        marginBlockEnd: 1,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 1.25,
        }}
      >
        <Box component="span" sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1.3rem" }}>
          {word.text}
        </Box>
        {word.lemma && (
          <Box
            component="span"
            sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "0.95rem", color: "text.secondary" }}
          >
            {word.lemma}
          </Box>
        )}
      </Box>

      {word.glosses.length > 0 ? (
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.375 }}>
          {word.glosses.join("  +  ")}
        </Typography>
      ) : (
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.375 }}>
          {word.morph
            ? "This morphology code is not one the decoder recognises."
            : "This word carries no x-morph attribute."}
        </Typography>
      )}

      {word.decoded?.pronounSuffix && (
        <Typography variant="caption" component="p" sx={{ mt: 0.375 }}>
          attached pronoun: <b>{word.decoded.pronounSuffix.gloss}</b>{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            ({word.decoded.pronounSuffix.parse})
          </Box>
        </Typography>
      )}

      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ mt: 0.375, fontFamily: "monospace" }}
      >
        {[word.strong || "(no Strong's)", word.morph].filter(Boolean).join(" · ")}
      </Typography>

      <Box sx={{ mt: 0.75, borderBlockStart: "1px dashed", borderColor: "divider", pt: 0.75 }}>
        {!word.strong ? (
          <Typography variant="caption" color="text.secondary">
            No Strong&rsquo;s number on this word, so no lexicon lookup is possible.
          </Typography>
        ) : entry ? (
          <>
            {entry.gloss && (
              <Typography variant="body2" sx={{ fontSize: "0.84rem" }}>
                {entry.gloss}
              </Typography>
            )}
            {entry.part_of_speech && (
              <Typography variant="caption" component="p" color="text.secondary">
                {entry.part_of_speech}
              </Typography>
            )}
            {entry.definition && (
              <Typography variant="body2" sx={{ fontSize: "0.82rem", mt: 0.375 }}>
                {entry.definition}
              </Typography>
            )}
            {!entry.gloss && !entry.definition && (
              <Typography variant="caption" color="text.secondary">
                Lexicon entry found, but it carries no gloss or definition.
              </Typography>
            )}
          </>
        ) : (
          <Typography variant="caption" color="text.secondary">
            <em>No lexicon entry loaded for {word.strong}.</em> The local lexicon table is empty in
            some environments — <code>scripts/import-lexicon.mjs</code> populates UHAL/UGL.
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ─── the pane ───────────────────────────────────────────────────────────────

export function VerseDetailPane({
  refLabel,
  selection,
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  originalLabel,
  resources,
  lexicon,
  rtl,
  onSelect,
}: VerseDetailPaneProps) {
  const theme = useTheme();

  if (!selection) {
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ paddingBlock: 4, paddingInline: 0.25, textAlign: "start" }}
      >
        Select a word, a row, a note or a word link.
        <br />
        <br />
        Everything is anchored to the original words, so a selection anywhere lights up the same
        place in all three texts.
      </Typography>
    );
  }

  const topRef = (
    <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
      {refLabel}
    </Typography>
  );

  if (selection.kind === "word") {
    const selected = selection.positions.map((p) => words[p]).filter(Boolean);
    if (selected.length === 0) {
      return (
        <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 4 }}>
          That word is no longer in this verse.
        </Typography>
      );
    }
    const posSet = new Set(selection.positions);
    const attached = resources.filter((r) => r.positions.some((p) => posSet.has(p)));
    const litText = selection.positions.map((p) => laneTextFor(lit, p)).filter(Boolean).join(" … ");
    const simText = selection.positions.map((p) => laneTextFor(sim, p)).filter(Boolean).join(" … ");

    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip
            kind="skip"
            label={`original word${selected.length > 1 ? "s" : ""}`}
          />
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Morphology · from {originalLabel}</SectionLabel>
          {selected.map((w) => (
            <WordCard key={w.position} word={w} entry={lexicon.get(w.strong) ?? null} />
          ))}
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Literal · {litLabel}</SectionLabel>
          <QuoteBlock>{lit.present ? litText || <NotRendered /> : "This lane has no text in this workspace."}</QuoteBlock>
        </Box>

        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Simplified · {simLabel}</SectionLabel>
          <QuoteBlock>{sim.present ? simText || <NotRendered /> : "This lane has no text in this workspace."}</QuoteBlock>
        </Box>

        {attached.length > 0 ? (
          <Box>
            <SectionLabel>Attached here</SectionLabel>
            {attached.map((r) => (
              <ResourceRowButton key={r.key} item={r} onSelect={onSelect} />
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
            No note or word link attaches to this word.
          </Typography>
        )}
      </Box>
    );
  }

  const item = resources.find((r) => r.key === selection.key);
  if (!item) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ paddingBlock: 4 }}>
        That resource is no longer in this verse.
      </Typography>
    );
  }

  if (item.kind === "tq") {
    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip kind="skip" label="question" />
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Question</SectionLabel>
          <QuoteBlock>{item.tq?.question || "—"}</QuoteBlock>
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Expected answer</SectionLabel>
          <QuoteBlock>{item.tq?.response || "—"}</QuoteBlock>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
          A question that cannot be answered from the two renderings above is the clearest sign
          that something in this verse does not line up.
        </Typography>
      </Box>
    );
  }

  if (item.kind === "twl") {
    const id = twLinkId(item.twl?.tw_link);
    return (
      <Box sx={{ textAlign: "start" }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
          {topRef}
          <FlowStatusChip kind="edited" label={id || "no tW article linked"} />
          {item.twl?.tags && <FlowStatusChip kind="skip" label={item.twl.tags} />}
          <FlowStatusChip
            kind={item.positions.length ? "ok" : "warn"}
            label={item.positions.length ? "quote anchored" : "quote not found"}
          />
        </Box>
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Linked from</SectionLabel>
          <QuoteBlock original rtl={rtl}>
            {item.twl?.orig_words || "—"}
          </QuoteBlock>
        </Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "3px 12px",
            fontSize: "0.8rem",
            mb: 2.25,
          }}
        >
          <Box sx={{ color: "text.secondary" }}>occurrence</Box>
          <Box>{item.twl?.occurrence ?? 1}</Box>
          <Box sx={{ color: "text.secondary" }}>link</Box>
          <Box sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
            {item.twl?.tw_link || "—"}
          </Box>
        </Box>
        {id ? (
          <Link href={`#/articles/tw/${encodeURIComponent(id)}`} sx={{ fontSize: "0.84rem" }}>
            Read the translationWords article →
          </Link>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
            This word link has no readable tW article reference.
          </Typography>
        )}
      </Box>
    );
  }

  // tN
  const slug = supportRefId(item.tn?.support_reference);
  const short = taShort(item.tn?.support_reference);
  return (
    <Box sx={{ textAlign: "start" }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", mb: 1.5 }}>
        {topRef}
        {slug && <FlowStatusChip kind="edited" label={slug} />}
        <FlowStatusChip
          kind={item.positions.length ? "ok" : "warn"}
          label={item.quote ? (item.positions.length ? "quote anchored" : "quote not found") : "no quote"}
        />
        {item.tn?.tags && <FlowStatusChip kind="skip" label={item.tn.tags} />}
      </Box>

      {item.quote && (
        <Box sx={{ mb: 2.25 }}>
          <SectionLabel>Quote</SectionLabel>
          <QuoteBlock original rtl={rtl}>
            {item.quote.replace(/&/g, " … ")}
          </QuoteBlock>
        </Box>
      )}

      <Box sx={{ mb: 2.25 }}>
        <SectionLabel>Note</SectionLabel>
        <NoteBody text={item.tn?.note ?? null} />
      </Box>

      {!item.positions.length && item.quote && (
        <Typography
          variant="body2"
          sx={{
            fontSize: "0.8rem",
            mb: 2,
            color: theme.palette.flows.warn.ink,
            bgcolor: alpha(theme.palette.flows.warn.main, 0.1),
            borderRadius: 1,
            padding: 1,
          }}
        >
          This quote does not resolve against the original text of this verse, so the note cannot
          be shown against any word. That happens when the quote was written in English, or when
          the original text has changed since the note was written.
        </Typography>
      )}

      {slug ? (
        <Link href={`#/articles/ta/${encodeURIComponent(short)}`} sx={{ fontSize: "0.84rem" }}>
          Read the translationAcademy article →
        </Link>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8rem" }}>
          {item.tn?.support_reference
            ? `Support reference "${item.tn.support_reference}" is not a recognised tA article.`
            : "This note has no translationAcademy article."}
        </Typography>
      )}
    </Box>
  );
}
