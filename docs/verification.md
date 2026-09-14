# Verification — 2026-09-12 (updated 2026-09-13 for 0.3.0/0.4.0)

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
