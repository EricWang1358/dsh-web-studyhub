/* 重读 N 段 (#1018): the reader's highlighter and bold marks come back in 今日 where the learner is weak. materials.marks.reread lists them across
   materials: marks of the current revision whose words are still there, not seen for 3 days (made or re-read), in a section (the chapter, else the
   page, else the material) with a due or weak question, the riskiest section first, at most 3 a day. materials.marks.seen records 已重读 on the mark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { capabilityIndex, filterCapabilities } from '../lib/runtime/tools.js';
import { markReread } from '../lib/contexts/library/mark-reread.js';
import { materialMasteryOf } from '../lib/material-mastery.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { groupRevision } from '../lib/document-outline.js';
import { textHash } from '../lib/passage-translation.js';

const DAY = 86400000, NOW = Date.now(), OLD = new Date(NOW - 5 * DAY).toISOString();
const PAGES = [
  'Page one explains the caretaker, which keeps the history of snapshots.',
  'Page two explains the originator, which makes and restores a snapshot.',
  'Page three explains the memento, the snapshot itself, opaque to others.',
  'Page four explains the bridge, which separates abstraction and implementation.',
];

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-marks-reread-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.call('snapshot');
  await service.store.update(state => {
    // A converted PDF of four pages in course SA, and one page of another course.
    PAGES.forEach((text, at) => state.sources.push({ id: `book-p${at + 1}`, title: `Patterns · p. ${at + 1}`, text, courses: ['SA'], createdAt: OLD,
      document: { materialId: 'document-patterns', page: at + 1, totalPages: 4, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Patterns.pdf', extractionVersion: 2 } }));
    state.sources.push({ id: 'other-p1', title: 'Other · p. 1', text: 'Another course explains caching and its expiry rules here.', courses: ['OS'], createdAt: OLD,
      document: { materialId: 'document-other', page: 1, totalPages: 1, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Other.pdf', extractionVersion: 2 } });
    const card = (id, sourceId) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: [{ sourceId, quote: state.sources.find(s => s.id === sourceId).text.slice(0, 30) }] });
    // Page 1: two weak questions; page 2: one weak; page 3: one question never answered (no risk); page 4: none. Other course: one weak.
    state.decks.push({ id: 'deck', title: 'Patterns', course: 'SA', cards: [card('a1', 'book-p1'), card('a2', 'book-p1'), card('b1', 'book-p2'), card('c1', 'book-p3')] });
    state.decks.push({ id: 'other', title: 'Other', course: 'OS', cards: [card('o1', 'other-p1')] });
    for (const [deckId, id] of [['deck', 'a1'], ['deck', 'a2'], ['deck', 'b1'], ['other', 'o1']]) state.attempts.push({ deckId, quiz_id: id, grade: 1, at: OLD });
  });
  const mark = async (sourceId, quote, style) => {
    const saved = await service.call('materials.marks.save', { sourceId, selection: { sourceId, quote }, style });
    assert.equal(saved.status, 'saved', `${quote} ${style}`);
    return saved;
  };
  /** Every mark made 5 days ago (a mark is "seen" when it is made). */
  const age = () => service.store.update(state => { for (const source of state.sources) for (const item of source.marks?.items || []) item.at = OLD; });
  const reread = (args = {}) => service.call('materials.marks.reread', { now: NOW, todayStart: NOW - 60000, ...args });
  return { service, mark, age, reread };
}

test('highlighter and bold marks in weak sections come back, the riskiest page first; underline, queue and safe pages do not', async t => {
  const { mark, age, reread } = await library(t);
  await mark('book-p2', 'originator, which makes', 'highlight');
  await mark('book-p1', 'keeps the history of snapshots', 'bold');
  await mark('book-p1', 'Page one explains', 'underline');
  await mark('book-p1', 'the caretaker', 'queue');
  await mark('book-p3', 'the snapshot itself', 'highlight');
  await mark('book-p4', 'separates abstraction', 'highlight');
  await age();
  const listed = await reread({ course: 'SA' });
  assert.deepEqual(listed.items.map(item => [item.selection.quote, item.style]),
    [['keeps the history of snapshots', 'bold'], ['originator, which makes', 'highlight']], 'page 1 (2 weak) before page 2 (1 weak); no risk, no line');
  const first = listed.items[0];
  assert.equal(first.selection.sourceId, 'book-p1');
  assert.equal(first.page, 1);
  assert.equal(first.title, 'Patterns.pdf');
  assert.deepEqual(first.risk, { due: 0, weak: 2 });
  assert.ok(first.documentId && first.revision && first.id, 'what the reader and materials.marks.seen need');
  assert.equal(first.selection.revision, first.revision, 'the passage names its revision, so the reader does not call it an older one');
  assert.equal(listed.count, 2);
});

