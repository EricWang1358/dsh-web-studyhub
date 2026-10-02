# Jev decision layer (experimental)

StudyHub can ask **Jev**, TypeSafe AI's "System One" model, small classifier-shaped questions that a text-generation model would answer at far
higher cost: *which course does this source belong to?*, *does this question give its answer away?*. It is **experimental, opt-in, and off by
default**. Nothing is sent to Jev until the learner has saved a key, confirmed the privacy note, switched the master switch on and switched on the
individual experiment. A Jev that is off, failing or slow never changes what StudyHub does: every experiment falls back to today's behaviour.

Jev's answers are **signals**, never decisions. It never writes to the library by itself, never approves or drops a question, and the existing
independent review and the learner's apply buttons remain the only gates.

## What is sent, where, and what is not known

- **What**: only what the experiments you switched on need, and only when you use them. A source's *title and a short excerpt* (the first 1,000
  characters) and the *course names* (with up to three titles already filed under each) for the course suggestion; a candidate question with its
  options, answer and quoted evidence for the pre-check; outline heading texts for the outline check; a question with its options and answer for the
  level cross-check. The whole library is never uploaded. The key is sent only in the `Authorization` header.
- **Where**: `https://api.typesafe.ai/v1/systemone` (TypeSafe AI's cloud), not through your study model. `JEV_BASE_URL` overrides it (tests, previews).
- **What the provider states** (docs.typesafe.ai/legal): its privacy policy commits not to train models on user data; zero data retention is offered
  to *enterprise* customers. **How long a normal account's data is retained is not documented**, and the product says exactly that in the privacy note.
  Assume what you send may be kept for some time.
- **Not claimed anywhere in the product**: a free tier, a price, a rate limit. The settings page shows the tokens used (`usage` as reported by the
  service) and nothing else about cost. Check the provider's own pages for plans and limits.
- **Language**: the provider's models page says English is the primary language and other languages, CJK included, are supported but less optimised.
  Expect weaker results on Chinese material; measure it (below) before relying on it.

The privacy note text lives in `ui/jev-flow.js` (`privacyPoints`), with its English in `ui/locales/en.jev.json`. A confirmation belongs to one
version of the note (`JEV_NOTICE_VERSION` in `lib/jev-settings.js`): when the note changes in substance, bump it and everyone is asked again.

## Settings and gates

`Settings > Experimental · Jev decision service` (`ui/JevSettings.jsx`). The key is stored like the audio keys and the MinerU token:
`<DSH home>/study/jev.json`, owner-only permissions, `JEV_API_KEY` as a fallback, shown back only as its last four characters, never in the
library, an export, a backup, a snapshot or a log. Token counters live next to it (`jev-usage.json`), separately from the study model's ledger.

Every call goes through one door, `lib/jev-runtime.js`, which re-reads the settings and checks, in this order: master switch (the kill switch),
the experiment's switch, a key, the confirmation. It resolves `{ ok: true, answers, usage }` or `{ ok: false, reason, message }` and does not throw
for anything the service, the network or the settings can do (an aborted signal, i.e. a cancelled job, is the one exception).

## The experiments

| Experiment | Where it shows | What it does | Never does |
|---|---|---|---|
| 课程归属建议 (`courseSuggest`) | Sources > Organize courses: a "Jev 建议" button next to "Suggest with AI" | One `choice` per source over the learner's courses (containment-aware: a chapter's probability counts toward its parent; a lookalike name is not a parent), shows each course's probability; fills a course in only when its subtree reaches the confidence line (default 80%, adjustable) | Apply anything. The existing "Apply suggestions" button, with its `expectedCourses` check, is the only way a course changes |
| 出题预审 (`preReview`) | Draft cards: a small "Jev 预审" badge and the probabilities inside the opened card | Before the independent review, `noul` questions per card (does the stem give the answer away; can it be understood without the source; is the answer in the evidence; is exactly one option defensible). A confident failure sends the card back for **one** rewrite | Replace the review. **Every** card, flagged or not, still goes through the existing independent review (`lib/generation.js`), which stays the only gate. The signals are stored as numbers only (`editorial.jev`) |
| 目录噪声判断 (`outlineNoise`) | Nothing yet: an operation and a pure function | `jev.outline.classify` labels headings chapter / label / running header or footer / other; `applyOutlineLabels` demotes or drops confident noise | Edit the reader (it belongs to another work package) |
| 题目认知层次对照 (`levelCheck`) | Settings > Jev > developer panel | Jev's reading (recall / concept / application) next to the code's keyword heuristic, with agreement counts | Replace the heuristic or store anything |

### Hooking the reader's outline (documented hook, not wired)

```js
const { labels } = await call('jev.outline.classify', { entries });          // entries: [{ id, level, title }], 1-200; labels {} when Jev is off or failing
const shown = applyOutlineLabels(entries, labels, { threshold: 0.8 });       // ui/jev-outline.js, pure; mode 'keep' mutes instead of dropping
```

Only a confident label changes anything. Order never changes, the input is not modified, and an outline is never emptied.

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
```

`scripts/eval-jev.mjs` runs the real request code of the four experiments over labelled items and reports accuracy, precision and recall, F1,
calibration (ECE) and tokens per experiment and per item. It does nothing without `JEV_API_KEY`. `tests/fixtures/jev-eval/README.md` explains the
dataset format and how to build one from a **copy** of your library (`--skeleton`). `scripts/jev-live-check.mjs` is the separate, tiny live check of the
API assumptions (also does nothing without a key).

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

Also record: whether the pre-check's flagged cards are the ones the independent review rejects (run it on drafts you already reviewed), and the
Chinese-versus-English difference the report's "by language" line shows.

## Limitations

- Quality is **unverified**. No number about real Jev appears in the product or in this document; the table above is empty on purpose.
- Retention for a normal account is not documented (see above). Free tier, price and rate limits are not stated by StudyHub.
- The vendor describes Jev as unreliable at arithmetic, dates and counting, and as text-only with a 64k-token context (a 32k-token budget for the
  state plus the longest question); the client refuses to send more than 24,000 characters of state.
- The 出题预审 rewrite is one extra author-model call when a card is flagged. Whether it saves more review work than it costs is not measured.
- 出题预审 runs in the batched draft pipeline (`lib/batch.js`), not in passage supplementation (`generateDeck` called from the selection jobs) or case papers.
- The client retries 429/529/5xx and network failures twice with exponential backoff (0.5 s doubling to 5 s, jitter that only shortens, a 10 s ceiling on a
  server-supplied `Retry-After`), mirroring the vendor SDK's documented defaults; behaviour under sustained rate limiting has only been tested against a fake server.
- The wire format (request and answer shapes) was taken from docs.typesafe.ai and tested against a fake server written from it; `scripts/jev-live-check.mjs`
  is how to confirm it against the real service.
