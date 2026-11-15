/* Early runtime generationRestart-switch crash recovery windows (issue #608): split into two 4-test files so CI shards balance
   with legacy and generation suites. Fake models only. */
import { defineCrashWindowModeSuite } from './helpers/generation-run-crash.mjs';

defineCrashWindowModeSuite('restart', {
  includeBeforeFirstDraft: true,
  middleWindows: ['first-part-saved', 'round-1-done-unsaved', 'round-2-running-saved'],
  includeClosingSaved: false,
});
