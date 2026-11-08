# Architecture Explorer Fact Audit · StudyHub 4.5.1

Every architectural figure, identifier, boundary rule, pipeline budget, scheduler parameter, mastery threshold, and offline test metric presented on `site/explorer.html` and `explorer-en.html` was verified directly against the local `v4.5.1` codebase. No currency prices, throughput promises, or live network calls are included.

## 1. Release, Runtime & Design Tokens

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| Package version `4.5.1`, Node.js `>=22.19` | `package.json:3`, `package.json:131` |
| Ink-desk dark tokens (`#161412`, `#110f0d`, `#1e1b18`, `#26231f`, `#292623`, `#332f2a`, `#4a443c`, `#efe9df`, `#c5bdb1`, `#a59d91`, `#958e84`, `#c93d22`, `#ec6a4a`, `#5fb58a`, `#d9a441`, `#d76c93`, `#86a9c6`, `#ece4d6`) | `ui/tokens.css:16-50` |
| Ink-desk light tokens (`#f1ede6`, `#e8e3da`, `#faf8f4`, `#ffffff`, `#e9e4db`, `#ddd5c9`, `#c5bbad`, `#1e1a15`, `#453e35`, `#635b51`, `#6a635a`, `#c03a1f`, `#d44f2e`, `#ad4025`, `#1e724d`, `#8b590f`, `#ad3966`, `#376893`, `#fffdf8`) | `ui/tokens.css:123-152` |
| Shared runtime scope key `Symbol.for("studyhub.runtime.scope.v1")` | `docs/architecture.md:79`, `lib/plugins/composition.js` |

## 2. Open & Composable Main-Chat Collaboration

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| `6` modular agent skills (`study-tutor`, `study-guide`, `study-import`, `study-book`, `study-custom`, and goal-driven self-study setup `study-self`) shipped in `"files"` and registered via `ctx.skills.register` | `skills/*/SKILL.md`, `skills/study-self/SKILL.md:1-10`, `lib/study-skills.js:8-38`, `lib/index.js:5,495`, `package.json:46` |
| `19` on-demand `library.context` contract areas interpolated from live enforcement constants | `lib/study-contracts.js:17-37` |
| Dynamic backtick `:data` and `:request` fences (`max backtick run + 1`, minimum 3) | `ui/agent-prompts/message.js:24-41`, `ui/agent-prompts/situation.js:38-47` |
| Static system persona (`{{model}}` / `{{provider}}` only) for prompt-cache stability | `presets/study.patch.yml:38-96` |
| Editable per-course study methods (`course.method`): `1–12` stages (`STAGES_MAX = 12`), `6` activities (`publish`, `practice`, `review`, `explain`, `check`, `project`), up to `2` alternatives (`ALTERNATIVES_MAX = 2`), `3` gate levels (`loose`, `medium` `2/3` pass & `0.8` advance, `strict` `1.0`), `3`-stage default `CLASSROOM_METHOD` (`课堂跟学`) | `lib/course-method.js:6-45` |

