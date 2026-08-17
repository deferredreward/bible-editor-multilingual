// Registry of every admin-facing feature and where it lives across the two
// admin UIs: classic Preferences (`#/preferences`, PreferencesWorkspace.tsx)
// and the new admin desk (`#/admin/*` + AdminDesk.tsx's "more tools" links).
// See issue #191.
//
// This file is documentation-as-data — nothing imports it at runtime.
// adminSurfaceMap.test.mjs verifies it against the real source: every
// section id in PreferencesWorkspace.tsx's `Section` union and every nav
// entry in AdminDesk.tsx's `AdminSection` union / "more tools" array must
// have a matching entry here, and every entry's `file`/`anchor` must
// actually exist in that file's source. Adding a section/nav entry to
// either UI without registering (or explicitly gapping) it here fails that
// test, on purpose — that's exactly the class of drift that let the AI
// service and Localization sections go classic-only, and let Style grow a
// third terminology editor (see #187, #188, #189, #190).

export interface AdminSurfaceRef {
  /** Path relative to web/src/ of the file that renders this surface. */
  file: string;
  /**
   * The literal string (section id, AdminSection key, or #/hash route) that
   * identifies this surface inside `file`. Must appear verbatim in the
   * file's source — checked by a plain substring search, not an AST parse.
   */
  anchor: string;
  /** Optional note on how complete this surface is relative to its sibling. */
  note?: string;
}

export interface AdminSurfaceEntry {
  /** Stable key for this admin-facing feature. */
  key: string;
  label: string;
  /** The classic Preferences surface, if this feature has one. */
  classic?: AdminSurfaceRef;
  /** The new admin-desk surface, if this feature has one. */
  desk?: AdminSurfaceRef;
  /**
   * Set when one side is intentionally or temporarily absent (not when a
   * feature simply never had a classic equivalent — e.g. Progress/Workflow
   * are desk-native pages, not gaps). Must cite the tracking issue.
   */
  gapIssue?: number;
}

const PREFS_FILE = "components/PreferencesWorkspace.tsx";
const DESK_FILE = "components/flows/AdminDesk.tsx";
const SETUP_SCREEN_FILE = "components/flows/AdminSetupScreen.tsx";

export const ADMIN_SURFACE_MAP: AdminSurfaceEntry[] = [
  {
    key: "brief",
    label: "Brief",
    classic: { file: PREFS_FILE, anchor: "brief" },
    desk: { file: SETUP_SCREEN_FILE, anchor: "brief" },
  },
  {
    key: "instructions",
    label: "Instructions",
    classic: { file: PREFS_FILE, anchor: "instructions" },
    desk: { file: SETUP_SCREEN_FILE, anchor: "instructions" },
  },
  {
    key: "commonIssues",
    label: "Common issues",
    classic: { file: PREFS_FILE, anchor: "commonIssues" },
    desk: { file: SETUP_SCREEN_FILE, anchor: "commonIssues" },
  },
  {
    key: "terminology",
    label: "Terminology",
    classic: { file: PREFS_FILE, anchor: "terminology", note: "full editor: add/edit/status/CSV import+export" },
    desk: { file: SETUP_SCREEN_FILE, anchor: "terminology", note: "read-only table, links out to classic to edit" },
    gapIssue: 190,
  },
  {
    key: "examples",
    label: "Examples",
    classic: { file: PREFS_FILE, anchor: "examples" },
    desk: { file: SETUP_SCREEN_FILE, anchor: "examples" },
  },
  {
    key: "setup",
    label: "Setup wizard",
    classic: { file: PREFS_FILE, anchor: "setup" },
    desk: { file: DESK_FILE, anchor: "setup" },
  },
  {
    key: "localization",
    label: "Localization (UI string overrides)",
    classic: { file: PREFS_FILE, anchor: "localization" },
    gapIssue: 189,
  },
  {
    key: "users",
    label: "Team & roles",
    classic: { file: PREFS_FILE, anchor: "users", note: "classic key is \"users\"" },
    desk: { file: DESK_FILE, anchor: "team", note: "desk key is \"team\" — same feature, different literal" },
  },
  {
    key: "aiService",
    label: "AI service (provider/model/API key)",
    classic: { file: PREFS_FILE, anchor: "aiService" },
    gapIssue: 188,
  },
  {
    key: "progress",
    label: "Progress",
    desk: { file: DESK_FILE, anchor: "progress", note: "desk-native page, no classic equivalent" },
  },
  {
    key: "workflow",
    label: "Workflow",
    desk: { file: DESK_FILE, anchor: "workflow", note: "desk-native page, no classic equivalent" },
  },
  {
    key: "aiStudio",
    label: "AI studio",
    desk: { file: DESK_FILE, anchor: "#/ai", note: "\"more tools\" link, not yet inside the desk shell (#186)" },
  },
  {
    key: "style",
    label: "Style",
    desk: { file: DESK_FILE, anchor: "#/style", note: "\"more tools\" link, not yet inside the desk shell (#186)" },
  },
  {
    key: "templates",
    label: "Templates",
    desk: { file: DESK_FILE, anchor: "#/curate", note: "\"more tools\" link, not yet inside the desk shell (#186)" },
  },
  {
    key: "observe",
    label: "Observe",
    desk: { file: DESK_FILE, anchor: "#/observe", note: "\"more tools\" link, not yet inside the desk shell (#186)" },
  },
];
