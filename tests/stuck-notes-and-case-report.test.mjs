import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createAssistService } from '../lib/assist.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const DRAFT_MARKDOWN =
  '# 容量规划与性能预算\n\n## 核心概念\n\n容量规划需要先明确目标吞吐与延迟预算，再结合资源瓶颈做压测。\n\n' +
  '## 常见误区\n\n只看平均值会掩盖尾延迟尖峰，需要同时观察分位数与队列长度。\n\n' +
  '## 例子\n\n假设峰值每秒五百次请求，先测量单实例上限，再留出安全冗余。';

const han = /[\u3400-\u9fff]/;
const stripTags = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

async function makeTempService(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-issue-962-'));
  const service = new StudyService(root, options);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, service };
}

test('stale running regular notes reconcile to interrupted across note.get, note.list, and snapshot, unlocking save and re-draft', async (t) => {
  const { root, service } = await makeTempService(t, { complete: async () => DRAFT_MARKDOWN });
  await service.store.update((state) => {
    state.decks.push({
      id: 'd1',
      title: '系统设计',
      cards: [{ id: 'c1', topic: '容量规划', prompt: '如何做容量规划？', answer: '先定目标再压测', explanation: '区分均值与尾延迟' }],
    });
  });
  const legacy = await service.call('note.create', { title: '容量规划笔记', cards: [{ deckId: 'd1', cardId: 'c1' }] });
  const staleSession = await service.call('note.create', { title: '尾延迟笔记', cards: [{ deckId: 'd1', cardId: 'c1' }] });

  // Simulate study-workspace.json left with running drafts from an older version (no pid/session) and a dead session.
  await service.store.update((state) => {
    state.notes.find((item) => item.id === legacy.id).generation = {
      id: 'job-legacy',
      status: 'running',
      startedAt: '2026-10-01T00:00:00.000Z',
    };
    state.notes.find((item) => item.id === staleSession.id).generation = {
      id: 'job-stale',
      status: 'running',
      startedAt: '2026-10-01T00:00:00.000Z',
      pid: process.pid,
      session: 'dead-session-id',
      progress: { phase: 'writing', completed: 0, total: 1 },
    };
  });

  const reopened = new StudyService(root, { complete: async () => DRAFT_MARKDOWN });
  t.after(() => reopened.dispose());

  for (const id of [legacy.id, staleSession.id]) {
    const got = await reopened.call('note.get', { id });
    assert.equal(got.generation?.status, 'interrupted', `note.get must reconcile ${id}`);
    assert.equal(got.generation?.progress, undefined, 'settled generation view strips stale progress');
  }

  const listed = await reopened.call('note.list');
  assert.deepEqual(
    listed.notes.map((item) => [item.id, item.generation?.status]).sort(),
    [[legacy.id, 'interrupted'], [staleSession.id, 'interrupted']].sort(),
  );

  const snap = await reopened.call('snapshot');
  assert.deepEqual(
    snap.notes.map((item) => [item.id, item.generation?.status]).sort(),
    [[legacy.id, 'interrupted'], [staleSession.id, 'interrupted']].sort(),
  );

  // Learner can immediately edit/save and re-trigger AI drafting on the recovered note.
  const saved = await reopened.call('note.save', { id: legacy.id, title: '容量规划与压测', markdown: '# 手动补充提纲' });
  assert.equal(saved.title, '容量规划与压测');

  const restarted = await reopened.call('note.generate', { id: legacy.id, expectedRevision: saved.revision });
  assert.equal(restarted.status, 'running');
  for (let i = 0; i < 40; i++) {
    const current = await reopened.call('note.get', { id: legacy.id });
    if (current.generation?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const finished = await reopened.call('note.get', { id: legacy.id });
  assert.equal(finished.generation?.status, 'done');
  assert.match(finished.markdown, /容量规划/);
});

test('disposing a service mid-draft marks the regular note interrupted for the next service in the same process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-issue-962-dispose-'));
  let second;
  t.after(async () => {
    await second?.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const first = new StudyService(root, {
    complete: (_sys, _prompt, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    }),
  });
  await first.store.update((state) => {
    state.decks.push({ id: 'd1', title: 'Deck', cards: [{ id: 'c1', prompt: 'Prompt', answer: 'Ans' }] });
  });
  const created = await first.call('note.create', { title: '容量规划', cards: [{ deckId: 'd1', cardId: 'c1' }] });
  await first.call('note.generate', { id: created.id });
  assert.equal((await first.call('note.get', { id: created.id })).generation?.status, 'running');

  await first.dispose();

  second = new StudyService(root, { complete: async () => DRAFT_MARKDOWN });
  assert.equal((await second.call('note.get', { id: created.id })).generation?.status, 'interrupted');
  assert.equal((await second.call('snapshot')).notes.find((n) => n.id === created.id)?.generation?.status, 'interrupted');
});

