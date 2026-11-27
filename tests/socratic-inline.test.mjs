import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { SOCRATIC_MAX_TURNS, buildRevealMessage, evaluateCardSocraticStep } from '../lib/contexts/study/socratic-inline.js';
import { studyStats, wrongBook } from '../lib/insights.js';
import { cardLevel, latestOutcomes } from '../lib/mastery.js';
import { undoableForRun } from '../lib/contexts/study/undo-ops.js';
import { extractLearnerPace } from '../lib/pace/forecast.js';
import { recapGroups } from '../lib/daily-recap.js';
import { wrongDetail } from '../lib/wrong-detail.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { questionSolidity } from '../lib/evidence/point-evidence.js';
import { taskProgress } from '../lib/daily-plan/tasks.js';
import { loadUi } from './helpers/ui-module.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { contentKey } from '../lib/card-content.js';
import { staleReviewEntries } from '../lib/study-state.js';
import { claimGrading, GRADING_BUSY } from '../lib/contexts/study/grading-marker.js';

const uiMod = await loadUi(`
  export { default as SocraticInlineDrawer } from './ui/review/SocraticInlineDrawer.jsx';
  export { AssistFormPanelView } from './ui/review/AssistFormPanel.jsx';
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { shortcutAction } from './ui/review/session-logic.js';
  export { computeTodayPace } from './ui/review/today-pace.js';
  export { formatSocraticTurnCopy, formatSocraticTranscriptCopy } from './ui/review/socratic-copy.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;

async function createSeededService(t, { complete = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'study-socratic-inline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const service = new StudyService(dir, { ...(complete ? { complete } : {}) });
  t.after(() => service.dispose());
  await service.store.update((s) => {
    s.courses = [{ id: 'course-os', name: '操作系统' }];
    s.decks = [{
      id: 'deck-os',
      title: '死锁与同步',
      course: '操作系统',
      cards: [
        {
          id: 'card-deadlock',
          kind: 'quiz',
          topic: '死锁必要条件',
          prompt: '为什么按全局顺序编号并升序申请资源可以预防死锁？',
          answer: '按全局顺序编号并要求按升序申请资源，会破坏循环等待条件，不可能形成环路等待。',
          explanation: '死锁需要互斥、占有且等待、不可剥夺、循环等待四个必要条件同时成立；按序申请破坏了循环等待，因此不会死锁。',
          hint: '想想死锁的四个必要条件',
          options: [
            { id: 'a', text: '破坏了循环等待条件', correct: true },
            { id: 'b', text: '破坏了互斥条件', correct: false },
          ],
        },
      ],
    }];
  });
  return service;
}

/** A stand-in model: replies come from `script` (a list, or a function of the request), and every request is kept for the test to read. */
function scriptedTutor(script) {
  const calls = [];
  const complete = async (system, prompt, options) => {
    const payload = JSON.parse(prompt);
    calls.push({ system, payload, options });
    const next = typeof script === 'function' ? script(payload) : script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next);
  };
  return { complete, calls };
}

/** Behaves like a sensible tutor for the deadlock question: stuck gets a hint, a real explanation closes, anything else gets a plain reply. */
const deadlockTutor = () => scriptedTutor(({ message, request }) => {
  if (request === 'hint') return { reply: '想一想：按序申请之后，还可能出现 A 等 B、B 又等 A 吗？', understood: false, help: 'hint' };
  if (/^(?:不会|不知道|想不出来|不太清楚|不清楚|忘了)/.test(message)) return { reply: '没关系。两个人各拿一把钥匙又都想要对方那把，会怎样？', understood: false, help: 'hint' };
  if (message.length >= 20) return { reply: '对，你说到点子上了：顺序固定后环就接不起来。', understood: true, help: 'none' };
  return { reply: '你是说顺序这件事吗？为什么固定顺序就不会互相等？', understood: false, help: 'none' };
});

const OWN_WORDS = '给资源编上号，大家只能从小往大拿，于是不会有人反过来等别人手里更小的号，圈就接不起来了。';

test('1) 打开 0 模型调用 + Shift+T 快捷键与抽屉入口 + 不抢焦点', async (t) => {
  const tutor = deadlockTutor();
  const service = await createSeededService(t, { complete: tutor.complete });

  const opened = await service.call('socratic.get', { deckId: 'deck-os', cardId: 'card-deadlock' });
  assert.equal(tutor.calls.length, 0, 'opening inline Socratic panel must invoke 0 model calls');
  assert.equal(opened.persisted, false);
  assert.equal(opened.state.stage, 'answer');
  assert.equal(opened.state.hintLevel, 0);
  assert.equal(opened.state.turns.length, 1);
  assert.doesNotMatch(opened.state.turns[0].text, /破坏了循环等待/, 'opening prompt does not spoil the answer');
  assert.match(opened.state.turns[0].text, /可以直接问/, 'the opening says a question is welcome');
  assert.doesNotMatch(opened.state.turns[0].text, /死锁必要条件/, 'the topic string (which can carry internal tags) is not pasted into the line');

  const ctx = {
    inside: true, modalOpen: false, page: 'review', busy: false,
    run: { id: 'r1', mode: 'path', card: { id: 'card-deadlock', kind: 'quiz' } },
  };
  const shiftT = uiMod.shortcutAction({ key: 'T', code: 'KeyT', shiftKey: true, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false }, ctx);
  assert.deepEqual(shiftT?.action, { type: 'socratic-toggle' });
  const examShiftT = uiMod.shortcutAction({ key: 'T', code: 'KeyT', shiftKey: true, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false }, { ...ctx, run: { ...ctx.run, mode: 'exam' } });
  assert.equal(examShiftT?.action, null);

  const drawerHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', prompt: opened.prompt, topic: opened.topic, modelReady: true, initialView: opened,
  }));
  assert.match(drawerHtml, /data-testid="socratic-inline-drawer"/);
  assert.match(drawerHtml, /data-own-keys=""/);
  assert.doesNotMatch(drawerHtml, /autofocus/i, 'opening Socratic drawer must not steal focus from the question');

  const assistHtml = renderToStaticMarkup(h(uiMod.AssistFormPanelView, {
    mode: 'ask',
    seed: { mode: 'ask', text: '', choices: [], relation: 'prerequisite', nonce: 1 },
    run: { id: 'r1', mode: 'path', card: { id: 'card-deadlock', prompt: opened.prompt } },
    model: { ready: true },
    copy: { askNote: () => '', improveLabel: () => '' },
    fixPhrases: { phrases: [], remove: () => {} },
    courseRules: { rules: [] },
    renderThinkingField: (_m, _n, _s, field) => field,
    onClose: () => {},
    onOpenSocratic: () => {},
  }));
  assert.match(assistHtml, /AI 帮我理解/);
  assert.match(assistHtml, /苏格拉底带学/);

  assert.ok(assistantRefusal('socratic.step'));
});

test('2) 反问不算答错：「什么排队？」得到直接回答，提示等级不动，模型看得到上一句', async (t) => {
  const tutor = scriptedTutor([
    { reply: '先说场景：好几个线程抢同一个资源。你觉得为什么会卡住？', understood: false, help: 'none' },
    { reply: '这里的「排队」指拿不到锁的线程停下来等。按固定顺序拿锁会改变什么？', understood: false, help: 'none' },
  ]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'deck-os', cardId: 'card-deadlock' }] });
  const say = (text) => service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', runId: run.id, text });

  await say('理解是在什么情景下会需要这个机制，解决什么需求');
  const asked = await say('什么排队？');

  assert.equal(asked.state.hintLevel, 0, 'a question never climbs a hint ladder');
  assert.equal(asked.state.maxHintLevelUsed, 0);
  assert.equal(asked.state.stage, 'answer');
  assert.equal(asked.state.turns.at(-1).kind, 'reply');
  assert.equal(asked.state.turns.at(-1).text, '这里的「排队」指拿不到锁的线程停下来等。按固定顺序拿锁会改变什么？', 'the reply is shown whole');
  const second = tutor.calls[1].payload;
  assert.equal(second.message, '什么排队？');
  assert.deepEqual(second.conversation.map((turn) => turn.from), ['tutor', 'learner', 'tutor'], 'the model is given what both sides said');
  assert.match(second.conversation.at(-1).text, /好几个线程抢同一个资源/);
  assert.equal(second.card.question.length > 0 && second.card.referenceAnswer.length > 0, true);
  const entry = (await service.store.read()).runs.find((item) => item.id === run.id).entries[0];
  assert.equal(entry.assistance.askedTutorBeforeAnswer, true);
  assert.equal(entry.assistance.hintUsed, false, 'no hint was given, so none is recorded');
});

test('3) 第一句就讲清楚了直接收尾，不再要求复述；之后还能接着问', async (t) => {
  const tutor = scriptedTutor([
    { reply: '对，顺序固定后环路接不起来。', understood: true, help: 'answer' },
    { reply: '可以，打破占有且等待也行：一次把需要的都申请到。', understood: true, help: 'none' },
  ]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const ref = { deckId: 'deck-os', cardId: 'card-deadlock' };

  const first = await service.call('socratic.step', { ...ref, text: OWN_WORDS });
  assert.equal(first.state.stage, 'summary', 'an own-words explanation closes at once');
  assert.equal(first.state.retellPassed, true);
  assert.equal(first.state.summary.mastered, true, 'the recap in the confirmation is not counted as help');
  assert.equal(first.state.revealed, false);
  assert.equal(first.state.turns.at(-1).kind, 'summary');
  assert.equal(tutor.calls.length, 1);

  const more = await service.call('socratic.step', { ...ref, text: '那打破别的条件行不行？' });
  assert.equal(more.state.stage, 'summary');
  assert.equal(more.state.retellPassed, true);
  assert.match(more.state.turns.at(-1).text, /占有且等待/);

  const doneHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, { ...ref, initialView: more, modelReady: true, cardAnswered: false }));
  assert.match(doneHtml, /data-testid="socratic-inline-summary"/);
  assert.match(doneHtml, /回到原题作答/);
  assert.match(doneHtml, /<textarea(?![^>]*disabled)/, 'the box stays open for follow-up questions');

  const answeredHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, { ...ref, initialView: more, modelReady: true, cardAnswered: true, retryQueued: true }));
  assert.match(answeredHtml, /<button[^>]*>收起带学<\/button>/);
  assert.match(answeredHtml, /本轮末尾会再考一遍这道题/);
  assert.doesNotMatch(answeredHtml, /<button[^>]*>[^<]*回到原题重做/);
});

test('4) 提示由模型顺着对话给；中断后恢复；历史与发给模型的内容都有上限', async (t) => {
  const tutor = deadlockTutor();
  const service = await createSeededService(t, { complete: tutor.complete });
  const ref = { deckId: 'deck-os', cardId: 'card-deadlock' };

  await service.call('socratic.step', { ...ref, text: '不太清楚' });
  const hinted = await service.call('socratic.step', { ...ref, action: 'hint' });
  assert.equal(tutor.calls.at(-1).payload.request, 'hint');
  assert.equal(tutor.calls.at(-1).payload.conversation.length, 3, 'the hint request carries the talk so far');
  assert.equal(hinted.state.hintLevel, 2);
  assert.equal(hinted.state.turns.at(-1).kind, 'hint');
  assert.match(hinted.state.turns.at(-1).text, /还可能出现 A 等 B/);
  assert.equal((await service.store.read()).decks[0].cards[0].socratic.hintLevel, 2, 'kept on the card in the backend');

  const resumed = await service.call('socratic.get', ref);
  assert.equal(resumed.persisted, true);
  assert.equal(resumed.state.stage, 'answer');
  assert.equal(resumed.state.turns.length, 4);

  for (let i = 0; i < 20; i += 1) await service.call('socratic.step', { ...ref, text: `懂了吗 ${i}` });
  const capped = await service.call('socratic.get', ref);
  assert.ok(capped.state.turns.length <= SOCRATIC_MAX_TURNS, `turns capped at ${SOCRATIC_MAX_TURNS}`);
  assert.ok(tutor.calls.at(-1).payload.conversation.length <= 12, 'only the last turns are sent');
  assert.equal(capped.state.hintLevel, 2, 'plain replies add no help');
});

test('5) 复制本条与复制整段含题目、两边说的话、用过的提示，不带内部阶段代号', async (t) => {
  const tutor = deadlockTutor();
  const service = await createSeededService(t, { complete: tutor.complete });
  const ref = { deckId: 'deck-os', cardId: 'card-deadlock' };
  await service.call('socratic.step', { ...ref, text: '忘了' });
  const done = await service.call('socratic.step', { ...ref, text: OWN_WORDS });

  const single = uiMod.formatSocraticTurnCopy(done.state.turns[2], done);
  assert.match(single, /题目：为什么按全局顺序编号并升序申请资源可以预防死锁/);
  assert.match(single, /老师（给了提示）：没关系/);

  const full = uiMod.formatSocraticTranscriptCopy(done);
  assert.match(full, /苏格拉底带学：死锁必要条件/);
  assert.match(full, /我：忘了/);
  assert.match(full, /老师（给了提示）/);
  assert.match(full, /结果：讲清楚了（用过提示）/);
  assert.doesNotMatch(full, /L0|L1|L2|阶段|判定/);

  const html = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, { ...ref, initialView: done, modelReady: true }));
  assert.match(html, /复制本条/);
  assert.match(html, /复制整段/);
  assert.doesNotMatch(html, /L0|socratic-inline__stages|判定/, 'no state-machine words on screen');
});

test('6) 统计隔离与独立口径 (#1323-11) + 错题本保留薄弱并显示提示等级 + 宽/窄屏不遮挡题目与选项', async (t) => {
  const service = await createSeededService(t, { complete: deadlockTutor().complete });
  const now = Date.now();

  // Official wrong answer on the real question first -> card enters WrongBook weak & is undoable
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'deck-os', cardId: 'card-deadlock' }] });
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['b'] });

  // Now open the drawer, get stuck (one hint), then explain it (all inside the same runId)
  await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', runId: run.id, text: '不会' });
  const right = await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', runId: run.id, text: OWN_WORDS });
  assert.equal(right.state.stage, 'summary');
  assert.equal(right.state.maxHintLevelUsed, 1);

  await service.call('socratic.step', {
    deckId: 'deck-os', cardId: 'card-deadlock', runId: run.id, text: '那我回原题试试',
  });

  const state = await service.store.read();
  const card = state.decks[0].cards[0];

  // 0) The answer log holds answers only: the Socratic steps live on card.socratic, never in state.attempts
  assert.deepEqual(state.attempts.map((a) => a.assessment), ['graded'], 'only the official answer is in the answer log');

  // 1) WrongBook MUST NOT be cleared out of `weak` by Socratic pass, and still exposes Socratic hintLevel
  const wb = wrongBook(state, { course: '操作系统', view: 'weak' });
  const wbItem = wb.items.find((it) => it.cardId === 'card-deadlock');
  assert.ok(wbItem, 'Socratic pass must NOT clear an unresolved mistake from WrongBook weak');
  assert.equal(wbItem.socratic?.hintLevel, 1, 'wrongBook row exposes highest Socratic hint level');
  assert.equal(wbItem.socratic?.stage, 'summary');
  assert.equal(wbItem.socratic?.retellPassed, true);
  const detail = wrongDetail(state, { deckId: 'deck-os', cardId: 'card-deadlock' });
  assert.equal(detail.socratic?.hintLevel, 1, 'wrongDetail exposes Socratic hint level');

  // 2) latestOutcomes stays at the official wrong verdict (< 3)
  const outcome = latestOutcomes(state.attempts);
  assert.ok(outcome('deck-os', 'card-deadlock') < 3, 'latestOutcomes must ignore socratic attempt');

  // 3) Z-key undoableForRun still targets the official attempt, NOT hijacked by socratic
  const latestRun = state.runs.find((r) => r.id === run.id);
  const undoable = undoableForRun(state.attempts, latestRun);
  assert.ok(undoable, 'official answer remains undoable');
  assert.notEqual(undoable.assessment, 'socratic', 'socratic attempt must never hijack Z undo');

  // 4) studyStats / today-pace / forecast / daily-recap never double-count socratic alongside the official answer
  const stats = studyStats(state, { course: '操作系统' }, new Date(now));
  assert.equal(stats.totals.attempts, 1, 'official attempt counted once, never double-counted with socratic');
  assert.equal(stats.totals.gradedAttempts, 1);
  assert.equal(stats.totals.correctRate, 0, 'official wrong answer rate stays honest (0%), not inflated by socratic');
  assert.deepEqual(stats.totals.socratic, {
    cards: 1,
    retold: 1,
    hintLevels: { 0: 0, 1: 1, 2: 0 },
    stages: { answer: 0, judge: 0, retell: 0, summary: 1 },
  }, 'socratic tutoring is counted from card.socratic: one question, retold, used L1, finished');
  assert.equal(stats.trend.at(-1)?.gradedCount, 1);

  const todayPace = uiMod.computeTodayPace({ attempts: state.attempts, now });
  assert.equal(todayPace.todayCount, 1, 'today-pace must not double-count socratic attempts');

  const learnerPace = extractLearnerPace(state.attempts, { now });
  assert.equal(learnerPace.attempts7d, 1, 'pace/forecast must not double-count socratic attempts');

  const recap = recapGroups(state, { now: new Date(now) });
  const recapCard = recap.groups[0]?.questions.find((q) => q.cardId === 'card-deadlock');
  assert.equal(recapCard?.attempts.length, 1, 'daily-recap must exclude socratic attempts');
  assert.notEqual(recapCard?.attempts[0]?.assessment, 'socratic');

  // 5) New untouched card stays `new` after Socratic tutoring alone (never orphaned from new-card queue)
  const freshService = await createSeededService(t, { complete: deadlockTutor().complete });
  await freshService.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', text: OWN_WORDS });
  const freshState = await freshService.store.read();
  const freshCard = freshState.decks[0].cards[0];
  assert.equal(cardLevel(freshCard, latestOutcomes(freshState.attempts)('deck-os', 'card-deadlock')), 'new');

  // Responsive CSS: 2-column beside question on wide screen, single-column below on narrow screen (<=959px), text wraps (#1309)
  const sessionSheet = parseCss(readFileSync(new URL('../ui/review/session.css', import.meta.url), 'utf8'));
  const drawerSheet = parseCss(readFileSync(new URL('../ui/review/socratic-inline.css', import.meta.url), 'utf8'));
  assert.equal(
    sessionSheet.declarations.some(
      (d) => d.ctx.at(-1) === '.review-body.has-socratic'
        && !d.ctx.some((c) => /^@(?:media|container)\b/.test(c))
        && d.prop === 'grid-template-columns'
        && d.value === 'minmax(0, 1fr) minmax(320px, 420px)',
    ),
    true,
    '.review-body.has-socratic lays out a 2-column desktop grid beside the question',
  );
  for (const narrowCtx of [/^@container study \(max-width:\s*959px\)$/, /^@media \(max-width:\s*959px\)$/]) {
    assert.equal(drawerSheet.blocks.some((b) => narrowCtx.test(b.prelude)), true, `socratic-inline.css declares ${narrowCtx}`);
    assert.equal(
      drawerSheet.declarations.some(
        (d) => d.ctx.at(-1) === '.has-socratic > .socratic-inline-drawer'
          && d.prop === 'grid-column'
          && d.value === '1'
          && d.ctx.some((c) => narrowCtx.test(c)),
      ) && drawerSheet.declarations.some(
        (d) => d.ctx.at(-1) === '.has-socratic > .socratic-inline-drawer'
          && d.prop === 'position'
          && d.value === 'static'
          && d.ctx.some((c) => narrowCtx.test(c)),
      ),
      true,
      `narrow rule ${narrowCtx} stacks drawer in column 1 with static position`,
    );
  }
  assert.equal(
    drawerSheet.declarations.some((d) => d.ctx.at(-1) === '.socratic-inline__body' && d.prop === 'overflow-wrap' && d.value === 'anywhere'),
    true,
    '.socratic-inline__body wraps long tokens without overflow',
  );
  assert.ok(card.socratic.retellPassed);
});

test('7) 回复不按问号截断；参考答案随时可看且 0 模型调用', async (t) => {
  const long = '你问的是排队吗？这里指拿不到锁的线程停下来等。\n\n`ok ? 1 : 0` 和它无关。那固定顺序会改变什么？';
  const tutor = scriptedTutor([{ reply: long, understood: false, help: 'none' }]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const asked = await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', text: '什么排队？' });
  assert.equal(asked.state.turns.at(-1).text, long);

  const html = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, { deckId: 'deck-os', cardId: 'card-deadlock', initialView: asked, modelReady: true }));
  assert.match(html, /data-testid="socratic-reveal-btn"/, 'offered from the first turn, not only after two hints');

  const revealed = await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', action: 'reveal' });
  assert.equal(tutor.calls.length, 1, 'action: reveal must invoke 0 model calls');
  assert.equal(revealed.state.stage, 'answer');
  assert.equal(revealed.state.hintLevel, 2);
  assert.equal(revealed.state.turns.at(-1).kind, 'reveal');

  const text = buildRevealMessage({ answer: '使用三元表达式 x > 0 ? 1 : -1', explanation: '为什么这样写？这样能避免空值。' }, 'zh');
  assert.match(text, /参考答案\*\*：使用三元表达式 x > 0 \? 1 : -1/);
  assert.match(text, /为什么\*\*：为什么这样写？这样能避免空值。$/);
});

const ref = { deckId: 'deck-os', cardId: 'card-deadlock' };
const startRun = (service) => service.call('review.start', { mode: 'path', scope: [ref] });

test('8) help taken in the drawer before answering marks the run answer as assisted, never a clean pass', async (t) => {
  const service = await createSeededService(t);
  const run = await startRun(service);
  const step = (args) => service.call('socratic.step', { ...ref, runId: run.id, offline: true, ...args });

  // Open the drawer on the unanswered question: L1, L2, then the reference answer; back to the question, answer correctly.
  await step({ action: 'hint' });
  await step({ action: 'hint' });
  await step({ action: 'reveal' });
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['a'] });

  const state = await service.store.read();
  const answers = state.attempts.filter((a) => a.runId === run.id);
  assert.equal(answers.length, 1, 'one answer in the log: the learner\'s');
  const [answer] = answers;
  assert.equal(answer.assistance.used, true);
  assert.equal(answer.assistance.askedTutorBeforeAnswer, true);
  assert.equal(answer.assistance.hintUsed, true);
  assert.equal(answer.assistance.revealedBeforeAnswer, true);
  assert.equal(answer.grade, 3, 'a right answer after the hint ladder is graded as hinted (3), not a clean 4');

  const solidity = questionSolidity(state.attempts)({ ...ref, level: 'learning' });
  assert.equal(solidity.exposedSolution, true, 'the exposure check sees the reference answer shown before answering');
  assert.equal(solidity.right, 0, 'no independent pass');
  assert.equal(solidity.assistedOnly, true);
});

test('9) the evidence follows what the drawer showed: asking only marks the tutor, a hint marks the hint', async (t) => {
  const service = await createSeededService(t, { complete: deadlockTutor().complete });
  const run = await startRun(service);
  const step = (args) => service.call('socratic.step', { ...ref, runId: run.id, ...args });
  const entryAssistance = async () => (await service.store.read()).runs.find((r) => r.id === run.id).entries[0].assistance;

  // A right answer at L0 in the drawer: the tutor was asked, no hint and no answer was shown.
  await step({ text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。' });
  assert.deepEqual(
    { used: true, askedTutorBeforeAnswer: true, hintUsed: false, revealedBeforeAnswer: false },
    pick(await entryAssistance(), ['used', 'askedTutorBeforeAnswer', 'hintUsed', 'revealedBeforeAnswer']),
  );

  // Reset and take one hint: the hint is recorded too, and evidence only adds up.
  await step({ action: 'reset' });
  await step({ action: 'hint', offline: true });
  const marked = await entryAssistance();
  assert.equal(marked.hintUsed, true);
  assert.equal(marked.revealedBeforeAnswer, false);

  // Once answered, a later Socratic step changes nothing in the stored answer.
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['b'] });
  const before = structuredClone((await service.store.read()).attempts);
  await step({ action: 'reveal' });
  assert.deepEqual((await service.store.read()).attempts, before);
});

test('10) no run: a step without runId writes the card only; an exam in progress refuses Socratic steps', async (t) => {
  const service = await createSeededService(t);
  const run = await startRun(service);
  await service.call('socratic.step', { ...ref, action: 'reveal' });
  const state = await service.store.read();
  assert.equal(state.runs.find((r) => r.id === run.id).entries[0].assistance, undefined, 'a step outside a run marks no run');
  assert.equal(state.decks[0].cards[0].socratic.stage, 'answer');

  const exam = await service.call('review.start', { mode: 'exam', scope: [ref] });
  await assert.rejects(
    service.call('socratic.step', { ...ref, runId: exam.id, action: 'reveal' }),
    /exam/i,
  );
});

test('11) Socratic steps never enter the answer log: 错因 lands on the real answer and the daily plan does not count an unanswered question', async (t) => {
  const service = await createSeededService(t, { complete: deadlockTutor().complete });

  // Every kind of step on a question outside a run: nothing in state.attempts.
  const step = (args) => service.call('socratic.step', { ...ref, ...args });
  await step({ text: '不知道' });
  await step({ text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。' });
  await step({ text: '因为死锁需要四个必要条件同时成立，全局升序编号后不会形成循环等待环路，所以能预防死锁。' });
  await step({ action: 'reset' });
  await step({ action: 'reveal' });
  assert.deepEqual((await service.store.read()).attempts, []);

  // Daily plan: a Socratic step before answering does not make the question done.
  const run = await startRun(service);
  await service.store.update((s) => { s.runs.find((r) => r.id === run.id).dailyPlanTaskId = 'task-1'; });
  const task = { id: 'task-1', learningTask: { kind: 'practice', scope: [ref] } };
  await service.call('socratic.step', { ...ref, runId: run.id, offline: true, action: 'reset' });
  await service.call('socratic.step', { ...ref, runId: run.id, text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。' });
  assert.equal(taskProgress(await service.store.read(), task).done, 0, 'an unanswered question is not done');

  // 错因 after a wrong answer and a Socratic step is saved on the wrong answer.
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['b'] });
  await service.call('socratic.step', { ...ref, runId: run.id, offline: true, action: 'reveal' });
  await service.call('attempt.errorReason.set', { ...ref, runId: run.id, errorReason: 'concept' });
  const state = await service.store.read();
  const wrong = state.attempts.find((a) => a.runId === run.id);
  assert.equal(wrong.grade, 1);
  assert.equal(wrong.errorReason, 'concept');
  assert.equal(state.attempts.length, 1);
  assert.equal(taskProgress(state, task).done, 1);
});

test('12) reopening the drawer shows saved help again: it is recorded on the unanswered question of the new run', async (t) => {
  let modelCalls = 0;
  const service = await createSeededService(t, { complete: async () => { modelCalls += 1; return '{}'; } });

  // Run A: L1, L2 and the reference answer, then the round ends without an answer.
  const runA = await startRun(service);
  for (const action of ['hint', 'hint', 'reveal']) await service.call('socratic.step', { ...ref, runId: runA.id, offline: true, action });
  await service.call('review.end', { runId: runA.id });

  // Run B: only open the drawer (no step), then answer correctly.
  const runB = await startRun(service);
  const opened = await service.call('socratic.get', { ...ref, runId: runB.id });
  assert.equal(opened.state.revealed, true, 'the drawer shows the saved reference answer');
  assert.equal(modelCalls, 0, 'opening stays at zero model calls');
  await service.call('review.answer', { runId: runB.id, cardId: 'card-deadlock', selected: ['a'] });

  const state = await service.store.read();
  const answer = state.attempts.find((a) => a.runId === runB.id);
  assert.equal(answer.assistance.askedTutorBeforeAnswer, true);
  assert.equal(answer.assistance.hintUsed, true);
  assert.equal(answer.assistance.revealedBeforeAnswer, true);
  assert.equal(answer.grade, 3, 'not a clean pass');
  assert.equal(questionSolidity(state.attempts)({ ...ref, level: 'learning' }).right, 0);
});

test('13) opening the drawer records nothing when there is no saved help, no run, or the question is answered', async (t) => {
  const service = await createSeededService(t);
  const run = await startRun(service);
  const entry = async () => (await service.store.read()).runs.find((r) => r.id === run.id).entries[0];

  await service.call('socratic.get', { ...ref, runId: run.id });
  assert.equal((await entry()).assistance, undefined, 'no saved record: nothing shown but the opening question');

  // A saved record that was reset holds only the opening question: still nothing to record.
  await service.call('socratic.step', { ...ref, action: 'hint' });
  await service.call('socratic.step', { ...ref, action: 'reset' });
  await service.call('socratic.get', { ...ref, runId: run.id });
  assert.equal((await entry()).assistance, undefined, 'an empty saved record records nothing');

  // Saved help, but no run named: nothing to mark.
  await service.call('socratic.step', { ...ref, action: 'reveal' });
  await service.call('socratic.get', ref);
  assert.equal((await entry()).assistance, undefined);

  // Saved help on an answered question: the answer keeps what it proved.
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['a'] });
  const before = structuredClone(await entry());
  await service.call('socratic.get', { ...ref, runId: run.id });
  assert.deepEqual(await entry(), before);
});

const SCHEDULE = { due_at: '2030-01-01T00:00:00.000Z', stability: 42, difficulty: 5, reps: 7, lapses: 0, state: 2, last_review: '2026-11-01T00:00:00.000Z' };
// A question the publish checks accept as it is (the shared seed is a short one), with a schedule and 讲清楚过 to lose.
const QUOTE = '按全局顺序申请资源可以破坏循环等待条件。';
const PUBLISHABLE = { citations: [{ sourceId: 'source-os', quote: QUOTE }], objective: '说明按序申请为何能预防死锁', hint: '想想死锁的四个必要条件', misconception: '误以为破坏的是互斥条件',
  options: [{ id: 'a', text: '破坏了循环等待条件', explanation: '按序申请不会成环', correct: true }, { id: 'b', text: '破坏了互斥条件', explanation: '资源仍然互斥', correct: false },
    { id: 'c', text: '破坏了不可剥夺条件', explanation: '资源仍不可剥夺', correct: false }] };
const seedPublishable = (service) => service.store.update((s) => {
  s.sources.push({ id: 'source-os', title: '死锁', text: QUOTE });
  Object.assign(s.decks[0].cards[0], structuredClone(PUBLISHABLE), { review: structuredClone(SCHEDULE), retell: { passed: 1, at: 1 } });
});
const liveCardOf = async (service) => (await service.store.read()).decks.find((deck) => deck.id === 'deck-os').cards.find((card) => card.id === 'card-deadlock');

test('14) the drawer\'s record is the learner\'s, not the question: an unchanged deck edit keeps the schedule, 讲清楚过 and the record', async (t) => {
  const service = await createSeededService(t);
  await seedPublishable(service);
  const before = contentKey(await liveCardOf(service));

  // The deck is opened for editing, one hint is taken in the drawer, the edit is published as it was.
  const draft = await service.call('deck.edit', { id: 'deck-os' });
  await service.call('socratic.step', { ...ref, offline: true, action: 'hint' });
  assert.equal(contentKey(await liveCardOf(service)), before, 'a Socratic step does not change what the question asks');
  await service.call('draft.publish.quick', { id: draft.id });

  const card = await liveCardOf(service);
  assert.deepEqual(pick(card.review, ['due_at', 'stability', 'reps']), pick(SCHEDULE, ['due_at', 'stability', 'reps']), 'the schedule is not reset');
  assert.deepEqual(card.retell, { passed: 1, at: 1 });
  assert.equal(card.socratic.hintLevel, 1, 'the live card\'s record survives, not the draft\'s older copy');
});

test('15) a step leaves the round alone, an edit of the answer drops the record, and an undo of a wording fix keeps it', async (t) => {
  const service = await createSeededService(t);
  await seedPublishable(service);
  const run = await startRun(service);
  await service.call('socratic.step', { ...ref, runId: run.id, offline: true, action: 'hint' });
  const state = await service.store.read();
  assert.equal(staleReviewEntries(state, state.runs.find((item) => item.id === run.id)).length, 0, 'the round does not see a changed question after a step');
  await service.call('review.end', { runId: run.id });

  // A wording fix (the explanation) keeps the record; undoing it must not bring an older record back.
  await service.call('card.update', { ...ref, patch: { explanation: '按序申请破坏了循环等待，所以不会死锁。' }, reason: 'wording' });
  await service.call('socratic.step', { ...ref, offline: true, action: 'hint' });
  assert.equal((await liveCardOf(service)).socratic.hintLevel, 2);
  await service.call('card.revert', { ...ref });
  const reverted = await liveCardOf(service);
  assert.equal(reverted.socratic.hintLevel, 2, 'card.revert restores the question, not the learner\'s record');
  assert.ok((reverted.revisions || []).every((revision) => !('socratic' in revision.content)), 'no revision stores the transcript');

  // A changed answer is a new question: like 讲清楚过, the old dialogue says nothing about it.
  await service.call('card.update', { ...ref, reason: 'answer', patch: {
    answer: '破坏了互斥条件。',
    options: PUBLISHABLE.options.map((option) => ({ ...option, correct: option.id === 'b' })),
  } });
  assert.equal((await liveCardOf(service)).socratic, undefined);
});

test('16) while an answer is being graded the drawer does not show the reference answer either', async (t) => {
  const service = await createSeededService(t);
  const run = await startRun(service);
  await service.store.update((s) => { claimGrading(s.runs.find((item) => item.id === run.id).entries[0], 'task-1'); });
  await assert.rejects(service.call('socratic.step', { ...ref, runId: run.id, offline: true, action: 'reveal' }), (error) => error.message.includes(GRADING_BUSY));
  assert.notEqual((await liveCardOf(service)).socratic?.revealed, true);
  // A hint is not the answer: it stays available.
  await service.call('socratic.step', { ...ref, runId: run.id, offline: true, action: 'hint' });
});

test('17) 模型没回复：说出真实原因，什么都不存，绝不拿本地模板顶替', async (t) => {
  const tutor = scriptedTutor([new Error('rate limit: 429 too many requests')]);
  const service = await createSeededService(t, { complete: tutor.complete });
  await assert.rejects(service.call('socratic.step', { ...ref, text: '没懂啥意思' }), (error) => /带学没有拿到回复/.test(error.message) && /429/.test(error.message));
  assert.equal((await liveCardOf(service)).socratic, undefined, 'a failed step saves nothing');
});

test('18) 没有模型：对话直说需要模型；自带提示和参考答案照常可看，且永远不判「讲清楚了」', async (t) => {
  const service = await createSeededService(t);
  await assert.rejects(service.call('socratic.step', { ...ref, text: OWN_WORDS }), /带学对话需要模型/);
  assert.equal((await liveCardOf(service)).socratic, undefined);
  const hinted = await service.call('socratic.step', { ...ref, action: 'hint' });
  assert.equal(hinted.state.turns.at(-1).text, '题目自带的提示：想想死锁的四个必要条件');
  const shown = await service.call('socratic.step', { ...ref, action: 'reveal' });
  assert.match(shown.state.turns.at(-1).text, /参考答案/);
  assert.equal(shown.state.retellPassed, false);

  await service.store.update((s) => { delete s.decks[0].cards[0].hint; delete s.decks[0].cards[0].socratic; });
  await assert.rejects(service.call('socratic.step', { ...ref, action: 'hint' }), /没有自带提示/);
  assert.equal((await liveCardOf(service)).socratic, undefined, 'no hint given, no hint recorded');

  const view = await service.call('socratic.get', ref);
  assert.equal(view.hasHint, false);
  const html = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, { ...ref, initialView: view, modelReady: false }));
  assert.match(html, /data-model-gate/);
  assert.doesNotMatch(html, /<textarea/, 'no box that cannot be answered');
  assert.doesNotMatch(html, /给个提示/, 'a hint that cannot be given is not offered');
  assert.match(html, /看参考答案/);
});

test('19) 光说「懂了」或照抄老师的话，模型说懂了也不算讲清楚', async (t) => {
  const said = '两个线程各占一把锁又等对方那把，就谁也走不了。固定顺序后不会出现这种情况。';
  const tutor = scriptedTutor([{ reply: said, understood: false, help: 'hint' }, { reply: '好。', understood: true, help: 'none' }]);
  const service = await createSeededService(t, { complete: tutor.complete });
  await service.call('socratic.step', { ...ref, text: '不会' });
  for (const text of ['懂了！', '好的。', '两个线程各占一把锁又等对方那把，就谁也走不了']) {
    const step = await service.call('socratic.step', { ...ref, text });
    assert.equal(step.state.retellPassed, false, text);
    assert.notEqual(step.state.stage, 'summary', text);
  }
});

test('20) 模型不按 JSON 回：纯文字照样显示但不算懂、按给过提示记；坏数据报错', async (t) => {
  const tutor = scriptedTutor(['我换个说法：两个人在窄桥上对着走，谁也不让，会怎样？', '```json\n{"reply": ']);
  const service = await createSeededService(t, { complete: tutor.complete });
  const plain = await service.call('socratic.step', { ...ref, text: '没懂啥意思' });
  assert.match(plain.state.turns.at(-1).text, /窄桥/);
  assert.equal(plain.state.retellPassed, false);
  assert.equal(plain.state.hintLevel, 1);
  await assert.rejects(service.call('socratic.step', { ...ref, text: '还是不懂' }), /读不出来/);
  assert.equal((await liveCardOf(service)).socratic.turns.length, plain.state.turns.length);
});

