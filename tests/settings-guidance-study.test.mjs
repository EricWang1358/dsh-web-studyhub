/* Settings Guidance Part 2 (Generation, DailyRecap, Practice + Reset Bug Fix, Courses / Method / CustomPlan):
   verifies every P0/P1/P2 fix across both Desktop (capabilities.chat === false) and DSH (chat === true), in zh and en. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENERATION_SETTINGS_DEFAULTS } from '../lib/generation-settings.js';
import { PRACTICE_DEFAULTS } from '../lib/practice-settings.js';
import { BOOK_DEFAULTS, mergeBookSettings } from '../lib/book-settings.js';
import { checkedCustom, customDefaults } from '../lib/custom-plan.js';
import { nativeSelects } from './helpers/native-selects.mjs';
import { inApp } from './helpers/fake-app.mjs';

const require = createRequire(import.meta.url);
const built = await build({
  stdin: {
    contents: `
      export { default as GenerationSettings, GenerationSettingsForm } from './ui/GenerationSettings.jsx';
      export { EffortSelect, effortSelectModel } from './ui/EffortSelect.jsx';
      export { kindNote } from './ui/generate-form.js';
      export { default as KindPicker } from './ui/KindPicker.jsx';
      export { DailyRecapSettingsForm } from './ui/DailyRecapSettings.jsx';
      export { default as PracticePane, PANE_BOOK_RESET_PATCH } from './ui/settings/PracticePane.jsx';
      export { levelHint, levelTip, levelOptions } from './ui/outline/words.js';
      export { default as CourseSettings, NewCourse } from './ui/CourseSettings.jsx';
      export { default as CourseMethodCard, MethodForm } from './ui/CourseMethodCard.jsx';
      export { ActiveSwitch, ParkedChip, CourseActiveProvider } from './ui/CourseActive.jsx';
      export { default as CustomPlanCard } from './ui/CustomPlanCard.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

const load = (requireFn) => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireFn, mod, mod.exports);
  return mod.exports;
};
const m = load(require);
const h = React.createElement;
const noop = () => {};
const HAN = /[\u3400-\u9fff]/;
const FORBIDDEN_ZH = /您|请勿|必须|暂无|宿主|插件/;
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const withLang = (lang, fn) => { m.setUiLanguage(lang); try { return fn(); } finally { m.setUiLanguage('zh'); } };
const DESKTOP_HOST = { capabilities: { edition: 'desktop', chat: false } };
const DSH_HOST = { capabilities: { edition: 'dsh', chat: true } };

/* Hook harness for stateful tests (PracticePane reset bug fix, CourseSettings nested-save guard, DailyRecapSettings). */
let active, studyCtx;
const hook = (initial) => {
  const index = active.cursor++;
  if (!(index in active.slots)) active.slots[index] = initial();
  return [index, active.slots[index]];
};
const mockHooks = {
  ...React,
  useState: (initial) => {
    const owner = active;
    const [index, value] = hook(() => (typeof initial === 'function' ? initial() : initial));
    return [value, (next) => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }];
  },
  useMemo: (calc, deps) => {
    const index = active.cursor++;
    const slot = active.slots[index];
    const same = slot && Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length
      && deps.every((v, i) => Object.is(v, slot.deps[i]));
    if (!same) active.slots[index] = { deps, value: calc() };
    return active.slots[index].value;
  },
  useCallback: (cb, deps) => mockHooks.useMemo(() => cb, deps),
  useRef: (value) => hook(() => ({ current: value }))[1],
  useId: () => hook(() => `id-${active.cursor}`)[1],
  useContext: (ctx) => (ctx === studyCtx ? (globalThis.__study ?? null) : (globalThis.__toast ?? null)),
  useInsertionEffect: () => {},
  useLayoutEffect: () => {},
  useEffect: (cb, deps) => {
    const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
    if (!slot.deps || !deps || deps.some((v, i) => !Object.is(v, slot.deps[i]))) {
      active.effects.push(() => { slot.cleanup?.(); slot.cleanup = cb(); });
      slot.deps = deps;
    }
  },
};
const live = load((name) => (name === 'react' ? mockHooks : require(name)));
studyCtx = live.StudyServicesContext;

