import { expect, test, request as apiRequest, type Locator } from "@playwright/test";
import { fetchChapter, mintToken, newUserContext } from "./helpers";
import { RTL_FIXTURE } from "./global-setup";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s1/s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// RTL direction guard (issue #293).
//
// An RTL regression — Arabic scripture rendered LTR in the flows notes view's
// lanes — reached the deployed dev worker and was caught by a human the night
// before a partner demo (fixed in PR #292, which wrapped the lane text in
// `dir="auto"`). Nothing automated guarded text direction, and the flows
// screens share no rendering code with the classic editor, so a fix in one
// place says nothing about the others. typecheck/build/lib tests can't see
// layout — only a real browser resolves `dir="auto"` and computed `direction`.
//
// This spec walks the four RTL-sensitive scripture surfaces and asserts the
// COMPUTED text direction, using each surface's real RTL path:
//
//   1. #/notes    — flows lane text, `dir="auto"` (the exact PR #292 surface)
//   2. #/questions— flows lane text, `dir="auto"` (the exact PR #292 surface)
//   3. classic    — ScriptureColumn, `dir` from versionIsRtl()
//   4. book view  — BookView, `dir` from versionIsRtl()
//
// The flows lanes are the tight guard: reverting PR #292 removes the
// `dir="auto"` wrapper, so the seeded Arabic lane resolves LTR and the `rtl`
// assertions on surfaces 1–2 fail. Surfaces 3–4 render RTL by SCRIPT — the
// Hebrew UHB original is unconditionally RTL via versionIsRtl() regardless of
// the (LTR) project direction — so they guard the classic/book direction path
// without needing an RTL workspace. The synthetic Arabic verse (global-setup's
// RTL_FIXTURE, ULT ZEC 6:1) drives the `dir="auto"` flows lanes; the classic
// and book surfaces assert on the Hebrew original, which the fixture leaves
// untouched. An English lane on each mixed flows screen anchors the `ltr` half.

/** getComputedStyle(...).direction of the element a locator resolves to. */
function computedDirection(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el as HTMLElement).direction);
}

/**
 * Computed direction of the scripture cell `${chapter}-${verse}-${version}`.
 * ScriptureColumn puts `dir` on the `[data-find-cell]` element itself; BookView
 * puts it on a descendant — so resolve the nearest element that actually bears
 * a `dir` attribute (self or descendant) and read ITS computed direction, since
 * `direction` inherits down and would read LTR on an ancestor above the `dir`.
 */
async function cellDirection(
  page: import("@playwright/test").Page,
  chapter: number,
  verse: number,
  version: string,
): Promise<string> {
  const cell = page.locator(`[data-find-cell="${chapter}-${verse}-${version}"]`).first();
  await cell.waitFor({ state: "visible", timeout: 15_000 });
  return cell.evaluate((el) => {
    const dirEl = (el.matches("[dir]") ? el : el.querySelector("[dir]")) ?? el;
    return getComputedStyle(dirEl as HTMLElement).direction;
  });
}

// A distinctive English substring from the UST of the fixture verse, captured
// from the seeded server so the `ltr` locator never hard-codes sample text that
// a future re-import could change.
async function ustSnippet(): Promise<string> {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const auth = await mintToken(probe, "rtl-probe");
  const chap = await fetchChapter(probe, auth.token, RTL_FIXTURE.book, RTL_FIXTURE.chapter);
  // fetchChapter's typed payload omits verses; read it off the raw shape.
  const ust = (chap as unknown as {
    verses?: Record<string, Record<string, { plain_text?: string }>>;
  }).verses?.UST?.[String(RTL_FIXTURE.verse)]?.plain_text;
  await probe.dispose();
  expect(ust, "expected an English UST plain_text for the fixture verse").toBeTruthy();
  // First ~6 words — long enough to be unique to this lane, short enough to
  // survive a highlight split within the lane span.
  return ust!.split(/\s+/).slice(0, 6).join(" ");
}

