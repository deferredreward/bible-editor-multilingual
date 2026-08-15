# Functional preview — test-drive log, design findings, API-contract gaps

**What this is.** The 13 screens in [`ui/`](ui/) started life as static mockups: every
button showed a toast naming the endpoint it *would* call. This document records what
happened when those screens were wired to a **real** bible-editor backend running
locally against a real seeded copy of Zechariah — what worked, what broke, what the
mockups got wrong about the API, and what still looks off visually.

Three kinds of finding live here, and they are deliberately kept apart:

- **§2 API-contract gaps** — places where the mockups' recorded endpoint did not
  match what the server actually requires. This is design-debt information: the
  handles were *paths only*, and a path is not a contract.
- **§3 Test-drive log** — what was clicked, at what screen width, and what the
  backend actually returned.
- **§4 Design-quality findings** — fresh-eyes visual/layout problems, with severity.

Design source: PR #149, branch `claude/adaptive-ui-flows-editor-6c309f`.

---

## 1. How the preview is wired (summary)

The full run-it-yourself instructions are in [`README.md`](README.md#running-the-functional-preview).
The short version:

- One Cloudflare Worker (`wrangler dev`) serves **both** the API and the 13 HTML
  screens, from the **same origin**. This is not a convenience — it is required.
  Authentication is cookie-based, so a separate static file server on another port
  would have its cookies dropped and every write would silently fail.
- `ui/_api.js` is a real API client. It mirrors the semantics of the production
  client, `web/src/sync/api.ts`.
- `ui/_shell.js` keeps its toast, but the toast is now a *debug readout of a real
  network call* rather than a stand-in for one.

### 1.1 The single most important correction: there is no bearer token

The original wiring brief for this work assumed the preview would mint a JWT, store
it, and send `Authorization: Bearer …` on every call. **That would not have worked,
and it would not have failed loudly.**

This API is cookie-only. The `Authorization: Bearer` fallback was deliberately
removed; a request carrying a bearer token is treated as *unauthenticated*, not as
a 401. Reads are mostly public, so a bearer-token preview would have looked like it
worked — chapters would load — and then every single write would have failed with a
403, for reasons that pointed nowhere near the real cause.

What the server actually sets, on `POST /api/auth/dev`:

| Cookie | Flags | Purpose |
|---|---|---|
| `be_access` | HttpOnly, SameSite=Lax, 1h | the session JWT |
| `be_refresh` | HttpOnly, SameSite=Strict, 14d | silent re-mint |
| `be_csrf` | **not** HttpOnly, 14d | read by JS, echoed as `X-CSRF-Token` |

So every request must send `credentials: "include"`, every write must additionally
echo the CSRF cookie into an `X-CSRF-Token` header, and every request must carry
`X-Workspace`. Evidence: `web/src/sync/api.ts:256-291`, `api/src/index.ts:158`, and
`STATE.md`'s standing "This API is cookie-auth only" lesson.

---

## 2. API-contract gaps found by wiring the handles up

### 2.1 Headline: the paths were right; the *contracts* were missing

An audit of every `data-handle` in the 13 screens against the route table in
`api/src/**` produced a genuinely good result for the design branch:

> **Every distinct `METHOD /api/path` handle resolves to a real, registered
> route.** Zero invented paths, zero wrong methods, zero missing endpoints.

The count moved during this work and is worth stating precisely rather than
quoting a stale number. The *pre-wiring* tree carried **85** distinct API
handles; wiring the screens replaced many of them with direct `flowApi` calls,
so the tree now carries **55**. An independent review caught an earlier draft of
this document quoting 85 after the commit that reduced it — the substance held,
the number did not.

That is the design branch's rule — *"handles must be copied from the registry, never
invented"* — holding up under verification.

The real gap is a different shape. A handle records only a method and a path. About
**30 of those routes cannot actually be called from that information alone**, because
they also require a mandatory query parameter or a mandatory header. Wiring straight
from the handle produces a `400` or a `428`, not a save.

### 2.2 Mandatory inputs that no handle records

| Missing input | Affected handles | Failure when omitted |
|---|---|---|
| `?book=` | **all 14 `/api/rows/*` handles** | `400 {"error":"book_required"}` |
| `?id=` | the 4 `/api/templates/unit*` handles | `400 {"error":"id_required"}` |
| `?path=` | the 2 `/api/articles/:resource/unit*` handles | `400 {"error":"path_required"}` |
| `?book=&chapter=` | `GET /api/pending-imports` | `400 validation_failed` |
| `?url=` | `GET /api/orgs/verify-source` | `400 {"error":"empty_url"}` |
| `If-Match` | 12 write routes | **`428`** `{"error":"if_match_required"}` |
| `X-Source-Generation` | `PATCH /api/verses/…` | **`428`** `{"error":"source_generation_required"}` |

Verified live against the running Worker:

```
PATCH /api/rows/tn/qki3?book=ZEC   (no If-Match)  → 428 {"error":"if_match_required"}
PATCH /api/rows/tn/qki3            (no ?book)     → 400 {"error":"book_required"}
```

### 2.3 `428` is a real status this UI never modelled — **severity: high**

The mockups model two failure states: version conflict and chapter lock, both `409`.
The server has a third, and it is the one a fresh client hits first: **`428
Precondition Required`**, returned when a write arrives with no `If-Match` (or, for
verses, no `X-Source-Generation`).

This matters because `428` means something operationally different from `409`. A
`409` says *someone else changed this; here is their version, choose one*. A `428`
says *you did not tell me which version you are editing* — it is a client bug, and
showing a translator a merge prompt for it would be actively misleading.

**Recommendation:** treat `428` as a distinct, non-user-facing error class — log it,
re-read the row, retry once — and never surface the merge UI for it.

### 2.4 The first write to preferences must send `If-Match: 0` — **severity: medium**

`GET /api/translation-memory/prefs` on a project that has never saved preferences
returns a synthetic default row with `version: 0` rather than a `404`:

```json
{"prefs":{"id":1,"audience":null,…,"assisted_mode":0,"version":0,"updated_at":0}}
```

The subsequent `PUT` must therefore send `If-Match: 0`. A client that treats
`version: 0` as "no row yet, so omit the precondition" gets a `428` and can never
make its first save. This is easy to get wrong and worth a comment at the call site.

### 2.5 Two handles point at list endpoints that do not exist — **severity: medium**

Both are cases where the plural noun is not a route:

| Assumed | Reality |
|---|---|
| `GET /api/books/:book` | does not exist — the per-book summary is **`GET /api/chapters/:book`** |
| `GET /api/articles` | does not exist — the list is **`GET /api/articles/:resource`**, `:resource ∈ {tw, ta}` |

### 2.6 A handle in `t3-scripture.html` contains leaked JavaScript — **severity: low (cosmetic), but it breaks the registry**

`docs/flows/ui/t3-scripture.html:411` builds its handle by string concatenation:

```js
' data-handle="PATCH /api/chapters/:book/:chapter/:verse/lanes/' + lane + '"'
```

At runtime this is *correct* — it emits `…/lanes/tn`, which the real route
`PATCH /api/chapters/:book/:chapter/:verse/lanes/:lane` matches. But the handle is no
longer a stable static identifier: any tool that greps the registry sees the
unresolved source text, and every lane produces a different key. **Fixed** in this
branch by emitting the literal `:lane` and passing the actual lane via a data
attribute.

### 2.7 `chapter_locked` does not apply uniformly — **severity: low, but surprising**

`PATCH /api/rows/tn/:id` is **exempt** from the AI-pipeline chapter lock; the
equivalent `tq` and `twl` patches are **not**, and `DELETE` is not exempt for any
kind. A UI that renders one "chapter is locked, inputs disabled" banner across a
whole screen will therefore disable note editing that the server would actually have
accepted.

### 2.8 `workspace_mismatch` is a global 409 no screen models — **severity: low**

Every write passes through app-wide middleware that compares the `X-Workspace` header
against the workspace resolved from the `be_ws` cookie, and returns
`409 {"error":"workspace_mismatch","expected":"<slug>"}` on disagreement. The real
client responds by reconciling and reloading the tab. No mockup records this state.

### 2.9 One lane condition, two different API behaviours — **severity: medium**

A scripture lane awaiting replacement produces *two different* client-visible
behaviours for the same underlying state:

| Call | Behaviour when the lane is pending replacement |
|---|---|
| `GET /api/chapters/ZEC/1` | **200**, and the lane is **silently omitted** from `verses` |
| `GET /api/verses/ZEC/1/1/ULT` | **409** `{"error":"lane_replacement_required"}` |

Verified live, both against the same database state. The silent omission is the
more dangerous of the two: the scripture screen renders with no ULT/UST text, no
error, and nothing to indicate *why* — the verses are sitting in D1 the whole
time. It cost real debugging time during this exercise, and a translator would
have no path from the symptom to the cause.

Also worth recording, because it is easy to mistake for the same switch: three
independent flags gate this, and clearing only the obvious one is not enough.
`replacement_required` controls the chapter-read filtering;
`pending_target_json` (non-NULL) drives the 409 gate at
`api/src/scriptureLane.ts:399`; and `active_config_json.textReadOnly` separately
refuses verse writes with `403 source_text_is_read_only`.

**Recommendation:** make the chapter read explicit about an omitted lane — return
the lane with a status rather than dropping it — so the UI can say "this lane is
being replaced" instead of rendering a mystery blank.

#### 2.9a A **read** endpoint rewrites lane state — **severity: high**, and it cost this session real time

`GET /api/project-config` is not a pure read. It calls `overlayLaneLabels`
(`api/src/scriptureLane.ts:978`), which calls **`maybeHealLaneStateForPreset`**
(`:961`) — a write that reconciles lane state against the active preset.

Isolated by controlled experiment. Starting from `replacement_required = 0`:

| Request (authenticated) | `config_revision` | `replacement_required` |
|---|---|---|
| baseline | 8 | 0 |
| `GET /api/auth/me` | 8 | 0 |
| `GET /api/chapters/ZEC/1` | 8 | 0 |
| `GET /api/workspaces` | 8 | 0 |
| `GET /api/orgs/BSOJ/inferred-config` | 8 | 0 |
| **`GET /api/project-config`** | **9** | **1** |

The consequence is not academic. Because that read is issued on load by every
Admin and Lead screen, **opening the setup screen silently re-hid all ULT and UST
verses from the scripture screen.** During this session it reverted the fix three
separate times, produced an "only UHB is served" symptom that looked random,
and caused one agent to report scripture as unavailable when the rows were in
the database the whole time.

Note this is *deliberate* self-healing, not a coding error — the mechanism keeps
lane state consistent with the preset. The problems are that (a) it is triggered
by a `GET`, so callers cannot predict it, and (b) it silently changes what a
*different* endpoint returns.

The heal is satisfiable rather than defeatable: it only rewrites when the lane's
**source repo** differs from the preset's desired source (`sameLaneSource`,
`:970`). Clearing the flags while leaving the old `ar_glt`/`ar_gst` source is why
the naive fix kept being undone; pointing the active source at the preset's
`ar_avd`/`ar_nav` makes the heal a no-op. Verified stable across repeated reads —
see the README runbook.

