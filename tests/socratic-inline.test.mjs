import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { SOCRATIC_MAX_TURNS, buildRevealMessage, enforceSingleQuestion } from '../lib/contexts/study/socratic-inline.js';
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

test('1) 单问推进 + 打开 0 模型调用 + Shift+T 快捷键与抽屉入口 + 不抢焦点布局', async (t) => {
  let modelCalls = 0;
  const service = await createSeededService(t, {
    complete: async () => {
      modelCalls += 1;
      return JSON.stringify({ passed: false, reply: 'L1?' });
    },
  });

  // Opening drawer (socratic.get) performs ZERO model calls and returns 1 opening guiding question (no answer spoiler)
  const opened = await service.call('socratic.get', { deckId: 'deck-os', cardId: 'card-deadlock' });
  assert.equal(modelCalls, 0, 'opening inline Socratic panel must invoke 0 model calls');
  assert.equal(opened.persisted, false);
  assert.equal(opened.state.stage, 'answer');
  assert.equal(opened.state.hintLevel, 0);
  assert.equal(opened.state.turns.length, 1);
  assert.equal((opened.state.turns[0].text.match(/[?？]/g) || []).length, 1, 'opening prompt asks strictly one question');
  assert.doesNotMatch(opened.state.turns[0].text, /破坏了循环等待/, 'opening prompt does not spoil the answer');

  // Single-question guardrail collapses multi-question replies
  const single = enforceSingleQuestion('1. 先看互斥条件？\n2. 再看占有且等待？\n3. 最后看循环等待？');
  assert.equal((single.match(/[?？]/g) || []).length, 1);
  assert.doesNotMatch(single, /2\./);

  // Shift+T toggles inline Socratic outside exams while plain T preserves assist-plain
  const ctx = {
    inside: true, modalOpen: false, page: 'review', busy: false,
    run: { id: 'r1', mode: 'path', card: { id: 'card-deadlock', kind: 'quiz' } },
  };
  const shiftT = uiMod.shortcutAction({ key: 'T', code: 'KeyT', shiftKey: true, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false }, ctx);
  assert.deepEqual(shiftT?.action, { type: 'socratic-toggle' });
  const examShiftT = uiMod.shortcutAction({ key: 'T', code: 'KeyT', shiftKey: true, repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, inEditable: false, onButton: false }, { ...ctx, run: { ...ctx.run, mode: 'exam' } });
  assert.equal(examShiftT?.action, null);

  // AssistFormPanel shows mode switch 「AI 帮我理解 / 苏格拉底带学」; SocraticInlineDrawer has no autoFocus (does not steal focus)
  const drawerHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    prompt: opened.prompt,
    topic: opened.topic,
    modelReady: true,
    initialView: opened,
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

  // Assistant boundary prevents AI assistant from spoofing learner Socratic steps (HB-1)
  assert.ok(assistantRefusal('socratic.step'));
});

test('2) 阶梯提示 L1 -> L2：答偏逐级升级、等级可见且后端持久化绑定 cardId', async (t) => {
  const service = await createSeededService(t);

  // 1st wrong answer -> L1 minimal counter-question
  const s1 = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '不知道',
    offline: true,
  });
  assert.equal(s1.state.stage, 'judge');
  assert.equal(s1.state.hintLevel, 1);
  assert.equal(s1.state.maxHintLevelUsed, 1);
  assert.equal(s1.state.turns.at(-1).hintLevel, 1);
  assert.equal((s1.state.turns.at(-1).text.match(/[?？]/g) || []).length, 1);

  const htmlL1 = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', initialView: s1, modelReady: false,
  }));
  assert.match(htmlL1, /data-hint-level="1"/);
  assert.match(htmlL1, /L1 最小提示/);

  // 2nd wrong answer -> L2 key clue
  const s2 = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '还是想不出来',
    offline: true,
  });
  assert.equal(s2.state.stage, 'judge');
  assert.equal(s2.state.hintLevel, 2);
  assert.equal(s2.state.maxHintLevelUsed, 2);
  assert.equal(s2.state.turns.at(-1).hintLevel, 2);

  // Verify persisted directly on card in backend state
  const raw = await service.store.read();
  const card = raw.decks[0].cards[0];
  assert.equal(card.socratic.hintLevel, 2);
  assert.equal(card.socratic.stage, 'judge');
});

