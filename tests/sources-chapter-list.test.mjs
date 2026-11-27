import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* The chapter list of a big converted book (资料 page, "查看 N 章"): one line per chapter (title, size, 从这一章出题), inside a list that
   scrolls on its own. A rule written for the plain page buttons (`.source-doc__page-list button { display:flex; width:100% }`) also caught
   the 从这一章出题 button, so it dropped to a line of its own, centred, and every chapter took two rows; and a 400-page book simply pushed
   the whole page down. */

const { declarations, blocks } = parseCss(readFileSync(new URL('../ui/sources.css', import.meta.url), 'utf8'));
const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());

/** Value of `prop` in base (non-media, non-narrow) rules whose selector list includes `selector`. */
function declValue(selector, prop) {
  return declarations.findLast((d) =>
    !d.ctx.some((c) => c.startsWith('@media') || c.includes('.is-narrow'))
    && splitSelectors(d.ctx.at(-1) || '').includes(selector)
    && d.prop === prop)?.value;
}

test('a chapter row is one flex line: the title takes the room, the generate button keeps its own width', () => {
  assert.equal(declValue('.source-doc__chapters > li', 'display'), 'flex');
  assert.equal(declValue('.source-doc__chapters > li', 'align-items'), 'center');
  assert.equal(declValue('.source-doc__chapters > li > .source-doc__chapter-btn', 'flex'), 'none');
  assert.equal(declValue('.source-doc__chapters > li > .source-doc__chapter-btn', 'width'), 'auto');
});

test('no stylesheet rule is written for a raw button of the list any more: the rows are <Button> (#137)', () => {
  const rawListButtonRe = /\.source-doc__(?:page-list|chapters)\b[^,]*[\s>+~]button(?![\w-])/;
  const hasRawListButton = (ctxText) => splitSelectors(ctxText).some((s) => rawListButtonRe.test(s));
  assert.deepEqual(
    declarations.filter((d) => d.ctx.some(hasRawListButton)),
    [],
    'no declaration targets a raw button inside .source-doc__page-list or .source-doc__chapters',
  );
  assert.deepEqual(
    blocks.filter((b) => hasRawListButton(b.prelude) || b.ctx.some(hasRawListButton)),
    [],
    'no block targets a raw button inside .source-doc__page-list or .source-doc__chapters',
  );
});

test('the list scrolls inside its own box', () => {
  assert.ok(declValue('.source-doc__page-list', 'max-height'), '.source-doc__page-list sets max-height');
  assert.equal(declValue('.source-doc__page-list', 'overflow-y'), 'auto');
  assert.equal(declValue('.source-doc__page-list', 'overscroll-behavior'), 'contain');
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

  assert.equal(declValue('.source-doc__row', 'align-items'), 'baseline');
  assert.equal(declValue('.source-doc__row', 'min-height'), '0');
  assert.equal(declValue('.source-doc__row', 'padding'), 'calc(var(--space-1) + var(--space-half)) var(--space-2)');
  assert.equal(declValue('.source-doc__row', 'font-size'), 'var(--fs-sm)');
  assert.equal(declValue('.source-doc__row > span:first-child', 'text-overflow'), 'ellipsis');
  assert.equal(declValue('.source-doc__row > span:first-child', 'white-space'), 'nowrap');
  assert.deepEqual(
    declarations.filter((d) => d.ctx.some((c) => c.includes(':not(.sh-btn)'))),
    [],
    'no declaration uses a :not(.sh-btn) guard',
  );
  assert.deepEqual(
    blocks.filter((b) => b.prelude.includes(':not(.sh-btn)') || b.ctx.some((c) => c.includes(':not(.sh-btn)'))),
    [],
    'no block uses a :not(.sh-btn) guard',
  );
});