## 3. Section 1 (`#overview`) — Plugins, Tools, Contexts, Store & Lazy UI

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| `1` workbench plugin (`daily-flashcard`) | `package.json:28,38`, `lib/index.js`, `lib/plugins/workbench.js` |
| `6` capability plugins (`studyhub-runtime`, `studyhub-materials`, `studyhub-bank`, `studyhub-study`, `studyhub-generation`, `studyhub-audio`) | `package.json:32-37`, `lib/plugins/runtime.js`, `lib/plugins/materials.js`, `lib/plugins/bank.js`, `lib/plugins/study.js`, `lib/plugins/generation.js`, `lib/plugins/audio.js` |
| `1` companion retrieval package (`packages/studyhub-retrieval`), `3` providers (`mcp:<tool>`, `service`, `builtin`), narrows selections above `150,000` chars (`RETRIEVE_ABOVE_CHARS`) | `packages/studyhub-retrieval/package.json`, `lib/retrieval.js`, `docs/architecture.md:298-314` |
| `7` DSH agent tools: `study_capabilities`, `study_materials` (17 ops), `study_bank` (4 ops), `study_practice` (10 ops), `study_generate_selection` (4 ops), `study_audio` (13 ops), `study_workspace` | `lib/runtime/tools.js:8-104`, `lib/index.js` |
| `study_capabilities` compact zero-arg index avoids ~`106,000` characters of full tool schemas and omits default fields | `lib/runtime/tools.js:56-104` |
| `19` `StudyRuntime` contexts: `16` operation contexts (`system`, `notifications`, `materials`, `bank`, `courses`, `study`, `authoring`, `generation`, `audio`, `notes`, `recording`, `coach`, `workflows`, `skeleton`, `jobs`, `library`) + `3` data-only `state.read` contexts (`learner`, `workflow-data`, `skeleton-data`) | `lib/runtime/domain-contracts.js:2-43`, `lib/runtime/builtins.js:101-102` |
| Context boundary enforcement: ESLint `no-restricted-imports` blocks raw store/global bypasses; architecture boundary tests enforce cross-context private-import isolation (`esbuild` metafile, allowing foreign `/contracts.js` only) and acyclic `runtime.describe()` API dependency graph via DFS | `eslint.config.js:38-58`, `tests/architecture-boundaries.test.mjs:23-60` |
| Sharded store `LATEST_VERSION = 5` (`study-sharded`), `ATTEMPT_CHUNK = 1000` attempts/shard, 20-hex SHA-1 shard filenames, deep-frozen parsed shard cache | `lib/store.js:46-59,205-215,264-280`, `lib/runtime/builtins.js:106-107` |
| `job-archive.json` bounded to `200` records / `90` days | `lib/job-archive.js`, `docs/architecture.md:350`, `docs/case-study/facts.snapshot.json:96-99` |
| `8` optional feature surfaces (`BlogNotes`, `Skeleton`, `Workflows`, `Graph`, `TaskConsole`, `AudioDashboard`, `DocumentViewer`, `LiveClass`) + `7` occasional pages (`GuidedStudy`, `Dashboard`, `Exam`, `ExamPrep`, `CourseOutline`, `BookPage`, `Board`) = `15` `deferredView()` chunks (plus lazy `PagePeek`) | `ui/workspace-views.jsx:8-22`, `docs/architecture.md:452`, `docs/case-study/facts.snapshot.json:54` |

## 4. Section 2 (`#pipeline`) — 5-Stage Reliable Generation Pipeline

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| Selection chunking `<= 60,000` chars (`CHUNK_CHARS`), `<= 10` targets/group (`MAX_PLAN_TARGETS`), authoring parts of `<= 5` cards, `concurrency = 4` | `lib/batch.js:23-31`, `lib/limits.js`, `docs/case-study/facts.snapshot.json:57-71` |
| Stage 1 (`Plan`): `planAssessment` (`targets[{ targetId: "target-1", objective, knowledge, section?, focus?, citations[...] }]`) + `groundedPlan`, verbatim quote `>= 12` chars, NFKC alphanumeric matching, automatic cross-page `sourceId` reattribution, `1` corrective retry + target-level salvage | `lib/assessment-quality.js:275-309,352-409`, `lib/quote-match.js` |
| Stage 2 (`Blueprint`): `blueprintAssessment`, locks `answer`, `reasoning`, `comparisonAxis`, `scenario` (`none \| constructed \| source`), options/rubric/cloze, `checkCalculation` (`10^-12..10^12`, `mm/cm/m/km`, `g/kg`, `s/min/h`, `%`), `1` retry + item salvage | `lib/assessment-quality.js:509-566`, `lib/calculation-check.js` |
| Stage 3 (`Author + Bind`): `authorPrompts`, string-aware balanced-brace `salvageAuthoredCards` (`1` JSON retry only if `0` cards recovered), `bindSupportedAnswers` overwrites `objective`, `citations`, `answer`, `options`, `rubric`, `cloze` by `targetId`, `autofixDeck` (`0` model calls) | `lib/generation.js:114-149,314-467`, `lib/card-autofix.js` |
| Stage 4 (`Local + Independent Review`): `cardLocalIssues` (`learnerContextIssues`, `answerLeakIssues`, `formulaIssues`, `clozeIssues`, `optionCueIssues`) + `1` independent editor call returning `REVIEW_SHAPE` (`{ issues, suggestions, summary, checks[{ cardId, ... }] }`) across `6` dimensions (`selfContained`, `answerLeak`, `optionQuality`, `learningValue`, `sourceSupport`, `explanationQuality`), `fail` vs `suggest`, `REVIEW_REASKS = 2` appended for cache reuse | `lib/assessment-quality.js:25-117,229-242`, `lib/generation.js:276-298` |
| Stage 5 (`Bounded Patch + Fill`): `1` batched `patchPrompts` call + `1` subset review over wording-only `PATCH_FIELDS` with bound answers/citations frozen; shortfall capped at `fillRounds = 2` (configurable `0..4`, `reserve <= 3`) with `priorRoundBrief` | `lib/generation-yield.js:13-135`, `lib/generation.js:535-786`, `docs/generation-reliability.md` |

