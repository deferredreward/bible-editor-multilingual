// Client-side notion of "which org am I in" — the localStorage mirror of the
// server's be_ws cookie. Kept dependency-free (no imports from api.ts) so
// outbox.ts can import it without creating a module cycle (outbox.ts already
// imports from api.ts).

const STORAGE_KEY = "bible-editor.workspace";

export function getWorkspaceSlug(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "default";
  } catch {
    // Privacy-mode localStorage throws on access — fall back to the implicit
    // single-workspace default rather than crashing module init.
    return "default";
  }
}

export function setWorkspaceSlug(slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    /* private mode — nothing we can do, next boot re-derives from the server */
  }
}
