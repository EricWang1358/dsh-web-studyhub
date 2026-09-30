# Verification — 2026-09-12 (updated 2026-09-13 for 0.3.0/0.4.0)

## 2026-09-30 — authorized supplementation (not yet released)

- Added `supplement`: reviewed generation and publication into one exact active deck, with plugin-owned phase results and a final persisted added/total receipt. Ordinary `generate` still creates a draft.
- Full suite passed 643 tests, no failures/skips, with test concurrency 4; lint and native/standalone builds passed. The earlier default-concurrency run hit an existing audio recovery fixture time limit; the focused audio recovery rerun passed without changing its timeout or assertions.
- After that run, the completed job's stale checkpoint pointer was removed, partial publication was checked against its new remaining checkpoint ID, and task labels were verified. All 14 final main-context/job-visibility tests passed; lint/build passed again. The final added partial-publication case was not included in the 643-test run.
- Regression coverage includes exact target validation before model work, no leftover draft after full success, unchanged original cards/history, archival during generation, duplicates, cancellation, failed independent review, and partial publication receipts. Review/simplification was limited to the fix's files; unrelated untracked files remain untouched.
- Only isolated fixture libraries and fake model responses were used. No learner library was changed, no model API requests were sent, and the already published/installed 1.4.1 artifact was not replaced. Activation requires a later package update.

## 2026-09-30 — 1.4.1 audio usage and resource management

- `npm run verify`: lint, 636 tests (0 failures, 0 skips), and native client/standalone build passed. `npm run build:demo` passed separately.
- The packed 1.4.1 artifact passed 31 tests against its extracted runtime: real Cordis injection, publication semantics, provider usage accounting, reasoning fallback, privacy, and bounded streaming aggregation. A 10,000-request ledger plus oversized and incomplete records was checked without retaining individual requests.
- Browser checks covered 1440 px and 320 px layouts, no horizontal overflow, independent reasoning grid/select synchronization, settings persistence after reload, empty quota state, and both light and dark themes. Visual fixture data was synthetic; the interactive demo exposes no account usage or keys.
- Desktop installation reports 1.4.1. Installed client, dashboard, entry point, and service hashes match the release artifact. Reloading the desktop host remains necessary to activate it; no active host tasks were interrupted.
- Usage refresh pauses while hidden and removes its timer/listener on unmount. Ledger retention is 31 days, request-body copying is avoided, and failed recoverable audio tasks retain their manifest while releasing model/service closures.
- No paid API requests, real audio transcription, microphone session, or learner-library mutations were performed for this release. Gemini quota is a local estimate against a user-entered model limit; Groq remaining quota is displayed only while response headers are valid. Live audio and host-token usage are excluded.

## 2026-09-27 learning-workflow design

