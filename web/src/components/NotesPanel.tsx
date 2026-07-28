// NotesPanel — the translationNotes (TN) resource panel.
//
// `NotesPanelBody` is the content-only render of the Notes view: a SectionHead,
// the translation-mode stats strip, and the per-verse/whole-chapter note list.
//
// Unlike WordsPanelBody/QuestionsPanelBody, the note CARD is supplied by the
// caller via the `renderNoteCard` render-prop rather than built here. That is
// deliberate: a note card is wired to a large, delicate machinery — live
// drag-reorder state, arrow-move focus/flash, the reorder-preview effect — that
// is alignment-adjacent and must not be perturbed. Keeping that machinery (and
// `renderNoteCard`) in its existing owner and passing the renderer in leaves the
// classic Notes tab byte-identical; this component only owns the surrounding
// layout (section head, stats strip, verse grouping, empty states), lifted
// verbatim from ResourceColumn's `activeResourceTab === "notes"` block.

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Box, Stack, Typography, Chip, Button, Tooltip, LinearProgress } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import type { TnRow } from "../sync/api";
import { SectionHead, VerseGroupHead, type ResourceCheckoff } from "./resourcePanelShared";

export interface NotesPanelBodyProps {
  activeVerse: number;
  // Derived, ordered rows. `tnGroups` non-null ⇒ pinned whole-chapter view
  // (grouped by verse); null ⇒ active-verse-only view using `tnForVerse`.
  tnForVerse: TnRow[];
  tnGroups: Array<[number, TnRow[]]> | null;
  totalTn: number;
  pinned: boolean;
  onTogglePin: () => void;
  onNoteCreate: () => void;
  locked?: boolean;
  checkoff?: ResourceCheckoff;
  // Translation-mode stats strip (hidden in the English root project).
  translationMode: boolean;
  tnStats: { total: number; validated: number; draftIds: string[] };
  termsCount: number;
  onNoteApprove?: (id: string, value: boolean) => void;
  // The caller builds each note card (it owns the drag/reorder/flash state the
  // card closes over). `peers` is the row's sibling list for arrow-move bounds.
  renderNoteCard: (r: TnRow, peers: TnRow[]) => ReactNode;
}

export function NotesPanelBody({
  activeVerse,
  tnForVerse,
  tnGroups,
  totalTn,
  pinned,
  onTogglePin,
  onNoteCreate,
  locked,
  checkoff,
  translationMode,
  tnStats,
  termsCount,
  onNoteApprove,
  renderNoteCard,
}: NotesPanelBodyProps) {
  const { t } = useTranslation();
  return (
    <>
      <SectionHead
        title={t("shell.notes")}
        count={totalTn}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onAdd={onNoteCreate}
        sticky
        hideAdd={locked}
        lane="tn"
        checkoff={checkoff}
      />
      {translationMode && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{
            px: 0.5,
            py: 0.75,
            mb: 0.5,
            flexWrap: "wrap",
            rowGap: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Chip
            size="small"
            color="secondary"
            variant="outlined"
            icon={<AutoAwesomeIcon sx={{ fontSize: "13px !important" }} />}
            label={t("translation.translationMode")}
            sx={{ height: 22, fontSize: 11, fontWeight: 600 }}
          />
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 120, flex: 1 }}>
            <LinearProgress
              variant="determinate"
              color="success"
              value={tnStats.total ? (tnStats.validated / tnStats.total) * 100 : 0}
              sx={{ flex: 1, height: 6, borderRadius: 99, minWidth: 60 }}
            />
            <Typography variant="caption" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
              {tnStats.validated} / {tnStats.total}
            </Typography>
          </Box>
          <Tooltip title={t("translation.languageMemoryTip")}>
            <Typography variant="caption" sx={{ color: "text.disabled", whiteSpace: "nowrap" }}>
              🧠 {t("translation.languageMemory")}: {tnStats.validated} {t("translation.examples")} ·{" "}
              {termsCount} {t("translation.terms")}
            </Typography>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          {onNoteApprove && (
            <Button
              size="small"
              variant="outlined"
              color="success"
              startIcon={<CheckIcon sx={{ fontSize: "15px !important" }} />}
              disabled={tnStats.draftIds.length === 0}
              onClick={() => {
                for (const id of tnStats.draftIds) onNoteApprove(id, true);
              }}
              sx={{ minWidth: 0, fontSize: 11 }}
            >
              {t("common.approveAll")} ({tnStats.draftIds.length})
            </Button>
          )}
        </Stack>
      )}
      {tnGroups ? (
        tnGroups.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            {t("shell.noNotesInChapter")}
          </Typography>
        ) : (
          tnGroups.map(([verse, rows]) => (
            <Fragment key={`tn-${verse}`}>
              <VerseGroupHead verse={verse} active={verse === activeVerse} section="notes" />
              {rows.map((r) => renderNoteCard(r, rows))}
            </Fragment>
          ))
        )
      ) : tnForVerse.length === 0 ? (
        <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
          {t("shell.noNotesForVerse")}
        </Typography>
      ) : (
        tnForVerse.map((r) => renderNoteCard(r, tnForVerse))
      )}
    </>
  );
}