**Recommendation:** move the heal out of the GET path (a startup/admin action, or
an explicit `POST …/reconcile`), or at minimum document that reading the project
config can change scripture visibility.

### 2.10 Original-language verses are correctly read-only — **not a defect**

`PATCH /api/verses/ZEC/1/1/UHB` → `403 {"error":"source_text_is_read_only"}`.
Only ULT/UST are writable. Any alignment UI must not offer to edit the Hebrew.

### 2.11 `GET /api/admin/users/org-members` reports failure inside a 200 — **severity: medium**

Observed live:

```json
HTTP 200  { "org": "...", "members": [], "error": "dcs_401_public_only", "truncated": false }
```

The Door43 roster lookup failed, but the HTTP status is `200`. A client that
only branches on `res.ok` renders an **empty team list** — indistinguishable from
an org that genuinely has no members. The distinction matters on an access-control
screen, where "nobody has access" and "we could not read who has access" call for
very different responses from an admin.

This is a defensible API design (the page stays usable), but it is a trap the
handle registry cannot express, and every consumer must remember to check
`body.error` on a successful response. Worth a comment at the call site.

### 2.12 Role management can't be exercised without live Door43 — **environmental, not a defect**

`PUT /api/admin/users/:username` returns `404 dcs_user_not_found` for a username
that does not exist on Door43, so the interesting `409 last_admin` guard is not
reachable in an offline preview. The dev session user (`dev`) is auto-granted
admin *without* a `user_roles` row, so it does not appear in the allowlist it is
administering — mildly confusing when reading the screen.