function mount(Component, initialProps, studyValue = {}) {
  let current = initialProps;
  const owner = { cursor: 0, slots: [], effects: [] };
  return {
    render(next = {}) {
      current = { ...current, ...next };
      owner.cursor = 0;
      active = owner;
      globalThis.__study = studyValue;
      try { return Component(current); } finally { active = null; globalThis.__study = null; }
    },
    effects() { owner.effects.splice(0).forEach((cb) => cb()); },
  };
}
const find = (tree, pred) => {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const child of tree) { const hit = find(child, pred); if (hit) return hit; } return null; }
  if (pred(tree)) return tree;
  return find(React.Children.toArray(tree.props?.children), pred);
};
const findAll = (tree, pred, out = []) => {
  if (!tree || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach((c) => findAll(c, pred, out)); return out; }
  if (pred(tree)) out.push(tree);
  findAll(React.Children.toArray(tree.props?.children), pred, out);
  return out;
};

/* ---------- 1. GenerationSettings, EffortSelect, generate-form, KindPicker ---------- */

test('GenerationSettings: Desktop hides empty lightModel, avoids bogus effort warnings, folds advanced controls, and shows CLI cap + difficulty/notation hints', () => {
  const renderGen = (lang, { host, props = {}, saved = {} } = {}) => withLang(lang, () => renderToStaticMarkup(
    inApp(m, h(m.GenerationSettings, {
      root: '/lib',
      saved: { ...GENERATION_SETTINGS_DEFAULTS, ...saved },
      ...props,
    }), { host }),
  ));

  // Desktop with no modelGroups, no efforts, and CLI concurrency cap = 2
  const desktopZh = renderGen('zh', { host: { ...DESKTOP_HOST, maxConcurrency: 2, defaultConcurrency: 2 }, props: { efforts: [] } });
  assert.doesNotMatch(desktopZh, /name="lightModel"/, 'hides lightModel when availableGroups empty and no custom value');
  assert.doesNotMatch(desktopZh, /跟随当前会话|当前模型没有可调的推理强度/, 'no DSH session label or bogus effort warning in Desktop');
  assert.match(plain(desktopZh), /学习库与模型/, 'points Desktop users to Library & model for CLI effort');
  assert.match(plain(desktopZh), /高级生成控制/, 'folds advanced settings inside Disclosure');
  assert.match(plain(desktopZh), /范围 1–2（默认 2）。当前本机 CLI 接入将并发上限限制为 2/, 'explains CLI cap of 2');
  assert.match(plain(desktopZh), /混合：基础、应用和辨析题搭配着出/, 'wires difficultyNote hint');
  assert.match(plain(desktopZh), /纯文本更稳定；公式适合数学、化学/, 'wires notationNote hint');
  assert.doesNotMatch(desktopZh, /name="count"/, 'Desktop hides main-chat count');

  // Desktop with saved custom lightModel still reveals lightModel select with plain-language hint
  const desktopCustomLight = renderGen('zh', {
    host: DESKTOP_HOST,
    saved: { lightModel: JSON.stringify(['openai', 'gpt-4o-mini']) },
  });
  assert.match(desktopCustomLight, /name="lightModel"/, 'shows lightModel when custom value is saved');
  assert.match(plain(desktopCustomLight), /单独换更快更省的模型/, 'plain-language lightModel hint');
  assert.doesNotMatch(plain(desktopCustomLight), /前缀缓存/, 'no prefix-cache jargon');

  // Desktop WITH model efforts uses 「跟随模型设置」 instead of 「跟随当前会话」
  const desktopEfforts = renderGen('zh', {
    host: DESKTOP_HOST,
    props: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
  });
  assert.match(plain(desktopEfforts), /跟随模型设置/);
  assert.doesNotMatch(plain(desktopEfforts), /跟随当前会话/);

  // EffortSelect pure model: follow={false} with value='follow' maps cleanly to 「跟随模型设置」
  const fallbackModel = m.effortSelectModel({ value: 'follow', efforts: [{ id: 'low', name: 'Low' }], follow: false });
  assert.ok(fallbackModel.options.some((o) => o.value === 'follow' && o.label === '跟随模型设置'));

  // Desktop in English has zero Han characters (outside language option values)
  const desktopEn = renderGen('en', {
    host: { ...DESKTOP_HOST, maxConcurrency: 2, defaultConcurrency: 2 },
    props: { efforts: [], modelGroups: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'M1' }] }] },
  });
  const cleanedEn = plain(desktopEn.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'));
  assert.doesNotMatch(cleanedEn, HAN, 'English GenerationSettings has zero untranslated Han');
  assert.match(cleanedEn, /Advanced generation controls/);
  assert.match(cleanedEn, /Local CLI caps concurrency at 2/);
  assert.match(cleanedEn, /Library & model/);
});

