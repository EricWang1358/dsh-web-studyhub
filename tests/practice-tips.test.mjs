/* The three first-use tips under a practice question (#948): 帮我弄懂 after a first wrong answer, 修题 after a first 「这题有问题」, 出成前置题 once an answer
   is shown under the question. The rule that decides which one (if any) shows is one pure function (ui/guidance/practice-tips.js), tested here without a
   browser; the browser test (question-tools-first-use-browser.test.mjs) draws them. Nothing here touches a real library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export * from './ui/guidance/practice-tips.js'; export * from './ui/guidance/registry.js'; export * from './ui/guidance/budget.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { PRACTICE_TIPS_KEY, PRACTICE_TIP_ORDER, PRACTICE_TIP, practiceTipFor, practiceTipSeen, markPracticeTipSeen, forgetPracticeTipsVisit, practiceTipState,
  GUIDANCE_ITEMS, guidanceItem, entryProblems, itemSeen, clearItem, GUIDANCE_KEY, readGuidanceState, claimProactiveTip, forgetVisitClaim } = module.exports;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } };
}
const refusing = () => ({ get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });

const ALL = [...PRACTICE_TIP_ORDER];
/** What the page asks: the moments that hold now, nothing seen, every switch on. */
const ask = (moments, rest = {}) => practiceTipFor({ allowed: ALL, seen: [], ...moments, ...rest });

test('the three tips and their order are the owner\'s table: 帮我弄懂, then 修题, then 出成前置题', () => {
  assert.deepEqual(PRACTICE_TIP_ORDER, ['practice.help-first', 'practice.fix-first', 'practice.prereq-first']);
  assert.deepEqual([PRACTICE_TIP.help, PRACTICE_TIP.fix, PRACTICE_TIP.prereq], PRACTICE_TIP_ORDER);
});

test('each tip shows only at its own moment, and only after the learner acted', () => {
  assert.equal(ask({}), null, 'nothing happened: nothing shows (the learner is still thinking about the question)');
  assert.equal(ask({ feedbackWrong: false, votedDown: false, answerShown: false }), null);
  assert.equal(ask({ feedbackWrong: true }), PRACTICE_TIP.help, 'a wrong answer is showing');
  assert.equal(ask({ votedDown: true }), PRACTICE_TIP.fix, '这题有问题 was marked');
  assert.equal(ask({ answerShown: true }), PRACTICE_TIP.prereq, 'an answer of 帮我弄懂 or 追问 is shown under the question');
});

test('at most one at a time: when moments coincide the earlier row wins, and the others take their turn when it is gone', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all), PRACTICE_TIP.help);
  assert.equal(ask(all, { seen: [PRACTICE_TIP.help] }), PRACTICE_TIP.fix);
  assert.equal(ask(all, { seen: [PRACTICE_TIP.help, PRACTICE_TIP.fix] }), PRACTICE_TIP.prereq);
  assert.equal(ask(all, { seen: ALL }), null);
  assert.equal(ask({ votedDown: true, answerShown: true }), PRACTICE_TIP.fix);
});

test('each shows once: a seen tip never returns', () => {
  for (const id of ALL) {
    const moment = { [PRACTICE_TIP.help]: { feedbackWrong: true }, [PRACTICE_TIP.fix]: { votedDown: true }, [PRACTICE_TIP.prereq]: { answerShown: true } }[id];
    assert.equal(ask(moment), id);
    assert.equal(ask(moment, { seen: [id] }), null, `${id} was seen`);
  }
});

test('never during an exam run, never while the tour is running', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all, { exam: true }), null);
  assert.equal(ask(all, { tourRunning: true }), null);
  assert.equal(ask(all, { exam: false, tourRunning: false }), PRACTICE_TIP.help);
});

test('the master switch and a tip\'s own switch: a tip that is not allowed is skipped, the rest still go', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all, { allowed: [] }), null, 'the master switch off allows none');
  assert.equal(ask(all, { allowed: [PRACTICE_TIP.fix, PRACTICE_TIP.prereq] }), PRACTICE_TIP.fix, '帮我弄懂\'s own switch is off');
  assert.equal(ask({ feedbackWrong: true }, { allowed: [PRACTICE_TIP.fix] }), null);
  assert.equal(practiceTipFor({ feedbackWrong: true }), null, 'nothing says it is allowed: it is not');
});

test('the seen / allowed lists may be arrays or sets, and unknown ids are ignored', () => {
  assert.equal(practiceTipFor({ feedbackWrong: true, seen: new Set(), allowed: new Set(ALL) }), PRACTICE_TIP.help);
  assert.equal(practiceTipFor({ feedbackWrong: true, seen: new Set(['nope']), allowed: ['nope', ...ALL] }), PRACTICE_TIP.help);
});

/* ---------- the memory: one list under one key, like the reader's hints ---------- */

test('a tip is remembered in one list; a second tip adds to it; clearing one id leaves the others', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), false);
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, local), true);
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, local), true, 'twice is the same');
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.prereq, local), true);
  assert.deepEqual(JSON.parse(local.getItem(PRACTICE_TIPS_KEY)), ['help-first', 'prereq-first']);
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), false);
  assert.deepEqual([...local.map.keys()], [PRACTICE_TIPS_KEY], 'one key holds it all');
  forgetPracticeTipsVisit();
});