test('a mark made or re-read in the last 3 days, a mark of another course and a mark of an older revision are not offered', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'keeps the history of snapshots', 'highlight');
  await mark('other-p1', 'caching and its expiry', 'highlight');
  assert.equal((await reread({ course: 'SA' })).count, 0, 'just made: the learner has just read it');
  await age();
  assert.equal((await reread({ course: 'SA' })).count, 1);
  assert.equal((await reread({ course: 'OS' })).items[0].selection.quote, 'caching and its expiry');
  assert.equal((await reread({})).count, 2, 'no course: every course');
  // The page's words change: a new revision of the material; what the old one kept is stale and never offered.
  await service.store.update(state => { state.sources.find(source => source.id === 'book-p1').text += ' Edited.'; });
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

test('at most 3 a day; 已重读 records the time on the mark, takes it off the list and counts toward the day', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'Page one explains the caretaker', 'highlight');
  await mark('book-p1', 'keeps the history of snapshots', 'bold');
  await mark('book-p2', 'Page two explains', 'highlight');
  await mark('book-p2', 'makes and restores a snapshot', 'bold');
  await age();
  const listed = await reread({ course: 'SA' });
  assert.equal(listed.items.length, 3, 'three a day');
  assert.equal(listed.total, 4, 'of four waiting');
  // The reader addresses the mark by its source: a material with no document record (this one) has no documentId the materials ops know.
  const target = { sourceId: listed.items[0].selection.sourceId, revision: listed.items[0].revision };
  const done = await service.call('materials.marks.seen', { ...target, id: listed.items[0].id });
  assert.equal(done.status, 'saved');
  assert.ok(Date.parse(done.item.rereadAt) >= NOW - 1000, 'the time is kept beside the mark');
  const after = await reread({ course: 'SA' });
  assert.equal(after.items.length, 2, 'two left today: three a day, one done');
  assert.ok(!after.items.some(item => item.id === listed.items[0].id), 'the re-read one waits 3 days');
  const kept = await service.call('materials.marks.list', target);
  assert.equal(kept.items.find(item => item.id === listed.items[0].id).rereadAt, done.item.rereadAt, 'the reader keeps it too');
  assert.equal((await service.call('materials.marks.seen', { ...target, id: 'gone' })).status, 'missing');
});

test('a library without marks answers at once with nothing', async t => {
  const { reread } = await library(t);
  assert.deepEqual(await reread({ course: 'SA' }), { items: [], count: 0, total: 0 });
});

