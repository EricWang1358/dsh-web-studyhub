import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { followupDigest } from '../lib/followup.js';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { openEnclosingDetails, resolveBookSearchTarget } from './ui/book/use-found-marks.js';
  export { showBlock, showWords } from './ui/book/ai-anchors.js';
  export { showCard } from './ui/book/term-card-go.js';
  export { keepBook, keptBook } from './ui/book/model.js';
  export { filterOutline, keepView, keptView, outlineViewKey, emptyPick } from './ui/outline/model.js';
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as BlogNotes, isSplitNoteViewport, resolveNoteEditLayout } from './ui/BlogNotes.jsx';
  export { default as FlagDialog } from './ui/app/modals/FlagDialog.jsx';
  export { questionNoteTitle, questionNoteCourse, qaToNoteArgs } from './ui/review/question-note.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;
const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

const withServices = (element) => h(
  m.StudyServicesContext.Provider,
  { value: { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop } },
  element,
);

const stripStyleAndTags = html => html
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

test('BookPage search target resolution finds paragraphIndex, prefers matching range inside target paragraph, and opens enclosing folds', () => {
  const p0 = { tag: 'p', contains: () => false };
  const p1 = { tag: 'p', contains: () => false };
  const targetSpan = {};
  const detailsInner = { open: false, parentElement: null };
  const detailsOuter = { open: false, parentElement: null };
  detailsInner.parentElement = { closest: sel => (sel === 'details' ? detailsOuter : null) };
  detailsOuter.parentElement = { closest: () => null };
  const p2 = {
    tag: 'p',
    contains: node => node === targetSpan,
    closest: sel => (sel === 'details' ? detailsInner : null),
  };
  const root = {
    contains: node => node === detailsInner || node === detailsOuter || node === p2,
    querySelectorAll: () => [p0, p1, p2],
  };

  // Pure paragraphIndex jump with no text ranges
  const byIndex = m.resolveBookSearchTarget(root, { hid: 'h2', paragraphIndex: 2 }, []);
  assert.equal(byIndex.block, p2);
  assert.equal(byIndex.activeIndex, 0);

  // Multiple ranges across paragraphs: selects the range inside paragraphIndex=2
  const ranges = [
    { startContainer: { nodeType: 3, parentElement: { closest: () => p0 } } },
    { startContainer: targetSpan },
  ];
  const disambiguated = m.resolveBookSearchTarget(root, { hid: 'h2', paragraphIndex: 2, query: 'entropy' }, ranges);
  assert.equal(disambiguated.block, p2);
  assert.equal(disambiguated.activeIndex, 1);

  assert.equal(m.openEnclosingDetails(root, p2), true);
  assert.equal(detailsInner.open, true);
  assert.equal(detailsOuter.open, true);

  // keepBook carries one-shot search navigation fields to BookPage
  const storage = makeMemoryStorage();
  m.keepBook('/lib/a', 'Physics', { target: 'h2', paragraphIndex: 2, query: 'entropy', snippet: 'entropy increases' }, storage);
  const kept = m.keptBook('/lib/a', 'Physics', storage);
  assert.equal(kept.target, 'h2');
  assert.equal(kept.paragraphIndex, 2);
  assert.equal(kept.query, 'entropy');
  assert.equal(kept.snippet, 'entropy increases');
});

