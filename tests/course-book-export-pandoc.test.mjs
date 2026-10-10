/* 复习全书 M6, I10: Pandoc reads the export. When `pandoc` is on PATH, the single file and the folder's files (in book.yaml's order) are read without a
   warning (`--fail-if-warnings`: no duplicate anchor, no missing footnote) into the same HTML, its anchors and links in place; skipped otherwise (the
   structural checks of tests/course-book-export.test.mjs stand in for it). No model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBook as runExport } from '../lib/course-book-export.js';
import { cardOf, exportBook } from './helpers/course-book-export-book.mjs';

const pandoc = (() => { try { return spawnSync('pandoc', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();

test('Pandoc reads the single export and the folder\'s list without a warning, to the same HTML', { skip: pandoc ? false : 'pandoc is not on PATH' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-book-pandoc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const html = files => {
    const run = spawnSync('pandoc', ['-f', 'markdown', '-t', 'html', '--fail-if-warnings', ...files], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  for (const answerKey of [false, true]) {
    const single = runExport(exportBook(), { cardOf, answerKey });
    await writeFile(join(dir, single.filename), single.text);
    const one = html([single.filename]);
    for (const id of ['lookup', 'h2', 'h9', 'h3', 'unplaced', ...(answerKey ? ['answers'] : [])]) assert.match(one, new RegExp(`id="${id}"`), `the anchor ${id}`);
    assert.match(one, /href="#h2"/);
    assert.match(one, /class="footnotes/);
    assert.match(one, /<table>/, 'the 速查表 is a table');
    const folder = runExport(exportBook(), { cardOf, answerKey, form: 'folder' });
    for (const file of [...folder.files, folder.manifest]) await writeFile(join(dir, file.name), file.text);
    const list = [...folder.manifest.text.matchAll(/^ {2}- (.+)$/gm)].map(match => match[1]);
    assert.equal(html(list), one, 'the folder reads as the same book');
  }
});