This change writes the [system-learning plan](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md), the [before/after workflow](study-workflows.md#proposed-system-learning), related documentation boundaries and a [handoff](handoffs/2026-09-27-learning-workflow-redesign.md). It does not implement the planned feature.

Verification for this documentation change is limited to current-code grounding, plan review, Markdown links/references, requirement-to-unit coverage and whitespace/diff checks. No production tests, build, real-model evaluation or learner trial were run in this planning turn. Earlier test counts below are historical results, not evidence for U1–U9 or AE1–AE16.

The prior assessment turn reproduced the existing 4-mastered/1-new → 80%/done calculation; that is evidence of the current rule, not a passing test of the new policy. Actual five-PDF/JSON coverage and zero-beginner teaching effectiveness remain unverified. The plan's Verification Contract specifies the implementation and pilot gates.

Plan review covered coherence, feasibility, product, scope, design and adversarial lenses in separate contexts. Three findings were applied within the user's requested design scope:

- Coherence: practical review now requires all mandatory criteria for each individual target, consistent with partial success in a multi-target experiment.
- Adversarial: delayed recall measures the interval since the target's latest relevant learning event, including teaching or practice on a different question.
- Adversarial: confirmed substantive false passes block the affected assessment path from issuing verified evidence until corrected and checked against the failure and independent samples.

The lead also aligned post-publish navigation with the selected learning mode and clarified that a new curriculum version preserves an active old session without awarding evidence to the new version. The other four review lenses reported no actionable findings. No unresolved review decisions remain. The optional cross-model pass was unavailable: the installed Claude launcher points to a missing executable; no review document was sent externally and no provider review is claimed.

Documentation checks cover all 12 changed/new Markdown files: local link targets and section anchors, balanced code fences, conflict markers, unique R1–R16 / AE1–AE16 / U1–U9 / KTD1–KTD8 definitions, requirement/example coverage and acyclic implementation dependencies. `git diff --check` passed. These are document integrity checks, not implementation or educational validation.

## Historical evidence follows

## Automated evidence

`npm test`: 35 tests passed, 0 failed, 0 skipped on this machine. Includes the 0.2.0 list below plus:

- Global notebook registry: publish/list/unpublish, missing libraries flagged, corrupt registry degrades to empty, `DSH_HOME` isolation.
- Cross-workspace `notebook.search` across published libraries (read-only) and host-transport round-trip for the notebook actions.
- Cloze cards: quality-gate validation (markers ↔ answers), public masking (no `value`/`accept` before answering), normalized per-blank grading with `accept` variants, SM-2 update, reveal-gate after the answer.
- Mock exam: silent answer recording (no feedback/SM-2/attempts while open), changeable answers, `projection.picks` restore surface, withdraw-by-clearing (empty selection ⇒ unanswered), reveal refused until submit, submit grades once with report (score/duration/byTopic/byDeck/wrong/weakScope), resubmit rejected, weakScope re-practices through the normal path.
- Wrongbook aggregation of latest wrong answers across decks.
- Dashboard stats: streak, 182-day zero-filled heatmap, daily average trend, weak topics.
- Graph: structure tree (deck › topic › card) with prerequisite edges, topic-scoped filtering, ordered path mode.
- Graph canvas geometry (`ui/graph-layout.js`, pure functions): deck blocks pack into columns, a single tall deck keeps its own column, a card with no tree edge lands in the 未分组 ghost group under its deck, every node is placed exactly once inside the sheet bounds, fit/zoom stay inside their range and never magnify past FIT_MAX, and path rows follow the canvas width and wrap serpentine.

- Coach (`tests/coach.test.mjs`, deterministic fake model in `scripts/fake-model.mjs`): zero-token cognitive levels (contrast wording beats 是什么), exact-slice evidence windows within budget, one nudge per wrong answer shared by the server prefetch and concurrent panel requests, hidden check key until tapped, at most two follow-ups, correct answers and coach-less services make no model calls, thumbs-down tags rewrite once in the background while the answered entry keeps its feedback and can be reverted, consent-gated variant batches that pass validation and move into 为你定制 with apply level, concept-only debrief insight with a shared/cached model call and profile update, snapshot fingerprint `unchanged`, profile inspect/clear. Host: light route picks off → low and caps output only when thinking is off.

- Sharded storage (`tests/store.test.mjs`): a commit rewrites only changed shards (deck b and the last attempts chunk) behind an atomic manifest and collects the replaced files; chunk order and removals survive a fresh read; a throwing mutation writes nothing and cannot leak nested manifest fields into the cache; a version 1 monolithic file opens, its first commit keeps the original bytes in `backups/` and later commits do not back up again; reads are cached per manifest stat and pick up another writer's commit; common service flows run with the cached library deep-frozen (`STUDY_STORE_FREEZE=1`, which also passes for the whole suite), and service results are detached copies.
- Storage benchmark (2026-09-15, copy of a real 7MB library: 245 sources, 14 decks / 384 cards, 39 runs with card snapshots), answer + snapshot + review.get + coach nudge in parallel: answer 325–740ms → 54–60ms, 下一题 318–512ms → 48–53ms, snapshot 460–1185ms → 7–12ms, review.get 530–1086ms → 1–2ms, worst event-loop stall 223–484ms → 34–38ms. Migration commit 280ms; manifest 28KB. Preview on the unmigrated copy: the first answer migrated it with a backup, a flashcard grade showed in 84ms and 下一题 in 81ms, progress and the sources page survived a reload.

- Upstream SM-2 formula and grade bounds.
- Required source quotes, distractor explanations and distinct objectives.
- No answer/option correctness in pre-answer review projection.
- Exact multiple-choice grading, idempotent submission, flashcard reveal before grade.
- Cross-instance concurrent writes; exception rollback preserves committed bytes.
- Durable review resume, completion, due queue and retained-source protection.
- Read-only legacy import, preserved scheduling and idempotent re-import.
- Author → editor → repair → re-review; persistent editorial problems rejected.
- Requested question kind enforced even if the editor approves the wrong kind.
- Progressive teaching never stores raw learner answers or adds SM-2 attempts.
- Actual DSH SDK entry import, tool/route registration.
- Browser carrier and server route round-trip, correct error envelope, 404/405-only legacy fallback.
- Published deck editing preserves unchanged scheduling, resets changed content, retains attempts, and blocks active-review mutation.
- Stale draft saves, publishes and deletes are rejected when the caller supplies the read version.
- Latest-outcome wrong queue; reversible archive/suspension; closed reviews reject further responses.
- Side-effect-free review reads and durable redacted teaching resume without repeat model calls.

`npm run build` creates the DSH classic-module client plus standalone browser preview. `npm pack` includes runtime modules, client, bundle patch, source protocols and README, excluding learner/demo data, tests and dev dependencies.

## Browser verification

### Audio input diagnostics, import entry and inbox — 2026-09-29 (unpublished)

- `npm run verify`: 440 tests, 435 passed, 0 failed, 5 optional host SDK checks skipped; lint and builds passed.
- Input diagnostics measure the same PCM frames uploaded by LiveClient. Tests distinguish silent frames from absent frames, capture from backend acknowledgment, and muted, suspended, paused and stopped states.
- Audio import integration tests verify all three stage notifications and the final saved-result message, persistence across service reopen, and opening the source from the inbox. Partial proofreading failures generate a warning milestone rather than a success milestone.
- Chromium with synthetic audio and mocked live endpoints verifies changing input level, silence at zero, capture-context interruption, pause/resume, continued recording while opening the new Audio transcription page, track cleanup and no terminal polling. A separate mocked inbox verifies opening the source modal from a completion message. The stage/persistence behavior is separately exercised through the real StudyService with a fake provider.
- Inspected the meter at 320px and the import page and inbox at 420px. Evidence: `output/playwright/audio-monitor-check.log`, `audio-meter-silent-320.png`, `audio-transcription-page-420.png`, `audio-inbox-check.log`, `audio-inbox-420.png`.
- The user's physical microphone and live provider recognition quality were not tested; the new diagnostics make these observable without claiming a cause for sparse transcription.

### Classroom live transcription and panel width follow-up — 2026-09-29 (unpublished)

- `npm run verify`: lint and both builds passed; 437 tests, 432 passed, 0 failed, 5 skipped because the optional DSH SDK is unavailable.
- Real Chromium in the isolated port 4182 preview, fixed 1440px window: 108 page/language/panel-width combinations passed the horizontal-overflow check. Chinese panels: 320, 360, 420, 640, 900 and 1440px; English panels: 320, 420 and 900px. Intentional kanban scrolling is checked by column width. Visually inspected the classroom, wrongbook and result card. The rendered Review result card uses one column at 320/420px and two at 900px without overflow.
- The real browser AudioWorklet ran against synthetic audio and mocked live endpoints: 100ms PCM frames, pause/resume, selected-sentence generation, continued capture during navigation, ending releases tracks, ended sessions stop polling, and save confirmation. Provider/service behavior is tested separately with fake WebSockets and controlled translation responses.
- Regression coverage includes late polls before/during stop, cancellation while connecting, delayed final text during connection handover and immediate stop, restored translation retries, serial persistence, failed-disk handoff rejection, and preventing retired writers from overwriting resumed or deleted sessions.
- Independent scoped review and reuse/quality/efficiency checks completed; reported issues were fixed and covered by regressions. This bounded mixed-working-tree review is not a formal `ce-code-review` whole-diff receipt and does not replace earlier release receipts.
- Evidence is local under `output/playwright/`: `layout-check.log`, `live-class-420.png`, `layout-3-320.png`, `result-420.png`, and `verify.log`. Live provider credentials and native DSH capture permissions remain unverified. These features are local changes and have not been published.

Used Playwright CLI against the same React UI and StudyService exposed by the standalone server. Preview library was explicitly created at `output/preview-library` using the demo seed script.

- Desktop 1280×1100 and narrow 390×844 layouts inspected visually.
- Selected wrong and correct quiz options, checked source-based per-option explanations and next due dates, completed a quiz, reloaded and verified attempt totals.
- Revealed flashcard answer, selected self-grade, returned to library and verified resumable review.
- Created a draft through a separate service instance while the panel stayed open; the draft appeared without remount.
- Entered `{}` into the JSON editor and switched to visual editing: error shown, editor and original draft preserved; no blank app.
- CSS is scoped to `.study-app`; responsive layout uses container width, not the host viewport.
- Preview favicon request fixed; no browser application exceptions observed on final pages.
- 0.2.0 completeness pass on port 4180: ended an abandoned run, suspended/restored a card, archived/restored a deck, edited the published deck, refreshed with unsaved changes and recovered them, then published successfully with no stale recovery banner.
- Created a flashcard manually through the UI, entered a source quote, validated and published it without a model. Flashcard-only decks correctly disable the quiz action.
- Rechecked 390×844 layout for horizontal overflow and visually inspected the management page. Evidence: `output/study-completeness-mobile.png`, `output/study-management.png`.
- During deliberate preview-server restart, the old page logged connection-refused and stale-token 403 errors; reload recovered the connection. No application exceptions occurred in the completed browser flows.
- 0.3.0 cross-workspace pass: publish/unpublish in the notebook directory, jump targets, global due queue and cross-library search UI rendered in the standalone preview.
- 0.4.0 pass (Chromium, 2026-09-13): graph page renders the horizontal fork (deck › topic › card) and the ordered path mode; dashboard renders totals, heatmap and trend; exam setup → 2-question run → submit produced a live report (score 50%, per-topic/deck bars, duration); wrongbook empty state rendered. A missing SVG `transform` on graph card nodes found in this pass was fixed and re-verified visually.
- 0.6.0 graph-canvas pass (Chromium, 2026-09-15, standalone preview on port 4181, seeded library `output/preview-big`: 10 decks / 320 cards / 120 prerequisite links): 查看图谱 from the study map enters browser fullscreen (element rect 1440×900 = the whole window, so the study panel's `contain: layout paint` no longer clips it). The 320 cards were previously cut at `MAX_H` 1200px of a ~11k-tall ribbon; the canvas now lays them out as 4488×2250 in 5 viewport-chosen columns and fits at 30% with nothing clipped. Verified: zoom buttons (30%→38%), Ctrl+wheel around the pointer (92%→115%), `0`/ `+` keyboard shortcuts, drag-to-pan at 92% (scroll 1445,734 → 1595,884), path mode inside the canvas (fit 103%), and clicking a card releases fullscreen and opens that question. Panel view keeps a fixed 68vh viewport at 25%; at 460px wide the same library packs into 3 columns and scrolls horizontally. Evidence: `output/canvas-1-fullscreen.png`, `output/canvas-2-zoomed.png`, `output/canvas-3-path.png`, `output/canvas-5-panel.png`, `output/canvas-6-narrow.png`.
- Coach pass (Chromium, 2026-09-15, `STUDY_FAKE_MODEL=1` preview on port 4191): at 1440×900 the 陪学 column sits beside the question; resuming a wrong answer shows the typing indicator then point + check; tapping the check, 还是不懂 (second angle), consent and goal all work without typing; B then 2 opened the tag tray and, after the idle delay, the background rewrite note with 撤销修改 appeared while the answered question kept its feedback; A turned autopilot on, a correct answer showed the countdown bar and advanced to the summary, whose debrief offered 刷 1 道为你定制的题 with a 5 s countdown that started the 为你定制 · 1 题 run. At 820px the panel renders inline under the feedback. The library shows the ready offer; `?` opens the shortcut sheet; 设置 › 陪学 shows consent, goal, signals and 清空画像. Light theme: answered options were unreadable (hard-coded dark backgrounds) and now use theme tokens.
- 0.4.0 narrow-viewport pass (390×844): dashboard, exam setup, exam running, wrongbook and the library with the notebook directory show no horizontal overflow; stat cards wrap and the heatmap scrolls horizontally. Resuming an open exam through 回到题目 renders in the review page with a pointer to submit from the exam page (next-question unlocked for exam runs); the exam itself is reached via its own nav entry.

Screenshots (local generated evidence, not included in the npm package):

- `output/study-library.png`
- `output/study-quiz-feedback.png`
- `output/study-flashcard.png`
- `output/study-mobile.png`

## Installed host evidence

The initial 0.1.0 tarball was installed in isolated DSH profiles `study-validation` and `study-validation-web`. The Web profile boots on port 4179 and loads the package without console errors. Authentication and route dispatch were exercised on that real host:

- Unauthenticated POST to `/api/study-workspace/call`: HTTP 401.
- Authenticated browser POST: HTTP 200, valid `server-response` envelope, `STUDY_ERROR` with message/code/details for a nonexistent test session.
- Peer imports resolve from the installed tarball, not only the source checkout.

The user's daily DSH profile was not changed. Full interaction inside an existing native DSH conversation was not completed; native view and right-sidebar registrations are covered by implementation/SDK inspection, while functional UI interactions were exercised in the standalone preview.

## Review and remaining limits

`ce-simplify-code`: reuse, quality and efficiency passes completed. Consolidated imports, normalized source text once per validation, parallelized static reference reads, documented teaching tool actions and bounded terminal generation-job retention. Deferred low-value loop/I/O rewrites to avoid needless behavioral churn.

Initial 0.1.0 `ce-code-review`: completed, seven findings fixed and independently validated, no remaining actionable findings. Receipt: `docs/ce-code-review/2026-09-12-final/review.json`. The 0.2.0 completeness changes received an inline code review and the additional tests/browser checks above; that earlier independent receipt does not cover the new diff.

Real model-provider generation was not run with user credentials. The generation protocol and repair/error paths are tested with controlled responses; the model's factual and teaching quality still requires checking against real source material. No claim is made that automated editorial review proves correctness. No lint or TypeScript checker is configured; files were formatted with Prettier and verified by build/tests.
# 2026-09-29：实时上下文校正、课堂笔记与归档

- `npm run verify`：449 项，444 通过，5 项缺少可选 DSH SDK 的检查跳过，0 失败；lint 与构建通过。记录：`output/playwright/correction-verify.log`。
- 新增验证：35 句突发完整覆盖、8 新句加 2 句重叠、检查中新增句子留给下一轮、结束补齐尾部、失败/超时保留游标、识别原稿保留、旧翻译不覆盖新校正、笔记落盘、子代理不阻塞主流程、跨范围版本冲突拒绝合并、缺少子代理时可见重试、low/default 路由与实际缓存计数。
- 归档状态经过落盘和重新加载验证，恢复可用，归档中删除不影响已另存的逐字稿与笔记资料。
- 浏览器使用模拟模型结果验证历史句子原位更新、勾选保留、笔记引用跳转、中英文入口、保存调用，以及归档/恢复/取消删除/确认删除。320、420、900 px 面板均无相关区域横向溢出。脚本：`output/playwright/live-notes-check.js`、`output/playwright/live-archive-check.js`；截图：`live-notes-420.png`、`live-archive-420.png`。
- 原生 DSH 子代理协议用模拟宿主验证；没有有效密钥或完整宿主 SDK，未声称验证真实识别/纠错质量、实际速度或节省费用。


## 1.4.0 发布检查 — 2026-09-30

- 完整 `npm run verify`：627 项通过、0 失败、0 跳过；使用本机 DSH SDK 执行真实 Cordis 依赖注入回归，静态检查和客户端构建通过。证据：`output/release-1.4.0-final-verify.log`。
- `settings`、`map`、`source.list` 与命令/侧栏的会话依赖覆盖；普通模拟宿主不检查依赖的盲点已补足。
- 八步系统学习路径仍未实现；真实付费音频、麦克风权限及运行中桌面模型交互的端到端验证仍未完成。SWE5001 的宿主 ACL 权限问题没有通过插件修改。
- 本次交付通过 GitHub Release 分发；磁盘安装和运行中激活分开确认，不强制重启尚有内存任务的宿主。

- 资料全屏预览：浏览器验证 1440×900 / 390×844，模拟宿主标题栏 40px 时关闭按钮顶部分别为 55px / 51px；按钮可命中，无窄窗口横向溢出，关闭及 Esc 返回原入口。受限侧栏中仍覆盖整个视口；实际窗口全屏时取消标题栏留白。截图 output/fullscreen-preview-windows.png。未声称已重启运行中的桌面宿主。