test('CourseOutline persists chapter fold state per root+course in localStorage and filters collapsed points via sticky bar', () => {
  const storage = makeMemoryStorage();
  assert.equal(m.outlineViewKey('/ws/1', 'CS3210'), 'study-outline-view:/ws/1:CS3210');

  m.keepView('/ws/1', 'CS3210', { open: new Set(['bk:c1', 'bk:s2']), deckId: 'deck-gpu', bookId: 'b1' }, storage);
  m.keepView('/ws/1', 'MA2001', { open: new Set(['bk:m1']), deckId: '' }, storage);

  assert.deepEqual(m.keptView('/ws/1', 'CS3210', storage), {
    open: ['bk:c1', 'bk:s2'],
    deckId: 'deck-gpu',
    bookId: 'b1',
  });
  assert.deepEqual(m.keptView('/ws/1', 'MA2001', storage), {
    open: ['bk:m1'],
    deckId: '',
  });
  assert.equal(m.keptView('/ws/2', 'CS3210', storage), null);

  const summary = { total: 2, counts: { new: 2, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 2, inactive: 0, percent: 0, state: 'unlearned' };
  const aiOutline = {
    status: 'ok',
    course: 'CS3210',
    total: 2,
    placed: 2,
    summary,
    draftCards: 0,
    limit: 200,
    decks: [{ id: 'd1', title: 'CUDA Deck', total: 1 }, { id: 'd2', title: 'MPI Deck', total: 1 }],
    documents: [],
    unplaced: { key: 'unplaced', total: 0, summary, reasons: {}, materials: [] },
    book: {
      id: 'b1',
      title: 'Parallel Computing',
      papers: 0,
      stale: false,
      orderBasis: { codes: ['logic'] },
      nodes: [
        {
          key: 'bk:c1',
          id: 'c1',
          title: 'Memory Hierarchy',
          total: 1,
          summary,
          deckCount: 1,
          depth: 1,
          children: [{ key: 'bk:p1', id: 'p1', title: 'Warp Divergence', total: 1, summary, deckCount: 1, depth: 2, opensRows: false }],
        },
        {
          key: 'bk:c2',
          id: 'c2',
          title: 'Message Passing',
          total: 1,
          summary,
          deckCount: 1,
          depth: 1,
          children: [{ key: 'bk:p2', id: 'p2', title: 'Collective AllReduce', total: 1, summary, deckCount: 1, depth: 2, opensRows: false }],
        },
      ],
    },
  };

  // Both chapters start collapsed in `savedOpen`; filtering 'AllReduce' reveals bk:c2 -> bk:p2 without mutating savedOpen
  const savedOpen = new Set();
  const filtered = m.filterOutline(aiOutline, {}, savedOpen, 'allreduce');
  assert.equal(filtered.filtering, true);
  assert.deepEqual(filtered.rows.map(r => r.key), ['bk:c2', 'bk:p2']);
  assert.equal(savedOpen.size, 0, 'persisted open set is never mutated by temporary search filter');

  const actions = {
    onBack: noop, onCreate: noop, onOpenSources: noop, retry: noop, toggle: noop,
    onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop,
    chooseDeck: noop, onFilterChange: noop,
  };
  const zhHtml = renderToStaticMarkup(withServices(h(m.CourseOutlineView, {
    course: 'CS3210',
    outline: aiOutline,
    details: {},
    open: savedOpen,
    filterQuery: 'allreduce',
    pick: m.emptyPick(),
    actions,
  })));
  assert.match(zhHtml, /class="outline-filter-bar"/);
  assert.match(zhHtml, /Collective AllReduce/);
  assert.doesNotMatch(zhHtml, /Warp Divergence/);

  m.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(withServices(h(m.CourseOutlineView, {
      course: 'CS3210',
      outline: aiOutline,
      details: {},
      open: savedOpen,
      filterQuery: 'nonexistent-topic',
      pick: m.emptyPick(),
      actions,
    })));
    const text = stripStyleAndTags(enHtml);
    assert.doesNotMatch(text, han);
    assert.match(text, /No matching chapters or questions\./);
    assert.match(text, /Clear filters/);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('BlogNotes supports >= 1100px split edit + live Markdown/KaTeX preview, narrow fallback, and single focus ring', () => {
  assert.equal(m.isSplitNoteViewport(1099), false);
  assert.equal(m.isSplitNoteViewport(1100), true);
  assert.equal(m.isSplitNoteViewport(1101), true);
  assert.equal(m.isSplitNoteViewport(0), false);
  assert.equal(m.isSplitNoteViewport(NaN), false);
  assert.equal(m.resolveNoteEditLayout('split', true), 'split');
  assert.equal(m.resolveNoteEditLayout('split', false), 'edit');
  assert.equal(m.resolveNoteEditLayout('preview', false), 'preview');
  assert.equal(m.resolveNoteEditLayout('unknown', true), 'edit');

  const note = {
    id: 'n-split',
    title: 'Spectral Theorem Synthesis',
    markdown: '# Eigenvalues\n\nInline formula: $E = mc^2$.',
    status: 'draft',
    cards: [{ cardId: 'c1', prompt: 'State spectral theorem' }],
  };
  const baseData = {
    root: 'lib-notes',
    model: { ready: true, reason: 'ok', label: '' },
    focus: { course: '*', courses: [] },
    notes: [{ ...note, cardCount: 1 }],
    decks: [],
    sources: [],
    settings: {},
  };

  const splitHtml = renderToStaticMarkup(withServices(h(m.BlogNotes, {
    data: baseData,
    initialId: note.id,
    initialNote: note,
    initialEditing: true,
    initialEditLayout: 'split',
    wideViewport: true,
  })));
  assert.match(splitHtml, /class="note-editor note-editor-split"/);
  assert.match(splitHtml, /双栏对照/);
  assert.match(splitHtml, /实时预览/);
  assert.match(splitHtml, /class="katex"/, 'live preview renders KaTeX formulas alongside Markdown editor');

  // Narrow viewport (< 1100px): hides 双栏对照 and falls back cleanly to single-column edit
  const narrowHtml = renderToStaticMarkup(withServices(h(m.BlogNotes, {
    data: baseData,
    initialId: note.id,
    initialNote: note,
    initialEditing: true,
    initialEditLayout: 'split',
    wideViewport: false,
  })));
  assert.match(narrowHtml, /class="note-editor note-editor-single"/);
  assert.doesNotMatch(narrowHtml, /双栏对照/);

  m.setUiLanguage('en');
  try {
    const enSplit = renderToStaticMarkup(withServices(h(m.BlogNotes, {
      data: baseData,
      initialId: note.id,
      initialNote: note,
      initialEditing: true,
      initialEditLayout: 'split',
      wideViewport: true,
    })));
    const enText = stripStyleAndTags(enSplit);
    assert.doesNotMatch(enText, han);
    assert.match(enText, /Split view/);
    assert.match(enText, /Live preview/);
  } finally {
    m.setUiLanguage('zh');
  }

  const { declarations: blogDecls } = parseCss(readFileSync(new URL('../ui/blog-notes.css', import.meta.url), 'utf8'));
  assert.ok(blogDecls.length > 0, 'blog-notes.css declares styles');
  const focusDecls = blogDecls.filter((d) => splitSelectors(d.ctx.at(-1) || '').includes('.note-edit-pane:has(.cm-editor.cm-focused)'));
  assert.ok(focusDecls.length > 0, 'blog-notes.css defines .note-edit-pane:has(.cm-editor.cm-focused)');
  assert.equal(focusDecls.some((d) => d.prop === 'box-shadow' && d.value === 'none'), true);
  assert.equal(focusDecls.some((d) => d.prop === 'outline' && d.value === '2px solid var(--accent)'), true);
  assert.equal(focusDecls.some((d) => d.prop === 'box-shadow' && /var\(--ring\)/.test(d.value)), false);
});

test('1 Day + 1 Course = 1 Note Article: quick-saves append into one daily course note while separating other courses, days, and 挑题成文 articles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-daily-course-note-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  await service.store.update(state => {
    const q1 = { id: 'j1', prompt: 'synchronized 锁升级顺序是什么？', answer: '无锁 -> 偏向锁 -> 轻量级锁 -> 重量级锁', explanation: '按竞争程度逐步升级。' };
    q1.followups = [{ id: 'jf1', digest: followupDigest(q1), question: '轻量级锁何时膨胀？', answer: 'CAS 自旋失败或竞争加剧时。' }];
    const q2 = { id: 'j2', prompt: 'volatile 能保证原子性吗？', answer: '不能，仅保证可见性与有序性', explanation: '复合自增仍需原子类或锁。' };
    const q3 = { id: 'j3', prompt: 'ThreadLocal 为什么可能内存泄漏？', answer: 'Entry 弱引用 key 回收后 value 仍被强引用', explanation: '用完需调用 remove()。' };
    q3.followups = [{ id: 'jf3', digest: followupDigest(q3), question: '线程池场景为什么要必须 remove？', answer: '工作线程复用会让 value 长期驻留。' }];
    state.decks.push(
      { id: 'java-deck', title: 'Java 并发', course: 'Java 八股', cards: [q1, q2, q3] },
      { id: 'net-deck', title: 'TCP 协议', course: '计算机网络', cards: [{ id: 'n1', prompt: '三次握手为什么不能是两次？', answer: '防止历史失效连接初始化请求造成资源浪费' }] },
    );
  });

  // UI title helper produces course-qualified ISO-day titles in both zh and en (zero Han in en)
  const zhTitle = m.questionNoteTitle('Java 八股');
  assert.match(zhTitle, /^\d{4}-\d{2}-\d{2} · Java 八股 · 学习笔记$/);
  m.setUiLanguage('en');
  try {
    const enTitle = m.questionNoteTitle('Algorithms');
    assert.match(enTitle, /^\d{4}-\d{2}-\d{2} · Algorithms · Study notes$/);
    assert.doesNotMatch(enTitle, han);
  } finally {
    m.setUiLanguage('zh');
  }

  // Save 1 (写笔记 on j1), Save 2 (写笔记 on j2), Save 3 (存进笔记 Q&A on j3) on the same course & day -> 1 single note!
  const first = await service.call('note.create', { title: '学习笔记 · 2026/11/17', cards: [{ deckId: 'java-deck', cardId: 'j1' }], reuse: true, prefill: true, language: 'zh' });
  assert.equal(first.title, '2026-11-17 · Java 八股 · 学习笔记');
  const second = await service.call('note.create', { title: '2026-11-17 · Java 八股 · 学习笔记', cards: [{ deckId: 'java-deck', cardId: 'j2' }], reuse: true, prefill: true, language: 'zh' });
  assert.equal(second.id, first.id, 'second question on same course & day appends into the same note');
  const third = await service.call('note.qa.add', { deckId: 'java-deck', cardId: 'j3', followupId: 'jf3', title: '2026-11-17 · Java 八股 · 学习笔记', language: 'zh' });
  assert.equal(third.status, 'added');
  assert.equal(third.note.id, first.id, '存进笔记 on third question of same course & day appends into the same note');
  assert.deepEqual(third.note.cards.map(c => c.cardId), ['j1', 'j2', 'j3']);

  // Re-clicking 写笔记 on j2 does not duplicate j2's block
  const reopenJ2 = await service.call('note.create', { title: '2026-11-17 · Java 八股 · 学习笔记', cards: [{ deckId: 'java-deck', cardId: 'j2' }], reuse: true, prefill: true, language: 'zh' });
  assert.equal(reopenJ2.id, first.id);
  assert.equal(reopenJ2.reused, true);

  const fullJavaNote = await service.call('note.get', { id: first.id });
  assert.equal(fullJavaNote.markdown.split('synchronized 锁升级顺序是什么？').length, 2);
  assert.equal(fullJavaNote.markdown.split('volatile 能保证原子性吗？').length, 2);
  assert.equal(fullJavaNote.markdown.split('ThreadLocal 为什么可能内存泄漏？').length, 2);
  assert.match(fullJavaNote.markdown, /\n\n---\n\n/, 'appended question blocks are separated cleanly by horizontal rule');
  assert.deepEqual(fullJavaNote.followupIds, ['jf1', 'jf3']);

  // Different course on same day -> separate note
  const otherCourse = await service.call('note.create', { title: '2026-11-17 · 计算机网络 · 学习笔记', cards: [{ deckId: 'net-deck', cardId: 'n1' }], reuse: true, prefill: true, language: 'zh' });
  assert.notEqual(otherCourse.id, first.id);

  // Different day on same course -> separate note
  const nextDay = await service.call('note.create', { title: '2026-11-18 · Java 八股 · 学习笔记', cards: [{ deckId: 'java-deck', cardId: 'j2' }], day: '2026-11-18', prefill: true, language: 'zh' });
  assert.notEqual(nextDay.id, first.id);

  // 挑题成文 custom-title article -> separate note
  const customArticle = await service.call('note.create', { title: 'Java 并发专题长文', cards: [{ deckId: 'java-deck', cardId: 'j1' }, { deckId: 'java-deck', cardId: 'j2' }] });
  assert.notEqual(customArticle.id, first.id);

  // Snapshot noteBadges marks qa: true on all 3 cards of the coalesced daily course note
  const snap = await service.call('snapshot');
  for (const cid of ['j1', 'j2', 'j3']) {
    const qaBadge = snap.noteBadges[cid].find(b => b.qa);
    assert.ok(qaBadge, `card ${cid} has an active qa target badge`);
    assert.equal(qaBadge.noteId, first.id);
  }
  assert.deepEqual(snap.noteBadges.j1.find(b => b.qa).followupIds, ['jf1']);
  assert.deepEqual(snap.noteBadges.j3.find(b => b.qa).followupIds, ['jf3']);
});