### 2.13 `l1-ai` offered a "Translate questions" pipeline that does not exist — **severity: medium**

The Lead screen's AI menu included a *Translate questions* action. There is no
`translate-tq` value in the `pipelineType` enum (`api/src/pipelines.ts`); the valid
set is `generate | notes | tqs | translate`, and translating questions is expressed
as `translate` with `translate.resourceType: "tq"`, not as its own pipeline type.

This is the one place a control implied a capability the API does not expose in
that shape. It is now disabled with a code comment rather than silently sending a
body the server would reject.

### 2.14 Template *Approve* 404s unless the row has a translation state — **severity: medium**

`POST /api/templates/unit/validate?id=…` returns `404` for a unit whose
`translation_state` is `NULL` — i.e. every template that the translate pipeline
has never touched. Since all 194 units in a fresh environment are in exactly that
state, Approve is unusable until a draft exists.

That is defensible server behaviour (there is nothing to validate), but the
mockup presented Approve as always available. It is now disabled with an
explanation when `translation_state` is `NULL`.

### 2.15 Terminology `concept_id` is a string, not a numeric id — **severity: low**

Easy to misread from the field name. Real values look like
`rc://*/tw/dict/bible/kt/god`. Passing a number is rejected.

### 2.16 Context-pack status degrades to `no_service_token` — **environmental**

`GET /api/translation-memory/export-status` reports a real degraded reason rather
than a sha, because `DCS_SERVICE_TOKEN` is absent locally. The Lead screen shows
that reason instead of inventing a pack sha — which is the correct behaviour for
the "context pack ready (sha)" trust chip the architecture doc requires.

### 2.17 "AI not configured" is genuinely reachable here — **not a defect**

The architecture spec requires screens to degrade gracefully when `BT_API_TOKEN` is
absent. In this local preview it *is* absent, so that state is exercised for real
rather than simulated:

```
POST /api/tn-quick → 503 {"error":"tn_quick_disabled"}
```