for (const pilot of [false, true]) {
  test(`note.cancel aborts live regular note.generate (pilot=${pilot}) without overwriting saved content`, async (t) => {
    let observedSignal;
    let releaseLateModel;
    t.after(() => releaseLateModel?.());
    const complete = (_sys, _prompt, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => { releaseLateModel = () => resolve(DRAFT_MARKDOWN); });
    };
    const { service } = await makeTempService(t, {
      complete,
      ...switchOptions(pilot ? 'runtime' : 'legacy', { complete, paths: ['noteGenerate'] }),
    });
    await service.store.update((state) => {
      state.decks.push({ id: 'd1', title: 'Deck', cards: [{ id: 'c1', prompt: 'Prompt', answer: 'Ans' }] });
    });
    const note = await service.call('note.create', { title: '容量规划', cards: [{ deckId: 'd1', cardId: 'c1' }] });
    const savedBefore = await service.call('note.save', { id: note.id, markdown: '# 原有草稿内容' });
    await service.call('note.generate', { id: note.id, expectedRevision: savedBefore.revision });

    for (let i = 0; i < 30 && !observedSignal; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(observedSignal, 'model call started');
    assert.equal(observedSignal.aborted, false);

    const cancelled = await service.call('note.cancel', { id: note.id });
    assert.equal(cancelled.generation?.status, 'cancelled');
    assert.equal(observedSignal.aborted, true, 'note.cancel aborts the in-flight signal');

    // Even if a provider ignores abort and resolves afterwards, cancelled draft must not overwrite markdown.
    releaseLateModel?.();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const after = await service.call('note.get', { id: note.id });
    assert.equal(after.generation?.status, 'cancelled');
    assert.equal(after.markdown, '# 原有草稿内容');
  });
}