test('21) 回复实际说出了答案：按看过答案记；批改中则整步拒绝', async (t) => {
  const tutor = scriptedTutor([{ reply: '答案就是破坏了循环等待条件。', understood: false, help: 'answer' }]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const run = await startRun(service);
  await service.store.update((s) => { claimGrading(s.runs.find((item) => item.id === run.id).entries[0], 'task-1'); });
  await assert.rejects(service.call('socratic.step', { ...ref, runId: run.id, text: '直接告诉我' }), (error) => error.message.includes(GRADING_BUSY));
  assert.equal(tutor.calls[0].payload.answerMustStayHidden, true, 'the model is told too');
  assert.equal((await liveCardOf(service)).socratic, undefined);

  const free = await service.call('socratic.step', { ...ref, text: '直接告诉我' });
  assert.equal(free.state.revealed, true);
  assert.equal(free.state.turns.at(-1).kind, 'reveal');
});

test('22) 本轮已作答时：开场从结果出发，模型拿到学习者实际选了什么', async (t) => {
  const tutor = deadlockTutor();
  const service = await createSeededService(t, { complete: tutor.complete });
  const run = await startRun(service);
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['b'] });
  const opened = await service.call('socratic.get', { ...ref, runId: run.id });
  assert.match(opened.state.turns[0].text, /刚才这题没答对/);
  await service.call('socratic.step', { ...ref, runId: run.id, text: '我以为是互斥' });
  assert.deepEqual(tutor.calls[0].payload.learnerRoundAnswer, { correct: false, chose: ['破坏了互斥条件'] });
});

