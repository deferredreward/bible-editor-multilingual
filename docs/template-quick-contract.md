# `POST /api/template-quick` — contract for uw-bt-bot

**Status:** not implemented upstream. As of 2026-07-30 a `POST` to
`https://uw-bt-bot.fly.dev/api/template-quick` returns **404** (the sibling
`/api/tn-quick` returns 401, i.e. it exists and wants auth). Until this endpoint
ships, the editor's "Draft with AI" button on the Note Templates screen fails
with `model_call_failed` / HTTP 502.

**What calls it:** `POST /api/templates/unit/draft?id=<templateId>` in
[`api/src/templates.ts`](../api/src/templates.ts) (the `templates.post("/unit/draft", …)`
handler). The editor is a dumb proxy: it forwards, validates the response
shape, and persists the result in the same request. The URL is overridable via
the `TEMPLATE_QUICK_URL` env var, defaulting to
`https://uw-bt-bot.fly.dev/api/template-quick`.

## What a note template is

A short English snippet a translator drops into a translationNote, with
placeholder tokens the editor substitutes at render time. Example (real row):

> SPEAKER is speaking of himself in the third person as \*\*text\*\* to show
> humility. If it would be helpful in your language, you could translate this
> in a humble form in the first person. Alternate translation: [text]

191 of them come from a Google Sheet (columns: support reference, type, note
template, id); 2 more are hardcoded "built-in" rows. The job is to translate the
**prose** into the target language while leaving the machinery alone.

## Request

```
POST <TEMPLATE_QUICK_URL>
Content-Type: application/json
Authorization: Bearer <BT_API_TOKEN>
```

`BT_API_TOKEN` is the same shared service token `/api/tn-quick` already accepts.

```jsonc
{
  "templateId": "figs-metaphor-01",   // stable id, sheet column D. Built-ins: "builtin-tcm" | "builtin-sh"
  "supportRef": "figs-metaphor",      // sheet column A. Built-ins send the literal "(built-in)"
  "type": "self",                     // sheet column B; string or null. Built-ins: "quick-fill"
  "sourceMd": "SPEAKER is speaking…",  // English template body — the thing to translate
  "targetMd": null,                   // existing translation, or null if none yet
  "targetLang": "ar",                 // project config languageCode
  "targetOrg": "BSOJ",                // project config exportOrg
  "direction": "rtl"                  // project config direction
}
```

The editor rejects its own request before sending if the serialized body
exceeds **64 KiB** of UTF-8 (`TEMPLATE_DRAFT_MAX_BODY_BYTES`), returning 413 to
the browser. In practice bodies are ~1 KB.

`targetMd` is supplied so the bot *may* revise rather than translate from
scratch. It is never non-null for a human-approved translation — the editor
refuses to draft over `translation_state = 'validated'` (409) before it ever
calls the bot.

## Response

**200**, `Content-Type: application/json`:

```jsonc
{
  "target_md": "…الترجمة…",   // REQUIRED, must be a string
  "warnings": ["…"]            // OPTIONAL array of strings
}
```

Note the case mismatch: the **request is camelCase, the response is
snake_case**. That is what the caller already parses — `target_md`, not
`targetMd`. Non-string entries in `warnings` are dropped; a non-array
`warnings` is treated as empty.

### How the caller reacts

| Upstream | Editor returns to the browser |
| --- | --- |
| 200 with string `target_md` | 200, row saved as `translation_state = 'ai_draft'`, version bumped, `warnings` stored in `draft_meta_json` |
| 200 but `target_md` missing / not a string | 502 `{"error":"model_call_failed","detail":"missing_target_md"}` |
| 200 but body isn't valid JSON | 502 `{"error":"model_call_failed","detail":"invalid_upstream_json"}` |
| **429** | **429** — passed through, so a bulk run can back off |
| any other non-2xx | 502 `{"error":"model_call_failed","detail":"<first 300 chars of your body>"}` |
| connection failure | 502 `{"error":"model_call_failed"}` |

Returning a useful plain-text or JSON error body is worth it: the first 300
characters reach the client and are shown to the translator.

## Behavioural requirements

These are the ones that make the difference between a usable draft and one a
translator has to throw away.

1. **Preserve placeholder tokens verbatim, in place.** The editor substitutes
   these at render time; translating, reordering, or reformatting them breaks
   the quick-fill. The set seen in live data:
   - `[ALT]`, `[text]` — bracketed substitution slots
   - `NOTE` and `SPEAKER` — uppercase inline slots
   - `**text**` — the bolded literal is itself a slot, keep both the asterisks
     and the word
   - `{book}` — interpolated by the frontend (`builtin-sh` only)
   - markdown links with relative paths, e.g. `[Genesis 1:1](../01/01.md)` —
     keep the path exactly; the link *label* should be translated
2. **Preserve markdown structure** — `(1)` / `(2)` enumerations, bold runs,
   and line breaks. `builtin-tcm` is a numbered-alternatives template and the
   numbering is load-bearing.
3. **Respect `direction`** — for `rtl`, do not insert directional control
   characters around the placeholders; the editor renders with `dir` attributes
   already (see the MUI/stylis note in the repo).
4. **Respond within ~30 s** where possible. The editor's client-side ceiling is
   120 s, so a slower response is survivable but degrades a bulk run badly.
5. **Support ~200 calls in a burst.** The bulk "Draft all with AI" flow issues
   one request per untranslated template with small client-side concurrency.
   429 with a `Retry-After` is respected upstream of you; silently dropping or
   hanging is not.
6. **Be stateless / idempotent.** The editor owns persistence and versioning
   (If-Match CAS on the D1 row); the bot should not store anything per
   template.

## Smallest thing that unblocks the demo

A single route that forwards `sourceMd` plus `targetLang`/`direction` to the
model with a prompt carrying rule 1 above, and returns
`{"target_md": "<model output>"}`. Warnings, revision-of-`targetMd`, and
per-`type` prompt tuning can all come later — the editor treats them as
optional.

## Verifying it end to end from the editor

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://uw-bt-bot.fly.dev/api/template-quick \
  -H "Authorization: Bearer $BT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"templateId":"figs-metaphor-01","supportRef":"figs-metaphor","type":"self","sourceMd":"Alternate translation: [text]","targetMd":null,"targetLang":"ar","targetOrg":"BSOJ","direction":"rtl"}'
```

401 means the token is wrong; 404 means the route still isn't there; 200 with a
`target_md` string means the editor's button will work.
