const SESSION_KEY_LS = "bible-editor.pipeline.sessionKey";

let boundUserId: number | null = null;

function sessionKeyStorageKey(userId: number | null): string {
  return userId === null ? SESSION_KEY_LS : `${SESSION_KEY_LS}.${userId}`;
}

export function setPipelineUser(userId: number | null): void {
  boundUserId = typeof userId === "number" && Number.isFinite(userId) ? userId : null;
}

export function currentPipelineUserId(): number | null {
  return boundUserId;
}

export function getSessionKey(): string {
  const userPart = boundUserId ?? "anon";
  const storageKey = sessionKeyStorageKey(boundUserId);
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
  } catch {
    /* private mode / no storage */
  }
  const fresh = `bible-editor/${userPart}/${crypto.randomUUID()}`;
  try {
    localStorage.setItem(storageKey, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}
