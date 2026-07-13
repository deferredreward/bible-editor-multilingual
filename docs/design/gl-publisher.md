# GL Publisher — exporting gateway-language resource repos to DCS

**Status:** Design (FEASIBILITY.md Phase 3) · **Drafted:** 2026-07-10
**Goal:** Extend the nightly export so a gateway language's translated resources land on git.door43.org under the GL org as valid Resource Containers (RC 0.2) — correct subjects, `checking_level`, pinned original-language relations, and the `tc-ready` repo topic — so the language appears in translationCore 3's GL dropdown and checks run.

Evidence tags: **[VERIFIED file:line]** = read in code/docs during this design pass; **[RESEARCHED]** = RC/Gitea format knowledge from published specs (rc0.2, Gitea API), not re-fetched; **[PROPOSED]** = new design; **[INFERENCE]** = judgment, labeled.

---

## 1. The fixed contract this must emit

FEASIBILITY.md §1 is the acceptance spec **[VERIFIED FEASIBILITY.md:12-28]**. Per book, the GL org must hold:

| Repo | Subject | Key requirement |
|---|---|---|
| `{lang}_glt` | `Aligned Bible` | USFM3 with `\zaln` to UGNT/UHB, `checking_level ≥ 3` |
| `{lang}_gst` | `Aligned Bible` | same |
| `{lang}_tn` | `TSV Translation Notes` | `dublin_core.relation` pins exact OL version (`?v=0.34`) |
| `{lang}_twl` | `TSV Translation Words Links` | 6-col TSV |
| `{lang}_tw` | `Translation Words` | markdown articles, `checking_level ≥ 2` |
| `{lang}_ta` | `Translation Academy` | markdown articles — required for tN checking |
| all | RC `rc0.2` manifest | DCS repo topic `tc-ready` (or `ready-for-use`) |

**Completeness is all-or-nothing per book**: tC3's `gatewayLanguageHelpers.js` (with `SourceContentUpdatesActions.js:449-459`) silently drops a language from the GL dropdown for a tool if any required piece is missing **[VERIFIED FEASIBILITY.md:24]**. There is no partial credit and no error message — which is why the publisher's manifest correctness, not the TSV rendering (already solid), is the risk center of this phase.

---

## 2. What the existing export already does

The nightly `ExportWorkflow` (05:30 UTC cron) renders D1 → TSV/USFM and pushes to DCS:

- **Targets are hardcoded to unfoldingWord English repos.** `RESOURCE_TARGETS` maps `tn→en_tn, tq→en_tq, twl→en_twl, ult→en_ult, ust→en_ust` with per-book file paths (`tn_{BOOK}.tsv`, `{NN}-{BOOK}.usfm`) **[VERIFIED api/src/export.ts:601-607]**. The owner is `env.DCS_EXPORT_OWNER ?? "unfoldingWord"` **[VERIFIED api/src/exportWorkflow.ts:430]** — a single env override, not per-project config. The import side is equally hardcoded (`dcsSources.ts:53-59` URL fan-out; `DCS_OWNER = "unfoldingWord"` at `dcsSources.ts:129`) **[VERIFIED]**.
- **Branch-per-(book × resource) PR flow.** Each edited book gets a `{BOOK}-be-{contributors}` branch (`buildExportBranch`, **[VERIFIED export.ts:46-51]**), committed via the Gitea contents API (`commitToDcs`, **[VERIFIED export.ts:839-901]** — master pre-check, branch reset, PUT/POST) using `DcsCommitConfig {baseUrl, token, owner, repo, branch}` **[VERIFIED export.ts:611-617]**, then an open PR into master (`ensureDcsPr`, **[VERIFIED export.ts:1017-1046]**). A DCS-side validate-and-merge workflow merges the PRs (currently dormant, `VALIDATORS = []` **[VERIFIED api/src/postExport.ts:45]**; the event-driven handoff is designed in `docs/triggered-export-merge.md`).
- **Renderers.** `buildTnTsv` / `buildTwlTsv` / `buildUsfm` **[VERIFIED export.ts:191, 205, 527]** produce contract-exact 7-col/6-col TSV and DCS-normalized USFM3; column order and cell escaping match the published en_* conventions.
- **Safety gates the publisher must not bypass.** Freshness gate (`checkMasterFreshness`, **[VERIFIED exportWorkflow.ts:830-844]**, applied at :349), TSV shrink guard (:374), and alignment-shrink guard (:405) all run inside `exportOne` (**[VERIFIED exportWorkflow.ts:293]**) before any commit. Branch-drift recovery is `docs/export-rebase-fix.md` (D1-authoritative rebuild on 409, gated on `DCS_TOKEN`).