test('an imported document keeps its marks on its version: listed with its document id, and 已重读 by that id', async t => {
  const { service, reread } = await library(t);
  const text = '# Tactics\n\nAvailability tactics detect faults and recover from them quickly.\n';
  const imported = await service.call('materials.document.import', { filename: 'tactics.md', courses: ['SA'], dataBase64: Buffer.from(text).toString('base64') });
  const document = await service.call('materials.document.get', { id: imported.documentId }), sourceId = document.sources[0].id;
  await service.store.update(state => {
    state.decks.push({ id: 'tactics', title: 'Tactics', course: 'SA', cards: [{ id: 't1', kind: 'flashcard', topic: 't', prompt: 'Q', answer: 'A', citations: [{ sourceId, quote: 'detect faults' }] }] });
    state.attempts.push({ deckId: 'tactics', quiz_id: 't1', grade: 1, at: OLD });
  });
  const id = { documentId: document.documentId, revision: document.revision };
  assert.equal((await service.call('materials.marks.save', { ...id, selection: { ...id, sourceId, quote: 'recover from them quickly' }, style: 'highlight' })).status, 'saved');
  await service.store.update(state => { for (const version of state.documents.flatMap(item => item.versions)) for (const item of version.marks?.items || []) item.at = OLD; });
  const listed = await reread({ course: 'SA' });
  assert.deepEqual(listed.items.map(item => [item.documentId, item.selection.quote]), [[document.documentId, 'recover from them quickly']]);
  assert.equal(listed.items[0].page, undefined, 'a text has no pages to name');
  assert.equal((await service.call('materials.marks.seen', { ...id, id: listed.items[0].id })).status, 'saved');
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

test('the reread list is the home page read: the main chat is refused it and sees it neither in the index nor in a context listing', () => {
  assert.match(assistantRefusal('materials.marks.reread') || '', /not available to the assistant/);
  assert.equal(assistantRefusal('materials.marks.seen'), null);
  const domain = { id: 'library', api: 'library.v1', operations: ['materials.marks.list', 'materials.marks.reread', 'materials.marks.seen'].map((name) => ({ name, available: true })) };
  assert.doesNotMatch(JSON.stringify(capabilityIndex([domain])), /marks\.reread/);
  const listed = JSON.stringify(filterCapabilities([domain], { context: 'library' }));
  assert.doesNotMatch(listed, /marks\.reread/);
  assert.match(listed, /marks\.seen/);
});

test('an archived material is not offered', async t => {
  const { service, mark, age, reread } = await library(t);
  await mark('book-p1', 'keeps the history of snapshots', 'highlight');
  await age();
  assert.equal((await reread({ course: 'SA' })).count, 1);
  await service.store.update(state => { for (const source of state.sources) if (source.id.startsWith('book-')) source.archived = true; });
  assert.equal((await reread({ course: 'SA' })).count, 0);
});

/* The host has one event loop: the list must not hold it. A made-up library of 10 books of 500 pages (frozen, as the store shares it), 4000 questions
   and 600 marks. The yardstick is measured in the same process (grouping the library once with its texts, what the 资料 page pays per revision), so a
   slow machine moves both. The very first answer must check every marked book's revision once (the hash of its pages, as materials does when
   the book opens), so it stays under one grouping; a repeated answer costs about nothing, and the answer after 已重读 (one page of one book changed,
   the rest shared and their revisions kept) well under half of one. */
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };
function bigLibrary() {
  const at = new Date(Date.now() - 6 * DAY).toISOString(), sources = [], decks = [], attempts = [];
  for (let book = 0; book < 10; book++) {
    for (let page = 1; page <= 500; page++) sources.push({ id: `b${book}-p${page}`, title: `Book ${book} · p. ${page}`, courses: ['SA'], createdAt: at,
      text: `Page ${page} of book ${book}. ${'Lorem ipsum dolor sit amet consectetur. '.repeat(40)}`,
      document: { materialId: `document-b${book}`, page, totalPages: 500, format: 'pdf', origin: 'converted', converter: 'marker', filename: `b${book}.pdf`, extractionVersion: 2 } });
    const cards = [];
    for (let n = 0; n < 400; n++) cards.push({ id: `c${book}-${n}`, kind: 'flashcard', topic: 't', prompt: `Q${n}`, answer: 'A', citations: [{ sourceId: `b${book}-p${1 + (n * 7) % 500}`, quote: `Page ${1 + (n * 7) % 500} of book ${book}.` }] });
    decks.push({ id: `deck${book}`, title: `Deck ${book}`, course: 'SA', cards });
    for (let n = 0; n < 400; n += 3) attempts.push({ deckId: `deck${book}`, quiz_id: `c${book}-${n}`, grade: 1, at });
  }
  const byId = new Map(sources.map(source => [source.id, source]));
  for (let book = 0; book < 10; book++) {
    const members = sources.filter(source => source.document.materialId === `document-b${book}`), items = [];
    for (let m = 0; m < 60; m++) {
      const sourceId = `b${book}-p${1 + (m * 13) % 500}`, quote = `Page ${1 + (m * 13) % 500} of book ${book}.`;
      items.push({ id: `${m % 2 ? 'bold' : 'highlight'}|${sourceId}:${m}`, key: `${sourceId}:${m}`, style: m % 2 ? 'bold' : 'highlight', sourceId, start: 0, end: quote.length, hash: textHash(byId.get(sourceId).text.slice(0, quote.length)), quote, at });
    }
    byId.get(`b${book}-p1`).marks = { revision: groupRevision(members), items };
  }
  return { revision: 1, sources, documents: [], decks, drafts: [], attempts, courses: [], settings: {} };
}
const timedCpu = fn => {
  const before = process.cpuUsage();
  const value = fn();
  const used = process.cpuUsage(before);
  return { value, ms: (used.user + used.system) / 1000 };
};

test('the list costs little on a large library: well under one grouping of it when new, about nothing when asked again', () => {
  const now = Date.now();
  // Warm the code first on a library of its own (another root, other objects), so the cold answer measures the work, not the JIT: run alone, the
  // test was slower than the yardstick 2 times in 8.
  { const warm = deepFreeze(bigLibrary()); materialMasteryOf(warm, { root: 'timing-warm', now }); markReread(warm, { course: 'SA', now }, { root: 'timing-warm' }); }
  // Measure CPU time (process.cpuUsage) instead of wall-clock performance.now() so OS preemption under parallel CI workers cannot inflate
  // sub-millisecond hits into false failures. Cold is measured on up to three fresh libraries, each against its own CPU yardstick, and the
  // best ratio counts: the stall this guards against was 18 times the yardstick on every try, and still fails all three.
  let state, root, yardstick, cold;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tryState = deepFreeze(bigLibrary()), tryRoot = `timing-guard-${attempt}`;
    const tryYardstick = Math.max(1, Math.min(...[0, 1].map(() => timedCpu(() => groupSourcesByDocument(tryState.sources)).ms)));
    materialMasteryOf(tryState, { root: tryRoot, now }); // the snapshot of the same revision pays this before the home asks
    const tryCold = timedCpu(() => markReread(tryState, { course: 'SA', now }, { root: tryRoot }));
    assert.equal(tryCold.value.count, 3);
    if (!cold || tryCold.ms / tryYardstick < cold.ms / yardstick) { state = tryState; root = tryRoot; yardstick = tryYardstick; cold = tryCold; }
    if (cold.ms < 2 * yardstick) break;
  }
  // Cache-hit check: median CPU ms across 15 consecutive hits filters out any single GC pause or OS timer tick, while a real cache miss fails every sample.
  const hitSamples = [];
  for (let i = 0; i < 15; i += 1) {
    const sample = timedCpu(() => markReread(state, { course: 'SA', now }, { root }));
    assert.equal(sample.value.count, 3);
    hitSamples.push(sample.ms);
  }
  hitSamples.sort((a, b) => a - b);
  const hit = { ms: hitSamples[7] };
  // 已重读 on one book: its first page (the holder) is a new object, every other page the same; the library's revision moves on.
  // Allow up to 2 distinct books so a single GC tick cannot flake while an O(all books) regression fails every try.
  let after;
  for (let bookIdx = 0; bookIdx < 2; bookIdx += 1) {
    const holder = state.sources.find(source => source.id === `b${bookIdx}-p1`);
    const marks = { ...holder.marks, items: holder.marks.items.map((item, at) => (at === 0 ? { ...item, rereadAt: new Date(now).toISOString() } : item)) };
    const next = deepFreeze({ ...state, revision: 2 + bookIdx, sources: state.sources.map(source => (source === holder ? { ...holder, marks } : source)) });
    materialMasteryOf(next, { root, now });
    const tryAfter = timedCpu(() => markReread(next, { course: 'SA', now }, { root }));
    assert.equal(tryAfter.value.count, 2, 'one re-read today: two more');
    if (!after || tryAfter.ms < after.ms) after = tryAfter;
    if (after.ms < yardstick / 2) break;
  }
  const report = `yardstick ${yardstick.toFixed(1)} ms CPU, new ${cold.ms.toFixed(1)} ms CPU, again median ${hit.ms.toFixed(2)} ms CPU, after 已重读 ${after.ms.toFixed(1)} ms CPU`;
  // Twice the yardstick: the cold answer is about one grouping (CI measured 42.5 against 42.4 ms), and the stall this guards against was 18 times it.
  assert.ok(cold.ms < 2 * yardstick, report);
  assert.ok(hit.ms < Math.max(2, yardstick / 50), report);
  assert.ok(after.ms < yardstick / 2, report);
});

