import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { loadUi } from './helpers/ui-module.mjs';

/* 本节题目 of the reader (#1013, ui/document-preview/practice/section-practice.js): which questions of the section on screen the panel lists, in the order of
   the text, at most 30, and the line under its heading (错题 n · 追问 n · 批注 n), counted from what the reading loop already placed. Pure. */
const m = await loadUi(`export * from './ui/document-preview/practice/section-practice.js';
  export { SHOWN_MAX as WRONG_SHOWN_MAX } from './ui/document-preview/reader/WrongPanel.jsx';
  export { readingPracticeArgs, practiceArgs } from './ui/learning-navigation.js';`);

const card = (cardId, start = 0, extra = {}) => ({ deckId: 'd', cardId, level: 'new', links: [{ sourceId: 's', start, end: start + 5 }], ...extra });
const option = (kind, cards, ids = ['e1']) => ({ kind, ids: new Set(ids), cards, summary: { total: cards.length } });

test('the panel offers 本节 and 本章 from the loop, and shows 本节 unless it has no question', () => {
  const here = option('here', [card('a')]), chapter = option('chapter', [card('a'), card('b')]), recent = option('recent', [card('c')]), document = option('document', []);
  const ranges = m.sectionRanges([here, chapter, recent, document]);
  assert.deepEqual(ranges.map(item => item.kind), ['here', 'chapter'], 'only this section and this chapter: 刚读过 and 整份资料 stay in 做这几页的题');
  assert.equal(m.shownRange(ranges, null).kind, 'here');
  assert.equal(m.shownRange(ranges, 'chapter').kind, 'chapter', 'the one chosen');
  assert.equal(m.shownRange([option('here', []), chapter], null).kind, 'chapter', 'a section with no question shows its chapter');
  assert.equal(m.shownRange([option('here', [])], 'chapter').kind, 'here', 'a choice that is not offered falls back');
  assert.equal(m.shownRange([], null), null);
});

test('the questions are listed in the order of the text, at most 30, the same number as the reader 错题 panel', () => {
  assert.equal(m.SHOWN_MAX, 30);
  assert.equal(m.WRONG_SHOWN_MAX, m.SHOWN_MAX, 'one number for both panels');
  const order = new Map([['e1', 0], ['e2', 1]]);
  const entries = { 'd|late': 'e2', 'd|early': 'e1', 'd|second': 'e1', 'd|nowhere': null };
  const listed = m.questionsOf(option('here', [card('late', 0), card('nowhere', 0), card('second', 90), card('early', 10)]), { entryOf: key => entries[key], order });
  assert.deepEqual(listed.cards.map(item => item.cardId), ['early', 'second', 'late', 'nowhere'], 'by entry, then by place in it; a question with no place last');
  const many = Array.from({ length: 34 }, (_, at) => card(`c${at}`, at));
  const capped = m.questionsOf(option('chapter', many), { entryOf: () => 'e1', order });
  assert.equal(capped.shown.length, 30);
  assert.equal(capped.rest, 4);
  assert.equal(capped.cards.length, 34);
});

test('错题 · 追问 · 批注 count what the loop and the existing reads already hold, for the range shown', () => {
  const cards = [card('a'), card('b'), card('c')];
  const notes = new Map([['e1', new Map([['note|n1', {}], ['note|n2', {}]])], ['e9', new Map([['note|n3', {}]])]]);
  const followups = m.followupsOf([{ kind: 'card', question: 'why?' }, { kind: 'qa-card' }, { kind: 'card' }, { kind: 'passage' }]);
  assert.equal(followups.length, 2, 'a 追问 is a follow-up kept on a question, not a 问答卡 or a 批注');
  assert.deepEqual(m.sectionStats({ cards, wrongKeys: new Set(['d|b', 'd|z']), followups, ids: new Set(['e1']), noteAssigned: notes }),
    { wrong: 1, followups: 2, notes: 2 });
  assert.deepEqual(m.sectionStats({ cards }), { wrong: 0, followups: 0, notes: 0 }, 'nothing read yet counts nothing');
  assert.equal(m.rangeKey([card('b'), card('a')]), m.rangeKey([card('a'), card('b')]), 'the same questions are the same range, in any order');
});

test('the 批注 are placed like the questions: one per passage, its passage as its link', () => {
  const places = m.notePlaces([{ cardId: 'annotation:k1', selection: { sourceId: 's1', start: 4, end: 9, quote: 'words' } }, { cardId: 'annotation:k2', selection: {} }]);
  assert.equal(places.length, 1, 'a 批注 with no passage has no place');
  assert.deepEqual(places[0].links[0], { sourceId: 's1', start: 4, end: 9, selection: { sourceId: 's1', start: 4, end: 9, quote: 'words' } });
});

