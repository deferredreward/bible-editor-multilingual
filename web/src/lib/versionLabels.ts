import type { ProjectConfig } from "../sync/api";

// Map an internal role code (the `bible_version` key stored in D1) to the
// project's DISPLAY label. Role codes stay ULT/UST/UHB/UGNT everywhere in the
// data + logic; only the rendered text changes per project (e.g. GLT/GST for a
// Gateway Language, or a named literal like "Van Dyke" via config override).
//
// Falls back to the role code when the config is absent (first paint, offline)
// or carries an older schema without the originals labels — so the UI never
// renders an empty header.
export function versionLabel(cfg: ProjectConfig | null, roleCode: string): string {
  if (!cfg) return roleCode;
  switch (roleCode) {
    case "ULT":
      return cfg.litLabel || roleCode;
    case "UST":
      return cfg.simLabel || roleCode;
    case "UHB":
      return cfg.origHebrewLabel || roleCode;
    case "UGNT":
      return cfg.origGreekLabel || roleCode;
    default:
      return roleCode;
  }
}
