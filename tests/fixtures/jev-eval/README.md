# Evaluating the experimental Jev layer

`scripts/eval-jev.mjs` measures whether Jev's answers are right, and how sure it claims to be when it is right or wrong. It runs the same
requests StudyHub would send for the four experiments, scores them against labels you provide, and prints accuracy, precision and recall,
F1, calibration (ECE) and the tokens used. It needs your own Jev key and sends the dataset's text to Jev (TypeSafe's cloud).

`dataset.json` here is a small public example (neutral textbook-style content, written for this repository, no learner data). It is far too
small to prove anything: it exists so the script and its metrics can be exercised, and as a template for your own data.

## Run it

```
# the public example (no confirmation needed: nothing of yours is in it)
JEV_API_KEY=<your key> node scripts/eval-jev.mjs tests/fixtures/jev-eval/dataset.json

# one experiment, a different confidence line, and a JSON report
JEV_API_KEY=<your key> node scripts/eval-jev.mjs my-dataset.json --features courseSuggest --threshold 0.9 --out report.json --yes
```

`--provider typesafe|opencode-zen-free|opencode-zen|custom` picks the service (default `typesafe`): the key is read from the environment variable the preset
names (`JEV_API_KEY`, `OPENCODE_GO_API_KEY_2`, `JEV_CUSTOM_API_KEY`; `--key-env NAME` names another one), never from a file; the custom preset also needs
`--endpoint <https address>` and `--model <id>`.

Without that variable it does nothing and says so. Any dataset other than this folder's needs `--yes`, because its text is sent to Jev.
`JEV_BASE_URL` points it at another address (a fake server, for testing the script itself).

## Dataset format

```json
{ "version": 1, "features": {
  "courseSuggest": { "courses": [{ "name": "Databases", "titles": ["an example title already filed here"] }],
                     "items": [{ "id": "a", "lang": "en", "title": "...", "text": "...", "course": "Databases" }] },
  "preReview":     { "items": [{ "id": "b", "card": { "kind": "flashcard", "prompt": "...", "answer": "...", "citations": [{ "sourceId": "s", "quote": "..." }] },
                                 "labels": { "stemLeaksAnswer": false, "needsSource": false, "answerInEvidence": true } }] },
  "outlineNoise":  { "items": [{ "id": "c", "level": 1, "title": "Page 12 of 140", "label": "running" }] },
  "levelCheck":    { "items": [{ "id": "d", "card": { "kind": "flashcard", "prompt": "...", "answer": "..." }, "level": "recall" }] } } }
```

- `courseSuggest`: `course` is one of the listed courses, or `null` when the source belongs to none of them. `lang` is optional; when present the
  report breaks the accuracy down by language.
- `preReview`: each label is the CORRECT yes/no answer to the question Jev is asked. `stemLeaksAnswer`: yes = the wording gives the answer away.
  `needsSource`: yes = it depends on material that is not shown. `answerInEvidence`: yes = the quoted evidence supports the answer.
  `oneDefensible` (quiz cards only): yes = exactly one option is defensible. A check with no label is skipped for that item.
- `outlineNoise`: the headings of one document in order; `label` is `chapter`, `label` (a small tag such as "English original"), `running`
  (a running header or footer) or `other`.
- `levelCheck`: `level` is `recall`, `concept` or `apply`. The report also scores the code's keyword heuristic on the same questions.

## Your own library, from a COPY

1. Copy your library folder somewhere else (never point the script at the live one) and do not copy your keys.
2. `node scripts/eval-jev.mjs --skeleton <the copy> --out my-dataset.json` writes a starting point, with no network and no key: your sources with
   their current course (these may be wrong, check them), and your questions with blank labels.
3. Open `my-dataset.json`, fill in every blank label (a `null` or `""`) or delete the item, and delete the experiments you do not want to measure.
   About 50 labelled items per experiment is a sensible start; fewer says very little.
4. Run the evaluation with `--yes`.

## Reading the numbers

- **accuracy / precision / recall / F1**: for the multi-class experiments a top answer is right when it equals your label. For `preReview` the
  positive class is "the defect is present"; precision and recall are measured at the confidence line (default 80%), which is what the product uses
  to decide that a card is flagged, and accuracy at 0.5.
- **ECE** (expected calibration error): items are grouped by how sure Jev claimed to be; ECE is the average gap between that confidence and the
  share it got right. 0 is perfectly calibrated; 0.1 means that "90% sure" is about 80% right. A high-accuracy, badly calibrated model still
  makes the 80% line meaningless, so look at both.
- **tokens**: as reported by the service (`usage`), per experiment and per item. Prices are not computed.
- A request that fails (network, rate limit) is reported as failed and left out of the scores; it is never counted as a wrong answer.

## Replaceable sites: Jev against the current model path

Two more sections measure the model calls a learner can choose to have Jev answer instead (`cardReview`, `courseOrganize`; `lib/jev-sites.js`). Each item
carries the labelled truth and, optionally, `model`: what the CURRENT model path answered for that item (record it from a run you already did, for example
the verdicts of the independent review you saw, or the course the "请 AI 建议" proposed).

```json
"cardReview":     { "items": [{ "id": "r1", "verdict": "accept", "model": "accept",
                                "card": { "kind": "flashcard", "prompt": "...", "answer": "...", "explanation": "...", "citations": [{ "sourceId": "s", "quote": "..." }] } }] },
"courseOrganize": { "courses": [{ "name": "Databases", "titles": ["..."] }],
                    "items": [{ "id": "o1", "title": "...", "text": "...", "course": "Databases", "model": "Databases" }] }
```

- `cardReview`: `verdict` is what a careful review should conclude (`accept` or `reject`); `model` is what the model review concluded. Cards the six yes/no checks
  do not fit (multi-answer cards, no evidence, no explanation) are counted as "not judgeable" and never sent.
- `courseOrganize`: `course` is the right course (or `null` for none); `model` is a course name, `null`, or a name the model proposed.

The report says, per site, how much Jev settles at your confidence line, its accuracy when it settles, what the hybrid the product really runs (Jev where it is
sure, the model for the rest) scores against the model alone, the agreement on what Jev settled, and Jev's latency per call and tokens. Without `model` answers
only Jev against the truth is reported. A small dataset proves little; these numbers describe your data only.
