// QuestionsPanel — the translationQuestions (TQ) resource panel.
//
// `QuestionsPanelBody` is the content-only render of the Questions view: a
// SectionHead, the translation-mode stats strip, and the per-verse/whole-chapter
// question list. In a gateway-language (translation) project each question is a
// QuestionCard (source + editable target, approve/translate); in the English
// root project it's the plain QuestionsTable.
//
// Like WordsPanelBody it owns NO state and NO scroll container — the caller
// supplies derived rows + translation-mode data + callbacks and positions it in
// a scroll body. Shared by the classic tabbed ResourceColumn and the standalone
// stacked layout panel. Lifted verbatim from ResourceColumn's
// `activeResourceTab === "questions"` block so the classic tab stays
// byte-identical.

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Box, Stack, Typography, Chip, Button, LinearProgress } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import type { TqRow } from "../sync/api";
import type { SourceQuestionMap } from "../hooks/useSourceQuestions";
import { QuestionsTable } from "./QuestionsTable";
import { QuestionCard } from "./QuestionCard";
import { SectionHead, VerseGroupHead, type ResourceCheckoff } from "./resourcePanelShared";

export interface QuestionsPanelBodyProps {
  activeVerse: number;
  // Derived, ordered rows. `tqGroups` non-null ⇒ pinned whole-chapter view
  // (grouped by verse); null ⇒ active-verse-only view using `tqForVerse`.
  tqForVerse: TqRow[];
  tqGroups: Array<[number, TqRow[]]> | null;
  totalTq: number;
  pinned: boolean;
  onTogglePin: () => void;
  onQuestionCreate: () => void;
  locked?: boolean;
  checkoff?: ResourceCheckoff;
  // Translation-mode wiring. `translationMode` false ⇒ English root (plain
  // QuestionsTable, no stats strip); true ⇒ gateway language (QuestionCards).
  translationMode: boolean;
  tqStats: { total: number; validated: number; draftIds: string[] };
  sourceQuestions: SourceQuestionMap;
  onQuestionSave: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
  onQuestionApprove?: (id: string, value: boolean) => void;
  onQuestionTranslate?: (id: string) => void;
  translatingQuestionIds?: Set<string>;
}

export function QuestionsPanelBody({
  activeVerse,
  tqForVerse,
  tqGroups,
  totalTq,
  pinned,
  onTogglePin,
  onQuestionCreate,
  locked,
  checkoff,
  translationMode,
  tqStats,
  sourceQuestions,
  onQuestionSave,
  onQuestionDelete,
  onQuestionApprove,
  onQuestionTranslate,
  translatingQuestionIds,
}: QuestionsPanelBodyProps) {
  const { t } = useTranslation();
  const renderQuestionCard = (r: TqRow) => (
    <QuestionCard
      key={r.id}
      row={r}
      sourceQuestion={sourceQuestions.get(r.id) ?? null}
      onSave={(p) => onQuestionSave(r.id, p)}
      onDelete={() => onQuestionDelete(r.id)}
      onApprove={onQuestionApprove ? () => onQuestionApprove(r.id, true) : undefined}
      onUnapprove={onQuestionApprove ? () => onQuestionApprove(r.id, false) : undefined}
      onTranslate={onQuestionTranslate ? () => onQuestionTranslate(r.id) : undefined}
      isTranslating={translatingQuestionIds?.has(r.id) ?? false}
      locked={locked}
    />
  );
  return (
    <>
      <SectionHead
        title={t("shell.questions")}
        count={totalTq}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onAdd={onQuestionCreate}
        sticky
        hideAdd={locked}
        lane="tq"
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
              value={tqStats.total ? (tqStats.validated / tqStats.total) * 100 : 0}
              sx={{ flex: 1, height: 6, borderRadius: 99, minWidth: 60 }}
            />
            <Typography variant="caption" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
              {tqStats.validated} / {tqStats.total}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {onQuestionApprove && (
            <Button
              size="small"
              variant="outlined"
              color="success"
              startIcon={<CheckIcon sx={{ fontSize: "15px !important" }} />}
              disabled={tqStats.draftIds.length === 0}
              onClick={() => {
                for (const id of tqStats.draftIds) onQuestionApprove(id, true);
              }}
              sx={{ minWidth: 0, fontSize: 11 }}
            >
              {t("common.approveAll")} ({tqStats.draftIds.length})
            </Button>
          )}
        </Stack>
      )}
      {tqGroups ? (
        tqGroups.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            {t("shell.noQuestionsInChapter")}
          </Typography>
        ) : (
          tqGroups.map(([verse, rows]) => (
            <Fragment key={`tq-${verse}`}>
              <VerseGroupHead verse={verse} active={verse === activeVerse} section="questions" />
              {translationMode ? (
                rows.map((r) => renderQuestionCard(r))
              ) : (
                <QuestionsTable rows={rows} onSave={onQuestionSave} onDelete={onQuestionDelete} locked={locked} />
              )}
            </Fragment>
          ))
        )
      ) : translationMode ? (
        tqForVerse.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            {t("questions.noQuestionsForVerse")}
          </Typography>
        ) : (
          tqForVerse.map((r) => renderQuestionCard(r))
        )
      ) : (
        <QuestionsTable rows={tqForVerse} onSave={onQuestionSave} onDelete={onQuestionDelete} locked={locked} />
      )}
    </>
  );
}
