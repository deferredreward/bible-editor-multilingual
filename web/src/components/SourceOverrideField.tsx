import { useState } from "react";
import { Alert, CircularProgress, Link, Stack, TextField, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../sync/api";
import type { OrgDraftState } from "./OrgConfigDraftEditor";
import type { ResourceKey } from "../lib/orgDraft";
import { door43RepoUrl, verifyErrorKind, type SourceVerifyState } from "../lib/setupWizard";

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
// own url text + verify state; a success writes an { mode:'override', org, repo }
// selection into the shared draft, a failure leaves the resource blank (never a
// bad ref). A pasted URL may point at a DIFFERENT org than the default upstream.
export function SourceOverrideField({
  resource,
  state,
}: {
  resource: ResourceKey;
  state: OrgDraftState;
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
      state.setResourceSource(resource, { mode: "blank" });
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
        >
          {t(`setup.sourceUrlError.${verify.kind}`)}
        </Alert>
      )}
    </Stack>
  );
}
