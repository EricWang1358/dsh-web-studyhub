import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* The chapter list of a big converted book (资料 page, "查看 N 章"): one line per chapter (title, size, 从这一章出题), inside a list that
   scrolls on its own. A rule written for the plain page buttons (`.source-doc__page-list button { display:flex; width:100% }`) also caught
   the 从这一章出题 button, so it dropped to a line of its own, centred, and every chapter took two rows; and a 400-page book simply pushed
   the whole page down. */

const css = readFileSync(new URL('../ui/sources.css', import.meta.url), 'utf8');

/** The body of the first rule whose selector (after trimming) is exactly `selector`. */
function rule(selector) {
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*${selector.replace(/[.>:()[\]]/g, match => `\\${match}`)}[ \\t]*\\{([^}]*)\\}`);
  return pattern.exec(css)?.[1] ?? '';
}

test('a chapter row is one flex line: the title takes the room, the generate button keeps its own width', () => {
  const row = rule('.source-doc__chapters > li');
  assert.match(row, /display:\s*flex/);
  assert.match(row, /align-items:\s*center/);
  assert.match(rule('.source-doc__chapters > li > .source-doc__chapter-btn'), /flex:\s*none/);
  assert.match(rule('.source-doc__chapters > li > .source-doc__chapter-btn'), /width:\s*auto/);
});

test('no stylesheet rule is written for a raw button of the list any more: the rows are <Button> (#137)', () => {
  assert.doesNotMatch(css, /source-doc__page-list button:not\(\.sh-btn\)|source-doc__chapters > li > button:not\(\.sh-btn\)/);
});

test('the list scrolls inside its own box', () => {
  const list = rule('.source-doc__page-list');
  assert.match(list, /max-height:/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
});

/* The wave-4 regression: the row buttons became <Button> and the `:not(.sh-btn)` rules that made them full-width one-line rows matched
   nothing, so every row was a bordered, centred, content-width button. The rows are a quiet block Button with one targeted class. */
const compiled = await build({ stdin: { contents: `export { ChapterList } from './ui/Sources.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const exported = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), exported, exported.exports);
const { ChapterList, setUiLanguage } = exported.exports;

test('the chapter rows are quiet, block, start-aligned Buttons with the row class', () => {
  const HASH = 'c'.repeat(64);
  const pages = [1, 2].map(n => ({ id: `p${n}`, title: `Book · p.${n}`, text: 'x'.repeat(30), createdAt: '2026-10-01T08:00:00.000Z', courses: ['OS'],
    document: { id: HASH, page: n, totalPages: 2, format: 'pdf', extractionVersion: 2, materialId: `document-${HASH}-pdf`, origin: 'converted', converter: 'mineru', chapter: { index: n - 1, title: `Chapter ${n}`, level: 1 } } }));
  const [item] = groupSourcesByDocument(pages);
  setUiLanguage('zh');
  const html = renderToStaticMarkup(React.createElement(ChapterList, { item, busy: false, onOpen() {}, onGenerate() {}, listId: 'l' }));
  const rows = html.match(/<button[^>]*class="[^"]*source-doc__row[^"]*"/g) || [];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row, /sh-btn--quiet[^"]*sh-btn--block[^"]*sh-btn--start/);
});

test('the page list rows carry the same row class, and the class gives the old look without a :not() guard', async () => {
  const HASH = 'd'.repeat(64);
  const pages = [1, 2].map(n => ({
    id: `p${n}`,
    title: `Notes · p.${n}`,
    text: 'x'.repeat(30),
    createdAt: '2026-10-01T08:00:00.000Z',
    courses: ['OS'],
    document: { id: HASH, page: n, totalPages: 2, format: 'pdf', extractionVersion: 2, materialId: `document-${HASH}-pdf`, origin: 'converted', converter: 'mineru' },
  }));
  const [item] = groupSourcesByDocument(pages);
  const opened = [];
  const noop = () => {};
  const actions = { open: (id) => opened.push(id), generate: noop, changeCourse: noop, archive: noop, pin: noop, pinMove: noop };

  await withBrowserGlobals(async () => {
    const interactive = await loadInteractiveUi(`
      export { DocumentRow } from './ui/Sources.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    interactive.exports.setUiLanguage('zh');
    const mounted = interactive.mount(() => interactive.React.createElement(
      interactive.exports.StudyServicesContext.Provider,
      { value: { busy: false, openModal: noop, call: async () => ({}) } },
      interactive.React.createElement(interactive.exports.DocumentRow, {
        item,
        source: pages[0],
        actions,
        courses: ['OS'],
      }),
    ));
    try {
      const expandBtn = mounted.find((node) => node.type === 'button' && mounted.text(node).includes('查看 2 页'));
      assert.ok(expandBtn, 'multi-page non-chaptered DocumentRow exposes 查看 2 页 toggle');
      await mounted.act(() => click(expandBtn));

      const pageList = mounted.find((node) => node.type === 'ul' && String(node.props?.className || '').includes('source-doc__page-list'));
      assert.ok(pageList, 'clicking toggle expands the page list');
      const pageRows = mounted.findAll((node) => node.type === 'button' && String(node.props?.className || '').includes('source-doc__row'), pageList);
      assert.equal(pageRows.length, 2);
      for (const pageRow of pageRows) {
        const cls = String(pageRow.props?.className || '');
        assert.match(cls, /\bsh-btn--quiet\b/);
        assert.match(cls, /\bsh-btn--block\b/);
        assert.match(cls, /\bsh-btn--start\b/);
        assert.match(cls, /\bsource-doc__row\b/);
      }
      await mounted.act(() => click(pageRows[1]));
      assert.deepEqual(opened, ['p2']);
    } finally {
      mounted.unmount();
    }
  });

  const row = rule('.source-doc__row');
  assert.match(row, /align-items:\s*baseline/);
  assert.match(row, /min-height:\s*0/);
  assert.match(row, /padding:\s*calc\(var\(--space-1\) \+ var\(--space-half\)\) var\(--space-2\)/);
  assert.match(row, /font-size:\s*var\(--fs-sm\)/);
  assert.match(rule('.source-doc__row > span:first-child'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.source-doc__row > span:first-child'), /white-space:\s*nowrap/);
  assert.doesNotMatch(css, /:not\(\.sh-btn\)/);
});
