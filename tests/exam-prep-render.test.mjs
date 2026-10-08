import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';
import { examPointListSummary } from '../lib/exam-point-list.js';
import { library, pointList, buildJob, snapshot } from './helpers/exam-prep-fixtures.mjs';

/* 备考补习 drawn: the list, one list, the create form, in both languages, with the hover explanations the owner asked for on every control or
   state whose behaviour is not obvious: each one is a Tooltip tied to an anchor the keyboard can reach. Fakes only. */

const ui = await loadUi(`
  export { default as ExamPrep } from './ui/exam-prep/ExamPrep.jsx';
  export { default as ExamPrepList } from './ui/exam-prep/ExamPrepList.jsx';
  export { ExamPrepDetailView } from './ui/exam-prep/ExamPrepDetail.jsx';
  export { default as PointTree } from './ui/exam-prep/PointTree.jsx';
  export * from './ui/exam-prep/model.js';
  export * from './ui/exam-prep/form.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { pageAvailable } from './ui/capabilities.js';
  export { NAV_DEFAULTS } from './ui/nav-order.js';
  export { PAGES } from './ui/pages.js';`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const services = (extra = {}) => ({ call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop, ...extra });
const render = (element, extra) => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services(extra) }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const drawn = html => textOf(html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span><\/span>/g, ''));
/** The page's own words: what the learner's data says (course names, titles of the fixture) taken out. */
const DATA = /网络|数据库|传输层\.pptx|传输层|老师给的样卷|去年的卷子|考试大纲|计算机网络：自顶向下方法|老师推荐，未导入|TCP 连接管理|三次握手|四次挥手|拥塞控制|UDP 的特点|校验和的计算|掌握|Q3/g;
const ownWords = text => text.replace(DATA, '');

/** Every tooltip of a rendered page: its words, and the anchors that reach it with their focus. */
function tooltips(html) {
  const page = dom(html);
  return page.all.filter(item => item.getAttribute('role') === 'tooltip').map(tip => {
    const anchor = page.all.find(item => (item.getAttribute('aria-describedby') || '').split(/\s+/).includes(tip.id));
    return { text: tip.textContent.trim(), id: tip.id, hidden: tip.hasAttribute('popover'), anchor,
      reachable: !!anchor && ((anchor.tagName === 'BUTTON' && !anchor.hasAttribute('disabled')) || anchor.getAttribute('tabindex') === '0') };
  });
}
const everyReachable = (html, label) => {
  const list = tooltips(html);
  assert.ok(list.length > 0, `${label}: has hover explanations`);
  for (const tip of list) {
    assert.ok(tip.anchor, `${label}: "${tip.text.slice(0, 30)}" is tied to an anchor`);
    assert.ok(tip.reachable, `${label}: the anchor of "${tip.text.slice(0, 30)}" takes keyboard focus (${tip.anchor?.tagName} tabindex=${tip.anchor?.getAttribute('tabindex')})`);
    assert.ok(tip.hidden, `${label}: hidden until hover or focus (a manual popover)`);
  }
  return list;
};

const mine = pointList({ title: '网络 · 传输层 考点清单', orphan: true });
const dataWith = (lists, extra = {}) => snapshot({ lists, ...extra });
const row = source => ui.listRow(examPointListSummary(source));

/* ---------- registration ---------- */

test('the sidebar entry and the page exist only while the switch is on', () => {
  const entries = data => ui.NAV_DEFAULTS.periodic.filter(id => ui.pageAvailable(data, id));
  assert.ok(entries(dataWith([mine], { on: true })).includes('examprep'));
  assert.ok(!entries(dataWith([mine], { on: false })).includes('examprep'));
  assert.deepEqual(entries(dataWith([mine], { on: false })), ['exam', 'dashboard'], 'nothing else changes');
  assert.equal(ui.PAGES.examprep.glyph, 'examprep');
});

/* ---------- the list ---------- */