test('kindNote branches task description by canChat, and KindPicker replaces native title with Tooltip layer', () => {
  assert.match(m.kindNote(['task'], undefined, undefined, { canChat: true }), /在主会话做静态验收/);
  const desktopTaskZh = m.kindNote(['task'], undefined, undefined, { canChat: false });
  assert.doesNotMatch(desktopTaskZh, /主会话/);
  assert.match(desktopTaskZh, /对照验收标准自检/);
  assert.match(desktopTaskZh, /复制提示词到外部 AI/);
  const desktopTaskEn = withLang('en', () => m.kindNote(['task'], undefined, undefined, { canChat: false }));
  assert.doesNotMatch(desktopTaskEn, HAN);
  assert.match(desktopTaskEn, /external AI/i);

  const pickerZh = renderToStaticMarkup(h(m.KindPicker, { value: ['quiz'], onChange: noop }));
  assert.doesNotMatch(pickerZh, /\btitle="/, 'no native HTML title attribute in KindPicker');
  assert.match(pickerZh, /role="tooltip"/, 'uses Tooltip primitive');
  assert.match(plain(pickerZh), /至少保留一种题型/);
});

test('the last ticked question type looks like every ticked one, says it cannot be unticked to a screen reader, and a click on it unticks nothing (#1701)', () => {
  const only = renderToStaticMarkup(h(m.KindPicker, { value: ['quiz'], onChange: noop }));
  const last = /<input[^>]*name="kinds-quiz"[^>]*>/.exec(only)[0];
  assert.doesNotMatch(last, /\sdisabled(=|\s|\/|>)/, 'not drawn as unusable: the default type is not grey');
  assert.match(last, /aria-disabled="true"/);
  assert.match(last, /checked=""/);
  assert.doesNotMatch(only, /sh-check[^"]*is-disabled/, 'no disabled look on any row');
  const card = /aria-describedby="([^"]+)"/.exec(last)?.[1];
  assert.ok(card, 'the box is described by the reason');
  assert.match(only, new RegExp(`<span id="${card}" role="tooltip"[^>]*>至少保留一种题型</span>`));
  const two = renderToStaticMarkup(h(m.KindPicker, { value: ['quiz', 'multi'], onChange: noop }));
  assert.doesNotMatch(two, /aria-disabled|至少保留一种题型/, 'with two ticked, either can be unticked and nothing is said');
  const busy = renderToStaticMarkup(h(m.KindPicker, { value: ['quiz', 'multi'], onChange: noop, disabled: true }));
  assert.match(/<input[^>]*name="kinds-multi"[^>]*>/.exec(busy)[0], /\sdisabled=""/, 'a form that is busy still disables the whole group');
});

/* ---------- 2. DailyRecapSettings ---------- */

test('DailyRecapSettings unifies title, explains 10-question trigger + model cost, handles matching timezone, and shows unsaved hint in zh & en', () => {
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const sameTzHtml = renderToStaticMarkup(inApp(m, h(m.DailyRecapSettingsForm, { root: '/lib', saved: { automatic: false, tone: 'friendly', timeZone: deviceTz } })));
  const text = plain(sameTzHtml);
  assert.match(text, /每日讲解合集/);
  assert.doesNotMatch(text, /每日错题讲解合集/, 'title unified with sidebar');
  assert.match(text, /同一天同一门课答满 10 道不同题才生成/);
  assert.match(text, /开启后自动调用当前模型/);
  assert.match(text, /与当前设备一致；跨时区后可在这里同步/);
  assert.match(text, /改动后点上方按钮保存/);

  // Dirty state flips status hint and enables save button
  const view = mount(live.DailyRecapSettingsForm, { root: '/lib', saved: { automatic: false, tone: 'friendly', timeZone: deviceTz } }, { busy: false, act: async () => ({}) });
  view.render(); view.effects();
  find(view.render(), (n) => n.props?.name === 'automatic').props.onChange(true);
  const statusNode = find(view.render(), (n) => n.props?.role === 'status');
  assert.match(String(statusNode.props.children), /有未保存的修改/);
  const submitBtn = find(view.render(), (n) => n.props?.type === 'submit');
  assert.equal(submitBtn.props.busyLabel, '保存中…');
  assert.equal(submitBtn.props.disabled, false);

  const enHtml = withLang('en', () => renderToStaticMarkup(inApp(m, h(m.DailyRecapSettingsForm, { root: '/lib', saved: { automatic: false, tone: 'friendly', timeZone: deviceTz } }))));
  assert.doesNotMatch(plain(enHtml), HAN, 'English DailyRecapSettings has zero untranslated Han');
  assert.match(plain(enHtml), /Matches this device/);
});

/* ---------- 3. PracticePane (reset bug fix, canChat, subheadings, Disclosure) & outline/words.js ---------- */

test('PracticePane: fixes reset bug for settings.book fields while preserving unrelated pageLimit, branches stubborn-question copy, and organizes with subheadings + Disclosure', async () => {
  // Desktop vs DSH stubborn-question hint + structure + visible levelTip
  const desktopHtml = renderToStaticMarkup(inApp(m, h(m.PracticePane, { data: { settings: { book: { coverage: 'full' } } }, busy: false, act: noop }), { host: DESKTOP_HOST }));
  const desktopText = plain(desktopHtml);
  assert.doesNotMatch(desktopText, /发给主会话/, 'Desktop PracticePane never mentions 发给主会话');
  assert.match(desktopText, /复制提示词/);
  for (const heading of ['每日练习', '顽固题判定', '复习全书与考前冲刺', '各页面增强功能']) {
    assert.ok(desktopText.includes(heading), `PracticePane shows heading/disclosure: ${heading}`);
  }
  assert.match(desktopText, /默认关闭，不调用模型/);
  assert.match(desktopText, /考前冲刺计划提前几天出现/);
  assert.match(desktopText, /期末一周/);
  assert.match(desktopText, /错满 3 次即标为顽固（总作答不满 5 次时只要错满 3 次同样生效）/);
  assert.match(desktopText, /详尽：资料里清点出的每一条都要讲到/, 'levelTip(coverage) rendered visibly');
  assert.doesNotMatch(desktopText, FORBIDDEN_ZH, 'no forbidden Chinese words in PracticePane');

  const dshHtml = renderToStaticMarkup(inApp(m, h(m.PracticePane, { data: { settings: {} }, busy: false, act: noop }), { host: DSH_HOST }));
  assert.match(plain(dshHtml), /发给主会话/, 'DSH PracticePane keeps 发给主会话');

  // Reset button disabled when only pageLimit (not managed on PracticePane) is set
  const onlyPageLimit = renderToStaticMarkup(inApp(m, h(m.PracticePane, { data: { settings: { book: { pageLimit: 12 } } }, busy: false, act: noop }), { host: DSH_HOST }));
  assert.match(onlyPageLimit.match(/<button[^>]*>(?:(?!<\/button>).)*恢复默认/)[0], /disabled/, 'pageLimit alone does not enable reset');

  // Reset button ENABLED when only a pane-managed settings.book field is changed, and clicking resets only book fields (preserving pageLimit!)
  const bookOnlyCalls = [];
  const bookView = mount(live.PracticePane, {
    data: { settings: { book: { qaToBook: 'auto', crunchWindowDays: 30, coverage: 'full', inlinePractice: true, pageLimit: 12 } } },
    busy: false,
    act: async (action, args) => { bookOnlyCalls.push([action, args]); return {}; },
  }, { host: DSH_HOST });
  bookView.render(); bookView.effects();
  const resetBtn1 = find(bookView.render(), (n) => n.props?.onClick && n.props.children === '恢复默认');
  assert.equal(resetBtn1.props.disabled, false, 'reset enabled when pane book settings are non-default');
  await resetBtn1.props.onClick();
  assert.deepEqual(bookOnlyCalls, [['settings.book.set', { patch: m.PANE_BOOK_RESET_PATCH }]]);
  const mergedAfterReset = mergeBookSettings({ qaToBook: 'auto', crunchWindowDays: 30, crunchMinutes: 90, coverage: 'full', inlinePractice: true, confusableDrill: true, pageLimit: 12 }, m.PANE_BOOK_RESET_PATCH);
  assert.deepEqual(mergedAfterReset, { qaToBook: BOOK_DEFAULTS.qaToBook, pageLimit: 12 }, 'resets all 6 pane book fields while preserving pageLimit');

  // When BOTH settings.practice and settings.book pane fields are modified, reset resets BOTH
  const bothCalls = [];
  const bothView = mount(live.PracticePane, {
    data: { settings: { practice: { autopilot: true }, book: { confusableDrill: true } } },
    busy: false,
    act: async (action, args) => { bothCalls.push([action, args]); return action.endsWith('reset') ? { ...PRACTICE_DEFAULTS } : {}; },
  }, { host: DSH_HOST });
  bothView.render(); bothView.effects();
  await find(bothView.render(), (n) => n.props?.onClick && n.props.children === '恢复默认').props.onClick();
  assert.deepEqual(bothCalls, [
    ['settings.practice.reset', {}],
    ['settings.book.set', { patch: m.PANE_BOOK_RESET_PATCH }],
  ]);

  // English PracticePane (Desktop & DSH) has zero untranslated Han
  for (const host of [DESKTOP_HOST, DSH_HOST]) {
    const enHtml = withLang('en', () => renderToStaticMarkup(inApp(m, h(m.PracticePane, { data: { settings: { practice: { studyChainRecipes: true }, book: { coverage: 'brief' } } }, busy: false, act: noop }), { host })));
    assert.doesNotMatch(plain(enHtml), HAN, `English PracticePane (${host.capabilities.edition}) has zero Han`);
    assert.match(plain(enHtml), /Per-page enhancements/);
    assert.match(plain(enHtml), /When the exam crunch plan begins/);
  }
});

test('ui/outline/words.js eliminates forbidden 必须 across all coverage tips and levelHint', () => {
  for (const level of ['brief', 'standard', 'full']) {
    assert.doesNotMatch(m.levelTip(level), /必须/, `levelTip(${level}) has no 必须`);
  }
  assert.doesNotMatch(m.levelHint(), /必须/, 'levelHint has no 必须');
});

/* ---------- 4. CourseSettings, CourseMethodCard, CourseActive, CustomPlanCard ---------- */

test('Desktop hides all 主会话 copy across NewCourse, CourseMethodCard, and CustomPlanCard while DSH keeps it', () => {
  const custom = checkedCustom({ ...customDefaults('review'), scope: { kind: 'all' }, book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'confusables'] } });
  const course = {
    id: 'c-os',
    name: 'Operating Systems',
    aliases: [],
    guidanceSourceIds: [],
    focusTopics: [],
    custom,
    method: {
      version: 1,
      name: 'OS Sprint',
      stages: [
        { name: 'Processes', activity: 'explain', alternatives: ['practice'], level: 'medium' },
        { name: 'Scheduling', activity: 'practice', alternatives: [], level: 'medium' },
      ],
    },
  };
  const emptyData = { root: '/lib', courses: [course], sources: [], decks: [], attempts: [] };
  const missedGate = { stage: course.method.stages[0], total: 4, passed: 1, toReady: 3, ready: false, checkPassed: false, missed: [{ cardId: 'k1', prompt: 'What is PCB?' }] };

  // Desktop NewCourse
  const newDesktop = renderToStaticMarkup(inApp(m, h(m.NewCourse, { courses: [course], initial: { open: true, name: 'Rust' } }), { host: DESKTOP_HOST }));
  assert.doesNotMatch(plain(newDesktop), /主会话/, 'Desktop NewCourse tooltip/copy never mentions 主会话');

  // Desktop CourseMethodCard (missing material + missed gate + note open)
  const methodDesktop = renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, {
    course,
    data: emptyData,
    readout: { index: 0, total: 2, own: true, gate: missedGate },
    initialNote: 'focus on locks',
  }), { host: DESKTOP_HOST, data: emptyData }));
  const methodDesktopText = plain(methodDesktop);
  assert.doesNotMatch(methodDesktopText, /主会话/, 'Desktop CourseMethodCard never leaks 主会话');
  assert.match(methodDesktopText, /首页和学习步骤会照着它走/);
  assert.match(methodDesktopText, /复制起草讲义提示词/);
  assert.match(methodDesktopText, /复制错题讲解提示词/);
  assert.match(methodDesktopText, /复制改学法提示词/);

  // Desktop default method card
  const defaultDesktop = renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, {
    course: { id: 'c-def', name: 'Math' },
    data: emptyData,
  }), { host: DESKTOP_HOST, data: emptyData }));
  assert.doesNotMatch(plain(defaultDesktop), /主会话/);

  // Desktop CustomPlanCard: visible switch hints, locked parts hint, instant-effect hint
  const customDesktop = renderToStaticMarkup(inApp(m, h(m.CustomPlanCard, { course }), { host: DESKTOP_HOST }));
  const customDesktopText = plain(customDesktop);
  assert.match(customDesktopText, /以下各项切换后立即生效/);
  assert.match(customDesktopText, /只有答错的题才会写变式题/);
  assert.match(customDesktopText, /按你的节奏排每天读哪几节/);
  assert.match(customDesktopText, /已锁定的部分/);

  // DSH keeps original main-chat copy
  const methodDsh = renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, {
    course,
    data: emptyData,
    readout: { index: 0, total: 2, own: true, gate: missedGate },
    initialNote: 'focus on locks',
  }), { host: DSH_HOST, data: emptyData }));
  assert.match(plain(methodDsh), /请主会话起草/);
  assert.match(plain(methodDsh), /带着错题回主会话/);
  assert.match(plain(methodDsh), /和主会话改学法/);

  // English Desktop CourseMethodCard & CustomPlanCard have zero Han
  const methodDesktopEn = withLang('en', () => renderToStaticMarkup(inApp(m, h(m.CourseMethodCard, {
    course,
    data: emptyData,
    readout: { index: 0, total: 2, own: true, gate: missedGate },
    initialNote: 'focus on locks',
  }), { host: DESKTOP_HOST, data: emptyData })));
  assert.doesNotMatch(plain(methodDesktopEn), HAN, 'English Desktop CourseMethodCard has zero Han');
  const customDesktopEn = withLang('en', () => renderToStaticMarkup(inApp(m, h(m.CustomPlanCard, { course }), { host: DESKTOP_HOST })));
  assert.doesNotMatch(plain(customDesktopEn), HAN, 'English Desktop CustomPlanCard has zero Han');
});