test('#11, #15, #58, #60 useSourceReader & useReaderMarks: question-note append, duplicate queue guard, copy-cite, and reread.onPrev', async () => {
  let hooks = [], cursor = 0, pendingEffects = [];
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const toasts = [], calls = [];
  const toastApi = {
    show: item => toasts.push(['show', item]),
    success: msg => toasts.push(['success', msg]),
    info: msg => toasts.push(['info', msg]),
    warning: msg => toasts.push(['warning', msg]),
    error: msg => toasts.push(['error', msg]),
  };
  let appValue = null;
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: hLocal, memo: c => c,
    createContext: def => ({ Provider: p => p.children, _def: def }),
    useContext: () => appValue,
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo(fn, deps) { const i = cursor++, prev = hooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps[k])) hooks[i] = { val: fn(), deps }; return hooks[i].val; },
    useEffect(fn, deps) { const i = cursor++, prev = hooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) { hooks[i] = { deps }; pendingEffects.push(fn); } },
    useInsertionEffect() {},
    useCallback(fn) { return fn; },
    useSyncExternalStore(_sub, snap) { return snap(); },
  };
  reactShim.default = reactShim;
  globalThis.__MARKS_REREAD_REACT__ = reactShim;
  const prevWin = globalThis.window, prevNav = globalThis.navigator, prevDoc = globalThis.document;
  const copied = [];
  globalThis.window = {
    getSelection: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  if (!globalThis.document) globalThis.document = { querySelector: () => null, createElement: () => ({ style: {} }) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async text => { copied.push(text); } } } });
  try {
    const built = await build({
      stdin: {
        contents: `
          export { formatQuoteForNote } from './ui/review/question-note.js';
          export { useSourceReader } from './ui/app/modals/source-reader.jsx';
          export { useReaderMarks } from './ui/document-preview/marks/useReaderMarks.jsx';
          export { setUiLanguage } from './ui/i18n.js';`,
        resolveDir: process.cwd(),
      },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-mr',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'mrr' }));
          builder.onLoad({ filter: /.*/, namespace: 'mrr' }, () => ({
            contents: `const R = globalThis.__MARKS_REREAD_REACT__; export default R; export const { Fragment, createElement, memo, createContext, useContext, useState, useRef, useMemo, useEffect, useInsertionEffect, useCallback, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'mrc' }));
          builder.onLoad({ filter: /.*/, namespace: 'mrc' }, () => ({
            contents: `const R = globalThis.__MARKS_REREAD_REACT__; export const useToast = () => globalThis.__MARKS_REREAD_TOAST__; export const ContextMenu = p => R.createElement('div', { ...p, 'data-comp': 'ContextMenu' });`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /QueueChip\.jsx$/ }, () => ({ path: 'qchip', namespace: 'mrq' }));
          builder.onLoad({ filter: /.*/, namespace: 'mrq' }, () => ({
            contents: `const R = globalThis.__MARKS_REREAD_REACT__; export default p => R.createElement('div', { ...p, 'data-comp': 'QueueChip' });`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /app-context\.js$/ }, () => ({ path: 'appctx', namespace: 'mra' }));
          builder.onLoad({ filter: /.*/, namespace: 'mra' }, () => ({
            contents: `const R = globalThis.__MARKS_REREAD_REACT__; export const useApp = () => R.useContext(null);`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /DailyPlan\.jsx$|RenameTitle\.jsx$|ReaderRun\.jsx$|ReaderModelGate\.jsx$/ }, args => ({ path: args.path, namespace: 'mrstub' }));
          builder.onLoad({ filter: /.*/, namespace: 'mrstub' }, () => ({
            contents: `export const relatedTaskItems = () => []; export const ReaderHeading = () => null; export default () => null; export const ReaderModelContext = {};`,
            loader: 'js',
          }));
        },
      }],
    });
    globalThis.__MARKS_REREAD_TOAST__ = toastApi;
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { formatQuoteForNote, useSourceReader, useReaderMarks, setUiLanguage } = mod.exports;
    setUiLanguage('zh');

    // #11 formatQuoteForNote handles multi-line passages and slide labels.
    assert.equal(formatQuoteForNote({ quote: 'Line 1\nLine 2', title: 'Patterns', page: 2 }), '> Line 1\n> Line 2\n\n——《Patterns》第 2 页');
    assert.equal(formatQuoteForNote({ quote: 'Slide line', title: 'Deck', page: 5, slides: true }), '> Slide line\n\n——《Deck》第 5 张');
    assert.equal(formatQuoteForNote({ quote: '  ' }), '');

    // #11 & #60 useSourceReader
    let noteMarkdown = '# 已有内容', noteRevision = 3; const savedNotes = [], modalSets = []; let refreshed = 0;
    const s1 = { id: 'book-p1', title: 'Patterns · p. 1', text: 'Page one explains the caretaker.', document: { materialId: 'doc-1', title: 'Patterns', page: 1 } };
    const s2 = { id: 'book-p2', title: 'Patterns · p. 2', text: 'Page two explains the originator.', document: { materialId: 'doc-1', title: 'Patterns', page: 2 } };
    const call = async (name, params) => {
      calls.push([name, params]);
      if (name === 'note.create') return { id: 'note-q1' };
      if (name === 'note.get') return { id: 'note-q1', markdown: noteMarkdown, revision: noteRevision };
      if (name === 'note.save') { savedNotes.push(params); noteMarkdown = params.markdown; noteRevision += 1; return { id: params.id }; }
      if (name === 'materials.marks.list') return { items: [{ id: 'q1', key: 'book-p1|0|22', style: 'queue', status: 'resolved', selection: { sourceId: 'book-p1', start: 0, end: 22, quote: 'Page one explains the ' } }], limits: { queue: 40 } };
      return { status: 'saved' };
    };
    appValue = {
      data: { sources: [s1, s2], contexts: ['bank', 'study'], root: 'r' },
      host: {},
      core: { call, act: call, busy: false, refresh: () => { refreshed += 1; } },
      nav: { navigate: () => {} },
      learn: { openLearningTarget: () => {} },
      intents: { practiceFromReading: () => {} },
      drafts: {},
      dailyPlan: null,
      selectionNotices: { subscribe: () => () => {} },
      settingsEntry: { openSettings: () => {}, openModelSettings: () => {} },
      set: { setModal: m => modalSets.push(m) },
      session: { run: { deckId: 'd1', card: { id: 'c1', kind: 'quiz' }, complete: false, mode: 'path' } },
    };

    let readerRes = null;
    const ReaderHost = props => { readerRes = useSourceReader(props); return null; };
    const rereadItems = [
      { id: 'm1', revision: 'r1', selection: { sourceId: 'book-p1', quote: 'Page one explains' } },
      { id: 'm2', revision: 'r1', selection: { sourceId: 'book-p2', quote: 'Page two explains' } },
    ];
    cursor = 0; hooks = [];
    ReaderHost({ modal: { type: 'source', source: s2, reread: { items: rereadItems, index: 1 } }, onClose: () => {} });
    assert.equal(typeof readerRes.viewer.onAppendQuestionNote, 'function');
    assert.equal(typeof readerRes.viewer.reread.onPrev, 'function');

    // Test #60 reread.onPrev jumps back to index 0 (and at index 0 onPrev is absent).
    readerRes.viewer.reread.onPrev();
    assert.equal(modalSets[0].reread.index, 0);
    assert.equal(modalSets[0].source.id, 'book-p1');
    cursor = 0; hooks = [];
    ReaderHost({ modal: { type: 'source', source: s1, reread: { items: rereadItems, index: 0 } }, onClose: () => {} });
    assert.equal(readerRes.viewer.reread.onPrev, undefined);

    // Test #11 appending passage note creates/reuses question note, appends once, avoids duplicate save, shows toast.
    await readerRes.viewer.onAppendQuestionNote({ quote: 'Originator quote', title: 'Patterns', page: 2 });
    assert.equal(savedNotes.length, 1);
    assert.equal(savedNotes[0].markdown, '# 已有内容\n\n> Originator quote\n\n——《Patterns》第 2 页');
    assert.equal(refreshed, 1);
    assert.deepEqual(toasts.at(-1), ['success', '已记入本题笔记']);
    await readerRes.viewer.onAppendQuestionNote({ quote: 'Originator quote', title: 'Patterns', page: 2 });
    assert.equal(savedNotes.length, 1, 'identical formatted block is not appended twice');

    // Exam/completed/absent run disables question note.
    appValue.session = { run: { deckId: 'd1', card: { id: 'c1' }, complete: false, mode: 'exam' } };
    cursor = 0; hooks = [];
    ReaderHost({ modal: { type: 'source', source: s1 }, onClose: () => {} });
    assert.equal(readerRes.viewer.onAppendQuestionNote, undefined);

    // #15, #58, #11 useReaderMarks
    let marksRes = null;
    const noteCalls = [];
    const MarksHost = props => { marksRes = useReaderMarks(props); return null; };
    hooks = []; cursor = 0; pendingEffects = [];
    const doc = { documentId: 'doc-1', revision: 'r1', title: 'Patterns', sources: [{ id: 'book-p1', page: 1, text: 'Page one explains the caretaker.' }] };
    const bodyRef = { current: { ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) }, querySelectorAll: () => [] } };
    const marksProps = {
      call,
      document: doc,
      data: { settings: {} },
      body: bodyRef,
      rendered: 1,
      enabled: true,
      materialName: 'Patterns',
      slides: false,
      onAppendQuestionNote: item => noteCalls.push(item),
    };
    const renderMarks = () => { cursor = 0; pendingEffects = []; MarksHost(marksProps); const efs = pendingEffects.splice(0); efs.forEach(fn => fn()); };
    renderMarks();
    await new Promise(r => setTimeout(r, 10)); // resolve materials.marks.list
    renderMarks();
    assert.equal(marksRes.chip.props.open, false);

    // Simulate menu open state on marks[4] (`menu` useState) for duplicate queue guard, copy-cite, and question-note.
    hooks[3] = {
      point: { x: 10, y: 20 },
      capture: { sourceId: 'book-p1', start: 0, end: 17, quote: 'Page one explains' },
      here: [],
      selected: false,
    };
    renderMarks();

    // #15 duplicate queue guard: warns instead of calling materials.marks.save, opens QueueChip.
    const saveCallsBefore = calls.filter(([name]) => name === 'materials.marks.save').length;
    marksRes.menu.props.onSelect('mark:queue');
    await new Promise(r => setTimeout(r, 10));
    renderMarks();
    assert.equal(calls.filter(([name]) => name === 'materials.marks.save').length, saveCallsBefore);
    assert.equal(marksRes.chip.props.open, true);
    assert.deepEqual(toasts.at(-1), ['show', { tone: 'info', message: '这段已在「待出题」第 1 条里。' }]);

    // #58 copy-cite copies formatted citation and shows toast.
    marksRes.menu.props.onSelect('copy-cite');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(copied.at(-1), 'Page one explains\n\n——《Patterns》第 1 页');
    assert.deepEqual(toasts.at(-1), ['show', { tone: 'success', message: '已带出处复制' }]);

    // #11 question-note forwards enriched capture to onAppendQuestionNote.
    marksRes.menu.props.onSelect('question-note');
    assert.deepEqual(noteCalls[0], { sourceId: 'book-p1', start: 0, end: 17, quote: 'Page one explains', title: 'Patterns', page: 1, slides: false });
  } finally {
    delete globalThis.__MARKS_REREAD_REACT__;
    delete globalThis.__MARKS_REREAD_TOAST__;
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: prevNav });
  }
});
