# Jev decision layer (experimental)

**Jev is only ever an experimental feature of this plugin.** It is opt-in, off by default, hidden until a learner turns on *Show experimental
features* (Settings › Advanced), and labelled *experimental* wherever it appears; nothing in StudyHub depends on it, nothing here is a
recommendation, and no wording in the product or in this document suggests that it will graduate from the experimental stage or be made a default. A learner who
never opens Settings › Advanced never sees that Jev exists.

StudyHub can ask **Jev**, TypeSafe AI's "System One" model, small classifier-shaped questions that a text-generation model would answer at far
higher cost: *which course does this source belong to?*, *does this question give its answer away?*. It can do that in two ways, both opt-in
and **off by default**: as an extra **reference signal** next to what StudyHub already does, or as an **optional replacement** for a few model
calls that StudyHub otherwise makes (the model's yes/no, pick-one or score answers). Nothing is sent to Jev until the learner has shown the
experimental features, chosen a provider, made a key available, confirmed the privacy note of that provider, switched the master switch on and
switched on the individual experiment or replacement. A Jev that is off, failing, rate limited or unsure never changes what StudyHub does: every
site falls back, automatically, to exactly the model path it had before, and says so once per run.

Jev's answers are **typed decisions** (a probability, a choice among labelled options, a level on a scale). It never writes prose, and it never
applies anything by itself: a replaced decision is applied exactly like the model's decision it replaced (and only because the learner switched
that site on); everything that today needs the learner's click still needs it.

## Showing and hiding it

`Settings › Advanced › Experimental features` holds one switch, **Show experimental features** (`lib/experimental.js`, stored in the StudyHub
settings folder of the DSH home as `study/experimental.json`, never in the library, so an export or a backup never turns it on elsewhere). It is
off by default, and it rides on the snapshot (`experimental`), so no surface needs a request of its own to know it.

- **Off**: no Jev section in Settings, no "Jev 建议" button, no "Jev 预审" or "由 Jev 判定" mark, no mention in the tour, welcome, home, setup
  checklist, help sheets, notices or inbox; no extra request and no timer. Every component that once drew something Jev draws exactly what a
  build without Jev draws (`tests/jev-hidden-flow.test.mjs` renders each with the switch off and scans the markup, in both languages). The
  pipeline hooks (`jevPreReviewHook`, `jevReviewHook`, `jevOrganizeHook`) return `undefined`, so the model call sequence is untouched. What stays
  with a draft (findings, summary) never names Jev; only `editorial.jevDecided` and the marks shown with the features say who decided what.
- **On**: the experimental block appears under the switch as one guided flow, in this order: (a) *What Jev could replace*, a short walk-through
  (next / back / skip, shown nowhere else) with one step per replaceable call: what it does now, what Jev would do instead, and the trade-off
  ("faster and cheaper, but accuracy may drop"); (b) the provider, its key source, the connection test and the privacy confirmation of that
  provider; (c) the switches: each replacement turns **on at once** (no save step), or, if the provider, the key or the confirmation is still
  missing, says what is missing and offers that step (and a switch that needs the master switch turns it on too, and says so).
- **Turning it off again** hides all of it and stops every experimental feature at once; the choices inside are kept but inactive.

## Providers

One small table in one place, `lib/jev-providers.js`. The request and answer shapes are the same for every provider; only the address, the model
id, the default key variable and the words differ.

| Provider id | Endpoint | Model | Default key variable | Notes |
|---|---|---|---|---|
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `JEV_API_KEY` | TypeSafe's own API. Behaviour unchanged by the presets. |
| `opencode-go` | `https://opencode.ai/zen/go/v1/systemone` | `jev-1.13` | `OPENCODE_GO_API_KEY_2` | OpenCode Go (the subscription DSH shows as "OpenCode Go 2"). **Not verified**: the route exists (an unauthenticated POST answers 401, an unknown path 404) but OpenCode's public Go model list names no Jev model, so whether a Go key is accepted here is unknown. If it is not, use `custom` with the address you know. |
| `opencode-zen-free` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13-free` | `OPENCODE_GO_API_KEY_2` | OpenCode Zen's limited-time free Jev model. |
| `opencode-zen` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13` | `OPENCODE_GO_API_KEY_2` | OpenCode Zen's paid Jev model (OpenCode's docs state about $0.042 per 1M input tokens, output free; the product shows tokens only, never a price). |
| `custom` | the address the learner enters | the model id the learner enters | `JEV_CUSTOM_API_KEY` | For another gateway that offers the same typed API. OpenRouter, AIML and Netlify AI Gateway were reported to list Jev, but **their wire formats are not verified**; the preset only assumes the same `POST { model, state, questions }` with a bearer key. |

