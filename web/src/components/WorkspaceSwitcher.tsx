// Org (workspace) switcher. Three variants share one data source + switch flow:
//   • "expanded" (top of Preferences, ALL roles) — the canonical, interactive org
//     switch. Renders even for a single-org deployment (read-only current-org note).
//   • "indicator" (TopBar) — a compact, NON-interactive chip showing the current
//     org; clicking it navigates to Preferences where the real switch lives.
//     Renders nothing for a single-org deployment (nothing to switch to).
//   • "menu" (legacy default) — the old top-bar dropdown; retained for safety.
// The switch flow (guard pending outbox ops → api.switchWorkspace → persist →
// full reload) is identical across variants — see handleSelect below.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import BusinessIcon from "@mui/icons-material/Business";
import { api, ApiError, type WorkspaceInfo } from "../sync/api";
import { outbox, isOpPending } from "../sync/outbox";
import { getWorkspaceSlug, setWorkspaceSlug, setWorkspaceIsFallback } from "../sync/workspace";

type Variant = "menu" | "indicator" | "expanded";

export function WorkspaceSwitcher({ variant = "menu" }: { variant?: Variant }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [current, setCurrent] = useState<string>(getWorkspaceSlug());
  const [membershipUnknown, setMembershipUnknown] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [switching, setSwitching] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listWorkspaces()
      .then((res) => {
        if (cancelled) return;
        setWorkspaces(res.workspaces);
        setCurrent(res.current);
        setMembershipUnknown(!!res.membershipUnknown);
      })
      .catch(() => {
        // Fetch failure — behave as a single-org deployment (render nothing)
        // rather than surface an error for a control most installs don't have.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentWorkspace = workspaces.find((w) => w.slug === current);
  const multiOrg = workspaces.length > 1;

  // Identical switch flow for every variant: never switch with unsynced edits,
  // then reload so no old-org hook state survives the D1 rebind.
  const handleSelect = async (slug: string) => {
    setAnchorEl(null);
    if (slug === current) return;

    const ops = await outbox.list();
    const pendingCount = ops.filter(isOpPending).length;
    if (pendingCount > 0) {
      setErrorMsg(t("workspace.unsavedEditsBlock", { n: pendingCount }));
      return;
    }

    setSwitching(true);
    try {
      await api.switchWorkspace(slug);
      setWorkspaceSlug(slug);
      // Persist alongside the slug so outbox.ts's outboxDbName() picks the
      // right IndexedDB name (unsuffixed for the fallback workspace) on the
      // reload below, without waiting on a follow-up /api/auth/me round-trip.
      const target = workspaces.find((w) => w.slug === slug);
      if (target) setWorkspaceIsFallback(target.isFallback);
      // Deliberate full reload: every hook's cached chapter/book/config state
      // belongs to the old org and must not survive the switch.
      location.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setErrorMsg(t("workspace.notAMember"));
      } else if (e instanceof ApiError && e.status === 404) {
        setErrorMsg(t("workspace.noLongerAvailable"));
      } else {
        setErrorMsg(t("workspace.switchFailed"));
      }
      setSwitching(false);
    }
  };

  const errorSnackbar = (
    <Snackbar
      open={errorMsg !== null}
      autoHideDuration={6000}
      onClose={() => setErrorMsg(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    >
      <Alert severity="warning" onClose={() => setErrorMsg(null)}>
        {errorMsg}
      </Alert>
    </Snackbar>
  );

  // ── Compact, non-interactive top-bar indicator ────────────────────────────
  // Only meaningful when there's somewhere to switch to; a single-org install
  // stays as uncluttered as it is today (renders nothing).
  if (variant === "indicator") {
    if (!multiOrg) return null;
    return (
      <Tooltip title={t("workspace.indicatorTooltip")}>
        <Chip
          size="small"
          variant="outlined"
          icon={<BusinessIcon fontSize="small" />}
          label={currentWorkspace?.label ?? current}
          onClick={() => {
            // Land on Preferences (not /setup): the org switcher now lives at the
            // top of the Preferences content for ALL roles, so a non-admin reaches
            // it here too — /setup would render an empty view for non-admins.
            location.hash = "#/preferences";
          }}
          sx={{ color: "text.secondary", cursor: "pointer", maxWidth: 200 }}
        />
      </Tooltip>
    );
  }

  // ── Canonical switcher, Preferences → Setup ───────────────────────────────
  if (variant === "expanded") {
    return (
      <Box
        component="section"
        aria-labelledby="org-switch-heading"
        sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, mb: 3 }}
      >
        <Stack spacing={1.5}>
          <Box>
            <Typography id="org-switch-heading" variant="h6">
              {t("workspace.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("workspace.intro")}
            </Typography>
          </Box>
          {multiOrg ? (
            <TextField
              select
              size="small"
              label={t("workspace.selectLabel")}
              value={current}
              onChange={(e) => void handleSelect(e.target.value)}
              disabled={switching}
              sx={{ minWidth: 320, maxWidth: 420 }}
              helperText={membershipUnknown ? t("workspace.membershipUnknownHint") : undefined}
            >
              {workspaces.map((w) => (
                <MenuItem key={w.slug} value={w.slug} disabled={!w.allowed}>
                  {w.label}
                  {!w.allowed ? ` · ${t("workspace.notMemberTooltip")}` : ""}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <>
              <TextField
                size="small"
                label={t("workspace.currentLabel")}
                value={currentWorkspace?.label ?? current}
                InputProps={{ readOnly: true }}
                variant="filled"
                sx={{ minWidth: 320, maxWidth: 420 }}
              />
              <Typography variant="caption" color="text.secondary">
                {t("workspace.singleOrgNote")}
              </Typography>
            </>
          )}
        </Stack>
        {errorSnackbar}
      </Box>
    );
  }

  // ── Legacy top-bar dropdown (default) ─────────────────────────────────────
  if (!multiOrg) return null;

  return (
    <>
      <Tooltip title={t("workspace.switchTooltip")}>
        <Button
          size="small"
          variant="text"
          color="inherit"
          startIcon={<BusinessIcon fontSize="small" />}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          disabled={switching}
          sx={{ textTransform: "none", color: "text.secondary" }}
        >
          {currentWorkspace?.label ?? current}
        </Button>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {membershipUnknown && (
          <>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ px: 2, py: 0.5, display: "block", maxWidth: 280 }}
            >
              {t("workspace.membershipUnknownHint")}
            </Typography>
            <Divider />
          </>
        )}
        {workspaces.map((w) => {
          const item = (
            <MenuItem
              key={w.slug}
              selected={w.slug === current}
              disabled={!w.allowed}
              onClick={() => void handleSelect(w.slug)}
            >
              <ListItemIcon sx={{ visibility: w.slug === current ? "visible" : "hidden" }}>
                <CheckIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{w.label}</ListItemText>
            </MenuItem>
          );
          return w.allowed ? (
            item
          ) : (
            <Tooltip key={w.slug} title={t("workspace.notMemberTooltip")}>
              {/* span wrapper so the tooltip still fires on a disabled MenuItem */}
              <span>{item}</span>
            </Tooltip>
          );
        })}
      </Menu>
      {errorSnackbar}
    </>
  );
}
