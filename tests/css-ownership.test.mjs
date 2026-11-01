import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { classOwners, readAllow, subjectClasses } from '../scripts/qa/css-ownership.mjs';
import { ROOT } from '../scripts/qa/css-tools.mjs';

// #151: a class is styled in one stylesheet. The allow-list is the debt that is left; it may only shrink.
const owners = classOwners();
const allow = readAllow();

test('a class that two stylesheets both write rules for is on the allow-list, with exactly those files', () => {
  const unlisted = Object.entries(owners).filter(([name]) => !allow[name]).map(([name, files]) => `.${name}: ${files.join(', ')}`);
  assert.deepEqual(unlisted, [], 'give the class one owning stylesheet (move or delete the second rule). The allow-list only shrinks: node scripts/qa/css-ownership.mjs --update');
  const widened = Object.entries(owners).filter(([name, files]) => allow[name] && files.some((file) => !allow[name].includes(file))).map(([name, files]) => `.${name}: ${files.join(', ')}`);
  assert.deepEqual(widened, [], 'a new stylesheet started to style an owned class');
});

test('the allow-list holds no entry that is already fixed', () => {
  const stale = Object.keys(allow).filter((name) => !owners[name]);
  assert.deepEqual(stale, [], 'delete these from tests/fixtures/css-ownership-allow.json (node scripts/qa/css-ownership.mjs --update)');
  const loose = Object.entries(allow).filter(([name, files]) => owners[name] && files.some((file) => !owners[name].includes(file))).map(([name]) => `.${name}`);
  assert.deepEqual(loose, [], 'an allowed file no longer styles the class: run --update to shrink the entry');
});

test('the subject of a selector is its last compound', () => {
  assert.deepEqual(subjectClasses('.a .b:hover'), ['b']);
  assert.deepEqual(subjectClasses('.a > .b.c'), ['b', 'c']);
  assert.deepEqual(subjectClasses('.a :is(.b, .c)'), ['b', 'c']);
  assert.deepEqual(subjectClasses('.a .b:not(.c)'), ['b'], ':not() names what the element is not');
  assert.deepEqual(subjectClasses('.a button'), []);
  assert.deepEqual(subjectClasses('.a [data-x=".z"] .y'), ['y']);
});

test('a class that is only ever written on top of another class is a modifier, not an owner', () => {
  const modifiers = new Set(['self', 'a', 'b']);
  assert.deepEqual(subjectClasses('.dash-line.self', modifiers), ['dash-line']);
  assert.deepEqual(subjectClasses('.x .self', modifiers), ['self'], 'on its own it is the subject');
  assert.deepEqual(subjectClasses('.a.b', modifiers), ['a', 'b'], 'two modifiers have nothing to be attributed to');
  const root = mkdtempSync(join(tmpdir(), 'css-own-'));
  mkdirSync(join(root, 'ui'));
  writeFileSync(join(root, 'ui/one.css'), '.dash-line.self { stroke: red; }\n.dash-line { stroke: blue; }\n.dim-row { opacity: 1; }\n');
  writeFileSync(join(root, 'ui/two.css'), '.dash-rate.self { background: red; }\n.dash-rate { gap: 1px; }\n.dim-row.self { opacity: .5; }\n.dim-row { color: red; }\n');
  assert.deepEqual(classOwners(root), { 'dim-row': ['ui/one.css', 'ui/two.css'] }, '.self is nobody\'s; .dim-row really is styled by both');
  rmSync(root, { recursive: true, force: true });
});

test('a state class written on another class is that class\'s own modifier, not a second owner', () => {
  assert.deepEqual(subjectClasses('.board-due.is-done'), ['board-due'], '.board-due.is-done styles .board-due');
  assert.deepEqual(subjectClasses('.a .b.has-rail:hover'), ['b']);
  assert.deepEqual(subjectClasses('.a :is(.b.is-open, .c)'), ['b', 'c']);
  assert.deepEqual(subjectClasses('.a .is-done'), ['is-done'], 'a bare state class is still a subject of its own');
  assert.deepEqual(subjectClasses('.is-a.is-b'), ['is-a', 'is-b'], 'only state classes: nothing to attribute them to');
  assert.deepEqual(subjectClasses('.sh-btn.sh-btn--primary'), ['sh-btn', 'sh-btn--primary'], 'BEM modifiers are classes with their own home');
});

test('OralExam injects review-results.css in the DSH host before any Review run has mounted', async () => {
  const realRequire = createRequire(import.meta.url);
  const compiled = await build({
    stdin: { contents: `export { default as OralExam } from './ui/OralExam.jsx'; export { default as ResultBreakdown } from './ui/ResultBreakdown.jsx';`, resolveDir: ROOT },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
  });
  const effects = [];
  const styles = [];
  const head = {
    querySelector: (sel) => { const m = /^style\[data-([\w-]+)\]$/.exec(sel); return m ? styles.find((el) => el.attrs.has(`data-${m[1]}`)) || null : null; },
    appendChild: (el) => { styles.push(el); return el; },
  };
  const hooks = {
    ...React,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (val) => ({ current: val }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useContext: () => ({ call: async () => null, act: async () => null, busy: false }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: (fn) => { effects.push(fn); },
    useId: () => 'oral-test',
  };
  hooks.default = hooks;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)((id) => id === 'react' ? hooks : realRequire(id), mod, mod.exports);
  const prevDoc = globalThis.document;
  globalThis.document = { head, createElement: () => ({ attrs: new Map(), textContent: '', setAttribute(k, v) { this.attrs.set(k, v); } }) };
  try {
    mod.exports.OralExam({ data: { root: 'r', decks: [] } });
    while (effects.length) effects.shift()();
    const oralCss = styles.map((el) => el.textContent).join('\n');
    assert.match(oralCss, /\.oral-report \.result-weak\s*\{/, 'OralExam must inject the sheet that owns .oral-report .result-weak');
    assert.match(oralCss, /\.oral-report \.result-details\s*\{/, 'OralExam must inject the sheet that owns .oral-report .result-details');
    assert.equal(styles.filter((el) => el.attrs.has('data-review-results')).length, 1, 'uses the review-results marker');
    mod.exports.ResultBreakdown({ total: 2, answered: 2, correct: 1 });
    while (effects.length) effects.shift()();
    assert.equal(styles.filter((el) => el.attrs.has('data-review-results')).length, 1, 'shares one <style data-review-results> element with ResultBreakdown');
  } finally {
    globalThis.document = prevDoc;
  }
});
