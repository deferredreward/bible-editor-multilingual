// Shared types + fanout helper for ChapterRoom broadcasts.
//
// Server-initiated path: rows.ts (and any other handler that mutates a
// chapter's row state) calls broadcastChapter(...) after the DB commit
// succeeds. The ChapterRoom DO receives a POST /broadcast and sends the
// stringified event to every connected WebSocket in the room.
//
// Wire format is a discriminated union on `type`. Clients dedupe by row
// version (incoming version <= local version → ignore), which also makes
// the originating user's own tab idempotent (their HTTP response already
// updated their state).

import type { Env } from "./index";
import type { CheckLane, RowKind, TnRow, TqRow, TwlRow, VerseDto, VerseLaneCheck, VerseStatus } from "./types";

// The current set of checkers for one (verse, lane) after a toggle. `checkers`
// is the full list of user ids so a receiving tab can recompute its own shade
// (you / someone else / both) regardless of which user originated the change.
export interface LaneCheckState {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checkers: number[];
}

export type WsEvent =
  | { type: "row.upserted"; kind: RowKind; row: TnRow | TqRow | TwlRow }
  | { type: "row.deleted"; kind: RowKind; id: string; version: number }
  | { type: "verse.updated"; verse: VerseDto }
  | { type: "verse_status.updated"; status: VerseStatus }
  | { type: "lane_check.updated"; check: LaneCheckState }
  // Bulk "I'm done with <lane> for this chapter": carries the full checker set
  // for the lane so receiving tabs replace the whole lane in one shot. The
  // single-verse event broadcasts one (verse, lane); broadcasting that per
  // verse here would be a fanout storm, so the bulk path sends one event.
  | { type: "lane_check.bulk"; book: string; chapter: number; lane: CheckLane; checks: VerseLaneCheck[] }
  // An AI pipeline just wrote rows into this chapter (out of the HTTP path, so
  // no row.upserted events fired). This is a coalesced *hint* — one per changed
  // chapter, not one per row — telling open tabs their row list is stale. The
  // client prompts the user to save and refresh rather than refetching silently.
  | { type: "chapter.pipeline_applied"; book: string; chapter: number; pipeline_type: string }
  // A scripture lane just froze for a replacement (source swap). Open tabs must
  // quarantine any queued edits for that lane's bible_version and stop editing
  // it until the replacement settles — the active generation is about to flip.
  | {
      type: "lane.replacement_freeze";
      lane: "lit" | "sim";
      jobId: string;
      predecessorGeneration: number;
      activeGeneration: number;
      configRevision: number;
      status: string;
    }
  // The replacement settled (activated / cancelled / failed) and the freeze
  // lifted. Open tabs refresh their project config + chapter so they pick up
  // the new generation's content (or the reverted state on cancel/fail).
  | {
      type: "lane.replacement_settled";
      lane: "lit" | "sim";
      jobId: string;
      predecessorGeneration: number;
      activeGeneration: number;
      configRevision: number;
      status: string;
    };

export async function broadcastChapter(
  env: Env,
  book: string,
  chapter: number,
  event: WsEvent,
): Promise<void> {
  try {
    const id = env.CHAPTER_ROOM.idFromName(`${book}:${chapter}`);
    const stub = env.CHAPTER_ROOM.get(id);
    await stub.fetch(
      new Request("http://do/broadcast", {
        method: "POST",
        body: JSON.stringify(event),
        headers: { "content-type": "application/json" },
      }),
    );
  } catch (e) {
    // A fanout failure shouldn't roll back a committed DB write — the row
    // is already persisted, the worst case is the other tab refreshes
    // manually (today's behavior).
    console.error("broadcastChapter failed", {
      book,
      chapter,
      type: event.type,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Fan a lane-scoped event (freeze / settled) out to every chapter room that
 * currently has content in D1. There's no global room registry — ChapterRoom
 * only tracks its own live sockets — so this coarse approach picks the set of
 * (book, chapter) rooms a translator could plausibly have open and broadcasts
 * to each. A room with no live sockets is a cheap no-op DO fetch. Capped so a
 * huge D1 can't blow the per-request subrequest budget; the freeze/settle is a
 * hint anyway (HTTP + generation guards are the source of truth), so missing a
 * rarely-open room just means that tab refreshes on its next action.
 */
export async function broadcastLaneEvent(env: Env, event: WsEvent): Promise<void> {
  try {
    const rs = await env.DB.prepare(
      `SELECT DISTINCT book, chapter FROM verses ORDER BY book, chapter LIMIT 500`,
    ).all<{ book: string; chapter: number }>();
    // Chunk the fanout so we don't launch 500 DO fetches at once (subrequest
    // budget); each chunk resolves before the next starts.
    const CHUNK = 50;
    for (let i = 0; i < rs.results.length; i += CHUNK) {
      const slice = rs.results.slice(i, i + CHUNK);
      await Promise.all(slice.map((r) => broadcastChapter(env, r.book, r.chapter, event)));
    }
  } catch (e) {
    console.error("broadcastLaneEvent failed", {
      type: event.type,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