test('CourseSettings guards nested save trap (method edit / unconfirmed rename), explains exam info, and MethodForm shows pass-strictness legend', async () => {
  const course = { id: 'c-1', name: 'Algorithms', aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 1, sources: 0 };
  const data = { root: '/lib', courses: [course], sources: [], focus: { course: 'Algorithms', courses: [{ name: 'Algorithms' }] } };
  const calls = [], closed = [];
  const study = {
    act: async (action, args, done) => { calls.push([action, args]); done?.({}); return {}; },
    call: async () => ({ topics: [] }),
    busy: false,
    openModal: noop,
    host: DSH_HOST,
  };
  const view = mount(live.CourseSettings, { data, courseId: 'c-1', onClose: (r) => closed.push(r) }, study);
  view.render(); view.effects();

  // Trigger nested method editing via CourseMethodCard's onEditingChange callback
  const methodCard = find(view.render(), (n) => typeof n.props?.onEditingChange === 'function');
  assert.ok(methodCard, 'CourseSettings passes onEditingChange to CourseMethodCard');
  methodCard.props.onEditingChange(true);

  // First click on 保存课程信息 warns instead of discarding edits & closing
  const dialog1 = view.render();
  const saveBtn1 = find(dialog1.props.footer, (n) => n.props?.variant === 'primary');
  assert.equal(saveBtn1.props.children, '保存课程信息');
  saveBtn1.props.onClick();
  assert.equal(calls.length, 0, 'first click while editing method does not submit course.save');
  assert.equal(closed.length, 0, 'dialog stays open');

  const dialog2 = view.render();
  const warnText = findAll(dialog2.props.footer, (n) => n.props?.tone === 'warning').map((n) => n.props.children).join(' ');
  assert.match(warnText, /学法仍在编辑中/);
  const saveBtn2 = find(dialog2.props.footer, (n) => n.props?.variant === 'primary');
  assert.equal(saveBtn2.props.children, '仍保存课程信息');

  // Second click proceeds cleanly with course.save
  await saveBtn2.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'course.save');
  assert.deepEqual(closed, ['saved']);

  // Exam info hint & MethodForm pass-strictness + 也可以 legend (zh & en)
  const csZh = renderToStaticMarkup(inApp(m, h(m.CourseSettings, { data, courseId: 'c-1', onClose: noop }), { host: DSH_HOST }));
  assert.match(plain(csZh), /用于模拟考计时、案例题配分与按部分出题/);
  assert.match(plain(csZh), /改名需点右侧「改名」并确认，立即生效/);
  assert.match(plain(csZh), /切换立即生效，不用点底部保存/);

  const methodFormZh = renderToStaticMarkup(inApp(m, h(m.MethodForm, {
    draft: { name: 'Sprint', stages: [{ name: 'Stage 1', activity: 'practice', alternatives: [], level: 'medium' }] },
    own: false,
    disabled: false,
    working: false,
    onChange: noop,
    onStage: noop,
    onSave: noop,
    onCancel: noop,
    onReset: noop,
  })));
  assert.match(plain(methodFormZh), /过关宽严：松一点（答过八成）、适中（答对八成）、严格一点（全部答对）/);
  assert.match(plain(methodFormZh), /学法单独保存/);

  const csEn = withLang('en', () => renderToStaticMarkup(inApp(m, h(m.CourseSettings, { data, courseId: 'c-1', onClose: noop }), { host: DESKTOP_HOST })));
  assert.doesNotMatch(plain(csEn), HAN, 'English CourseSettings has zero Han');
});