test('23) 旧版留下的对话（复述阶段、旧的 turn 类型）能接着聊', async (t) => {
  const tutor = scriptedTutor([{ reply: '你问得对，刚才那句没说清。固定顺序为什么能让圈接不起来？', understood: false, help: 'none' }]);
  const service = await createSeededService(t, { complete: tutor.complete });
  await service.store.update((s) => {
    s.decks[0].cards[0].socratic = { version: 1, language: 'zh', stage: 'retell', hintLevel: 0, maxHintLevelUsed: 0, retellAttempts: 1, retellPassed: false,
      answeredCorrectly: true, revealed: false, currentAnswer: '', startedAt: 1, updatedAt: 1, summary: null,
      turns: [{ id: 't1', role: 'tutor', kind: 'retell-probe', stage: 'retell', hintLevel: 0, text: '这次复述还偏简略', at: 1 }] };
  });
  const next = await service.call('socratic.step', { ...ref, action: 'retell', text: '没懂啥意思' });
  assert.equal(next.state.stage, 'answer');
  assert.equal(next.state.turns.length, 3);
  assert.equal(tutor.calls[0].payload.conversation[0].text, '这次复述还偏简略', 'the old line is context the tutor can explain');
});

test('24) 超时会叫停底层调用，并带上任务名与时限交给轻量模型通道', async () => {
  let signal;
  let options;
  const hang = (system, prompt, given) => { options = given; signal = given.signal; return new Promise(() => {}); };
  const state = { decks: [{ id: 'deck-os', cards: [{ id: 'card-deadlock', prompt: '题', answer: '答案', kind: 'flashcard' }] }], sources: [], runs: [] };
  await assert.rejects(evaluateCardSocraticStep(state, { ...ref, text: '在吗' }, { complete: hang, timeoutMs: 20 }), /没有回应/);
  assert.equal(signal.aborted, true);
  assert.equal(options.task, 'review.socratic');
  assert.equal(options.timeoutMs, 20);
});

