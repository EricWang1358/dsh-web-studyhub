import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, PAGE_IDS, pageOf, pageNeeds, pagesInGroup, navLabelOf, pageTitleOf } from '../ui/pages.js';
import { NAV_DEFAULTS, NAV_GROUPS } from '../ui/nav-order.js';
import { hasContext, pageAvailable } from '../ui/capabilities.js';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F (#109): one page registry behind the sidebar, the top bar, availability and rendering.

test('every sidebar page of the registry is in NAV_DEFAULTS, in the same group and order, and nothing else is', () => {
  for (const group of Object.keys(NAV_DEFAULTS)) {
    assert.deepEqual(pagesInGroup(group), NAV_DEFAULTS[group], `group ${group}`);
  }
  const grouped = PAGE_IDS.filter((id) => PAGES[id].group);
  assert.deepEqual(grouped.sort(), Object.values(NAV_DEFAULTS).flat().sort());
  assert.deepEqual(NAV_GROUPS.map((group) => group.id), Object.keys(NAV_DEFAULTS));
  for (const id of PAGE_IDS) if (PAGES[id].group) assert.ok(NAV_DEFAULTS[PAGES[id].group], `${id}: its group exists`);
});

test('a page row has the fields the shell reads', () => {
  for (const id of PAGE_IDS) {
    const page = PAGES[id];
    assert.equal(typeof page.label, 'string', `${id} label`);
    assert.ok(Array.isArray(page.needs), `${id} needs`);
    assert.ok(page.title === null || typeof page.title === 'string', `${id} title`);
    if (page.group) assert.equal(typeof page.glyph, 'string', `${id} has a sidebar glyph`);
  }
  assert.equal(PAGES.review.title, null, 'the run titles the practice page');
});

test('the labels that differ from the titles keep their old words', () => {
  assert.equal(PAGES.dashboard.label, '统计');
  assert.equal(PAGES.dashboard.title, '学习统计');
  assert.equal(PAGES.board.label, '待办');
  assert.equal(PAGES.board.title, '待办看板');
  assert.equal(PAGES.settings.title, '设置', 'the sidebar entry and the page title are one name');
  assert.equal(PAGES.settings.label, PAGES.settings.title);
  assert.equal(pageTitleOf('draft'), '草稿与发布');
  assert.equal(pageTitleOf('manage'), '维护题组');
  assert.equal(pageTitleOf('graph'), '知识图谱');
  assert.equal(pageTitleOf('nope'), undefined);
});

test('only sidebar pages have a navigation label (a return from settings says 原位置)', () => {
  assert.equal(navLabelOf('library'), '学习库');
  assert.equal(navLabelOf('live'), '课堂实录');
  assert.equal(navLabelOf('audio'), '音频转写');
  for (const id of ['settings', 'review', 'draft', 'manage', 'graph', 'outline', 'nope']) assert.equal(navLabelOf(id), undefined, id);
});

test('availability reads the registry and matches the table it replaced', () => {
  const old = {
    library: ['bank', 'study'], manage: ['bank'], review: ['bank', 'study'], wrongbook: ['bank', 'study'],
    exam: ['bank', 'study'], dashboard: ['bank', 'study'], graph: ['bank', 'study'],
    generate: ['materials', 'bank', 'authoring', 'generation'], draft: ['bank', 'authoring'],
    sources: ['materials'], audio: ['audio'], live: ['audio', 'recording'],
    workflows: ['workflows', 'bank', 'study'], skeleton: ['skeleton'], notes: ['notes'],
    examprep: ['materials', 'generation'], // added later, behind a host switch (pages.js `flag`)
    outline: ['bank', 'study', 'materials'], // added later: the 总纲 page, reached from the home's course area
  };
  for (const id of PAGE_IDS) assert.deepEqual(pageNeeds(id), old[id] || [], id);
  assert.deepEqual(pageNeeds('nope'), []);
  assert.equal(pageOf('nope'), undefined);
  assert.equal(pageOf('toString'), undefined, 'inherited names are not pages');
  const data = { contexts: ['bank', 'study'] };
  assert.equal(pageAvailable(data, 'library'), true);
  assert.equal(pageAvailable(data, 'generate'), false);
  assert.equal(pageAvailable({}, 'generate'), true, 'an older host without a capability list offers everything');
  assert.equal(pageAvailable(data, 'board'), true);
  assert.equal(hasContext(data, 'audio'), false);
});

test('onEnter: the sidebar resets what a revisit should start fresh, the tour only the exam', () => {
  const calls = [];
  const ctx = { resetExam: () => calls.push('exam'), openBoardFresh: () => calls.push('board'), clearNote: () => calls.push('note'), clearGraphScope: () => calls.push('graph') };
  for (const id of ['board', 'exam', 'notes', 'graph']) PAGES[id].onEnter(ctx, 'user');
  assert.deepEqual(calls, ['board', 'exam', 'note', 'graph']);
  calls.length = 0;
  for (const id of ['board', 'exam', 'notes', 'graph']) PAGES[id].onEnter(ctx, 'tour');
  assert.deepEqual(calls, ['exam'], 'the tour keeps the board, notes and graph as they were');
  for (const id of PAGE_IDS.filter((page) => !['board', 'exam', 'notes', 'graph'].includes(page))) assert.equal(PAGES[id].onEnter, undefined, id);
});

test('every label and title has an English line (no page bypasses ui())', async () => {
  const { ui, setUiLanguage } = await loadUi("export { ui, setUiLanguage } from './ui/i18n.js';");
  setUiLanguage('en');
  try {
    const han = /[一-鿿]/;
    for (const id of PAGE_IDS) for (const text of [PAGES[id].label, PAGES[id].title].filter(Boolean)) {
      assert.doesNotMatch(ui(text), han, `${id}: ${text}`);
    }
  } finally { setUiLanguage('zh'); }
});
