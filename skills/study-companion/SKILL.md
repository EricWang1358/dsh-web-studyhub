---
name: study-companion
description: Build, compile, attach, or sync cross-discipline Interactive Companions (studyhub-lesson/1) — self-contained 16–20 slide HTML lessons across Mathematics, Philosophy, Engineering, Physics, Economics, and CS with offline W3C MathML, 1D/2D parametric and quiver sandboxes, counterexample matrices, closed-loop schematics, flaw-spotting, and spaced-repetition card sync (跨学科交互伴学生成、零密钥编译与挂载).
whenToUse: The learner asks to create, generate, compile, attach, or update an Interactive Companion lesson (interactive companion, HTML lesson, math sandbox lesson, phase-plane companion, 交互伴学, 伴学页, 生成伴学课, 挂载伴学包), wants a zero-API-key interactive lesson compiled directly from the main chat, or pastes a companion hand-off message.
---

# Interactive Companions: Cross-Discipline Stage & Compiler (`studyhub-lesson/1`)

Every StudyHub action below runs through `study_workspace` (`action` plus `payload_json`). Call `library.context {}` first to see courses, sources, and model readiness, and read `library.context {"area":"companions"}` once if you need exact parameter contracts.

**Language & grounding rule:** Match the learner's language throughout. When chatting in English, author `language: "en"` lessons and replies in idiomatic, vivid English with standard quotes (`"..."`, zero Chinese UI residue or `「…」`). When chatting in Chinese, author `language: "zh"` lessons in natural Simplified Chinese. Ground examples, notation, theorems, and counterexamples in the learner's StudyHub materials (`source.list` / `source.get`); when no course materials exist for a free-topic lesson, set `grounded: false` so StudyHub labels the projected source `ai-drafted-unverified` honestly.

## Choosing the Right Workflow

1. **Workflow A — Background 4-Stage API Build (`generation.companion.build`)** *(use when StudyHub has a configured generation model and the learner wants automated background generation)*:
   - **Estimate first (0 model calls):** Call `generation.companion.build {"course": "…", "topic": "…", "sourceIds": ["…"], "archetype": "auto", "language": "en", "estimate": true}` (`language: "zh"` in Chinese) and report the estimated model calls and token range (never state prices).
   - **Start on confirmation:** Call `generation.companion.build` without `estimate: true` (`archetype`: `"auto" | "sandbox" | "dialectic" | "mechanism" | "empirical"`, `mountMode`: `"auto" | "enrich-existing" | "full-pack" | "companion-only"`).
   - **Report & return control:** Share `jobId` (or use `job.wait {"jobId"}` once up to 60s when completing an authorized turn; check later with `job.status {"jobId"}`—never poll in a loop). Output writes to `<workspace>/companions/<course>/<slug>.html` and `.lesson.json` and registers on the course automatically.

2. **Workflow B — Zero-API-Key Main-Chat Authoring (`companion.compile`)** *(works with zero StudyHub provider API key configured, or whenever you author/refine a custom lesson directly in chat)*:
   - Read relevant course excerpts via `source.list` and `source.get` when grounding in library materials.
   - Author a complete `studyhub-lesson/1` JSON object (16–20 slides recommended for a full lesson; shorter focused lessons are also valid) and call `companion.compile` (registered in the `courses` context on `study_workspace`):
     `companion.compile {"lesson": { ... }, "course": "…", "attach": true, "grounded": true, "mountMode": "auto"}`
   - Optional `"outputPath": "companions/<course>/<slug>.html"` writes a linked `.html` (plus `.lesson.json`) inside authorized workspace/library folders; `"attach": false` compiles standalone HTML without mutating library state.
   - `companion.compile` runs deterministic math and schema pre-repair, validates all pedagogical invariants, compiles the zero-dependency offline `.html`, projects `src-companion-<id>` into **Sources**, and syncs spaced-repetition cards in a single call.

