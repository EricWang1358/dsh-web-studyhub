/* 练习点评 (settings.practice.debrief): on by default, one light-model call for a round of 3 or more answers; switched off, coach.debrief makes NO model call
   and still returns the parts that need none (the measured split, the rule-based insights, headline and next step). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

const source = { id: 'src', title: 'Memento notes',
  text: 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.' };
const quiz = (n, prompt) => ({ id: `q${n}`, kind: 'quiz', topic: 'Memento', objective: `objective ${n}`, prompt, answer: 'Caretaker', hint: 'Who keeps the history?',
  explanation: 'The Caretaker keeps history; the Originator restores state.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It manages history without reading snapshots.' },
    { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot, not its manager.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It creates and restores snapshots.' }] });
const prompts = ['Memento 模式中哪个角色管理历史？', 'Caretaker 和 Memento 的区别是什么？', '为什么 Caretaker 不读取快照内容？', 'Originator 负责哪一步？', '谁创建快照？'];

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-practice-debrief-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [];
  const light = createFakeModel({ log });
  const service = new StudyService(root, { complete: light, completeLight: light, coach: true, ...switchOptions(SWITCH_MODE, { complete: light, paths: ['coach'] }) });
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: prompts.map((prompt, at) => quiz(at + 1, prompt)) } });
  await new StudyService(root).call('draft.publish', { id: 'd' });
  return { service, log };
}
async function finishedRun(service, answers = 5) {
  let run = await service.call('review.start', { deckId: 'd', mode: 'quiz' });
  for (let at = 0; at < answers; at++) {
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((option) => option.text === 'Caretaker').id] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}
const modelCalls = (log) => log.filter((entry) => entry.prompt.includes('本轮指标')).length;

test('on by default: a round of three or more answers asks the light model once', async (t) => {
  const { service, log } = await setup(t);
  const run = await finishedRun(service);
  const debrief = await service.call('coach.debrief', { runId: run.id });
  assert.equal(modelCalls(log), 1);
  assert.equal(debrief.headline, '概念会了，别停在纸上谈兵', 'the model phrased the headline');
});

test('switched off: no model call at all, and the measured parts are still there', async (t) => {
  const { service, log } = await setup(t);
  await service.call('coach.consent', { prep: true });
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const run = await finishedRun(service);
  const debrief = await service.call('coach.debrief', { runId: run.id });
  assert.equal(log.length, 0, 'nothing was sent to any model: not the debrief, not a queued preparation');
  assert.equal(debrief.metrics.answered, 5);
  assert.equal(debrief.metrics.gradedCorrect, 5);
  assert.equal(debrief.insights[0].code, 'concept-only');
  assert.equal(debrief.preparing, false, 'a preparation is a model call too, and this switch promised none');
  assert.ok(debrief.headline && debrief.why, 'the rule-based advice is shown instead of the model sentence');
  assert.notEqual(debrief.headline, '概念会了，别停在纸上谈兵');
  assert.equal(debrief.next, 'continue_path');
  assert.equal((await service.call('export')).learner.summary || '', '', 'the profile summary is only ever written by the model call');
});

test('the switch is read when the debrief is made: turning it on again brings the model sentence back for the next round', async (t) => {
  const { service, log } = await setup(t);
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const first = await finishedRun(service);
  await service.call('coach.debrief', { runId: first.id });
  assert.equal(modelCalls(log), 0);
  await service.call('settings.practice.reset');
  const second = await finishedRun(service);
  await service.call('coach.debrief', { runId: second.id });
  assert.equal(modelCalls(log), 1);
});

test('a debrief already made keeps being served after the switch goes off, without a new call', async (t) => {
  const { service, log } = await setup(t);
  const run = await finishedRun(service);
  const made = await service.call('coach.debrief', { runId: run.id });
  await service.call('settings.practice.set', { patch: { debrief: false } });
  const again = await service.call('coach.debrief', { runId: run.id });
  assert.equal(again.at, made.at);
  assert.equal(modelCalls(log), 1);
});

test('#45: CoachDebrief pauses auto-advance while hovered and cancels countdown on Escape', async (t) => {
  const React = (await import('react')).default;
  const { loadUi } = await import('./helpers/ui-module.mjs');
  const { readFileSync } = await import('node:fs');
  const m = await loadUi(`
    export { default as CoachDebrief } from './ui/CoachDebrief.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage, uiCatalogue } from './ui/i18n.js';
  `);
  Object.assign(m.uiCatalogue(), JSON.parse(readFileSync(new URL('../ui/locales/en.polish-results.json', import.meta.url), 'utf8')));

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map();
  const prevWindow = globalThis.window;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  };

  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  let tree = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const debriefInitial = {
    headline: '不错',
    why: '保持节奏',
    next: 'continue_path',
    metrics: { answered: 3, gradedAnswered: 3, gradedCorrect: 3, selfAnswered: 0, selfMet: 0, levels: {} },
    insights: [],
    status: { enabled: true, consent: true, ready: 0, preparing: false },
  };
  let actions = 0;
  const props = { run: { id: 'run-debrief', answered: 3 }, initial: debriefInitial, autopilot: true, onContinue: () => { actions++; } };
  const render = () => {
    cursor = 0;
    pending = [];
    const prev = internals.H;
    internals.H = {
      useContext: (ctx) => (ctx === m.StudyServicesContext ? { call: () => new Promise(() => {}), busy: false } : ctx._currentValue),
      useState: (init) => {
        const i = cursor++;
        if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
          hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
        }];
        return hooks[i];
      },
      useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
      useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
      useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:cd${i}:`; return hooks[i]; },
      useDeferredValue: (v) => v,
      useSyncExternalStore: (_sub, getSnap) => getSnap(),
    };
    try { tree = m.CoachDebrief(props); } finally { internals.H = prev; }
    for (const eff of pending) {
      cleanups[eff.i]?.();
      cleanups[eff.i] = undefined;
      const done = eff.fn();
      hooks[eff.i] = { deps: eff.deps };
      if (typeof done === 'function') cleanups[eff.i] = done;
    }
    return tree;
  };
  const nodeText = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(nodeText).join('');
    return typeof node === 'object' && node.props ? nodeText(node.props.children) : '';
  };
  const findClass = (node, cls) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const c of node) { const r = findClass(c, cls); if (r) return r; } return null; }
    if (node.props?.className?.split(/\s+/).includes(cls)) return node;
    return findClass(node.props?.children, cls);
  };

  try {
    m.setUiLanguage('zh');
    render();
    tree = render();
    let status = findClass(tree, 'coach-countdown');
    assert.ok(status, 'countdown renders initially');
    assert.doesNotMatch(nodeText(status), /已暂停/);

    t.mock.timers.tick(1000);
    tree = render();
    const afterOneSec = nodeText(findClass(tree, 'coach-countdown'));
    assert.match(afterOneSec, /4 秒/, 'countdown ticks down while not hovered');

    tree.props.onMouseEnter();
    tree = render();
    status = findClass(tree, 'coach-countdown');
    assert.match(nodeText(status), /（已暂停）/, 'hovering pauses countdown and shows indicator');

    t.mock.timers.tick(3000);
    tree = render();
    assert.match(nodeText(findClass(tree, 'coach-countdown')), /4 秒/, 'timer did not advance while hovered');
    assert.equal(actions, 0);

    m.setUiLanguage('en');
    tree = render();
    assert.match(nodeText(findClass(tree, 'coach-countdown')), /\(paused\)/, 'English pause suffix');
    m.setUiLanguage('zh');

    tree.props.onMouseLeave();
    tree = render();
    assert.doesNotMatch(nodeText(findClass(tree, 'coach-countdown')), /已暂停/);
    t.mock.timers.tick(1000);
    tree = render();
    assert.match(nodeText(findClass(tree, 'coach-countdown')), /3 秒/, 'countdown resumes after mouse leave');

    for (const fn of listeners.get('keydown') || []) fn({ key: 'Escape' });
    tree = render();
    assert.equal(findClass(tree, 'coach-countdown'), null, 'Escape cancels countdown');
    t.mock.timers.tick(5000);
    assert.equal(actions, 0, 'cancelled countdown never fires action');
  } finally {
    for (const c of cleanups) c?.();
    m.setUiLanguage('zh');
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
  }
});

