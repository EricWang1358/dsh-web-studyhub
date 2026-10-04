import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
// Styles are irrelevant to these control interactions; keep only their document boundary.
globalThis.document = { querySelector: () => ({ textContent: '' }) };
const built = await build({ stdin: { contents: `export { DailyRecapPanel } from './ui/DailyRecap.jsx';
  export { DailyRecapSettingsForm } from './ui/DailyRecapSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = fn => { const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(fn, module, module.exports); return module.exports; };
const ssr = load(require);
let active;
const hook = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useRef: value => hook(() => ({ current: value }))[1], useId: () => hook(() => `field-${active.cursor}`)[1],
  useInsertionEffect: () => {}, useEffect: (callback, deps) => { const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
    if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) {
      active.effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); slot.deps = deps;
    } },
};
const components = load(name => name === 'react' ? hooks : require(name));
function view(Component, props = {}) {
  let current = props;
  const owner = { cursor: 0, slots: [], effects: [] };
  return {
    render(next = {}) { current = { ...current, ...next }; owner.cursor = 0; active = owner;
      try { return Component(current); } finally { active = null; } },
    effects() { owner.effects.splice(0).forEach(callback => callback()); },
    unmount() { owner.slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
};
const button = (editor, text) => find(editor.render(), node => node.props?.onClick && node.props.children === text);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const group = extra => ({ day: '2026-10-04', course: 'Databases', courseId: 'db', answeredCount: 10, wrongCount: 0, eligible: true, remaining: 0, ...extra });
const status = groups => ({ day: '2026-10-04', tone: 'friendly', automatic: false, groups });
const panel = (props = {}) => view(components.DailyRecapPanel, { root: 'library-a', call: async () => status([group()]), ...props });

test('fewer than ten distinct answers explains the remaining count and cannot generate', async () => {
  const editor = panel({ call: async () => status([group({ answeredCount: 9, wrongCount: 8, eligible: false, remaining: 1 })]) });
  editor.render(); editor.effects(); await settle();
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /再做 1 道不同题目/);
  assert.equal(button(editor, '生成今日合集').props.disabled, true);
});

test('submitted answers awaiting assessment are counted without claiming they are all correct', async () => {
  const editor = panel({ call: async () => status([group({ unassessedCount: 10 })]) });
  editor.render(); editor.effects(); await settle();
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /10 题尚待批改/);
  assert.doesNotMatch(html, /今天没有错题/);
  assert.equal(button(editor, '生成今日合集').props.disabled, false);
});

test('ten answers with no mistakes still permits a summary and duplicate clicks queue only one job', async () => {
  const requests = [], pending = deferred();
  const editor = panel({ call: async (action, args) => {
    requests.push({ action, args });
    return action === 'note.daily.status' ? status([group()]) : pending.promise;
  } });
  editor.render(); editor.effects(); await settle();
  assert.equal(button(editor, '生成今日合集').props.disabled, false);
  const generating = button(editor, '生成今日合集').props.onClick();
  await button(editor, '生成今日合集').props.onClick();
  assert.equal(requests.filter(item => item.action === 'note.daily.generate').length, 1);
  assert.equal(requests.at(-1).args.course, 'db');
  assert.equal(requests.at(-1).args.tone, 'friendly');
  assert.equal(requests.at(-1).args.force, undefined);
  pending.resolve({ id: 'recap-db', status: 'running' }); await generating;
  assert.match(renderToStaticMarkup(editor.render()), /正在整理/);
});

test('late responses from another library cannot show its summary or open its note', async () => {
  const old = deferred(), opened = [];
  const editor = panel({ call: async () => old.promise, onOpenNote: id => opened.push(id) });
  editor.render(); editor.effects();
  editor.render({ root: 'library-b', call: async () => status([group({ course: 'Networks', courseId: 'net' })]) });
  editor.effects(); await settle();
  old.resolve(status([group({ noteId: 'old-note', hasContent: true })])); await settle();
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /Databases/);
  assert.match(renderToStaticMarkup(editor.render()), /Networks/);
  assert.deepEqual(opened, []);
});

test('opening a completed summary navigates locally without starting another generation', async () => {
  const requests = [], opened = [];
  const editor = panel({ call: async action => { requests.push(action); return status([group({ noteId: 'recap-db', hasContent: true })]); }, onOpenNote: id => opened.push(id) });
  editor.render(); editor.effects(); await settle();
  button(editor, '阅读今日合集').props.onClick();
  assert.deepEqual(opened, ['recap-db']);
  assert.deepEqual(requests, ['note.daily.status']);
});

test('a protected manual edit stays intact unless replacement is explicitly chosen', async () => {
  const requests = [];
  const editor = panel({ call: async (action, args) => {
    requests.push({ action, args });
    return action === 'note.daily.status' ? status([group()]) : { id: 'recap-db', status: 'protected' };
  } });
  editor.render(); editor.effects(); await settle();
  await button(editor, '生成今日合集').props.onClick();
  assert.match(renderToStaticMarkup(editor.render()), /手动修改/);
  assert.equal(requests.filter(item => item.action === 'note.daily.generate').length, 1);
  assert.equal(requests.at(-1).args.force, undefined);
  await button(editor, '替换手动内容并重新整理').props.onClick();
  assert.equal(requests.filter(item => item.action === 'note.daily.generate').length, 2);
  assert.equal(requests.at(-1).args.force, true);
  assert.equal(requests.at(-1).args.day, '2026-10-04');
});

test('stopping a running recap preserves the existing reading action and permits a manual retry', async () => {
  const requests = [];
  const editor = panel({ call: async (action, args) => {
    requests.push({ action, args });
    return action === 'note.daily.status' ? status([group({ noteId: 'recap-db', hasContent: true, generation: { status: 'running' } })])
      : { id: 'recap-db', generation: { status: 'cancelled' } };
  }, onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  await button(editor, '停止生成').props.onClick();
  assert.equal(requests.at(-1).action, 'note.daily.cancel');
  assert.deepEqual(requests.at(-1).args, { id: 'recap-db' });
  assert.ok(button(editor, '阅读今日合集'));
  assert.ok(button(editor, '重试生成合集'));
});

test('a notes-list generation refreshes while running, then offers its completed local recap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const editor = panel({ poll: true, call: async action => {
    if (action === 'note.daily.generate') return { id: 'recap-db', status: 'running' };
    return status([group(++reads === 1 ? {} : { noteId: 'recap-db', hasContent: true, generation: { status: 'done' } })]);
  }, onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  await button(editor, '生成今日合集').props.onClick();
  assert.match(renderToStaticMarkup(editor.render()), /正在整理/);
  t.mock.timers.tick(1500); await settle();
  assert.ok(button(editor, '阅读今日合集'));
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /正在整理/);
  t.mock.timers.tick(10000); await settle();
  assert.equal(reads, 2, 'polling stops once the job completes');
  editor.unmount();
});

test('cancelling one course keeps refreshing another running recap until it is readable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false, reads = 0;
  const editor = panel({ poll: true, call: async (action) => {
    if (action === 'note.daily.cancel') { cancelled = true; return { id: 'db-recap', generation: { status: 'cancelled' } }; }
    reads++;
    return status([group({ noteId: 'db-recap', generation: { status: cancelled ? 'cancelled' : 'running' } }),
      group({ course: 'Networks', courseId: 'net', noteId: 'net-recap', hasContent: reads >= 3,
        generation: { status: reads >= 3 ? 'done' : 'running' } })]);
  }, onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  await button(editor, '停止生成').props.onClick();
  t.mock.timers.tick(3000); await settle();
  assert.ok(button(editor, '阅读今日合集'), 'the other course becomes readable without reopening the panel');
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /正在整理今天的讲解/);
  const finalReads = reads;
  t.mock.timers.tick(10000); await settle();
  assert.equal(reads, finalReads);
  editor.unmount();
});

test('a round crossing midnight updates only the selected day for the course', async () => {
  const requests = [];
  const editor = panel({ runId: 'late-round', call: async (action, args) => {
    requests.push({ action, args });
    return action === 'note.daily.status' ? status([group(), group({ day: '2026-10-03' })]) : { id: 'today-recap', status: 'running' };
  } });
  editor.render(); editor.effects(); await settle();
  await button(editor, '生成今日合集').props.onClick();
  assert.equal(requests.at(-1).args.day, '2026-10-04');
  const html = renderToStaticMarkup(editor.render());
  assert.equal((html.match(/正在整理今天的讲解/g) || []).length, 1);
  assert.match(html, /2026-10-03/);
});

test('a manually edited recap offers reading and explicit replacement without a misleading update action', async () => {
  const editor = panel({ call: async () => status([group({ noteId: 'recap-db', hasContent: true, protected: true, stale: true })]), onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  assert.ok(button(editor, '阅读今日合集'));
  assert.equal(button(editor, '更新今日合集'), null);
  assert.ok(button(editor, '替换手动内容并重新整理'));
});

test('completed writing previews the saved summary while an update keeps the previous version readable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let progress = { phase: 'explaining', completed: 1, total: 2 };
  const editor = panel({ poll: true, call: async () => status([group({ noteId: 'recap-db', hasContent: true,
    preview: '先辨清条件，再展开推理。', generation: { status: 'running', progress } })]), onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  assert.match(renderToStaticMarkup(editor.render()), /已整理 1\/2 组讲解/);
  progress = { phase: 'organizing', completed: 2, total: 2 };
  t.mock.timers.tick(3000); await settle();
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /先辨清条件，再展开推理/);
  assert.match(html, /上一版/);
  assert.match(html, /统一语言与结构/);
  assert.ok(button(editor, '阅读今日合集'));
});

test('a transient status failure keeps polling a known running recap until completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const editor = panel({ poll: true, call: async () => {
    reads++;
    if (reads === 2) throw new Error('Temporary connection failure');
    return status([group({ noteId: 'recap-db', hasContent: reads >= 3, generation: { status: reads >= 3 ? 'done' : 'running' } })]);
  }, onOpenNote() {} });
  editor.render(); editor.effects(); await settle();
  t.mock.timers.tick(3000); await settle();
  assert.match(renderToStaticMarkup(editor.render()), /Temporary connection failure/);
  t.mock.timers.tick(5000); await settle();
  assert.ok(button(editor, '阅读今日合集'));
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /Temporary connection failure/);
  editor.unmount();
});

test('a status read started before generation cannot erase the newly accepted job', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const oldRead = deferred(), groups = [group(), group({ course: 'Networks', courseId: 'net', generation: { status: 'running' } })];
  const editor = panel({ poll: true, call: async action => {
    if (action === 'note.daily.generate') return { id: 'recap-db', status: 'running' };
    return ++reads === 1 ? status(groups) : oldRead.promise;
  } });
  editor.render(); editor.effects(); await settle();
  t.mock.timers.tick(3000); await settle();
  await button(editor, '生成今日合集').props.onClick();
  oldRead.resolve(status(groups)); await settle();
  assert.equal((renderToStaticMarkup(editor.render()).match(/正在整理今天的讲解/g) || []).length, 2);
  editor.unmount();
});

test('the same course on two days keeps each manually chosen tone separate', async () => {
  const requests = [];
  const editor = panel({ call: async (action, args) => {
    if (action === 'note.daily.status') return status([group(), group({ day: '2026-10-03' })]);
    requests.push(args); return { id: 'recap-db', status: 'running' };
  } });
  editor.render(); editor.effects(); await settle();
  find(editor.render(), node => node.type === 'input' && node.props.value === 'professional' && node.props.name.includes('2026-10-03')).props.onChange();
  await button(editor, '生成今日合集').props.onClick();
  assert.equal(requests[0].tone, 'friendly', 'the other day retains its original tone');
  const previousDay = find(editor.render(), node => node.type === 'article' && node.key.includes('2026-10-03'));
  await find(previousDay, node => node.props?.onClick && node.props.children === '生成今日合集').props.onClick();
  assert.equal(requests[1].day, '2026-10-03');
  assert.equal(requests[1].tone, 'professional');
});

test('daily recap settings default to manual and submit opt-in plus the chosen tone', async () => {
  const calls = [], editor = view(components.DailyRecapSettingsForm, { root: 'library-a', act: async (action, args, after) => {
    calls.push({ action, args }); after({ dailyRecap: args.dailyRecap });
  } });
  editor.render(); editor.effects();
  let control = find(editor.render(), node => node.props?.name === 'automatic');
  assert.equal(control.props.checked, false);
  control.props.onChange(true);
  control = find(editor.render(), node => node.props?.name === 'tone');
  control.props.onChange({ target: { value: 'professional' } });
  await editor.render().props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'settings');
  assert.equal(calls[0].args.dailyRecap.automatic, true);
  assert.equal(calls[0].args.dailyRecap.tone, 'professional');
});

test('daily recap settings have translated usable controls in English', () => {
  ssr.setUiLanguage('en');
  const html = renderToStaticMarkup(React.createElement(ssr.DailyRecapSettingsForm, { root: 'library-a' }));
  assert.doesNotMatch(html, /[㐀-鿿]/);
  assert.match(html, /name="automatic"/);
  assert.match(html, /name="tone"/);
  ssr.setUiLanguage('zh');
});
