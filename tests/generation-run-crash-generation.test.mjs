/* Runtime generation-switch crash recovery across the coverage-run windows (issue #608): runs in parallel with legacy and
   restart modes. Fake models only. */
import { defineCrashWindowModeSuite } from './helpers/generation-run-crash.mjs';

defineCrashWindowModeSuite('generation');
