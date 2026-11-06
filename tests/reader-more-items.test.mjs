import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 「更多」 of the reader's toolbar (reader/more-items.js): everything the toolbar no longer shows (the views, find, translate, display settings, the study tools,
   mastery and coverage, the AI outline, the original file, and what the dialog adds: rename, today's tasks, the question sets). The items are the Menu's. */
const m = await loadUi(`export { moreItems } from './ui/document-preview/reader/more-items.js'; export { setUiLanguage } from './ui/i18n.js';`);
m.setUiLanguage('zh');

const ids = items => items.filter(item => !item.heading).map(item => item.id);
const noop = () => {};
const handlers = () => { const calls = []; const make = name => (...args) => calls.push([name, ...args]); return { calls, setView: make('view'), find: make('find'), translate: make('translate'), display: make('display'), tools: make('tools'),
  quality: make('quality'), assist: make('assist'), download: make('download'), hostPreview: make('hostPreview'), attach: make('attach') }; };
const base = { view: 'read', format: 'pdf', fileUrl: true, localMode: false, find: { on: false }, translate: true, display: true, tools: { on: false, count: 0 }, quality: null, assist: false, download: false, hostPreview: false, attach: false, extra: [] };

test('a PDF material: the three views as checked items, then find, translate, display settings and the study tools', () => {
  const h = handlers(), items = m.moreItems(base, h);
  assert.deepEqual(ids(items), ['view:read', 'view:text', 'view:original', 'find', 'translate', 'display', 'tools']);
  assert.deepEqual(items.filter(item => item.checked !== undefined && item.id.startsWith('view:')).map(item => [item.id, item.checked]), [['view:read', true], ['view:text', false], ['view:original', false]]);
  const find = items.find(item => item.id === 'find');
  assert.match(find.hint, /F/, 'the shortcut is told');
  find.run(); items.find(item => item.id === 'translate').run(); items.find(item => item.id === 'display').run(); items.find(item => item.id === 'tools').run();
  items.find(item => item.id === 'view:text').run();
  assert.deepEqual(h.calls, [['find'], ['translate'], ['display'], ['tools'], ['view', 'text']]);
});

test('without the original file the 原始 PDF item says so and leads to 补全原文件; a text format has no 原始 PDF item', () => {
  const h = handlers();
  const items = m.moreItems({ ...base, fileUrl: false }, h), original = items.find(item => item.id === 'view:original');
  assert.equal(original.hint, '没有原文件');
  assert.ok(original.tip, 'and the longer words are in its tip');
  assert.equal(original.checked, false);
  original.run();
  assert.deepEqual(h.calls, [['view', 'original']], 'the reader decides what a click on it does (it opens the 补全原文件 dialog)');
  assert.ok(!ids(m.moreItems({ ...base, format: 'md' }, h)).includes('view:original'));
  const attach = m.moreItems({ ...base, format: 'md', attach: true }, h).find(item => item.id === 'attach');
  assert.equal(attach.label, '补全原文件…');
  assert.equal(attach.hint, '没有原文件');
});

test('in the original PDF view find, translate and display settings are not offered', () => {
  const items = m.moreItems({ ...base, view: 'original' }, handlers());
  assert.deepEqual(ids(items), ['view:read', 'view:text', 'view:original', 'tools']);
  assert.equal(items.find(item => item.id === 'view:original').checked, true);
  assert.ok(items.find(item => item.id === 'tools').tip, 'the study tools say what they do on a page of the PDF');
});

test('a local note has no study tools, no translation and no material views beyond reading and text', () => {
  const items = m.moreItems({ ...base, localMode: true, format: 'md', translate: false, tools: null }, handlers());
  assert.deepEqual(ids(items), ['view:read', 'view:text', 'find', 'display']);
});

test('the study tools show how many passages are linked; mastery and coverage, the AI outline and the downloads come only when there is something to say', () => {
  const h = handlers();
  const items = m.moreItems({ ...base, tools: { on: true, count: 3 }, quality: { text: '掌握 60% · 覆盖 32%' }, assist: true, download: true, hostPreview: true }, h);
  const tools = items.find(item => item.id === 'tools');
  assert.equal(tools.checked, true);
  assert.equal(tools.hint, '3');
  assert.equal(items.find(item => item.id === 'quality').hint, '掌握 60% · 覆盖 32%');
  assert.deepEqual(ids(items), ['view:read', 'view:text', 'view:original', 'find', 'translate', 'display', 'tools', 'quality', 'assist', 'download', 'host-preview']);
  items.find(item => item.id === 'assist').run(); items.find(item => item.id === 'download').run(); items.find(item => item.id === 'host-preview').run(); items.find(item => item.id === 'quality').run();
  assert.deepEqual(h.calls, [['assist'], ['download'], ['hostPreview'], ['quality']]);
  assert.deepEqual(ids(m.moreItems(base, h)).filter(id => ['quality', 'assist', 'download', 'host-preview'].includes(id)), []);
});

test('what the dialog adds (rename, tasks, question sets) comes last, after its own heading, and runs on its own', () => {
  let ran = 0;
  const extra = [{ id: 'rename', icon: 'edit', label: '重命名…', run: () => { ran += 1; } }, { id: 'deck:d1', label: '宏观 · 题组', run: noop }];
  const items = m.moreItems({ ...base, extra }, handlers());
  assert.deepEqual(ids(items).slice(-2), ['rename', 'deck:d1']);
  const heading = items.findIndex(item => item.heading);
  assert.ok(items.slice(heading).some(item => item.heading), 'headings separate the groups');
  items.find(item => item.id === 'rename').run();
  assert.equal(ran, 1);
});
