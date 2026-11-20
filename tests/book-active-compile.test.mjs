/* StudyHub 5.0.0 Next Batch 1 · Wave 2A (Evolution 2 Items #1 & #2):
   1. `lib/companion/book-active-compile.js`: 0-token `compileConfusablesToLesson` (4–6 slide `studyhub-lesson/1`
      dialectic lesson with `matrix` `predictBeforeReveal: true`, `quiz`, `hid` anchor, passing `validate.js` and
      offline 0-external-link HTML compile) + KaTeX/Markdown-safe `T01` `[slot]` parser/masker.
   2. `book.crunch.mark { kind: 'stuck' }` writeback raising `pitfalls` flip-order priority without touching FSRS.
   3. Expanded `settings.book.confusableDrill` across Look Over (`BookFlip`), Confusables (`BookConfusables`:
      names / difference / mistake modes + 「转为辩证对比实验」), and Exam Kit (`BookExamKit`: `[slot]` masking
      preserving `signals` & KaTeX). Bilingual en/zh parity, zero LLM calls, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { compileConfusablesToLesson, maskTemplateSlots, parseTemplateSlots } from '../lib/companion/book-active-compile.js';
import { validateLessonSpec } from '../lib/companion-template/validate.js';
import { compileLessonHtml } from '../lib/companion-template/render-html.js';
import { COURSE as BOOK_COURSE, service as bookService } from './helpers/crunch-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PAIR_1 = {
  id: 'C001',
  items: ['K001', 'K002'],
  names: ['Mutex', 'Semaphore'],
  hids: ['h2', 'h3'],
  rows: [
    { aspect: 'what', cells: ['Binary lock with strict owner release', 'Counter tracking available permits'] },
    { aspect: 'when', cells: ['Protecting a single critical section owned by one thread', 'Coordinating bounded buffer slots or signaling across threads'] },
    { aspect: 'difference', cells: ['Only the acquiring thread may unlock', 'Any thread may signal/post permits'] },
    { aspect: 'mistake', cells: ['Unlocking from a different thread', 'Using semaphore as an ownership lock without tracking count'] },
  ],
};

const PAIR_2 = {
  id: 'C002',
  items: ['K003', 'K004'],
  names: ['Paging', 'Segmentation'],
  hids: ['h5', 'h6'],
  rows: [
    { aspect: 'what', cells: ['Fixed-size page frames', 'Variable-size logical segments'] },
    { aspect: 'difference', cells: ['Eliminates external fragmentation', 'Matches logical program structure'] },
  ],
};

const PAIR_3 = {
  id: 'C003',
  items: ['K005', 'K006'],
  names: ['TCP', 'UDP'],
  hids: ['h8', 'h9'],
  rows: [{ aspect: 'mistake', cells: ['Assuming TCP preserves message boundaries', 'Assuming UDP guarantees ordering'] }],
};

const EXTERNAL_LINK_RE = /https?:\/\/(?!www\.w3\.org\/)|<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i;
const HAN_RE = /\p{Script=Han}/u;

/* ---------- 1. C001 -> 0-Token Dialectic Companion Compile ---------- */

test('compileConfusablesToLesson compiles 1..3 C001 pairs (including partial rows) into valid 4-6 slide dialectic lessons with 0 external links', () => {
  for (const [label, pairs, expectedSlides, language] of [
    ['single pair en', [PAIR_1], 4, 'en'],
    ['two pairs zh', [PAIR_1, PAIR_2], 5, 'zh'],
    ['three pairs (minimal row)', [PAIR_1, PAIR_2, PAIR_3], 6, 'en'],
    ['single minimal row pair', [PAIR_3], 4, 'en'],
  ]) {
    const lesson = compileConfusablesToLesson(pairs, { course: 'OS', hid: 'h2', language });
    assert.equal(lesson.format, 'studyhub-lesson/1', label);
    assert.equal(lesson.template, 'dialectic', label);
    assert.equal(lesson.hid, 'h2', label);
    assert.equal(lesson.slides.length, expectedSlides, `${label}: 4–6 slides`);
    const matrixBlocks = lesson.slides.flatMap(s => s.blocks).filter(b => b.t === 'matrix');
    assert.ok(matrixBlocks.length >= 1, `${label}: includes matrix block`);
    assert.ok(matrixBlocks.every(b => b.predictBeforeReveal === true), `${label}: matrix uses predictBeforeReveal: true`);
    const quizBlocks = lesson.slides.flatMap(s => s.blocks).filter(b => b.t === 'quiz');
    assert.ok(quizBlocks.length >= 1, `${label}: includes boundary discrimination quiz`);

    const validation = validateLessonSpec(lesson);
    assert.equal(validation.ok, true, `${label}: validateLessonSpec errors: ${validation.errors.join('; ')}`);

    const compiled = compileLessonHtml(lesson);
    assert.ok(compiled.html.length > 1000, `${label}: compiled HTML non-empty`);
    assert.doesNotMatch(compiled.html, EXTERNAL_LINK_RE, `${label}: 0 external links in offline HTML`);

    if (language === 'en') {
      assert.doesNotMatch(JSON.stringify(lesson), HAN_RE, `${label}: zero Chinese in English lesson`);
    }
  }
  assert.throws(() => compileConfusablesToLesson([]), /requires at least one valid confusable pair/);
});