Same for `POST /api/templates/unit/draft` (`template_draft_disabled`),
`POST /api/pipelines/start` and `GET /api/pipelines/:jobId` (`pipeline_api_disabled`).
Note the asymmetry the spec calls out: `GET /api/pipelines` (the **list**) is *not*
gated and keeps returning `200` with an empty job list, so the observability screen
stays populated-but-empty rather than erroring.

---

### 2.18 Wiring gotcha in the preview's own shell: auto-dispatch can double-fire — **severity: medium (preview-only)**

This one is a defect in *this branch's* plumbing rather than in the app's API, but
it is the kind of thing that would bite anyone reusing the pattern.

`_shell.js` intercepts every click on `[data-handle]` and performs the real call.
A screen that *also* wires its own handler to the same button therefore triggers
**two** requests. Measured on `a4-observe`, instrumenting `window.fetch` and
clicking "Check now" once:

```
before:  { "/api/health": 2 }      ← shell dispatch + the screen's loadHealth()
after:   { "/api/health": 1 }
```

Two escape hatches exist, and both are correct depending on intent:

- **`data-handle-manual`** — the shell skips the network and only fires the
  `flow:handled` event, leaving the screen's own code to make the call. Right when
  the screen needs the response to render something.
- **listen to `flow:handled` and use `event.detail.result`** — right when the
  shell's generic call already returns what the screen needs.

The wrong pattern is "leave the handle live *and* re-fetch in a listener", which
is what produced the doubled health check.

Audited across all 13 screens: no screen double-fires a **write**. Every
`flow:handled` listener either refreshes a list after a mutation (correct) or
reconciles local state from `detail.result` (correct). The single genuine
duplicate was the `a4` health GET, now fixed.

## 3. Test-drive log

### 3.1 Method

Everything below was driven in a real browser against the local Worker at
`127.0.0.1:8891`, with the pages served from the **same origin** as the API so
the session cookies apply.

**One method note that matters.** An early measurement reported horizontal scroll
on every screen. It was wrong: the browser pane was reporting `innerWidth: 0`, so
`body.scrollWidth > window.innerWidth` was trivially true everywhere. Every
measurement below was taken with the viewport **explicitly sized first**. Had this
gone unnoticed it would have produced 39 fabricated findings.

Coverage was automated with a temporary same-origin harness that loaded each
screen in an iframe at each width, waited for async hydration, then measured the
real document from the parent. 14 pages × 3 widths = **42 probes**, run twice
(once before the fixes, once after).

### 3.2 Responsive sweep — final run

| Width | Result |
|---|---|
| 375 | **14/14 clean** — no horizontal body scroll, no JS errors |
| 768 | **14/14 clean** |
| 1280 | **14/14 clean** |

The first run found exactly one real layout defect, `t1-home @ 375`
(`scrollWidth 432` in a `375` viewport). Cause: `t1-home` is the only screen
carrying five top-bar controls, and the shared `.account-cluster` is
`flex: none; white-space: nowrap`, so it measured **378px on its own** and could
not shrink. Hiding the status pill's label at ≤560 (keeping the ● and the full
tap target, same jobs menu behind it) reclaimed ~60px. Re-measured: `scrollWidth`
375, all controls still present.

### 3.3 Concurrency contract — exercised against the real backend

Every one of these is an observed response, not a simulated state:

| Action | Result |
|---|---|
| Row write, no `If-Match` | `428 if_match_required` |
| Row write, no `?book=` | `400 book_required` |
| Row write, correct version | `200`, version incremented |
| Row write, stale version | `409 version_mismatch` + full `current` row |
| Verse `GET` (ULT) | `200`, version 1, generation 1, 24 verse objects |
| Verse write, both headers | `200`, v1 → v2 |
| Verse write, no `X-Source-Generation` | `428 source_generation_required` |
| Verse write, wrong generation | `409 source_generation_mismatch {expected:1, got:7}` |
| Verse write on UHB | `403 source_text_is_read_only` |
| `X-Workspace` disagreeing with session | `409 workspace_mismatch {expected:"bsoj"}` |
| `POST /api/tn-quick` | `503 tn_quick_disabled` |
| `POST /api/pipelines/start` | `503 pipeline_api_disabled` |
| `GET /api/pipelines` (not gated) | `200`, empty job list |

The **merge prompt** was driven end-to-end: `t2-review`'s conflict trigger sends a
deliberately stale `If-Match`, the server returns a real `409 version_mismatch`,
and the dialog opens populated from the server's actual `current` row — one
request, no double-fire.

### 3.4 Per-screen state

