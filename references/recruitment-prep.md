# Recruitment Preparation Mode

Use this mode only when the learner names recruiting, interviews, an OA, a JD,
resume defense, project deep-dives, or a target role, or when loaded resources
already use `role-*`, `stage-*`, or `depth-*` tags. Do not silently turn a
general-purpose study library into a recruiting library.

## Role Card

Resolve the target role/level, track or stack, nearest recruiting gate, time
horizon, and first observable weak signal. Infer them from the user's JD,
resources, profile, and attempts. Ask one concise question only when the answer
would materially change selection. Never invent ownership, scale, metrics, or
production impact.

## Weighted Knowledge Map

Organize preparation as:

```text
role -> domain -> topic branch -> interviewable leaf node
```

Weight branches by interview yield for the target role and gate. For a general
new-grad SDE search, algorithms, project defense, and behavioral evidence tend
to outrank broad system design; for Agent/LLM roles, RAG, tool calling, memory,
evaluation, inference, and LLM-native design may be high-yield. Treat this as a
role-aware default, not a timeless market fact.

Use compatible tags:

```text
role-sde-new-grad | role-agent-engineer | role-<target>
stage-resume | stage-oa | stage-technical-screen | stage-onsite
stage-project-deep-dive | stage-behavioral | stage-system-design
depth-how | depth-why | depth-where
format-recall | format-tradeoff | format-fault-diagnosis
format-project-defense | format-system-design
yield-high | yield-medium | yield-low
```

Tags drive selection; they never store mastery.

## Source Quality And Anti-Hoarding

Do not count collected links, paid bundles, unread videos, or generated pages
as progress. Unfiltered material creates correction debt when it is outdated,
low quality, or half-correct.

Use authoritative or primary material as the factual baseline, the learner's
weak-area and attempt logs as the personalization layer, and AI as a curation
bridge that organizes cited evidence rather than replacing it. Start each
research task from one named weak leaf and end with an observable artifact. A
curated report may include an architecture diagram, source walkthrough, call
flow, application boundary, and high-yield failure analysis. Reject untargeted
resource dumps.

## Recruitment Node

A node must be one independently explainable leaf, not an entire domain or a
flat resource list. It must support three answer layers:

1. **HOW** — mechanism, invariant, data flow, or design shape.
2. **WHY** — design intent, alternatives, trade-offs, and boundaries.
3. **WHERE** — concrete application, changed constraint, failure diagnosis, or
   project decision.

Add these sections or subject-appropriate equivalents:

```markdown
## Interview Map And Yield
## Core Model
## Interview Depth
### HOW
### WHY
### WHERE
## Probe Chain
## Observable Output
```

The probe chain must contain at least one HOW, two WHY, and one WHERE/transfer
probe. The observable output must be something an interviewer could see: a
30-second explanation, trace, diagram, diagnostic checklist, project defense,
or measured artifact.

For resume/project nodes, expose action, mechanism, evidence, impact,
ownership, and measurement scope. Downgrade unsupported claims.

For a preparation-process story, use S→P→A→R: observed situation, diagnosed
problem or funnel ambiguity, specific action plus deliberately stopped
low-yield behavior, then verified result. Example application counts, rates,
prices, and time spans are placeholders until they resolve to the learner's
own tracker or evidence.

## Recruitment Quiz

Create a quiz for an uncovered depth target rather than restating a heading.
Across a topic set, HOW recall is the baseline; bias durable coverage toward
WHY, WHERE, transfer, diagnosis, and defense.

Prefer prompts that ask the learner to:

- explain a mechanism or invariant
- compare plausible designs and defend a trade-off
- diagnose a failure and name the next discriminating check
- defend a project choice, ownership boundary, or measurement
- explain preparation or funnel improvement with evidence using S→P→A→R
- layer a small design and identify its first bottleneck
- transfer the concept under a changed constraint

Every durable recruitment quiz must add:

```markdown
## Scoring Rubric
Required points, partial-credit boundary, and disqualifying misconception.

## Follow-up Ladder
HOW, WHY/trade-off, and WHERE/transfer probes.

## Interview Signal
What the answer demonstrates beyond memorization.

## Debrief Action
The precise repair action after a miss.
```

Keep one primary gradable target. During sparring, ask ladder probes one at a
time and do not reveal later probes early.

For multiple-choice or multi-select, make distractors plausible, similar in
length and abstraction, and tied to real misconceptions. Avoid joke choices,
grammar cues, fixed answer positions, and a fixed number of correct options.
Shuffle option order at delivery time and audit answer-position balance across
a batch so the learner cannot infer a stable A/B/C/D pattern.

## Recruitment Sparring

Within due material, prioritize:

1. target role and nearest gate match
2. high-yield weak branch
3. weakest depth layer
4. overdue/SM-2 urgency

Retain SM-2 scheduling, but do not spend a short recruiting session rehearsing
a low-yield topic while the current gate is failing elsewhere.

Use the first three questions to sample HOW, WHY, and WHERE rather than only
difficulty. Diagnose the answer as one of:

- `map-gap`
- `how-gap`
- `why-gap`
- `where-gap`
- `diagnostic-gap`
- `evidence-gap`
- `delivery-gap`

Use core correctness for the durable SM-2 grade. Report interview delivery as
a separate axis. A polished wrong answer does not pass; correct but awkward
reasoning remains knowledge-correct and creates a delivery action.

After a miss, repair one rung and then change the constraint or scenario.
Number substitution tests procedure; changed-context transfer tests interview
readiness. Mark a node interview-ready only after at least one WHY and one
WHERE/transfer probe succeed.

Use a coach loop: require a committed answer, judge it before reveal, teach the
missing rung, name one action card, then run a second rep under a changed
constraint. Treat that second rep as transfer evidence rather than optional
extra practice.

## Session Close

Report the target role/gate, strongest and weakest map branches, current depth
ceiling, one observable next artifact or mock action, due items, and next
review. Save normalized conclusions, never a transcript or raw reasoning.

When the learner confirms a profile update, add or refresh a compact section:

```markdown
## Recruitment Focus
- Target role / gate:
- High-yield weak branch:
- Depth ceiling: HOW | WHY | WHERE
- Next observable artifact:
```