test('companion.compile accepts { confusables } with 0 LLM calls and persists hid anchor onto course companion record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-c001-lab-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose?.());
  await study.call('course.save', { name: 'OS' });

  const res = await study.call('companion.compile', {
    confusables: [PAIR_1],
    course: 'OS',
    hid: 'h2',
    language: 'en',
    mountMode: 'companion-only',
  });
  assert.equal(res.attached, true);
  assert.ok(res.companion?.id);
  assert.equal(res.companion.hid, 'h2');
  assert.equal(res.companion.slideCount, 4);
  const state = await study.store.read();
  const osCourse = state.courses.find(c => c.name === 'OS');
  const saved = osCourse?.companions?.find(c => c.id === res.companion.id);
  assert.ok(saved, 'companion record persisted');
  assert.equal(saved.hid, 'h2');
});

/* ---------- 2. T01 [slot] KaTeX & Markdown Safety ---------- */

test('parseTemplateSlots and maskTemplateSlots hide [slot] items while preserving KaTeX formulas, Markdown syntax, and triggers', () => {
  const template = 'Given $A = [a_{ij}]$ and $\\mathbb{E}[X]$ in `arr[i]`, state **[Core Mechanism]** using \\[f(x) = [0, 1]\\] and [Key Trade-off]. See [Ref](https://example.com)[^1] and $$M = [1, 2]$$.';
  const parts = parseTemplateSlots(template);
  const slots = parts.filter(p => p.slot);
  assert.deepEqual(slots.map(s => s.text), ['[Core Mechanism]', '[Key Trade-off]']);
  assert.deepEqual(slots.map(s => s.label), ['Core Mechanism', 'Key Trade-off']);

  const masked = maskTemplateSlots(template);
  assert.equal(masked.slotCount, 2);
  assert.ok(masked.maskedText.includes('$A = [a_{ij}]$'), 'inline KaTeX brackets preserved');
  assert.ok(masked.maskedText.includes('$\\mathbb{E}[X]$'), 'inline KaTeX expectation brackets preserved');
  assert.ok(masked.maskedText.includes('`arr[i]`'), 'inline code brackets preserved');
  assert.ok(masked.maskedText.includes('\\[f(x) = [0, 1]\\]'), 'display KaTeX \\[...\\] preserved');
  assert.ok(masked.maskedText.includes('$$M = [1, 2]$$'), 'display KaTeX $$...$$ preserved');
  assert.ok(masked.maskedText.includes('[Ref](https://example.com)[^1]'), 'Markdown link and footnote preserved');
  assert.ok(masked.maskedText.includes('**___**'), 'bold Markdown wrapper around masked slot preserved');
  assert.doesNotMatch(masked.maskedText, /\[Core Mechanism\]|\[Key Trade-off\]/);

  const partial = maskTemplateSlots(template, { revealed: new Set([0]) });
  assert.ok(partial.maskedText.includes('**[Core Mechanism]**'));
  assert.doesNotMatch(partial.maskedText, /\[Key Trade-off\]/);
});

/* ---------- 3. book.crunch.mark kind:'stuck' writeback (no FSRS pollution) ---------- */

