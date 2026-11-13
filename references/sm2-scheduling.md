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

`retrievability(review, at, settings)` in `lib/sm2.js` gives this `R` for a stored review at an instant, with `t` counted as an answer at that instant would count it (whole local days); `retrievabilityAt(settings)` builds the model once for a pass over many reviews. A review with no memory state (a new card, or a record with neither an FSRS state nor an SM-2 interval) and an FSRS review without `last_review` give 0, as ts-fsrs says of a new card. A migrated SM-2 review is read as the scheduler reads it (below). It matches ts-fsrs's `get_retrievability` (`tests/fsrs-parity.test.mjs`), except that ts-fsrs counts whole 24-hour periods.

## Which due question comes first

A round of 今日学习 takes the due questions before the weak and the new ones (`planPath` in `lib/mastery.js`). Among the due questions the 重点 ones come first; inside each of those two groups the question with the lowest predicted recall at that moment comes first (`retrievability` in `lib/sm2.js`: `R(t)` above, `t` being the whole local days since the last review, as an answer at that moment would count them), then the one due earlier, then library order. So a question with a 3-day gap that is 3 days overdue (R about 0.85) comes before one with a 60-day gap that is 5 days overdue (R about 0.89), which the due date alone put first. A due record the scheduler cannot read a memory state from, and an FSRS record whose last review is unknown (no `last_review`, as a review written from outside can be), count as R = 0, as ts-fsrs says of a new card, and come first in their group: with no elapsed time the curve would say 1 and such a record would wait behind every other due question. The order uses the default weights: every FSRS-6 curve falls with `t / S` alone, so a learner's own weights would order the same questions the same way. For one moment the home card's count and the round 开始今日学习 starts hold the same questions in the same order (`tests/daily-path.test.mjs`), and recall moves only when the local day changes: the order can change then, and the home card is recomputed then too (a poll on another calendar day gets the whole snapshot, `lib/snapshot-time.js`), so for one moment the two still agree. A started round keeps its order.

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
- `exam_alignment`: `false` switches exam alignment (below) off; absent or `true`, it is on.

The SM-2 keys `minimum_ease_factor`, `initial_ease_factor`, `first_interval_days` and `second_interval_days` are ignored when a library is read and dropped on the next save.

## The stored review

A review keeps the fields older code reads (`repetitions`, `interval_days`, `ease_factor`, `due_at`) and adds `algorithm: "fsrs-6"`, `stability`, `difficulty`, `reps`, `lapses`, `elapsed_days` and `last_review`. `ease_factor` is derived from difficulty only so that an older build reading the library after a downgrade can keep scheduling.

## Exam alignment

One function derives the settings a question is scheduled with (`lib/card-schedule.js` `cardScheduleSettings`): the library settings, the raised target recall of a focus question, and the exam date of the question's course (`exam.date` on the course record; a chapter course without its own date takes its parent course's). Every path that schedules a question uses it: a practice answer and the answer buttons' gaps, the mock exam, prerequisite credit, rubric grading, the oral mock and the sample library.

When the course has an exam on a later local day than the answer and the gap FSRS gives reaches the exam day, the review is due from local 00:00 of the exam day (computed from the calendar date, so a daylight-saving change in between moves nothing), so the practice queue serves it before a daytime exam. An answer on the exam day itself, or after it, is scheduled as usual: there is no earlier day left. Nothing about the memory state changes:

- `interval_days` stays the gap FSRS gave, so the mastery lines (`lib/mastery.js`) read the level the answer earned, the same with alignment on or off;
- `due_at` is when the question really comes back;
- `unaligned_due_at` keeps the due date FSRS gave; it is on the review only while the exam has moved `due_at` to an earlier day (a gap that ends exactly on the exam day only moves to 00:00 and writes none), and the next answer writes a review without it unless the exam moves that one too.

The exam is never written as `maximum_interval`, which keeps meaning only the learner's own maximum. A library or a review without these fields reads as before.

Questions already due after the exam do not come back by themselves, so a pass over the library (`lib/exam-alignment.js` `alignDueDates`) gives each a due date before it. It runs when a course write changes the exam a deck sits (`course.save` with a new, changed or cleared date, `course.merge`, `course.rename`), bringing forward only those decks' questions and returning `alignment: { pulled, restored }`; and when the learner switches it or presses 现在对齐 (`course.examAlignment.set`, the only write of `exam_alignment`, every course; the `settings` write refuses it). A library whose exam date was set before this existed is therefore on but not aligned until 现在对齐: Settings and the course's exam date say how many questions wait (`course.examAlignment.preview` `pending`). The questions are spread over the days left, from today to the day before the exam, the lowest recall now (`retrievabilityAt`) first, each due from the start of its day. A question is never brought to a day before the day after its last answer (`memoryState(review).lastReview`: the FSRS `last_review`, or for an SM-2 review `unaligned_due_at ?? due_at − interval_days`; unknown, it may take today), so one answered a moment ago is not due again today; each day takes, lowest recall first, the questions that may take it up to the even share of those still waiting over the days left (`ceil(waiting / days left)`), so a pile answered today spreads over tomorrow up to the day before the exam instead of landing on tomorrow. A question answered the day before the exam is due from 00:00 on the exam day, the same date the scheduler gives an answer given then. `examAlignmentPreview` simulates this very pass on a copy. Only `due_at` moves and the old one is kept in `unaligned_due_at`. Only answered questions are moved (a never-answered one is new, as the due forecast counts it), and not a suspended one, one in an archived deck or one in a parked course (parking never touches a schedule). The pass is idempotent: a question already due before its exam keeps its date; on the exam day nothing moves; a moved question whose exam was removed, switched off, is no longer its deck's, moved to on or after its own due date, or is over (the day after the exam) gets `unaligned_due_at` back as `due_at`. Nothing runs when the exam day passes: after the exam day new answers are scheduled as usual; questions that were brought forward and not answered stay due until they are answered or their dates are restored in Settings (`course.examAlignment.restore`, the same pass without bringing anything forward; any other pass restores them too). Moving a deck to another course (`deck.course`, `deck.move`, `deck.merge`, `deck.split`) does not run the pass. An SM-2 review moved this way still reads its last review from `unaligned_due_at − interval_days`.

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
