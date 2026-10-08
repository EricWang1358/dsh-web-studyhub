import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';
import { examPointListSummary } from '../lib/exam-point-list.js';
import { library, pointList, buildJob, snapshot } from './helpers/exam-prep-fixtures.mjs';

/* 备考补习, the short create form drawn (the pure part is in exam-prep-form.test.mjs): one table of the course documents with a one-click role each and its
   reason, the optional settings in one closed fold, the model banner on top, the plan above the one button, and the form kept for a detour. Fakes only. */

const ui = await loadUi(`
  export { default as ExamPrep } from './ui/exam-prep/ExamPrep.jsx';
  export { default as ExamPrepCreate } from './ui/exam-prep/ExamPrepCreate.jsx';
  export * from './ui/exam-prep/model.js';
  export * from './ui/exam-prep/form.js';
  export * from './ui/exam-prep/form-draft.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const services = (extra = {}) => ({ call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop,
  navigate: noop, openModal: noop, ...extra });
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services() }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const drawn = html => textOf(html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span><\/span>/g, ''));
const KNOWN = ['网络', '数据库'];
const rowsOf = html => dom(html).all.filter(item => item.hasAttribute('data-doc'));
const rowFor = (html, title) => rowsOf(html).find(item => item.textContent.includes(title));
const inside = (element, tag) => { for (let at = element; at; at = at.parentElement) if (at.tagName === tag.toUpperCase()) return at; return null; };
const ownWords = text => text.replace(/网络|数据库|传输层\.pptx|传输层|老师给的样卷|去年的卷子|考试大纲/g, '').replace(/"[^"]*[㐀-鿿][^"]*"/g, '""');
const withoutOther = () => library().filter(source => source.id !== 'other-1');

const open = (data, scope = data.focus.course, extra = {}) => ui.openingForm(data, { scope, known: KNOWN, ...extra });
const create = (data, form = open(data), extra = {}) => h(ui.ExamPrepCreate, { data, initial: form, onBack: noop, onStarted: noop, openSettings: noop, openImport: noop, ...extra });

test('a learner who left the course empty still sees the progress and the failure of the build on the list page', () => {
  const nameless = buildJob({ id: 'blueprint-none', title: '没写课程的', course: null });
  const failed = buildJob({ id: 'blueprint-none-bad', title: '没写课程坏了的', status: 'failed', course: null });
  const page = data => drawn(render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop })));
  const everywhere = page(snapshot({ lists: [], jobs: [nameless, failed], course: '*' }));
  assert.match(everywhere, /没写课程的/);
  assert.match(everywhere, /「没写课程坏了的」没有生成完/);
  assert.match(page(snapshot({ lists: [], jobs: [nameless], course: '' })), /没写课程的/, 'uncategorised');
  assert.doesNotMatch(page(snapshot({ lists: [], jobs: [nameless] })), /没写课程的/, 'a course page keeps to its own builds');
});

/* ---------- the form drawn ---------- */

test('one table of the course documents, a role each with its reason, and a sentence that counts them', () => {
  const html = render(create(snapshot({ lists: [] })));
  const text = drawn(html);
  assert.equal(rowsOf(html).length, 4, 'the deck, two papers and the syllabus; the other course\'s material stays out');
  assert.doesNotMatch(text, /别的课的讲义/);
  const page = dom(html), rows = page.all.filter(item => item.hasAttribute('data-doc')), find = title => rows.find(item => item.textContent.includes(title));
  const deck = find('传输层'), paper = find('老师给的样卷'), syllabus = find('考试大纲');
  assert.equal(deck.getAttribute('data-role'), 'lecture');
  assert.equal(paper.getAttribute('data-role'), 'past-paper');
  assert.equal(syllabus.getAttribute('data-role'), 'syllabus');
  assert.match(deck.textContent, /PowerPoint · 5 页/);
  assert.match(deck.textContent, /PowerPoint/);
  assert.match(paper.textContent, /文件名含「样卷」/, 'the reason is visible');
  assert.match(syllabus.textContent, /文件名含「大纲」/);
  assert.match(find('去年的卷子').textContent, /默认当作课件/);
  const buttons = row => page.all.filter(item => item.tagName === 'BUTTON' && inside(item, 'li') === row && item.hasAttribute('aria-pressed'));
  for (const row of [deck, paper, syllabus]) assert.deepEqual(buttons(row).map(item => item.textContent.trim()), ['课件', '样卷', '大纲', '不用'], 'one click each');
  const pressed = row => buttons(row).filter(item => item.getAttribute('aria-pressed') === 'true').map(item => item.textContent.trim());
  assert.deepEqual(pressed(paper), ['样卷']);
  assert.match(text, /2 份课件 · 1 份样卷 · 1 份大纲/);
  assert.equal(dom(html).all.filter(item => (item.getAttribute('class') || '').split(/\s+/).includes('source-picker')).length, 0, 'no picker on the main path');
  assert.doesNotMatch(text, /蓝图|blueprint/i);
});

test('without a sample paper the form says what that means and offers 导入样卷 (only where importing is possible)', () => {
  const data = snapshot({ lists: [], sources: library().filter(source => !source.id.startsWith('paper-')) });
  const html = render(create(data));
  assert.match(drawn(html), /没有样卷：所有考点都是补充，不会标出样卷考过的点/);
  assert.ok(dom(html).all.some(item => item.tagName === 'BUTTON' && /导入样卷/.test(item.textContent)));
  const without = render(create(data, open(data), { openImport: undefined }));
  assert.match(drawn(without), /没有样卷：所有考点都是补充/);
  assert.ok(!dom(without).all.some(item => item.tagName === 'BUTTON' && /导入样卷/.test(item.textContent)), 'the link is hidden when the page cannot import');
  assert.doesNotMatch(drawn(render(create(snapshot({ lists: [] })))), /没有样卷/, 'with a paper the note is gone');
});

test('a name that looks like a paper keeps its role but offers 设为样卷 in one click', () => {
  const data = snapshot({ lists: [], sources: [...library(), { id: 'weak-1', title: 'Exam tips', text: 'tips', createdAt: '2026-10-01T08:00:00.000Z', courses: ['网络'], chars: 4 }] });
  const html = render(create(data));
  const row = rowFor(html, 'Exam tips');
  assert.equal(row.getAttribute('data-role'), 'lecture');
  assert.match(row.textContent, /名字像样卷？设为样卷/);
  assert.doesNotMatch(rowFor(html, '传输层').textContent, /设为样卷/);
});

test('名称, 范围, 课程, 清单语言, 推荐教材 and 其它课程的资料 sit in one closed fold; the name is the placeholder; the link goes to Settings', () => {
  const html = render(create(snapshot({ lists: [] })));
  const page = dom(html);
  const folds = page.all.filter(item => item.tagName === 'DETAILS');
  const more = folds.find(item => /更多设置/.test(item.textContent));
  assert.ok(more, 'one fold: 更多设置');
  assert.equal(more.hasAttribute('open'), false, 'closed on a plain opening');
  const name = page.all.find(item => item.tagName === 'INPUT' && item.getAttribute('placeholder') === '网络 考点清单');
  assert.ok(name, 'the default name is the placeholder');
  assert.equal(name.getAttribute('value') || '', '', 'nothing typed');
  assert.ok(inside(name, 'details') === more, 'the name is off the main path');
  const text = more.textContent;
  const words = ['名称', '范围', '课程', '清单语言', '自动', '中文', 'English', '推荐教材', '其它课程的资料', '这些默认值可以在设置里修改', '前往设置'];
  for (const word of words) assert.match(text, new RegExp(word), word);
  assert.ok(page.all.some(item => item.tagName === 'BUTTON' && /前往设置/.test(item.textContent) && inside(item, 'details') === more));
  assert.match(drawn(html), /更多设置/);
  const standing = page.all.filter(item => item.tagName === 'FIELDSET' && /推荐教材/.test(item.textContent) && inside(item, 'details') !== more);
  assert.equal(standing.length, 0, 'no standing fieldset outside the fold');
  assert.ok(!page.all.some(item => item.tagName === 'BUTTON' && /也显示其它课程的资料/.test(item.textContent)), 'the other-course toggle left the main area');
});

test('a rebuild opens the same form with its values and its fold open; it keeps the name, the course, the scope and the note', () => {
  const mine = pointList({ papers: 2 });
  const row = ui.listRow(examPointListSummary(mine));
  const again = ui.rebuildForm(ui.formFromList(row, mine.blueprint), snapshot({ lists: [mine] }));
  const html = render(create(snapshot({ lists: [mine] }), again));
  const more = dom(html).all.find(item => item.tagName === 'DETAILS' && /更多设置/.test(item.textContent));
  assert.equal(more.hasAttribute('open'), true, 'it carries values');
  assert.match(drawn(html), /重新生成考点清单/);
  assert.match(drawn(html), /旧清单保留为历史版本/);
  const name = dom(html).all.find(item => item.tagName === 'INPUT' && item.getAttribute('value') === mine.title);
  assert.ok(name, 'the name of the list');
  assert.equal(again.language, 'auto');
  assert.deepEqual(again.picks['past-paper'], ['paper-1', 'paper-2']);
  assert.match(drawn(html), /2 份样卷/, 'the counts follow the picks');
});

test('without a model the banner is at the top of the form, the table is still there, and the start button waits', () => {
  const data = { ...snapshot({ lists: [] }), model: { ready: false, reason: 'no-route' }, modelReady: false };
  const html = render(create(data));
  const text = drawn(html);
  assert.match(text, /还没有可用的 AI 模型/);
  assert.doesNotMatch(text, /先配置一个 AI 模型/, 'no block in place of the button');
  assert.ok(html.indexOf('sh-banner') > -1 && html.indexOf('sh-banner') < html.indexOf('data-doc='), 'the banner comes before the table');
  assert.ok(html.indexOf('sh-banner') < html.indexOf('data-token-estimate') || !html.includes('data-token-estimate'));
  const start = dom(html).all.find(item => item.tagName === 'BUTTON' && /开始生成/.test(item.textContent));
  assert.ok(start && start.hasAttribute('disabled'), 'the one primary button stays at the bottom, disabled');
  assert.ok(dom(html).all.some(item => item.tagName === 'BUTTON' && /前往设置/.test(item.textContent)));
  const ready = render(create(snapshot({ lists: [] })));
  assert.doesNotMatch(ready, /sh-banner/);
  assert.ok(!dom(ready).all.find(item => item.tagName === 'BUTTON' && /开始生成/.test(item.textContent)).hasAttribute('disabled'));
});

test('what the list reads is said once, above the table; there is no second plan line above the button', () => {
  const html = render(create(snapshot({ lists: [] })));
  assert.equal(html.split('2 份课件').length - 1, 1, 'the counts are said once');
  assert.match(html, /2 份课件 · 1 份样卷 · 1 份大纲/);
  assert.ok(html.indexOf('2 份课件') < html.indexOf('<table') || html.indexOf('2 份课件') < html.lastIndexOf('开始生成'), 'above the table and the button');
  assert.ok(!html.includes('exam-prep-plan'), 'no plan line');
});

test('when the course cannot be told, one small course field is asked above the table, once', () => {
  const data = snapshot({ lists: [], course: '' });
  const html = render(create(data, open(data, '*')));
  const field = dom(html).all.find(item => (item.getAttribute('class') || '').split(/\s+/).includes('course-field'));
  assert.ok(field, 'the course field');
  assert.ok(!inside(field, 'details'), 'on the main path, because it is the one question');
  assert.ok(html.indexOf('course-field') < html.indexOf('data-doc='), 'above the table');
  assert.equal(rowsOf(html).length, 5, 'with no course, every material is offered');
  const known = render(create(snapshot({ lists: [] })));
  assert.ok(!dom(known).all.some(item => (item.getAttribute('class') || '').split(/\s+/).includes('course-field') && !inside(item, 'details')), 'a known course is not asked');
});

test('the form in English: the table, the reasons, the fold, the plan and the banner have no Chinese', () => {
  const tips = { id: 'weak-1', title: 'Exam tips', text: 'tips', createdAt: '2026-10-01T08:00:00.000Z', courses: ['网络'], chars: 4 };
  const data = { ...snapshot({ lists: [], sources: [...library(), tips] }), model: { ready: false, reason: 'no-route' } };
  english(() => {
    const html = render(create(data));
    const text = ownWords(drawn(html));
    const words = ['New exam-point list', 'More settings', 'Slides', 'Sample paper', 'Syllabus', 'Not used', 'Go to settings', 'Start building'];
    for (const word of words) assert.match(text, new RegExp(word), word);
    assert.doesNotMatch(text, han, text);
    assert.doesNotMatch(text, /蓝图|blueprint/i);
    const noPaper = ownWords(drawn(render(create(snapshot({ lists: [], sources: withoutOther().filter(source => !source.id.startsWith('paper-')) })))));
    assert.match(noPaper, /No sample paper/);
    assert.doesNotMatch(noPaper, han, noPaper);
  });
});

test('a long table scrolls in a window with a filter; a short one is a plain list with every row in sight', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `note-${index}`, title: `笔记 ${index}`, text: 'n', createdAt: '2026-10-01T08:00:00.000Z', courses: ['网络'], chars: 1 }));
  const long = render(create(snapshot({ lists: [], sources: [...library(), ...many] })));
  assert.match(long, /sh-scroll__filter/, 'a filter for a long table');
  assert.equal(rowsOf(long).length, 14, 'every row is still a row of the table');
  const short = render(create(snapshot({ lists: [] })));
  assert.doesNotMatch(short, /sh-scroll__filter/);
  assert.match(short, /<ul[^>]*exam-prep-docs__list/);
});

test('a deck of many pages offers 选择页面 on its row, so using only some pages stays possible; a one-page text does not', () => {
  const html = render(create(snapshot({ lists: [] })));
  const page = dom(html);
  const row = title => page.all.filter(item => item.hasAttribute('data-doc')).find(item => item.textContent.includes(title));
  assert.match(row('传输层').textContent, /选择页面/);
  assert.doesNotMatch(row('老师给的样卷').textContent, /选择/);
});

test('the form explains itself where it is not obvious: the roles, the estimate and the textbook, each reachable by keyboard and hidden until hover', () => {
  const page = dom(render(create(snapshot({ lists: [] }))));
  const tips = page.all.filter(item => item.getAttribute('role') === 'tooltip').map(tip => ({ text: tip.textContent.trim(), hidden: tip.hasAttribute('popover'),
    anchor: page.all.find(item => (item.getAttribute('aria-describedby') || '').split(/\s+/).includes(tip.id)) }));
  for (const part of [/每份资料有一个用途/, /不是账单/, /不会被读取/]) assert.ok(tips.some(tip => part.test(tip.text)), `${part} explained`);
  for (const tip of tips) {
    assert.ok(tip.anchor && (tip.anchor.getAttribute('tabindex') === '0' || tip.anchor.tagName === 'BUTTON'), `"${tip.text.slice(0, 20)}" takes keyboard focus`);
    assert.ok(tip.hidden, 'hidden until hover or focus');
  }
});

/* ---------- keeping the form across a detour ---------- */

test('the form kept for a detour to Settings comes back for the same library, and only for a while', () => {
  const form = open(snapshot({ lists: [] }));
  ui.dropForm();
  assert.equal(ui.keptForm('/lib', 1000), null);
  ui.keepForm('/lib', { form, more: true }, 1000);
  assert.deepEqual(ui.keptForm('/lib', 2000), { form, more: true });
  assert.equal(ui.keptForm('/other', 2000), null, 'another library');
  assert.equal(ui.keptForm('/lib', 1000 + 60 * 60 * 1000), null, 'a form left for an hour is not brought back');
  ui.dropForm();
  assert.equal(ui.keptForm('/lib', 2000), null);
});

test('a page opened with a kept form shows the form again, with the picks the learner had made', () => {
  const data = snapshot({ lists: [] });
  const form = open(data);
  const items = ui.documentsOf(data.sources);
  const edited = { ...form, picks: ui.assignRole(form.picks, items.find(item => item.title === '老师给的样卷'), 'none') };
  ui.keepForm(data.root, { form: edited, more: false });
  try {
    const html = render(h(ui.ExamPrep, { data, onOpenSource: noop, onOpenTask: noop, openSettings: noop }));
    assert.match(drawn(html), /开始生成/, 'the create form, not the list');
    assert.equal(rowFor(html, '老师给的样卷').getAttribute('data-role'), 'none');
    assert.match(drawn(html), /2 份课件 · 0 份样卷/);
  } finally { ui.dropForm(); }
});