| Screen | Verified behaviour |
|---|---|
| `t1-home` | Real book/chapter counts from `GET /api/chapters/ZEC` (653 tn / 134 tq book-wide); real pipeline pill; honest "unknown" for the context-pack chip. Note the API returns **15** chapter entries for a 14-chapter book — it includes a chapter-0 front-matter row, so a naive "15 chapters" label reads as wrong |
| `t2-review` | 59 real notes + real questions for ZEC 1; real Save (200), real stale-Save (409 + merge), real Delete, real Preserve, real reorder |
| `t3-scripture` | Real UHB/ULT/UST panes (verified rendering ZEC 1:8 in all three); real verse-done + lane checkboxes (200); real verse save |
| `t4-align` | Real words from UHB/ULT; real `align/suggest` (genuinely empty here); **save deliberately disabled** — see 4.8 |
| `t5-articles` | Real `GET /api/articles/tw|ta`; honest empty state; one real tW article (`kt/god`) imported through the real endpoint |
| `t6-words` | 66 real word links for ZEC 1; real suggestions; real lexicon calls returning honest 404s |
| `l1-ai` | Real job list; real 503 → calm "AI not configured" state, not an error |
| `l2-style` | Real prefs incl. the `If-Match: 0` first write; real term add/delete; real CSV export/import; honest `no_service_token` pack state |
| `l3-templates` | 194 real template units; real edit + history; Approve correctly disabled (server 404s on `translation_state: NULL`) |
| `a1-setup` | Real project config + real org lookups (Door43 *was* reachable); real preset apply, which honestly `409 project_not_empty` |
| `a2-import` | Real book list/import/reimport/lint/sources; real lane-replacement lifecycle (started and backed out a real job) |
| `a3-team` | Real allowlist + real workspace switch; org roster shows the honest `dcs_401_public_only` degraded state |
| `a4-observe` | Real health/jobs/exports/pool; "Workflow stages" left as the deliberate `TODO:no-backend` stub |

### 3.5 What was NOT exercised

- **Approve on notes/questions.** `POST /api/rows/{tn,tq}/:id/validate` returns
  `404` for every row in this seed, because the server requires
  `translation_state` to be non-NULL and nothing here has been through the AI
  pipeline. Correct API behaviour; simply unreachable without a pipeline run.
- **`chapter_locked` (409).** Needs a live non-terminal pipeline job, which needs
  `BT_API_TOKEN`. `t1-home`'s three clearly-labelled "Simulate…" buttons render
  those banner states; unlike the conflict trigger, they are genuine simulations.
  Kept because the states are required by the spec and otherwise unreachable, but
  they are a deliberate exception to "no simulated states".
- **Alignment save** — disabled on purpose (4.8).
- **`last_admin` guard** — unreachable, since `PUT /api/admin/users/:username`
  404s for usernames that do not exist on Door43.

---

## 4. Design-quality findings

Severity key: **high** = a translator would hit this and be confused or blocked ·
**medium** = visibly inconsistent, worth fixing before this becomes the app ·
**low** = polish.

### 4.1 Six of thirteen screens restructure at unsanctioned breakpoints — **severity: medium**

The design system fixes three breakpoints — **560 / 820 / 900**
([02-architecture.md](02-architecture.md) D4). Measured against the committed
design branch, the actual `@media (max-width: …)` values were:

| Screen | Breakpoints used | Verdict |
|---|---|---|
| `t1-home` | 820, 900 | on-system |
| `t2-review` | 480, 559.98, 899.98 | on-system (480 is a local sub-rule) |
| `t5-articles` | 819.98 | on-system |
| `t6-words` | 559.98, 899.98 | on-system |
| `l1-ai` | 560 | on-system |
| `l2-style`, `l3-templates` | 900 | on-system |
| `index` | 820 | on-system |
| **`t3-scripture`** | **780** | **off-system** |
| **`t4-align`** | 559.98, **780** | **off-system** |
| **`a1-setup`, `a3-team`, `a4-observe`** | **700** | **off-system** |
| **`a2-import`** | **700**, 820, 900 | **off-system** |

Two stray values, `780` and `700`, account for all of it.

**Correction to an earlier draft of this finding.** My first pass asserted that
`700` vs `900` straddling 768 was what made Admin screens look "wide" at tablet
while Lead screens collapsed. I measured that at 768 `a4-observe` renders a
4-across `.stat-row` while `l2-style` is a single column — which is true — and
wrongly attributed it to the breakpoint. It is not. `a4`'s stat row is
`repeat(auto-fit, minmax(150px, 1fr))`, which is *intrinsically* fluid and needs
no breakpoint at all; it fits four columns at 768 simply because four fit. The
two mechanisms are genuinely different, and the honest version is:

- **`780` in `t3` / `t4` is a real layout restructure** at an off-system width
  (`.pair` and `.sbs-cols` collapsing two columns to one). These should be `820`.
- **`700` in `a1`–`a4` is not a layout rule at all.** All four are the identical
  one-liner `@media (max-width: 700px) { .flow-nav { display: none; } }` — it
  hides navigation, not structure. See 4.6, which is the real problem there.

**Fix status — deliberately partial.** Normalizing `780` → `820` is the safe,
unambiguous half and is worth doing. Normalizing `700` → `820` would be an active
**regression**: it would start hiding the admin navigation at 820 instead of 700,
widening the dead-end described in 4.6. So the `700` rules are left alone and the
underlying problem is escalated instead.

### 4.2 The tablet band is under-served — most screens have only two layouts, not three — **severity: medium**, *judgment call, not fixed*

