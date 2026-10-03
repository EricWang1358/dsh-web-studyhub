# Jev decision layer (experimental)

**Jev is only ever an experimental feature of this plugin.** It is opt-in, off by default, hidden until a learner turns on *Show experimental features* (**Settings › Experimental features**), and labelled *experimental* wherever it appears; nothing in StudyHub depends on it, nothing here is a recommendation, and no wording in the product or in this document suggests that it will graduate from the experimental stage or be made a default. A learner who never turns that switch on never sees that Jev exists.

## What Jev does here

StudyHub can ask **Jev**, TypeSafe AI's "System One" model, small classifier-shaped questions. Examples: *which course does this source belong to?* and *does this question give its answer away?* By the vendor's account, Jev answers these faster and more cheaply than a text-generation model. StudyHub has not verified that.

There are two ways to use it. Both are opt-in and off by default:

- **Extra reference signals** shown next to what StudyHub already does (four experiments; see [The extra-signal experiments](#the-extra-signal-experiments)).
- **Optional replacement** for a few model calls that StudyHub otherwise makes: the model's yes/no, pick-one or score answers (two sites; see [Replacing model calls](#replacing-model-calls)).

Nothing is sent to Jev until the learner has done all of the following:

1. shown the experimental features;
2. chosen a provider;
3. made a key available;
4. confirmed that provider's privacy note;
5. switched on the master switch, **Enable the Jev experiments (master switch)**;
6. switched on the individual experiment or replacement.

A Jev that is off, failing, rate limited or unsure never changes what StudyHub does. Every site falls back automatically to exactly the model path it had before, and says so once per run.

Jev's answers are **typed decisions**: a probability, a choice among labelled options, or a level on a scale. It never writes prose, and it never applies anything by itself:

- A replaced decision is applied exactly like the model's decision it replaced, and only because the learner switched that site on.
- Everything that needs the learner's click without Jev still needs it.

## Code map

| File | Role |
| --- | --- |
| `lib/experimental.js` | The **Show experimental features** switch |
| `lib/jev-providers.js` | Provider presets, custom-endpoint checks and the key lookup for scripts |
| `lib/jev-settings.js` | The settings file, keys, confirmations, the gate (`jevGate`), `JEV_FEATURES` and `JEV_NOTICE_VERSION` |
| `lib/jev-sites.js` | The replaceable sites (`JEV_REPLACE_SITES`) |
| `lib/jev.js` | The HTTP client, error mapping and the provider seam |
| `lib/jev-runtime.js` | The one door every call goes through (`createJevRuntime`) |
| `lib/jev-decide.js` | The replacement seam (`replaceWithJev`) |
| `lib/jev-hooks.js` | The hooks the generation pipeline and the course organiser call |
| `lib/jev-review.js`, `lib/jev-course-suggest.js` | The `cardReview` site; the `courseSuggest` experiment and the `courseOrganize` site |
| `lib/jev-triage.js`, `lib/jev-outline.js`, `lib/jev-levels.js` | The `preReview`, `outlineNoise` and `levelCheck` experiments |
| `lib/jev-usage.js`, `lib/jev-messages.js` | The token meter; the zh/en messages |
| `lib/jev-operations.js` | Operations mounted by the system context: `jev.settings.get`, `jev.settings.set`, `jev.test`, `jev.outline.classify`, `jev.usage` |
| `lib/contexts/library/operations.js` | The `source.organize.suggest` hook, `source.organize.jev` and `jev.levels.check` |
| `ui/JevSettings.jsx`, `ui/jev-flow.js` | The settings block, the walk-through and the privacy note |
| `ui/JevBadge.jsx`, `ui/JevOrganize.jsx`, `ui/JevLevelCheck.jsx`, `ui/jev-outline.js` | Marks on drafts and sources, the developer panel and the outline hook |
| `ui/locales/en.jev.json` | English strings |
| `lib/jev-eval.js`, `scripts/eval-jev.mjs`, `scripts/jev-live-check.mjs` | Evaluation and the live API check |
| `tests/helpers/fake-jev.mjs`, `tests/jev-*.test.mjs` | The fake server and the tests. `tests/jev-docs.test.mjs` keeps this page's promises in step with the code |

## Showing and hiding it

**Settings › Experimental features** holds one switch, **Show experimental features** (`lib/experimental.js`).

- It is stored in the DSH home as `<DSH home>/study/experimental.json`, never in the library. An export or a backup therefore never turns it on elsewhere.
- It is off by default.
- It rides on the snapshot (`experimental`), so no surface needs a request of its own to know it.

**Off:**

- No Jev section in Settings, no **Jev suggestion** (Jev 建议) button, and no **Jev pre-check** (Jev 预审) or **Decided by Jev** (由 Jev 判定) mark.
- No mention in the tour, welcome, home, setup checklist, help sheets, notices or inbox. No extra request and no timer.
- Every component that can draw something about Jev draws exactly what a build without Jev draws. `tests/jev-hidden-flow.test.mjs` renders each one with the switch off and scans the markup, in both languages.
- The pipeline hooks (`jevPreReviewHook`, `jevReviewHook`, `jevOrganizeHook`) return `undefined`, so the model call sequence is untouched.
- What stays with a draft (findings, summary) never names Jev. Only `editorial.jevDecided` and the marks shown with the features say who decided what.

**On:** the experimental block appears under the switch as one guided flow, in this order:

1. **What Jev could replace**, a short walk-through (next, back, skip) shown nowhere else. It has one step per replaceable call: what it does now, what Jev would do instead, and the trade-off ("faster and cheaper, but accuracy may drop").
2. The provider, its key source, the key test (**Test the Jev key**) and that provider's privacy confirmation.
3. The switches. Each replacement turns **on at once**, with no save step. If the provider, the key or the confirmation is still missing, the switch says what is missing and offers that step. A switch that needs the master switch turns it on too, and says so.

**Turning it off again** hides all of it and stops every experimental feature at once. The choices inside are kept but inactive.

## Providers

The presets live in one small table, `lib/jev-providers.js`. The request and answer shapes are the same for every provider; only the address, the model id, the default key variable and the wording differ.

| Provider id | Endpoint | Model | Default key variable | Notes |
|---|---|---|---|---|
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `JEV_API_KEY` | TypeSafe's own API. Behaviour unchanged by the presets. |
| `opencode-go` | `https://opencode.ai/zen/go/v1/systemone` | `jev-1.13` | `OPENCODE_GO_API_KEY_2` | OpenCode Go (the subscription DSH shows as "OpenCode Go 2"). **Not verified**: the route exists (an unauthenticated POST answers 401, an unknown path 404), but OpenCode's public Go model list names no Jev model, so whether a Go key is accepted here is unknown. If it is not, use `custom` with the address you know. |
| `opencode-zen-free` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13-free` | `OPENCODE_GO_API_KEY_2` | OpenCode Zen's free Jev model, offered for a limited time. |
| `opencode-zen` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13` | `OPENCODE_GO_API_KEY_2` | OpenCode Zen's paid Jev model, billed by OpenCode. The product shows tokens only, never a price; see OpenCode's own pricing page. |
| `custom` | the address the learner enters | the model id the learner enters | `JEV_CUSTOM_API_KEY` | For another gateway that offers the same typed API. OpenRouter, AIML and Netlify AI Gateway were reported to list Jev, but **their wire formats are not verified**. The preset only assumes the same `POST { model, state, questions }` with a bearer key. |

The OpenCode facts come from https://opencode.ai/docs/zen/ and the public `/zen/v1/models` list. The same OpenCode key works for Zen and Go.

**Custom endpoint rules** (`isCustomEndpoint`, `isCustomModel`):

- The address must be https; http is accepted only for this machine (`localhost`, `127.0.0.1`, `[::1]`).
- It may not hold a user name, password, query or fragment, and has at most 300 characters.
- The model id is a plain token of letters, digits and `. _ : / -`, at most 100 characters.

### Keys

A key is resolved in this order:

1. a key pasted in the settings, kept per service: TypeSafe's in `key` as before, OpenCode's in `opencodeKey`, the custom endpoint's in `customKey`;
2. the environment variable named by the setting `keyEnv` (default per preset, in the table);
3. `JEV_API_KEY`, for TypeSafe only.

Key rules:

- A key never crosses services. A TypeSafe key, pasted or from `JEV_API_KEY`, is never sent to OpenCode or to a custom endpoint, and the other way round.
- **A key that comes from an environment variable is never stored.** Only the variable's *name* is saved, and the value is read when a request is sent. The settings page says "key from environment variable NAME (found / not found)" without showing any character of the value.
- DSH's own *OpenCode 2* account keeps its key in `OPENCODE_GO_API_KEY_2`, and DSH does not copy it into plugin settings. Neither does StudyHub, so the OpenCode presets read that variable and nothing else.
- If the variable is not visible to the plugin process, the page says so plainly; DSH may not pass it on. The learner can paste a key instead, or start DSH with the variable set.

### Errors and retries

Errors are typed. Each comes with a plain zh/en sentence that names the provider and never holds the key, the learner's text or a response body.

| Cause | Code | Retried |
|---|---|---|
| HTTP 401 or 403 (key rejected) | `invalid-key` | No |
| HTTP 402 (insufficient balance) | `insufficient-balance` | No |
| HTTP 400 or 422 | `invalid-request` | No |
| HTTP 429 | `rate-limited` | Yes |
| HTTP 529 | `overloaded` | Yes |
| Other HTTP 5xx | `unavailable` | Yes |
| HTTP 408, or no answer within 30 s | `timeout` | Yes |
| Network failure | `network` | Yes |
| State over 24,000 characters | `too-large` | Not sent |
| An answer that does not fit the question | `bad-response` | No |
| Any other HTTP status | `unexpected` | No |

Retried failures are retried twice with backoff. A `Retry-After` longer than 10 s is reported instead of waited for.

**`JEV_BASE_URL`** still redirects every provider, for tests and previews. The preset's path, or the custom endpoint's path, is kept. `tests/helpers/fake-jev.mjs` serves both layouts and enforces the `Authorization` header.

## What is sent, where, and what is not known (per provider)

**What** (all providers): only what the experiments or replacements you switched on need, and only when you use them. The whole library is never uploaded. The key is sent only in the `Authorization` header.

| Feature | What is sent |
|---|---|
| Course suggestions (`courseSuggest`, `courseOrganize`) | A source's *title and a short excerpt* (the first 1,000 characters), and the *course names*, each with up to three titles already filed under it |
| Card review and pre-check (`cardReview`, `preReview`) | A candidate question with its options, answer, hint, explanation and quoted evidence |
| Outline check (`outlineNoise`) | Outline heading texts |
| Level cross-check (`levelCheck`) | A question with its options and answer |

**Where it goes, by provider:**

- **TypeSafe** (`typesafe`; docs.typesafe.ai/legal): goes to `api.typesafe.ai`, not through your study model. Its privacy policy commits not to train models on user data; zero data retention is offered to *enterprise* customers. **How long a normal account's data is retained is not documented**, and the product says exactly that. Assume what you send may be kept for some time.
- **OpenCode** (`opencode-zen-free`, `opencode-zen`, `opencode-go`): goes to OpenCode's Zen service (or, for `opencode-go`, its Go service) and on to its provider TypeSafe AI, not through your study model.
  - OpenCode's documentation states that its providers generally follow zero retention and do not train on data. This is OpenCode's statement and is not verified here.
  - **For Jev 1.13 Free, the documentation does not say whether prompts are retained or used for training.** It only says the model is available on OpenCode for a limited time.
  - The product treats that as **unknown**, says so in the privacy note, and tells the learner not to use confidential material with the free model.
  - Whether the Go route accepts Jev at all is not verified (see the providers table).
- **Custom endpoint** (`custom`): goes to the address the learner entered. StudyHub does not know who runs it, how long it keeps what it receives or whether it trains on prompts (unknown). The wire format is unverified.

**The confirmation is per provider.**

- It is keyed by `JEV_NOTICE_VERSION` in `lib/jev-settings.js` plus the provider id. TypeSafe's stays in `confirmedAt` and `noticeVersion` as before; the other providers' go in `confirmations`.
- The custom endpoint's confirmation is also bound to its address, so a new address asks again.
- Changing provider asks again; going back finds the earlier confirmation.
- When a note changes in substance, bump the version, and everyone is asked again.

**Not claimed anywhere in the product:** a free tier of TypeSafe, a price or a rate limit. The settings page shows the tokens used (`usage` as reported by the service) and nothing else about cost. Check the provider's own pages for plans and limits.

**Language:** the provider's models page says English is the primary language. Other languages, CJK included, are supported but less optimised. Expect weaker results on Chinese material, and measure it (see [Evaluation](#evaluation)) before relying on it.

The privacy note text lives in `ui/jev-flow.js` (`privacyPoints`), with its English in `ui/locales/en.jev.json`.

## Settings and gates

The Jev section, **Experimental · Jev decision service**, sits under **Settings › Experimental features** (`ui/JevSettings.jsx`).

- **Pasted key.** It is stored like the audio keys and the MinerU token: in `<DSH home>/study/jev.json`, with owner-only permissions. It is shown back only as its last four characters. It never appears in the library, an export, a backup, a snapshot or a log.
- **Token counters.** They live next to the key (`jev-usage.json`, at most 90 days of rows), separately from the study model's ledger. There is one row per experiment and per replaceable site.

Every call goes through one door, `lib/jev-runtime.js`, which re-reads the settings and checks, in this order:

1. the master switch (the kill switch);
2. the feature's or site's own switch;
3. for the custom provider only, that the endpoint address and model are filled in;
4. a key;
5. the confirmation.

It resolves `{ ok: true, answers, usage }` or `{ ok: false, reason, message }`. It does not throw for anything the service, the network or the settings can do. The one exception is an aborted signal, that is, a cancelled job.

The pipeline hooks additionally require **Show experimental features**.

## Replacing model calls

### The seam

`replaceWithJev({ runtime, site, items, build, read, fallback, threshold, ... })` in `lib/jev-decide.js` is the one routing function the sites use.

- **Site not switched on** (or the experimental features hidden): `fallback(items)` runs once over all items in their original order, before anything else. The model call sequence is **byte-identical** to a build without Jev. Jev is not contacted and not mentioned.
- **Site switched on:**
  - Each item becomes one tiny typed request (`build`), and Jev's answer is read back (`read`).
  - An item answered with at least the learner's confidence line (default 80%) is **decided by Jev**.
  - Everything else goes to `fallback` in **one** call, as one list in the original order, never per item. "Everything else" means low confidence, an input Jev cannot take, a failing, rate-limited or unreachable Jev, or a missing key or confirmation.
- **The result says what happened.** Each entry is `by: 'jev' | 'model'`. The summary carries the counts, Jev's tokens (counted apart) and **one** fallback notice for the whole run.
- **Nothing is applied here.** A cancelled run and a failing `fallback` reject as they always did.

### Audit: where StudyHub asks a model for a decision-shaped answer

"Typed" means the answer maps onto one of Jev's three question types:

- `noul`: the probability of yes;
- `choice`: one of up to 255 labelled options, with probabilities;
- `score`: one of 2–10 ordered levels.

Jev returns **no free text**, so prose, explanations, translations, rewritten cards and outline text can never be replaced. "Applied" means the answer takes effect without a learner click. File references are to this repository at the time of the audit.

| # | Site (operation, file) | Decision the model returns | Typed? | Model calls | Applied? | Status |
|---|---|---|---|---|---|---|
| G1 | Independent review of generated cards (`generate` → `lib/batch.js` → `generateDeck` → `reviewDeck`, `lib/generation.js`) | per card pass/fail on six dimensions + free-text findings | six `noul` per card; findings are text | 1 per part of at most 5 cards | yes: flagged cards are dropped | **wired: `cardReview`** |
| F1 | **Suggest with AI** (`source.organize.suggest`, `lib/contexts/library/operations.js`) | per source `{courses[], reason}`; may invent new course names | `choice` over existing courses + none | 1 for all sources | learner click | **wired: `courseOrganize`** (new names, several courses and the reason text stay with the model) |
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

The extra-signal experiments are separate and keep their own switches; see [The extra-signal experiments](#the-extra-signal-experiments).

### What a replaced site does

| Site | Where it shows | What Jev does | Falls back to the model when | Never does |
|---|---|---|---|---|
| `cardReview` | Draft: a **Decided by Jev** mark per card and a one-line summary ("Jev (experimental) judged N questions (A accepted, R rejected), and the independent model review judged the other M.") | One `noul` per applicable dimension (`selfContained`, `answerLeak`, `optionQuality`, `learningValue`, `sourceSupport`, `explanationQuality`). If every applicable dimension is at least as sure to pass as the line, the card is accepted. If one is at least as sure to fail, the card is rejected: dropped exactly like a model-rejected card, with the reason in the omitted list. | a middling answer, a multi-answer card, a card with no evidence or explanation, or a failing Jev: **one** model review call over exactly those cards. When every card falls back, it is the very call a run without Jev makes. | Write review text: its findings are built from its own numbers. Replace the review for the cards it is unsure about. Pass its decisions off as the model's: the draft summary and `editorial.jevDecided` say who decided what. |
| `courseOrganize` | **Sources › Organize courses**: the usual proposal rows, each Jev-decided one marked **Decided by Jev**, plus one line "Jev (experimental) gave N suggestions; the model gave the other M." | One `choice` over the existing courses. It is containment-aware: a chapter's probability counts toward its parent. A course at least as sure as the line is the suggestion. | it is unsure, "none of the listed courses fits" (the model may propose a new course name), there are no courses yet, or Jev fails: **one** model call over those sources | Apply anything. It only proposes: **Apply suggestions**, with its `expectedCourses` check, is still the only way a course changes. |

Tokens for each replaceable site are counted in their own row of the Jev usage page and never mixed with the study model's ledger.

### Hook the reader's outline (documented, not wired)

```js
const { labels } = await call('jev.outline.classify', { entries });          // entries: [{ id, level, title }], 1-200; labels {} when Jev is off or failing
const shown = applyOutlineLabels(entries, labels, { threshold: 0.8 });       // ui/jev-outline.js, pure; mode 'keep' mutes instead of dropping
```

- Only a confident label changes anything. A confident running header or footer is dropped (or muted in `keep` mode). A confident small label goes one level deeper and is muted.
- Order never changes, the input is not modified, and an outline is never emptied.
- The reader's outline lives in `ui/document-preview/reader/outline.js`, which belongs to another work package.

## The extra-signal experiments

| Experiment | Where it shows | What it does | Never does |
|---|---|---|---|
| **Course ownership suggestions** (`courseSuggest`) | **Sources › Organize courses**: a **Jev suggestion** button next to **Suggest with AI** | One `choice` per source over the learner's courses and shows each course's probability. It is containment-aware: a chapter's probability counts toward its parent, and a lookalike name is not a parent. It fills a course in only when its subtree reaches the confidence line (default 80%, adjustable). | Apply anything. The existing **Apply suggestions** button, with its `expectedCourses` check, is the only way a course changes |
| **Question pre-check** (`preReview`) | Draft cards: a small **Jev pre-check** badge, and the probabilities inside the opened card | Before the independent review, it asks `noul` questions per card: does the stem give the answer away; can it be understood without the source; is the answer in the evidence; is exactly one option defensible. A confident failure sends the card back for **one** rewrite | Replace the review. **Every** card, flagged or not, still goes through the existing independent review (`lib/generation.js`), which stays the only gate. The signals are stored as numbers only (`editorial.jev`) |
| **Outline noise check** (`outlineNoise`) | Nothing yet: an operation and a pure function | `jev.outline.classify` labels headings as chapter, label, running header or footer, or other. `applyOutlineLabels` demotes or drops confident noise | Edit the reader (it belongs to another work package) |
| **Cognitive level cross-check** (`levelCheck`) | **Settings › Experimental features**, in the Jev section under **Developer panel: cognitive level cross-check** | Jev's reading (recall, concept or application) of up to 30 questions spread evenly over the library (the operation accepts up to 60), next to the code's keyword heuristic, with agreement counts | Replace the heuristic or store anything |

## Add another provider

The experiments call `provider.decide(state, questions, { signal })` and nothing else; `lib/jev.js` documents the seam. A provider is `{ id, decide }`, and `decide` resolves

```js
{ model, answers: { <name>: { type: 'noul', noul } | { type: 'choice', choice, probabilities, confidence } | { type: 'score', score, probabilities, confidence } },
  usage: { inputTokens, outputTokens } }
```

for `questions: { <name>: { type: 'noul' | 'choice' | 'score', instructions, criteria? } }`. `criteria` is a map of option to description for `choice`, an ordered array for `score`, and `{ true, false }` for `noul`.

- Pass it with `createJevRuntime({ provider: settings => ({ id, decide }) })` (`lib/jev-runtime.js`).
- For a running service, use `new StudyService(root, { jev: { provider } })`.
- A model reached through opencode/DSH, or a local classifier, plugs in the same way.

A text model has no calibrated probabilities. The probabilities it states about itself are exactly what `scripts/eval-jev.mjs` is there to check.

## Evaluation

```
JEV_API_KEY=<your key> node scripts/eval-jev.mjs tests/fixtures/jev-eval/dataset.json
node scripts/eval-jev.mjs my-dataset.json --provider opencode-zen-free --features cardReview,courseOrganize --yes     # key from OPENCODE_GO_API_KEY_2
```

`scripts/eval-jev.mjs` runs the real request code over labelled items. It reports accuracy, precision and recall, F1, calibration (ECE) and tokens per experiment and per item.

**Options:**

- `--provider <id>` picks any provider id from the table.
- The key comes from the environment variable the preset names; `--key-env NAME` names another one. Without that variable, the script does nothing.
- `--endpoint` and `--model` fill in the custom preset.
- Any dataset other than the public example under `tests/fixtures/jev-eval/` needs `--yes`, because it may hold your own material.

**Replaceable sites.** For `cardReview` and `courseOrganize`, the dataset can carry, per item, what the current model path answered (`model`). The report then compares Jev with it:

- how much Jev settles at the line, and its accuracy when it settles;
- the hybrid the product really runs (Jev where sure, the model for the rest) against the model alone;
- the agreement;
- Jev's latency per call and its tokens.

**Your own dataset.** `tests/fixtures/jev-eval/README.md` explains the dataset format and how to build one from a **copy** of your library (`--skeleton`, which needs no key and no network).

`scripts/jev-live-check.mjs` is the separate, tiny live check of the API assumptions. It also takes `--provider`, and it also does nothing without a key.

### Results

To be filled in by the owner; nothing here is measured yet.

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

Also record:

- whether the pre-check's flagged cards are the ones the independent review rejects (run it on drafts you already reviewed);
- the Chinese-versus-English difference that the report's "by language" line shows.

## Not verified

- **Not verified**: the real OpenCode Zen endpoint (`https://opencode.ai/zen/v1/systemone`, request and answer shapes, the models `jev-1.13` and `jev-1.13-free`), how Zen words its errors (402 and the others are mapped by status only), the real key, and whether DSH passes `OPENCODE_GO_API_KEY_2` into the plugin process. Everything above was tested against a local fake server written from the documentation.
- Whether the OpenCode Go route accepts a Go key for Jev.
- The wire formats of OpenRouter, AIML and Netlify AI Gateway (the custom endpoint assumes the same typed API).
- Whether OpenCode retains prompts sent to `jev-1.13-free` or trains on them: its documentation does not say.
- Quality: no number about real Jev appears in the product or in this document; the tables above are empty on purpose. Whether replacing a model call with Jev is faster, cheaper or less accurate on your material is what the evaluation script is for.

## Limitations

- Quality is **unverified**. Retention for a normal TypeSafe account is not documented (see above). StudyHub states no free tier, price or rate limit.
- The vendor describes Jev as unreliable at arithmetic, dates and counting, and as text-only with a 64k-token context (a 32k-token budget for the state plus the longest question). The client refuses to send more than 24,000 characters of state.
- The **Question pre-check** rewrite is one extra author-model call when a card is flagged. Whether it saves more review work than it costs is not measured.
- The **Question pre-check** and the `cardReview` replacement run only in the generation job (`generate`: `lib/batch.js` → `generateDeck`). They do not run in passage supplementation, the publish-time review, the repair loop or case papers.
- The client retries 429, 529, 5xx, timeouts and network failures twice with exponential backoff. The backoff is 0.5 s doubling to 5 s, with jitter that only shortens it and a 10 s ceiling on a server-supplied `Retry-After`. This mirrors the vendor SDK's documented defaults. Behaviour under sustained rate limiting has only been tested against a fake server.
- The wire format (request and answer shapes) was taken from docs.typesafe.ai and tested against a fake server written from it. `scripts/jev-live-check.mjs` is how to confirm it against the real service.
- A draft whose cards Jev accepted carries the same review receipts as a model-reviewed one, so the publish-time check does not review them again. The provenance is in `editorial.jevDecided`.
