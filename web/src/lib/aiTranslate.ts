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

// Cap in-flight pipeline starts. A whole book (e.g. Psalms → 2×150 = 300 starts)
// must not fire sequentially — that spins the UI for a minute and lets one hung
// request stall everything behind it. A small pool keeps it responsive while
// staying gentle on the bot's start endpoint.
const START_CONCURRENCY = 4;

interface StartUnit {
  chapter: number;
  translate: TranslateRequestOptions;
}

/**
 * Start AI-translate (notes + questions) across the given chapters of `book`.
 * Best-effort with bounded concurrency: never throws — returns a per-run tally.
 */
export async function startBookAiTranslate(
  book: string,
  chapters: number[],
): Promise<AiTranslateResult> {
  const result: AiTranslateResult = { started: 0, skipped: 0, failed: 0 };

  // Flatten to a work queue of (chapter × resource) units, then drain it with a
  // fixed pool of workers so at most START_CONCURRENCY requests are in flight.
  const units: StartUnit[] = [];
  for (const translate of RESOURCE_RUNS) {
    for (const chapter of chapters) units.push({ chapter, translate });
  }

  let next = 0;
  const runOne = async (unit: StartUnit) => {
    try {
      const res = await pipelineStore.start({
        pipelineType: "translate",
        book,
        startChapter: unit.chapter,
        endChapter: unit.chapter,
        sessionKey: getSessionKey(),
        translate: unit.translate,
      });
      if (res.status === "already_running") result.skipped++;
      else result.started++;
    } catch {
      result.failed++;
    }
  };

  const worker = async () => {
    while (next < units.length) {
      const unit = units[next++];
      await runOne(unit);
    }
  };

  const pool = Math.min(START_CONCURRENCY, units.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return result;
}
