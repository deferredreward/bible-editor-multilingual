// Banners shared by the flow screens, styled after .banner / .banner--lock /
// .banner--ready in docs/flows/ui/_tokens.css. Neither is dismissible — the
// mockup's lock banner (docs/flows/ui/t2-review.html) carries an action and no
// close control, and a banner that reports live server state shouldn't be
// hideable while that state still holds.

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

// Pipeline type -> label key. Keys are api/src/pipelines.ts's PIPELINE_TYPES.
// Anything unknown (or missing) degrades to a generic label rather than being
// rendered raw or invented.
const PIPELINE_LABEL_KEYS: Record<string, string> = {
  generate: "flowTranslate.pipeline.generate",
  notes: "flowTranslate.pipeline.notes",
  tqs: "flowTranslate.pipeline.tqs",
  translate: "flowTranslate.pipeline.translate",
};

// "3 min ago" style suffix, or null when the timestamp is absent/unparseable —
// in which case the banner simply omits the clause instead of guessing.
//
// The real `chapter_locked` 409 body sends `startedAt` as UNIX SECONDS, not an
// ISO string — see api/src/chapterLock.ts's ChapterLockedError (`startedAt:
// number`, filled from pipeline_jobs.created_at) and the mirrored
// ChapterLockedBody in web/src/sync/api.ts. A string is still accepted for any
// caller that has already formatted one.
function relativeTime(startedAt: string | number | null, t: TFunction): string | null {
  if (startedAt == null || startedAt === "") return null;
  const then =
    typeof startedAt === "number" ? startedAt * 1000 : Date.parse(startedAt);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return t("flowTranslate.time.lessThanMinuteAgo");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("flowTranslate.time.minutesAgo", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("flowTranslate.time.hoursAgo", { count: hrs });
  const days = Math.floor(hrs / 24);
  return t("flowTranslate.time.daysAgo", { count: days });
}

interface BannerShellProps {
  tone: "lock" | "ready";
  icon: string;
  message: string;
  action?: { label: string; onClick: () => void };
}

function BannerShell({ tone, icon, message, action }: BannerShellProps) {
  const theme = useTheme();
  const c = tone === "lock" ? theme.palette.flows.warn : theme.palette.flows.ok;
  return (
    <Box
      role="status"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        flexWrap: "wrap",
        borderRadius: "9px",
        border: `1px solid ${c.main}`,
        background: c.soft,
        color: c.ink,
        paddingBlock: 1.25,
        paddingInline: 1.75,
        textAlign: "start",
      }}
    >
      <Box component="span" aria-hidden="true" sx={{ flex: "none" }}>
        {icon}
      </Box>
      {/* basis 220px (not 0) so the text never collapses next to a nowrap button */}
      <Typography variant="body2" sx={{ flex: "1 1 220px", minWidth: 0, color: "inherit" }}>
        {message}
      </Typography>
      {action && (
        <Button
          size="small"
          onClick={action.onClick}
          sx={{
            flex: "none",
            minHeight: 44,
            whiteSpace: "nowrap",
            color: "inherit",
            borderColor: c.main,
            fontWeight: 700,
          }}
          variant="outlined"
        >
          {action.label}
        </Button>
      )}
    </Box>
  );
}

export interface LockBannerProps {
  /** From the real 409 `chapter_locked` body. Null degrades to a generic label. */
  pipelineType: string | null;
  /**
   * Unix SECONDS from the same body (api/src/chapterLock.ts sends a number).
   * An ISO string is also accepted. Null omits the elapsed-time clause.
   */
  startedAt: string | number | null;
  onMarkKeep?: () => void;
}

export function LockBanner({ pipelineType, startedAt, onMarkKeep }: LockBannerProps) {
  const { t } = useTranslation();
  const labelKey = pipelineType ? PIPELINE_LABEL_KEYS[pipelineType] : undefined;
  const label = labelKey ? t(labelKey) : t("flowTranslate.pipeline.generic");
  const since = relativeTime(startedAt, t);
  // Never name an editor: the lock body carries a pipeline, not a person.
  const message = since
    ? t("flowTranslate.chapterLockedSince", { pipeline: label, since })
    : t("flowTranslate.chapterLockedRunning", { pipeline: label });
  return (
    <BannerShell
      tone="lock"
      icon="🔒"
      message={message}
      action={
        onMarkKeep
          ? { label: t("flowTranslate.markNotesToKeep"), onClick: onMarkKeep }
          : undefined
      }
    />
  );
}

export interface ReadyBannerProps {
  count: number;
  onReview: () => void;
}

export function ReadyBanner({ count, onReview }: ReadyBannerProps) {
  const { t } = useTranslation();
  return (
    <BannerShell
      tone="ready"
      icon="✨"
      message={t("flowTranslate.aiDraftsReady", { count })}
      action={{ label: t("flowTranslate.review"), onClick: onReview }}
    />
  );
}