test('the list shows one row per list of the current course: title, scope, basis, counts, time and a way in', () => {
  const html = render(h(ui.ExamPrep, { data: dataWith([mine]), onOpenSource: noop, onOpenTask: noop }));
  const text = drawn(html);
  assert.match(text, /备考补习/);
  assert.match(text, /网络 · 传输层 考点清单/);
  assert.match(text, /传输层/);
  assert.match(text, /依据 1 份样卷；样卷考过的范围可能不全/);
  assert.match(text, /样卷考过 3 · 补充 2/);
  assert.match(text, /新建考点清单/);
  assert.doesNotMatch(text, /必学/);
  assert.doesNotMatch(text, /蓝图|blueprint/i);
  assert.match(html, /<button[^>]*exam-prep-row__open[^>]*>/, 'the row opens the list');
  assert.match(text, /2026/, 'the time of the list');
  const tips = everyReachable(html, 'list');
  assert.ok(tips.some(tip => /样卷/.test(tip.text) && /不全/.test(tip.text)), 'the basis line explains itself');
});

test('another course\'s list is not shown; the same course\'s is; a parent course takes in its sub-courses', () => {
  const other = pointList({ title: '数据库 · 考点清单', courses: ['数据库'] });
  const text = drawn(render(h(ui.ExamPrep, { data: dataWith([mine, other]), onOpenSource: noop, onOpenTask: noop })));
  assert.match(text, /网络 · 传输层 考点清单/);
  assert.doesNotMatch(text, /数据库 · 考点清单/);
  const nothing = drawn(render(h(ui.ExamPrep, { data: dataWith([other]), onOpenSource: noop, onOpenTask: noop })));
  assert.match(nothing, /这门课还没有考点清单/);
  assert.match(nothing, /其它课程里有 1 份考点清单/, 'it says where the others are');
});

test('with no list the page says what it is for and the three inputs, and offers 新建考点清单', () => {
  const html = render(h(ui.ExamPrep, { data: dataWith([]), onOpenSource: noop, onOpenTask: noop }));
  const text = drawn(html);
  for (const word of ['课件', '样卷', '大纲', '推荐教材', '样卷考过', '补充', '新建考点清单']) assert.match(text, new RegExp(word), word);
  assert.match(text, /必选/);
  assert.match(text, /不选时所有考点都是补充/);
  assert.ok((html.match(/新建考点清单/g) || []).length >= 2, 'the header button and the empty state button');
  english(() => {
    const en = drawn(render(h(ui.ExamPrep, { data: dataWith([]), onOpenSource: noop, onOpenTask: noop })));
    assert.match(en, /Exam prep/);
    assert.match(en, /New exam-point list/);
    assert.match(en, /required/);
    assert.doesNotMatch(ownWords(en), han, 'no Chinese of the app own');
    assert.doesNotMatch(en, /蓝图|blueprint/i);
  });
});

test('a running build shows in the row in the place of the time, and as a row of its own when it is a new list; a failed one points to the 任务 console', () => {
  const running = buildJob({ id: 'blueprint-9', status: 'running', done: 2, total: 5, targetId: mine.id, supersedes: mine.id });
  const html = render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [running] }), onOpenSource: noop, onOpenTask: noop }));
  const text = drawn(html);
  assert.match(text, /正在生成 2\/5/);
  assert.match(text, /在任务里查看/);
  assert.equal((html.match(/data-build=/g) || []).length, 0, 'the list it rebuilds already has a row');
  const firstBuild = drawn(render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [buildJob({ id: 'blueprint-first' })] }), onOpenSource: noop, onOpenTask: noop })));
  assert.match(firstBuild, /正在生成 2\/5/);
  assert.match(render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [buildJob({ id: 'blueprint-first' })] }), onOpenSource: noop, onOpenTask: noop })), /data-build="blueprint-first"/, 'a first build is a row of its own, found by its job');
  const fresh = drawn(render(h(ui.ExamPrep, { data: dataWith([], { jobs: [buildJob({ title: '新的清单' })] }), onOpenSource: noop, onOpenTask: noop })));
  assert.match(fresh, /新的清单/);
  assert.match(fresh, /正在生成/);
  const failed = drawn(render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [buildJob({ title: '坏了的', status: 'failed' })] }), onOpenSource: noop, onOpenTask: noop })));
  assert.match(failed, /「坏了的」没有生成完/);
  assert.match(failed, /在任务里查看原因/);
  const tip = everyReachable(html, 'building').find(item => /后台/.test(item.text));
  assert.ok(tip, 'the running state explains itself');
});