3. **Mounting & Re-Syncing Existing Packs (`companion.attach`, `companion.sync`)**:
   - Mount a local `.html` file or companion pack directory (`pages/*.html`, or unbuilt `lessons/*.json` referencing `projects/` / `src/` snippets) via `companion.attach {"path": "…", "course": "…", "mode": "linked", "mountMode": "auto"}`.
   - After editing a linked file on disk, refresh its SHA-256, projected source, and cards while preserving FSRS-6 review schedules via `companion.sync {"id": "…", "course": "…"}`.
   - Inspect existing lessons with `companion.list {"course": "…"}` and `companion.get {"id": "…", "course": "…"}`.

## `studyhub-lesson/1` Schema & 8-Beat Discovery Arc

Top-level JSON shape:
`{"schema": "studyhub-lesson/1", "id": "kebab-slug", "title": "Question-driven hook title", "lead": "1-sentence intuition vs boundary contrast", "course": "Course Name", "language": "en", "minutes": 25, "needs": ["Prerequisite 1"], "after": ["Concrete capability 1"], "terms": {"Term": "1-sentence definition earned in the lesson"}, "slides": [...]}`

Design full lessons around active discovery—concrete numbers and intuition **before** formal jargon:
1. **`open` & `hook` (Slides 1–3):** Concrete numerical surprise or physical/ethical puzzle (`text`/`callout`), 2–3 foundation warm-ups (`recall`), and an everyday intuition pump (`scene`) mapping tangible features to formal variables before symbols appear.
2. **`code` & `predict` (Slides 4–5):** Walk a naive proof, syllogism, force balance, or algorithm (`code` with `\n`-separated `source` and no manual line numbers), then pose a sharp edge-case commitment (`predict` with unique `id`, e.g. `"pred-1"`).
3. **`run`, `spot`, & `why` (Slides 6–9):** Manipulate the live model (`sandbox`, `matrix`, `schematic`, or `lanes`) paired with `{"t": "reveal", "of": "pred-1"}`; have the learner click the exact 1-based flawed step/premise (`spot`, `answerLines` strictly within `1..lineCount`); inspect structural anatomy (`inside`).
4. **`fix` & `choose` (Slides 10–12):** Test the repaired proof/control loop/framework on stage, compare trade-offs (`choose`), and pair `decide` + `cases` on a `"layout": "split"` slide (every `branches[].pick` must match an entry in `cases.tools`).
5. **`name`, `check`, `say`, & `take` (Slides 13–18):** Earn the formal textbook term (`name`) only after experiencing the mechanism, test transfer with two 4-option boundary `quiz` slides, prompt a 2-minute `say` oral synthesis, and close with 3 takeaway `cards` (plus an optional `try` / `workshop` hands-on drill).

Every block requires `"t"` and conversational mentor narration `"say"` (1–2 vivid sentences pointing directly at what changes on stage—never write filler like `"In this slide we will learn…"` or `"本页介绍…"`). Allowed `tone` values are strictly `"success"`, `"warning"`, or `"error"` (`callout`: `"info" | "pitfall" | "success"`; `lanes`: `"success" | "error" | "wait"`).

## Stage Toolkit & Guardrails

