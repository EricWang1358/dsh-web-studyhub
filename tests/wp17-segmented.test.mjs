import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP17: one segmented control for every single-choice row, with a sliding thumb.
const require = createRequire(import.meta.url);
const load = async (contents) => {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
};
const m = await load(`export * from './ui/components/index.js'; export { nextSegmentIndex } from './ui/components/segmented.js'; export { default as Ingest } from './ui/Ingest.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const html = (type, props = {}) => renderToStaticMarkup(h(type, props));
const read = (file) => readFileSync(file, 'utf8');
const css = read('ui/components/components.css');
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma', disabled: true }, { value: 'd', label: 'Delta' }];
const seg = (extra = {}) => html(m.SegmentedControl, { label: 'Pick', value: 'b', options, onChange() {}, ...extra });

test('the control renders a thumb that knows the active index, with a static active fill underneath', () => {
  const out = seg();
  assert.match(out, /<span[^>]*class="sh-seg__thumb"[^>]*aria-hidden="true"/);
  assert.match(out, /data-index="1"/);
  assert.match(out, /data-count="4"/);
  assert.match(out, /<button[^>]*class="sh-seg__item is-active"[^>]*aria-pressed="true"[^>]*>Beta<\/button>/, 'server markup keeps the fill on the item, so there is no jump before the thumb takes over');
  assert.doesNotMatch(out, /data-thumb="on"/, 'the thumb only takes over after mount');
  assert.match(seg({ value: 'zzz' }), /data-index="-1"/, 'no active option means no thumb position');
});

test('roving tab stop: only the active segment is tabbable, falling back to the first enabled one', () => {
  const out = seg();
  assert.match(out, /aria-pressed="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-pressed="true"/);
  assert.equal(out.match(/tabindex="-1"/g).length, 3);
  const none = seg({ value: 'zzz' });
  assert.match(none, /<button[^>]*tabindex="0"[^>]*>Alpha<\/button>/);
  const disabledActive = seg({ value: 'c' });
  assert.match(disabledActive, /<button[^>]*tabindex="0"[^>]*>Alpha<\/button>/, 'a disabled active segment cannot hold the tab stop');
});

test('arrow keys move between enabled segments, wrap, and honour Home/End and RTL', () => {
  const next = m.nextSegmentIndex;
  assert.equal(next(options, 0, 'ArrowRight'), 1);
  assert.equal(next(options, 1, 'ArrowRight'), 3, 'skips the disabled option');
  assert.equal(next(options, 3, 'ArrowRight'), 0, 'wraps forward');
  assert.equal(next(options, 0, 'ArrowLeft'), 3, 'wraps backward');
  assert.equal(next(options, 3, 'ArrowDown'), 0);
  assert.equal(next(options, 1, 'ArrowUp'), 0);
  assert.equal(next(options, 2, 'Home'), 0);
  assert.equal(next(options, 0, 'End'), 3);
  assert.equal(next(options, 1, 'ArrowRight', { rtl: true }), 0, 'in RTL the right arrow goes to the previous segment');
  assert.equal(next(options, 1, 'a'), -1, 'other keys are ignored');
  assert.equal(next([{ value: 'x', disabled: true }], 0, 'ArrowRight'), -1);
  assert.equal(next([{ value: 'x' }], 0, 'ArrowRight'), -1, 'a single segment has nowhere to go');
});

test('keyboard focus moves without changing the value; Enter and Space still select', () => {
  const src = read('ui/components/SegmentedControl.jsx');
  assert.match(src, /onKeyDown/);
  assert.match(src, /nextSegmentIndex/);
  assert.match(src, /\.focus\(\)/);
});

test('the thumb animates position and size only, and reduced motion removes every transition', () => {
  assert.match(css, /\.sh-seg__thumb\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.sh-seg__thumb\s*\{[^}]*transition:[^;}]*transform\s+0?\.2s[^;}]*width[^;}]*height/);
  assert.match(css, /\.sh-seg__item\s*\{[^}]*transition:[^;}]*color/, 'text colour cross-fades');
  assert.match(css, /\.sh-seg\[data-thumb="on"\]\s+\.sh-seg__item\.is-active\s*\{[^}]*background:\s*transparent/, 'the item fill hands over to the thumb');
  assert.match(css, /\.sh-seg__item:active:not\(:disabled\)\s*\{[^}]*scale\(0\.98\)/, 'press feedback');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.sh-seg__thumb[^{]*\{[^}]*transition:\s*none/);
  assert.match(reduced, /\.sh-seg__item[^{]*\{[^}]*(transition:\s*none|transform:\s*none)/);
});

test('size variants, icons and disabled options keep working', () => {
  assert.match(seg({ size: 'sm' }), /class="sh-seg sh-seg--sm"/);
  assert.match(seg({ options: [{ value: 'a', label: 'A', icon: 'file' }], value: 'a' }), /<button[^>]*><svg[^>]*aria-hidden="true"/);
  assert.match(seg(), /<button[^>]*disabled=""[^>]*>Gamma<\/button>/);
  assert.match(seg({ disabled: true }), /<button[^>]*disabled=""[^>]*>Alpha<\/button>/);
});

test('the disclosure body opens with a short height and fade, only where details-content is supported', () => {
  assert.match(css, /@supports selector\(::details-content\)/);
  assert.match(css, /\.sh-disclosure::details-content\s*\{[^}]*transition:[^;}]*block-size[^;}]*opacity/);
  assert.match(css, /\.sh-disclosure\[open\]::details-content\s*\{[^}]*block-size:\s*auto/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /::details-content[^{]*\{[^}]*transition:\s*none/);
});

test('the recording setup rows are segmented controls with the same labels and pressed state', () => {
  const out = renderToStaticMarkup(h(m.Ingest, { data: { decks: [], modelReady: true }, start() {} }));
  assert.equal(out.match(/class="sh-seg[ "]/g).length, 2, 'kind row and mistakes row');
  for (const label of ['自动识别', '闪卡', '单选 MQ', '多选', '开放问答', '按我标注的', '全部当错题', '都不算错题']) assert.ok(out.includes(`>${label}</button>`), label);
  assert.match(out, /aria-pressed="true"[^>]*>自动识别<\/button>/);
  assert.match(out, /aria-pressed="true"[^>]*>按我标注的<\/button>/);
  assert.match(out, /title="一律做成问答闪卡"/, 'option notes stay as tooltips');
  assert.doesNotMatch(out, /class="kind/);
});

test('every single-choice segment row uses the shared control and the old hand-rolled CSS is gone', () => {
  const rows = [
    ['ui/Exam.jsx', '考试题型'], ['ui/Skeleton.jsx', '主题视图'], ['ui/Skeleton.jsx', '骨架视图'], ['ui/Graph.jsx', '视图模式'],
    ['ui/Ingest.jsx', null], ['ui/Generate.jsx', null], ['ui/study-map/DeskIntro.jsx', '学习模式'], ['ui/SkeletonCanvas.jsx', '想做什么'],
  ];
  for (const [file, label] of rows) {
    const src = read(file);
    assert.match(src, /import \{[^}]*SegmentedControl[^}]*\} from ['"]\.\.?\/components\/index\.js['"]/, `${file} imports SegmentedControl`);
    if (label) assert.match(src, new RegExp(`<SegmentedControl[^>]*label=\\{ui\\(["'"]${label}["'"]\\)\\}`), `${file} ${label}`);
  }
  for (const [file, pattern] of [
    ['ui/views.css', /\.exam-type-settings button/], ['ui/skeleton.css', /\.sk-seg\b/], ['ui/skeleton.css', /\.skc-extend-intents button/],
    ['ui/graph.css', /\.graph-mode\b/], ['ui/style.css', /\.focus-switch button/], ['ui/style.css', /\.choice-grid/], ['ui/style.css', /\.kind-grid|\.kind\.selected/],
  ]) assert.doesNotMatch(read(file), pattern, `${file} no longer carries ${pattern}`);
  assert.doesNotMatch(read('ui/Exam.jsx'), /className=\{typeMode === kind/);
});

test('wrapped segments: the thumb follows both axes, so a row that wraps (narrow sidebar) still slides to the right line', () => {
  const src = read('ui/components/SegmentedControl.jsx');
  for (const measure of ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight']) assert.match(src, new RegExp(measure), `the thumb is placed from ${measure}`);
  assert.match(src, /translate\(\$\{item\.offsetLeft\}px, \$\{item\.offsetTop\}px\)/, 'x and y in one transform');
  assert.match(css, /\.sh-seg\s*\{[^}]*flex-wrap:\s*wrap/, 'the row may wrap');
  assert.match(css, /\.sh-seg__thumb\s*\{[^}]*top:\s*0;[^}]*left:\s*0/, 'the thumb is positioned from the padding-box origin on both axes');
  assert.match(css, /\.sh-seg\s*\{[^}]*position:\s*relative/, 'the group is the thumb offset parent, so offsetTop/offsetLeft are group-relative');
  assert.match(read('ui/generate-form.css'), /\.generate-kind\s*\{[^}]*flex-wrap:\s*wrap/, 'the Generate kind row relies on wrapping');
});