test('non-destructively coalesces fragmented legacy 学习笔记 · YYYY/MM/DD drafts per (day, course) while preserving all user text and daily recaps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-coalesce-notes-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  await service.store.update(state => {
    const cards17 = Array.from({ length: 6 }, (_, idx) => ({
      id: `q17_${idx + 1}`,
      prompt: `11月17日第 ${idx + 1} 题`,
      answer: `答案 ${idx + 1}`,
    }));
    const cards13 = [
      { id: 'q13_1', prompt: '11月13日第 1 题', answer: 'A1' },
      { id: 'q13_2', prompt: '11月13日第 2 题', answer: 'A2' },
    ];
    state.decks.push({ id: 'java-deck', title: 'Java 八股', course: 'Java 八股', cards: [...cards17, ...cards13] });

    // Seed 6 fragmented 学习笔记 · 2026/11/17 notes, 2 fragmented 学习笔记 · 2026/11/13 notes, and 1 每日学习总结
    state.notes.push({
      id: 'recap-17',
      kind: 'daily-recap',
      title: '2026-11-17 · Java 八股 · 每日学习总结',
      status: 'draft',
      markdown: '# 2026-11-17 · Java 八股 · 每日学习总结\n\n总结正文保持不动。',
      cards: [{ deckId: 'java-deck', cardId: 'q17_1' }],
      revision: 1,
      createdAt: '2026-11-17T08:00:00.000Z',
      updatedAt: '2026-11-17T08:00:00.000Z',
      daily: { day: '2026-11-17', courseId: 'course-java', course: 'Java 八股', timeZone: 'Asia/Shanghai' },
    });
    for (let i = 0; i < 6; i++) {
      state.notes.push({
        id: `frag-17-${i + 1}`,
        title: '学习笔记 · 2026/11/17',
        status: 'draft',
        origin: 'question',
        cards: [{ deckId: 'java-deck', cardId: `q17_${i + 1}` }],
        markdown: `# 学习笔记 · 2026/11/17\n\n## 核心概念\n\n用户手写笔记片段 #${i + 1}：重点记录 ${i + 1}。\n`,
        revision: 0,
        createdAt: `2026-11-17T0${i + 1}:00:00.000Z`,
        updatedAt: `2026-11-17T0${i + 1}:00:00.000Z`,
      });
    }
    for (let i = 0; i < 2; i++) {
      state.notes.push({
        id: `frag-13-${i + 1}`,
        title: '学习笔记 · 2026/11/13',
        status: 'draft',
        origin: 'question',
        cards: [{ deckId: 'java-deck', cardId: `q13_${i + 1}` }],
        markdown: `# 学习笔记 · 2026/11/13\n\n## 核心概念\n\n11月13日手写记录 #${i + 1}。\n`,
        revision: 0,
        createdAt: `2026-11-13T0${i + 1}:00:00.000Z`,
        updatedAt: `2026-11-13T0${i + 1}:00:00.000Z`,
      });
    }
  });

  // Immediate snapshot (before any note.* mutation) already projects coalesced notes cleanly
  const snap = await service.call('snapshot');
  assert.equal(snap.notes.length, 3, '6 fragments (11/17) + 2 fragments (11/13) + 1 daily recap -> 3 clean rows');
  const row17 = snap.notes.find(n => n.id === 'frag-17-1');
  const row13 = snap.notes.find(n => n.id === 'frag-13-1');
  const rowRecap = snap.notes.find(n => n.id === 'recap-17');
  assert.equal(row17.title, '2026-11-17 · Java 八股 · 学习笔记');
  assert.equal(row17.cardCount, 6);
  assert.equal(row13.title, '2026-11-13 · Java 八股 · 学习笔记');
  assert.equal(row13.cardCount, 2);
  assert.equal(rowRecap.title, '2026-11-17 · Java 八股 · 每日学习总结');

  // note.list & note.get durably persist coalescing with zero lost user text
  const listed = await service.call('note.list');
  assert.equal(listed.notes.length, 3);
  const merged17 = await service.call('note.get', { id: 'frag-17-1' });
  assert.deepEqual(merged17.cards.map(c => c.cardId), ['q17_1', 'q17_2', 'q17_3', 'q17_4', 'q17_5', 'q17_6']);
  for (let i = 1; i <= 6; i++) {
    assert.match(merged17.markdown, new RegExp(`用户手写笔记片段 #${i}：重点记录 ${i}。`), `fragment #${i} text preserved`);
  }
  const merged13 = await service.call('note.get', { id: 'frag-13-1' });
  assert.deepEqual(merged13.cards.map(c => c.cardId), ['q13_1', 'q13_2']);
  assert.match(merged13.markdown, /11月13日手写记录 #1。[\s\S]*---\n\n[\s\S]*11月13日手写记录 #2。/);
});