test('25) 收尾以后再问出答案或提示，照样记到还没作答的这道题上', async (t) => {
  const tutor = scriptedTutor([
    { reply: '对，顺序固定后环路接不起来。', understood: true, help: 'none' },
    { reply: '这题选「破坏了循环等待条件」。', understood: true, help: 'answer' },
  ]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const run = await startRun(service);
  const say = (text) => service.call('socratic.step', { ...ref, runId: run.id, text });
  assert.equal((await say(OWN_WORDS)).state.stage, 'summary');

  const after = await say('那这题到底选哪个？');
  assert.equal(after.state.revealed, true, '「understood」 stays true after closing; the help in that reply still counts');
  assert.equal(after.state.turns.at(-1).kind, 'reveal');
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['a'] });
  const answer = (await service.store.read()).attempts.find((a) => a.runId === run.id);
  assert.equal(answer.assistance.revealedBeforeAnswer, true);
  assert.equal(answer.grade, 3, 'not a clean pass');
});

test('26) 回复里原样出现标准答案：模型自报没给帮助也按看过答案记', async (t) => {
  const leak = '你想想看，是不是破坏了循环等待条件这一条？';
  const tutor = scriptedTutor([{ reply: leak, understood: false, help: 'none' }]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const step = await service.call('socratic.step', { ...ref, text: '我没思路' });
  assert.equal(step.state.revealed, true);
  assert.equal(step.state.turns.at(-1).kind, 'reveal');
});

test('27) 等回复时题目改了、对话清了或另一条先落盘：这条回复不保存', async (t) => {
  let during = async () => {};
  const complete = async () => { await during(); return JSON.stringify({ reply: '为什么固定顺序就不会互相等？', understood: false, help: 'none' }); };
  const service = await createSeededService(t, { complete });
  const say = (text) => service.call('socratic.step', { ...ref, text });
  await say('第一句');
  const turnsNow = async () => (await liveCardOf(service)).socratic?.turns.length ?? 0;

  during = async () => { during = async () => {}; await service.call('socratic.step', { ...ref, action: 'reset' }); };
  await assert.rejects(say('清空前发的'), /刚刚变了/);
  assert.equal(await turnsNow(), 1, 'only the fresh opening line');

  during = async () => { during = async () => {}; await say('后发先到'); };
  await assert.rejects(say('先发后到'), /刚刚变了/);
  assert.equal(await turnsNow(), 3, 'one exchange, not two that never saw each other');

  during = async () => { await service.store.update((s) => { s.decks[0].cards[0].prompt = '改过的题干'; delete s.decks[0].cards[0].socratic; }); };
  await assert.rejects(say('改题前发的'), /刚刚变了/);
  assert.equal(await turnsNow(), 0);
});

test('28) 学习者自己先说出了答案，老师复述一句不算泄题', async (t) => {
  const tutor = scriptedTutor([
    { reply: '你说「破坏了循环等待条件」，方向对。为什么这样就不会死锁？', understood: false, help: 'none' },
    { reply: '回到你说的破坏了循环等待条件：环是怎么被拆掉的？', understood: false, help: 'none' },
  ]);
  const service = await createSeededService(t, { complete: tutor.complete });
  const run = await startRun(service);
  for (const text of ['破坏了循环等待条件', '不太会解释']) {
    const step = await service.call('socratic.step', { ...ref, runId: run.id, text });
    assert.equal(step.state.revealed, false, text);
    assert.equal(step.state.hintLevel, 0, text);
    assert.equal(step.state.turns.at(-1).kind, 'reply', text);
  }
  const entry = (await service.store.read()).runs.find((item) => item.id === run.id).entries[0];
  assert.equal(entry.assistance.revealedBeforeAnswer, false);
  assert.equal(entry.assistance.hintUsed, false);
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object?.[key]]));
}
