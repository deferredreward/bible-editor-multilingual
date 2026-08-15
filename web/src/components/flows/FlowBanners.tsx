// TODO(i18n): plain English literals in this file need keys added to
// web/src/i18n/locales/*.json — this slice ships with hard-coded strings.
//
// Banners shared by the flow screens, styled after .banner / .banner--lock /
// .banner--ready in docs/flows/ui/_tokens.css. Neither is dismissible — the
// mockup's lock banner (docs/flows/ui/t2-review.html) carries an action and no
// close control, and a banner that reports live server state shouldn't be
// hideable while that state still holds.

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";

// Pipeline type -> human label. Keys are api/src/pipelines.ts's PIPELINE_TYPES.
// Anything unknown (or missing) degrades to a generic label rather than being
// rendered raw or invented.
const PIPELINE_LABELS: Record<string, string> = {
  generate: "AI generate",
  notes: "AI notes",
  tqs: "AI questions",
  translate: "AI translate",
};

// "3 min ago" style suffix, or null when the timestamp is absent/unparseable —
// in which case the banner simply omits the clause instead of guessing.
//
// The real `chapter_locked` 409 body sends `startedAt` as UNIX SECONDS, not an
// ISO string — see api/src/chapterLock.ts's ChapterLockedError (`startedAt:
// number`, filled from pipeline_jobs.created_at) and the mirrored
// ChapterLockedBody in web/src/sync/api.ts. A string is still accepted for any
// caller that has already formatted one.
function relativeTime(startedAt: string | number | null): string | null {
  if (startedAt == null || startedAt === "") return null;
  const then =
    typeof startedAt === "number" ? startedAt * 1000 : Date.parse(startedAt);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "less than a minute ago";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
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
  const label = (pipelineType && PIPELINE_LABELS[pipelineType]) || "an AI run";
  const since = relativeTime(startedAt);
  // Never name an editor: the lock body carries a pipeline, not a person.
  const message = since
    ? `Chapter locked — ${label} running since ${since}.`
    : `Chapter locked — ${label} running.`;
  return (
    <BannerShell
      tone="lock"
      icon="🔒"
      message={message}
      action={onMarkKeep ? { label: "Mark notes to keep", onClick: onMarkKeep } : undefined}
    />
  );
}

export interface ReadyBannerProps {
  count: number;
  onReview: () => void;
}

export function ReadyBanner({ count, onReview }: ReadyBannerProps) {
  return (
    <BannerShell
      tone="ready"
      icon="✨"
      message={count === 1 ? "1 AI draft ready" : `${count} AI drafts ready`}
      action={{ label: "Review", onClick: onReview }}
    />
  );
}