**What is missing for a GL org:** target repos derived from configuration instead of the `en_*` constants; `manifest.yaml` generation/update (the exporter today never touches manifests — the en_* repos have hand-maintained ones); repo bootstrap; topic stamping; and tW/tA markdown export (no article tables exist yet — Phase 4).

---

## 3. What the publisher adds

### 3.1 Config-driven targets [PROPOSED]

The Phase 1 config layer (being built in parallel — referenced here as `ProjectSourceConfig`; it does not exist in the tree yet, `grep ProjectSourceConfig` returns nothing **[VERIFIED 2026-07-10]**) carries per-project: `org` (DCS owner, e.g. `es-419_gl`), `language {identifier, title, direction}`, source Bible identifiers, and the OL pairing. The publisher extends it with a `publishTargets` section that replaces `RESOURCE_TARGETS`:

```ts
interface PublishTarget {
  repo: string;               // "{lang}_tn", "{lang}_glt", …
  subject: RcSubject;         // "TSV Translation Notes" | … | "Aligned Bible"
  identifier: string;         // dublin_core.identifier: "tn", "twl", "tw", "ta", "glt", "gst"
  format: string;             // "text/tsv" | "text/usfm3" | "text/markdown"
  type: "help" | "dict" | "man" | "bundle";
  checkingLevel: 1 | 2 | 3;   // stamped per repo, raised by the GL team over time
  path: (book: string) => string;
}
```

Resolution: `repo = target.repo`, `owner = project.org` — flowing through the same `DcsCommitConfig` **[VERIFIED export.ts:611]** and the unchanged branch/PR machinery. The unfoldingWord English project becomes just one `ProjectSourceConfig` whose targets equal today's constants, so the en_* path is a regression test, not a fork. `glt`/`gst` map onto the existing `ult`/`ust` render path (`buildResource`, **[VERIFIED exportWorkflow.ts:562-640]** — `bible_version` is already a column on `verses`), with the USFM `\id` headers carrying the GL identifiers.

### 3.2 Manifest generation and update [PROPOSED, format RESEARCHED]

RC 0.2 `manifest.yaml` structure **[RESEARCHED — rc0.2 spec; mirrors the live en_tn/en_ult manifests]**:

```yaml
dublin_core:
  conformsto: 'rc0.2'
  contributor: []            # from contributorsFor() across all books, cumulative
  creator: '<GL org display name>'
  description: '...'
  format: 'text/tsv'         # per PublishTarget.format
  identifier: 'tn'
  issued: '2026-07-10'       # first-publish date; stable
  language:
    identifier: 'es-419'     # from ProjectSourceConfig.language
    title: 'Español Latinoamérica'
    direction: 'ltr'
  modified: '2026-07-10'     # bumped every publishing commit
  publisher: '<GL org>'
  relation:
    - 'el-x-koine/ugnt?v=0.34'   # exact OL pin — REQUIRED (FEASIBILITY §1)
    - 'hbo/uhb?v=2.1.30'
    - 'es-419/glt'               # GL cross-relations (unversioned, like en_tn's)
    - 'es-419/gst'
    - 'es-419/ta'
    - 'es-419/tw'
    - 'es-419/twl'
  rights: 'CC BY-SA 4.0'
  source:
    - identifier: 'tn'
      language: 'en'
      version: '<en_tn release the translation was made from>'
  subject: 'TSV Translation Notes'
  title: 'translationNotes'
  type: 'help'
  version: '1'               # bumped on release, not nightly
checking:
  checking_entity: ['<GL org>']
  checking_level: '2'        # from PublishTarget.checkingLevel
projects:
  - title: 'Obadiah'
    versification: 'ufw'
    identifier: 'oba'
    sort: 31
    path: './tn_OBA.tsv'
    categories: ['bible-ot']
```

Design decisions:

