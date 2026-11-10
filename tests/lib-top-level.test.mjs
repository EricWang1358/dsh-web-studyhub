import test from 'node:test';
import assert from 'node:assert/strict';
import { topLevelLib, trackedFiles } from '../scripts/qa/lib-graph.mjs';

/* #902 S2. The number of git-tracked top-level lib/*.js files equals MAX_TOP_LEVEL_LIB_FILES, which only goes down. The rule this test enforces and nothing more:
   the count does not grow, a new module goes under lib/contexts/<context>/, and raising the number needs the reason written in the pull request. When a file leaves lib/,
   lower the number in the same change (equality, not "at most": otherwise a file could leave and another arrive unseen, and two pull requests that each raise the number would merge side by side).
   The number starts from main at d24682c0 (422 files). For scale, the same count was 286 at eeda7e19 (last commit on main before 10 October) and 358 at 122cb4ad (last before 1 November).
   Files are counted with `git ls-files`, never from the disk: lib/client*.js is build output, ignored by git, and a local build leaves those files on the disk.
   A new file is counted once it is `git add`ed (CI always sees it). */
const MAX_TOP_LEVEL_LIB_FILES = 422;

/** What is wrong with the count of tracked top-level lib files, or undefined when it equals the ceiling. */
function ceilingProblem(count, ceiling) {
  if (count > ceiling) {
    return `lib/ has ${count} git-tracked top-level .js files; the ceiling is ${ceiling} (tests/lib-top-level.test.mjs). A new module goes under lib/contexts/<context>/. `
      + 'Raising the ceiling needs the reason written in the pull request. (A new file counts once it is `git add`ed.)';
  }
  if (count < ceiling) return `lib/ has ${count} git-tracked top-level .js files, fewer than the ceiling ${ceiling}: lower MAX_TOP_LEVEL_LIB_FILES to ${count} in tests/lib-top-level.test.mjs.`;
  return undefined;
}

test('the tracked count of top-level lib/*.js files equals the ceiling', () => {
  const tracked = topLevelLib(trackedFiles());
  assert.ok(tracked.length > 300, `only ${tracked.length} tracked top-level lib files found: git ls-files is not answering for this checkout`);
  assert.equal(ceilingProblem(tracked.length, MAX_TOP_LEVEL_LIB_FILES), undefined);
});

test('a higher count asks for a context folder, a lower one asks to lower the ceiling, an equal one passes', () => {
  assert.match(ceilingProblem(423, 422), /423 git-tracked top-level .*the ceiling is 422.*lib\/contexts\/<context>\/.*reason written in the pull request.*git add/);
  assert.match(ceilingProblem(421, 422), /lower MAX_TOP_LEVEL_LIB_FILES to 421/);
  assert.equal(ceilingProblem(422, 422), undefined);
});

test('only direct children of lib/ count: contexts, shared folders and non-js files do not', () => {
  const sample = ['lib/a.js', 'lib/b.mjs', 'lib/contexts/bank/a.js', 'lib/runtime/builtins.js', 'lib/live-local-worker.mjs', 'ui/a.js', 'lib/a.json', 'lib/z.js'];
  assert.deepEqual(topLevelLib(sample), ['lib/a.js', 'lib/z.js']);
});
