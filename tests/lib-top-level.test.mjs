import test from 'node:test';
import assert from 'node:assert/strict';
import { topLevelLib, trackedFiles } from '../scripts/qa/lib-graph.mjs';

/* #902 S2. The number of git-tracked top-level lib/*.js files can only fall. It was 286 before 10 October, 354 before 1 November and is the number below now;
   the contexts (lib/contexts/<id>/) and the named shared folders (lib/runtime/, lib/jobs/, lib/office/, lib/plugins/) are where new modules go.
   docs/architecture.md still calls lib/*.js "shared domain modules", and a flat file is not forbidden by taste: it is a decision that has to be argued for in review.

   LOWER THIS NUMBER WHEN A FILE LEAVES lib/. NEVER RAISE IT. A new module goes into a context under lib/contexts/ or into a named shared folder, not next to the 400 flat ones.
   Files are counted with `git ls-files`, never from the disk: lib/client*.js is build output, ignored by git, and a local build adds ~190 of them. */
const MAX_TOP_LEVEL_LIB_FILES = 421;

test('no new top-level lib/*.js file: the tracked count is at or under the ceiling', (t) => {
  const tracked = topLevelLib(trackedFiles());
  assert.ok(tracked.length > 300, `only ${tracked.length} tracked top-level lib files found: git ls-files is not answering for this checkout`);
  assert.ok(tracked.length <= MAX_TOP_LEVEL_LIB_FILES,
    `lib/ has ${tracked.length} git-tracked top-level .js files; the ceiling is ${MAX_TOP_LEVEL_LIB_FILES} (tests/lib-top-level.test.mjs). Do not raise it: put the new module `
    + 'into a context under lib/contexts/<id>/ or into a named shared folder (lib/runtime/, lib/jobs/, lib/office/, lib/plugins/).');
  if (tracked.length < MAX_TOP_LEVEL_LIB_FILES) t.diagnostic(`lib/ now has ${tracked.length} top-level files: lower MAX_TOP_LEVEL_LIB_FILES from ${MAX_TOP_LEVEL_LIB_FILES} to ${tracked.length}`);
});

test('only direct children of lib/ count: contexts, shared folders and non-js files do not', () => {
  const sample = ['lib/a.js', 'lib/b.mjs', 'lib/contexts/bank/a.js', 'lib/runtime/builtins.js', 'lib/live-local-worker.mjs', 'ui/a.js', 'lib/a.json', 'lib/z.js'];
  assert.deepEqual(topLevelLib(sample), ['lib/a.js', 'lib/z.js']);
});
