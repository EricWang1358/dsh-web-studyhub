/* 只生成部分章节 & pre-run book scale on the 总纲 page (#708; static zh and en): the whole book stays the one main button; picking chapters is folded beside it.
   Whenever unbuilt review book chapters remain (`!book.notes` or `rest`), `useBookScale` asks `courseBook.build` with `estimate: true` (no model call) and
   `CourseOutlineView` shows points, calls AND read+write tokens plus the quota-saving tip below the control row (never a currency price, never fabricated UI
   call counts, and never duplicated when chapters are ticked inside `BookPick`). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const ui = await loadUi(`
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { default as BookPick, ScaleLines, hasUnbuiltParts, partState, pickedInOrder, unbuiltText } from './ui/outline/BookPick.jsx';
  export { bookCostTipText, bookScalePointsText, bookScaleTokensText } from './ui/outline/words.js';
  export * from './ui/outline/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const PRICE = /元|¥|￥|\$|价格|费用|美元|RMB|USD|price|cost/i;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const buttons = html => dom(html).all.filter(item => item.tagName === 'BUTTON' || item.tagName === 'button');
const primary = html => buttons(html).filter(item => /sh-btn--primary/.test(item.getAttribute('class') || '')).map(item => item.textContent.trim());
const summary = total => ({ total, counts: { new: total, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: total, inactive: 0, percent: null, state: total ? 'new' : 'none' });
const range = (low, high) => ({ low, high });

const point = (id, title) => ({ key: `bk:${id}`, id, title, total: 0, summary: summary(0), deckCount: 0, depth: 2, anchors: 1, opensRows: false });
const chapter = (id, title, points) => ({ key: `bk:${id}`, id, title, total: 0, summary: summary(0), deckCount: 0, depth: 1, children: points });
const PARTS = [{ id: 'c1', title: 'Thermodynamics', points: 2, written: 2 }, { id: 'c2', title: 'Kinetics', points: 3, written: 0 },
  { id: 'c3', title: 'Equilibrium', points: 4, written: 1 }];
const WHOLE_SCALE = { points: 9, chapters: 3, sample: false, calls: range(18, 54), readTokens: range(45000, 90000), writeTokens: range(16200, 194400), totalTokens: range(61200, 284400) };
const REST_SCALE = { points: 6, chapters: 2, sample: false, calls: range(12, 36), readTokens: range(30000, 60000), writeTokens: range(10800, 129600), totalTokens: range(40800, 189600) };
const notesLine = extra => ({ id: 'notes-1', createdAt: null, supersedes: null, language: 'zh', leaves: 3, papers: false, stale: false, missing: 0, changed: 0, ...extra });
const outline = ({ notes = null, parts = PARTS, format = 'pdf', extra = {} } = {}) => ({ status: 'ok', course: 'SA', total: 0, placed: 0, summary: summary(0), draftCards: 0, limit: 200, decks: [],
  deckId: null, documents: [{ key: 'doc:t', title: `Textbook.${format}`, format, chapters: 2, total: 0, summary: summary(0), deckCount: 0 }],
  unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] },
  book: { id: 'outline-1', title: '总纲 · SA', createdAt: null, supersedes: null, papers: 0, stale: false, from: 'inventory', orderBasis: { codes: ['logic'] },
    counts: { units: 9, leftover: 0, invalid: 0, repeated: 0 }, other: null, notes, parts,
    nodes: [chapter('c1', 'Thermodynamics', [point('p1', 'Entropy'), point('p2', 'Enthalpy')]), chapter('c2', 'Kinetics', [point('p3', 'Rate laws')]),
      chapter('c3', 'Equilibrium', [point('p4', 'Le Chatelier')])], ...extra }, open: {} });
const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, onOpenBook: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop,
  onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop, setCoverage: noop, pickScale: async () => ({}) };
const page = (args, extra = {}) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(args), details: {}, open: new Set(), pick: ui.emptyPick(), actions, coverage: 'standard', ...extra }));

test('hasUnbuiltParts and unbuiltText report partially built chapter sets without string coercion', () => {
  assert.equal(ui.hasUnbuiltParts(), false);
  assert.equal(ui.hasUnbuiltParts([]), false);
  assert.equal(ui.hasUnbuiltParts(PARTS.map(part => ({ ...part, written: 0 }))), false, 'none built yet is an unbuilt book, not a partial one');
  assert.equal(ui.hasUnbuiltParts(PARTS.map(part => ({ ...part, written: part.points }))), false, 'all chapters built');
  assert.equal(ui.hasUnbuiltParts(PARTS), true);
  assert.equal(ui.unbuiltText(PARTS), '已生成 2/3 章，其余 1 章未生成');
  assert.equal(ui.unbuiltText(PARTS.map(part => ({ ...part, written: 0 }))), null);
});

test('an outline without a book: 生成复习全书 stays adjacent to its controls; bookScale surfaces points, calls and tokens below (Markdown too, no fabricated fallback)', () => {
  const unbuiltParts = PARTS.map(part => ({ ...part, written: 0 }));
  // Before async bookScale arrives (`bookScale = null`), no fabricated 2*points..6*points call estimate is drawn; the quota tip still shows.
  const pendingHtml = page({ parts: unbuiltParts, format: 'md' }), pendingText = textOf(pendingHtml);
  assert.doesNotMatch(pendingText, /要写 \d+ 个知识点/, 'never fabricate call counts in UI before estimate: true resolves');
  assert.match(pendingText, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);

  // Once bookScale resolves, points + calls + read/write/total tokens render below the control row (even for Markdown where CustomGate never opens).
  const html = page({ parts: unbuiltParts, format: 'md' }, { bookScale: WHOLE_SCALE }), text = textOf(html);
  assert.deepEqual(primary(html), ['生成复习全书'], 'the whole book is still one click');
  assert.match(text, /生成复习全书 精简 标准 详尽 重新整理/, 'scale text never splits 生成复习全书 from its 讲解详尽程度 Select');
  assert.ok(html.indexOf('outline-organise__actions') < html.indexOf('outline-organise__notes'), 'scale and notes render below the control row');
  assert.match(text, /要写 9 个知识点 · 18–54 次模型调用 · 读资料加模型写出的约 61\.2K–284K tok（读资料 45K–90K tok，写出 16\.2K–194K tok，含思考）；提示词另计/);
  assert.match(text, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.doesNotMatch(text, PRICE);
  assert.match(text, /只生成部分章节/);
  assert.match(text, /勾选要生成的章：只写这些章的知识点、只读它们的资料；已经写好的不会重写，也不会再花一次。/);
  assert.match(text, /Kinetics 未生成 · 3 个知识点/);
  const pick = buttons(html).find(item => /生成所选章节/.test(item.textContent));
  assert.ok(pick.hasAttribute('disabled'), 'nothing picked: nothing to build');
  assert.doesNotMatch(text, /章未生成/, 'a course without a book has no 未生成 line');
});

test('a book of some chapters (`rest`): shows remaining scale (points, calls, tokens) and quota-saving tip alongside 生成全部其余章节', () => {
  const html = page({ notes: notesLine() }, { bookScale: REST_SCALE }), text = textOf(html);
  assert.match(text, /已生成 2\/3 章，其余 1 章未生成/);
  assert.match(text, /生成全部其余章节 精简 标准 详尽 重新整理/, 'controls stay grouped on the control row');
  assert.match(text, /生成其他章节/);
  assert.match(text, /要写 6 个知识点 · 12–36 次模型调用 · 读资料加模型写出的约 40\.8K–190K tok（读资料 30K–60K tok，写出 10\.8K–130K tok，含思考）；提示词另计/);
  assert.match(text, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.doesNotMatch(text, PRICE);
  assert.match(text, /Thermodynamics 已生成/);
  assert.match(text, /Equilibrium 已生成 1\/4 个知识点/);
  assert.ok(buttons(html).some(item => item.textContent.trim() === '生成全部其余章节'), 'the whole-book button names what it writes');
  assert.doesNotMatch(text, /更新全书/);
  assert.doesNotMatch(text, /资料有更新/, 'not out of date');
  const rows = dom(html).all.filter(item => item.getAttribute?.('data-key') === 'bk:c2');
  assert.match(rows[0].textContent, /未生成/, 'the chapter row says it');
  assert.doesNotMatch(dom(html).all.find(item => item.getAttribute?.('data-key') === 'bk:c1').textContent, /未生成/);
});

test('no picker or duplicate scale on stale/descriptor outlines, waiting sample, or fully built books; without an outline the way there is said', () => {
  assert.doesNotMatch(textOf(page({ extra: { stale: true } }, { bookScale: WHOLE_SCALE })), /只生成部分章节|要写 9 个知识点/, 'an outline to organise again first');
  assert.doesNotMatch(textOf(page({ extra: { from: 'descriptors' } }, { bookScale: WHOLE_SCALE })), /只生成部分章节|要写 9 个知识点/);
  assert.doesNotMatch(textOf(page({ parts: PARTS.slice(0, 1) })), /只生成部分章节/, 'one chapter: nothing to pick');
  const sample = { level: 'standard', written: true, points: [{ id: 'p1', title: 'Entropy' }, { id: 'p2', title: 'Enthalpy' }] };
  const sampleHtml = page({ notes: notesLine({ sample }) }, { bookScale: REST_SCALE });
  assert.doesNotMatch(textOf(sampleHtml), /生成其他章节/, 'the sample card leads');
  assert.equal((textOf(sampleHtml).match(/opencode \/ commandcode/g) || []).length, 1, 'waiting sample shows the tip once inside BookSample, not twice');
  const builtHtml = page({ notes: notesLine(), parts: PARTS.map(part => ({ ...part, written: part.points })) }, { bookScale: WHOLE_SCALE });
  assert.doesNotMatch(textOf(builtHtml), /要写 \d+ 个知识点|opencode \/ commandcode/, 'fully built book shows neither pre-run scale nor unbuilt tip');
  const bare = render(h(ui.CourseOutlineView, { course: 'SA', outline: { ...outline(), book: null }, details: {}, open: new Set(), pick: ui.emptyPick(), actions, coverage: 'standard' }));
  assert.match(textOf(bare), /想先只生成几章：先点「生成总纲」（只清点资料、排章节，不写讲解），再回来选章节。/);
  assert.match(textOf(bare), /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.doesNotMatch(textOf(bare), PRICE);
});

test('the scale of a pick: points, calls and tokens (read+write or read-only), showTip suppression, nothing to write, no price', () => {
  const fullScale = { points: 14, chapters: 2, sample: true, calls: range(28, 84), readTokens: range(120000, 410000), writeTokens: range(25200, 302400), totalTokens: range(145200, 712400) };
  const fullText = textOf(render(h(ui.ScaleLines, { scale: fullScale })));
  assert.match(fullText, /要写 14 个知识点 · 28–84 次模型调用/);
  assert.match(fullText, /读资料加模型写出的约 145K–712K tok（读资料 120K–410K tok，写出 25\.2K–302K tok，含思考）；提示词另计/);
  assert.match(fullText, /先写 2 个样例，按它们实际用的 token 推算其余的，你看过再继续/);
  assert.match(fullText, /整本比较费：可以把资料交给网页版 AI 生成后导入，或者用 opencode \/ commandcode 这类套餐再生成/);
  assert.doesNotMatch(fullText, PRICE);
  const noTipText = textOf(render(h(ui.ScaleLines, { scale: fullScale, showTip: false })));
  assert.match(noTipText, /要写 14 个知识点 · 28–84 次模型调用/);
  assert.doesNotMatch(noTipText, /opencode \/ commandcode/, 'showTip={false} suppresses duplicate tip when Organise already shows it');
  const readOnly = textOf(render(h(ui.ScaleLines, { scale: { points: 3, chapters: 1, sample: false, calls: range(6, 18), readTokens: range(12000, 41000) } })));
  assert.match(readOnly, /读资料约 12K–41K tok（不含提示和模型写出的内容）/);
  assert.match(textOf(render(h(ui.ScaleLines, { scale: { ...fullScale, points: 0 } }))), /选的章都已经写好，不用再生成/);
  assert.deepEqual(ui.pickedInOrder(PARTS, new Set(['c3', 'c1'])), ['c1', 'c3'], 'sent in outline order');
  assert.equal(ui.partState({ points: 3, written: 0 }), '未生成 · 3 个知识点');
});

test('English: the outline scale, rest scale, picker and tip have zero Chinese characters and zero price words', () => english(() => {
  const fixtureWords = /Thermodynamics|Entropy|Enthalpy|Kinetics|Rate laws|Equilibrium|Le Chatelier|Textbook\.(?:pdf|md)|Textbook|SA/g;
  const restHtml = page({ notes: notesLine() }, { bookScale: REST_SCALE }), restText = textOf(restHtml);
  assert.doesNotMatch(restText.replace(fixtureWords, ''), han);
  assert.doesNotMatch(restText, PRICE);
  assert.match(restText, /Build all the other chapters/);
  assert.match(restText, /6 knowledge points to write · 12–36 model calls · Material read plus writing: about 40\.8K–190K tok \(30K–60K tok read, 10\.8K–130K tok written, thinking included\); the prompts are extra/);

  const unbuiltHtml = page({ parts: PARTS.map(part => ({ ...part, written: 0 })), format: 'md' }, { bookScale: WHOLE_SCALE });
  const unbuiltText = textOf(unbuiltHtml);
  assert.doesNotMatch(unbuiltText.replace(fixtureWords, ''), han);
  assert.doesNotMatch(unbuiltText, PRICE);
  assert.match(unbuiltText, /9 knowledge points to write · 18–54 model calls · Material read plus writing: about 61\.2K–284K tok \(45K–90K tok read, 16\.2K–194K tok written, thinking included\); the prompts are extra/);
  assert.match(unbuiltText, /web AI.*opencode \/ commandcode/);

  const pickScale = textOf(render(h(ui.ScaleLines, { scale: REST_SCALE })));
  assert.doesNotMatch(pickScale, han);
  assert.doesNotMatch(pickScale, PRICE);
}));
