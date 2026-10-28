# Review scheduling (FSRS-6)

This file keeps its old name because other pages link to it. Up to 3.7 StudyHub scheduled reviews with SM-2; since then the scheduler is FSRS-6. The code is `lib/sm2.js` (the name is kept for the same reason), ported from BAXUIE's StudyHub for ZCode 0.4.8.

## Scheduling versus verified learning

The scheduler chooses a card's next review time. Its interval is not a certificate of understanding, transfer, practical skill or whole-course coverage. The native plugin derives an estimated mastery view from intervals and recent attempts (`lib/mastery.js`: under 6 days 学习中, 6 days or more 熟悉, 21 days or more with at least two right answers in a row 已掌握; when a review was scheduled under a maximum interval below 6 or 21 days, that line comes down to the maximum, so the levels mean the same whatever the settings; a self-graded 5 shows 已掌握 at once, as it always did); the [planned evidence policy](../docs/plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) separates that estimate from per-knowledge-point verification. Self-ratings, implicit prerequisite credits and retries retain their provenance and cannot silently become independent evidence.

## What FSRS-6 predicts

FSRS keeps two numbers per card:

- **stability**: the number of days after which the chance of still recalling the card falls to 90%;
- **difficulty**: 1 (easy) to 10 (hard).

After each answer it updates both from the rating and from the days that really passed since the last review: whole calendar days in the local time zone of the machine StudyHub runs on, so "the same day" is the learner's day (ts-fsrs counts UTC days; in Beijing that would split 07:50 and 08:10 into two days). The chance of recall after `t` days is `R(t) = (1 + FACTOR · t / S)^(−DECAY)`, with `DECAY = w20` (0.1542 by default) and `FACTOR = 0.9^(−1/DECAY) − 1`, so that `R(S) = 0.9`. The next review is placed where that chance falls to the learner's target recall (`request_retention`, default 0.9). So:

- a card answered on time and right gets a much longer interval;
- a card answered before it is due gets a smaller increase, and one answered again on the same day keeps its interval;
- a wrong answer on a learned card lowers its stability and shortens the interval, though not always to 1 day.

The formulas, the 21 default weights, the clamps and the ordering of the four candidate intervals (Again ≤ Hard < Good < Easy) follow [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) 5.4.2 in its long-term mode without fuzz: there are no minute-level learning steps, because StudyHub stores whole days. `tests/fsrs-parity.test.mjs` replays thousands of random histories through both and requires identical stability, difficulty and intervals. Two intended differences: days are counted on the local calendar, not UTC's (the parity test feeds ts-fsrs the same instants shifted by the local UTC offset, under three time zones), and the maximum interval is a hard cap here, where ts-fsrs may push Good and Easy a day or two past it. A review scheduled under a maximum below the default keeps that maximum (`maximum_interval`) for the mastery lines.

The weights are the published defaults; StudyHub does not optimise them per learner. Benchmarks of FSRS were run on long-time Anki users, so for a learner with a handful of answers per card the predictions are an estimate.

## Grades and ratings

Stored grades stay 0–5. The scheduler maps them to the four FSRS ratings:

| Grade | Meaning | FSRS rating |
|---|---|---|
| 0–2 | 完全忘记 / 记得一点 / 有印象 | Again |
| 3 | 勉强答对 | Hard |
| 4 | 熟练 (also an auto-graded right answer) | Good |
| 5 | 轻松掌握 | Easy |

A grade of 3 or more is still a pass: `repetitions` (the passing streak) goes up by one, and a lower grade sets it to 0.

## Settings

The library settings hold two optional numbers (设置 › 导入、计划与备份 › 间隔复习):

- `request_retention`: target recall, 0.7–0.97, default 0.9;
- `maximum_interval`: the most days between two reviews, 1–36500, default 36500.

The SM-2 keys `minimum_ease_factor`, `initial_ease_factor`, `first_interval_days` and `second_interval_days` are ignored when a library is read and dropped on the next save.

## The stored review

A review keeps the fields older code reads (`repetitions`, `interval_days`, `ease_factor`, `due_at`) and adds `algorithm: "fsrs-6"`, `stability`, `difficulty`, `reps`, `lapses`, `elapsed_days` and `last_review`. `ease_factor` is derived from difficulty only so that an older build reading the library after a downgrade can keep scheduling.

## Moving from SM-2

Nothing is rewritten when the plugin updates, and no due date moves. A card's SM-2 state is converted at its next answer:

- stability = the SM-2 interval in days;
- difficulty = `10 − (ease − 1.3) · 9 / 2.2`, clamped to 1–10 (ease 2.5 → about 5.1, ease 1.3 → 10);
- last review = `due_at − interval_days` (with no usable `due_at`, as a legacy import can have, the card is taken as due now: last review = now − interval; its streak is kept).

Until then the card reads as before: same due date, same mastery level.

## Legacy library files

The Markdown/JSONL procedure below belongs to the legacy library contract; native plugin writes use the transactional Store and persistent review runs.

Prepare one UTF-8 JSON object on one line for `reviews/attempts.jsonl` before
changing either file. It contains `timestamp`, `quiz_id`, `grade`, `elapsed_ms`,
`before`, and `after`. Keep the exact original quiz and attempt-log contents in
memory, then prepare and validate complete replacement contents for both files.
If either write or validation fails, restore both original contents before
reporting the failure.

Temporary questions are not durable quizzes. They have no review state and no
attempt-log record until the learner confirms saving them as quizzes.