OpenCode facts come from https://opencode.ai/docs/zen/ and the public `/zen/v1/models` list (the same OpenCode key works for Zen and Go).

**Keys.** A key is resolved in this order: a key pasted in the settings (kept per service: TypeSafe's in `key` as before, OpenCode's in `opencodeKey`,
the custom endpoint's in `customKey`) > the environment variable named by the setting `keyEnv` (default per preset, in the table) > `JEV_API_KEY`
(TypeSafe only). A key never crosses services: a TypeSafe key (pasted or `JEV_API_KEY`) is never sent to OpenCode or to a custom endpoint, and the
other way round. **A key that comes from an environment variable is never stored**: only the variable's *name* is saved, the value is read when a
request is sent, and the settings page says "key from environment variable NAME (found / not found)" without showing any character of the value.
DSH's own *OpenCode 2* account keeps its key in `OPENCODE_GO_API_KEY_2` and DSH does not copy it into plugin settings; neither does StudyHub, so the
OpenCode presets read that variable and nothing else. If the variable is not visible to the plugin process the page says so plainly (DSH may not pass it
on); the learner can paste a key instead or start DSH with the variable set.

**Errors.** Typed, with plain zh/en sentences that name the provider and never hold the key, the learner's text or a response body: 401/403 key
rejected (`invalid-key`), 402 insufficient balance (`insufficient-balance`, not retried), 429 (`rate-limited`), 529 (`overloaded`), 5xx
(`unavailable`), plus network and timeout. 429/529/5xx and network failures are retried twice with backoff, as before.

**`JEV_BASE_URL`** still redirects every provider (tests and previews; the preset path, or the path of the custom endpoint, is kept), and
`tests/helpers/fake-jev.mjs` serves both layouts and enforces the `Authorization` header.

## What is sent, where, and what is not known (per provider)

- **What** (all providers): only what the experiments or replacements you switched on need, and only when you use them. A source's *title and a short
  excerpt* (the first 1,000 characters) and the *course names* (with up to three titles already filed under each) for course suggestions; a candidate
  question with its options, answer, hint, explanation and quoted evidence for the card review and the pre-check; outline heading texts for the outline
  check; a question with its options and answer for the level cross-check. The whole library is never uploaded. The key is sent only in the
  `Authorization` header.
- **TypeSafe** (`typesafe`; docs.typesafe.ai/legal): goes to `api.typesafe.ai`, not through your study model. Its privacy policy commits not to train models on user data; zero data retention is offered to *enterprise* customers. **How long a normal account's data is retained is not documented**, and the product
  says exactly that. Assume what you send may be kept for some time.
- **OpenCode Zen** (`opencode-zen-free`, `opencode-zen`): goes to OpenCode's Zen service and on to its provider TypeSafe AI, not through your study model.
  OpenCode's documentation states that its providers generally follow zero retention and do not train on data (OpenCode's statement; not verified here).
  **But for Jev 1.13 Free the documentation does not say whether prompts are retained or used for training**; it only says the model is available on
  OpenCode for a limited time. The product treats that as **unknown**, says so in the privacy note, and tells the learner not to use confidential
  material with the free model. The free period is limited-time.
- **Custom endpoint** (`custom`): goes to the address the learner entered; StudyHub does not know who runs it, how long it keeps what it receives or
  whether it trains on prompts (unknown), and the wire format is unverified.
- **The confirmation is per provider**: `JEV_NOTICE_VERSION` in `lib/jev-settings.js` plus the provider id (TypeSafe's stays in `confirmedAt` /
  `noticeVersion` as before, the other providers' in `confirmations`; the custom endpoint's is also bound to its address, so a new address asks again).
  Changing provider asks again; going back finds the earlier confirmation. When a note changes in substance, bump the version and everyone is asked again.