test('3) 答对要求复述，复述不合格继续追问，合格后进入小结并提供诚实的收尾 CTA', async (t) => {
  const service = await createSeededService(t);

  // Right answer at L0 -> moves to retell stage
  const answered = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。',
    offline: true,
  });
  assert.equal(answered.state.stage, 'retell');
  assert.equal(answered.state.hintLevel, 0);
  assert.equal(answered.state.turns.at(-1).kind, 'retell-prompt');

  // Unqualified retell ("懂了") -> stays in retell and keeps probing with 1 question
  const badRetell = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '懂了',
    offline: true,
  });
  assert.equal(badRetell.state.stage, 'retell');
  assert.equal(badRetell.state.retellAttempts, 1);
  assert.equal(badRetell.state.retellPassed, false);
  assert.equal(badRetell.state.turns.at(-1).kind, 'retell-probe');
  assert.equal((badRetell.state.turns.at(-1).text.match(/[?？]/g) || []).length, 1);

  // Qualified own-words retell -> summary stage + retellPassed = true
  const goodRetell = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '因为死锁需要四个必要条件同时满足，给所有资源统一编号并规定只能按升序申请后，任何进程都不会等比自己编号小的资源，因此不可能形成循环等待环路，死锁就被预防了。',
    offline: true,
  });
  assert.equal(goodRetell.state.stage, 'summary');
  assert.equal(goodRetell.state.retellPassed, true);
  assert.equal(goodRetell.state.summary.mastered, true);

  // Unanswered card -> CTA is 「回到原题作答」
  const unansweredSummaryHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', initialView: goodRetell, modelReady: false, cardAnswered: false,
  }));
  assert.match(unansweredSummaryHtml, /data-testid="socratic-inline-summary"/);
  assert.match(unansweredSummaryHtml, /回到原题作答/);

  // Already-answered card with queued retry -> honest 「收起带学」 + retry note, never misleading 「回到原题重做」 button
  const answeredSummaryHtml = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', initialView: goodRetell, modelReady: false, cardAnswered: true, retryQueued: true,
  }));
  assert.match(answeredSummaryHtml, /<button[^>]*>收起带学<\/button>/);
  assert.match(answeredSummaryHtml, /本轮末尾会再考一遍这道题/);
  assert.doesNotMatch(answeredSummaryHtml, /<button[^>]*>[^<]*回到原题重做/);
});

test('4) 中断恢复与历史滑动窗口：重新打开该卡从上次阶段恢复，历史不超过上限', async (t) => {
  const service = await createSeededService(t);

  // Step into L1 judge stage
  await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '不太清楚',
    offline: true,
  });

  // Simulate closing drawer and reopening the same card later -> socratic.get restores exact stage & hintLevel
  const resumed = await service.call('socratic.get', { deckId: 'deck-os', cardId: 'card-deadlock' });
  assert.equal(resumed.persisted, true);
  assert.equal(resumed.state.stage, 'judge');
  assert.equal(resumed.state.hintLevel, 1);
  assert.equal(resumed.state.turns.length, 3);

  // Sliding window cap: many unqualified retells never grow turns beyond SOCRATIC_MAX_TURNS
  await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '按全局顺序编号并按升序申请资源，破坏循环等待不形成环路',
    offline: true,
  });
  for (let i = 0; i < 20; i += 1) {
    await service.call('socratic.step', {
      deckId: 'deck-os',
      cardId: 'card-deadlock',
      text: '懂了',
      offline: true,
    });
  }
  const capped = await service.call('socratic.get', { deckId: 'deck-os', cardId: 'card-deadlock' });
  assert.ok(capped.state.turns.length <= SOCRATIC_MAX_TURNS, `turns capped at ${SOCRATIC_MAX_TURNS}`);
});