- **Template + config, not freehand.** One template per resource type; every variable field comes from `ProjectSourceConfig` (language block, org, source version) or `PublishTarget` (subject/identifier/format/type/checking_level). Nothing is inferred at render time from repo contents.
- **OL relation pins are config, human-set.** The exact `?v=` values (`el-x-koine/ugnt?v=0.34`, `hbo/uhb?v=2.1.30`) must match the OL release the GL's tN quotes were checked against — a translation-team decision, not derivable. They live in `ProjectSourceConfig` and are validated non-empty at publish time; tN/TWL publish fails closed without them **[PROPOSED — direct consequence of FEASIBILITY.md:18]**.
- **`projects[]` reflects published books only.** The manifest updater reads the repo's current manifest, upserts the entry for the book being exported (identifier = lowercase book id, `sort` from the existing `BOOK_NUMBERS` table **[VERIFIED export.ts:17-31]**, `versification: 'ufw'`, `categories` from OT/NT membership — `NT_BOOKS` set already exists **[VERIFIED dcsSources.ts:26-30]**), bumps `modified`, and commits `manifest.yaml` on the same export branch as the book file, so book + manifest land in one PR and master is never in a book-without-manifest-entry state. tW/tA manifests use one project entry per top-level section (`bible/`, `intro/`…), not per book **[RESEARCHED — en_tw/en_ta convention]**.
- **Read-modify-write, not regenerate.** Fields humans may hand-edit (description, contributors added out-of-band) survive because the updater parses the existing YAML and patches only the fields it owns (`modified`, `projects[]`, `relation`, `checking`). A missing/unparseable manifest falls back to the full template. Needs a YAML library in the Worker — none is bundled today **[VERIFIED — no yaml dep in api; INFERENCE from package review during this pass, worth re-confirming at implementation]**.

### 3.3 Repo bootstrap [PROPOSED]

First publish for a (project, resource) with no repo:

1. `GET /repos/{org}/{repo}` → 404 ⇒ `POST /orgs/{org}/repos` `{name, default_branch: "master", auto_init: true}` **[RESEARCHED — Gitea API]**. Requires the service token to have org create-repo permission in the GL org — a provisioning step per GL org, same class as the existing `DCS_SERVICE_TOKEN` setup (`docs/deploy.md`).
2. Commit the initial `manifest.yaml` (empty `projects[]`), `LICENSE.md` (CC BY-SA 4.0 — required by `rights`), and `README.md` directly to master (contents API — the branch/PR flow is pointless on an empty repo).
3. Stamp topics (below).

Bootstrap is idempotent and runs as a step inside the workflow before the first `exportOne` for that repo, so a transient failure retries in place **[PROPOSED]**.

### 3.4 `tc-ready` topic [PROPOSED, API RESEARCHED]

`PUT /repos/{owner}/{repo}/topics/{topic}` adds a single topic without clobbering others (preferred over `PUT /repos/{owner}/{repo}/topics`, which replaces the whole list) **[RESEARCHED — Gitea API]**. Stamped at bootstrap and re-asserted (idempotent) each publishing run. **Gate it on readiness, not existence**: the topic is what makes tC3 index the repo, so stamping a repo whose `checking_level` is below the contract's floor advertises a broken resource. Proposal: stamp only when the repo's configured `checkingLevel` meets the §1 floor for its subject (3 for Bibles, 2 for tW, ≥1 with team sign-off for helps) — a `publish: true` flag per target in `ProjectSourceConfig`, flipped by a human.

---

## 4. Acceptance test procedure

Per FEASIBILITY §1's consequence line **[VERIFIED FEASIBILITY.md:28]**: *install tC3, point it at the GL org, the language appears in the dropdown and checks run.*

1. Install translationCore 3 (desktop). In settings, ensure the resource server is git.door43.org (default).
2. Trigger a source-content update (tC3's `SourceContentUpdatesActions` path scans DCS by subject + topic **[VERIFIED FEASIBILITY.md:24 — cited evidence]**).
3. Create a project for the pilot book; open the **translationNotes tool**; the GL must appear in the GL dropdown.
4. Run checks on at least one note: the GL tN note text renders, its SupportReference tA article opens, and the aligned GL Bible highlights the quote.
5. Negative control: remove one piece (e.g. the `ta` relation or the tA repo topic) on a scratch org and confirm the language drops out — verifying we understand the completeness predicate rather than assuming it.

**Minimum viable set for the tN pilot (one book):** the FEASIBILITY table marks tA as "required for tN checking" **[VERIFIED FEASIBILITY.md:21]**, and the tN tool displays the note against an aligned GL Bible — so the floor is `{lang}_glt` + `{lang}_gst` (Aligned Bible, level 3), `{lang}_tn`, and `{lang}_ta`, all with manifests + topics for that book. `{lang}_tw` + `{lang}_twl` are the translationWords tool's set and can follow **[INFERENCE — FEASIBILITY's per-tool completeness claim implies per-tool sets, but the exact per-tool predicate lives in `gatewayLanguageHelpers.js`, which was verified by the feasibility pass, not re-read here; also unverified whether *both* glt and gst are required or one aligned Bible suffices]**. This makes the GLT/GST long pole (FEASIBILITY Phase 6) a hard dependency of even the tN pilot's *acceptance test* — flagged in §6.

