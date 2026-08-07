// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// a3-team: Admin — team & access. Port of docs/flows/ui/a3-team.html.
// Real allowlist management (add / edit role / remove / purge-manual),
// reusing the client calls already proven in UserManagementSection.tsx.
// The live Door43 org roster panel checks `body.error` even on a 200 —
// GET /api/admin/users/org-members can report a degraded read (e.g.
// "dcs_401_public_only") inside a successful response (05-functional-
// preview-findings.md §2.11) — and renders that honestly rather than as
// an empty-but-fine roster. Org switch reuses WorkspaceSwitcher's
// "expanded" variant, which already implements the org-switch-reloads-app
// semantics (guard pending outbox ops → switch → reload).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { FlowNav } from "./FlowNav";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import type { FlowScreenContext } from "./types";
import { api, ApiError, type AdminUser, type OrgMembersResponse } from "../../sync/api";

export interface TeamScreenProps extends FlowScreenContext {}

const ROLE_OPTIONS: Array<{ value: "admin" | "editor"; label: string }> = [
  { value: "editor", label: "Editor" },
  { value: "admin", label: "Admin" },
];

// Bare allowlist error codes (api/src/adminUserRoutes.ts) rendered as plain
// English — same codes UserManagementSection.tsx maps, kept in sync here
// rather than shared, since this screen has no i18n keys yet either.
function errorMessage(e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
  switch (code) {
    case "invalid_username":
      return "400 — invalid username";
    case "dcs_user_not_found":
      return "404 — no such Door43 user";
    case "last_admin":
      return "409 — can't do that to the only remaining admin";
    case "not_found":
      return "404 — not found";
    default:
      return e instanceof ApiError ? `${e.status} — ${code ?? "request failed"}` : "request failed";
  }
}

// Panel chrome shared by the three admin tables on this screen — top /
// body / foot, matching .panel / .panel-top / .panel-body / .panel-foot
// in docs/flows/ui/_tokens.css.
function Panel({
  title,
  sub,
  children,
  foot,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <Box
      component="section"
      sx={{
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
        overflow: "hidden",
        mb: 2,
      }}
    >
      <Box sx={{ px: 2, py: 1.5, borderBlockEnd: 1, borderColor: "divider" }}>
        <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 700 }}>
          {title}
        </Typography>
        {sub && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {sub}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: 2 }}>{children}</Box>
      {foot && (
        <Box
          sx={{
            px: 2,
            py: 1.25,
            borderBlockStart: 1,
            borderColor: "divider",
            bgcolor: "action.hover",
            fontSize: "0.8rem",
            color: "text.secondary",
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.5,
          }}
        >
          {foot}
        </Box>
      )}
    </Box>
  );
}