test('a build of another course is not shown on this course\'s page, not as a row and not as a failed notice; a build that names no course is shown nowhere', () => {
  const other = buildJob({ id: 'blueprint-db', title: '数据库的清单', course: '数据库' });
  const otherFailed = buildJob({ id: 'blueprint-db-bad', title: '数据库坏了的', status: 'failed', course: '数据库' });
  const nameless = buildJob({ id: 'blueprint-none', title: '没写课程的', course: null });
  const namelessFailed = buildJob({ id: 'blueprint-none-bad', title: '没写课程坏了的', status: 'failed', course: null });
  const html = render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [other, otherFailed, nameless, namelessFailed] }), onOpenSource: noop, onOpenTask: noop }));
  const text = drawn(html);
  for (const title of ['数据库的清单', '数据库坏了的', '没写课程的', '没写课程坏了的']) assert.doesNotMatch(text, new RegExp(title), title);
  assert.doesNotMatch(text, /没有生成完/);
  assert.equal((html.match(/data-build=/g) || []).length, 0);
  const own = drawn(render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [buildJob({ id: 'blueprint-own', title: '本课的清单' }), buildJob({ id: 'blueprint-own-bad', title: '本课坏了的', status: 'failed' })] }), onOpenSource: noop, onOpenTask: noop })));
  assert.match(own, /本课的清单/);
  assert.match(own, /「本课坏了的」没有生成完/);
  const onDatabase = drawn(render(h(ui.ExamPrep, { data: dataWith([mine], { jobs: [other], course: '数据库' }), onOpenSource: noop, onOpenTask: noop })));
  assert.match(onDatabase, /数据库的清单/, 'on its own course\'s page it shows');
});

test('a rebuild is matched to its own list among all the lists, so it is a state of that list\'s row and not a second row', () => {
  const dbList = pointList({ title: '数据库 · 考点清单', courses: ['数据库'] });
  const rebuild = buildJob({ id: 'blueprint-re', title: '数据库 · 考点清单', targetId: dbList.id, supersedes: dbList.id, course: '数据库' });
  const data = dataWith([mine, dbList], { jobs: [rebuild], course: '数据库' });
  const html = render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }));
  assert.equal((html.match(/data-build=/g) || []).length, 0, 'no extra row');
  assert.match(drawn(html), /正在生成 2\/5/, 'the list\'s own row carries it');
});

test('a list whose materials changed says so on its row and in its detail, and keeps 重新生成; a list that did not does not say it', () => {
  const stale = { ...ui.listRow({ ...examPointListSummary(mine), stale: true }) };
  const data = dataWith([mine]);
  data.examPointLists = data.examPointLists.map(summary => ({ ...summary, stale: true }));
  const listHtml = render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }));
  assert.match(drawn(listHtml), /资料已更新，建议重新生成/);
  assert.match(listHtml, /exam-prep-row__stale/);
  const detailHtml = render(detail({ row: stale }));
  assert.match(drawn(detailHtml), /资料已更新，建议重新生成/);
  const regenerate = dom(detailHtml).all.find(item => item.tagName === 'BUTTON' && /重新生成/.test(item.textContent));
  assert.ok(regenerate && !regenerate.hasAttribute('disabled'), '重新生成 stays');
  assert.doesNotMatch(drawn(render(h(ui.ExamPrep, { data: dataWith([mine]), onOpenSource: noop, onOpenTask: noop }))), /资料已更新/);
  assert.doesNotMatch(drawn(render(detail())), /资料已更新/);
  english(() => {
    assert.match(drawn(render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }))), /Materials have changed; rebuilding is recommended/);
    const plain = pointList({ title: 'Networks list' });
    const en = drawn(render(detail({ row: { ...ui.listRow({ ...examPointListSummary(plain), stale: true }) }, blueprint: plain.blueprint })));
    assert.match(en, /Materials have changed; rebuilding is recommended/);
    assert.doesNotMatch(ownWords(en), han);
  });
});

test('the list in English: the owner\'s names and no Chinese UI text', () => {
  const data = dataWith([pointList({ title: 'Networks list', courses: ['网络'], scope: 'Transport' })]);
  english(() => {
    const html = render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }));
    const text = drawn(html);
    assert.match(text, /Exam prep/);
    assert.match(text, /Tested in sample papers 2 · Extra 2/);
    assert.match(text, /Based on 1 sample paper; the range tested in sample papers may be incomplete/);
    assert.match(text, /New exam-point list/);
    assert.doesNotMatch(ownWords(text), han, text);
    for (const tip of tooltips(html)) assert.doesNotMatch(tip.text, han, tip.text);
  });
});

/* ---------- one list ---------- */