test('the reader starts its round with the very arguments of 做这几页的题: a path round of those questions that keeps where the learner was reading', () => {
  const refs = [{ deckId: 'd', cardId: 'a' }], reading = { documentId: 'doc', sectionId: 'e1', sectionOffset: 12 };
  assert.deepEqual(m.readingPracticeArgs(refs, reading, 'library'),
    { ...m.practiceArgs(refs), reading: { ...reading, origin: { page: 'library' } } });
  assert.equal(m.readingPracticeArgs(refs, reading, 'library').mode, 'path');
  assert.equal(m.readingPracticeArgs(refs, reading, 'library').fresh, true);
});

test('a question looks up its own parts inside its own .review-body: the reader round sits over the practice page (#1013)', async () => {
  const { readFile } = await import('node:fs/promises');
  const own = /document\.querySelector(All)?\(\s*['"`]\.(assist-|question-)/;
  for (const file of ['../ui/review/QuestionRun.jsx', '../ui/review/PracticeTip.jsx', '../ui/document-preview/practice/SectionPractice.jsx']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, own, `${file}: no page-wide lookup of a question's part`);
  }
  const tip = await readFile(new URL('../ui/review/PracticeTip.jsx', import.meta.url), 'utf8');
  assert.match(tip, /const scope = card\.closest\('\.review-body'\) \|\| document;/);
  assert.doesNotMatch(tip, /document\.querySelectorAll\(control\)/, 'the tip finds its control in its own question');
  const run = await readFile(new URL('../ui/review/QuestionRun.jsx', import.meta.url), 'utf8');
  assert.match(run, /onAskMore=\{\(event\) => \{ const body = event\?\.currentTarget\?\.closest\?\.\("\.review-body"\)/, '继续追问 opens the 追问 box of its own question');
});

test('the 批注 handed to the loop keep one identity while their places are the same, so a re-read of the annotations does not walk the text again (#1013)', () => {
  const link = (cardId, start) => ({ cardId, selection: { sourceId: 's', start, end: start + 4, quote: 'abcd' } });
  const first = m.notePlaces([link('n1', 0), link('n2', 10)]), again = m.notePlaces([link('n1', 0), link('n2', 10)]);
  assert.notEqual(first, again, 'a re-read builds new arrays');
  assert.equal(m.noteKey(first), m.noteKey(again), 'with the same places');
  assert.notEqual(m.noteKey(first), m.noteKey(m.notePlaces([link('n1', 0), link('n2', 12)])), 'a passage moved is a change');
  assert.notEqual(m.noteKey(first), m.noteKey(m.notePlaces([link('n1', 0)])), 'a note removed is a change');
  assert.equal(m.noteKey(m.notePlaces([])), '', 'no note: nothing to place');
  assert.equal(m.noteKey(m.notePlaces(null)), '');
});

test('做这几页的题 › 在这里做 says when it takes only the first 30 of the range (#1013)', async () => {
  assert.equal(m.hereLabelArgs(12), null, 'up to 30: plain 在这里做');
  assert.equal(m.hereLabelArgs(30), null);
  assert.deepEqual(m.hereLabelArgs(31), [30], 'more: 在这里做前 30 道');
  const { readFile } = await import('node:fs/promises');
  const en = JSON.parse(await readFile(new URL('../ui/locales/en.loop.json', import.meta.url), 'utf8'));
  assert.equal(en['在这里做前 {0} 道'], 'Answer the first {0} here');
});

test('#59 SectionPractice shows 只看未掌握 chip only when mastery is mixed and filters both listed and started cards', async () => {
  let hooks = [], cursor = 0, tree = null;
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: hLocal, memo: c => c,
    useId: () => 'id-1',
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo(fn, deps) { const i = cursor++, prev = hooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps[k])) hooks[i] = { val: fn(), deps }; return hooks[i].val; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useSyncExternalStore(_sub, snap) { return snap(); },
  };
  reactShim.default = reactShim;
  globalThis.__SECTION_PRACTICE_REACT__ = reactShim;
  try {
    const built = await build({
      stdin: { contents: `export { default as SectionPractice } from './ui/document-preview/practice/SectionPractice.jsx';`, resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-sp',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'sr' }));
          builder.onLoad({ filter: /.*/, namespace: 'sr' }, () => ({
            contents: `const R = globalThis.__SECTION_PRACTICE_REACT__; export default R; export const { Fragment, createElement, memo, useId, useState, useRef, useMemo, useEffect, useCallback, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'sc' }));
          builder.onLoad({ filter: /.*/, namespace: 'sc' }, () => ({
            contents: `
              const R = globalThis.__SECTION_PRACTICE_REACT__;
              export const Button = p => R.createElement('button', { ...p, 'data-comp': 'Button' });
              export const Chip = p => R.createElement('button', { ...p, 'data-comp': 'Chip', 'aria-pressed': p.selected });
              export const InlineMessage = p => R.createElement('div', p);
              export const LoadingState = p => R.createElement('div', p);
              export const SegmentedControl = () => R.createElement('div', null);`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /StudyInline\.jsx$/ }, () => ({ path: 'inline', namespace: 'si' }));
          builder.onLoad({ filter: /.*/, namespace: 'si' }, () => ({ contents: `const R = globalThis.__SECTION_PRACTICE_REACT__; export default p => R.createElement('span', null, p.text);`, loader: 'js' }));
          builder.onResolve({ filter: /BookQa\.jsx$/ }, () => ({ path: 'qa', namespace: 'sqa' }));
          builder.onLoad({ filter: /.*/, namespace: 'sqa' }, () => ({ contents: `const R = globalThis.__SECTION_PRACTICE_REACT__; export const QaList = () => R.createElement('div', null);`, loader: 'js' }));
          builder.onResolve({ filter: /study-context\.jsx$/ }, () => ({ path: 'ctx', namespace: 'sctx' }));
          builder.onLoad({ filter: /.*/, namespace: 'sctx' }, () => ({ contents: `export const useStudy = () => ({ call: async () => ({}), busy: false });`, loader: 'js' }));
          builder.onResolve({ filter: /shared\.js$/ }, () => ({ path: 'shared', namespace: 'ssh' }));
          builder.onLoad({ filter: /.*/, namespace: 'ssh' }, () => ({ contents: `export const useInjectCss = () => {};`, loader: 'js' }));
          builder.onResolve({ filter: /useSectionStats\.js$/ }, () => ({ path: 'stats', namespace: 'sst' }));
          builder.onLoad({ filter: /.*/, namespace: 'sst' }, () => ({ contents: `export const useSectionStats = () => ({ wrong: 0, followups: 0, notes: 0, items: [] });`, loader: 'js' }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { SectionPractice } = mod.exports;
    const expandNode = node => {
      if (Array.isArray(node)) return node.map(expandNode);
      if (!node || typeof node !== 'object') return node;
      if (typeof node.$$type === 'function') return expandNode(node.$$type(node.props));
      return node.props?.children ? { ...node, props: { ...node.props, children: expandNode(node.props.children) } } : node;
    };
    const findAll = (pred, node = tree, out = [], seen = new Set()) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return out;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(n => findAll(pred, n, out, seen)); return out; }
      if (pred(node)) out.push(node);
      if (node.props?.children) findAll(pred, node.props.children, out, seen);
      return out;
    };
    const textOf = node => (typeof node === 'string' || typeof node === 'number') ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node?.props?.children ? textOf(node.props.children) : '';

    const startedRefs = [];
    const makeProps = cards => ({
      loop: {
        status: 'ready',
        cards,
        options: [{ kind: 'here', ids: new Set(['e1']), cards, summary: { total: cards.length } }],
        entryOf: () => 'e1',
        noteAssigned: new Map(),
        start: () => ({ reading: { documentId: 'doc', sectionId: 'e1' } }),
      },
      outline: [{ id: 'e1' }],
      title: 'Section 1',
      inline: { start: (refs, _reading, then) => { startedRefs.push(refs); then({ id: 'r1', index: 0, navigation: [] }); return true; }, Run: () => null },
      version: 1,
      visible: true,
    });
    const renderSp = props => { cursor = 0; tree = expandNode(SectionPractice(props)); return tree; };

    // All unmastered -> no chip.
    renderSp(makeProps([card('a', 1, { level: 'new', prompt: 'Q1' }), card('b', 2, { level: 'weak', prompt: 'Q2' })]));
    assert.equal(findAll(n => n.props?.['data-comp'] === 'Chip').length, 0);

    // Mixed mastery (2 mastered/familiar, 2 weak/new) -> chip renders with count 2.
    hooks = [];
    const mixed = makeProps([
      card('m1', 1, { level: 'mastered', prompt: 'Mastered Q' }),
      card('f1', 2, { level: 'familiar', prompt: 'Familiar Q' }),
      card('w1', 3, { level: 'weak', prompt: 'Weak Q' }),
      card('n1', 4, { level: 'new', prompt: 'New Q' }),
    ]);
    renderSp(mixed);
    const chip = () => findAll(n => n.props?.['data-comp'] === 'Chip')[0];
    assert.equal(textOf(chip()), '只看未掌握 2');
    assert.equal(findAll(n => n.props?.className === 'section-practice__row').length, 4);

    // Toggle chip -> only unmastered cards listed & started.
    chip().props.onClick();
    renderSp(mixed);
    assert.deepEqual(findAll(n => n.props?.className === 'section-practice__row').map(n => n.props['data-section-card']), ['d|w1', 'd|n1']);
    const startBtn = findAll(n => n.props?.['data-usage'] === 'reader.section-practice')[0];
    assert.equal(textOf(startBtn), '在这里做这 2 道题');
    startBtn.props.onClick();
    assert.deepEqual(startedRefs[0].map(r => r.cardId), ['w1', 'n1']);

    const enFragment = JSON.parse(readFileSync(new URL('../ui/locales/en.polish-reader.json', import.meta.url), 'utf8'));
    assert.equal(enFragment['只看未掌握 {0}'], 'Not mastered ({0})');
  } finally {
    delete globalThis.__SECTION_PRACTICE_REACT__;
  }
});