test('book.crunch.mark kind:stuck raises pitfalls priority in flip order without mutating FSRS card reviews or attempts', async t => {
  const { study } = await bookService(t);
  const beforeState = await study.store.read();
  const decksSnapshot = JSON.stringify(beforeState.decks);
  const attemptsSnapshot = JSON.stringify(beforeState.attempts);

  const beforeCrunch = await study.call('book.crunch', { course: BOOK_COURSE, date: '2026-10-10' });
  const target = beforeCrunch.points[beforeCrunch.points.length - 1];
  assert.ok(target?.id);
  const beforePitfalls = target.pitfalls;

  const marked = await study.call('book.crunch.mark', { course: BOOK_COURSE, hid: target.id, kind: 'stuck', on: true, date: '2026-10-10' });
  assert.equal(marked.write, 'marked');
  const afterPoint = marked.points.find(p => p.id === target.id);
  assert.equal(afterPoint.pitfalls, beforePitfalls + 1, 'stuck mark raises pitfalls by 1');
  assert.equal(afterPoint.stuck, '2026-10-10');
  assert.equal(marked.plan.order.flip[0], target.id, 'stuck point moves to top of flip order');

  const afterState = await study.store.read();
  assert.equal(JSON.stringify(afterState.decks), decksSnapshot, 'FSRS card review states untouched');
  assert.equal(JSON.stringify(afterState.attempts), attemptsSnapshot, 'attempts untouched');

  const cleared = await study.call('book.crunch.mark', { course: BOOK_COURSE, hid: target.id, kind: 'stuck', on: false, date: '2026-10-10' });
  assert.equal(cleared.write, 'cleared');
  assert.equal(cleared.points.find(p => p.id === target.id).pitfalls, beforePitfalls);
});

/* ---------- 4. UI Tests across BookConfusables, BookExamKit, and BookFlip ---------- */

