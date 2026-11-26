/* The first run and its words: one name for the first step (添加资料), a welcome page that tells the truth about the tour and the formats it takes, the
   way from the short tour to the full one, and a checklist whose buttons say what they do. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { withStudy } from './helpers/study-services.mjs';

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export * from './ui/i18n.js';
    export { default as FirstRunLine } from './ui/first-run/FirstRunLine.jsx';
    export { firstRunLine } from './ui/first-run/line.js';
    export { TourPopover } from './ui/tour/Tour.jsx';
    export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
    export { readTourProgress, writeTourProgress } from './ui/tour/progress.js';
    export { TOUR_STEPS, CORE_TOUR_LENGTH } from './ui/tour/steps.js';
    export { default as SetupChecklist, stepAction } from './ui/SetupChecklist.jsx';
    export { createSetupHandlers } from './ui/app/setup-handlers.js';
    export { default as AppSidebar } from './ui/app/AppSidebar.jsx';
    export { default as DailyPlan } from './ui/DailyPlan.jsx';
    export { default as ExamPrepCreate } from './ui/exam-prep/ExamPrepCreate.jsx';
    export { default as Generate } from './ui/Generate.jsx';
    export { GENERATION_DEFAULTS } from './ui/generation-status.js';
    export { emptyPicks } from './ui/exam-prep/form.js';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const m = loaded.exports;
const h = React.createElement;
const noop = () => {};
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// The first screen of an empty library is the first-run line (ui/first-run, 3.6 D2); a loaded sample keeps it, with the sample banner above.
const welcome = ({ sample = { loaded: false } } = {}) => renderToStaticMarkup(h(m.FirstRunLine, { line: m.firstRunLine({ root: '/l', model: { ready: true }, decks: [], sources: [], drafts: [], jobs: [] }),
  form: 'page', sample, on: { importFirst: noop, startSample: noop, later: noop } }));

test('the first step has one name on the welcome page, the tour and the checklist: 添加资料', () => {
  m.setUiLanguage('zh');
  for (const markup of [welcome(), welcome({ sample: { loaded: true, course: '示例课程 · 设计模式' } })]) {
    assert.match(markup, />添加资料</);
    assert.doesNotMatch(markup, /导入我的第一份资料|添加第一份资料/);
  }
  const last = renderToStaticMarkup(h(m.TourPopover, { step: m.TOUR_STEPS.at(-1), index: 7, total: 8, onNext: noop, onBack: noop, onClose: noop, onSkip: noop, onImport: noop }));
  assert.match(last, />添加资料</);
  assert.doesNotMatch(last, /导入我的第一份资料/);
  assert.match(m.stepAction({ id: 'materials', action: 'import' }, { course: '' }, { import: noop }).label, /^添加资料$/);
  assert.equal(m.stepAction({ id: 'materials', action: 'import' }, { course: '' }, {}).disabled, true, 'no handler, no dead button');
});

test('the first screen says 网页文件 (.html), the formats the hub takes, and a tour time that is true', () => {
  m.setUiLanguage('zh');
  const words = text(welcome());
  assert.match(words, /网页文件（\.html）/, 'only saved .html files are taken, not an address');
  assert.doesNotMatch(words.replace(/网页文件/g, ''), /网页/, 'no bare 网页');
  assert.match(words, /Word/);
  assert.match(words, /PowerPoint/);
  assert.doesNotMatch(words, /三分钟|两三分钟/);
  assert.match(words, new RegExp(`${m.CORE_TOUR_LENGTH} 步`), 'the step count is the default tour\'s own');
  const loaded = text(welcome({ sample: { loaded: true, course: '示例课程 · 设计模式' } }));
  assert.doesNotMatch(loaded, /载入示例并开始导览/, 'a loaded sample has its banner (重新开始导览 / 移除示例数据), not a second offer');
  m.setUiLanguage('en');
  try {
    for (const markup of [welcome(), welcome({ sample: { loaded: true, course: 'Sample course' } })]) assert.doesNotMatch(text(markup), han);
    assert.match(text(welcome()), /Add source/);
  } finally { m.setUiLanguage('zh'); }
});

test('the last step of the short tour offers the full tour; the full tour (and the paused card) do not', () => {
  m.setUiLanguage('zh');
  const props = { step: m.TOUR_STEPS.at(-1), index: 7, total: 8, onNext: noop, onBack: noop, onClose: noop, onSkip: noop, onImport: noop, onRemoveSample: noop };
  const short = renderToStaticMarkup(h(m.TourPopover, { ...props, onFullTour: noop }));
  assert.match(short, /看完整导览/);
  assert.equal((short.match(/sh-btn--primary/g) || []).length, 1, 'still one primary action: 添加资料');
  assert.doesNotMatch(renderToStaticMarkup(h(m.TourPopover, props)), /看完整导览/);
  const middle = renderToStaticMarkup(h(m.TourPopover, { ...props, step: m.TOUR_STEPS[1], index: 1, onFullTour: noop }));
  assert.doesNotMatch(middle, /看完整导览/, 'only the last step offers it');
  m.setUiLanguage('en');
  try { assert.match(renderToStaticMarkup(h(m.TourPopover, { ...props, onFullTour: noop })), /See the full tour/); } finally { m.setUiLanguage('zh'); }
  // Settings › 学习画像与导览 can start it too.
  const panel = renderToStaticMarkup(h(m.OnboardingPanel, { sample: { loaded: false }, progress: null, onTour: noop, onFullTour: noop }));
  assert.match(panel, /看完整导览/);
  assert.doesNotMatch(renderToStaticMarkup(h(m.OnboardingPanel, { sample: { loaded: false }, progress: null, onTour: noop })), /看完整导览/);
});

test('a paused full tour is remembered as the full tour; the short tour leaves the old shape of the record', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  try {
    m.writeTourProgress('/a', { stepId: 'exam', full: true });
    assert.deepEqual(m.readTourProgress('/a'), { stepId: 'exam', done: false, full: true });
    m.writeTourProgress('/b', { stepId: 'tasks', done: true, full: false });
    assert.deepEqual(m.readTourProgress('/b'), { stepId: 'tasks', done: true });
  } finally { delete globalThis.localStorage; }
});

test('the checklist button for the skeleton goes to the page, and says so (it generates nothing)', () => {
  m.setUiLanguage('zh');
  assert.equal(m.stepAction({ id: 'skeleton', action: 'skeleton' }, { course: '' }, { skeleton: noop }).label, '去知识骨架页');

  const calls = { navigate: [], setModal: [], goGenerate: [], openDraft: [], openSettings: [], setCourseSettings: [] };
  const handlers = m.createSetupHandlers({
    data: { sources: [], drafts: [], focus: {} },
    nav: { navigate: (...args) => calls.navigate.push(args) },
    set: { setModal: (...args) => calls.setModal.push(args) },
    intents: { goGenerate: (...args) => calls.goGenerate.push(args) },
    drafts: { openDraft: (...args) => calls.openDraft.push(args) },
    settingsEntry: { openSettings: (...args) => calls.openSettings.push(args), setCourseSettings: (...args) => calls.setCourseSettings.push(args) },
  });
  handlers.skeleton();
  assert.deepEqual(calls.navigate, [['skeleton']], 'the handler only navigates to skeleton');
  assert.deepEqual(calls.goGenerate, [], 'it does not trigger generation');
  assert.deepEqual(calls.setModal, []);
  assert.deepEqual(calls.openDraft, []);
  assert.deepEqual(calls.openSettings, []);
  assert.deepEqual(calls.setCourseSettings, []);

  // Render the checklist for a course with no materials (while another course exists) and for a course with a deck:
  // it says 添加资料 / 先添加资料 / 去知识骨架页, never 生成知识骨架 / 导入资料 / 加入资料.
  const emptyCourse = { root: '/l', focus: { course: 'OS', courses: ['OS', 'Math'] }, courses: [{ id: 'c1', name: 'OS' }], sources: [], decks: [{ id: 'd-math', course: 'Math', cards: [{ id: 'm1' }] }], drafts: [], skeletons: [], model: { ready: true } };
  const emptyChecklistText = text(renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.SetupChecklist, { data: emptyCourse, on: handlers, initialOpen: true }))));
  assert.match(emptyChecklistText, /添加资料/);
  assert.match(emptyChecklistText, /先添加资料，再出题/);
  assert.doesNotMatch(emptyChecklistText, /导入资料|加入资料|先加入资料/);

  const courseWithDeck = { ...emptyCourse, decks: [{ id: 'd-os', course: 'OS', cards: [{ id: 'q1' }] }] };
  const deckChecklistText = text(renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.SetupChecklist, { data: courseWithDeck, on: handlers, initialOpen: true }))));
  assert.match(deckChecklistText, /去知识骨架页/);
  assert.doesNotMatch(deckChecklistText, /生成知识骨架|导入资料|加入资料|先加入资料/);

  // The pages where 导入资料 used to be a second name (创建题组, 今天先做什么, 备考补习) all render 添加资料 buttons.
  const generateMarkup = renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.Generate, {
    data: emptyCourse, running: false, openDraft: noop, setPage: noop, genSource: 'files', setGenSource: noop,
    gen: m.GENERATION_DEFAULTS, setGen: noop, selectedSources: [], setSelectedSources: noop, setModal: noop, openModelSettings: noop, onStarted: noop,
  })));
  assert.match(generateMarkup, />添加资料</);
  assert.doesNotMatch(generateMarkup, />导入资料</);

  const plan = {
    state: { date: '2026-10-05', budgetMinutes: 30, spentMinutes: 0, tasks: [], proposal: { id: 'p1', items: [], emptyReason: 'nothing-due' } },
    busy: false, error: '', suggest: noop, accept: noop, start: noop, complete: noop, refresh: noop,
  };
  const dailyPlanMarkup = renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.DailyPlan, { plan, modelReady: true, openModelSettings: noop })));
  assert.match(dailyPlanMarkup, />添加资料</);
  assert.doesNotMatch(dailyPlanMarkup, />导入资料</);

  const examPrepMarkup = renderToStaticMarkup(withStudy(m.StudyServicesContext, h(m.ExamPrepCreate, {
    data: emptyCourse,
    initial: { course: 'OS', askCourse: false, others: false, picks: m.emptyPicks(), title: '', language: '', notes: '', reading: { title: '', author: '', url: '', note: '' } },
    onBack: noop, onStarted: noop, openSettings: noop, openImport: noop,
  })));
  assert.match(examPrepMarkup, />添加资料</);
  assert.doesNotMatch(examPrepMarkup, />导入资料</);

  m.setUiLanguage('en');
  try { assert.match(m.stepAction({ id: 'skeleton', action: 'skeleton' }, { course: '' }, { skeleton: noop }).label, /^Open the knowledge outline page$/); } finally { m.setUiLanguage('zh'); }
});

test('StudyHub says what it is once: the welcome page, the sidebar, the READMEs and the plugin descriptions use the one positioning', async () => {
  const ZH = '把老师的课件变成题，每道题都点得回原页；做完一轮，看得见自己变熟。', ZH_SUB = '开源免费，资料存在你电脑上；模型自己选，按用量付费。';
  const EN = 'Turn your lecture slides into questions that each link back to their page; finish a round and see yourself getting it.';
  const EN_SUB = 'Free and open source, your sources stay on your computer; pick your own model and pay for what you use.';
  m.setUiLanguage('zh');
  const first = text(welcome());
  assert.ok(first.includes(ZH) && first.includes(ZH_SUB), 'the first screen carries both lines');
  m.setUiLanguage('en');
  try {
    const english = text(welcome());
    assert.ok(english.includes(EN) && english.includes(EN_SUB));
    assert.doesNotMatch(english, han);
  } finally { m.setUiLanguage('zh'); }
  const read = (file) => readFile(file, 'utf8');
  const [readmeZh, readmeEn] = [await read('README.zh-CN.md'), await read('README.md')];
  assert.ok(readmeZh.includes(ZH) && readmeZh.includes(ZH_SUB));
  assert.ok(readmeEn.includes(EN) && readmeEn.includes(EN_SUB));
  assert.doesNotMatch(readmeZh + readmeEn, /removed in 3\.6|在 3\.6 版移除|before 3\.6|3\.6 之前/, 'the MinerU cloud route went in 3.5.5');
  const { readdir } = await import('node:fs/promises');
  const guides = (await readdir('docs')).filter((name) => name.endsWith('.md'));
  for (const name of guides) assert.doesNotMatch(await read(`docs/${name}`), /removed in 3\.6|在 3\.6 版移除|before 3\.6|3\.6 之前|replaced `mineruSetup` in 3\.6/, `docs/${name}: the MinerU cloud route went in 3.5.5, not 3.6`);
  assert.doesNotMatch(await read('lib/runtime-config.js'), /\(3\.6; replaces mineruSetup\)/, 'the host-config description names the release that shipped the install');
  const sidebarApp = {
    shell: { navDrawer: false, navOpen: false, narrowWindow: false, rootRef: { current: null }, setSidebarCollapsed: noop, setNavOpen: noop },
    nav: { page: 'library', navPage: 'library', pageTarget: null, navigate: noop },
    session: { run: null, onCoachPractice: noop, actions: { openShortcutHelp: noop } },
    intents: { resumeOrStart: noop },
    board: { count: 0, due: { overdue: 0, today: 0 } },
    finder: { openFinder: noop },
  };
  const renderSidebar = () => renderToStaticMarkup(inApp(m, h(m.AppSidebar), {
    data: { root: '/l', decks: [], sources: [], drafts: [], jobs: [] },
    app: sidebarApp,
  }));
  m.setUiLanguage('zh');
  const sidebarZh = renderSidebar();
  assert.match(sidebarZh, /<small>每道题都点得回原页<\/small>/, 'the sidebar has room for the first clause only');
  assert.doesNotMatch(sidebarZh, /做完一轮/);
  m.setUiLanguage('en');
  try {
    const sidebarEn = renderSidebar();
    const taglineEn = (sidebarEn.match(/<small>([^<]*)<\/small>/) || [])[1] || '';
    assert.ok(taglineEn.length > 0 && !han.test(taglineEn), `English sidebar tagline is translated: ${taglineEn}`);
  } finally { m.setUiLanguage('zh'); }
  assert.match(JSON.parse(await read('package.json')).description, /^StudyHub: turn your lecture slides into questions that each link back to their page/);
  assert.match(JSON.parse(await read('locale/zh.json')).meta.description, /^把老师的课件变成题，每道题都点得回原页/);
});

test('the introduction site carries the same positioning in its title, description and lede, in both languages', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildSite } = await import('../scripts/site-build.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-site-'));
  try {
    await buildSite({ outdir: dir });
    const zh = await readFile(join(dir, 'index.html'), 'utf8'), en = await readFile(join(dir, 'en.html'), 'utf8');
    const pick = (html, re) => (html.match(re) || [])[1] || '';
    const strip = (value) => value.replace(/<[^>]+>/g, '');
    for (const [html, first, sentence, sub] of [
      [zh, '把老师的课件变成题，每道题都点得回原页', '把老师的课件变成题，每道题都点得回原页；做完一轮，看得见自己变熟。', '开源免费，资料存在你电脑上；模型自己选，按用量付费。'],
      [en, 'Turn your lecture slides into questions that each link back to their page', 'Turn your lecture slides into questions that each link back to their page; finish a round and see yourself getting it.', 'Free and open source, your sources stay on your computer; pick your own model and pay for what you use.'],
    ]) {
      assert.ok(pick(html, /<title>([\s\S]*?)<\/title>/).includes(first), 'the title leads with the positioning');
      assert.ok(pick(html, /<meta name="description" content="([^"]*)"/).includes(first), 'the meta description carries it');
      const lede = strip(pick(html, /<p class="hero-lede[^"]*">([\s\S]*?)<\/p>/));
      assert.ok(lede.includes(sentence) && lede.includes(sub), 'the hero lede carries the sentence and the sub-line');
    }
    assert.doesNotMatch(zh + en, /自己的资料，扎实地学|Learn from your own sources/, 'the old tagline is gone from the built pages');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
