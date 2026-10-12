/* 复习全书 on the 总纲 page (static zh and en): one main button 生成复习全书 once the outline exists (更新全书 when the notes are out of date, quiet when they
   are current), the same model gate and running line as 生成总纲, 资料有更新，建议更新全书; an opened knowledge point shows its notes read-only: 考情 only with
   sample papers, 知识梳理, 讲解, 例子, 补充 marked as beyond the materials, 角标 buttons and the 出处 they open. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as LeafNotes } from './ui/outline/LeafNotes.jsx';
  export * from './ui/outline/model.js';
  export { levelOptions } from './ui/outline/words.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = total => ({ total, counts: { new: total, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: total, inactive: 0, percent: null, state: total ? 'new' : 'none' });
const point = (id, title, total, extra = {}) => ({ key: `bk:${id}`, id, title, total, summary: summary(total), deckCount: total ? 1 : 0, depth: 2, anchors: 1, opensRows: false, ...extra });
const notesLine = extra => ({ id: 'course-outline-notes-1', createdAt: '2026-10-09T00:00:00.000Z', supersedes: null, language: 'zh', leaves: 2, papers: false, stale: false, missing: 0,
  changed: 0, ...extra });
const book = notes => ({ id: 'course-outline-1', title: '总纲 · SA', createdAt: null, supersedes: null, papers: 0, stale: false, orderBasis: { codes: ['logic'] },
  counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 }, other: null, notes,
  nodes: [{ key: 'bk:c1', id: 'c1', title: 'Thermodynamics', total: 0, summary: summary(0), deckCount: 0, depth: 1, children: [point('p1', 'Entropy', 0), point('p2', 'Enthalpy', 0)] }] });
const outline = notes => ({ status: 'ok', course: 'SA', total: 0, placed: 0, summary: summary(0), draftCards: 0, limit: 200, decks: [], deckId: null,
  documents: [{ key: 'doc:t', title: 'Textbook.pdf', format: 'pdf', chapters: 2, total: 0, summary: summary(0), deckCount: 0 }],
  unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] }, book: notes === undefined ? null : book(notes), open: {} });
const body = { fingerprint: '0123456789abcdef', points: ['Entropy measures disorder [^1]', 'It never decreases in an isolated system'],
  explain: 'Think of $S = k \\ln W$ as counting arrangements [^1] [^2].', example: 'Example: ice melting gains entropy [^2]', extra: ['A general intuition'],
  cites: [{ n: 1, sourceId: 'tb-p3', quote: 'Entropy measures disorder', start: 10, end: 35, title: 'Textbook · p. 3' }, { n: 2, sourceId: 'tb-p4', quote: 'ice cube gains entropy', title: 'Textbook · p. 4' }] };
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop, onPick: noop,
  onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
const OPEN = new Set(['bk:c1', 'bk:p1']);
const page = (extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(null), details: {}, open: OPEN, pick: ui.emptyPick(), actions, ...extra }));
const buttons = html => dom(html).all.filter(item => item.tagName === 'BUTTON' || item.tagName === 'button');
const primary = html => buttons(html).filter(item => /sh-btn--primary/.test(item.getAttribute('class') || '')).map(item => item.textContent.trim());

test('the main button follows the book: 生成复习全书 on an outline, 更新全书 when out of date, quiet when current; 生成总纲 first without an outline', () => {
  assert.equal(ui.mainAction(null), 'outline');
  assert.equal(ui.mainAction(book(null)), 'book');
  assert.equal(ui.mainAction(book(notesLine({ stale: true }))), 'update');
  assert.equal(ui.mainAction(book(notesLine())), null);
  assert.deepEqual(primary(page()), ['生成复习全书']);
  assert.match(textOf(page()), /重新整理/);
  const stale = page({ outline: outline(notesLine({ stale: true })) });
  assert.deepEqual(primary(stale), ['更新全书']);
  assert.match(textOf(stale), /资料有更新，建议更新全书/);
  assert.doesNotMatch(textOf(stale), /建议重新整理/, 'one stale line: the book\'s');
  const current = page({ outline: outline(notesLine()) });
  assert.deepEqual(primary(current), [], 'current notes: nothing to do, 更新全书 stays quiet');
  assert.match(textOf(current), /更新全书/);
  assert.doesNotMatch(textOf(current), /资料有更新/);
  const flat = page({ outline: outline(undefined), open: new Set() });
  assert.deepEqual(primary(flat), ['创建题组'], 'a course without questions and without an outline: 创建题组 is the empty state\'s');
  assert.deepEqual(primary(page({ outline: outline(null) })), ['生成复习全书'], 'with an outline the book leads even without questions; 创建题组 is quiet');
  const flatWithQuestions = page({ outline: { ...outline(undefined), total: 3 }, open: new Set() });
  assert.deepEqual(primary(flatWithQuestions), ['生成总纲'], 'without an outline 生成总纲 leads');
  assert.match(textOf(flatWithQuestions), /生成复习全书/, 'the book can start at once too: it organises the outline first');
  // With papers picked and a book, the note says only 考情 is rewritten.
  assert.match(textOf(current), /已有复习全书时点「更新全书」：只重新对照样卷、改写考情，讲解不变。/);
});

test('the same gate and running line as 生成总纲: a new gate feature, a running build leads to its task', () => {
  const gated = page({ model: { ready: false, reason: 'no-route', label: '' } });
  assert.match(textOf(gated), /生成复习全书需要先配置模型；总纲和已写好的讲解照常能看。/);
  assert.ok(buttons(gated).filter(item => /生成复习全书|重新整理/.test(item.textContent)).every(item => item.getAttribute('disabled') !== null));
  const running = textOf(page({ writing: { jobId: 'course-book-1', status: 'running', done: 1, total: 5 } }));
  assert.match(running, /正在生成复习全书（2\/5 步）… 看进度/);
  assert.doesNotMatch(running, /生成复习全书 |重新整理/);
  const job = (kind, status) => ({ contract: { contractVersion: 1, jobId: `j-${kind}`, kind, title: 't', status, detail: { course: 'SA' }, progress: { done: 2, total: 4 },
    stage: { code: 'x', text: '' }, capabilities: {}, actions: {}, result: { refs: [] }, runtime: {} } });
  assert.deepEqual(ui.runningBuild([job('course-book-build', 'running')], 'SA', ui.BOOK_BUILD_KIND), { jobId: 'j-course-book-build', status: 'running', done: 2, total: 4 });
  assert.equal(ui.runningBuild([job('course-book-build', 'running')], 'SA'), null, 'the outline build is another kind');
});

test('an opened knowledge point shows its notes: 知识梳理, 讲解, 例子, 补充 marked, 角标 and 出处; 考情 only with sample papers', () => {
  const details = { 'bk:p1': { cards: [], more: 0, notes: { id: 'p1', body } } };
  const html = page({ outline: outline(notesLine()), details }), text = textOf(html);
  assert.match(text, /知识梳理 Entropy measures disorder 1 It never decreases in an isolated system 讲解 Think of/);
  assert.match(text, /例子 Example: ice melting gains entropy 2 补充 资料以外 A general intuition/);
  assert.match(text, /1\. 「Entropy measures disorder」 Textbook · p\. 3 2\. 「ice cube gains entropy」 Textbook · p\. 4/);
  assert.ok(!html.includes('outline-notes__exam') && !/\[\^1\]/.test(text), 'no paper, no 考情; marks are buttons, not text');
  const marks = buttons(html).filter(item => /md-cite__mark/.test(item.getAttribute('class') || ''));
  assert.deepEqual(marks.map(item => item.getAttribute('aria-label')), ['看原文 1', '看原文 1', '看原文 2', '看原文 2']);
  assert.ok(html.includes('md-math'), 'the formula goes through the KaTeX renderer');
  const exam = { 'bk:p1': { cards: [], more: 0, notes: { id: 'p1', body, exam: { fingerprint: 'x', tested: true, note: 'Asked as a short calculation.' } } } };
  assert.match(textOf(page({ outline: outline(notesLine({ papers: true })), details: exam })), /考情 样卷考过。 Asked as a short calculation\. 知识梳理/);
  const untested = { 'bk:p1': { cards: [], more: 0, notes: { id: 'p1', body, exam: { fingerprint: 'x', tested: false } } } };
  assert.match(textOf(page({ outline: outline(notesLine({ papers: true })), details: untested })), /考情 样卷没有考到这一点。/);
  const closed = textOf(page({ outline: outline(notesLine()), details, open: new Set(['bk:c1']) }));
  assert.doesNotMatch(closed, /知识梳理/, 'a closed point shows nothing');
  assert.match(textOf(render(h(ui.LeafNotes, { notes: { id: 'p1', empty: true } }))), /这一点的资料里没有可读的文字，没有讲解。/);
});

const passes = { fingerprint: '0123456789abcdef', points: [], explain: '', extra: ['A general intuition'],
  parts: [{ ranges: [{ material: 'Secure.pdf', unit: 'page', from: 1, to: 8 }], points: ['Trust boundaries first [^1]'], explain: 'Where data crosses a boundary [^1].' },
    { ranges: [{ material: 'Secure.pdf', unit: 'page', from: 73, to: 80 }], points: ['Record each threat [^2]'], explain: 'The log closes the loop.', example: 'Example: a login form [^2]' }],
  cites: [{ n: 1, sourceId: 's-p1', quote: 'Secure design page 1 line 0', title: 'Secure.pdf · p. 1' }, { n: 2, sourceId: 's-p73', quote: 'Secure design page 73 line 0', title: 'Secure.pdf · p. 73' }] };
const deep = (coverage, extra) => ({ 'bk:p1': { cards: [], more: 0, notes: { id: 'p1', body: passes, coverage } }, ...extra });

test('讲解详尽程度 beside the book\'s button, a point read in passes under 「第 a–b 页」, 覆盖 and 读更多, and the book line\'s 讲解覆盖', () => {
  const asked = [];
  const html = page({ outline: outline(notesLine({ coverage: { read: 300, total: 1000, partial: 1 } })), details: deep({ unit: 'page', read: 16, total: 80, more: 'full' }),
    coverage: 'standard', actions: { ...actions, setCoverage: noop, readMore: (...args) => asked.push(args) } });
  const text = textOf(html);
  assert.match(text, /更新全书 精简 标准 详尽 重新整理/, 'the level beside the book\'s button');
  assert.match(html, /aria-label="讲解详尽程度"/);
  assert.match(ui.levelOptions().find(option => option.value === 'standard').tip, /^标准：再加上步骤、规则和易错提醒必须讲到/, 'the chosen level explains itself on hover');
  assert.doesNotMatch(text, /费用|元|\$/, 'no cost estimate');
  assert.match(text, /第 1–8 页 Trust boundaries first 1 Where data crosses a boundary 1 \. 第 73–80 页 Record each threat 2 The log closes the loop\. 例子 ：Example: a login form 2/);
  assert.match(text, /覆盖：读了 16\/80 页 读更多/);
  assert.match(text, /只重新读这一个知识点，按「详尽」多读几页再写讲解/, '读更多 says what it does on hover');
  assert.match(text, /讲解覆盖：读了资料的 30%，1 个知识点只读了一部分/);
  const brief = textOf(page({ outline: outline(notesLine()), details: deep({ unit: 'page', read: 0, total: 80, partial: 80, more: 'standard' }), actions: { ...actions, readMore: noop } }));
  assert.match(brief, /覆盖：读了 0\/80 页，另有 80 页只读了开头 读更多/);
  const done = textOf(page({ outline: outline(notesLine()), details: deep({ unit: 'char', read: 1200, total: 1200, more: null }), actions: { ...actions, readMore: noop } }));
  assert.match(done, /覆盖：读了 1,200\/1,200 字/);
  assert.doesNotMatch(done, /读更多/, 'nothing more to read');
  const named = { ...passes, parts: [passes.parts[0], { ...passes.parts[1], ranges: [{ material: 'Handout 3.md', unit: 'whole' }] }] };
  assert.match(textOf(render(h(ui.LeafNotes, { notes: { id: 'p1', body: named } }))), /Secure · 第 1–8 页 .* Handout 3/, 'several materials: each heading names its own');
  assert.equal(asked.length, 0);
  // The transitions: an italic line above the point and one below it; notes without them show none.
  const bridged = render(h(ui.LeafNotes, { notes: { id: 'p1', body, bridge: { in: 'From enthalpy we turn to disorder.', out: 'That leads on to free energy.' } } }));
  assert.match(textOf(bridged), /^ From enthalpy we turn to disorder\. 知识梳理 .* That leads on to free energy\. 1\. 「/);
  assert.equal((bridged.match(/outline-notes__bridge/g) || []).length, 2);
  assert.doesNotMatch(render(h(ui.LeafNotes, { notes: { id: 'p1', body } })), /outline-notes__bridge/);
  // The 总纲 draws its 角标 through the same Markdown: a handler gives buttons, each with the character before it in its no-wrap unit; no handler leaves the text.
  const cited = render(h(ui.LeafNotes, { notes: { id: 'p1', body: { ...body, text: '熵是无序度[^1]。再看。', explain: '' } }, onOpenSource: noop }));
  assert.match(cited, /无序<span class="md-cite-keep">度<sup class="md-cite">[\s\S]*?<\/sup>。<\/span>再看。/);
  assert.doesNotMatch(render(h(ui.LeafNotes, { notes: { id: 'p1', body: { ...body, text: '熵是无序度[^1]。', explain: '' } } })), /md-cite/);
});

test('in English the book\'s controls and notes have no Chinese of their own', () => {
  english(() => {
    const data = /Thermodynamics|Entropy measures disorder|Entropy|Enthalpy|It never decreases in an isolated system|Think of|as counting arrangements|S = k \\ln W|Example: ice melting gains entropy|A general intuition|ice cube gains entropy|Textbook · p\. \d|Textbook|Asked as a short calculation\.|SA/g;
    const details = { 'bk:p1': { cards: [], more: 0, notes: { id: 'p1', body, exam: { fingerprint: 'x', tested: true, note: 'Asked as a short calculation.' } } } };
    for (const html of [page(), page({ outline: outline(notesLine({ stale: true, papers: true })), details }), page({ writing: { jobId: 'j', status: 'running', done: 0, total: 3 } }),
      page({ model: { ready: false, reason: 'no-route', label: '' } })]) {
      const text = textOf(html).replace(data, '');
      assert.doesNotMatch(text, han, text.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    }
    const text = textOf(page({ outline: outline(notesLine({ stale: true, papers: true })), details }));
    assert.match(text, /Update the book/);
    assert.match(text, /In the sample papers Tested in the sample papers\./);
    assert.match(text, /Key points .* Explanation .* Example .* Extra Beyond the materials/);
    assert.match(text, /1\. “Entropy measures disorder”/);
    assert.match(textOf(page()), /Write the review book/);
    const deepHtml = page({ outline: outline(notesLine({ coverage: { read: 300, total: 1000, partial: 1 } })), details: deep({ unit: 'page', read: 0, total: 80, partial: 80, more: 'full' }),
      coverage: 'full', actions: { ...actions, setCoverage: noop, readMore: noop } });
    const deepText = textOf(deepHtml).replace(/Secure\.pdf|Secure|Trust boundaries first|Where data crosses a boundary|Record each threat|The log closes the loop\.|Example: a login form|A general intuition|Secure design page \d+ line 0|SA|Thermodynamics|Entropy|Enthalpy/g, '');
    assert.doesNotMatch(deepText, han, deepText.match(/.{0,30}[㐀-鿿].{0,30}/)?.[0]);
    assert.match(textOf(deepHtml), /Pages 1–8 .* Pages 73–80/);
    assert.match(textOf(deepHtml), /Coverage: read 0 of 80 pages; 80 more only at their start Read more/);
    assert.match(textOf(deepHtml), /Explanations cover 30% of the materials; 1 knowledge point\(s\) read only in part/);
    assert.match(ui.levelOptions().at(-1).tip, /^Detailed: every item of the inventory must be covered/);
  });
});