- **Offline W3C MathML (`$...$` / `$$...$$`):** Zero-network compiler supporting `\frac`, `\sqrt`, `\sum`, `\int_a^b`, `\oint`, `\lim`, `\begin{cases}`, `bmatrix` / `vmatrix`, `\overbrace` / `\underbrace`, `\|x\|`, `\langle u,v\rangle`, `\dot{x}`, `\ddot{x}`, `\operatorname{...}`, and formal/modal logic (`\vdash`, `\models`, `\Box`, `\Diamond`, `\forall`, `\exists`, `\implies`, `\iff`). Leave currency like `$100` literal with a space after digits.
- **`sandbox` (Math, ODEs, Mechanics, Control, Physics, Macroeconomics):**
  - `knobs`: `[{"id":"zeta","label":"Damping $\\zeta$","min":0.1,"max":2.0,"step":0.05,"default":0.25}]`, plus optional regime `presets`: `[{"label":"Underdamped","values":{"zeta":0.2}},{"label":"Critical ($\\zeta=1$)","values":{"zeta":1.0}}]` (`values` keys must match `knobs[].id` inside `[min, max]`).
  - **1D curves:** `domain: {"variable":"t","min":0,"max":12,"steps":90,"label":"Time $t$"}`, optional `threshold: {"value":0,"label":"Equilibrium"}`, and `series: [{"id":"resp","label":"$x(t)$","expr":"..."}]`.
  - **2D parametric & phase-plane quiver:** `series: [{"id":"orbit","label":"Trajectory","xExpr":"...","yExpr":"..."}]`, optional normalized quiver `field: {"xMin":-2,"xMax":2,"yMin":-2,"yMax":2,"grid":12,"xVar":"x","yVar":"y","dxExpr":"y","dyExpr":"-x - 2*zeta*y"}`, and live moving equilibrium `markers: [{"id":"eq","label":"Equilibrium","xExpr":"0","yExpr":"0"}]`.
  - **Finite AST math rule (zero `eval`):** Use only numbers, knob/domain/field variables, constants (`pi`, `e`, `tau`), operators (`+ - * / ^`), and supported pure functions (`sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, exp, ln, log10, log2, sqrt, cbrt, abs, floor, ceil, round, sign, min, max, pow, clamp, step, sinc, sigmoid, hypot, heaviside, lerp`). Guard denominators and even roots (`max(0.0001, ...)`) so every expression stays finite across the entire knob and domain grid.
- **`matrix` (Philosophy, Law, Ethics, Economics):** `frameworks` (`>= 2`), `scenarios` with `cells: [{"badge","tone":"success"|"warning"|"error","verdict","why"}]`, optional `predictBeforeReveal: true`, and `walk: [{"scenario","focus","say"}]`.
- **`schematic` (Engineering, Control Loops, Architecture):** `nodes` (`x` in `20..500`, `y` in `20..210`, optional clickable `detail`), `edges` (`from`, `to`, `label`; backward/closed-loop edges curve automatically via quadratic Bézier without crossing middle blocks), and `walk` (`nodes`, `edges`, `tone`, `states`, `say`).
- **`lanes`, `spot`, `quiz`, & `try` / `workshop`:**
  - `lanes`: Two-actor concurrency or Socratic Proponent/Objector timelines with optional inline `ask`.
  - `spot`: Multi-line `source` + 1-based `answerLines`, `hint`, and `found`.
  - `quiz`: 4 choices, 1 correct, with misconception-specific `why` on every option (`{"label":"...","correct":false,"why":"..."}`).
  - `try` / `workshop`: `{"t":"try","title":"...","prompt":"...","criteria":["..."],"hint":"...","solution":"...","say":"..."}` — renders checkable steps + persisted scratchpad in the stage and compiles into a `kind: "task"` StudyHub rubric card.

## Catch-Up Cards & Boundaries

- When a learner asks about a companion slide (`companion.ask` or chat inquiry with `companionId`), save approved anti-misconception flashcards via `companion.catchup.save {"companionId":"…","course":"…","slide":N,"slideTitle":"…","prompt":"…","answer":"…","misconception":"…","quote":"…"}` (and `companion.feedback.sync` only for linked packs) so the card files into **Companion Catch-ups** (`伴学拾遗`) with a live `#slide` jump-back link rather than unlinked `capture`.
- Never touch StudyHub internal storage (`.dsh-study/`, `study-workspace.json`) with file or shell tools.
- Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes. (永久删除或归档任何东西之前，先用一句话问学习者：什么会没有，什么会留下；得到明确的「好」再动手。) This applies before calling `companion.remove`.
