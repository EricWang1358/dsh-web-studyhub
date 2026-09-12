# Verification — 2026-09-12

## Automated evidence

`npm test`: 19 tests passed, 0 failed, 0 skipped on this machine. Includes:

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
