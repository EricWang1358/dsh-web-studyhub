import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { globalCss } from './helpers/global-css.mjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapProps } from './helpers/study-map-props.mjs';

/* D3 (2.5.9, design consistency): the shared course-scope control looks the same on every page, and the home has one clear
   hierarchy (mode tabs above the title, title on its own line, one primary button). */
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { default as StudyMap } from './ui/StudyMap.jsx'; export { default as PageScope } from './ui/PageScope.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { StudyMap, PageScope, setUiLanguage } = mod.exports;
const h = React.createElement;
const css = name => readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
const han = /[㐀-鿿]/;

const courses = [{ name: 'CS3219' }, { name: 'CS3219 / Lecture 1' }, { name: 'OS' }];
const deck = { id: 'd1', title: 'Patterns', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, createdAt: '2026-09-01T00:00:00Z' };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active', topics: [] } };
function home(runs = []) {
  const data = { root: '/tmp/lib', decks: [deck], progress, sources: [{ id: 's' }], drafts: [], jobs: [], runs, today: { due: 1, weak: 2, new: 1, size: 4 },
    focus: { mode: 'class', course: 'CS3219', courses, fresh: [] } };
  const noop = () => {};
  return renderToStaticMarkup(h(StudyMap, mapProps({ data, busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop,
    retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: [], onFocus: noop })));
}

test('PageScope renders the same wrapper on every page, whatever the page passes', () => {
  setUiLanguage('zh');
  const variants = [
    { courses, value: '*' }, { courses, value: 'CS3219 / Lecture 1' }, { courses, value: '', unassigned: true },
    { courses, value: 'OS', unassigned: false, label: '范围' }, { courses: [], value: '*', disabled: true },
    { courses, value: '*', showInactive: false, onShowInactive() {} },
  ];
  for (const props of variants) {
    const html = renderToStaticMarkup(h(PageScope, { onChange() {}, ...props }));
    assert.ok(html.startsWith('<label class="page-scope">'), 'one wrapper class, no per-page modifier');
    assert.equal((html.match(/<select/g) || []).length, 1);
  }
});

test('the scope control has one fixed width in its own css, and no page css re-sizes it', () => {
  const own = css('course-active.css');
  const rule = /\.page-scope\s*\{([^}]*)\}/.exec(own)?.[1] ?? '';
  assert.match(rule, /(?:^|[;\s])width:\s*20rem/, 'one fixed width, also inside a shrink-to-fit header');
  assert.match(rule, /max-width:\s*100%/);
  assert.match(rule, /display:\s*grid/);
  assert.match(own, /\.page-scope\s+select\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(globalCss(), /\.page-scope\s*\{[^}]*max-width/, 'the old per-page 36rem cap is gone');
  for (const file of readdirSync(new URL('../ui', import.meta.url)).filter(name => name.endsWith('.css') && name !== 'course-active.css')) {
    for (const [, selector, body] of css(file).matchAll(/([^{}]*\.page-scope(?![-\w])[^{}]*)\{([^}]*)\}/g)) {
      const widths = [...body.matchAll(/(?:^|[;\s])(max-width|width|min-width)\s*:\s*([^;]+)/g)].map(match => [match[1], match[2].trim()]);
      for (const [property, value] of widths) {
        assert.ok(/^(100%|none)$/.test(value), `${file}: "${selector.trim()}" sets ${property}: ${value}`);
      }
    }
  }
});

test('the home has one h1, one primary button, and the mode tabs sit before the title', () => {
  setUiLanguage('zh');
  for (const html of [home(), home([{ id: 'r', mode: 'path', scope: [], index: 1, total: 4, title: 'Today' }])]) {
    assert.equal((html.match(/<h1/g) || []).length, 1);
    assert.equal((html.match(/class="sh-btn sh-btn--primary sh-btn--md today-go"/g) || []).length, 1);
    assert.ok(html.indexOf('focus-switch') < html.indexOf('<h1'), 'tabs come before the title in reading order');
  }
  setUiLanguage('en');
  try { assert.doesNotMatch(home().replace(/CS3219|Patterns|Memento/g, ''), han, 'no Han in the English home'); } finally { setUiLanguage('zh'); }
});

test('home css: tabs and title never share a line; the resume number and its caption share one baseline', () => {
  const tiers = `${css('home-tiers.css')}\n${css('study-map/desk.css')}`; // the tier rules of the desk classes moved into desk.css with their base rules (#151)
  assert.match(tiers, /\.focus-switch\s*\{[^}]*display:\s*flex/, 'the tabs take their own line');
  assert.match(tiers, /\.desk-intro\s*\{[^}]*flex-direction:\s*column/);
  assert.match(tiers, /\.today-count\s*\{[^}]*align-items:\s*baseline/);
  assert.match(tiers, /\.today-count strong\s*\{[^}]*line-height:\s*1\s*;/);
  // narrow: the flattened intro gets an explicit order for every part, so nothing lands above the title by default
  const narrow = tiers;
  for (const part of ['focus-switch', 'course-heading', 'course-parked-line', 'role-prep', 'today-stack', 'course-route', 'desk-mastery', 'desk-next', 'desk-also', 'desk-more', 'resume-list']) {
    assert.match(narrow, new RegExp(`\\.${part}\\b[^{]*\\{[^}]*order:\\s*\\d+`), `${part} has an explicit order`);
  }
});