test('practiceTipState: what is seen and what is allowed, read from the storage in one place', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage({ [PRACTICE_TIPS_KEY]: JSON.stringify(['fix-first']), [GUIDANCE_KEY]: JSON.stringify({ muted: ['practice.prereq-first'] }) });
  assert.deepEqual(practiceTipState(local), { seen: [PRACTICE_TIP.fix], allowed: [PRACTICE_TIP.help, PRACTICE_TIP.fix] });
  const off = memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ off: true }) });
  assert.deepEqual(practiceTipState(off), { seen: [], allowed: [] }, 'the master switch');
  assert.deepEqual(practiceTipState(memoryStorage()), { seen: [], allowed: ALL }, 'nothing stored: all on, none seen');
  forgetPracticeTipsVisit();
});

test('a blocked or missing storage: nothing throws; a tip seen in this visit is not shown again in it', () => {
  for (const storage of [null, refusing()]) {
    forgetPracticeTipsVisit();
    assert.doesNotThrow(() => practiceTipSeen(PRACTICE_TIP.help, storage));
    assert.equal(practiceTipSeen(PRACTICE_TIP.help, storage), false);
    assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, storage), false, 'it cannot be stored');
    assert.equal(practiceTipSeen(PRACTICE_TIP.help, storage), true, 'but this visit remembers it');
    assert.equal(practiceTipSeen(PRACTICE_TIP.fix, storage), false);
    assert.deepEqual(practiceTipState(storage).seen, [PRACTICE_TIP.help]);
  }
  forgetPracticeTipsVisit();
});

test('a tip seen in this visit stays seen when another tab clears the storage; 再显示一次 in this tab brings it back', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  local.removeItem(PRACTICE_TIPS_KEY); // another tab's reset, or cleared site data
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), true, 'held for the visit');
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  assert.equal(clearItem(guidanceItem(PRACTICE_TIP.fix), { local, session: memoryStorage() }), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), false, 'this tab cleared it: back without a reload');
  forgetPracticeTipsVisit();
});

/* ---------- 设置 › 引导 lists them ---------- */

test('the registry lists the three: a tip of 练习, proactive, closed for good, pointing at the one list', () => {
  const entries = PRACTICE_TIP_ORDER.map(id => guidanceItem(id));
  for (const entry of entries) {
    assert.ok(entry, 'registered');
    assert.deepEqual(entryProblems(entry), [], entry.id);
    assert.equal(entry.kind, 'tip');
    assert.equal(entry.where, '练习');
    assert.equal(entry.proactive, true, 'the master switch and their own switch apply');
    assert.equal(entry.dismiss, 'forever');
    assert.equal(entry.memory.store, 'local');
    assert.equal(entry.memory.key, PRACTICE_TIPS_KEY);
    assert.equal(entry.memory.match, 'list');
    assert.ok(entry.trigger.length > 12 && entry.again.length > 4, 'a true trigger and a true again');
  }
  assert.deepEqual(entries.map(entry => entry.memory.item), ['help-first', 'fix-first', 'prereq-first']);
  assert.deepEqual(entries.map(entry => entry.title), ['答错后提示「帮我弄懂」', '标记「这题有问题」后提示「修题」', '看到讲解后提示「出成前置题」']);
  assert.equal(new Set(GUIDANCE_ITEMS.map(item => item.id)).size, GUIDANCE_ITEMS.length, 'ids stay unique');
});

test('the registry sees what the page writes, and 再显示一次 clears exactly that id', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  const storages = { local, session: memoryStorage() };
  markPracticeTipSeen(PRACTICE_TIP.help, local);
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  assert.equal(itemSeen(guidanceItem(PRACTICE_TIP.help), storages), true);
  assert.equal(itemSeen(guidanceItem(PRACTICE_TIP.prereq), storages), false);
  assert.equal(clearItem(guidanceItem(PRACTICE_TIP.help), storages), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), false);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), true, 'the other id of the list stays');
  forgetPracticeTipsVisit();
});

/* ---------- not the daily budget ---------- */

test('the three tips do not go through the daily budget: showing them never spends today\'s one tip, and a spent day does not stop them', () => {
  forgetPracticeTipsVisit(); forgetVisitClaim();
  const day = new Date(2026, 9, 26, 12).getTime();
  const spent = memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1 }) });
  assert.equal(claimProactiveTip({ id: 'a.one', now: day, storage: spent }), false, 'the day is spent');
  assert.deepEqual(practiceTipState(spent).allowed, ALL, 'but the practice tips still ask only the switches');
  const local = memoryStorage();
  markPracticeTipSeen(PRACTICE_TIP.help, local);
  assert.equal(readGuidanceState(local).shownToday, 0, 'marking a practice tip seen counts nothing against the day');
  assert.equal(claimProactiveTip({ id: 'a.one', now: day, storage: local }), true, 'the day\'s tip is still there for the other surfaces');
  forgetPracticeTipsVisit(); forgetVisitClaim();
});

test('the hook hands the rule the exam flag of the run and the tour flag of the page, so neither can be forgotten', async () => {
  const { readFile } = await import('node:fs/promises');
  const hook = await readFile(new URL('../ui/review/use-practice-tip.js', import.meta.url), 'utf8');
  assert.match(hook, /exam = run\?\.mode === 'exam'/);
  assert.match(hook, /practiceTipFor\(\{[^}]*exam[^}]*tourRunning[^}]*\}\)/);
  const view = await readFile(new URL('../ui/app/page-views.jsx', import.meta.url), 'utf8');
  assert.match(view, /tourRunning: !!tour\.tourStep/, 'the practice page says whether the tour is running');
  const run = await readFile(new URL('../ui/review/QuestionRun.jsx', import.meta.url), 'utf8');
  assert.match(run, /usePracticeTip\(\{[^}]*tourRunning: !!tourRunning/);
  assert.ok(run.split(String.fromCharCode(10)).length <= 745, 'QuestionRun stays about the size it was (739 lines before, 744 now: the tip logic and its component live in their own files)');
});