---

## 5. Phasing

**Ships with the tN pilot (buildable now against existing machinery):**
- `PublishTarget`/owner threading through `exportOne` (mechanical once `ProjectSourceConfig` lands; the en_* constants become the default config).
- Manifest template + updater for TSV and USFM repos; YAML dependency.
- Repo bootstrap + LICENSE + topic stamping.
- Publish-readiness gating (`publish` flag, checking_level floors).
- Negative-control acceptance rig on a scratch DCS org — this needs no GL content at all and should be built *first*, because it converts the §1 contract from documentation into an executable check.

**Waits:**
- **On the config layer (Phase 1):** everything above consumes `ProjectSourceConfig`; until it exists the publisher can only be built against a stub interface (acceptable — the interface is small and specified here).
- **Phase 4 (tW/tA modules):** markdown article export has no tables/renderers yet; `{lang}_tw`/`{lang}_ta` publishing ships with that phase. Interim: the tA repo for the pilot can be hand-maintained (tC Create stopgap, per FEASIBILITY §4B) while its manifest/topic are still stamped by this publisher.
- **Phase 6 (GLT/GST):** the publisher's Bible path is ready sooner than the content will be — aligned, checking_level-3 GL Bibles are the project's stated long pole.

---

## 6. Effort and risks

**Effort [INFERENCE — informed judgment, consistent with FEASIBILITY's 1–2 wk Phase 3 line]:** target threading ~2 days; manifest engine ~3–4 days (YAML round-trip care); bootstrap + topics ~1–2 days; acceptance rig + scratch-org drills ~3 days. Fits 1–2 weeks *excluding* content readiness.

**Risks:**

1. **The verification gap (named, load-bearing).** We cannot fully verify the tC3 dropdown outcome without real GL repos with real aligned Bibles and a tC3 install. The completeness predicate is all-or-nothing and silent **[VERIFIED FEASIBILITY.md:24]**; every manifest field is a potential silent-failure point, and the exact per-tool required set is inferred, not re-read from tC3 source in this pass. Mitigations: (a) re-read `gatewayLanguageHelpers.js` and extract the literal predicate before implementation; (b) the scratch-org negative-control rig; (c) consider seeding a scratch org with *copies of es-419/en content under fake language codes* to exercise the pipeline before any real GL content exists. Until step 4 of §4 passes on real content, this phase is not done.
2. **Aligned-Bible dependency inversion.** The tN pilot's acceptance test needs level-3 GLT/GST — Phase 6 content. Either the pilot's acceptance is staged (publisher verified on scratch data now; real-language verification when Bibles exist) or an existing GL aligned Bible (e.g. es-419 GLT/GST, which exist on DCS **[RESEARCHED — noted in feasibility work; not re-verified]**) anchors the pilot language choice. Decision needed.
3. **Token/permission provisioning.** Org repo-creation and topic-write rights per GL org; the known service-token gaps (no branch-delete — `docs/export-rebase-fix.md`) recur per org.
4. **Manifest clobbering.** A regenerate-from-scratch bug would erase hand edits or `projects[]` entries for books this instance doesn't manage. The read-modify-write rule plus a manifest-shrink guard (refuse to commit a manifest with fewer `projects[]` entries than master's, same philosophy as `exportTsvShrinkRefused` **[VERIFIED export.ts:306]**) covers it.
5. **`tq` has no GL contract slot.** tC3's contract doesn't list tQ **[VERIFIED FEASIBILITY.md:14-22]**; publishing `{lang}_tq` is optional and must not gate completeness.

---

## Honesty ledger

- **Verified by reading in this pass:** FEASIBILITY §1 contract and evidence line; export.ts (targets, commit/PR primitives, guards, renderers); exportWorkflow.ts (owner resolution, freshness/shrink gates, exportOne flow); postExport.ts (dormant validators); both export design docs; absence of `ProjectSourceConfig` in the tree.
- **Not verified:** RC manifest field set and Gitea topics/org-repo API shapes are from prior knowledge **[RESEARCHED]**, not fetched against live DCS this session — confirm against a live en_tn manifest and the door43 Swagger before implementation. tC3's exact per-tool completeness predicate (re-read `gatewayLanguageHelpers.js`). Whether a YAML lib is truly absent from `api/package.json`. es-419 GLT/GST availability.
- **Assumption:** the Phase 1 config layer will expose language/org/OL-pin fields roughly as sketched; the `PublishTarget` interface here is the requested contract, not a description of existing code.
