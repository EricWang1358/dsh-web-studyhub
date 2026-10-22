/* 3.6 D2: the first-run line, 配模型 → 加资料 → 做第一组. firstRunLine (ui/first-run/line.js) reads the step and its state off the snapshot (the sample course never
   counts, the line is gone once a deck of the learner's own is published), and FirstRunLine draws it with one sentence per row, a body only on the open step
   and at most one primary button in it; the compact card after 以后再说 is the same component. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export * from './ui/first-run/line.js';
  export { default as FirstRunLine, stepSentence, compactAction, generateBlockReason } from './ui/first-run/FirstRunLine.jsx';
  export { firstDeckSummary, firstDeckBlock } from './ui/first-run/use-first-deck.js';
  export { startGeneration } from './ui/generate-start.js';
  export { estimateRequestOf, generationRequest, summaryLine, selectionStats } from './ui/generate-form.js';
  export { generationFormDefaults } from './ui/generation-status.js';
  export { importForLine, importHandoff } from './ui/app/import-handoff.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const primaries = (markup) => (markup.match(/sh-btn--primary/g) || []).length;
const READY = { ready: true, reason: 'ok', label: 'DeepSeek · V4 Flash' };
const NO_KEY = { ready: false, reason: 'no-credential', label: 'DeepSeek · V4 Flash' };
const NOTHING = { ready: false, reason: 'no-route', label: '' };
const SAMPLE = { loaded: true, course: '示例课程 · 设计模式', deckId: 'sample-deck', draftId: 'sample-draft', sourceId: 'sample-src' };
const library = (extra = {}) => ({ root: '/lib', model: READY, decks: [], sources: [], drafts: [], jobs: [], ...extra });
const mine = { id: 's1', title: '第3讲 进程与线程' };
const draft = { id: 'd1', title: '第3讲 · 题组', cards: [{ id: 'c1' }] };
const job = (status, extra = {}) => ({ id: `j-${status}`, type: 'generate', status, sourceIds: ['s1'], ...extra });
const ids = (line) => line.steps.map((step) => `${step.id}:${step.status}`);
const on = { recheck: noop, openModelSettings: noop, importFirst: noop, importMore: noop, generate: noop, publish: noop, openDraft: noop, startSample: noop, later: noop };
const page = (line, props = {}) => renderToStaticMarkup(h(m.FirstRunLine, { line, form: 'page', sample: { loaded: false }, on, ...props }));
const compact = (line, props = {}) => renderToStaticMarkup(h(m.FirstRunLine, { line, form: 'compact', todayLabel: '10月22日周四', on, ...props }));

test('the line walks model, material, deck and opens one step at a time', () => {
  assert.deepEqual(m.FIRST_RUN_STEPS, ['model', 'material', 'deck']);
  const none = m.firstRunLine(library({ model: NOTHING }));
  assert.equal(none.show, true);
  assert.equal(none.step, 0, 'no model: the model step is open');
  assert.deepEqual(ids(none), ['model:todo', 'material:todo', 'deck:waiting']);
  const ready = m.firstRunLine(library());
  assert.equal(ready.step, 1, 'a model and no material: the material step');
  assert.equal(ready.steps[0].verified, true);
  assert.equal(ready.steps[0].label, 'DeepSeek · V4 Flash');
  const material = m.firstRunLine(library({ sources: [{ id: 'old', title: '旧讲义' }, mine] }));
  assert.equal(material.step, 2);
  assert.deepEqual(ids(material), ['model:done', 'material:done', 'deck:ready']);
  assert.equal(material.steps[1].title, '第3讲 进程与线程', 'the newest material names the step');
  assert.equal(material.steps[1].count, 2);
  assert.deepEqual(material.steps[2].sourceIds, ['old', 's1'], '出第一组题 ticks every material of the learner');
  const pdf = m.firstRunLine(library({ sources: [1, 2, 3].map((page) => ({ id: `p${page}`, title: `讲义.pdf · p.${page}`, text: 'x', document: { id: 'pdf', page, format: 'pdf' } })) }));
  assert.equal(pdf.steps[1].count, 1, 'a PDF is one material, not one per page');
  assert.doesNotMatch(pdf.steps[1].title, /p\.\d/, 'named as 资料 names the document, not by its last page');
  const noModelYet = m.firstRunLine(library({ model: NO_KEY, sources: [mine] }));
  assert.equal(noModelYet.step, 0, 'the material came first (step 2 is never locked); the model is still the open step');
  assert.deepEqual(ids(noModelYet), ['model:todo', 'material:done', 'deck:ready']);
  assert.equal(noModelYet.steps[2].modelReady, false);
});

test('the third step: a run, a run that ended, a draft to publish at once, a draft to look at first', () => {
  const generating = m.firstRunLine(library({ sources: [mine], jobs: [job('running')] }));
  assert.equal(generating.steps[2].status, 'generating');
  assert.deepEqual(generating.steps[2].jobIds, ['j-running'], 'the step carries the run\'s card');
  assert.equal(generating.step, 2);
  const failed = m.firstRunLine(library({ sources: [mine], jobs: [job('failed')] }));
  assert.equal(failed.steps[2].status, 'failed');
  assert.deepEqual(failed.steps[2].jobIds, ['j-failed']);
  assert.equal(m.firstRunLine(library({ sources: [mine], jobs: [job('failed', { continuedBy: 'j2' })] })).steps[2].status, 'ready', 'a run continued elsewhere is not the story');
  assert.equal(m.firstRunLine(library({ sources: [mine], jobs: [job('complete')] })).steps[2].status, 'ready', 'a finished run whose draft is gone: start again');
  const drafted = library({ sources: [mine], drafts: [draft], jobs: [job('complete', { draftId: 'd1' })] });
  assert.equal(m.firstRunLine(drafted).steps[2].status, 'draft-review', 'until the coverage says the draft is clean, it is looked at first');
  assert.deepEqual(m.firstRunLine(drafted).steps[2].jobIds, [], 'a draft is the step\'s own button, not the run\'s card');
  const clean = m.firstRunLine(drafted, { publishAtOnce: true });
  assert.equal(clean.steps[2].status, 'draft-clean');
  assert.equal(clean.steps[2].draft.id, 'd1');
  assert.equal(m.firstRunLine(library({ sources: [mine], drafts: [draft], jobs: [job('running', { draftId: 'd1' })] })).steps[2].status, 'generating', 'a fill running on the draft is still a run');
  const noModel = m.firstRunLine(library({ model: NOTHING, sources: [mine], drafts: [draft] }));
  assert.equal(noModel.step, 2, 'a draft waits in step 3 even without a model: publishing needs none');
  // Jobs the line does not carry: an audio import, a PDF conversion, a publication, a selection supplement.
  for (const other of [{ type: 'audio-import' }, { type: 'pdf-convert' }, { type: 'draft-publish' }, { type: 'generate', origin: 'selection' }])
    assert.equal(m.firstRunLine(library({ sources: [mine], jobs: [job('running', other)] })).steps[2].status, 'ready', JSON.stringify(other));
});

test('a first run that ended badly but left a draft: the run is the story, not 「第一组题出好了」', () => {
  m.setUiLanguage('zh');
  // A refused key, 停止, a host that went away: the draft holds what passed, and the run's card (its one honest action) is what step 3 carries.
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const line = m.firstRunLine(library({ sources: [mine], drafts: [draft], jobs: [job(status, { draftId: 'd1' })] }));
    assert.equal(line.steps[2].status, 'stopped', status);
    assert.deepEqual(line.steps[2].jobIds, [`j-${status}`], `${status}: the step carries the run's card`);
    assert.equal(line.step, 2);
    assert.equal(m.stepSentence(line.steps[2]), '第一组题没有出完', status);
    // Even when the coverage would call the draft clean, a run that ended badly is not 「出好了」.
    assert.equal(m.firstRunLine(library({ sources: [mine], drafts: [draft], jobs: [job(status, { draftId: 'd1' })] }), { publishAtOnce: true }).steps[2].status, 'stopped', `${status} + clean`);
  }
  // A run that finished but short: the shortfall's action (接着做, 去配置模型, 继续, 为没覆盖的部分补题) says the run stands.
  for (const action of ['continue', 'model-settings', 'resume', 'topup']) {
    const line = m.firstRunLine(library({ sources: [mine], drafts: [draft], jobs: [job('complete', { draftId: 'd1' })] }), { shortfallAction: action });
    assert.equal(line.steps[2].status, 'stopped', action);
    assert.deepEqual(line.steps[2].jobIds, ['j-complete'], action);
  }
  // Short, and the run's card was put away (知道了): the draft is the way on, still not 「出好了」.
  const gone = m.firstRunLine(library({ sources: [mine], drafts: [draft] }), { shortfallAction: 'continue' });
  assert.equal(gone.steps[2].status, 'stopped');
  assert.deepEqual(gone.steps[2].jobIds, []);
  // What stays as it was: a run continued by another one, a clean finish, a draft with no shortfall action.
  const continued = library({ sources: [mine], drafts: [draft], jobs: [job('failed', { draftId: 'd1', continuedBy: 'j2' })] });
  assert.equal(m.firstRunLine(continued).steps[2].status, 'draft-review', 'a continued run is not the story');
  const done = library({ sources: [mine], drafts: [draft], jobs: [job('complete', { draftId: 'd1' })] });
  assert.equal(m.firstRunLine(done, { shortfallAction: null }).steps[2].status, 'draft-review');
  assert.equal(m.firstRunLine(done, { publishAtOnce: true, shortfallAction: null }).steps[2].status, 'draft-clean');
  // The run of another draft (or none) does not speak for this one.
  const other = library({ sources: [mine], drafts: [draft], jobs: [job('failed', { draftId: 'elsewhere' })] });
  assert.equal(m.firstRunLine(other).steps[2].status, 'draft-review');
});

test('a run that stands is drawn as its card: no 「出好了」 body, no second primary; the compact card leaves the action to the card', () => {
  m.setUiLanguage('zh');
  const refused = m.firstRunLine(library({ sources: [mine], drafts: [draft], jobs: [job('failed', { draftId: 'd1' })] }));
  const markup = page(refused, { jobs: h('div', { className: 'cjc' }, h('button', { className: 'sh-btn sh-btn--primary' }, '去配置模型')) });
  assert.match(markup, /class="cjc"/, 'the run\'s card is inside step 3');
  assert.doesNotMatch(text(markup), /第一组题出好了|发布前先在草稿页看一遍/);
  assert.doesNotMatch(markup, /data-first-run="(review|publish)"/, 'no 检查草稿 or 发布并开始练 of the step beside the card');
  assert.equal(primaries(markup), 1, 'the card\'s own action is the one primary');
  assert.equal(m.compactAction(refused, on), null, 'the compact card does not say 检查草稿 over a run that stands');
  assert.match(text(compact(refused)), /第一组题没有出完/);
  assert.doesNotMatch(text(compact(refused)), /第一组题出好了|检查草稿/);
  // The card was put away: the step's way on is the draft (its page says what is missing and continues it).
  const gone = m.firstRunLine(library({ sources: [mine], drafts: [draft] }), { shortfallAction: 'continue' });
  const alone = page(gone);
  assert.equal(primaries(alone), 1);
  assert.match(alone, /data-first-run="review"[^>]*>检查草稿</);
  assert.doesNotMatch(text(alone), /第一组题出好了/);
  assert.equal(m.compactAction(gone, on).label, '检查草稿');
});

test('the compact card offers no button that belongs to another step than the one it marks', () => {
  m.setUiLanguage('zh');
  // No model yet, a material added: the model is the step marked, so 出第一组题 (which would open a form whose generate button is greyed) is not offered.
  for (const data of [library({ model: NO_KEY, sources: [mine] }), library({ model: NOTHING, sources: [mine] }), library({ model: NOTHING })]) {
    const line = m.firstRunLine(data);
    assert.equal(line.step, 0);
    assert.equal(m.compactAction(line, on), null, JSON.stringify(data.model));
    const markup = compact(line);
    assert.equal(primaries(markup), 0);
    assert.match(markup, /data-step="model"[^>]*aria-current="step"/);
  }
});

test('the sample course never counts, and the line is gone once a deck of the learner\'s own is published', () => {
  const sampleOnly = library({ sample: SAMPLE, decks: [{ id: 'sample-deck', sample: true }], sources: [{ id: 'sample-src', sample: true, title: '示例讲义' }],
    drafts: [{ id: 'sample-draft', sample: true, cards: [] }], jobs: [job('running', { draftId: 'sample-draft' })] });
  const line = m.firstRunLine(sampleOnly);
  assert.equal(line.show, true, 'a loaded sample is not the learner\'s library');
  assert.deepEqual(ids(line), ['model:done', 'material:todo', 'deck:waiting'], 'its material, draft and run tick nothing');
  assert.equal(m.firstRunLine(library({ sample: { ...SAMPLE, loaded: false }, sources: [{ id: 'sample-src' }] })).steps[1].status, 'todo', 'known by its ids too');
  assert.equal(m.firstRunDraft(sampleOnly), null);
  const published = m.firstRunLine(library({ sources: [mine], decks: [{ id: 'deck-1' }] }));
  assert.deepEqual(published, { show: false, step: -1, steps: [] });
  assert.equal(m.firstRunLine(library({ decks: [{ id: 'coach', systemKind: 'coach' }] })).show, true, 'a deck the app made itself is not one');
  assert.equal(m.firstRunLine(null).show, false);
});

test('one sentence per row, in both languages', () => {
  m.setUiLanguage('zh');
  const [model, material, deck] = m.firstRunLine(library({ sources: [mine] })).steps;
  assert.equal(m.stepSentence(model), '已连接：DeepSeek · V4 Flash');
  assert.equal(m.stepSentence({ ...model, verified: false }), '已选择模型：DeepSeek · V4 Flash', 'a DSH that cannot tell is not called connected');
  assert.equal(m.stepSentence(material), '第3讲 进程与线程 · 已添加');
  assert.equal(m.stepSentence({ ...material, count: 3 }), '第3讲 进程与线程 等 3 份资料 · 已添加');
  assert.equal(m.stepSentence(deck), '用资料出第一组题');
  m.setUiLanguage('en');
  try {
    for (const status of m.DECK_STATES) assert.doesNotMatch(m.stepSentence({ ...deck, status }), han, status);
    assert.doesNotMatch(m.stepSentence({ id: 'model', status: 'todo' }) + m.stepSentence({ id: 'material', status: 'todo' }), han);
  } finally { m.setUiLanguage('zh'); }
});

test('the page form: only the open step has a body, with at most one primary button, and no step bounces to the settings', () => {
  m.setUiLanguage('zh');
  // No model: the gate's own steps in place, 重新检查 as the one primary, the settings only as a quiet link inside the step that picks a model.
  const none = page(m.firstRunLine(library({ model: NOTHING })));
  assert.equal(primaries(none), 1);
  assert.match(none, /data-body="model"/);
  assert.equal((none.match(/data-body=/g) || []).length, 1, 'one open step');
  assert.match(text(none), /在 DSH 打开「设置 › 模型」，选一个服务商，填入它的 API Key 并保存/);
  assert.match(text(none), /去哪拿 Key、要不要充值：看/, 'where to get a key, said once');
  assert.match(text(none), /选一个模型：在对话输入框的模型选择器里选.*前往设置/, 'the quiet settings link sits inside the step that picks a model');
  assert.equal((text(none).match(/前往设置/g) || []).length, 1, 'and nowhere else');
  assert.match(none, />重新检查</);
  assert.match(text(none), /回到这里，这一步会自己打勾；没有变就点「重新检查」/);
  assert.match(none, /class="sh-btn sh-btn--link[^"]*"[^>]*>添加资料</, 'the material step is never locked: a quiet 添加资料 on its row');
  // A missing key: only the key step (no model to pick), and no settings link at all.
  const noKey = page(m.firstRunLine(library({ model: NO_KEY })));
  assert.match(text(noKey), /在「DeepSeek」卡片填入 API Key 并保存/);
  assert.doesNotMatch(text(noKey), /前往设置/);
  // Every state of the line: one primary at most, the bottom's two quiet links, no title=.
  const states = [
    library(), library({ sources: [mine] }), library({ sources: [mine], jobs: [job('running')] }),
    library({ sources: [mine], drafts: [draft] }),
  ];
  for (const data of states) {
    const markup = page(m.firstRunLine(data), { jobs: h('div', { className: 'cjc' }, 'card') });
    assert.ok(primaries(markup) <= 1, `one primary at most: ${markup.slice(0, 120)}`);
    assert.doesNotMatch(markup, / title="/, 'explanations are Tooltips, never title=');
    assert.match(markup, /载入示例并开始导览/);
    assert.match(markup, />以后再说</);
  }
  const material = page(m.firstRunLine(library()));
  assert.match(material, /data-first-run="import"[^>]*>|>添加资料</);
  assert.match(text(material), /网页文件（\.html）/, 'the formats the hub takes, in the step that takes them');
  const ready = page(m.firstRunLine(library({ sources: [mine] })));
  assert.match(ready, /data-first-run="generate"/);
  assert.match(ready, />出第一组题</);
  assert.match(ready, />再加一份</, 'an added material can have a second one, quietly');
  const running = page(m.firstRunLine(library({ sources: [mine], jobs: [job('running')] })), { jobs: h('div', { className: 'cjc' }, 'card') });
  assert.equal(primaries(running), 0, 'a run in progress has nothing to press but its own card');
  assert.match(running, /class="cjc"/, 'the run\'s card is inside the third step');
  assert.doesNotMatch(running, /查看进度/);
  const clean = page(m.firstRunLine(library({ sources: [mine], drafts: [draft] }), { publishAtOnce: true }));
  assert.match(clean, /sh-btn--primary[^>]*data-first-run="publish"/);
  assert.match(clean, />发布并开始练</);
  assert.match(clean, />先看看草稿</);
  const review = page(m.firstRunLine(library({ sources: [mine], drafts: [draft] })));
  assert.match(review, /data-first-run="review"/);
  assert.match(review, />检查草稿</);
  assert.doesNotMatch(review, /发布并开始练<\/button>/);
  // The sample link needs a host with a sample that is not loaded.
  assert.doesNotMatch(page(m.firstRunLine(library()), { sample: null }), /载入示例并开始导览/);
  assert.doesNotMatch(page(m.firstRunLine(library()), { sample: { loaded: true } }), /载入示例并开始导览/, 'a loaded sample has its banner');
});

test('the compact card (以后再说) is the same line: three rows and the open step\'s one button', () => {
  m.setUiLanguage('zh');
  const cases = [
    [library(), '添加资料'], [library({ model: NOTHING }), null], [library({ sources: [mine] }), '出第一组题'],
    [library({ sources: [mine], jobs: [job('running')] }), null], [library({ sources: [mine], drafts: [draft] }), '检查草稿'],
  ];
  for (const [data, label] of cases) {
    const markup = compact(m.firstRunLine(data));
    assert.equal((markup.match(/class="frl-step"/g) || []).length, 3);
    assert.doesNotMatch(markup, /data-body=/, 'no bodies in the card');
    assert.equal(primaries(markup), label ? 1 : 0);
    if (label) assert.equal(m.compactAction(m.firstRunLine(data), on).label, label);
    assert.match(markup, /today-card/);
  }
  assert.equal(m.compactAction(m.firstRunLine(library({ sources: [mine], drafts: [draft] }), { publishAtOnce: true }), on).label, '发布并开始练');
  assert.equal(m.compactAction(m.firstRunLine(library()), {}), null, 'no handler, no dead button');
});

test('English: the whole line has no Chinese left', () => {
  m.setUiLanguage('en');
  try {
    for (const data of [library({ model: NOTHING }), library({ model: NO_KEY }), library(), library({ sources: [{ id: 's1', title: 'Lecture 3' }] }),
      library({ sources: [{ id: 's1', title: 'Lecture 3' }], drafts: [{ ...draft, title: 'Deck' }] }),
      library({ sources: [{ id: 's1', title: 'Lecture 3' }], drafts: [{ ...draft, title: 'Deck' }], jobs: [job('failed', { draftId: 'd1' })] })]) {
      for (const markup of [page(m.firstRunLine(data)), page(m.firstRunLine(data, { publishAtOnce: true })), compact(m.firstRunLine(data), { todayLabel: 'Thu 22 Oct' })])
        assert.doesNotMatch(text(markup), han, text(markup).slice(0, 200));
    }
  } finally { m.setUiLanguage('zh'); }
});

test('the library home draws the line: the whole first screen, or the compact card after 以后再说; the welcome page and the starter are gone', async () => {
  const read = (file) => readFile(file, 'utf8');
  const [views, map, today, welcome, tour] = await Promise.all(['ui/app/page-views.jsx', 'ui/StudyMap.jsx', 'ui/study-map/TodayCard.jsx', 'ui/Welcome.jsx', 'ui/app/use-tour.js'].map(read));
  assert.match(views, /const linePage = lineShown && !tour\.tourStep && !tour\.lineLater;/);
  assert.match(views, /firstRun=\{firstRun\}/);
  assert.doesNotMatch(views, /<Welcome /);
  assert.match(map, /line\.show && firstRun\?\.form === "page"/);
  assert.match(map, /<FirstRunLine line=\{line\} form="compact"/);
  assert.doesNotMatch(today, /starter-steps|plan\.kind === 'empty'/);
  assert.doesNotMatch(welcome, /export default/, 'only the sample banner is left of the welcome page');
  assert.doesNotMatch(tour, /showWelcome/);
  assert.doesNotMatch(tour.slice(tour.indexOf('function startTour'), tour.indexOf('const startFullTour')), /hideWelcome\(\)/, 'a tour does not put the line away');
  // 载入示例并开始导览: the sample banner does not slide in above the line while the sample loads for the tour (the tour's home replaces the page as a whole).
  assert.match(views, /data\.sample\?\.loaded && !\(linePage && tour\.sampleForTour\) && <SampleBanner/);
  assert.match(tour, /setSampleForTour\(true\)/);
  // The draft's shortfall reaches the line: a run that came out short stands over its draft.
  assert.match(await read('ui/first-run/use-first-run-line.js'), /shortfallAction: shortfall\?\.action/);
});

/* ---------- 3.6 D4: the first deck from the line itself (option A) ---------- */