test('FlagDialog uses shared Field + TextArea (.sh-input), and CSS enforces tabular-nums and 390px grid collapse', () => {
  const flagHtml = renderToStaticMarkup(withServices(h(m.FlagDialog, { run: { deckId: 'd1', card: { id: 'c1' } }, onClose: noop })));
  assert.match(flagHtml, /class="[^"]*\bsh-field\b[^"]*"/);
  assert.match(flagHtml, /<textarea[^>]*class="[^"]*\bsh-input\b[^"]*"/);

  const tabularChecks = [
    ['ui/shell.css', '.nav-count'],
    ['ui/home-tiers.css', '.today-count'],
    ['ui/case-study.css', '.case-paper__clock'],
    ['ui/exam.css', '.exam-countdown'],
    ['ui/audio-dashboard.css', '.audio-dashboard-metrics .audio-token-count'],
    ['ui/book/book-plan.css', '.book-plan__countdown'],
  ];
  for (const [file, selector] of tabularChecks) {
    const { declarations } = parseCss(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.ok(declarations.length > 0, `${file} declares styles`);
    assert.equal(
      declarations.some((d) =>
        !d.ctx.some((c) => c.startsWith('@media') || c.startsWith('@container'))
        && splitSelectors(d.ctx.at(-1) || '').includes(selector)
        && d.prop === 'font-variant-numeric'
        && d.value === 'tabular-nums',
      ),
      true,
      `${file} sets font-variant-numeric: tabular-nums on ${selector}`,
    );
  }
  const { declarations: skeletonDecls } = parseCss(readFileSync(new URL('../ui/skeleton.css', import.meta.url), 'utf8'));
  assert.ok(skeletonDecls.length > 0, 'ui/skeleton.css declares styles');
  assert.equal(
    skeletonDecls.some((d) =>
      !d.ctx.some((c) => c.startsWith('@media') || c.startsWith('@container'))
      && splitSelectors(d.ctx.at(-1) || '').includes('.sk-layout')
      && d.prop === 'grid-template-columns'
      && /minmax\(min\(260px,\s*100%\),\s*380px\)/.test(d.value),
    ),
    true,
    'ui/skeleton.css .sk-layout clamps first column for narrow viewports',
  );
  const { declarations: deskDecls } = parseCss(readFileSync(new URL('../ui/study-map/desk.css', import.meta.url), 'utf8'));
  assert.ok(deskDecls.length > 0, 'ui/study-map/desk.css declares styles');
  assert.equal(
    deskDecls.some((d) =>
      !d.ctx.some((c) => c.startsWith('@media') || c.startsWith('@container'))
      && splitSelectors(d.ctx.at(-1) || '').includes('.desk')
      && d.prop === 'grid-template-columns'
      && /minmax\(min\(270px,\s*100%\),\s*340px\)/.test(d.value),
    ),
    true,
    'ui/study-map/desk.css .desk clamps card column for narrow viewports',
  );
  assert.equal(
    deskDecls.some((d) =>
      d.ctx.some((c) => /@container\s+study\s*\(max-width:\s*760px\)|@media\s*\(max-width:\s*760px\)/.test(c))
      && splitSelectors(d.ctx.at(-1) || '').includes('.desk > .today-stack')
      && d.prop === 'width'
      && d.value === 'auto',
    ),
    true,
    'ui/study-map/desk.css resets .desk > .today-stack width: auto in narrow layout',
  );
});

test('BookPage AI/term jumps (showBlock, showWords, showCard) and CSS scroll-margin-top clear sticky .topbar + .book-bar', () => {
  const { declarations: bookDecls } = parseCss(readFileSync(new URL('../ui/book/book.css', import.meta.url), 'utf8'));
  const { declarations: aiDecls } = parseCss(readFileSync(new URL('../ui/book/book-ai.css', import.meta.url), 'utf8'));
  assert.ok(bookDecls.length > 0, 'book.css declares styles');
  assert.ok(aiDecls.length > 0, 'book-ai.css declares styles');
  assert.equal(
    bookDecls.some((d) =>
      splitSelectors(d.ctx.at(-1) || '').includes('.book-page')
      && d.prop === '--book-scroll-top'
      && d.value.replace(/\s+/g, ' ') === 'calc(var(--book-bar-top, 0px) + var(--book-bar-h, 44px) + var(--space-5))',
    ),
    true,
    '.book-page defines --book-scroll-top clearing sticky .topbar + .book-bar',
  );
  for (const selector of ['.book-step', '.book-step__heading', '.book-chapter__heading', '.book-node__heading', '.book-card', '.book-point [data-book-search-hit]']) {
    assert.equal(
      bookDecls.some((d) =>
        splitSelectors(d.ctx.at(-1) || '').includes(selector)
        && d.prop === 'scroll-margin-top'
        && d.value === 'var(--book-scroll-top)',
      ),
      true,
      `book.css ${selector} uses scroll-margin-top: var(--book-scroll-top)`,
    );
  }
  for (const selector of ['.book-ai', '.book-ai-anchor']) {
    assert.equal(
      aiDecls.some((d) =>
        splitSelectors(d.ctx.at(-1) || '').includes(selector)
        && d.prop === 'scroll-margin-top'
        && /^var\(--book-scroll-top(?:\s*,|\))/.test(d.value),
      ),
      true,
      `book-ai.css ${selector} uses scroll-margin-top: var(--book-scroll-top, ...)`,
    );
  }

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCss = globalThis.CSS;
  try {
    let scrollNow = 0;
    const scrolled = [];
    const topbar = {
      parentElement: { getBoundingClientRect: () => ({ top: -scrollNow, bottom: 4000 - scrollNow }) },
      getBoundingClientRect: () => ({ top: 0, bottom: 51, height: 51 }),
    };
    const bar = {
      closest: sel => (sel.includes('.study-app') ? scroller : null),
      getBoundingClientRect: () => {
        const top = Math.max(51, 180 - scrollNow);
        return { top, bottom: top + 46, height: 46 };
      },
    };
    const page = {
      style: { getPropertyValue: () => '51px', setProperty: () => {} },
      closest: sel => (sel.includes('.study-app') ? scroller : null),
      querySelector: sel => (sel === '.book-bar' ? bar : null),
    };
    const scroller = {
      clientTop: 0,
      clientHeight: 800,
      scrollHeight: 4000,
      get scrollTop() { return scrollNow; },
      set scrollTop(v) { scrollNow = v; },
      getBoundingClientRect: () => ({ top: 0, bottom: 800, height: 800 }),
      matches: sel => sel.includes('.study-app'),
      contains: () => true,
      querySelector: sel => (sel === '.topbar' ? topbar : null),
      scrollTo: opts => { scrolled.push(opts); scrollNow = opts.top; },
    };

    const details = { open: false, parentElement: { closest: () => null } };
    const focused = [];
    const toggle = { focus: opts => focused.push(['toggle', opts]) };
    const tallBlock = {
      dataset: { aiBlock: 'b1' },
      parentElement: scroller,
      attrs: new Map(),
      setAttribute(k, v) { this.attrs.set(k, v); },
      removeAttribute(k) { this.attrs.delete(k); },
      closest: sel => (sel === '.book-page' ? page : null),
      querySelector: sel => (sel === '.book-ai__toggle' ? toggle : null),
      getBoundingClientRect: () => ({ top: 1200 - scrollNow, bottom: 2200 - scrollNow, height: 1000 }),
    };
    const wordSpan = {
      dataset: { aiIds: 'w1' },
      parentElement: scroller,
      attrs: new Map(),
      setAttribute(k, v) { this.attrs.set(k, v); },
      removeAttribute(k) { this.attrs.delete(k); },
      closest: sel => (sel === 'details' ? details : sel === '.book-page' ? page : null),
      focus: opts => focused.push(['span', opts]),
      getBoundingClientRect: () => ({ top: 1500 - scrollNow, bottom: 1524 - scrollNow, height: 24 }),
    };
    const termCard = {
      dataset: { termCard: 'K001' },
      parentElement: scroller,
      attrs: new Map(),
      setAttribute(k, v) { this.attrs.set(k, v); },
      removeAttribute(k) { this.attrs.delete(k); },
      closest: sel => (sel === 'details' ? details : sel === '.book-page' ? page : null),
      getBoundingClientRect: () => ({ top: 1800 - scrollNow, bottom: 2700 - scrollNow, height: 900 }),
    };

    globalThis.getComputedStyle = node => (node === scroller ? { overflowY: 'auto' } : node === topbar ? { position: 'sticky' } : {});
    globalThis.window = { getComputedStyle: globalThis.getComputedStyle, innerHeight: 800 };
    globalThis.CSS = { escape: s => s };
    globalThis.requestAnimationFrame = fn => fn();
    globalThis.document = {
      scrollingElement: {},
      querySelector: sel => (sel === '[data-term-card="K001"]' ? termCard : null),
      querySelectorAll: sel => (sel === '[data-ai-block]' ? [tallBlock] : sel === '.book-ai-anchor' ? [wordSpan] : []),
    };

    assert.equal(m.showBlock('b1'), true);
    assert.equal(scrolled.at(-1).top, 1200 - 113, 'tall AI block lands 16px below stuck .topbar + .book-bar (97 + 16 = 113)');
    assert.deepEqual(focused.at(-1), ['toggle', { preventScroll: true }]);

    scrollNow = 0;
    assert.equal(m.showWords('w1'), true);
    assert.equal(details.open, true);
    assert.equal(scrolled.at(-1).top, 1500 - (113 + (687 - 24) / 2), 'short anchor span centers in usable viewport below sticky bar');
    assert.deepEqual(focused.at(-1), ['span', { preventScroll: true }]);

    scrollNow = 0;
    details.open = false;
    m.showCard('K001');
    assert.equal(details.open, true);
    assert.equal(scrolled.at(-1).top, 1800 - 113, 'tall term card lands 16px below stuck .topbar + .book-bar');
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.getComputedStyle = prevGetComputedStyle;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.CSS = prevCss;
  }
});
