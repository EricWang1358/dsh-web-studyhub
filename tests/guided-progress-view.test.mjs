import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { build } from 'esbuild';
import React from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';

/* #543 / #544: the guided page shows the progress, the remaining-time range and the cost of the session the library really has.
   The session is read from a real library (study.session.get, what the panel polls) and handed to the real page view. */

const require = createRequire(import.meta.url);
const h = React.createElement;
const noop = () => {};

const entry = `export * from './ui/i18n.js';
  export { PAGE_VIEWS } from './ui/app/page-views.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyProgressPanel } from './ui/guided-study/StudyProgressPanel.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';`;

async function load(contents, plugins = []) {
  const compiled = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], loader: { '.css': 'text' }, plugins, logLevel: 'silent' });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
  return loaded.exports;
}
const m = await load(entry);
// The same page with the workbench replaced by a probe that prints the props the page gave it.
const probe = { name: 'probe', setup(b) {
  b.onResolve({ filter: /GuidedStudyWorkbench\.jsx$/ }, () => ({ path: 'probe', namespace: 'probe' }));
  b.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `
    import React from 'react';
    export default function Probe(props) { return <pre id="props">{JSON.stringify({ progress: props.progress, estimate: props.estimate, cost: props.cost, session: props.session?.id })}</pre>; }` }));
} };
const p = await load(entry, [probe]);

/** Server-render a tree that suspends on a lazy page and wait for all of it. */
function renderAll(tree) {
  return new Promise((resolve, reject) => {
    let html = '';
    const sink = new Writable({ write(chunk, _enc, done) { html += chunk; done(); } });
    const stream = renderToPipeableStream(tree, { onAllReady() { stream.pipe(sink); sink.on('finish', () => resolve(html)); }, onError: reject });
  });
}
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const card = (id, topic) => ({ id, kind: 'flashcard', topic, objective: `Know ${topic}`, prompt: `What is ${topic}?`, answer: 'A thing.', hint: 'Think.',
  explanation: 'Explained.', misconception: 'None.', citations: [{ sourceId: 'src-v', quote: 'View source text' }] });

async function liveSession(t) {
  const root = await mkdtemp(join(tmpdir(), 'guided-progress-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose());
  await study.call('snapshot');
  await study.call('source.add', { id: 'src-v', title: 'V', text: 'View source text for the view.', courses: ['CS101'] });
  await study.call('draft.save', { deck: { id: 'd-v', course: 'CS101', title: 'V deck', cards: [card('c1', 'One'), card('c2', 'Two'), card('c3', 'Three')] } });
  await study.call('draft.publish', { id: 'd-v' });
  const started = await study.call('study.session.start', { courseId: 'CS101', scope: [{ kind: 'deck', id: 'd-v' }], goal: { title: 'View goal', checkItems: [
    { id: 'k1', title: 'One', targetCardIds: ['c1'] }, { id: 'k2', title: 'Two', targetCardIds: ['c2'] }, { id: 'k3', title: 'Three', targetCardIds: ['c3'] }] } });
  await study.store.update((s) => {
    s.attempts.push({ id: 'a1', runId: 'r', quiz_id: 'c1', deckId: 'd-v', topic: 'One', timestamp: Date.now(), grade: 4, assessment: 'graded', elapsed_ms: 100000, assistance: { used: false } });
    s.studySessions.find((item) => item.id === started.id).usage = [{ kind: 'generation', at: 1, jobId: 'j1', cardId: 'c2', tokens: 6700,
      usage: { uncachedInputTokens: 4000, outputTokens: 700, cacheReadTokens: 2000, cacheWriteTokens: 0 } }];
  });
  return study.call('study.session.get', { sessionId: started.id });
}
const appFor = (guidedSession) => ({ data: { modelReady: true }, core: { call: async () => guidedSession, act: noop, refresh: noop }, nav: { navigate: noop },
  session: { run: null, enterRun: noop, actions: {} }, lib: { guidedSession, set: {} }, host: null });
const pageOf = (module, guidedSession) => h(module.AppContext.Provider, { value: appFor(guidedSession) }, h(module.PAGE_VIEWS.guided));

test('the guided page hands the panel the progress, the range and the cost that study.session.get read from the library', async (t) => {
  const session = await liveSession(t);
  assert.equal(session.progress.independentPassedCount, 1);
  assert.equal(session.estimate.status, 'estimated');
  assert.equal(session.cost.breakdown.generation.tokens, 6700);

  const html = await renderAll(pageOf(p, session));
  const props = JSON.parse(/<pre id="props">([^<]*)<\/pre>/.exec(html)[1].replace(/&quot;/g, '"'));
  assert.deepEqual(props, JSON.parse(JSON.stringify({ progress: session.progress, estimate: session.estimate, cost: session.cost, session: session.id })));
});

test('on the real page the learner reads the real progress and a range, never the placeholder', async (t) => {
  const session = await liveSession(t);
  m.setUiLanguage('zh');
  const html = text(await renderAll(pageOf(m, session)));
  assert.ok(html.includes(session.progress.displayLine), html);
  assert.match(html, /独立检验 1\/3（33%）/);
  assert.ok(html.includes(session.estimate.message), 'the line under the progress is the estimate, word for word');
  assert.match(html, /预计达到本次检验目标还需 \d+–\d+ 分钟（初步估计）/);
  assert.doesNotMatch(html, /还在估计|尚在估计/);
});

test('with nothing answered yet the page says 尚在估计 in the one wording, not a second one', async (t) => {
  const session = await liveSession(t);
  const none = { ...session, ...{ progress: { ...session.progress, independentPassedCount: 0 } }, estimate: { status: 'estimating', minMinutes: null, maxMinutes: null, remainingItems: 3 } };
  m.setUiLanguage('zh');
  const html = text(await renderAll(pageOf(m, none)));
  assert.match(html, /尚在估计，完成首个检验后更新/);
  assert.doesNotMatch(html, /还在估计/);
  assert.match(text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: {}, estimate: undefined }))), /尚在估计，完成首个检验后更新/, 'no estimate at all reads the same');
});

