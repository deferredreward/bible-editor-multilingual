// One scripture lane card from docs/flows/ui/t3-scripture.html (.lane-block):
// the read-only original-language line, the paragraph-marker toolbar, the
// editable target box, and the Undo / Save footer.
//
// The mockup shipped Save DISABLED because a vanilla textarea can only produce
// a flat string, and writing that back as `{verseObjects:[{type:"text"}]}`
// annihilates the verse's alignment tree (findings §5.1). Here the textarea
// holds the app's EDITABLE representation — extractEditableText, with \p / \q1
// surfaced as literal tokens — and the parent diffs it through smartEditVerse.
// This component therefore never constructs verseObjects itself; it hands the
// parent a string and nothing else.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { FlowStatusChip } from "./FlowStatusChip";
import { drafts, verseKey } from "../../sync/drafts";
import { normalizeEditable } from "../../lib/usfm";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { VerseDto } from "../../sync/api";

// The mockup's four paragraph-marker chips. Inserted as literal tokens because
// that is exactly what extractEditableText emits and what smartEditVerse's diff
// understands.
const PARAGRAPH_MARKERS = ["\\p", "\\q1", "\\q2", "\\s1"] as const;

export interface ScriptureLaneProps {
  book: string;
  chapter: number;
  verse: number;
  /** Internal role code — "ULT" / "UST". Never the display label. */
  bibleVersion: string;
  /** Project display label for this lane (e.g. "GLT"). */
  laneLabel: string;
  /** The verse row for this lane, or null when the payload has no row for it. */
  base: VerseDto | null;
  /** extractEditableText(base.content) — the diff baseline and initial value. */
  editableBaseline: string;
  /** Original-language line shown above the editor (already plain text). */
  sourceText: string | null;
  sourceRtl: boolean;
  sourceLabel: string;
  targetRtl: boolean;
  /** False for viewers, a text-locked lane, or a lane awaiting replacement. */
  canEdit: boolean;
  /** Why editing is off, rendered under the box. Null when canEdit. */
  disabledReason: string | null;
  saving: boolean;
  onSave: (editableText: string) => void;
  onAlign: () => void;
}