- **Not claimed anywhere in the product**: a free tier of TypeSafe, a price, a rate limit. The settings page shows the tokens used (`usage` as reported by
  the service) and nothing else about cost. Check the provider's own pages for plans and limits.
- **Language**: the provider's models page says English is the primary language and other languages, CJK included, are supported but less optimised.
  Expect weaker results on Chinese material; measure it (below) before relying on it.

The privacy note text lives in `ui/jev-flow.js` (`privacyPoints`), with its English in `ui/locales/en.jev.json`.

## Settings and gates

`Settings › Advanced › Experimental features › Jev` (`ui/JevSettings.jsx`). A pasted key is stored like the audio keys and the MinerU token:
`<DSH home>/study/jev.json`, owner-only permissions, shown back only as its last four characters, never in the library, an export, a backup, a
snapshot or a log. Token counters live next to it (`jev-usage.json`), separately from the study model's ledger, one row per experiment and per
replaceable site.

Every call goes through one door, `lib/jev-runtime.js`, which re-reads the settings and checks, in this order: master switch (the kill switch), the
feature's or site's own switch, the custom endpoint being filled in (custom provider only), a key, the confirmation. It resolves
`{ ok: true, answers, usage }` or `{ ok: false, reason, message }` and does not throw for anything the service, the network or the settings can do (an
aborted signal, i.e. a cancelled job, is the one exception). The pipeline hooks additionally require *Show experimental features*.

## Replacing model calls

### The seam

`lib/jev-decide.js` `replaceWithJev({ runtime, site, items, build, read, fallback, threshold, ... })` is the one routing function the sites use:

- Site not switched on (or the experimental features hidden): `fallback(items)` runs once over all items in their original order, before anything else.
  The model call sequence is **byte-identical** to a build without Jev; Jev is not contacted and not mentioned.
- Switched on: each item becomes one tiny typed request (`build`); Jev's answer is read back (`read`). An item answered with at least the learner's
  confidence line (default 80%) is **decided by Jev**. Everything else (low confidence, an input Jev cannot take, a failing, rate-limited or
  unreachable Jev, a missing key or confirmation) goes to `fallback` in **one** call, as one list in the original order, never per item.
- The result says what happened: each entry is `by: 'jev' | 'model'`; the summary carries the counts, Jev's tokens (counted apart) and **one**
  fallback notice for the whole run.
- Nothing is applied here; a cancelled run and a failing `fallback` reject as they always did.

### Audit: where StudyHub asks a model for a decision-shaped answer

"Typed" = maps onto Jev's `noul` (probability of yes), `choice` (one of up to 255 labelled options, with probabilities) or `score` (2-10 ordered
levels). Jev returns **no free text**, so prose, explanations, translations, rewritten cards and outline text can never be replaced. "Applied" = the answer
takes effect without a learner click. File references are to this repository at the time of the audit.

