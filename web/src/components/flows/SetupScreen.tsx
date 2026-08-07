// TODO(i18n) — flow screens ship English literals until the i18n sweep.
//
// a1-setup: admin setup wizard. Port of docs/flows/ui/a1-setup.html — that
// mockup's 5 steps (organization / sources / lanes / review & apply / done)
// are NOT re-implemented here. web/src/components/SetupWizard.tsx already IS
// that wizard, wired to the real endpoints (org search + inferred-config,
// verify-source, PUT /api/project-config with its honest 409
// project_not_empty, PATCH /api/project-config/mode) and already reused by
// PreferencesWorkspace.tsx's "setup" section. Rebuilding a second copy of its
// apply/409/lane-lock/migration state machine here — much of it concurrency-
// safety logic this repo has been burned by before (see CLAUDE.md's alignment
// history) — would be strictly worse than the original: more code, no more
// real, and a second place for that logic to drift out of sync. So this
// screen supplies only what the mockup adds on top of the wizard itself: the
// flow chrome (nav, page header, band-aware width) and the admin-only gate.
//
// Known gap vs. the mockup: a1-setup.html draws a step rail that is a side
// column on desktop and a horizontal strip on phone. SetupWizard's own
// Stepper is vertical at every width (MUI <Stepper orientation="vertical">).
// Changing that is out of this file's scope — it lives inside SetupWizard.tsx,
// which this task does not touch — so the rail stays vertical on phone too.
// Vertical steps remain fully usable narrow (each step's header and controls
// still fit one column), so this is a visual deviation, not a functional one.
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { FlowNav } from "./FlowNav";
import type { FlowScreenContext } from "./types";
import { SetupWizard } from "../SetupWizard";
import { WorkspaceChoiceDialog } from "../WorkspaceChoiceDialog";

export interface SetupScreenProps extends FlowScreenContext {}

export default function SetupScreen({ role, me, onNavigate }: SetupScreenProps) {
  // Mirrors the mockup's step-5 "Preview workspace picker" button — reusing
  // the real dialog (already wired to GET /api/workspaces + the real switch
  // flow) rather than a fabricated preview list.
  const [wsPickerOpen, setWsPickerOpen] = useState(false);

  return (
    <Box sx={{ pb: 6 }}>
      <FlowNav
        current="setup"
        book={me?.lastBook ?? undefined}
        chapter={me?.lastChapter ?? undefined}
        verse={me?.lastVerse ?? undefined}
        role={role}
      />

      <Box sx={{ maxWidth: 900, marginInline: "auto", px: 2, pt: 3 }}>
        <Typography
          variant="caption"
          sx={{
            display: "block",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "text.secondary",
            mb: 0.5,
          }}
        >
          Bundle A · Stand up an org
        </Typography>
        <Typography variant="h5" sx={{ mb: 0.5 }}>
          Setup wizard
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3, maxWidth: 640 }}>
          Five linear steps: organization, sources to pull from, scripture lanes,
          review &amp; apply, done. Admin role only.
        </Typography>

        {role !== "admin" ? (
          // Honest admin-only state — no wizard content leaks to a non-admin
          // role, and nothing is fabricated in its place.
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography variant="subtitle1" gutterBottom>
              Admin only
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The setup wizard configures which Door43 sources this project
              pulls from and where it writes — only an admin can change that.
              Your role is <strong>{role}</strong>. Ask a project admin to make
              changes here, or continue with your regular work.
            </Typography>
            <Button
              variant="outlined"
              sx={{ mt: 2 }}
              onClick={() => onNavigate(me?.lastBook || "OBA", me?.lastChapter || 1, me?.lastVerse || 1)}
            >
              Back to home
            </Button>
          </Paper>
        ) : (
          <>
            <Paper variant="outlined" sx={{ p: { xs: 2, tablet: 3 } }}>
              <SetupWizard />
            </Paper>

            <Box sx={{ mt: 2 }}>
              <Button variant="text" size="small" onClick={() => setWsPickerOpen(true)}>
                Preview workspace picker
              </Button>
            </Box>
            {wsPickerOpen && <WorkspaceChoiceDialog onClose={() => setWsPickerOpen(false)} />}
          </>
        )}
      </Box>
    </Box>
  );
}