D1 specifies three distinct treatments: mobile card-at-a-time (<560), a tablet
"Translation Desk" (560–899), and a three-region desktop workspace (≥900).

Seven screens (`t3`, `l1`, `l2`, `l3`, `a1`, `a3`, `a4`, `index`) define only a
**single** breakpoint, so they have two layouts and no tablet-specific treatment
at all — they jump from desktop straight to the mobile single column. `t2-review`
is the only screen that genuinely implements a distinct tablet layout.

That is very likely *why the notes page feels oddly balanced on tablet*: it is
not that `t2` is wrong so much as that it is the only screen behaving as
specified, so its tablet layout reads as the odd one out against six siblings
that simply go single-column.

**Left for Benjamin to decide** — this is a scope question, not a bug. Either
build the tablet treatment on the remaining screens, or amend D1 to admit that
most screens legitimately only need two layouts. Guessing at the taste here would
be worse than asking.

### 4.3 `t2-review` at tablet: fat rail, squeezed hero, no context column — **severity: medium**

Concretely, at 560–899px `t2-review.html:59` sets:

```css
.review-wrap { grid-template-columns: minmax(220px, 0.85fr) minmax(0, 1.35fr); }
.review-wrap .context-col { display: none; }
```

Two consequences:

1. The queue rail takes ~39% of the width (and at 560px its `220px` floor takes
   **43%**, leaving the hero work card only ~296px). D1 calls for the work card
   to be the hero at ~55%; here the rail crowds it.
2. The verse-context column is removed outright, though D1 asks for it to remain
   "collapsible on the right/below (~35%)" at tablet. It is replaced by a
   `.verse-btn-mobile` button — i.e. the *mobile* affordance, applied to tablet.

This is the specific mechanism behind the "weirdly balanced" impression.

### 4.4 The "shared" top bar is only shared in markup — its CSS is copy-pasted and has already drifted — **severity: medium**

All 14 pages use the `topbar-shared` class, and `_tokens.css` styles the bar
itself. But the *account cluster buttons* inside it are not in the shared
stylesheet at all. `.cluster-btn` is defined **six separate times**, once each in
`t1`–`t6`, and not at all in the eight Lead/Admin pages (which use a different
treatment).

Six independent copies of one component's CSS, and they have already diverged:

| Screen | `.cluster-btn` declarations |
|---|---|
| `t1`, `t2`, `t3`, `t5` | `padding: 5px 11px; font-size: 12.5px` |
| `t4-align` | …plus `min-height: 30px` |
| `t6-words` | …plus a **second rule** overriding to `font-size: 11.5px; padding: 3px 8px` |

This is the classic shape of a component that is *about* to become inconsistent
everywhere. It also has a concrete consequence today — see 4.5.

**Recommendation:** move `.cluster-btn` (and the account-cluster block) into
`_tokens.css` once, and delete the six local copies. This is the single
highest-leverage cleanup in the set, because the top bar appears on every screen.

### 4.5 Several interactive controls are below the minimum tap-target size — **severity: high on touch**

Measured in-browser at a real 375×812 viewport on `t6-words` (viewport explicitly
sized — see the method note in §3):

| Control | Rendered height | Verdict |
|---|---|---|
| `<select>` "All candidates" | **22px** | fails WCAG 2.5.8 AA (24×24) |
| `.cluster-btn` "Refresh" | **23px** | fails WCAG 2.5.8 AA |
| `.lex-word` (Hebrew word buttons) | 26px | passes AA, far below the 44px AAA target |
| `.add-link-btn` | 30px | passes AA, below 44px |
| `.cluster-btn` "Mode" | 28px | passes AA, below 44px |
| nav `Home` link | 31px | passes AA, below 44px |

The two failures both trace to 4.4: the 23px button is caused by `t6`'s local
`padding: 3px 8px` override, which no other screen has. The Hebrew `.lex-word`
buttons matter more than the number suggests — they are the primary tap target on
a word-linking screen, on a phone, and they are 26px.

**Recommendation:** set a `min-height: 32px` floor on interactive controls in
`_tokens.css` (44px for primary touch targets), and drop `t6`'s local override.
This is a straightforward fix, but it changes visual density on every screen, so
it is listed rather than applied unilaterally — density was a deliberate design
choice in this lineage.

### 4.6 All four Admin screens have **no navigation at all** below 700px — **severity: high**

This is the finding that replaced my mistaken version of 4.1, and it is worse
than what I originally thought was wrong.

`a1`–`a4` each carry `@media (max-width: 700px) { .flow-nav { display: none; } }`.
`.flow-nav` is the *only* inter-screen navigation on those pages, and **nothing
replaces it** at narrow widths — there is no hamburger, no bottom bar, no
select menu.

Measured in-browser on `a4-observe` at 375×812, enumerating every `a[href$=".html"]`
and testing computed visibility:

```
flowNavVisible:    false
visible nav links: []        ← none
hidden nav links:  a1-setup, a2-import, a3-team, a4-observe, t1-home, index
```