test.describe("RTL text direction on scripture surfaces (#293)", () => {
  // ── Surface 1: flows notes lanes (#/notes) — the PR #292 surface ──────────
  test("flows notes: Arabic lane is rtl, English lane is ltr", async ({ browser }) => {
    const english = await ustSnippet();
    const { context } = await newUserContext(browser, "rtl-notes");
    const page = await context.newPage();
    await page.goto(
      `/#/notes/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}/${RTL_FIXTURE.verse}`,
    );

    const arabicLane = page
      .locator('span[dir="auto"]')
      .filter({ hasText: RTL_FIXTURE.arabicUlt });
    await expect(arabicLane).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(arabicLane)).toBe("rtl");

    const englishLane = page.locator('span[dir="auto"]').filter({ hasText: english });
    await expect(englishLane.first()).toBeVisible();
    expect(await computedDirection(englishLane.first())).toBe("ltr");

    await context.close();
  });

  // ── Surface 2: flows questions lanes (#/questions) — the PR #292 surface ───
  test("flows questions: Arabic lane is rtl, English lane is ltr", async ({ browser }) => {
    const english = await ustSnippet();
    const { context } = await newUserContext(browser, "rtl-questions");
    const page = await context.newPage();
    await page.goto(`/#/questions/${RTL_FIXTURE.book}/${RTL_FIXTURE.chapter}`);

    const arabicLane = page
      .locator('span[dir="auto"]')
      .filter({ hasText: RTL_FIXTURE.arabicUlt });
    await expect(arabicLane).toBeVisible({ timeout: 15_000 });
    expect(await computedDirection(arabicLane)).toBe("rtl");

    const englishLane = page.locator('span[dir="auto"]').filter({ hasText: english });
    await expect(englishLane.first()).toBeVisible();
    expect(await computedDirection(englishLane.first())).toBe("ltr");

    await context.close();
  });

  // ── Surface 3: classic scripture pane (#/BOOK/CHAPTER) ─────────────────────
  test("classic scripture pane: Hebrew source is rtl, English is ltr", async ({ browser }) => {
    const { context } = await newUserContext(browser, "rtl-classic");
    const page = await context.newPage();
    await page.goto(`/#/${RTL_FIXTURE.book}/1`);

    // The Hebrew original renders RTL by script (versionIsRtl("UHB") === true),
    // independent of the LTR project direction.
    expect(await cellDirection(page, 1, 1, "UHB")).toBe("rtl");
    // An English target pane stays LTR under the default LTR project.
    expect(await cellDirection(page, 1, 1, "UST")).toBe("ltr");

    await context.close();
  });

  // ── Surface 4: classic book view (BookView, whole-book multi-version) ───────
  // BookView is the classic Shell's "book" scripture mode, not a route — it's
  // selected via localStorage (be:scriptureMode), and its visible columns come
  // from be:enabledVersions (default ["ULT","UST"], no source). Seed both before
  // first paint so the whole-book grid renders the Hebrew UHB column too. It is
  // separate rendering code from ScriptureColumn, so it needs its own guard.
  test("book view: Hebrew source is rtl, English is ltr", async ({ browser }) => {
    const { context } = await newUserContext(browser, "rtl-book");
    await context.addInitScript(() => {
      try {
        localStorage.setItem("be:scriptureMode", JSON.stringify("book"));
        localStorage.setItem("be:enabledVersions", JSON.stringify(["UHB", "ULT", "UST"]));
      } catch {
        /* private mode etc. */
      }
    });
    const page = await context.newPage();
    await page.goto(`/#/${RTL_FIXTURE.book}/1`);

    // Assert on chapter 1 verse 1 — the top of the book, loaded immediately
    // (BookView lazy-loads later chapters via IntersectionObserver).
    expect(await cellDirection(page, 1, 1, "UHB")).toBe("rtl");
    expect(await cellDirection(page, 1, 1, "UST")).toBe("ltr");

    await context.close();
  });
});