const uiMod = await loadUi(`
  export { default as BookConfusables } from './ui/book/BookConfusables.jsx';
  export { default as BookExamKit } from './ui/book/BookExamKit.jsx';
  export { default as BookFlip } from './ui/book/BookFlip.jsx';
  export { templateParts } from './ui/book/exam-kit-model.js';
  export { maskConfusableCell } from './ui/book/confusable-drill.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const noop = () => {};
const stripTags = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (el, lang = 'zh') => {
  uiMod.setUiLanguage(lang);
  try { return renderToStaticMarkup(el); } finally { uiMod.setUiLanguage('zh'); }
};

test('BookConfusables exposes single secondary contrast-lab button, masks difference/mistake cells via helper, and stays bilingual', () => {
  assert.equal(uiMod.maskConfusableCell({ aspect: 'difference', cell: 'Only owner unlocks', names: ['Mutex', 'Semaphore'], mode: 'difference' }), '___');
  assert.equal(uiMod.maskConfusableCell({ aspect: 'what', cell: 'Binary lock', names: ['Mutex', 'Semaphore'], mode: 'difference' }), 'Binary lock');
  assert.equal(uiMod.maskConfusableCell({ aspect: 'mistake', cell: 'Wrong unlock', names: ['Mutex', 'Semaphore'], mode: 'mistake' }), '___');

  const zhHtml = render(h(uiMod.BookConfusables, { confusables: [PAIR_1], drill: true, onGo: noop, onCompileLab: noop, onMarkStuck: noop }), 'zh');
  assert.match(stripTags(zhHtml), /转为辩证对比实验/);
  assert.match(zhHtml, /data-confusable-lab="C001"/);
  assert.doesNotMatch(zhHtml, /\stitle="/);

  const enHtml = render(h(uiMod.BookConfusables, { confusables: [PAIR_1], drill: true, onGo: noop, onCompileLab: noop, onMarkStuck: noop }), 'en');
  assert.doesNotMatch(stripTags(enHtml), HAN_RE, 'zero Chinese in English BookConfusables');
  assert.match(stripTags(enHtml), /Turn into contrast lab/);
});

test('BookExamKit preserves KaTeX brackets in templateParts and shows self-check toggle only when drill=true', () => {
  const parts = uiMod.templateParts('Given $A = [a_{ij}]$ explain [Core Step] and [Trade-off].');
  assert.deepEqual(parts.filter(p => p.slot).map(p => p.text), ['[Core Step]', '[Trade-off]']);

  const book = {
    status: 'ok',
    examKit: {
      language: 'en',
      types: [{
        code: 'T01',
        name: 'Derivation',
        signals: ['prove convergence', 'bound'],
        asks: 'Apply invariant',
        template: 'Given $A = [a_{ij}]$, establish [Invariant] then conclude [Bound].',
        fills: [{ ref: 'PAST1 Q1', quote: 'Prove convergence.', fill: 'Invariant: monotone' }],
        anchors: ['PAST1 Q1'],
        hids: ['h2'],
      }],
    },
    nodes: [{ hid: 'h1', number: '1', title: 'Foundations', leaf: false, children: [{ hid: 'h2', number: '1.1', title: 'Convergence', leaf: true, children: [] }] }],
  };

  const offHtml = render(h(uiMod.BookExamKit, { book, drill: false, onGo: noop }), 'zh');
  assert.doesNotMatch(offHtml, /对照自测/, '0 extra controls when confusableDrill is off');

  const onZh = render(h(uiMod.BookExamKit, { book, drill: true, onGo: noop, onMarkStuck: noop }), 'zh');
  assert.match(stripTags(onZh), /对照自测/);
  assert.match(stripTags(onZh), /prove convergence · bound/);

  const onEn = render(h(uiMod.BookExamKit, { book, drill: true, onGo: noop, onMarkStuck: noop }), 'en');
  assert.doesNotMatch(stripTags(onEn), HAN_RE, 'zero Chinese in English BookExamKit');
  assert.match(stripTags(onEn), /Self-check/);
});

test('BookFlip folds takeaway and K001 term definitions behind active-recall veil when drill=true and hides nothing extra when drill=false', () => {
  const book = {
    status: 'ok',
    nodes: [{
      hid: 'h1',
      number: '1',
      title: 'Sync',
      leaf: false,
      children: [{
        hid: 'h2',
        key: 'bk:p1',
        number: '1.1',
        title: 'Mutex',
        leaf: true,
        gen: '**一句话** Mutex enforces strict single-thread ownership.\n\n**讲解** Full explanation body.',
        mine: '',
        qa: '',
        cards: [{ code: 'K001', name: 'Mutex', plain: 'Binary lock owned by one thread.' }],
        children: [],
      }],
    }],
    answerCards: [],
  };
  const crunch = {
    status: 'no-exam',
    plan: { order: { flip: ['h2'] }, today: null },
    points: [{ id: 'h2', pitfalls: 0, questions: 0, weakness: 0.6, seen: null }],
  };
  const handlers = { gone: new Set(), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop };

  const offHtml = render(h(uiMod.BookFlip, { book, crunch, course: 'OS', handlers, drill: false, onMark: noop, onGo: noop }), 'zh');
  assert.doesNotMatch(offHtml, /data-flip-masked|book-flip__recall/, '0 extra recall veil when confusableDrill is off');

  const onZh = render(h(uiMod.BookFlip, { book, crunch, course: 'OS', handlers, drill: true, onMark: noop, onMarkStuck: noop, onGo: noop }), 'zh');
  assert.match(onZh, /data-flip-masked=""/, 'takeaway and K001 definition are masked by default when drill=true');
  assert.doesNotMatch(stripTags(onZh), /enforces strict single-thread ownership|Binary lock owned by one thread/, 'takeaway & K001 definition hidden until revealed');
  assert.match(stripTags(onZh), /揭晓要点/);
  assert.match(stripTags(onZh), /卡住了/);

  const onEn = render(h(uiMod.BookFlip, { book, crunch, course: 'OS', handlers, drill: true, onMark: noop, onMarkStuck: noop, onGo: noop }), 'en');
  assert.doesNotMatch(stripTags(onEn), HAN_RE, 'zero Chinese in English BookFlip');
  assert.match(stripTags(onEn), /Reveal takeaway/);
  assert.match(stripTags(onEn), /Stuck/);
});

/* ---------- 5. Interactive Click-Flow Tests across all 3 Active Book Surfaces ---------- */

const liveBundle = await esbuild({
  stdin: {
    contents: `
      export { default as BookConfusables } from './ui/book/BookConfusables.jsx';
      export { default as BookExamKit } from './ui/book/BookExamKit.jsx';
      export { default as BookFlip } from './ui/book/BookFlip.jsx';
    `,
    resolveDir: REPO_ROOT,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@base-ui/*', 'markdown-it', 'markdown-it-texmath', 'dompurify', 'katex', 'katex/*'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

function createHookHarness() {
  const state = { cursor: 0, slots: [] };
  const mockReact = {
    ...React,
    useState: init => {
      const idx = state.cursor++;
      if (!(idx in state.slots)) state.slots[idx] = typeof init === 'function' ? init() : init;
      return [state.slots[idx], next => { state.slots[idx] = typeof next === 'function' ? next(state.slots[idx]) : next; }];
    },
    useMemo: (calc, deps) => {
      const idx = state.cursor++;
      const slot = state.slots[idx];
      if (!slot || !Array.isArray(deps) || !Array.isArray(slot.deps) || deps.length !== slot.deps.length || deps.some((v, i) => !Object.is(v, slot.deps[i]))) {
        state.slots[idx] = { deps, value: calc() };
      }
      return state.slots[idx].value;
    },
    useCallback: (cb, deps) => mockReact.useMemo(() => cb, deps),
    useRef: init => {
      const idx = state.cursor++;
      if (!(idx in state.slots)) state.slots[idx] = { current: init };
      return state.slots[idx];
    },
    useEffect: noop,
    useLayoutEffect: noop,
    useInsertionEffect: noop,
    useId: () => `id-${state.cursor++}`,
  };
  const mod = { exports: {} };
  const customRequire = id => (id === 'react' ? mockReact : require(id));
  new Function('require', 'module', 'exports', liveBundle.outputFiles[0].text)(customRequire, mod, mod.exports);
  return {
    render(fn) { state.cursor = 0; return fn(mod.exports); },
  };
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) collectNodes(child, pred, out); return out; }
  if (pred(node)) out.push(node);
  if (node.props?.children !== undefined) collectNodes(node.props.children, pred, out);
  return out;
}

function textOfTree(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfTree).join(' ');
  if (typeof node === 'object' && node.props?.children !== undefined) return textOfTree(node.props.children);
  return '';
}

test('Interactive active-mask flows: BookConfusables modes + lab compile, BookExamKit slot reveal + signals, BookFlip reveal + stuck writeback', async () => {
  // 1. BookConfusables: toggle self-check -> switch to difference & mistake -> mark stuck -> compile contrast lab
  const stuckCalls = [];
  const labCalls = [];
  const confHarness = createHookHarness();
  const confProps = {
    confusables: [PAIR_1],
    drill: true,
    onGo: noop,
    onMarkStuck: (hid, on) => stuckCalls.push(['conf', hid, on]),
    onCompileLab: async pair => { labCalls.push(pair.id); },
  };
  const renderComp = (comp, props) => (typeof comp === 'function' ? comp(props) : comp.type(props));
  let tree = confHarness.render(live => renderComp(live.BookConfusables, confProps));
  const toggleBtn = collectNodes(tree, n => n.props?.className === 'book-conf__toggle')[0];
  toggleBtn.props.onClick();
  tree = confHarness.render(live => renderComp(live.BookConfusables, confProps));
  const modeSeg = collectNodes(tree, n => n.props?.value === 'names' && typeof n.props?.onChange === 'function')[0];
  assert.ok(modeSeg, 'mask mode SegmentedControl mounts when quizOn');
  modeSeg.props.onChange('difference');
  tree = confHarness.render(live => renderComp(live.BookConfusables, confProps));
  const diffRow = collectNodes(tree, n => n.props?.['data-aspect'] === 'difference')[0];
  assert.equal(diffRow.props['data-aspect-masked'], '');
  assert.doesNotMatch(textOfTree(diffRow), /Only the acquiring thread/);
  assert.match(textOfTree(diffRow), /___/);
  const labBtn = collectNodes(tree, n => n.props?.['data-confusable-lab'] === 'C001')[0];
  assert.ok(labBtn, 'contrast-lab button visible when names are not masked');
  await labBtn.props.onClick();
  assert.deepEqual(labCalls, ['C001']);
  const confStuckBtn = collectNodes(tree, n => n.props?.['data-confusable-stuck'] === 'C001')[0];
  confStuckBtn.props.onClick();
  assert.deepEqual(stuckCalls, [['conf', 'h2', true]]);

  // 2. BookExamKit: toggle self-check -> [slot] masked & fills hidden & signals visible -> reveal slot 0 -> mark stuck
  const kitBook = {
    status: 'ok',
    examKit: {
      language: 'en',
      types: [{
        code: 'T01',
        name: 'Derivation',
        signals: ['prove convergence', 'bound'],
        asks: 'Apply invariant',
        template: 'Given $A = [a_{ij}]$, establish [Invariant] then conclude [Bound].',
        fills: [{ ref: 'PAST1 Q1', quote: 'Prove convergence.', fill: 'Invariant: monotone' }],
        anchors: ['PAST1 Q1'],
        hids: ['h2'],
      }],
    },
    nodes: [{ hid: 'h1', number: '1', title: 'Foundations', leaf: false, children: [{ hid: 'h2', number: '1.1', title: 'Convergence', leaf: true, children: [] }] }],
  };
  const kitHarness = createHookHarness();
  const kitProps = { book: kitBook, drill: true, onGo: noop, onMarkStuck: (hid, on) => stuckCalls.push(['kit', hid, on]) };
  let kitTree = kitHarness.render(live => live.BookExamKit.type(kitProps));
  const kitToggle = collectNodes(kitTree, n => n.props?.['aria-pressed'] === false && typeof n.props?.onClick === 'function')[0];
  kitToggle.props.onClick();
  kitTree = kitHarness.render(live => live.BookExamKit.type(kitProps));
  const kitCard = collectNodes(kitTree, n => typeof n.type === 'function' && n.props?.type?.code === 'T01')[0];
  const kitCardTree = kitCard.type(kitCard.props);
  const kitTplEl = collectNodes(kitCardTree, n => typeof n.type === 'function' && n.props?.text === kitBook.examKit.types[0].template)[0];
  const kitTplTree = kitTplEl.type(kitTplEl.props);
  const slotBtns = collectNodes(kitTplTree, n => n.props?.['data-slot-masked'] !== undefined);
  assert.equal(slotBtns.length, 2, 'both [slot] items masked while $A = [a_{ij}]$ stays intact');
  assert.match(textOfTree(kitCardTree), /prove convergence · bound/, 'signals stay visible during self-check');
  assert.doesNotMatch(textOfTree(kitCardTree), /PAST1 Q1/, 'fills folded while template is masked');
  slotBtns[0].props.onClick();
  kitTree = kitHarness.render(live => live.BookExamKit.type(kitProps));
  const kitCard2 = collectNodes(kitTree, n => typeof n.type === 'function' && n.props?.type?.code === 'T01')[0];
  const kitCardTree2 = kitCard2.type(kitCard2.props);
  const kitTplTree2 = collectNodes(kitCardTree2, n => typeof n.type === 'function' && n.props?.text === kitBook.examKit.types[0].template)[0];
  const kitTplRendered2 = kitTplTree2.type(kitTplTree2.props);
  assert.equal(collectNodes(kitTplRendered2, n => n.props?.['data-slot-masked'] !== undefined).length, 1, 'slot 0 revealed, slot 1 still masked');
  assert.match(textOfTree(kitTplRendered2), /\[Invariant\]/);
  const kitStuckBtn = collectNodes(kitCardTree2, n => n.props?.['data-kit-stuck'] === 'T01')[0];
  kitStuckBtn.props.onClick();

  // 3. BookFlip: masked initially -> click reveal -> takeaway & K001 definition visible -> mark stuck
  const flipBook = {
    status: 'ok',
    nodes: [{
      hid: 'h1', number: '1', title: 'Sync', leaf: false,
      children: [{
        hid: 'h2', key: 'bk:p1', number: '1.1', title: 'Mutex', leaf: true,
        gen: '**一句话** Mutex enforces strict single-thread ownership.\n\n**讲解** Full explanation body.',
        mine: '', qa: '', cards: [{ code: 'K001', name: 'Mutex', plain: 'Binary lock owned by one thread.' }], children: [],
      }],
    }],
    answerCards: [],
  };
  const flipCrunch = {
    status: 'no-exam',
    plan: { order: { flip: ['h2'] }, today: null },
    points: [{ id: 'h2', pitfalls: 0, questions: 0, weakness: 0.6, seen: null }],
  };
  const flipHandlers = { gone: new Set(), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop };
  const flipHarness = createHookHarness();
  const flipProps = {
    book: flipBook, crunch: flipCrunch, course: 'OS', handlers: flipHandlers, drill: true,
    onMark: noop, onMarkStuck: (hid, on) => stuckCalls.push(['flip', hid, on]), onGo: noop,
  };
  let flipTree = flipHarness.render(live => live.BookFlip(flipProps));
  assert.doesNotMatch(textOfTree(flipTree), /enforces strict single-thread ownership|Binary lock owned by one thread/);
  const revealBtn = collectNodes(flipTree, n => typeof n.props?.onClick === 'function' && /揭晓要点/.test(textOfTree(n.props.children)))[0];
  assert.ok(revealBtn);
  revealBtn.props.onClick();
  flipTree = flipHarness.render(live => live.BookFlip(flipProps));
  assert.match(textOfTree(flipTree), /enforces strict single-thread ownership/);
  assert.match(textOfTree(flipTree), /Binary lock owned by one thread/);
  const flipStuckBtn = collectNodes(flipTree, n => n.props?.['data-flip-stuck'] === 'h2')[0];
  flipStuckBtn.props.onClick();

  assert.deepEqual(stuckCalls, [
    ['conf', 'h2', true],
    ['kit', 'h2', true],
    ['flip', 'h2', true],
  ]);
});