test('5) 复制本条与复制整段包含题目、我的作答、提示等级、阶段与 AI 追问', async (t) => {
  const service = await createSeededService(t);
  await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '忘了',
    offline: true,
  });
  const answered = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '按全局顺序编号并按升序申请资源，破坏循环等待条件',
    offline: true,
  });

  const lastTurn = answered.state.turns.at(-1);
  const singleCopy = uiMod.formatSocraticTurnCopy(lastTurn, answered);
  assert.match(singleCopy, /题目：为什么按全局顺序编号并升序申请资源可以预防死锁/);
  assert.match(singleCopy, /阶段：复述/);
  assert.match(singleCopy, /提示等级：L1 最小提示/);
  assert.match(singleCopy, /AI 追问/);

  const fullCopy = uiMod.formatSocraticTranscriptCopy(answered);
  assert.match(fullCopy, /苏格拉底带学：死锁必要条件/);
  assert.match(fullCopy, /题目：为什么按全局顺序编号并升序申请资源可以预防死锁/);
  assert.match(fullCopy, /当前阶段：复述/);
  assert.match(fullCopy, /L1 最小提示/);
  assert.match(fullCopy, /我的作答：忘了/);
  assert.match(fullCopy, /AI 提示/);
  assert.match(fullCopy, /AI 追问/);

  const html = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', initialView: answered, modelReady: false,
  }));
  assert.match(html, /复制本条/);
  assert.match(html, /复制整段/);
});

test('6) 统计隔离与独立口径 (#1323-11) + 错题本保留薄弱并显示提示等级 + 宽/窄屏不遮挡题目与选项', async (t) => {
  const service = await createSeededService(t);
  const now = Date.now();

  // Official wrong answer on the real question first -> card enters WrongBook weak & is undoable
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'deck-os', cardId: 'card-deadlock' }] });
  await service.call('review.answer', { runId: run.id, cardId: 'card-deadlock', selected: ['b'] });

  // Now open Socratic drawer, get L1 hint, answer right, and pass retell (all inside the same runId)
  await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', runId: run.id, text: '不会', offline: true });
  const right = await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    runId: run.id,
    text: '给资源按全局顺序编号并升序申请，破坏循环等待条件',
    offline: true,
  });
  assert.equal(right.state.stage, 'retell');
  assert.equal(right.state.maxHintLevelUsed, 1);

  await service.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    runId: run.id,
    text: '因为死锁需要四个必要条件同时成立，全局升序编号后不会形成循环等待环路，所以能预防死锁。',
    offline: true,
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
  const freshService = await createSeededService(t);
  await freshService.call('socratic.step', {
    deckId: 'deck-os',
    cardId: 'card-deadlock',
    text: '给资源按全局顺序编号并升序申请，破坏循环等待条件',
    offline: true,
  });
  const freshState = await freshService.store.read();
  const freshCard = freshState.decks[0].cards[0];
  assert.equal(cardLevel(freshCard, latestOutcomes(freshState.attempts)('deck-os', 'card-deadlock')), 'new');

  // Responsive CSS: 2-column beside question on wide screen, single-column below on narrow screen (<=959px), text wraps (#1309)
  const sessionCss = readFileSync(new URL('../ui/review/session.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../ui/review/socratic-inline.css', import.meta.url), 'utf8');
  assert.match(sessionCss, /\.review-body\.has-socratic\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(320px,\s*420px\)/s);
  assert.match(css, /@container study \(max-width:\s*959px\)/);
  assert.match(css, /@media \(max-width:\s*959px\)/);
  assert.match(css, /\.socratic-inline__body\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.ok(card.socratic.retellPassed);
});

