# StudyHub 2.5.10 integration acceptance — 2026-10-03

Status: complete local release build. Source changes are integrated; eight installable archives and two setup pages were produced and verified. Nothing in this acceptance publishes a GitHub release, npm version or website.

## Scope

- Included the previously unfinished README, feature documentation and existing introduction website, alongside the generation, materials, review and settings fixes on this branch.
- Excluded the proposed A/B/C/D application UI redesigns, private design boards, `.claude/` and `blobs/`. The introduction website preserves its existing design.
- Version, package metadata, lockfile, bilingual changelogs and install documentation agree on 2.5.10.

## Functional outcomes

- Generation extracts supported knowledge points and exact source passages, builds grounded answers, writes the questions and independently reviews them. Verified knowledge points and answers survive a correction response that omits, changes or fails to return them. Only checked targets claim stable slots; question reordering preserves bindings by card identity. Evidence and answer checks remain strict, with no additional model call added by this integration.
- Generation preferences remain configurable in Settings. Verified batches can be saved before the rest finish, within the configured deadline. Case creation follows the saved generation language and course defaults while preserving text and values the learner is editing.
- Saving SM-2 preferences writes only the changed scheduling fields, preserving generation preferences. Incoming settings refresh untouched fields. A course merge brings new profile fields into the open form without erasing pending edits.
- Course timing and case papers use the same supported reading-time and minutes-per-mark ranges. Case creation remains operable in narrow layouts and at enlarged text sizes.
- Editing a question hides outdated English translations until a translation of the current content is available. The persisted translation and historical question snapshots remain intact.
- Jev custom endpoints/models are accepted through the public settings contract; audio tool inputs describe actual upload IDs and file objects. Long-audio preflight messages show the configured segment duration. Reader shortcut metrics, paused-empty usage reports, current page names and generated English titles were reconciled with current behavior.

## Verification

| Check | Result |
| --- | --- |
| Isolated full suite, `npm test` | 3,362 passed; 0 failed, cancelled or skipped |
| Project-wide `npm run lint` | Passed |
| Application `npm run build` | Passed |
| Translation regression after simplification | 8 passed |
| Website browser checks | Both languages at 360, 420, 768, 1280 and 1680 px; keyboard, focus, 200% text, no-JavaScript content and local links passed |
| Case/settings browser checks | Pending edits, course merge, generation defaults and narrow layout passed |
| Actual archive verification | Eight package names/versions, entry files, language entry points, all packaged Markdown links and ten SHA-256 checksums passed |
| Packaged plugin entry smoke check | All eight extracted plugin entries imported successfully in the isolated runner; no services started or external connections attempted |

The first full run caught two tests expecting superseded button/page labels. Their assertions were updated to the current names; the final complete run passed. No assertion of functional correctness was removed.

No separate typecheck command is configured. Application build and project lint cover the configured checks.

Code review: targeted manual due to unrelated branch work. The production scope is recorded in `output/bugfix-audit-round4/simplify-scope.json`. Three independent simplification passes completed: reuse applied 1, quality applied 0, efficiency applied 1, skipped 0. The applied changes remove duplicate whitespace normalization and clean up the validator's own temporary unpacking directories in `finally`, with the resolved cleanup path checked against the release directory. Evidence validation, input protection and model call counts remain intact.

## Artifacts and evidence

- Release directory: `output/release-2.5.10/`.
- Full package: `ericwang1358-dsh-daily-flashcard-2.5.10.tgz`.
- Six capability packages: runtime, materials, bank, study, generation and audio.
- Search companion: `ericwang1358-studyhub-retrieval-2.5.10.tgz`.
- Bilingual setup pages, `artifacts.json`, `SHA256SUMS-2.5.10.txt` and `verification.json` are beside the archives.
- Deployable introduction site: `output/site-dist/`; local preview at `http://127.0.0.1:4322/` and `/en.html`.
- Complete test/build/lint and archive logs: `output/bugfix-audit-round4/`.
- Actual packaged entry smoke test: `output/bugfix-audit-round4/archive-entry-smoke.log`; 8 passed.
- Website acceptance: `output/site/qa-2.5.10/summary.json`; independent exports: `output/site/export-smoke-summary.json`.
- Packaged document graph: `output/docs-2.5.10-acceptance.json`; 51 documentation files, 58 packaged Markdown documents checked, zero missing targets.
- Feature regression receipts: `output/bugfix-audit-round2/owner-fixes-freeze.md`, `output/bugfix-audit-round3/course-merge-browser/summary.json`, and `output/bugfix-audit-round4/scheduling/acceptance.md`.

## Limits of this acceptance

Generation and service regressions used fixtures and temporary libraries, not real learner data or paid provider credentials. The final isolated suite scrubbed provider secrets and blocked four attempted external connections across 347 test processes. Earlier in this integration, an agent's separately launched typed-tool fixture lacked its fake fetch and attempted an external request using a fake key; the final isolated run supersedes that run. This report does not claim that the entire work session made zero external requests.

Actual provider first-batch acceptance rate and latency have not been measured. The known retention and binding failures have regression coverage; no guarantee that a model can never supply an unsupported passage or answer is made. Website external destination availability and public deployment were not part of offline acceptance.

## Same-day follow-up: clear expression

After the release integration, shared clarity guidance was added to answer preparation, author self-check and independent review. It applies to Chinese, English and bilingual learner-facing text, retains technical terms and decisive conditions, and explicitly protects exact quotes and verified answer fields. No English-only dictionary, fixed word limit, new review dimension or model call was added. Evidence extraction remains unchanged. The bilingual quality documentation describes this scope.

Follow-up verification: 90 relevant generation, evidence, Jev, case and documentation regressions passed; project-wide lint and application build passed. All eight refreshed 2.5.10 archives passed checksum, locale and document verification, and their extracted entries passed eight isolated import smoke checks with no services started or external connections attempted. Logs are `output/bugfix-audit-round4/clear-expression-*.log`. The 3,362-test result above belongs to the earlier full integration run; this follow-up used scoped regressions. Real-provider gains are not claimed.
