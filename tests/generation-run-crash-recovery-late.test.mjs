/* Late runtime generationRestart-switch crash recovery windows (issue #608): second half of restart crash windows for balanced
   local and CI parallel execution. Fake models only. */
import { defineCrashWindowModeSuite } from './helpers/generation-run-crash.mjs';

defineCrashWindowModeSuite('restart', {
  includeBeforeFirstDraft: false,
  middleWindows: ['round-2-part-saved', 'last-question-saved', 'closing-unsaved'],
  includeClosingSaved: true,
});