| # | Site (operation, file) | Decision the model returns | Typed? | Model calls | Applied? | Status |
|---|---|---|---|---|---|---|
| G1 | Independent review of generated cards (`generate` → `lib/batch.js` → `generateDeck` → `reviewDeck`, `lib/generation.js`) | per card pass/fail on six dimensions + free-text findings | six `noul` per card; findings are text | 1 per part of at most 5 cards | yes: flagged cards are dropped | **wired: `cardReview`** |
| F1 | "请 AI 建议" (`source.organize.suggest`, `lib/contexts/library/operations.js`) | per source `{courses[], reason}`; may invent new course names | `choice` over existing courses + none | 1 for all sources | learner click | **wired: `courseOrganize`** (new names, several courses and the reason text stay with the model) |
| G2 | Selected-passage supplement and review (`selection.js`) | same as G1 | as G1 | 1 per run, at most 20 cards | yes | audited, not wired (the `reviewDeck` seam takes the hook; this path does not pass it) |
| G3 | Pre-publish auto-review (`draft.publish`, `authoring/publication.js`) | same as G1 | as G1 | 1 per 5 unreviewed cards | at the publish click | audited, not wired |
| G4 | Repair loop review (`draft.repair`) | same as G1 on one card | as G1 | up to 2 rounds | yes | audited, not wired (the rewrite itself is prose) |
| G5 | Case-paper review (`generateCaseDeck`) | six paper-level checks + per-question issues | `noul`; per-question attribution is text | 1 per paper | yes | audited, not wired |
| G6 | Teaching-article review (`workflow-teaching.js`) | five booleans + issues text fed back into the rewrite | `noul` for the booleans | 1 per attempt | yes | audited, not wired |
| F2 | `deck.merge.suggest` | `{targetId, sourceIds[], reason}`; a proposal without a reason is dropped | pairwise `noul` would approximate clustering; reason is text | 1 per course | learner click | audited, not wired |
| F3 | `draft.import.propose` | `{title, course, mergeTargetId}` | course and merge target: `choice`; the title is text | 1 | learner click (the bulk import applies the title) | audited, not wired |
| F4 | Question placement in `capture` | `{duplicateOf, deckId, newDeck, topic, reason}` | duplicate and deck pick: `choice`; new names and reason are text | 1 | yes | audited, not wired |
| F5 | `focus.suggest` | `{role, targetTopics[]}` | one `noul` per topic (best fit among the audited sites) | 1 | learner click | audited, not wired |
| F6 | Quick-start topic pick (`pickScope`) | `{keys[], title}` ordered | per-topic `noul`; ordering and title lost | 1 | yes | audited, not wired |
| F7 | `generate.suggest` | focus text, count, difficulty, kind | difficulty and kind only; the product is the focus text | 1 | learner click | not replaceable |
| F8 | `materials.outline.suggest` | where sections start and at what level, with titles | per-block `choice`; titles of heading-less sections are text | 1 per document | learner click | audited, not wired |
| V1 | Guided-teaching check (`teach.answer`) | `{passed, feedback}` | `noul` for `passed`; the feedback is prose | 1 per answer | yes: advances the rung | audited, not wired |
| V2 | Rubric grading (`gradeCase`, `card.grade`) | per criterion scores, quotes, suggestions | scores could be coarse `score` bands; quotes and suggestions are text | 1 per answer | yes: schedules SM-2 | audited, not wired |
| V3 | Oral-exam assessment (`oral.submit`) | `{cardId, band, reason}` per answer | `choice`/`score` for the band; the reason is text | 1 per exam | yes: reschedules | audited, not wired (mostly typed: a good next candidate) |
| V4 | Transcript proof-review (`audio.corrections.review`) | `apply` / `reject` / `unsure` + a replacement text | verdict `choice`; the replacement is text | 1 per 15 items | yes: edits the transcript | audited, not wired |
| V5 | Retelling feedback (`workflow.feedback`) | covered, missing, question, suggestion, note | only `suggestion` is typed | 1 | hint only | not replaceable |
| – | Plan call, assist `ask` prerequisite pick, assist `improve`, live correction, audio proofread, coach debrief | decisions embedded inside a larger generation or rewrite | not separable | – | – | not replaceable |

The extra-signal experiments are separate (and keep their own switches): `courseSuggest` (a "Jev 建议" button with probabilities beside "请 AI 建议"),
`preReview` (a cheap pre-check before the independent review), `outlineNoise` (an interface only: the reader does not call it yet) and `levelCheck`
(a developer panel).

### What a replaced site does