test('NoteDraft and BlogNotes expose stop-drafting while running and unlock controls when interrupted or cancelled', async () => {
  const uiMod = await loadUi(`
    export { default as NoteDraft } from './ui/NoteDraft.jsx';
    export { default as BlogNotes } from './ui/BlogNotes.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const services = {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify() {},
    askInChat() {},
    host: {},
    openSettings() {},
    navigate() {},
    openModal() {},
  };
  const baseData = {
    root: 'lib',
    model: { ready: true, reason: 'ok', label: 'Fake' },
    focus: { course: '*', courses: [] },
    notes: [],
    decks: [],
    sources: [],
    settings: {},
  };
  const draftNote = (status, markdown = '# 已保存段落') => ({
    id: 'n1',
    title: '容量规划文章',
    status: 'draft',
    markdown,
    revision: 2,
    cards: [{ deckId: 'd1', cardId: 'c1', prompt: '题目一' }],
    generation: { id: 'g1', status, ...(status === 'interrupted' ? { message: '上次生成已中断，可以重新生成' } : {}) },
  });

  // 1. Running NoteDraft with onCancel shows 停止起草 and translates cleanly in English.
  const runningZh = renderToStaticMarkup(
    React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
      React.createElement(uiMod.NoteDraft, {
        note: draftNote('running'),
        model: baseData.model,
        running: true,
        onStart() {},
        onCancel() {},
      })),
  );
  assert.match(runningZh, /<button[^>]*>(?:<[^>]+>)*停止起草/);

  uiMod.setUiLanguage('en');
  try {
    const runningEn = renderToStaticMarkup(
      React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
        React.createElement(uiMod.NoteDraft, {
          note: draftNote('running'),
          model: baseData.model,
          running: true,
          onStart() {},
          onCancel() {},
        })),
    );
    assert.doesNotMatch(runningEn, han);
    assert.match(stripTags(runningEn), /Stop drafting/);
  } finally {
    uiMod.setUiLanguage('zh');
  }

  // 2. Running BlogNotes locks editing controls while offering 停止起草.
  const runningPage = renderToStaticMarkup(
    React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
      React.createElement(uiMod.BlogNotes, {
        data: { ...baseData, notes: [{ ...draftNote('running', ''), cardCount: 1 }] },
        initialId: 'n1',
        initialNote: draftNote('running', ''),
      })),
  );
  assert.match(runningPage, /<button[^>]*>(?:<[^>]+>)*停止起草/);
  assert.match(runningPage, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*编辑内容/);

  // 3. Interrupted & cancelled BlogNotes show clear notices and unlock reading + editing + material + CSDN controls (zh & en).
  for (const status of ['interrupted', 'cancelled']) {
    const readingNote = draftNote(status, '');
    const readingHtml = renderToStaticMarkup(
      React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
        React.createElement(uiMod.BlogNotes, {
          data: { ...baseData, notes: [{ ...readingNote, cardCount: 1 }] },
          initialId: readingNote.id,
          initialNote: readingNote,
        })),
    );
    assert.match(stripTags(readingHtml), status === 'interrupted' ? /上次 AI 起草已中断/ : /已停止 AI 起草/);
    assert.doesNotMatch(readingHtml, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*编辑内容/, `编辑内容 unlocked when ${status}`);
    assert.doesNotMatch(readingHtml, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*AI 起草解析/, `AI 起草解析 unlocked when ${status}`);
    assert.doesNotMatch(readingHtml, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*复制内容并打开 CSDN/, `CSDN copy unlocked when ${status}`);

    const editingNote = draftNote(status, '# 已保存段落');
    const editingHtml = renderToStaticMarkup(
      React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
        React.createElement(uiMod.BlogNotes, {
          data: { ...baseData, notes: [{ ...editingNote, cardCount: 1 }] },
          initialId: editingNote.id,
          initialNote: editingNote,
          initialEditing: true,
        })),
    );
    assert.doesNotMatch(editingHtml, /<input[^>]*value="容量规划文章"[^>]*disabled/, `title input unlocked when ${status}`);
    assert.doesNotMatch(editingHtml, /<button[^>]*disabled[^>]*>(?:<[^>]+>)*保存当前内容为资料/, `save as material unlocked when ${status}`);

    uiMod.setUiLanguage('en');
    try {
      const enNote = { ...readingNote, title: 'Capacity planning', cards: [{ deckId: 'd1', cardId: 'c1', prompt: 'Question 1' }] };
      const enHtml = renderToStaticMarkup(
        React.createElement(uiMod.StudyServicesContext.Provider, { value: services },
          React.createElement(uiMod.BlogNotes, {
            data: { ...baseData, notes: [{ ...enNote, cardCount: 1 }] },
            initialId: enNote.id,
            initialNote: enNote,
          })),
      );
      assert.doesNotMatch(enHtml, han, `English BlogNotes has no CJK when ${status}`);
    } finally {
      uiMod.setUiLanguage('zh');
    }
  }
});

test('casePaperReport preserves submitted responses, assist tasks carry runId, and reopened retry sends saved answers only for pending items', async (t) => {
  const { root, service } = await makeTempService(t, { complete: createFakeModel() });
  await service.store.update((state) => {
    state.sources.push({ id: 'src-case', title: '冷链案例', text: '三月冷库夜间断电，值班室没有收到告警。\n\n次日清晨才发现温度超标。' });
    state.decks.push({
      id: 'case-deck',
      title: '冷链架构案例',
      format: 'case-study',
      case: { sourceId: 'src-case' },
      cards: [
        {
          id: 'q1',
          kind: 'open',
          prompt: '给出架构改造建议并结合案例说明。',
          marks: 5,
          answer: '采用事件驱动监控告警。',
          rubricCriteria: [
            { id: 'c1', label: '架构建议', marks: 3, descriptor: '明确方案' },
            { id: 'c2', label: '结合案例', marks: 2, descriptor: '引用断电事故' },
          ],
        },
        {
          id: 'q2',
          kind: 'open',
          prompt: '说明告警演练与预算取舍。',
          marks: 5,
          answer: '分阶段落地告警演练。',
          rubricCriteria: [
            { id: 'c1', label: '演练设计', marks: 3, descriptor: '演练步骤' },
            { id: 'c2', label: '预算假设', marks: 2, descriptor: '说明假设' },
          ],
        },
      ],
    });
  });

  const run = await service.call('review.start', { mode: 'exam', examKinds: 'case', scope: [{ deckId: 'case-deck' }], fresh: true });
  const answerQ1 = '建议采用事件驱动告警架构，结合三月冷库断电无人知晓的事故，假设首期改造预算有限。';
  const answerQ2 = '先在核心冷库试点断电告警演练，假设首期改造预算有限，逐步推广到全部仓。';
  await service.call('review.answer', { runId: run.id, cardId: 'q1', response: answerQ1 });
  await service.call('review.answer', { runId: run.id, cardId: 'q2', response: answerQ2 });
  await service.call('exam.submit', { runId: run.id, timings: { readingMs: 120000, writingMs: 600000 } });

  // Grade only q1 first, leaving q2 pending (simulating interrupted grading before restart).
  await service.call('card.grade', { deckId: 'case-deck', cardId: 'q1', runId: run.id, answer: answerQ1 });

  const reopenedReport = await service.call('exam.report', { runId: run.id });
  assert.equal(reopenedReport.case.pending, 1);
  assert.equal(reopenedReport.case.questions.find((q) => q.cardId === 'q1')?.status, 'graded');
  assert.equal(reopenedReport.case.questions.find((q) => q.cardId === 'q1')?.response, answerQ1);
  assert.equal(reopenedReport.case.questions.find((q) => q.cardId === 'q2')?.status, 'pending');
  assert.equal(reopenedReport.case.questions.find((q) => q.cardId === 'q2')?.response, answerQ2);

  // Verify assistService records runId on grade tasks so UI can match tasks to this exam run.
  const assist = createAssistService();
  const stateSnap = await service.store.read();
  const q2Card = stateSnap.decks[0].cards[1];
  await assist.startAssist({}, {
    root,
    service,
    mode: 'grade',
    ref: { deckId: 'case-deck', cardId: 'q2' },
    runId: run.id,
    text: answerQ2,
    card: q2Card,
    deckTitle: '冷链架构案例',
    language: 'zh',
  });
  const startedTask = assist.assistView(root).tasks.at(-1);
  assert.equal(startedTask?.runId, run.id);
  for (let i = 0; i < 40 && assist.assistView(root).tasks.at(-1)?.status === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Verify UI helper hydrateReportAnswers + submitCasePaperGrades on a fresh reopened report with empty browser answers {}.
  const uiCase = await loadUi(`
    export { CaseReport, caseGradingState } from './ui/CaseResult.jsx';
    export { hydrateReportAnswers, submitCasePaperGrades } from './ui/CaseWorkspace.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);

  // Reset q2 back to pending on a second run to test submitCasePaperGrades with answers = {}.
  const run2 = await service.call('review.start', { mode: 'exam', examKinds: 'case', scope: [{ deckId: 'case-deck' }], fresh: true });
  await service.call('review.answer', { runId: run2.id, cardId: 'q1', response: answerQ1 });
  await service.call('review.answer', { runId: run2.id, cardId: 'q2', response: answerQ2 });
  await service.call('exam.submit', { runId: run2.id, timings: { readingMs: 60000, writingMs: 300000 } });
  await service.call('card.grade', { deckId: 'case-deck', cardId: 'q1', runId: run2.id, answer: answerQ1 });

  const report2 = await service.call('exam.report', { runId: run2.id });
  assert.deepEqual(uiCase.hydrateReportAnswers(report2, {}), { q1: answerQ1, q2: answerQ2 });

  const submittedAssistCalls = [];
  const retryViaAssist = await uiCase.submitCasePaperGrades({
    report: report2,
    answers: {},
    uiLanguage: 'zh',
    call: async (action, args) => {
      submittedAssistCalls.push([action, args]);
      return { id: 'task-retry-q2', mode: 'grade', status: 'running', deckId: args.deckId, cardId: args.cardId, runId: args.runId };
    },
  });
  assert.equal(retryViaAssist.errors.length, 0);
  assert.equal(submittedAssistCalls.length, 1, 'only pending q2 is re-submitted; graded q1 is untouched');
  assert.equal(submittedAssistCalls[0][0], 'assist.start');
  assert.equal(submittedAssistCalls[0][1].cardId, 'q2');
  assert.equal(submittedAssistCalls[0][1].text, answerQ2, 'sends saved server response instead of empty string');

  // Also test fallback direct card.grade against the real StudyService with answers = {}!
  const retryDirect = await uiCase.submitCasePaperGrades({
    report: report2,
    answers: {},
    uiLanguage: 'zh',
    call: (action, args) => {
      if (action === 'assist.start') return Promise.reject(new Error('Unknown action: assist.start'));
      return service.call(action, args);
    },
  });
  assert.deepEqual(retryDirect.errors, []);
  assert.equal(retryDirect.gradedDirect, true);
  const fullyGraded = await service.call('exam.report', { runId: run2.id });
  assert.equal(fullyGraded.case.pending, 0);
  assert.equal(fullyGraded.case.questions.every((q) => q.status === 'graded'), true);

  // Verify CaseReport rendering across running, failed, and interrupted states (zh + en).
  const runningHtml = renderToStaticMarkup(React.createElement(uiCase.CaseReport, {
    report: report2,
    assistTasks: [{ id: 't1', mode: 'grade', deckId: 'case-deck', cardId: 'q2', runId: run2.id, status: 'running' }],
    onRetryGrading() {},
  }));
  assert.match(runningHtml, /sh-spinner/);
  assert.match(stripTags(runningHtml), /其余正在后台批改/);

  const failedHtml = renderToStaticMarkup(React.createElement(uiCase.CaseReport, {
    report: report2,
    assistTasks: [
      { id: 'other-run', mode: 'grade', deckId: 'case-deck', cardId: 'q2', runId: 'unrelated-run', status: 'running' },
      { id: 't2', mode: 'grade', deckId: 'case-deck', cardId: 'q2', runId: run2.id, status: 'failed', message: '模型连接超时' },
    ],
    onRetryGrading() {},
  }));
  assert.doesNotMatch(failedHtml, /sh-spinner/, 'failed grading stops spinning even if another run has a task');
  assert.match(stripTags(failedHtml), /其余未完成批改/);
  assert.match(stripTags(failedHtml), /模型连接超时/);
  assert.match(stripTags(failedHtml), /待重试/);
  assert.match(failedHtml, /<button[^>]*>(?:<[^>]+>)*重新提交批改/);

  const interruptedHtml = renderToStaticMarkup(React.createElement(uiCase.CaseReport, {
    report: report2,
    assistTasks: [],
    onRetryGrading() {},
  }));
  assert.doesNotMatch(interruptedHtml, /sh-spinner/, 'reopened unfinished report with no running task stops spinning');
  assert.match(stripTags(interruptedHtml), /上次批改没有完成，你的作答已保存/);
  assert.match(stripTags(interruptedHtml), /待重试/);
  assert.match(interruptedHtml, /<button[^>]*>(?:<[^>]+>)*重新提交批改/);

  // English UI check: no Chinese leaks in running, failed, or interrupted report views.
  const englishReport = {
    ...report2,
    case: {
      ...report2.case,
      title: 'Cold Chain Case',
      questions: report2.case.questions.map((q, idx) => ({
        ...q,
        prompt: `Question ${idx + 1} prompt`,
        rubric: q.rubric ? {
          ...q.rubric,
          summary: 'Solid architecture recommendation.',
          criteria: q.rubric.criteria.map((c) => ({ ...c, label: 'Architecture', evidence: ['Event-driven alerting'], missing: [], suggestion: '' })),
          assumptions: [],
        } : null,
      })),
      weakest: [],
    },
  };
  uiCase.setUiLanguage('en');
  try {
    for (const tasks of [
      [{ id: 't1', mode: 'grade', deckId: 'case-deck', cardId: 'q2', runId: run2.id, status: 'running' }],
      [{ id: 't2', mode: 'grade', deckId: 'case-deck', cardId: 'q2', runId: run2.id, status: 'failed', message: 'Model request timed out' }],
      [],
    ]) {
      const enHtml = renderToStaticMarkup(React.createElement(uiCase.CaseReport, {
        report: englishReport,
        assistTasks: tasks,
        onRetryGrading() {},
      }));
      assert.doesNotMatch(enHtml, han, `English CaseReport has no CJK for tasks=${JSON.stringify(tasks)}`);
    }
  } finally {
    uiCase.setUiLanguage('zh');
  }
});
