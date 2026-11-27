import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { openCourseBook } from '../lib/course-book-files.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { POINT_REASONS } from '../lib/evidence/point-report.js';
import { COURSE, pointLibrary } from './helpers/point-library.mjs';

/* 复习全书接入查缺 (UI): BookPointGaps (reusing PointGaps), TOC 缺题 lens + per-chapter/leaf indicators,
   BookGapHint per-point gap action, ZH + EN completeness, and token-only CSS for light/dark themes. */

const m = await loadUi(`
  export { default as BookPointGaps } from './ui/book/BookPointGaps.jsx';
  export { default as BookToc } from './ui/book/BookToc.jsx';
  export { default as BookGapHint } from './ui/book/BookGapHint.jsx';
  export { filterGapTocEntries, tocGapMeta } from './ui/book/book-gap-lens.js';
  export { startCoursePointTopUp } from './ui/book/use-book-actions.js';
  export { tocEntries } from './ui/book/model.js';
  export { createActRunner } from './ui/act-runner.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);

const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const text = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const inLanguage = (language, run) => { m.setUiLanguage(language); try { return run(); } finally { m.setUiLanguage('zh'); } };
const render = (element) => renderToStaticMarkup(withStudy(m.StudyServicesContext, element));

function sampleBook() {
  const { state, outline } = pointLibrary();
  const p1 = state.sources.find(s => s.id === 'doc-p1');
  state.sources.push({
    ...courseNotesMaterial({
      title: '复习全书 · C',
      course: COURSE,
      outlineId: outline.id,
      language: 'zh',
      papers: [],
      counts: {},
      leaves: [
        { id: 'pa', title: 'Point A', anchors: [], body: { fingerprint: 'a'.repeat(16), points: ['A.'], explain: 'A.', cites: [{ n: 1, sourceId: p1.id, quote: p1.text.slice(0, 20), start: 0, end: 20 }] } },
        { id: 'pb', title: 'Point B', anchors: [], body: { fingerprint: 'b'.repeat(16), points: ['B.'], explain: 'B.', cites: [{ n: 1, sourceId: p1.id, quote: p1.text.slice(0, 20), start: 0, end: 20 }] } },
        { id: 'pc', title: 'Point C', anchors: [], body: { fingerprint: 'c'.repeat(16), points: ['C.'], explain: 'C.', cites: [{ n: 1, sourceId: p1.id, quote: p1.text.slice(0, 20), start: 0, end: 20 }] } },
        { id: 'pd', title: 'Point D', anchors: [], body: { fingerprint: 'd'.repeat(16), points: ['D.'], explain: 'D.', cites: [{ n: 1, sourceId: p1.id, quote: p1.text.slice(0, 20), start: 0, end: 20 }] } },
      ],
    }),
    createdAt: '2026-11-01T01:00:00.000Z',
  });
  return openCourseBook(state, { course: COURSE });
}

const book = sampleBook();
const report = book.pointGaps;

test('BookPointGaps reuses PointGaps for course summary, clickable jumps, chapter breakdown, and per-chapter top-up (zh)', () => {
  const html = render(h(m.BookPointGaps, { course: COURSE, report, onTopUp: noop, onGo: noop, onOutline: noop, onOpenTask: noop }));
  const words = text(html);
  assert.match(words, /这本书共有 4 个知识点，2 个还没有题/);
  assert.match(words, /还没有题的知识点/);
  assert.match(words, /补这些知识点/);
  assert.match(words, /按章节查缺/);
  assert.match(words, /1 Chapter 1/);
  assert.match(words, /2\/2 有题/);
  assert.match(words, /2 Chapter 2/);
  assert.match(words, /0\/2 有题/);
  assert.match(words, /缺 2/);
  assert.match(words, /补本章（约 1 题）/);
  assert.match(html, /data-point-jump=/, 'uncovered points in PointGaps are clickable jump buttons');
  assert.match(html, /data-chapter-topup="ch2"/, 'chapter with coverable gap offers per-chapter top-up');
  assert.doesNotMatch(html, /data-chapter-topup="ch1"/, 'covered chapter has no top-up button');
});

test('BookPointGaps renders running state, all-covered state, and unavailable states cleanly', () => {
  const running = render(h(m.BookPointGaps, {
    course: COURSE,
    report,
    fillingJob: { id: 'job-1', status: 'running' },
    onTopUp: noop,
    onGo: noop,
    onOpenTask: noop,
  }));
  assert.match(text(running), /正在按知识点补题…/);
  assert.match(text(running), /看进度/);
  assert.match(running, /data-points-topup=""[^>]*disabled|disabled[^>]*data-points-topup/);

  const allCovered = render(h(m.BookPointGaps, {
    course: COURSE,
    report: { ...report, covered: 4, uncovered: 0, uncoverable: 0, list: [], topUp: null, chapters: report.chapters.map(c => ({ ...c, covered: c.points, uncovered: 0, topUp: null, missing: [] })) },
    onTopUp: noop,
    onGo: noop,
  }));
  assert.match(text(allCovered), /这本书共有 4 个知识点，都有题了/);
  assert.doesNotMatch(allCovered, /data-points-topup|data-chapter-topup/);

  for (const reason of POINT_REASONS.filter(r => !['no-outline', 'unreadable'].includes(r))) {
    const html = render(h(m.BookPointGaps, { course: COURSE, report: { status: 'unavailable', reason }, onOutline: noop }));
    assert.match(html, new RegExp(`data-book-point-gaps="${reason}"`));
    assert.match(text(html), /回到总纲/);
  }
  for (const reason of ['no-outline', 'unreadable']) {
    assert.equal(render(h(m.BookPointGaps, { course: COURSE, report: { status: 'unavailable', reason }, onOutline: noop })), '');
  }
});

test('BookToc exposes 缺题 lens, per-chapter coverage counts, and filters uncovered points with ancestors', () => {
  const entries = m.tocEntries(book);
  const filtered = m.filterGapTocEntries(entries, report);
  assert.equal(filtered.gapCount, 2);
  assert.deepEqual(filtered.entries.map(e => e.title), ['2 Chapter 2', '2.1 Point C', '2.2 Point D']);

  const meta = m.tocGapMeta(report);
  assert.equal(meta.get(book.nodes[0].hid).covered, 2);
  assert.equal(meta.get(book.nodes[1].hid).uncovered, 2);

  const tocAll = render(h(m.BookToc, { entries, here: book.nodes[0].children[0].hid, onGo: noop, coverage: null, pointGaps: report }));
  assert.match(text(tocAll), /缺题 \(2\)/);
  assert.match(tocAll, /class="book-toc__gap-count"[^>]*>2\/2</);
  assert.match(tocAll, /class="book-toc__gap-count"[^>]*data-has-gaps=""[^>]*>0\/2</);
  assert.match(tocAll, /data-gap-state="uncovered"/);

  const tocGaps = render(h(m.BookToc, { entries, here: book.nodes[1].children[0].hid, onGo: noop, coverage: null, pointGaps: report, lens: 'gaps' }));
  assert.match(text(tocGaps), /2\.1 Point C/);
  assert.match(text(tocGaps), /2\.2 Point D/);
  assert.doesNotMatch(text(tocGaps), /1\.1 Point A/, 'gaps lens hides covered points');
});

test('BookGapHint renders per-point gap status and fill action only when pointGapOf is supplied', () => {
  const pcNode = book.nodes[1].children[0];
  const pdNode = book.nodes[1].children[1];
  const paNode = book.nodes[0].children[0];

  assert.equal(render(h(m.BookGapHint, { node: pcNode, course: COURSE, handlers: {} })), '', 'no extra UI without pointGapOf');

  const uncovered = render(h(m.BookGapHint, {
    node: pcNode,
    course: COURSE,
    handlers: { pointGapOf: () => ({ id: 'pc', status: 'uncovered', coverable: true, quota: 1 }), fillPointGap: noop },
  }));
  assert.match(uncovered, /data-point-question-gap="uncovered"/);
  assert.match(uncovered, /data-point-fill-one="pc"/);
  assert.match(text(uncovered), /这个知识点还没有题.*补这个知识点/);

  const uncoverable = render(h(m.BookGapHint, {
    node: pdNode,
    course: COURSE,
    handlers: { pointGapOf: () => ({ id: 'pd', status: 'uncoverable', coverable: false }) },
  }));
  assert.match(uncoverable, /data-point-question-gap="uncoverable"/);
  assert.doesNotMatch(uncoverable, /data-point-fill-one/);

  const drafted = render(h(m.BookGapHint, {
    node: pcNode,
    course: COURSE,
    handlers: { pointGapOf: () => ({ id: 'pc', status: 'drafted', drafted: 1 }) },
  }));
  assert.match(drafted, /data-point-question-gap="drafted"/);
  assert.match(text(drafted), /已有草稿题待发布/);

  const covered = render(h(m.BookGapHint, {
    node: paNode,
    course: COURSE,
    handlers: { pointGapOf: () => ({ id: 'pa', status: 'covered', published: 1 }) },
  }));
  assert.equal(covered, '', 'covered point stays quiet');
});

test('startCoursePointTopUp calls generate with course + coverage.pointIds and reports success or refusal', async () => {
  const called = [], notices = [];
  const runner = (fail) => m.createActRunner(() => ({
    call: async (op, args) => {
      called.push({ op, args });
      if (fail) throw new Error('model quota exhausted');
      return { jobId: 'j1', coverage: { questions: 1 } };
    },
    refresh: async () => {},
    epoch: () => 0,
    setBusy: noop,
    setError: noop,
    holdMs: 0,
  }));
  await m.startCoursePointTopUp({ act: runner(false).act, course: COURSE, courseName: 'Algorithms', pointIds: ['pc'], notify: note => notices.push(note) });
  assert.deepEqual(called[0], { op: 'generate', args: { course: COURSE, title: 'Algorithms · 补知识点', coverage: { pointIds: ['pc'] } } });
  assert.equal(notices[0].tone, 'success');
  assert.match(notices[0].text, /Algorithms.*1 个知识点.*1 题.*新草稿/);

  await m.startCoursePointTopUp({ act: runner(true).act, course: COURSE, courseName: 'Algorithms', pointIds: ['pc'], notify: note => notices.push(note) });
  assert.equal(notices[1].tone, 'error');
  assert.match(notices[1].text, /quota/i);
});

test('every Review Book gap check word is translated into English (no untranslated Chinese)', () => inLanguage('en', () => {
  const panel = text(render(h(m.BookPointGaps, {
    course: COURSE,
    report: {
      ...report,
      chapters: report.chapters.map((ch, i) => (i === 1 ? { ...ch, drafted: 1, sections: [{ id: 's1', hid: 'h9', number: '2.1', title: 'Sec 2.1', points: 2, covered: 1, published: 0, drafted: 1, uncovered: 1, uncoverable: 0, topUp: { pointIds: ['pc'], questions: 1 } }] } : ch)),
    },
    fillingJob: { id: 'j1', status: 'running' },
    onTopUp: noop,
    onGo: noop,
    onOpenTask: noop,
  })));
  assert.equal(han.test(panel), false, `untranslated in BookPointGaps: ${panel.match(new RegExp(`.{0,30}${han.source}.{0,30}`))?.[0]}`);
  assert.match(panel, /This book has 4 knowledge points; 2 have no question yet/);
  assert.match(panel, /Gaps by chapter/);

  const toc = text(render(h(m.BookToc, { entries: m.tocEntries(book), here: book.nodes[0].children[0].hid, onGo: noop, coverage: null, pointGaps: report })));
  assert.equal(han.test(toc), false, `untranslated in BookToc: ${toc}`);
  assert.match(toc, /No questions \(2\)/);

  for (const gap of [
    { id: 'pc', status: 'uncovered', coverable: true, quota: 1 },
    { id: 'pd', status: 'uncoverable', coverable: false },
    { id: 'pc', status: 'drafted', drafted: 1 },
  ]) {
    const hint = text(render(h(m.BookGapHint, { node: book.nodes[1].children[0], course: COURSE, handlers: { pointGapOf: () => gap, fillPointGap: noop } })));
    assert.equal(han.test(hint), false, `untranslated in BookGapHint (${gap.status}): ${hint}`);
  }
}));

test('UI guardrails: BookPointGaps uses accessible Tooltip instead of raw title= across all branches and book-point-gaps.css uses design tokens only', async () => {
  const richReport = {
    ...report,
    chapters: report.chapters.map((ch, idx) => (idx === 1 ? {
      ...ch,
      drafted: 1,
      sections: [{ id: 's1', hid: 'h-sec-1', number: '2.1', title: 'Sec 2.1', points: 2, covered: 1, published: 0, drafted: 1, uncovered: 1, uncoverable: 0, topUp: { pointIds: ['pc'], questions: 1 } }],
      missing: [
        { id: 'pc', hid: 'h-pc', number: '2.1', title: 'Point C', dependents: 2, coverable: true },
        { id: 'pd', hid: null, number: '2.2', title: 'Point D', dependents: 0, coverable: false },
      ],
    } : ch)),
  };
  // modelReady: false omits the nested TokenEstimate icon button while rendering every branch of BookPointGaps and PointGaps.
  const quietHtml = render(h(m.BookPointGaps, { course: COURSE, report: { status: 'unavailable', reason: 'stale' }, onOutline: noop }));
  const fullHtml = render(h(m.BookPointGaps, {
    course: COURSE,
    report: richReport,
    modelReady: false,
    fillingJob: { id: 'job-1', status: 'running' },
    onOpenTask: noop,
    onTopUp: noop,
    onGo: noop,
  }));
  const plainHtml = render(h(m.BookPointGaps, {
    course: COURSE,
    report: richReport,
    modelReady: false,
    onTopUp: noop,
  }));

  for (const [label, rendered] of [['unavailable', quietHtml], ['full ok with onGo', fullHtml], ['full ok without onGo', plainHtml]]) {
    assert.ok(rendered.length > 0, `${label} renders non-empty HTML`);
    assert.doesNotMatch(rendered, /\btitle="/, `use Tooltip/HelpTip instead of raw title= (${label})`);
  }

  const missingList = fullHtml.match(/<ul\b[^>]*class="book-gaps__missing"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.ok(missingList, 'MissingLinks list is rendered for chapter missing points');
  const badgeTag = missingList.match(/<span\b[^>]*\bsh-badge\b[^>]*>前置<\/span>/)?.[0] ?? '';
  const tooltipId = badgeTag.match(/\baria-describedby="([^"]+)"/)?.[1];
  assert.ok(tooltipId, 'prerequisite badge in MissingLinks has aria-describedby wired to Tooltip');
  const escapedId = tooltipId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tooltipMatch = missingList.match(new RegExp(`<span\\b([^>]*\\bid="${escapedId}"[^>]*)>([^<]*)<\\/span>`));
  assert.ok(tooltipMatch, 'rendered Tooltip element matches prerequisite badge aria-describedby');
  assert.match(tooltipMatch[1], /\brole="tooltip"/);
  assert.match(tooltipMatch[1], /\bsh-tooltip\b/);
  assert.equal(tooltipMatch[2], '有 2 个知识点建立在它之上，先补它。');

  const css = await readFile(new URL('../ui/book/book-point-gaps.css', import.meta.url), 'utf8');
  assert.match(css, /@layer study\.features/);
  assert.match(css, /:where\(\.study-app, \.study-seat\)/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'token-only colors for light and dark themes');
});