test('the workbench shows the derived progress of the session it was given, not the status of its check items', () => {
  m.setUiLanguage('zh');
  const session = { id: 's', courseId: 'C', status: 'active', goal: { title: 'g', checkItems: [{ id: 'k1', title: 'One', status: 'passed' }] },
    progress: { displayLine: '独立检验 0/1（0%）；1 项待检验', items: [{ id: 'k1', title: 'One', status: 'pending', evidenceAttemptIds: [] }], lectureCoveredCount: 0, nextDayDueCount: 0 } };
  const html = text(renderToStaticMarkup(h(m.GuidedStudyWorkbench, { session, run: null })));
  assert.match(html, /独立检验 0\/1（0%）；1 项待检验/);
  const unread = text(renderToStaticMarkup(h(m.GuidedStudyWorkbench, { session: { ...session, progress: undefined }, run: null })));
  assert.match(unread, /检验项共 1 项/, 'before the first read it claims no result');
  assert.doesNotMatch(unread, /已独立通过|独立检验 \d/);
});

test('the panel lists the four parts of the cost in tokens and the cost of an independently passed item, with no price', async (t) => {
  const session = await liveSession(t);
  m.setUiLanguage('zh');
  const html = text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: session.progress, estimate: session.estimate, cost: session.cost, defaultExpanded: true })));
  assert.match(html, /本次用量/);
  assert.match(html, /教学讲解与读现场：[^。]*DSH/, 'the main chat\'s own use is not measured here and says where to look');
  assert.match(html, /复用已有题：1 道，0 次模型调用/);
  assert.match(html, /新题生成与独立审核：6,700 tok/);
  assert.match(html, /QA 整理：复用讲解，0 额外模型调用/);
  assert.match(html, /每道独立通过的题平均：6,700 tok（不含主会话）/);
  assert.doesNotMatch(html, /\$|USD|¥|元|美元/);

  const pending = text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: { ...session.progress, independentPassedCount: 0 },
    cost: { ...session.cost, costPerIndependentCheckItem: 'pending_first_pass' }, defaultExpanded: true })));
  assert.match(pending, /每道独立通过的题的平均用量：做完第一道后计算/);

  const unknown = text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: session.progress,
    cost: { ...session.cost, breakdown: { ...session.cost.breakdown, generation: { tokens: null, measured: false } } }, defaultExpanded: true })));
  assert.match(unknown, /新题生成与独立审核：用量未知，没有计入/);
});

test('the English page says the same things in English', async (t) => {
  const session = await liveSession(t);
  m.setUiLanguage('en');
  t.after(() => m.setUiLanguage('zh'));
  const html = text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: session.progress, estimate: session.estimate, cost: session.cost, defaultExpanded: true })));
  assert.match(html, /About \d+–\d+ minutes left to reach this check goal \(rough estimate\)/);
  assert.match(html, /Cost this session/);
  assert.match(html, /Writing and reviewing new questions: 6,700 tok/);
  assert.match(html, /Average per independently passed question: 6,700 tok \(without the main chat\)/);
  const none = text(renderToStaticMarkup(h(m.StudyProgressPanel, { progress: {}, estimate: { status: 'estimating' } })));
  assert.match(none, /Still estimating; updated after your first check/);
});
