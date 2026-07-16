// Synchronous local freeze flags for scripture-lane replacement.
//
// The WS `lane.replacement_freeze` handler must block new drafts / outbox
// enqueues / aligner opens *immediately* — before the async project-config
// refresh lands. `projectConfig.laneState.*.replacementJobId` is the durable
// source of truth after refresh; this module covers the window between the
// freeze event and that refresh (and stays set until `lane.replacement_settled`
// clears it).
//
// Kept module-level so outbox.ts / drafts.ts can check without React.

type Listener = () => void;

const frozen = new Map<string, string>(); // bibleVersion → reason
const listeners = new Set<Listener>();
let epoch = 0;

function notify() {
  epoch += 1;
  for (const l of listeners) l();
}

export function markLaneFrozen(bibleVersion: string, reason: string): void {
  frozen.set(bibleVersion, reason);
  notify();
}

export function clearLaneFrozen(bibleVersion: string): void {
  if (!frozen.delete(bibleVersion)) return;
  notify();
}

export function isLaneFrozen(bibleVersion: string): boolean {
  return frozen.has(bibleVersion);
}

export function laneFreezeReason(bibleVersion: string): string | undefined {
  return frozen.get(bibleVersion);
}

export function subscribeLaneFreeze(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot for `useSyncExternalStore` — bumps on every freeze/thaw. */
export function getLaneFreezeEpoch(): number {
  return epoch;
}