const detail = (extra = {}) => h(ui.ExamPrepDetailView, { row: row(mine), blueprint: mine.blueprint, onBack: noop, onOpenSource: noop, onOpenTask: noop, onRegenerate: noop, onDeleted: noop, ...extra });

test('a list: the basis, the counts, the filter and search, the tree, and the leftovers; nothing is offered that cannot be pressed', () => {
  const html = render(detail());
  const text = drawn(html);
  assert.match(text, /网络 · 传输层 考点清单/);
  assert.match(text, /依据 1 份样卷；样卷考过的范围可能不全/);
  assert.match(text, /样卷考过 3 · 补充 2/);
  assert.doesNotMatch(text, /必学/);
  for (const word of ['全部 5', '样卷考过 3', '补充 2', 'TCP 连接管理', '拥塞控制', 'UDP 的特点', '校验和的计算']) assert.match(text, new RegExp(word), word);
  assert.doesNotMatch(text, /四次挥手/, 'the small points show when their big point is opened');
  assert.match(html, /type="search"/);
  assert.match(text, /样卷里没对上的题/);
  assert.match(text, /Q3/);
  assert.match(text, /没有可读文字的课件页/);
  assert.match(text, /传输层\.pptx：第 5 页/);
  assert.match(text, /推荐阅读/);
  assert.match(text, /计算机网络：自顶向下方法/);
  assert.match(text, /重新生成/);
  assert.match(text, /删除/);
  assert.doesNotMatch(text, /蓝图|blueprint/i);
  assert.doesNotMatch(text, /针对这些考点出题/, 'a button that is always off is not shown');
  assert.doesNotMatch(html, /exam-prep-soon/);
  assert.ok(dom(html).all.filter(item => item.tagName === 'BUTTON').every(item => !item.hasAttribute('disabled')), 'no control is permanently disabled');
  const tips = everyReachable(html, 'detail');
  assert.ok(!tips.some(tip => /以后的版本/.test(tip.text)));
  assert.ok(tips.some(tip => /额度/.test(tip.text) && /旧清单/.test(tip.text)), '重新生成: costs quota, keeps the old one');
  assert.ok(tips.some(tip => /^样卷考过：/.test(tip.text) && /样卷/.test(tip.text)) && tips.some(tip => /补充：/.test(tip.text) && /课件/.test(tip.text)), 'the two tiers say how they are decided');
  assert.ok(tips.some(tip => /找不到讲它的内容/.test(tip.text)), '课件里没找到对应内容 explains itself');
  assert.ok(tips.some(tip => /样卷题/.test(tip.text)) && tips.some(tip => /只有图片/.test(tip.text)) && tips.some(tip => /不是依据/.test(tip.text)), 'the leftovers and the reading note explain themselves');
  assert.ok(tips.some(tip => /无法恢复/.test(tip.text)), 'delete');
});

test('every point has its tier badge, and a point only a sample paper reached carries the flag 课件里没找到对应内容', () => {
  const html = render(detail());
  const page = dom(html);
  const points = page.all.filter(item => item.hasAttribute('data-point'));
  assert.equal(points.length, 4, 'the four big points; the small ones show when TCP is opened');
  assert.doesNotMatch(drawn(html), /必学/);
  assert.equal((html.match(/>样卷考过（1\/1 份）</g) || []).length >= 1, true, 'a point a paper tested says in how many of the papers');
  assert.equal((html.match(/>补充</g) || []).length >= 1, true);
  assert.match(drawn(html), /课件里没找到对应内容/);
  assert.match(drawn(html), /出现在 1 页课件/);
});

test('the places of a point open on 看原页, one button each, with the quote; paper questions say 看原题', () => {
  const tree = ui.buildTree(mine.blueprint.points);
  const html = render(h(ui.PointTree, { roots: tree.roots, initialOpen: ['p1', 'p2'], onOpenSource: noop, label: '考点' }));
  const text = drawn(html);
  assert.match(text, /课件 第 1 页/);
  assert.match(text, /三次握手建立连接/);
  assert.match(text, /看原页/);
  assert.match(text, /看原题/);
  assert.match(text, /简述三次握手/);
  assert.match(html, /<q class="exam-prep-place__quote">/, 'a quote is a quote');
  const buttons = dom(html).all.filter(item => item.tagName === 'BUTTON' && /看原页|看原题/.test(item.textContent));
  assert.ok(buttons.length >= 2);
  const tips = everyReachable(html, 'places');
  assert.ok(tips.some(tip => /阅读器/.test(tip.text)), '看原页 says it opens the reader and that you come back');
  // the keyboard: one tab stop for all the row buttons, each telling whether it is open
  const toggles = dom(html).all.filter(item => item.hasAttribute('data-point-toggle'));
  assert.equal(toggles.filter(item => item.getAttribute('tabindex') === '0').length, 1);
  assert.ok(toggles.every(item => item.hasAttribute('aria-expanded')));
  english(() => assert.match(drawn(render(h(ui.PointTree, { roots: tree.roots, initialOpen: ['p1', 'p2'], onOpenSource: noop, label: 'Points' }))), /Slide, page 1/));
});

