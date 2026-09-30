# SM-2 Scheduling

## Scheduling versus verified learning

SM-2 chooses a card's next review time. Its interval is not a certificate of understanding, transfer, practical skill or whole-course coverage. The current native plugin derives an estimated mastery view from intervals and recent attempts; the [planned evidence policy](../docs/plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) separates that estimate from per-knowledge-point verification. Self-ratings, implicit prerequisite credits and retries retain their provenance and cannot silently become independent evidence.

The formula below remains the scheduling reference. The Markdown/JSONL file-write procedure and temporary-question description later in this file belong to the legacy library contract; native plugin writes use the transactional Store and persistent review runs. The planned v3 extension preserves existing schedules and logs, and adds evidence in the same store rather than changing this formula.

## Algorithm

The scheduling configuration uses `minimum_ease_factor`, `initial_ease_factor`,
`first_interval_days`, and `second_interval_days`. A grade is an integer from
0 through 5.

For every grade, calculate:

```text
ease_factor = max(
  minimum_ease_factor,
  previous_ease_factor + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)
)
```

Store `ease_factor` rounded to two decimal places to keep the same state across
clients with different floating-point display behavior.

Then calculate the interval:

```text
if grade < 3:
  repetitions = 0
  interval_days = 1
else:
  if previous_repetitions == 0: interval_days = first_interval_days
  if previous_repetitions == 1: interval_days = second_interval_days
  if previous_repetitions >= 2: interval_days = nearest_integer(previous_interval_days * ease_factor)
  repetitions = previous_repetitions + 1
due_at = attempt_timestamp + interval_days calendar days
```

Prepare one UTF-8 JSON object on one line for `reviews/attempts.jsonl` before
changing either file. It contains `timestamp`, `quiz_id`, `grade`, `elapsed_ms`,
`before`, and `after`. `nearest_integer` rounds a fractional `.5` upward. Keep
the exact original quiz and attempt-log contents in memory, then prepare and
validate complete replacement contents for both files. If either write or
validation fails, restore both original contents before reporting the failure.

Temporary questions are not durable quizzes. They have no SM-2 state and no
attempt-log record until the learner confirms saving them as quizzes.