| Site | Where it shows | What Jev does | Falls back to the model when | Never does |
|---|---|---|---|---|
| `cardReview` | Draft: a "由 Jev 判定" mark per card and a one-line summary ("Jev (experimental) judged N questions ..., the other M by the independent model review") | One `noul` per applicable dimension (`selfContained`, `answerLeak`, `optionQuality`, `learningValue`, `sourceSupport`, `explanationQuality`). All applicable dimensions at least as sure to pass as the line: accepted. One at least as sure to fail: rejected (dropped exactly like a model-rejected card, with the reason in the omitted list). | a middling answer, a multi-answer card, a card with no evidence or explanation, Jev failing: **one** model review call over exactly those cards (with every card falling back it is the very call a run without Jev makes) | Write review text: its findings are built from its own numbers. Replace the review for the cards it is unsure about. Mark its decisions as the model's: the draft summary and `editorial.jevDecided` say who decided what. |
| `courseOrganize` | Sources › Organize courses: the usual proposal rows, each Jev-decided one marked "由 Jev 判定", plus one line "Jev gave N suggestions; the model gave the other M" | One `choice` over the existing courses (containment-aware: a chapter's probability counts toward its parent). A course at least as sure as the line is the suggestion. | unsure, "none of the listed courses fits" (the model may propose a new course name), no courses yet, Jev failing: **one** model call over those sources | Apply anything: it proposes; "确认应用建议" with its `expectedCourses` check is still the only way a course changes. |

Tokens for each replaceable site are counted in their own row of the Jev usage page and never mixed with the study model's ledger.

### Hooking the reader's outline (documented hook, not wired)

```js
const { labels } = await call('jev.outline.classify', { entries });          // entries: [{ id, level, title }], 1-200; labels {} when Jev is off or failing
const shown = applyOutlineLabels(entries, labels, { threshold: 0.8 });       // ui/jev-outline.js, pure; mode 'keep' mutes instead of dropping
```

Only a confident label changes anything. Order never changes, the input is not modified, and an outline is never emptied.

## The extra-signal experiments

| Experiment | Where it shows | What it does | Never does |
|---|---|---|---|
| 课程归属建议 (`courseSuggest`) | Sources > Organize courses: a "Jev 建议" button next to "Suggest with AI" | One `choice` per source over the learner's courses (containment-aware: a chapter's probability counts toward its parent; a lookalike name is not a parent), shows each course's probability; fills a course in only when its subtree reaches the confidence line (default 80%, adjustable) | Apply anything. The existing "Apply suggestions" button, with its `expectedCourses` check, is the only way a course changes |
| 出题预审 (`preReview`) | Draft cards: a small "Jev 预审" badge and the probabilities inside the opened card | Before the independent review, `noul` questions per card (does the stem give the answer away; can it be understood without the source; is the answer in the evidence; is exactly one option defensible). A confident failure sends the card back for **one** rewrite | Replace the review. **Every** card, flagged or not, still goes through the existing independent review (`lib/generation.js`), which stays the only gate. The signals are stored as numbers only (`editorial.jev`) |
| 目录噪声判断 (`outlineNoise`) | Nothing yet: an operation and a pure function | `jev.outline.classify` labels headings chapter / label / running header or footer / other; `applyOutlineLabels` demotes or drops confident noise | Edit the reader (it belongs to another work package) |
| 题目认知层次对照 (`levelCheck`) | Settings > Jev > developer panel | Jev's reading (recall / concept / application) next to the code's keyword heuristic, with agreement counts | Replace the heuristic or store anything |

## Adding another provider

The experiments call `provider.decide(state, questions, { signal })` and nothing else (`lib/jev.js` documents the seam). A provider is
`{ id, decide }`; `decide` resolves

```js
{ model, answers: { <name>: { type: 'noul', noul } | { type: 'choice', choice, probabilities, confidence } | { type: 'score', score, probabilities, confidence } },
  usage: { inputTokens, outputTokens } }
```

for `questions: { <name>: { type: 'noul' | 'choice' | 'score', instructions, criteria? } }` (`criteria` is a map of option to description for `choice`, an
ordered array for `score`, `{ true, false }` for `noul`). Pass it with `createJevRuntime({ provider: settings => ({ id, decide }) })`
(`lib/jev-runtime.js`; for a running service, `new StudyService(root, { jev: { provider } })`). A model reached through opencode/DSH, or a local
classifier, plugs in the same way. Note that a text model has no calibrated probabilities: ones it states about itself are exactly what
`scripts/eval-jev.mjs` is there to check.

## Evaluation

```
JEV_API_KEY=<your key> node scripts/eval-jev.mjs tests/fixtures/jev-eval/dataset.json
node scripts/eval-jev.mjs my-dataset.json --provider opencode-zen-free --features cardReview,courseOrganize --yes     # key from OPENCODE_GO_API_KEY_2
```