test('a long list (300 points) draws fast, closed big points cost one row each', () => {
  const big = pointList({ many: 295 });
  const tree = ui.buildTree(big.blueprint.points);
  const started = performance.now();
  const html = render(h(ui.PointTree, { roots: tree.roots, onOpenSource: noop, label: '考点' }));
  const elapsed = performance.now() - started;
  const rows = (html.match(/data-point="/g) || []).length;
  assert.equal(rows, tree.roots.length);
  assert.ok(elapsed < 1500, `${Math.round(elapsed)} ms for ${rows} rows`);
  const opened = render(h(ui.PointTree, { roots: tree.roots, forceOpen: true, onOpenSource: noop, label: '考点' }));
  assert.equal((opened.match(/data-point="/g) || []).length, 300, 'a search opens every big point');
});

test('the list in English: names, tiers and explanations', () => {
  english(() => {
    const html = render(detail({ row: row(pointList({ title: 'Networks list', orphan: true })) }));
    const text = drawn(html);
    assert.doesNotMatch(text, /Make questions for these points|Must-learn/);
    for (const word of ['Rebuild|Regenerate', 'Delete', 'Tested in sample papers \\(1\\/1 papers\\)', 'Extra', 'Sample-paper questions with no match', 'Slides with no readable text', 'Recommended reading', 'All 5', 'Not found in the slides'])
      assert.match(text, new RegExp(word), word);
    for (const tip of everyReachable(html, 'detail (en)')) assert.doesNotMatch(tip.text, han, tip.text);
    assert.doesNotMatch(ownWords(text), han);
  });
});

/* ---------- the create form: see exam-prep-form.test.mjs ---------- */

test('the library for the form has no point list in it, and a point list is never offered as a document', () => {
  assert.equal(ui.documentsOf([...library(), mine]).some(item => item.sourceIds.includes(mine.id)), false);
  assert.equal(ui.documentsOf([...library(), mine]).length, ui.documentsOf(library()).length);
});

test('while the record is being read a list shows everything its summary knows and a slot for the points, and says so when it cannot be read', () => {
  const html = render(detail({ blueprint: null }));
  const text = drawn(html);
  assert.match(text, /网络 · 传输层 考点清单/);
  assert.match(text, /依据 1 份样卷；样卷考过的范围可能不全/);
  assert.match(text, /样卷考过 3 · 补充 2/);
  assert.match(text, /全部 5/);
  assert.match(html, /exam-prep-tree is-loading/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(text, /样卷里没对上的题/, 'what only the record knows waits for it');
  const regenerate = dom(html).all.find(item => item.tagName === 'BUTTON' && /重新生成/.test(item.textContent));
  assert.ok(regenerate.hasAttribute('disabled'), 'a new version needs the inputs of the record');
  assert.ok(dom(html).all.find(item => item.tagName === 'INPUT' && item.type === 'search').hasAttribute('disabled'));
  const failed = drawn(render(detail({ blueprint: null, failure: { error: new Error('没有这份资料') } })));
  assert.match(failed, /读不出这份考点清单/);
  assert.match(failed, /没有这份资料/);
});

test('older versions (archived by a rebuild) sit behind a quiet 历史版本 reveal, not among the lists', () => {
  const old = pointList({ title: '旧版', createdAt: '2026-09-01T00:00:00.000Z' });
  const data = dataWith([mine, old]);
  data.examPointLists = data.examPointLists.map(summary => ({ ...summary, archived: summary.id === old.id }));
  const html = render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }));
  const text = drawn(html);
  assert.match(text, /历史版本（1）/);
  assert.doesNotMatch(text, /旧版/, 'closed by default');
  assert.equal((html.match(/data-list=/g) || []).length, 1);
  english(() => assert.match(drawn(render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop }))), /Older versions \(1\)/));
});