const PLAN = { summary: '将从 1 份资料出 12 题 · 混合难度 · 中文 · 单选测验', estimate: { status: 'ready', estimate: { totalTokens: { low: 11100, high: 14300 }, calls: { low: 3, high: 4 } } }, block: '' };
const generateButton = (markup) => markup.match(/<button[^>]*data-first-run="generate"[^>]*>/)[0];

test('step 3 says what will be made and its estimate before anything is spent; 出第一组题 is the one primary, 改题型和题数 a quiet link', () => {
  m.setUiLanguage('zh');
  const ready = m.firstRunLine(library({ sources: [mine] }));
  const markup = page(ready, { plan: PLAN, on: { ...on, tune: noop } });
  assert.match(markup, /data-first-run="plan"/);
  assert.match(text(markup), /将从 1 份资料出 12 题 · 混合难度 · 中文 · 单选测验/, '创建题组\'s summary sentence and the types');
  assert.match(text(markup), /预计 11\.1K–14\.3K tok · 3–4 次模型调用/, 'the estimate line, 创建题组\'s own');
  assert.ok(markup.indexOf('data-first-run="plan"') < markup.indexOf('data-first-run="generate"'), 'the estimate stands above the button that spends');
  assert.equal(primaries(markup), 1);
  assert.match(markup, /sh-btn--primary[^>]*data-first-run="generate"[^>]*>出第一组题</);
  assert.doesNotMatch(generateButton(markup), /disabled/, 'pressable');
  assert.match(markup, /class="sh-btn sh-btn--link[^"]*"[^>]*data-first-run="tune"[^>]*>改题型和题数</);
  assert.doesNotMatch(text(markup), /在「创建题组」里，这份资料已经勾好/, 'the line no longer sends the learner to the form first');
  assert.doesNotMatch(markup.replace(/<button[^>]*token-estimate__info[^>]*>/g, ''), / title="/, 'no title= of the line\'s own (the estimate\'s icon button is 创建题组\'s, shared)');
  // While the estimate is asked its room is held (the ghost line), so its arrival moves nothing.
  const asking = page(ready, { plan: { ...PLAN, estimate: { status: 'loading' } } });
  assert.match(asking, /token-estimate__ghost/);
  assert.match(text(asking), /正在估算…/);
});

test('出第一组题 is disabled with the reason while no model is usable or the selection needs 创建题组', () => {
  m.setUiLanguage('zh');
  // No model: the open step is the model (step 1), but a third step drawn open still never offers a button that fails 20 seconds later.
  const line = m.firstRunLine(library({ model: NO_KEY, sources: [mine] }));
  const markup = page({ ...line, step: 2 }, { plan: PLAN });
  assert.match(generateButton(markup), /disabled/);
  assert.match(markup, /data-first-run="blocked"[^>]*>还没有可用的 AI 模型，先完成第 1 步。</);
  assert.equal(m.compactAction(line, on), null, 'the compact card offers nothing over a missing model');
  const big = page(m.firstRunLine(library({ sources: [mine] })), { plan: { ...PLAN, block: 'too-big' } });
  assert.match(generateButton(big), /disabled/);
  assert.match(text(big), /超过一次出题的上限：点「改题型和题数」/);
  assert.equal(m.generateBlockReason({ modelReady: true }, PLAN), '');
  assert.match(m.generateBlockReason({ modelReady: true }, { block: 'reference' }), /参考样题/);
  // The pure test behind it: a selection over the one-run limit is 'too-big'; sample questions that overlap the materials are 'reference'.
  const huge = { id: 'h', title: '教材', text: 'x'.repeat(2_000_000) };
  assert.equal(m.firstDeckBlock({ sources: [huge], sourceIds: ['h'], gen: {} }), 'too-big');
  assert.equal(m.firstDeckBlock({ sources: [mine], sourceIds: ['s1'], gen: {} }), '');
  assert.equal(m.firstDeckBlock({ sources: [mine, { id: 'r', text: 'q' }], sourceIds: ['s1', 'r'], gen: { referenceSourceIds: ['r'] } }), 'reference');
});

test('the line\'s summary is 创建题组\'s summary sentence plus the types, and its request and estimate are the form\'s own', async () => {
  m.setUiLanguage('zh');
  const gen = m.generationFormDefaults({});
  const data = library({ sources: [{ ...mine, text: '进程是资源分配的单位。'.repeat(40) }] });
  const sentence = m.summaryLine({ ...m.selectionStats(data.sources, ['s1']), count: 12, difficulty: gen.difficulty, language: gen.language });
  assert.equal(m.firstDeckSummary({ data, gen, sourceIds: ['s1'], goal: 12 }), `${sentence} · 单选测验`);
  assert.match(m.firstDeckSummary({ data, gen, sourceIds: ['s1'] }), /^将从 1 份资料出题/, 'before the estimate: no number made up');
  assert.equal(m.firstDeckSummary({ data, gen, sourceIds: [] }), '');
  // The estimate request is the one 创建题组 asks with (estimateRequestOf), and 创建题组 uses it too.
  const request = m.estimateRequestOf(gen, { course: '', sourceIds: ['s1'] });
  assert.equal(request.feature, 'generate');
  assert.deepEqual(request.sourceIds, ['s1']);
  assert.equal(request.coverageLevel, 'standard');
  const [form, hook, views] = await Promise.all(['ui/Generate.jsx', 'ui/first-run/use-first-deck.js', 'ui/app/page-views.jsx'].map((file) => readFile(file, 'utf8')));
  assert.match(form, /estimateRequestOf\(gen, \{ course: generationCourse, sourceIds: selectedSources, reasoningEffort \}\)/);
  assert.match(form, /startGeneration\(\{ act, notify, setGen, data, gen, course: generationCourse, sourceIds: selectedSources,/);
  assert.match(hook, /useUsageEstimate\(call, request,/);
  assert.match(hook, /startGeneration\(\{ act, notify, setGen, data, gen, course, sourceIds \}\)/);
  // The app hands the line its request and the quiet way to the form; nothing starts a run but the button.
  assert.match(views, /generate: firstDeck\.start, tune: \(sourceIds\) => intents\.goGenerate\(\{ sourceIds, remember: true \}\)/);
  assert.match(views, /plan: firstDeck/);
  assert.doesNotMatch(hook, /useEffect/, 'no effect: the run is never started by itself');
});

test('出第一组题 sends 创建题组\'s request, says so, and starts the next deck from a clean form', async () => {
  m.setUiLanguage('zh');
  const sent = [], notices = [], gens = [];
  const act = async (action, args, then) => { sent.push({ action, args }); then?.({ id: 'job-1', status: 'running' }); };
  const gen = { ...m.generationFormDefaults({}), title: '我的题组' };
  let started = null;
  await m.startGeneration({ act, notify: (notice) => notices.push(notice), setGen: (next) => gens.push(next(gen)), data: library({ sources: [mine] }), gen, course: '',
    sourceIds: ['s1'], then: (job) => { started = job; } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'generate');
  assert.deepEqual(sent[0].args, m.generationRequest(gen, { course: '', sourceIds: ['s1'] }));
  assert.match(notices[0].text, /已开始生成「我的题组」/);
  assert.equal(gens[0].title, '', 'the form is clean for the next deck');
  assert.equal(started.id, 'job-1');
});

test('the first import comes back to the line: no hop to 创建题组, the plain import message', async () => {
  m.setUiLanguage('zh');
  const back = [];
  const open = m.importForLine((ids) => back.push(ids));
  assert.equal(open.type, 'add');
  const handoff = m.importHandoff(open, { done: 1, sourceIds: ['a'], documents: [{ title: 'L.md', format: 'md' }], decks: [] });
  handoff.call(handoff.ids);
  assert.deepEqual(back, [['a']]);
  assert.equal(handoff.notice.text, '已导入「L.md」', 'nothing about a ticked form the learner is not on');
  assert.equal(m.importHandoff(open, { done: 1, sourceIds: [], decks: [{ title: 'D', cards: [{}] }] }), null, 'a JSON deck still opens as a draft');
  const [tour, views] = await Promise.all(['ui/app/use-tour.js', 'ui/app/page-views.jsx'].map((file) => readFile(file, 'utf8')));
  assert.match(tour, /const openFirstImport = \(\) => setModal\(importForLine\(/);
  assert.doesNotMatch(tour, /importForQuestions/, 'the line never hands the first import to 创建题组');
  assert.match(views, /importFirst: tour\.openFirstImport, importMore: tour\.openFirstImport,/, '再加一份 comes back to the line too');
  assert.match(views, /addSource: \(\) => \(lineShown \? tour\.openFirstImport\(\)/, 'any 添加资料 on the home while the line is up');
});

test('the compact card holds two ruled lines for the summary and the estimate while the first deck is ready', () => {
  m.setUiLanguage('zh');
  const ready = m.firstRunLine(library({ sources: [mine] }));
  const markup = compact(ready, { plan: { ...PLAN, estimate: { status: 'loading' } } });
  assert.match(markup, /class="frl-compact-plan"/);
  assert.equal((markup.match(/frl-compact-plan__line/g) || []).length, 2);
  assert.match(text(markup), /将从 1 份资料出 12 题/);
  assert.match(text(markup), /正在估算…/);
  assert.match(text(compact(ready, { plan: PLAN })), /预计 11\.1K–14\.3K tok/, 'the estimate\'s tokens fit the ruled line');
  for (const other of [library(), library({ sources: [mine], drafts: [draft] }), library({ model: NOTHING, sources: [mine] })])
    assert.doesNotMatch(compact(m.firstRunLine(other), { plan: PLAN }), /frl-compact-plan/, 'only while the first deck is ready to be made');
});

test('English: the third step\'s new words have no Chinese left', () => {
  m.setUiLanguage('en');
  try {
    const ready = m.firstRunLine(library({ sources: [{ id: 's1', title: 'Lecture 3' }] }));
    const noModel = { ...ready, steps: [ready.steps[0], ready.steps[1], { ...ready.steps[2], modelReady: false }] };
    const plan = { ...PLAN, summary: 'x' };
    for (const markup of [page(ready, { plan, on: { ...on, tune: noop } }), page(noModel, { plan }), page(ready, { plan: { ...plan, block: 'too-big' } }),
      page(ready, { plan: { ...plan, block: 'reference' } }), compact(ready, { plan, todayLabel: 'Thu 22 Oct' })])
      assert.doesNotMatch(text(markup), han, text(markup).slice(0, 300));
  } finally { m.setUiLanguage('zh'); }
});
