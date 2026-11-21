import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/* 知识点查缺 reads the course outline's placement, and the estimate builds its round: these modules must load whatever is imported first (an import cycle made
   `rowRefsOf` unreadable at load for some entry orders, gate review of 245c675d). Each is imported FIRST in a fresh process, and none of them is on an import
   cycle of lib/. */

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['lib/course-outline.js', 'lib/evidence/point-rows.js', 'lib/evidence/point-report.js', 'lib/custom-readiness.js', 'lib/evidence/course-evidence.js',
  'lib/course-outline-index.js', 'lib/contexts/generation/generate/point-allocate.js', 'lib/contexts/generation/generate/point-plan.js',
  'lib/contexts/generation/generate/point-round.js', 'lib/token-estimate.js', 'lib/course-outline-book.js'];
const run = promisify(execFile);

for (const file of MODULES) {
  test(`${file} loads when it is imported first`, async () => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(repository, file)).href)}); console.log('loaded');`],
      { cwd: repository });
    assert.equal(stdout.trim(), 'loaded');
  });
}

/** The relative imports of a file (static `import … from` and `export … from`). */
const importsOf = file => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)]
  .map(match => resolve(dirname(file), match[1])).filter(existsSync);

test('none of them is on an import cycle', () => {
  for (const file of MODULES) {
    const start = join(repository, file), seen = new Set(), stack = [[start, [start]]];
    while (stack.length) {
      const [at, path] = stack.pop();
      for (const next of importsOf(at)) {
        assert.notEqual(next, start, `cycle: ${[...path, next].map(item => relative(repository, item).replace(/\\/g, '/')).join(' -> ')}`);
        if (!seen.has(next)) { seen.add(next); stack.push([next, [...path, next]]); }
      }
    }
  }
});
