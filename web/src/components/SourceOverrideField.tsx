import { useState } from "react";
import { Alert, Button, CircularProgress, Link, Stack, TextField, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import type { ResourceKey } from "../lib/orgDraft";
import {
  door43RepoUrl,
  verifyErrorKind,
  clearedOverrideSelection,
  pendingOverrideSelection,
  type SourceVerifyState,
} from "../lib/setupWizard";

// A reader-friendly `org: repo` chip that links the repo name to its Door43 page.
export function RepoRef({ org, repo }: { org: string; repo: string }) {
  return (
    <Typography variant="body2" component="span">
      {org}:{" "}
      <Link href={door43RepoUrl(org, repo)} target="_blank" rel="noopener noreferrer">
        {repo}
        <OpenInNewIcon fontSize="inherit" sx={{ verticalAlign: "middle", ml: 0.25 }} />
      </Link>
    </Typography>
  );
}

// The pasted-URL → verified-source machine, shared by Step 2's per-resource row
// and Step 3's per-lane upstream control so the two can never drift. Manages its
// own url text + verify state. A success writes { mode:'override', org, repo }.
// A verification FAILURE (400/404 invalid OR 503/unreachable transient) must NOT
// blank the resource — that would silently persist a valid custom source (chosen
// during a DCS blip) as omitted. Instead it stays a PENDING override (no repo),
// which the Apply gate blocks on until the user re-verifies or genuinely clears
// the field. Only an emptied field (a real user clear) blanks the source.
// A pasted URL may point at a DIFFERENT org than the default upstream.
export function SourceOverrideField({
  resource,
  state,
  rowChecked = false,
}: {
  resource: ResourceKey;
  state: OrgDraftState;
  // Whether the owning resource row is checked (pull-from-upstream). Determines
  // what an emptied URL resets to — upstream when checked, blank otherwise.
  rowChecked?: boolean;
}) {
  const { t } = useTranslation();
  const sel = state.resourceSource[resource] ?? { mode: "upstream" };
  const [url, setUrl] = useState("");
  const [verify, setVerify] = useState<SourceVerifyState>(
    sel.mode === "override" && sel.repo
      ? { status: "verified", org: sel.org ?? state.upstreamOrg, repo: sel.repo }
      : { status: "idle" },
  );

  const onVerify = async () => {
    const raw = url.trim();
    if (!raw) {
      setVerify({ status: "idle" });
      // Clearing the field must clear any prior verified override — otherwise a
      // deleted URL leaves a stale ref in the draft that Apply would persist.
      state.setResourceSource(resource, clearedOverrideSelection(rowChecked));
      return;
    }
    setVerify({ status: "verifying" });
    try {
      const res = await api.verifySource(raw);
      setVerify({ status: "verified", org: res.org, repo: res.repo, fullName: res.fullName });
      state.setResourceSource(resource, { mode: "override", org: res.org, repo: res.repo });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      setVerify({ status: "error", kind: verifyErrorKind(status) });
      // Do NOT blank on failure — keep it a pending override so Apply is blocked
      // (a transient 503 must never silently drop a real source to "omitted").
      state.setResourceSource(resource, pendingOverrideSelection());
    }
  };

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      <TextField
        size="small"
        fullWidth
        sx={{ maxWidth: 480 }}
        label={t("setup.sourceUrlLabel")}
        placeholder="https://git.door43.org/BibleAquifer/ar_tn"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void onVerify()}
        disabled={verify.status === "verifying"}
        InputProps={{
          endAdornment: verify.status === "verifying" ? <CircularProgress size={16} /> : undefined,
        }}
      />
      {verify.status === "verified" && (
        <Alert severity="success" variant="outlined" sx={{ py: 0 }}>
          <RepoRef org={verify.org} repo={verify.repo} />
        </Alert>
      )}
      {verify.status === "error" && (
        <Alert
          severity={verify.kind === "unreachable" ? "warning" : "error"}
          variant="outlined"
          sx={{ py: 0 }}
          action={
            // A transient DCS failure is retryable with the same URL; an invalid
            // URL needs an edit (re-blur re-verifies) so no retry button there.
            verify.kind === "unreachable" ? (
              <Button color="inherit" size="small" onClick={() => void onVerify()}>
                {t("setup.upstreamOrgRetry")}
              </Button>
            ) : undefined
          }
        >
          {t(`setup.sourceUrlError.${verify.kind}`)}
        </Alert>
      )}
    </Stack>
  );
}
