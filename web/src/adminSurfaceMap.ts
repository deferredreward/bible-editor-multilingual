// Admin surface parity map — the single cross-reference between the classic
// admin UI (#/preferences, PreferencesWorkspace.tsx) and the new admin desk
// (#/admin/*, #/ai, #/style, #/curate, #/observe — AdminDesk.tsx + screens).
//
// Why this exists: nav/section lists for the two UIs are hand-written
// independently (AdminDesk.tsx's two nav arrays, PreferencesWorkspace.tsx's
// ALL_SECTIONS). Nothing used to tell anyone the other surface exists, which
// is exactly how the AI service and Localization sections ended up
// classic-only, and how Style grew a third terminology editor (see #191).
//
// This file is documentation-as-data — nothing imports it at runtime.
// adminSurfaceMap.test.mjs enforces that it stays honest: every classic
// section and every desk nav entry must have an entry here, and every
// pointer below must actually resolve in the file it claims to. Adding a
// section/route to either UI without registering it here fails that suite.
//
// When classic retires (#173), delete its `classic` pointers entry-by-entry;
// this map keeps working as the desk's own feature inventory.

export interface SurfacePointer {
  /** Literal id/key/hash that must appear (as a quoted string) verbatim in `file`. */
  id: string;
  /** Repo-relative path. */
  file: string;
}

export interface SurfaceGap {
  side: "classic" | "desk";
  issue: number;
  note?: string;
}

export interface AdminSurfaceEntry {
  feature: string;
  label: string;
  classic?: SurfacePointer;
  desk?: SurfacePointer;
  gap?: SurfaceGap;
}

const PREFS = "web/src/components/PreferencesWorkspace.tsx";
const ADMIN_DESK = "web/src/components/flows/AdminDesk.tsx";
const ADMIN_SETUP = "web/src/components/flows/AdminSetupScreen.tsx";

export const ADMIN_SURFACE_MAP: AdminSurfaceEntry[] = [
  // ── Preferences ALL_SECTIONS ↔ Admin Setup desk sections ──────────────────
  {
    feature: "brief",
    label: "Brief",
    classic: { id: "brief", file: PREFS },
    desk: { id: "brief", file: ADMIN_SETUP },
  },
  {
    feature: "instructions",
    label: "Instructions",
    classic: { id: "instructions", file: PREFS },
    desk: { id: "instructions", file: ADMIN_SETUP },
  },
  {
    feature: "commonIssues",
    label: "Common issues",
    classic: { id: "commonIssues", file: PREFS },
    desk: { id: "commonIssues", file: ADMIN_SETUP },
  },
  {
    feature: "terminology",
    label: "Terminology",
    classic: { id: "terminology", file: PREFS },
    desk: { id: "terminology", file: ADMIN_SETUP },
    gap: {
      side: "desk",
      issue: 190,
      note: "desk copy (AdminSetupScreen's TerminologyPanel) is read-only; the full add/edit/status/CSV-import editor still lives only in classic",
    },
  },
  {
    feature: "examples",
    label: "Examples",
    classic: { id: "examples", file: PREFS },
    desk: { id: "examples", file: ADMIN_SETUP },
  },
  {
    feature: "setup",
    label: "Setup wizard",
    classic: { id: "setup", file: PREFS },
    desk: { id: "setup", file: ADMIN_DESK },
  },
  {
    feature: "localization",
    label: "Localization (UI string overrides)",
    classic: { id: "localization", file: PREFS },
    gap: { side: "desk", issue: 189, note: "no desk equivalent yet — still classic-only" },
  },
  {
    feature: "users",
    label: "Team & roles",
    classic: { id: "users", file: PREFS },
    desk: { id: "team", file: ADMIN_DESK },
  },
  {
    feature: "aiService",
    label: "AI service (provider/model/API key)",
    classic: { id: "aiService", file: PREFS },
    gap: { side: "desk", issue: 188, note: "no desk equivalent yet — still classic-only" },
  },

  // ── Desk-only surfaces (no classic Preferences analog expected) ───────────
  { feature: "workflow", label: "Workflow", desk: { id: "workflow", file: ADMIN_DESK } },
  { feature: "progress", label: "Progress", desk: { id: "progress", file: ADMIN_DESK } },
  { feature: "aiStudio", label: "AI studio", desk: { id: "#/ai", file: ADMIN_DESK } },
  { feature: "style", label: "Style", desk: { id: "#/style", file: ADMIN_DESK } },
  { feature: "templates", label: "Templates", desk: { id: "#/curate", file: ADMIN_DESK } },
  { feature: "observe", label: "Observe", desk: { id: "#/observe", file: ADMIN_DESK } },
];
