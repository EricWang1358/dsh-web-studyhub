import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { IN_PLACE, LEAVES_WITHOUT_ARROW, actionProblems, buttonElements, clickDoes, goOnProblems, labelHelpers, labelsOf, localHandlers, specProblems, varsOf } from './helpers/go-on.mjs';

/* #1073 / #1074, round 6 of the review of PR #1118: the arrow is decided by what the click does, for every Button with words and every action, not by the words
   (tests/helpers/go-on.mjs: clickDoes); a way back leads with arrow-left; and the English words the review found (sources on the first-run card, "1 question"). */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const locale = async (name) => JSON.parse(await read(`ui/locales/${name}`));

/* ---- 1: the click decides ----------------------------------------------------------------------------------------------------------------------------------- */

test('1: what a click does is read from its handler: a go or open prop, a router, a page setter, a practice run leave; a setter of this page, a job action, a dialog stay', () => {
  for (const click of ['onGoGenerate', '() => onPractice(cards)', 'session.coach.onReviewWeak', '() => setScreen({ kind: "portal", id: s.id })', '() => setPage?.("library")',
    '() => nav.show.task(id)', '() => { setOpen(false); onOpenModelSettings?.(); }', '() => navigate("library")', 'onBoard', 'onSources', 'onSettings',
    '() => act("review.start", args, enterRun)', '(event) => { event.stopPropagation(); onGo(entry); }', '() => study.openModal({ type: "source", source: place })']) {
    assert.equal(clickDoes(click), 'leave', click);
  }
  for (const click of ['() => setEditing(true)', '() => setOpen((open) => !open)', "() => core.act('generate', continueArgs(x), (started) => core.notify?.(started))",
    "() => openModal({ type: 'focusIntake' })", "() => set.setModal({ type: 'add', resumeConversion: file })"]) {
    assert.equal(clickDoes(click), 'here', click);
  }
  assert.equal(clickDoes('() => onPick(item)'), '', 'a prop that does not say: the words decide');
  assert.equal(clickDoes('() => host.openFile(state.file)'), 'external', 'a window outside StudyHub');
});

test('1: a handler of the same file is read through its body, also through `x.current = { open: … }`; a long one (a loader) says nothing', () => {
  const source = ["const generateFromSources = (ids) => intents.goGenerate({ sourceIds: ids });", "const close = () => setOpen(false);",
    "latest.current = { notify: core.notify, open: learn.openLearningTarget };"].join('\n');
  const locals = localHandlers(source);
  assert.equal(clickDoes('() => generateFromSources(ids)', locals), 'leave');
  assert.equal(clickDoes('close', locals), 'here');
  assert.equal(clickDoes('() => latest.current.open({ kind: "cards" })', locals), 'leave');
});

test('1: the rule reads every Button with words, whatever they say: one that leaves wants the arrow, one that acts in place has none', () => {
  assert.equal(goOnProblems('<Button variant="quiet" onClick={onGoGenerate}>{ui("直接去创建题组")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button size="sm" variant="link" onClick={onOpenSettings}>{ui("查看检索设置")}</Button>').length, 1, '查看 is not a go-on word, the click leaves');
  assert.equal(goOnProblems('<Button size="sm" onClick={() => onPractice(cards)}>{ui("只练这些题")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button className="wf-action-btn" onClick={() => setScreen({ kind: "portal", id })}>{ui("查看记录")}</Button>').length, 1, 'a screen setter changes the view');
  assert.equal(goOnProblems('<Button variant="link" iconEnd="arrow-right" onClick={() => setShown(true)}>{ui("查看全部")}</Button>').length, 1, 'a fold opening here has no arrow');
  assert.equal(goOnProblems('<Button variant="link" aria-pressed={open} onClick={onToday}>{ui("今天读哪几节")}</Button>').length, 0, 'a toggle says so itself');
  assert.equal(goOnProblems('<Button size="sm" onClick={openFile}>{ui("在浏览器中打开")}</Button>').length, 1, 'a window outside StudyHub leads with the external mark');
  assert.equal(goOnProblems('<Button size="sm" icon="external" onClick={openFile}>{ui("在浏览器中打开")}</Button>').length, 0);
});

test('1: the contradictions the review saw are gone: each control that takes the learner on ends in the arrow, as its twin does', async () => {
  const sources = new Map((await uiSources()).map(({ file, source }) => [file, source])), helpers = labelHelpers([...sources].map(([file, source]) => ({ file, source })));
  const want = [
    ['ui/ExamCoachPage.jsx', /^直接去创建题组$/], ['ui/LargeDocumentCard.jsx', /^查看检索设置$/], ['ui/Skeleton.jsx', /^只练这些题$/],
    ['ui/review/RoundLookBack.jsx', /^重练这道错题/], ['ui/CaseResult.jsx', /^逐题复习这套案例$/], ['ui/FocusIntakeDialog.jsx', /^只练重点$/],
    ['ui/review/InlineRun.jsx', /^错的再练一遍$/], ['ui/Review.jsx', /^在错题本里看看$/], ['ui/finder/FinderSheet.jsx', /^带我去$/],
    ['ui/app/page-views.jsx', /^查看资料$/], ['ui/app/page-views.jsx', /^音频设置$/], ['ui/Draft.jsx', /^查看已发布题组$/], ['ui/DailyPlan.jsx', /^查看待办$/],
    ['ui/LiveCorrectionLine.jsx', /^到音频设置换一个文字模型$/], ['ui/document-preview/marks/QueueChip.jsx', /^先连接模型$/],
    ['ui/tasks/ContinuedNote.jsx', /^看接着做的任务$/], ['ui/book/BookHeader.jsx', /^看进度$/], ['ui/Workflows.jsx', /^查看记录$/],
  ];
  for (const [file, label] of want) {
    const source = sources.get(file), vars = varsOf(source);
    const found = buttonElements(source).filter(({ children }) => labelsOf(children, helpers, vars).some((words) => label.test(words)));
    assert.ok(found.length, `${file}: ${label}`);
    for (const { open } of found) assert.match(open, /\biconEnd=(?:"arrow-right"|\{[^}]*arrow-right)/, `${file}: ${label} takes the learner somewhere`);
  }
});

