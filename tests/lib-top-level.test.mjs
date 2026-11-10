import test from 'node:test';
import assert from 'node:assert/strict';
import { topLevelLib, trackedFiles } from '../scripts/qa/lib-graph.mjs';

/* #902 S2. The number of git-tracked top-level lib/*.js files does not grow. The rule this test enforces and nothing more: a new module goes under
   lib/contexts/<context>/; raising the number below needs the reason written in the pull request. Lower it when a file leaves lib/.
   The number starts from main at d24682c0 (422 files). For scale, the same count was 286 at eeda7e19 (last commit on main before 10 October) and 358 at 122cb4ad (last before 1 November).
   Files are counted with `git ls-files`, never from the disk: lib/client*.js is build output, ignored by git, and a local build leaves those files on the disk. */
const MAX_TOP_LEVEL_LIB_FILES = 422;

test('no new top-level lib/*.js file: the tracked count is at or under the ceiling', (t) => {
  const tracked = topLevelLib(trackedFiles());
  assert.ok(tracked.length > 300, `only ${tracked.length} tracked top-level lib files found: git ls-files is not answering for this checkout`);
  assert.ok(tracked.length <= MAX_TOP_LEVEL_LIB_FILES,
    `lib/ has ${tracked.length} git-tracked top-level .js files; the ceiling is ${MAX_TOP_LEVEL_LIB_FILES} (tests/lib-top-level.test.mjs). A new module goes under lib/contexts/<context>/. `
    + 'Raising the ceiling needs the reason written in the pull request.');
  if (tracked.length < MAX_TOP_LEVEL_LIB_FILES) t.diagnostic(`lib/ now has ${tracked.length} top-level files: lower MAX_TOP_LEVEL_LIB_FILES from ${MAX_TOP_LEVEL_LIB_FILES} to ${tracked.length}`);
});

test('only direct children of lib/ count: contexts, shared folders and non-js files do not', () => {
  const sample = ['lib/a.js', 'lib/b.mjs', 'lib/contexts/bank/a.js', 'lib/runtime/builtins.js', 'lib/live-local-worker.mjs', 'ui/a.js', 'lib/a.json', 'lib/z.js'];
  assert.deepEqual(topLevelLib(sample), ['lib/a.js', 'lib/z.js']);
});
