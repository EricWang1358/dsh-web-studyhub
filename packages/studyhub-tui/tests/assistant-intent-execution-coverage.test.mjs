// #1354: 助手意图覆盖表（可执行链路）+ 失败不得显示「已完成」。
//
// 覆盖表（13 个意图：跳页 / 开带学 / 看统计 / 换主题 / 导出错题本 / 标记错因 / 通俗讲解 /
// 跳过题 / 挪到最后 / 改判 / 存笔记 / 前置题 / 边界 boundary）每个意图都至少一条
// “对着真实 StudyService”的执行链路断言（不是假后端：deck.import / review.* / attempt.* /
// note.* 全程走 lib/ 的真实服务），并额外断言：
//   1. 认不出的指令必须返回 boundary，不得返回「已完成」；
//   2. 任何失败结果都不得出现「已完成 / 已执行 / 已保存」，且要给出可读中文原因 + 可重试入口。
//
// node --test tests/assistant-intent-execution-coverage.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();

const [
  { parseAssistantIntent },
  { executeAssistantReadAction, executeAssistantWriteAction },
  { createTuiHost },
  storeMod,
  prefsMod,
  dataMod,
  assistantMod,
] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-actions.ts'),
  import('../src/host/tui-host.ts'),
  import('../src/state/store.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/shell/data.ts'),
  import('../src/shell/AssistantPanel.tsx'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const { saveTuiPreferences, loadTuiPreferences } = prefsMod;
const { dueToday } = dataMod;
const { AssistantPanel, _resetAssistantSessionMemory } = assistantMod;

const PROMISE_WORDS = /已完成|已执行|已保存/;

/** A provider discovery stub only: every study action below goes through the real StudyService. */
function noProviderDiscovery() {
  return {
    scan: async () => [],
    getCached: () => [],
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

const DECK_CARDS = [
  {
    kind: 'quiz',
    topic: '传输层',
    objective: '区分 TCP 与 UDP',
    prompt: '哪种协议提供可靠的面向连接字节流传输？',
    options: [
      { id: 'a', text: 'TCP', correct: true, explanation: 'TCP 用序号与 ACK。' },
      { id: 'b', text: 'UDP', correct: false, explanation: 'UDP 无连接不可靠。' },
      { id: 'c', text: 'ICMP', correct: false, explanation: 'ICMP 用于网络诊断。' },
    ],
    answer: 'TCP',
    hint: '想想握手与 ACK。',
    explanation: 'TCP 有握手、序号与 ACK。',
    misconception: '把 TCP 和 UDP 搞混。',
  },
  {
    kind: 'quiz',
    topic: '应用层',
    objective: 'HTTPS 默认端口',
    prompt: 'HTTPS 默认使用哪个端口？',
    options: [
      { id: 'a', text: '443', correct: true, explanation: 'HTTPS 用 443。' },
      { id: 'b', text: '80', correct: false, explanation: '80 是 HTTP。' },
      { id: 'c', text: '22', correct: false, explanation: '22 是 SSH。' },
    ],
    answer: '443',
    hint: '不是 80。',
    explanation: 'HTTPS 默认 443。',
    misconception: '混淆 80 与 443。',
  },
];

describe('#1354 助手意图覆盖表（真实 StudyService 执行链路）', () => {
  let base;
  let host;
  let deckId;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'studyhub-asst-coverage-'));
    host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      providerDiscovery: noProviderDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });
    const imported = await host.call('deck.import', {
      text: JSON.stringify({ title: '计算机网络测验', course: '计算机网络', cards: DECK_CARDS }),
    });
    assert.equal(imported.ok, true, imported.error?.message);
    deckId = imported.value?.results?.[0]?.deckId;
    assert.ok(deckId, 'deck.import must return the new deck id');
  });

  after(async () => {
    await host?.dispose?.();
    unregisterTsx?.();
    if (base) await rm(base, { recursive: true, force: true });
  });

  let runSeq = 0;
  /** A fresh real review round over the seeded two-card deck. */
  async function freshRun() {
    runSeq += 1;
    const started = await host.call('review.start', { mode: 'quiz', deckId, fresh: true });
    assert.equal(started.ok, true, started.error?.message);
    const run = started.value;
    assert.ok(run?.id && run?.card?.id, `round ${runSeq} must expose a run and its current card`);
    return run;
  }

  async function answerWrong(run) {
    const answered = await host.call('review.answer', {
      runId: run.id,
      cardId: run.card.id,
      selected: ['b'],
      queueVersion: run.queueVersion ?? 0,
    });
    assert.equal(answered.ok, true, answered.error?.message);
    assert.equal(answered.value?.feedback?.correct, false, 'wrong option must be graded wrong');
  }

  function makeDeps(run, extra = {}) {
    return {
      host,
      snapshot: null,
      cardCtx: {
        runId: run.id,
        deckId,
        cardId: run.card.id,
        cardIndex: typeof run.index === 'number' ? run.index : 0,
        total: 2,
        prompt: run.card.prompt,
        kind: run.card.kind,
      },
      lang: 'zh',
      navigate: () => {},
      applyRun: () => {},
      ...extra,
    };
  }

  /**
   * The intent table: every row is (意图 -> 例句 -> 期望动作) plus one real execution-chain check.
   * `execute` must go through the real StudyService (host.call) or the real store/prefs layer.
   */
  const INTENT_ROWS = [
    {
      id: 'navigate',
      zh: '跳页',
      input: '跳到统计',
      expectKind: 'navigate',
      expectAction: 'navigate(dashboard)',
      verifyIntent: (intent) => assert.equal(intent.page, 'dashboard'),
      execute: async () => {
        useTuiStore.getState().navigate('dashboard');
        assert.equal(useTuiStore.getState().page, 'dashboard', '导航必须真的切换页面');
        return { note: 'store.navigate(dashboard)' };
      },
    },
    {
      id: 'guided',
      zh: '开带学',
      input: '用带学模式帮我梳理一下这题',
      expectKind: 'enter_guided',
      expectAction: 'assistant.guided',
      verifyIntent: (intent) => assert.equal(intent.stage, 'question'),
      execute: async (intent) => {
        useTuiStore.getState().setAssistantTab('guided');
        if (intent.stage) useTuiStore.getState().setAssistantStage(intent.stage);
        assert.equal(useTuiStore.getState().assistantTab, 'guided', '带学必须真的切到 guided 标签');
        assert.equal(useTuiStore.getState().assistantStage, 'question');
        return { note: 'store.setAssistantTab(guided)' };
      },
    },
    {
      id: 'stats',
      zh: '看统计',
      input: '今天有多少题到期',
      expectKind: 'readonly_stats',
      expectAction: 'snapshot',
      execute: async () => {
        const snap = await host.call('snapshot', {});
        assert.equal(snap.ok, true, snap.error?.message);
        const due = dueToday(snap.value);
        assert.equal(typeof due, 'number', '只读统计必须来自真实 snapshot');
        assert.ok(due >= 0, `到期题数必须是非负数，得到 ${due}`);
        return { note: `snapshot -> due=${due}` };
      },
    },
    {
      id: 'theme',
      zh: '换主题',
      input: '切换到护眼模式',
      expectKind: 'set_preference',
      expectAction: 'preferences.set',
      verifyIntent: (intent) => assert.equal(intent.patch.theme, 'warm-amber'),
      execute: async (intent) => {
        const location = { env: { DSH_HOME: join(base, 'dsh-home') } };
        useTuiStore.getState().setPreferences(intent.patch);
        await saveTuiPreferences(intent.patch, location);
        const reloaded = await loadTuiPreferences(location);
        assert.equal(reloaded.theme, 'warm-amber', '主题必须真的写盘并可重新读出');
        return { note: 'saveTuiPreferences -> warm-amber' };
      },
    },
    {
      id: 'export',
      zh: '导出错题本',
      input: '导出本课错题 Markdown',
      expectKind: 'write_confirm',
      expectAction: 'export.wrongbook',
      verifyIntent: (intent) => {
        assert.equal(intent.requiresConfirm, true);
        assert.equal(intent.params.course, '*');
      },
      execute: async () => {
        const run = await freshRun();
        await answerWrong(run);
        const outcome = await executeAssistantWriteAction(
          {
            kind: 'write_confirm',
            actionName: 'export.wrongbook',
            params: { course: '*' },
            previewTitle: '确认导出错题本',
            previewMessage: '将执行：export.wrongbook',
            paramsSummary: 'course=*',
            requiresConfirm: true,
          },
          makeDeps(run),
        );
        assert.equal(outcome.succeeded, true, outcome.text);
        assert.match(outcome.text, /已导出/, `导出结果必须说清去向：${outcome.text}`);
        const dir = join(host.getLibraryRoot(), 'backups');
        assert.ok(existsSync(dir), '导出必须真的写 backups/ 目录');
        const { readdir } = await import('node:fs/promises');
        const file = (await readdir(dir)).find((f) => f.startsWith('studyhub-wrongbook') && f.endsWith('.md'));
        assert.ok(file, `必须写出 studyhub-wrongbook-*.md，实际：${(await readdir(dir)).join(',')}`);
        const md = await readFile(join(dir, file), 'utf8');
        assert.match(md, /^# 错题本导出/m, '导出的 Markdown 必须有错题本标题');
        const exported = md.split('\n').filter((line) => /^\d+\.\s/.test(line));
        assert.ok(exported.length >= 1, `导出的 Markdown 必须包含真实错题条目，实际：\n${md}`);
        assert.ok(
          exported.some((line) => /端口|协议/.test(line)),
          `导出条目必须来自题库里真实答错的题，实际：\n${md}`,
        );
        return { note: `backups/${file}` };
      },
    },
    {
      id: 'errorReason',
      zh: '标记错因',
      input: '错因设为概念不清',
      expectKind: 'write_confirm',
      expectAction: 'attempt.errorReason.set',
      verifyIntent: (intent) => {
        assert.equal(intent.requiresConfirm, true);
        assert.equal(intent.params.errorReason, 'concept');
      },
      execute: async (intent) => {
        const run = await freshRun();
        await answerWrong(run);
        const outcome = await executeAssistantWriteAction(
          { ...intent, params: { ...intent.params, deckId, cardId: run.card.id } },
          makeDeps(run),
        );
        assert.equal(outcome.succeeded, true, outcome.text);
        const wb = await host.call('wrongbook', { course: '*', view: 'weak', offset: 0, limit: 100 });
        assert.equal(wb.ok, true, wb.error?.message);
        const item = (wb.value?.items ?? []).find((it) => it.cardId === run.card.id);
        assert.ok(item, '错题本必须能读到刚答错的题');
        assert.equal(item.errorReason, 'concept', '错因必须真的落在后端的错题记录上');
        return { note: 'wrongbook[0].errorReason=concept' };
      },
    },
    {
      id: 'plainExplain',
      zh: '通俗讲解',
      input: '用大白话讲一下这题',
      expectKind: 'generate_plain_explain',
      expectAction: 'card.followup.add',
      verifyIntent: (intent) => assert.equal(intent.requiresConfirm, true),
      execute: async () => {
        const run = await freshRun();
        const saved = await executeAssistantWriteAction(
          {
            kind: 'write_confirm',
            actionName: 'card.followup.add',
            params: {
              deckId,
              cardId: run.card.id,
              question: '通俗讲解',
              answer: 'TCP 用三次握手、序号与 ACK 保证可靠有序。',
              source: 'assistant',
              silent: true,
              replace: true,
            },
            previewTitle: '保存通俗讲解到本题',
            previewMessage: '将执行：保存通俗讲解',
            paramsSummary: '保存到当前题目',
            requiresConfirm: true,
          },
          makeDeps(run),
        );
        assert.equal(saved.succeeded, true, saved.text);
        const card = await host.call('card.get', { deckId, cardId: run.card.id });
        assert.equal(card.ok, true, card.error?.message);
        assert.ok(
          (card.value?.card?.followups ?? []).length >= 1,
          '通俗讲解必须真的存进 card.followup（下次可复用）',
        );
        return { note: 'card.get -> followups>=1' };
      },
    },
    {
      id: 'skip',
      zh: '跳过题',
      input: '跳过这道题',
      expectKind: 'run_action',
      expectAction: 'review.skip',
      execute: async (intent) => {
        const run = await freshRun();
        const outcome = await executeAssistantReadAction(intent, makeDeps(run));
        assert.equal(outcome.succeeded, true, outcome.text);
        const after = await host.call('review.get', { runId: run.id });
        assert.equal(after.ok, true, after.error?.message);
        assert.notEqual(after.value?.index, run.index, '跳过必须真的把本轮指针移到下一题');
        return { note: `index ${run.index} -> ${after.value?.index}` };
      },
    },
    {
      id: 'moveToEnd',
      zh: '挪到最后',
      input: '把这道题挪到最后',
      expectKind: 'run_action',
      expectAction: 'review.queue.edit',
      verifyIntent: (intent) => assert.equal(intent.params.position, 'end'),
      execute: async (intent) => {
        const run = await freshRun();
        const outcome = await executeAssistantReadAction(intent, makeDeps(run));
        assert.equal(outcome.succeeded, true, outcome.text);
        const after = await host.call('review.get', { runId: run.id });
        assert.equal(after.ok, true, after.error?.message);
        assert.notEqual(
          after.value?.card?.id,
          run.card.id,
          '挪到最后后，后端当前题必须换成另一道未答题（题序真的变了）',
        );
        return { note: 'review.get -> current card changed' };
      },
    },
    {
      id: 'gradeAdjust',
      zh: '改判',
      input: '这题判错了，改判为4分',
      expectKind: 'write_confirm',
      expectAction: 'review.grade.adjust',
      verifyIntent: (intent) => assert.equal(intent.params.grade, 4),
      execute: async (intent) => {
        const run = await freshRun();
        await answerWrong(run);
        const outcome = await executeAssistantWriteAction(
          { ...intent, params: { ...intent.params, runId: run.id, cardId: run.card.id, entryIndex: 0 } },
          makeDeps(run),
        );
        // A quiz answer is not AI-graded: the backend must refuse, and the assistant must say so
        // honestly (readable Chinese, retryable) instead of claiming 「已完成」.
        assert.equal(outcome.succeeded, false, `选择题不该被判为可改判：${outcome.actionSummary}`);
        assert.ok(!PROMISE_WORDS.test(outcome.actionSummary + outcome.text), `失败不得出现完成文案：${outcome.actionSummary} / ${outcome.text}`);
        assert.match(outcome.text, /[\u4e00-\u9fff]/, '失败原因必须是可读中文');
        assert.match(outcome.text, /改分|判分|改判/, `失败原因要点明改判前提：${outcome.text}`);
        return { note: 'review.grade.adjust -> honest refusal' };
      },
    },
    {
      id: 'saveNote',
      zh: '存笔记',
      input: '把这个解答存到笔记',
      expectKind: 'write_confirm',
      expectAction: 'note.qa.add',
      execute: async (intent) => {
        const run = await freshRun();
        const outcome = await executeAssistantWriteAction(
          { ...intent, params: { ...intent.params, deckId, cardId: run.card.id } },
          makeDeps(run, {
            lastAssistantReply: 'TCP 靠握手、序号与 ACK 保证可靠有序。',
            lastLearnerQuestion: '为什么 TCP 可靠？',
          }),
        );
        assert.equal(outcome.succeeded, true, outcome.text);
        const notes = await host.call('note.list', {});
        assert.equal(notes.ok, true, notes.error?.message);
        const hit = (notes.value?.notes ?? []).find((n) =>
          (n.cards ?? []).some((c) => c.cardId === run.card.id),
        );
        assert.ok(hit, '存笔记必须真的写出含本题的学习笔记');
        return { note: `note.list -> ${hit.title}` };
      },
    },
    {
      id: 'prerequisite',
      zh: '前置题',
      input: '出前置题：虚拟内存',
      expectKind: 'write_confirm',
      expectAction: 'assist.start',
      verifyIntent: (intent) => {
        assert.equal(intent.requiresConfirm, true);
        assert.equal(intent.params.mode, 'derive');
        assert.equal(intent.params.derive?.relation, 'prerequisite');
        assert.equal(intent.params.text, '虚拟内存', '前置题知识点必须来自冒号后的内容，不能是整句指令');
      },
      execute: async (intent) => {
        const run = await freshRun();
        const outcome = await executeAssistantWriteAction(
          { ...intent, params: { ...intent.params, runId: run.id, deckId, cardId: run.card.id } },
          makeDeps(run),
        );
        // With a model the backend starts a real background task (「已启动」，不是「已完成」);
        // without one it must fail honestly with a readable reason and a retry entry.
        assert.ok(
          !PROMISE_WORDS.test(outcome.actionSummary + outcome.text),
          `前置题不得声称已完成（后台任务只能算已启动/失败）：${outcome.actionSummary} / ${outcome.text}`,
        );
        if (outcome.succeeded) {
          assert.match(outcome.actionSummary, /已启动/, '成功的后台任务只能说「已启动」');
          assert.match(outcome.text, /后台任务|任务/, '必须引导到后台任务查看进度');
        } else {
          assert.match(outcome.text, /[\u4e00-\u9fff]/, '失败原因必须是可读中文');
        }
        return { note: outcome.succeeded ? 'assist.start -> started' : 'assist.start -> honest failure' };
      },
    },
    {
      id: 'boundary',
      zh: '边界 boundary',
      input: '帮我自动把所有题按难度重排并同步到 Notion',
      expectKind: 'boundary',
      expectAction: 'boundary',
      verifyIntent: (intent) => {
        assert.match(intent.reason, /不能直接/, '边界必须直说做不到，且不改动数据');
        assert.ok(intent.alternativeCommand, '边界必须给出真实替代入口');
        assert.equal(intent.requiresConfirm, false);
      },
      execute: async (intent) => {
        // 边界不是执行动作：它没有后端副作用，因此绝不能落成「已完成」。
        assert.equal(intent.kind, 'boundary');
        assert.equal(intent.actionName, 'boundary');
        assert.ok(!PROMISE_WORDS.test(`${intent.canDo}${intent.cannotDo}${intent.entryLabel}`), '边界文案不得出现完成字样');
        return { note: 'boundary -> no backend side effect' };
      },
    },
  ];

  test('覆盖表完整性：13 个意图 / 每个意图至少 1 条执行链路', () => {
    assert.equal(INTENT_ROWS.length, 13, '覆盖表必须正好覆盖 13 个意图');
    const ids = new Set(INTENT_ROWS.map((row) => row.id));
    assert.equal(ids.size, 13, '意图 id 不能重复');
    for (const row of INTENT_ROWS) {
      assert.equal(typeof row.execute, 'function', `${row.zh} 必须有执行链路断言`);
      assert.ok(row.input?.length > 0, `${row.zh} 必须有例句`);
      assert.ok(row.expectKind && row.expectAction, `${row.zh} 必须写明期望动作`);
    }
    const expected = [
      '跳页', '开带学', '看统计', '换主题', '导出错题本', '标记错因', '通俗讲解',
      '跳过题', '挪到最后', '改判', '存笔记', '前置题', '边界 boundary',
    ];
    for (const zh of expected) {
      assert.ok(INTENT_ROWS.some((row) => row.zh === zh), `覆盖表缺少意图：${zh}`);
    }
  });

  for (const row of INTENT_ROWS) {
    test(`意图「${row.zh}」：${row.input} -> ${row.expectAction} 且真实链路成立`, async () => {
      useTuiStore.setState({ page: 'library', navContext: {} });
      const intent = parseAssistantIntent(row.input, {
        snapshot: null,
        currentCardId: null,
        currentDeckId: null,
        card: null,
        lang: 'zh',
      });
      assert.equal(intent.kind, row.expectKind, `"${row.input}" 解析为 ${intent.kind}（${intent.actionName}）`);
      assert.equal(intent.actionName, row.expectAction, `"${row.input}" 期望动作 ${row.expectAction}`);
      row.verifyIntent?.(intent);
      await row.execute(intent);
    });
  }

  test('认不出的指令一律 boundary（不得返回已完成 / 不得当聊天假装做完）', () => {
    const cases = [
      '帮我把整本错题本上传到云端',
      '帮我把所有题按难度重排并同步到 Notion',
      '把这题的题干改成另一道题',
      '帮我发邮件给老师',
    ];
    for (const input of cases) {
      const intent = parseAssistantIntent(input, { snapshot: null, currentCardId: null, currentDeckId: null, card: null, lang: 'zh' });
      assert.equal(intent.kind, 'boundary', `"${input}" 必须返回 boundary，实际 ${intent.kind}`);
      assert.equal(intent.actionName, 'boundary');
      assert.ok(!PROMISE_WORDS.test(`${intent.canDo}${intent.cannotDo}${intent.reason}${intent.entryLabel}`), `"${input}" 边界文案不得出现完成字样`);
    }
  });

  test('失败结果一律不出现「已完成/已执行/已保存」，且给出可读原因', async () => {
    const run = await freshRun();
    // 1) 没有可保存的解答 -> note.qa.add 必须诚实失败
    const noAnswer = await executeAssistantWriteAction(
      {
        kind: 'write_confirm',
        actionName: 'note.qa.add',
        params: { deckId, cardId: run.card.id, language: 'zh' },
        previewTitle: '确认存到学习笔记',
        previewMessage: '将执行：note.qa.add',
        paramsSummary: '写入学习笔记',
        requiresConfirm: true,
      },
      makeDeps(run),
    );
    assert.equal(noAnswer.succeeded, false);
    assert.ok(!PROMISE_WORDS.test(noAnswer.actionSummary + noAnswer.text), noAnswer.actionSummary);
    assert.match(noAnswer.text, /还没有|先提问|没有/, `失败原因必须可读：${noAnswer.text}`);

    // 2) 没有打开题目 -> 只读动作必须诚实失败
    const noCard = await executeAssistantReadAction(
      { kind: 'run_action', actionName: 'review.similar', params: {}, humanLabel: '查找同类题', paramsSummary: '', requiresConfirm: false },
      { ...makeDeps(run), cardCtx: null },
    );
    assert.equal(noCard.succeeded, false);
    assert.ok(!PROMISE_WORDS.test(noCard.actionSummary + noCard.text), noCard.actionSummary);
    assert.match(noCard.text, /刷题页|打开/, `失败原因必须可读：${noCard.text}`);

    // 3) 错题本是空的 -> 导出必须诚实失败，不能写个空文件还叫「已完成」
    const emptyHost = await createTuiHost({
      libraryRoot: join(base, 'empty-library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-empty') },
      home: base,
      documentsDir: base,
      providerDiscovery: noProviderDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });
    try {
      const emptyExport = await executeAssistantWriteAction(
        {
          kind: 'write_confirm',
          actionName: 'export.wrongbook',
          params: { course: '*' },
          previewTitle: '确认导出错题本',
          previewMessage: '将执行：export.wrongbook',
          paramsSummary: 'course=*',
          requiresConfirm: true,
        },
        { ...makeDeps(run), host: emptyHost, cardCtx: null },
      );
      assert.equal(emptyExport.succeeded, false, '错题本为空时导出必须失败');
      assert.ok(!PROMISE_WORDS.test(emptyExport.actionSummary + emptyExport.text), emptyExport.actionSummary);
      assert.match(emptyExport.text, /没有错题|未写出/, `失败原因必须可读：${emptyExport.text}`);
      assert.equal(
        existsSync(join(base, 'empty-library', 'backups')),
        false,
        '空错题本不得写出导出文件',
      );
    } finally {
      await emptyHost.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 面板级：失败时显示原因 + 可重试入口；只在真有副作用时才标完成
// ---------------------------------------------------------------------------

function createInkHarness(element, { cols = 110, rows = 34 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  const frames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(chunk.toString('utf8'));
    if (plain.trim()) frames.push(plain);
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
    interactive: true,
  });

  const latest = () => frames.at(-1) ?? '';
  return {
    latest,
    write: (s) => stdin.write(s),
    async waitFor(predicate, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(latest())) return latest();
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for frame. Last frame:\n${latest() || '<empty>'}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe('#1354 面板：失败原因 + 可重试入口（不显示已完成）', () => {
  let base;
  let host;
  let deckId;
  let run;
  let snapshot;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'studyhub-asst-panel-'));
    host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env: { ...process.env, DSH_HOME: join(base, 'dsh-home') },
      home: base,
      documentsDir: base,
      providerDiscovery: noProviderDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
    });
    const imported = await host.call('deck.import', {
      text: JSON.stringify({ title: '计算机网络测验', course: '计算机网络', cards: DECK_CARDS }),
    });
    deckId = imported.value.results[0].deckId;
    const started = await host.call('review.start', { mode: 'quiz', deckId, fresh: true });
    run = started.value;
    snapshot = (await host.call('snapshot', {})).value;
  });

  after(async () => {
    await host?.dispose?.();
    unregisterTsx?.();
    if (base) await rm(base, { recursive: true, force: true });
  });

  function resetPanelStore() {
    _resetAssistantSessionMemory();
    useTuiStore.setState({
      page: 'review',
      navContext: {},
      history: [],
      inputCaptured: false,
      showLaunchpad: false,
      practiceStack: [],
      assistantOpen: true,
      assistantFocused: true,
      assistantTab: 'assistant',
      assistantStage: 'question',
      assistantFullscreen: false,
      assistantCardContext: {
        runId: run.id,
        deckId,
        cardId: run.card.id,
        cardIndex: 0,
        total: 2,
        prompt: run.card.prompt,
        isWrong: false,
      },
      snapshot,
      binding: { root: join(base, 'library') },
      desktopConfig: null,
      activeRunId: run.id,
      toasts: [],
      footerHints: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    });
  }

  async function submitCommand(h, text) {
    h.write('i');
    await new Promise((r) => setTimeout(r, 40));
    h.write(text);
    await new Promise((r) => setTimeout(r, 50));
    h.write('\r');
  }

  test('失败（无解答可存笔记）显示原因 + [A] 可重试，且绝不显示已完成', async () => {
    resetPanelStore();
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 110, height: 34 },
        React.createElement(AssistantPanel, {
          host,
          isActive: true,
          width: 110,
          height: 34,
          docked: true,
          onClose: () => {},
        }),
      ),
    );
    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      await submitCommand(h, '把这个解答存到笔记');
      await h.waitFor((s) => s.includes('确认存到学习笔记'));
      await new Promise((r) => setTimeout(r, 60));
      h.write('y');
      const failed = await h.waitFor((s) => s.includes('还没有助手的解答') || s.includes('先提问'));
      assert.ok(!failed.includes('已完成'), `失败时不得出现「已完成」：\n${failed}`);
      assert.ok(/执行失败/.test(failed), `失败必须标注执行失败：\n${failed}`);
      assert.ok(/\[A\]\s*重试|重试这条指令/.test(failed), `失败必须给出可重试入口：\n${failed}`);

      // 按 [A] 真的重试同一条指令：写动作会再次拿出确认框，确认后同样诚实失败（不是静默无反应）。
      h.write('A');
      await h.waitFor((s) => s.includes('确认存到学习笔记') && s.includes('确认执行'));
      await new Promise((r) => setTimeout(r, 60));
      h.write('y');
      const retried = await h.waitFor((s) => (s.match(/还没有助手的解答/g) ?? []).length >= 2);
      assert.ok(!retried.includes('已完成'), `重试失败后仍不得出现「已完成」`);
    } finally {
      h.cleanup();
    }
  });

  test('只读统计与导航不再冒充「已完成」', async () => {
    resetPanelStore();
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 110, height: 34 },
        React.createElement(AssistantPanel, {
          host,
          isActive: true,
          width: 110,
          height: 34,
          docked: true,
          onClose: () => {},
        }),
      ),
    );
    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      await submitCommand(h, '今天有多少题到期');
      const stats = await h.waitFor((s) => s.includes('活跃题组') || s.includes('只读统计'));
      assert.ok(!stats.includes('已完成：只读统计'), `只读统计不得写「已完成」：\n${stats}`);
      assert.ok(/无改动|0 模型调用/.test(stats), `只读统计应说明没有改动：\n${stats}`);
    } finally {
      h.cleanup();
    }
  });

  test('成功的写动作（导出错题本）才标完成，并且真的写了文件', async () => {
    resetPanelStore();
    // 先答错一题，让真实错题本有内容。
    await host.call('review.answer', {
      runId: run.id,
      cardId: run.card.id,
      selected: ['b'],
      queueVersion: run.queueVersion ?? 0,
    });
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 110, height: 34 },
        React.createElement(AssistantPanel, {
          host,
          isActive: true,
          width: 110,
          height: 34,
          docked: true,
          onClose: () => {},
        }),
      ),
    );
    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      await submitCommand(h, '导出本课错题 Markdown');
      await h.waitFor((s) => s.includes('确认导出错题本'));
      await new Promise((r) => setTimeout(r, 60));
      h.write('y');
      const done = await h.waitFor((s) => s.includes('已导出'));
      assert.ok(/已导出/.test(done), `成功导出必须有明确结果：\n${done}`);
      assert.ok(!/执行失败/.test(done), `成功的导出不该出现执行失败：\n${done}`);
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(join(base, 'library', 'backups'));
      assert.ok(files.some((f) => f.startsWith('studyhub-wrongbook')), '导出必须真的写文件');
    } finally {
      h.cleanup();
    }
  });
});