An admin who opens any Admin screen on a phone cannot reach another Admin screen,
cannot get back to the translator home, and cannot reach the hub. The only way
out is the browser's back button or editing the URL.

The Lead screens (`l1`–`l3`) never hide their `.flow-nav`, so this is specific to
the Admin flow rather than a system-wide convention.

**Recommendation:** give `.flow-nav` a narrow-width form rather than hiding it —
horizontal scroll strip, or collapse to a `<select>` that navigates on change.
**Not fixed here** because it is new UI design, not a correction, and the right
answer should match whatever mobile-nav pattern the real app adopts. Flagging it
rather than inventing a pattern unilaterally.

### 4.7 The merge prompt attributed a real conflict to a fabricated person — **severity: high**, *fixed*

The most consequential honesty defect found. `t2-review`'s "Demo: 409 conflict"
button is itself admirably honest — it deliberately sends a stale `If-Match` so
the server returns a **real** `409 version_mismatch`, and populates the merge
prompt from the server's actual `current` row. Verified: one `PATCH
/api/rows/tn/qki3?book=ZEC`, real 409, real content in both columns.

But the dialog's *headings* were left as demo copy and were never overwritten:

```
Diego saved a change to this note while you were editing.
Theirs (v4, Diego, 2 min ago)
```

So a translator resolving a genuine conflict was told a **named colleague** made
the edit, at a fabricated time, at a version number unrelated to the real row
(the real one was v6). Attributing an edit to a specific person who did not make
it is worse than showing nothing — on a shared-editing screen it is exactly the
kind of detail a user would act on.

Worth noting *why* it was invented: the row-level 409 body carries `updated_by`
(a **numeric user id**) and `updated_at`, but **no username**. There is no way to
name the other editor from this response, so the mockup filled the gap with a
plausible name.

**Fixed:** the lede now reads "Another editor saved a change…", and the heading
is built from the real payload — `Theirs (v6, 3 min ago)` — degrading to a bare
`Theirs (v6)` if the timestamp is missing. Verified in-browser: heading matches
the server's version, and "Diego" no longer appears anywhere on the page.

**Follow-on for the real app:** if the merge prompt should name the other editor,
the 409 body needs to carry a username, not just `updated_by`. Worth deciding
deliberately — it is a small API change with a real UX payoff.

### 4.8 `t4-align` cannot save an alignment — **honest limitation, deliberately surfaced**

The aligner's drag interaction works and its words come from the real UHB/ULT
verse objects, but **Save is disabled with a visible explanation**. Reconstructing
a valid `\zaln` milestone tree from the preview's drag state is not something this
vanilla-JS mockup does faithfully, and `PATCH /api/verses/…` would happily accept
a malformed `content.verseObjects` and persist alignment damage.

Given this repo's history — `docs/plan.md` and `CLAUDE.md` both record repeated
production alignment loss, and `web/src/lib/replace.ts` exists specifically to
prevent it — writing a plausible-but-wrong tree would be the single most harmful
thing this preview could do. A disabled button with an honest reason is worth more
than a save that silently corrupts alignment.

### 4.9 `t1-home` overflowed the viewport at 375px — **severity: medium**, *fixed*

Covered in the drive log (3.2). Recorded here because the root cause is a design
issue, not a one-off: the shared account cluster cannot shrink
(`flex: none; white-space: nowrap`), so *any* screen that adds a fifth control
overflows. `t1-home` was simply the first to cross the line. Related to 4.4 — the
cluster's CSS is duplicated per screen, so there is no single place to fix its
narrow-width behaviour.

---

## 5. What two independent reviews found that the drive did not

This section exists because the answer is uncomfortable and useful.

The browser drive in §3 verified **layout, console cleanliness, and network
behaviour** across 42 probes. It never systematically asked the one question that
mattered most: **"is this value on screen actually real?"** Two independent cold
reviews asked it, and found a great deal that 42 green probes had walked straight
past. Every finding below was confirmed and fixed.

### 5.1 The one that mattered: `t3-scripture` Save destroyed word alignment

The verse Save built its body as:

```js
content: { verseObjects: [{ type: "text", text: value }] }
```

That is whole-verse flattening — the real tree of nested `\zaln` alignment
milestones and `\w` word nodes replaced by a single text node. Every alignment on
the verse, gone.

**The server could not stop it.** `guardBlocksSave` (`api/src/alignmentDelta.ts`)
only blocks when `unexpectedLosses.length > 0`, and losses are computed only for
words that *survive* the edit. When the "after" side contains zero `\w` nodes,
every word short-circuits and **total annihilation reports as zero losses**.

It had already happened. The reviewer found the receipt in the running database's
own audit trail: `edit_log` id 1458, `row_key ZEC/1/8/ULT`, `prev_version 1 →
new_version 2`, payload `verseObjects` = one text node, server-recorded delta
`{"beforeAligned":38,"afterAligned":0,"unexpectedLosses":[]}`. **38 aligned words
→ 0, accepted with a 200.**

Two things make this worth dwelling on:

1. **§3.3 of this very document reported that write as a success** ("Verse write,
   both headers → 200, v1 → v2"). The drive's own probe passed the *real* verse
   tree back to the server, so it never exercised the payload the button actually
   sends. A green test can be green for the wrong reason.
2. **It contradicted our own stated reasoning.** §4.8 disabled `t4-align`'s save
   precisely because "writing a plausible-but-wrong tree would be the single most
   harmful thing this preview could do" — while `t3` was doing exactly that.

**Fixed:** the flattening body construction is removed entirely and both verse
Save buttons are `disabled` with a visible reason, matching `t4`.

**Escalated for the real app:** `analyzeAlignmentDelta`'s empty-after hole is not
a preview bug. *Any* edit path that empties the word set escapes the guard. Worth
checking whether it is reachable from the production editor.

### 5.2 Fabricated content presented as real

| What | Where | Fixed by |
|---|---|---|
| Signed-in user "Ana Ruiz · editor" (real session is `dev`/`admin` — the **role** was wrong too) | 6 translator screens | driving the cluster from `flowApi.me` |
| "Replaced 4 of 4 matches across 3 verses" with **no network call at all** | `t3` find/replace | a real client-side scan; Apply disabled (no such endpoint exists) |
| Hard-coded Spanish scripture, plus two **live** Save buttons firing `PATCH {}` | `t4` side-by-side | real ULT/UST text; saves disabled; dialog gated when ULT is unavailable |
| Mock ULT/UST verse text with a fabricated alignment highlight | `t6` mobile sheet | real verse text per lane |
| An entire "Examples" section, incl. "142 validated examples feeding the pack" | `l2` | real `GET /api/translation-memory/examples`, honest empty state |
| Invented template `figs-metaphor` shown in state `edited` whenever the load failed | `l3` | explicit empty/error state |
| "New AI drafts ready for **ZEC 6**" on a real trigger, never rewritten | `l1` | text built from the real book/chapter |
| "AI notes run in progress for **ZEC 5** — started **4 min ago**" on a genuine 409 | `t2` lock banner | built from the real `chapter_locked` payload |
| Baked tW catalog options surviving a failed fetch | `t6` datalist | removed; honest failure state |
| Hard-coded 4-book picker (3 not imported) | `l1` | real `GET /api/books` |
| "Chapter copied to clipboard" with no clipboard call | `t3` | real `navigator.clipboard`, honest failure |
| Hub still claiming "Nothing here calls the network" | `index` | rewritten |

### 5.3 "Demo: 409 conflict" was silently saving

`t2`'s conflict trigger used `ifMatch: Math.max(1, item.version - 1)`. On a fresh
seed **every row is at version 1**, so `Math.max(1, 0) = 1` — the *current*
version. The PATCH therefore **succeeded and committed the textarea contents**,
on a button labelled "Demo".

The §4.7 verification was real, but it ran against a row that had reached v6
through earlier testing — which is exactly why it looked correct. Now sends
`version + 1`, which can never match; verified to 409 with the row's version and
content unchanged.

### 5.4 Defects in the preview's own API layer

- **Missing `csrf_mismatch` recovery.** `web/src/sync/api.ts` treats a
  `403 csrf_mismatch` as recoverable (refresh re-mints `be_csrf`, retry once).
  `_api.js` classified it as plain `forbidden`, so an expired CSRF cookie would
  hard-fail every write and render as a permissions problem. Now mirrored.
- **Fabricated `X-Source-Generation`.** The shell defaulted the header to a
  literal `1`. That header exists so a client can *prove* which generation it
  loaded; defaulting manufactures the proof, and on any deployment whose active
  generation is 1 the gate would silently pass for a client that never read the
  row. Now omitted when unknown, so the server answers `428` — failing closed is
  the entire point of the header.
- **`classify()` catch-all was `"conflict"`**, so a `429` rate limit would read as
  a merge conflict. Now `"error"`.

### 5.5 Confirmed correct under review

Stated because a review that only lists faults is not a useful record. Verified by
the reviewer against the API source: header discipline (including `If-Match: 0`
surviving, which the first prefs write depends on); exact 409 classification
against the server's literals; `428` classified *before* the 409 branch and
branched on separately by consuming screens; the 401 retry bounded at one; the
`workspace_mismatch` retry bounded by the same flag (max depth 2, with
`adoptWorkspace` short-circuiting the retry rather than arming it); CSRF sent on
writes only and correctly omitted for the exempt auth paths; no HTTP status
causing a throw; **no blur-save or autosave anywhere**; and **no side-effectful
call on any screen's load path**.

### 5.6 Final verification after the fixes

The full sweep was re-run, with an added regression scan for every fabricated
literal listed in 5.2:

| Width | Result |
|---|---|
| 375 | 14/14 — no h-scroll, no JS errors, no fabricated literals |
| 768 | 14/14 |
| 1280 | 14/14 |

*(End of design findings.)*