`scripts/eval-jev.mjs` runs the real request code over labelled items and reports accuracy, precision and recall, F1, calibration (ECE) and tokens per
experiment and per item. `--provider typesafe|opencode-zen-free|opencode-zen|custom` picks the service (the key comes from the environment variable the
preset names, `--key-env NAME` names another one, `--endpoint` and `--model` fill in the custom preset); it does nothing without that variable. For the
**replaceable sites** (`cardReview`, `courseOrganize`) the dataset can carry, per item, what the current model path answered (`model`); the report then
compares Jev with it: how much Jev settles at the line, its accuracy when it settles, the hybrid the product really runs (Jev where sure, the model for
the rest) against the model alone, the agreement, and Jev's latency per call and tokens. `tests/fixtures/jev-eval/README.md` explains the dataset
format and how to build one from a **copy** of your library (`--skeleton`). `scripts/jev-live-check.mjs` is the separate, tiny live check of the API
assumptions (also takes `--provider`, also does nothing without a key).

### Results (to be filled in by the owner; nothing here is measured yet)

| Experiment | Items | Language mix | Accuracy | Precision @ 80% | Recall @ 80% | ECE | Tokens in / item | Tokens out / item | Date, key plan |
|---|---|---|---|---|---|---|---|---|---|
| courseSuggest | | | | | | | | | |
| preReview: stemLeaksAnswer | | | | | | | | | |
| preReview: needsSource | | | | | | | | | |
| preReview: answerInEvidence | | | | | | | | | |
| preReview: oneDefensible | | | | | | | | | |
| outlineNoise | | | | | | | | | |
| levelCheck (Jev) | | | | | | | | | |
| levelCheck (code heuristic) | | | | | | | | | |

| Replaceable site | Items | Settled at 80% | Accuracy when settled | Model alone | Hybrid | Agreement | Jev latency / call | Tokens in / item | Date, provider |
|---|---|---|---|---|---|---|---|---|---|
| cardReview | | | | | | | | | |
| courseOrganize | | | | | | | | | |

Also record: whether the pre-check's flagged cards are the ones the independent review rejects (run it on drafts you already reviewed), and the
Chinese-versus-English difference the report's "by language" line shows.

## Not verified

- **Not verified**: the real OpenCode Zen endpoint (`https://opencode.ai/zen/v1/systemone`, request and answer shapes, the models `jev-1.13` and
  `jev-1.13-free`), how Zen words its errors (402 and the others are mapped by status only), the real key, and whether DSH passes
  `OPENCODE_GO_API_KEY_2` into the plugin process. Everything above was tested against a local fake server written from the documentation.
- The wire formats of OpenRouter, AIML and Netlify AI Gateway (the custom endpoint assumes the same typed API).
- Whether OpenCode retains prompts sent to `jev-1.13-free` or trains on them: its documentation does not say.
- Quality: no number about real Jev appears in the product or in this document; the tables above are empty on purpose. Whether replacing a model call
  with Jev is faster, cheaper or less accurate on your material is what the evaluation script is for.

## Limitations

- Quality is **unverified**. Retention for a normal TypeSafe account is not documented (see above). Free tier, price and rate limits are not stated by StudyHub.
- The vendor describes Jev as unreliable at arithmetic, dates and counting, and as text-only with a 64k-token context (a 32k-token budget for the
  state plus the longest question); the client refuses to send more than 24,000 characters of state.
- The 出题预审 rewrite is one extra author-model call when a card is flagged. Whether it saves more review work than it costs is not measured.
- 出题预审 and the `cardReview` replacement run in the generation job (`generate`: `lib/batch.js` → `generateDeck`), not in passage supplementation, the
  publish-time review, the repair loop or case papers.
- The client retries 429/529/5xx and network failures twice with exponential backoff (0.5 s doubling to 5 s, jitter that only shortens, a 10 s ceiling on a
  server-supplied `Retry-After`), mirroring the vendor SDK's documented defaults; behaviour under sustained rate limiting has only been tested against a fake server.
- The wire format (request and answer shapes) was taken from docs.typesafe.ai and tested against a fake server written from it; `scripts/jev-live-check.mjs`
  is how to confirm it against the real service.
- A draft whose cards Jev accepted carries the same review receipts as a model-reviewed one (so the publish-time check does not re-review them); the
  provenance is in `editorial.jevDecided`.
