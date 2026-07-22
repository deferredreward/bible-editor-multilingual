// Small shared helper that fires the AI "translate" pipeline for a whole book
// (notes + questions), reusing the same pipelineStore.start path the per-chapter
// PipelineMenu uses. Factored here so the IMPORT surface can kick off an AI
// draft right after a translate-intent import without duplicating that wiring.
//
// The translate pipeline runs one chapter at a time on the bot (see PipelineMenu,
// which loops per chapter), so we loop too: notes for every chapter, then
// questions. Each start is independent — one conflict/queue-full ("already
// running") or failure must not abort the rest, so every call is guarded.

import { pipelineStore, getSessionKey } from "../sync/pipelineStore";
import type { TranslateRequestOptions } from "../sync/api";

export interface AiTranslateResult {
  /** New runs actually started. */
  started: number;
  /** Chapters already covered by an in-flight run (server said already_running). */
  skipped: number;
  /** Starts that threw (e.g. conflict with another translator, network). */
  failed: number;
}

// notes = default translate; questions = translate with resourceType: "tq".
const RESOURCE_RUNS: TranslateRequestOptions[] = [{}, { resourceType: "tq" }];

/**
 * Start AI-translate (notes + questions) across the given chapters of `book`.
 * Best-effort: never throws — returns a per-run tally instead.
 */
export async function startBookAiTranslate(
  book: string,
  chapters: number[],
): Promise<AiTranslateResult> {
  const result: AiTranslateResult = { started: 0, skipped: 0, failed: 0 };
  for (const translate of RESOURCE_RUNS) {
    for (const chapter of chapters) {
      try {
        const res = await pipelineStore.start({
          pipelineType: "translate",
          book,
          startChapter: chapter,
          endChapter: chapter,
          sessionKey: getSessionKey(),
          translate,
        });
        if (res.status === "already_running") result.skipped++;
        else result.started++;
      } catch {
        result.failed++;
      }
    }
  }
  return result;
}