export function ScriptureLane({
  book,
  chapter,
  verse,
  bibleVersion,
  laneLabel,
  base,
  editableBaseline,
  sourceText,
  sourceRtl,
  sourceLabel,
  targetRtl,
  canEdit,
  disabledReason,
  saving,
  onSave,
  onAlign,
}: ScriptureLaneProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(editableBaseline);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  // Which draft key the box currently holds. A change means "different
  // verse/lane" and re-seeds the box; a ref (not state) so setting it can't
  // re-run the hydration effect and cancel its own read.
  const hydratedKeyRef = useRef<string | null>(null);
  // Latest server baseline, readable inside the effect WITHOUT being a dep.
  const baselineRef = useRef(editableBaseline);
  baselineRef.current = editableBaseline;

  // The draft key is the ROW's verse, never the displayed one: a `\v 6-9` range
  // row opened at verse 7 PATCHes v=6, and the outbox clears drafts by the op's
  // target verse. Keying the draft on 7 would leave it uncleared after a
  // successful save — a permanent false "N unsaved", plus a stale draft that
  // could later rehydrate over newer text. DocColumn.tsx:260 makes the same
  // choice (it passes dto.verse for both the PATCH and the draft).
  const rowVerse = base?.verse ?? verse;
  const draftKey = base ? verseKey(book, chapter, rowVerse, bibleVersion) : null;

  // "This lane holds unsaved typing." `hasDraft` is async state from the draft
  // subscription; `dirtyRef` is its synchronous mirror, set on the keystroke
  // itself so a re-render in the window before the subscription lands can't
  // resync over an in-progress edit. Same pair, same reason, as DocColumn.tsx
  // (439-483).
  const [hasDraft, setHasDraft] = useState(false);
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!draftKey) {
      setHasDraft(false);
      dirtyRef.current = false;
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey && !d.quarantined);
      setHasDraft(!!rec);
      dirtyRef.current = !!rec;
    });
  }, [draftKey]);

  // Seed ONCE per draft key: the server value, then any persisted draft
  // (unsaved typing from this browser) on top.
  //
  // `editableBaseline` is deliberately NOT a dependency here. Keying the SEED on
  // it meant any later change to server content re-seeded the textarea
  // mid-typing, moving the caret and replacing what the translator had just
  // typed. New server content is instead adopted by the resync effect below,
  // which only fires when the lane is clean.
  useEffect(() => {
    const key = draftKey ?? "none";
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    dirtyRef.current = false;
    setValue(baselineRef.current);
    if (!draftKey) return;
    let cancelled = false;
    void drafts.get(draftKey).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== key) return;
      const plain = (rec?.payload as { plainText?: unknown } | undefined)?.plainText;
      if (typeof plain === "string") setValue(plain);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  // Adopt new SERVER content when the lane is clean — DocColumn's resync
  // (452-483, guarded at 568: `if (hasDraft || dirtyRef.current) return`).
  // Hydrate-once alone was not enough: a Verse-history restore or a
  // find/replace updates the verse row but left the box holding pre-restore
  // text, and the next Save diffed the new baseline against that stale text and
  // reverted the restore. While the lane IS dirty the user's text stands and
  // the "Unsaved" chip below shows the divergence.
  useEffect(() => {
    if (hasDraft || dirtyRef.current) return;
    setValue(editableBaseline);
  }, [editableBaseline, hasDraft]);

  const dirty = normalizeEditable(value) !== editableBaseline;

  // Every keystroke goes to the IndexedDB drafts store so unsaved typing
  // survives a reload / tab close. The outbox is untouched until Save.
  function handleChange(next: string) {
    setValue(next);
    if (!draftKey || !base) return;
    if (normalizeEditable(next) === editableBaseline) {
      dirtyRef.current = false;
      void drafts.clear(draftKey);
      return;
    }
    // Synchronous, before the async draft write: the resync effect above must
    // never adopt a new baseline over typing that hasn't reached IndexedDB yet.
    dirtyRef.current = true;
    void drafts.set(draftKey, { plainText: next }, base.version, {
      kind: "verse",
      book,
      chapter,
      verse: rowVerse,
      bibleVersion,
    });
  }

  function handleUndo() {
    setValue(editableBaseline);
    dirtyRef.current = false;
    if (draftKey) void drafts.clear(draftKey);
  }

  function insertMarker(marker: string) {
    const el = boxRef.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const token = `${marker} `;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    handleChange(next);
    // Restore the caret after React re-renders with the new value.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // There is no draft/approved lifecycle on verses. "Edited" means a human has
  // touched the row (updated_by set); anything else is still the import.
  const chip = !base ? (
    <FlowStatusChip kind="skip" label={t("flowScripture.chipNoData")} />
  ) : base.updated_by != null ? (
    <FlowStatusChip kind="edited" />
  ) : (
    <FlowStatusChip kind="draft" label={t("flowScripture.chipImported")} />
  );

  return (
    <Box
      component="section"
      aria-label={t("flowScripture.laneAria", { lane: bibleVersion })}
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        p: 1.75,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1, flexWrap: "wrap" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {laneLabel && laneLabel !== bibleVersion ? `${bibleVersion} → ${laneLabel}` : bibleVersion}
        </Typography>
        {chip}
        {dirty && <FlowStatusChip kind="warn" label={t("flowAlign.lane.unsaved")} />}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="outlined" onClick={onAlign} sx={{ minHeight: 44 }}>
          {t("flowAlign.lane.align")}
        </Button>
      </Stack>

      {/* The reference above the editor is the ORIGINAL-language line: this
          project has no separate gateway-language source row — ULT/UST are
          themselves the editable targets. */}
      <Typography
        component="p"
        dir={sourceRtl ? "rtl" : "ltr"}
        sx={{
          fontFamily: SCRIPTURE_FONT_STACK,
          fontSize: sourceRtl ? "1.3rem" : "1rem",
          lineHeight: 1.7,
          bgcolor: "action.hover",
          borderRadius: 1,
          paddingBlock: 1,
          paddingInline: 1.25,
          marginBlockEnd: 1.25,
          textAlign: "start",
        }}
      >
        {sourceText ?? (
          // UI chrome in the UI language — `dir="auto"` so it follows its own
          // text (LTR in English, RTL in Arabic) instead of inheriting the
          // parent Typography's scripture rtl (issue #163). Real source text
          // above correctly follows sourceRtl; this is only the empty state.
          <Box component="em" dir="auto" sx={{ fontSize: "0.85rem", fontFamily: "inherit", textAlign: "start" }}>
            {t("flowScripture.noSourceText", { source: sourceLabel })}
          </Box>
        )}
      </Typography>

      {canEdit && (
        <Stack
          direction="row"
          spacing={0.75}
          sx={{ mb: 1, flexWrap: "wrap" }}
          aria-label={t("flowAlign.lane.paragraphMarkers")}
        >
          {PARAGRAPH_MARKERS.map((m) => (
            <Button
              key={m}
              size="small"
              variant="text"
              onClick={() => insertMarker(m)}
              sx={{
                minHeight: 32,
                minWidth: 44,
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.72rem",
                border: "1px dashed",
                borderColor: "divider",
                color: "text.secondary",
              }}
            >
              {m}
            </Button>
          ))}
        </Stack>
      )}

      <TextField
        multiline
        fullWidth
        minRows={2}
        maxRows={16}
        value={value}
        disabled={!canEdit || !base}
        onChange={(e) => handleChange(e.target.value)}
        inputRef={boxRef}
        inputProps={{
          dir: targetRtl ? "rtl" : "ltr",
          spellCheck: false,
          "aria-label": t("flowAlign.lane.inputAria", { lane: bibleVersion }),
        }}
        sx={{
          "& .MuiInputBase-root": {
            fontFamily: SCRIPTURE_FONT_STACK,
            fontSize: "1.05rem",
            lineHeight: 1.6,
            alignItems: "flex-start",
            textAlign: "start",
          },
        }}
      />

      {disabledReason && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, textAlign: "start" }}>
          {disabledReason}
        </Typography>
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: "wrap" }}>
        <Button variant="outlined" disabled={!dirty || saving} onClick={handleUndo} sx={{ minHeight: 44 }}>
          {t("common.undo")}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          disabled={!canEdit || !base || !dirty || saving}
          onClick={() => onSave(value)}
          sx={{ minHeight: 44 }}
        >
          {saving ? t("flowAlign.lane.saving") : t("common.save")}
        </Button>
      </Stack>
    </Box>
  );
}