test('CourseActive replaces native title attributes with Tooltip layer in ActiveSwitch and ParkedChip', () => {
  const api = { setActive: async () => ({}), activate: async () => ({}), manage: noop };
  const parked = { id: 'c-p', name: 'Cloud', active: false, explicit: false };
  const activeHtml = renderToStaticMarkup(h(m.CourseActiveProvider, { value: api }, h(m.ActiveSwitch, { course: parked, courses: [parked], compact: true })));
  assert.doesNotMatch(activeHtml, /\btitle="/, 'ActiveSwitch uses Tooltip, not native title');
  assert.match(activeHtml, /role="tooltip"/);

  const chipHtml = renderToStaticMarkup(h(m.CourseActiveProvider, { value: api }, h(m.ParkedChip, { course: parked })));
  assert.doesNotMatch(chipHtml, /\btitle="/, 'ParkedChip uses Tooltip, not native title');
  assert.match(chipHtml, /role="tooltip"/);
});

test('all 11 owned UI files obey zero forbidden Chinese words and zero native title attributes', async () => {
  const files = [
    'ui/GenerationSettings.jsx',
    'ui/EffortSelect.jsx',
    'ui/generate-form.js',
    'ui/KindPicker.jsx',
    'ui/DailyRecapSettings.jsx',
    'ui/settings/PracticePane.jsx',
    'ui/outline/words.js',
    'ui/CourseSettings.jsx',
    'ui/CourseMethodCard.jsx',
    'ui/CourseActive.jsx',
    'ui/CustomPlanCard.jsx',
  ];
  for (const file of files) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    // Check string literals passed to ui(...) / uiFormat(...) for forbidden Chinese words
    for (const match of src.matchAll(/\bui(?:Format)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
      assert.doesNotMatch(match[2], FORBIDDEN_ZH, `${file} ui() contains forbidden word: ${match[2]}`);
    }
    assert.doesNotMatch(src, /<(?:[a-z][\w-]*|Checkbox|Badge|Switch|Button)\b[^>]*\btitle=/, `${file} must not use native title attribute`);
  }
});