## 5. Section 3 (`#fsrs`) — Live FSRS-6 & Mastery Simulator

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| `21` FSRS-6 default weights `FSRS6_WEIGHTS` (`w0..w20`), decay `w20 = 0.1542`, `enable_short_term = false`, `enable_fuzz = false`, local calendar `dayDiff` | `lib/sm2.js:34-42,77-84,137-189` |
| `request_retention` default `0.90`, allowed range `0.70–0.97`, `maximum_interval = 36500` days | `lib/sm2.js:46-54` |
| Focus card boost `FOCUS_RETENTION_BOOST = 0.04` (`0.90 -> 0.94`, capped at `0.97`) | `lib/sm2.js:57-65` |
| Grade mapping `0–2 -> 1 (Again)`, `3 -> 2 (Hard)`, `4 -> 3 (Good)`, `5 -> 4 (Easy)` | `lib/sm2.js:88` |
| Mastery levels `new`, `weak` (`lastGrade < 3`), `learning` (`< 6d`), `familiar` (`FAMILIAR_DAYS = 6`), `mastered` (`MASTERED_DAYS = 21` & `MASTERED_STREAK = 2`, or immediate self-grade `5`) | `lib/mastery.js:2,32-50` |

## 6. Section 4 (`#testing`) — Deterministic Offline Test & Sharding Explorer

| Explorer claim / figure | Exact codebase source (`v4.5.1`) |
| --- | --- |
| `1,308` `tests/*.test.mjs` files (`1,112` fast-tier + `196` unique slow-listed files across `browser: 119`, `ffmpeg: 3`, `cli: 80`), dynamically counted at build time | `site/explorer-content.mjs:17-50`, `tests/slow-tests.json`, `tests/slow-tests-list.test.mjs` |
| Temp `DSH_HOME`, `scrubSecrets`, `STUDY_NO_CALIBRATION=1`, concurrency `max(2, min(availableParallelism - 1, 12))` | `scripts/test.mjs:20,43-58`, `scripts/qa/test-schedule.mjs:38-41` |
| Per-test timeout `300,000 ms` (`300s`) and per-file timeout `480,000 ms` (`480s`) | `scripts/qa/run-tests.mjs:35-36` |
| Loopback-only network blocker preloaded via `--import` (`TEST_NETWORK_BLOCKED`) | `scripts/qa/test-network.mjs`, `scripts/test.mjs:45,60` |
| Deterministic LPT greedy sharding (`shardKeys`, `--shard=I/N` up to `64` shards) over committed `tests/test-weights.json` | `scripts/qa/test-schedule.mjs:44-67`, `tests/test-weights.json` |
| Offline deterministic LLM (`preview/fake-model`) with `42` prompt-family handlers (`FAKE_MODEL_HANDLERS`) and simulated prompt-cache token reporting | `scripts/fake-model.mjs:811-835` |
