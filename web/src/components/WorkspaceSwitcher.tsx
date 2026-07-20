// Compact org switcher for the TopBar. Renders nothing at all for a
// single-org deployment (the common case today) — a bare button showing the
// current workspace only appears once a second workspace exists to switch to.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
  Snackbar,
  Alert,
  Divider,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import BusinessIcon from "@mui/icons-material/Business";
import { api, ApiError, type WorkspaceInfo } from "../sync/api";
import { outbox, isOpPending } from "../sync/outbox";
import { getWorkspaceSlug, setWorkspaceSlug, setWorkspaceIsFallback } from "../sync/workspace";

export function WorkspaceSwitcher() {
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

  // Single-org deployment must look exactly like today.
  if (workspaces.length <= 1) return null;

  const currentWorkspace = workspaces.find((w) => w.slug === current);

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
    </>
  );
}
