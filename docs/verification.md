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
