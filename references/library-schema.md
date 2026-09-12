# Study Library Schema

All files are UTF-8 Markdown with YAML frontmatter. A learner chooses the
library root explicitly; the plugin must never infer it from the plugin
repository or current working directory.

## Library Root

```text
<library-root>/
  study-lib.json
  config/scheduling.json
  nodes/<area-or-general>/<id>.md
  quizzes/<area-or-general>/<id>.md
  bites/<area-or-general>/<id>.md
  reviews/attempts.jsonl
  reviews/teaching.jsonl
  profile/overview.md
```

`reviews/attempts.jsonl` and `reviews/teaching.jsonl` are created empty.
`profile/overview.md` begins from the profile template and becomes a confirmed
session summary after attempts exist.

## Teaching Ledger

`reviews/teaching.jsonl` must be append-only. Each line is one UTF-8 JSON
object with an `event_type`; previous teaching events are never rewritten.

A teaching event has `event_type: "teaching"`, a unique lowercase-kebab `id`,
an ISO-8601 `timestamp`, `origin_quiz_id`, `source_node_ids`, and this required
content:

```json
{
  "event_type": "teaching",
  "diagnosis": {"type": "missing-model | misconception | procedure-gap", "core_gap": "..."},
  "mastered_rungs": ["..."],
  "transfer": {"rule": "...", "examples": ["..."]}
}
```

It must contain normalized conclusions, never a transcript, raw learner answer,
or reasoning trace. A consolidation lifecycle event has
`event_type: "consolidation"`, its own ID and timestamp, a
`teaching_event_id` that resolves to a teaching event, an `action` of `ready`,
`accepted`, or `declined`, and optional `supplemental_quiz_id`. Append a
consolidation lifecycle event rather than updating the teaching event.

## IDs And Links

`id` is lowercase kebab case and unique within its resource type. All
`prerequisites`, `related`, `linked_nodes`, and Bite `source.id` references
must resolve to existing resource IDs. A resource must not reference itself or
repeat a relation. `area` is optional. Reuse an established area when it fits;
explain a new area before creating it. `sources` contains citations, URLs, or
free-text source references and does not need to resolve to a library resource.

## Recruitment-Compatible Metadata

Recruitment mode uses the existing `tags` arrays; it does not add a parallel
mastery field or require a schema migration. Compatible tags include:

```text
role-sde-new-grad | role-agent-engineer | role-<target>
stage-resume | stage-oa | stage-technical-screen | stage-onsite
stage-project-deep-dive | stage-behavioral | stage-system-design
depth-how | depth-why | depth-where
format-recall | format-tradeoff | format-fault-diagnosis
format-project-defense | format-system-design
yield-high | yield-medium | yield-low
```

Tags describe relevance and intended coverage, not demonstrated mastery. When
the learner confirms a profile update, `profile/overview.md` may contain a
compact `Recruitment Focus` section with target role/gate, highest-yield weak
branch, depth ceiling, and next observable artifact. See
`references/recruitment-prep.md` for the behavioral contract.

## Node Metadata

```yaml
id: <lowercase-kebab-id>
title: <human title>
area: <optional area>
tags: []
prerequisites: []
related: []
sources: []
summary: <one-sentence recall summary>
```

## Quiz Metadata

```yaml
id: <lowercase-kebab-id>
title: <human title>
area: <optional area>
tags: []
linked_nodes: []
summary: <one-sentence quiz summary>
review:
  repetitions: 0
  interval_days: 0
  ease_factor: 2.5
  due_at: null
provenance:
  type: teaching
  teaching_event_id: <teaching event id>
  origin_quiz_id: <origin quiz id>
```

`provenance` is optional for ordinary quizzes but mandatory for a
teaching-derived quiz. Its `type` must be `teaching`, `teaching_event_id` must
identify the ledger event, and `origin_quiz_id` must identify the same durable
quiz as that event.

## Bite Metadata

```yaml
id: <lowercase-kebab-id>
title: <human title>
area: <optional area>
source:
  type: node
  id: <source-id>
tags: []
```