test('7) #1323-12: 智能单问截断（忽略引号/代码/URL/三元）+ 参考答案讲解不误截 + L2 0调用查看参考答案', async (t) => {
  // 1) enforceSingleQuestion ignores `?`/`？` inside quotes, inline/fenced code, URLs, contractions, and ternary operators
  const tricky = '提示：看「为什么？」和 `x ? a : b` 以及 https://example.com?a=1&b=2，还有 cond ? 1 : 0，你觉得破坏了哪个条件？顺便回答第二个问题？';
  const trimmed = enforceSingleQuestion(tricky);
  assert.equal(trimmed, '提示：看「为什么？」和 `x ? a : b` 以及 https://example.com?a=1&b=2，还有 cond ? 1 : 0，你觉得破坏了哪个条件？');

  const fenced = '先看代码：\n```js\n// why?\nconst v = ok ? 1 : 0;\n```\n这段代码解决了什么问题？\n2. 另一个问题？';
  const trimmedFenced = enforceSingleQuestion(fenced);
  assert.match(trimmedFenced, /\/\/ why\?/);
  assert.match(trimmedFenced, /这段代码解决了什么问题？$/);
  assert.doesNotMatch(trimmedFenced, /另一个问题/);

  const englishContraction = "Don't you think TCP's handshake needs SYN? What about ACK?";
  assert.equal(enforceSingleQuestion(englishContraction), "Don't you think TCP's handshake needs SYN?");

  // 2) buildRevealMessage keeps full answer & explanation even when they contain `?`/`？`
  const revealText = buildRevealMessage({
    answer: '使用三元表达式 x > 0 ? 1 : -1（为什么？因为需要无分支返回值）',
    explanation: '为什么这样写？参考 https://docs.example.com?q=1，这样能避免空值。',
  }, 'zh');
  assert.match(revealText, /参考答案：使用三元表达式 x > 0 \? 1 : -1/);
  assert.match(revealText, /简要讲解：为什么这样写？参考 https:\/\/docs\.example\.com\?q=1/);
  assert.match(revealText, /请用你自己的话复述一遍这道题为什么这样解？$/);

  // 3) L2 zero-model-call `action: 'reveal'` + UI button rendered at hintLevel >= 2
  let modelCalls = 0;
  const service = await createSeededService(t, {
    complete: async () => {
      modelCalls += 1;
      return JSON.stringify({ passed: false, reply: 'Should not be called' });
    },
  });
  await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', action: 'hint', offline: true });
  const atL2 = await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', action: 'hint', offline: true });
  assert.equal(atL2.state.hintLevel, 2);

  const l2Html = renderToStaticMarkup(h(uiMod.SocraticInlineDrawer, {
    deckId: 'deck-os', cardId: 'card-deadlock', initialView: atL2, modelReady: true,
  }));
  assert.match(l2Html, /data-testid="socratic-reveal-btn"/);
  assert.match(l2Html, /查看参考答案/);

  const revealed = await service.call('socratic.step', { deckId: 'deck-os', cardId: 'card-deadlock', action: 'reveal' });
  assert.equal(modelCalls, 0, 'action: reveal must invoke 0 model calls');
  assert.equal(revealed.state.stage, 'retell');
  assert.equal(revealed.state.hintLevel, 2);
  assert.equal(revealed.state.turns.at(-1).kind, 'reveal');
  assert.match(revealed.state.turns.at(-1).text, /参考答案：/);
  assert.match(revealed.state.turns.at(-1).text, /简要讲解：/);
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
  const service = await createSeededService(t);
  const run = await startRun(service);
  const step = (args) => service.call('socratic.step', { ...ref, runId: run.id, offline: true, ...args });
  const entryAssistance = async () => (await service.store.read()).runs.find((r) => r.id === run.id).entries[0].assistance;

  // A right answer at L0 in the drawer: the tutor was asked, no hint and no answer was shown.
  await step({ text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。' });
  assert.deepEqual(
    { used: true, askedTutorBeforeAnswer: true, hintUsed: false, revealedBeforeAnswer: false },
    pick(await entryAssistance(), ['used', 'askedTutorBeforeAnswer', 'hintUsed', 'revealedBeforeAnswer']),
  );

  // Reset and take one hint: the hint is recorded too, and evidence only adds up.
  await step({ action: 'reset' });
  await step({ action: 'hint' });
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
  assert.equal(state.decks[0].cards[0].socratic.stage, 'retell');

  const exam = await service.call('review.start', { mode: 'exam', scope: [ref] });
  await assert.rejects(
    service.call('socratic.step', { ...ref, runId: exam.id, action: 'reveal' }),
    /exam/i,
  );
});

test('11) Socratic steps never enter the answer log: 错因 lands on the real answer and the daily plan does not count an unanswered question', async (t) => {
  const service = await createSeededService(t);

  // Every kind of step on a question outside a run: nothing in state.attempts.
  const step = (args) => service.call('socratic.step', { ...ref, offline: true, ...args });
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
  await service.call('socratic.step', { ...ref, runId: run.id, offline: true, text: '按全局顺序编号并要求升序申请资源，破坏了循环等待条件，不会形成环路等待。' });
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

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object?.[key]]));
}