export default function TeamScreen({ role }: TeamScreenProps) {
  const isAdmin = role === "admin";

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersError, setUsersError] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrgMembersResponse | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "editor">("editor");
  const [adding, setAdding] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadAllowlist = useCallback(async () => {
    setUsersError(false);
    try {
      const { users } = await api.adminListUsers();
      setUsers(users);
    } catch {
      setUsersError(true);
    }
  }, []);

  const loadRoster = useCallback(async () => {
    try {
      setOrgMembers(await api.adminListOrgMembers());
    } catch {
      // Network failure reaching our own API (distinct from a degraded-but-200
      // Door43 read, which arrives as OrgMembersResponse.error below).
      setOrgMembers({ org: "", members: [], error: "network", truncated: false });
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadAllowlist();
    void loadRoster();
  }, [isAdmin, loadAllowlist, loadRoster]);

  const rosterLogins = orgMembers ? new Set(orgMembers.members.map((m) => m.login.toLowerCase())) : null;
  // A degraded-but-200 roster (body.error set, e.g. "dcs_401_public_only"),
  // a public-members fallback (partial), or a page-capped roster (truncated)
  // must not be read as "this org has no members" — distinguish all of these
  // incomplete-roster cases from a genuinely complete roster before flagging
  // any allowlist row as "not org member".
  const rosterDegraded = !!orgMembers?.error || !!orgMembers?.partial || !!orgMembers?.truncated;

  const handleAdd = async () => {
    const username = newUsername.trim();
    if (!username) return;
    setAdding(true);
    try {
      const res = await api.adminSetUserRole(username, newRole);
      let text = `Added ${username} as ${newRole}`;
      if (!res.dcsVerified) text += " (unverified — Door43 lookup failed, added anyway)";
      setMsg(text);
      setNewUsername("");
      setNewRole("editor");
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setAdding(false);
    }
    await loadAllowlist();
  };

  const handleRoleChange = async (username: string, roleValue: "admin" | "editor") => {
    setRowBusy(username);
    try {
      const res = await api.adminSetUserRole(username, roleValue);
      let text = `${username} is now ${roleValue}`;
      if (res.wasTeamManaged) text += " (Door43 team sync will re-take this on next login)";
      setMsg(text);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setRowBusy(null);
    }
    await loadAllowlist();
  };

  const handleRemove = async (username: string) => {
    if (!window.confirm(`Remove ${username} from the allowlist?`)) return;
    setRowBusy(username);
    try {
      const res = await api.adminRemoveUser(username);
      setMsg(
        res.wasTeamDerived
          ? `Removed ${username} (Door43 team sync will re-add on next login)`
          : `Removed ${username}`,
      );
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setRowBusy(null);
    }
    await loadAllowlist();
  };

  const manualUsers = (users ?? []).filter((u) => (u.source ?? "manual") === "manual");

  const handlePurge = async () => {
    setPurging(true);
    try {
      const res = await api.adminPurgeManualGrants();
      setMsg(
        res.kept.length
          ? `Removed ${res.removed.length}; kept ${res.kept.join(", ")} (last-admin guard)`
          : `Removed ${res.removed.length}`,
      );
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setPurging(false);
      setPurgeOpen(false);
    }
    await loadAllowlist();
  };

  if (!isAdmin) {
    return (
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
        <FlowNav current="team" role={role} />
        <Alert severity="info" sx={{ mt: 2 }}>
          Team &amp; access is admin-only. Your current role is {role}.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
      <FlowNav current="team" role={role} />

      <Box sx={{ mt: 2, mb: 2 }}>
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "primary.main" }}
        >
          Bundle A/team · Org access administration
        </Typography>
        <Typography variant="h5" sx={{ mt: 0.5 }}>
          Team &amp; user management
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Manual role grants layered on top of your Door43 org&apos;s team roles. Admin only.
        </Typography>
      </Box>

      <Box sx={{ mb: 2 }}>
        <WorkspaceSwitcher variant="expanded" />
      </Box>

      <Panel title="Add a person" sub="Grants a manual role. An unverified Door43 username still gets added, with an info note.">
        <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            label="Door43 username"
            placeholder="e.g. maria_traductora"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            sx={{ minWidth: 220 }}
          />
          <TextField
            select
            size="small"
            label="Role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "editor")}
            sx={{ minWidth: 140 }}
          >
            {ROLE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            onClick={() => void handleAdd()}
            disabled={adding || !newUsername.trim()}
            startIcon={adding ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            Add
          </Button>
        </Stack>
      </Panel>

      <Panel
        title="Allowlist"
        sub="Owners on Door43 are not automatically admins here — role is granted explicitly, and where a Door43 team also manages this user, team assignment wins over a manual grant on next sync."
        foot={
          <>
            <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {users === null
                ? usersError
                  ? "Load failed"
                  : "Loading…"
                : `Loaded via GET /api/admin/users — ${users.length} user(s)`}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              color="warning"
              startIcon={<DeleteOutlineIcon fontSize="small" />}
              onClick={() => setPurgeOpen(true)}
              disabled={manualUsers.length === 0}
            >
              Purge manual grants…
            </Button>
          </>
        }
      >
        {users === null ? (
          usersError ? (
            <Alert
              severity="error"
              action={
                <Button size="small" onClick={() => void loadAllowlist()}>
                  Retry
                </Button>
              }
            >
              Failed to load the allowlist.
            </Alert>
          ) : (
            <CircularProgress size={22} />
          )
        ) : users.length === 0 ? (
          <Typography color="text.secondary">No allowlisted users.</Typography>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Box
              component="table"
              sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", minWidth: 560 }}
            >
              <Box component="thead">
                <Box component="tr">
                  {["User", "Role", "Added by", "Source", ""].map((h) => (
                    <Box
                      component="th"
                      key={h}
                      sx={{
                        textAlign: "start",
                        fontSize: "0.7rem",
                        fontWeight: 700,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                        py: 1,
                        px: 1.5,
                        borderBlockEnd: 1,
                        borderColor: "divider",
                      }}
                    >
                      {h}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {users.map((u) => {
                  const notMember = rosterLogins && !rosterDegraded && !rosterLogins.has(u.username.toLowerCase());
                  return (
                    <Box component="tr" key={u.username}>
                      <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider" }}>
                        {u.username}
                        {notMember && (
                          <Tooltip title="Not currently a member of the Door43 org">
                            <Chip size="small" variant="outlined" color="warning" label="not org member" sx={{ ml: 1 }} />
                          </Tooltip>
                        )}
                      </Box>
                      <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider" }}>
                        <TextField
                          select
                          size="small"
                          value={u.role}
                          disabled={rowBusy === u.username}
                          onChange={(e) => void handleRoleChange(u.username, e.target.value as "admin" | "editor")}
                          sx={{ minWidth: 110 }}
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <MenuItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </MenuItem>
                          ))}
                        </TextField>
                      </Box>
                      <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider", color: "text.secondary" }}>
                        {u.addedBy ?? "—"}
                      </Box>
                      <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider", color: "text.secondary" }}>
                        {u.source === "dcs_team" ? "Door43 team" : "manual grant"}
                      </Box>
                      <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider" }}>
                        <Button
                          size="small"
                          color="error"
                          disabled={rowBusy === u.username}
                          onClick={() => void handleRemove(u.username)}
                        >
                          Remove
                        </Button>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
        )}
      </Panel>

      <Panel
        title="Live Door43 org roster"
        sub="Read-only reconciliation view — never writes a role. Falls back through admin token → shared service token → public members, so it always renders something."
        foot={
          <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
            {orgMembers === null
              ? "Loading…"
              : `Loaded via GET /api/admin/users/org-members${
                  orgMembers.error ? ` — degraded: ${orgMembers.error}${orgMembers.partial ? " (partial roster)" : ""}` : ` — ${orgMembers.members.length} member(s)`
                }`}
          </Typography>
        }
      >
        {orgMembers === null ? (
          <CircularProgress size={22} />
        ) : (
          <>
            {rosterDegraded && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                Door43 roster read failed ({orgMembers.error}) — the table below may be empty or incomplete;
                this is not evidence that the org has no members.
              </Alert>
            )}
            {orgMembers.partial && !rosterDegraded && (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                Showing the public-members fallback ({orgMembers.error ?? "team roles unavailable"}) — team
                roles may be missing for some members.
              </Alert>
            )}
            {orgMembers.members.length === 0 ? (
              <Typography color="text.secondary">
                No members returned{orgMembers.error ? ` (${orgMembers.error})` : ""}.
              </Typography>
            ) : (
              <Box sx={{ overflowX: "auto" }}>
                <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem", minWidth: 400 }}>
                  <Box component="thead">
                    <Box component="tr">
                      {["Door43 username", "Team role"].map((h) => (
                        <Box
                          component="th"
                          key={h}
                          sx={{
                            textAlign: "start",
                            fontSize: "0.7rem",
                            fontWeight: 700,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "text.secondary",
                            py: 1,
                            px: 1.5,
                            borderBlockEnd: 1,
                            borderColor: "divider",
                          }}
                        >
                          {h}
                        </Box>
                      ))}
                    </Box>
                  </Box>
                  <Box component="tbody">
                    {orgMembers.members.map((m) => (
                      <Box component="tr" key={m.login}>
                        <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider" }}>
                          {m.login}
                        </Box>
                        <Box component="td" sx={{ py: 1, px: 1.5, borderBlockEnd: 1, borderColor: "divider", color: "text.secondary" }}>
                          {m.teamRole ?? "—"}
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            )}
          </>
        )}
      </Panel>

      <Panel title="Read-only vs editor gating" sub="Notes on access, not editable here.">
        <Typography variant="body2" color="text.secondary">
          Viewer-role sessions get a global read-only banner and every mutating request outside a small
          self-scoped allowlist is 403&apos;d server-side (<code>blockViewerWrites</code>). Templates and
          tW/tA articles have <strong>no client-side role gating today</strong> — enforcement, if any, is
          server-side only and not surfaced in those editors; that gap is intentionally mirrored here, not
          silently fixed.
        </Typography>
      </Panel>

      <Dialog open={purgeOpen} onClose={() => !purging && setPurgeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Purge manual grants?</DialogTitle>
        <DialogContent>
          {manualUsers.length === 0 ? (
            <Typography variant="body2">No manually-granted rows to purge.</Typography>
          ) : (
            <Typography variant="body2">
              Purges every manually-granted role ({manualUsers.length}). Door43-team-derived rows are kept.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPurgeOpen(false)} disabled={purging}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => void handlePurge()}
            disabled={purging || manualUsers.length === 0}
            startIcon={purging ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            Purge
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}