test('1: a toast\'s action { label, run } is read too: 马上练这 N 张 and 用它出题 take the learner on, so they end in the arrow', async () => {
  for (const file of ['ui/app/use-selection-notices.js', 'ui/app/use-source-import.js']) {
    const source = await read(file);
    assert.deepEqual(actionProblems(source, { file }), [], file);
    assert.match(source, /iconEnd: 'arrow-right'/, file);
  }
  assert.equal(actionProblems("notify({ action: { label: ui('用它出题'), run: () => goGenerate(ids) } });", { file: 'ui/x.js' }).length, 1);
});

test('1: the whole of ui/ agrees with the rule, Buttons and actions alike, and the exceptions are few, each with why and still in use', async () => {
  const sources = await uiSources(), helpers = labelHelpers(sources), used = new Set(), seen = {}, found = [];
  for (const { file, source } of sources) {
    for (const { label, open, want } of goOnProblems(source, { file, helpers, used, seen })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of actionProblems(source, { file, helpers, used, seen })) found.push(`${file}: action ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of specProblems(source, { file })) found.push(`${file}: spec ${label} wants ${want}  ${open.slice(0, 80)}`);
  }
  assert.deepEqual(found, []);
  assert.ok(seen.buttons > 1100 && seen.actions > 90, `every Button and action is read (${JSON.stringify(seen)})`);
  assert.ok(seen.leave > 150 && seen.here > 250, `most are decided by their click, not their words (${JSON.stringify(seen)})`);
  assert.ok(LEAVES_WITHOUT_ARROW.length <= 10, 'a short list');
  for (const entry of [...LEAVES_WITHOUT_ARROW, ...IN_PLACE]) assert.ok(entry.why.length > 20, `${entry.file}: say why`);
  assert.deepEqual(LEAVES_WITHOUT_ARROW.filter((entry) => !used.has(entry)).map((entry) => entry.file), [], 'no stale exception');
});

/* ---- 3: the way back ----------------------------------------------------------------------------------------------------------------------------------------- */

test('3: a way back (返回 … / 回到 …) leads with arrow-left and never ends in the go-on arrow', async () => {
  assert.equal(goOnProblems('<Button onClick={() => navigate("library")}>{ui("回到学习目录")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button icon="arrow-left" onClick={() => navigate("library")}>{ui("回到学习目录")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button icon="arrow-left" iconEnd="arrow-right" onClick={onBack}>{ui("返回学习库")}</Button>').length, 1);
  for (const [file, label] of [['ui/Review.jsx', '回到学习目录'], ['ui/OralExam.jsx', '回到学习库'], ['ui/BlogNotes.jsx', '返回学习库']]) {
    const source = await read(file), at = source.indexOf(`ui("${label}")`) >= 0 ? source.indexOf(`ui("${label}")`) : source.indexOf(`ui('${label}')`);
    const open = source.slice(source.lastIndexOf('<Button', at), at);
    assert.match(open, /\sicon="arrow-left"/, `${file}: ${label}`);
  }
  assert.match((await read('ui/Review.jsx')).split('\n').find((line) => /className="review-return"/.test(line)), /\sicon="arrow-left"/, 'Review: 返回学习库 / 回到学习流');
});

/* ---- 4: the English words ------------------------------------------------------------------------------------------------------------------------------------ */

test('4: the first-run card says "sources", the word of its button 「Add another source」, not "materials"', async () => {
  const words = (await locale('en.onboarding.json'))['开源免费，资料存在你电脑上；模型自己选，按用量付费。'];
  assert.match(words, /\bsources\b/);
  assert.doesNotMatch(words, /material/i);
});

test('4: a count of one question is "1 question": uiFormat takes the singular a catalogue gives as `<key>#one` when the count is 1', async () => {
  const catalogue = {};
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry))) Object.assign(catalogue, await locale(name));
  assert.equal(catalogue['{0} 题#one'], '{0} question');
  const i18n = await read('ui/i18n.js');
  assert.match(i18n, /#one/, 'uiFormat looks the singular up');
  const { setUiLanguage, uiFormat } = await loadUi("export { setUiLanguage, uiFormat } from './ui/i18n.js';");
  setUiLanguage('en');
  try {
    assert.equal(uiFormat('{0} 题', [1]), '1 question');
    assert.equal(uiFormat('{0} 题', [3]), '3 questions');
    assert.equal(uiFormat('{0} 题', [0]), '0 questions');
  } finally { setUiLanguage('zh'); }
  assert.equal(uiFormat('{0} 题', [1]), '1 题');
});
