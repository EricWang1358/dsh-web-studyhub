/* Legacy-mode crash recovery across the coverage-run windows (issue #608): split by mode so CI shards and local workers run
   legacy, generation, and restart modes in parallel. Fake models only. */
import { defineCrashWindowModeSuite } from './helpers/generation-run-crash.mjs';

defineCrashWindowModeSuite('legacy');
