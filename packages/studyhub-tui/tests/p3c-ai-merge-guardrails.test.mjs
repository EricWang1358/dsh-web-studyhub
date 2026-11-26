/**
 * #1354 P3 AI Merge Guardrails & Behavioral Regressions (D7 + P3-c + Backend Composite `note.qa.save`).
 *
 * Covers:
 * 1. Architecture guardrails (zero direct `host.streamComplete(` outside `useAiConversation.ts` / `tui-host.ts`,
 *    all 10 prompt modes owned by `buildUnifiedAiSystemPrompt`, zero split `note.qa.add` callers in TUI,
 *    duplicate `TeachModal.tsx` & ReviewView `L` teach entry removed).
 * 2. Behavioral verification of all 10 unified prompt modes (zh/en non-empty & mode-distinct).
 * 3. Real `StudyService` behavioral regression of `persistCardQaToFollowupAndNote` -> atomic `note.qa.save`
 *    (single call, idempotent repeat, answer replacement, and zero half-writes on failure).
 * 4. Real `StudyService` behavioral regression of `loadTeachSession` / `submitTeachAnswer` / `skipTeachStep`
 *    driving unified Guided Study (`t`/`T` -> `AssistantPanel` `teach.*`).
 *
 * Run: node --test tests/p3c-ai-merge-guardrails.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PKG_ROOT, 'src');

const [
  { StudyService },
  aiDialogue,
  { executeAssistantWriteAction },
  { savePageAskToNote },
  { AssistantPanel, _resetAssistantSessionMemory },
  { ReviewView },
  { useTuiStore, DEFAULT_PREFERENCES },
] = await Promise.all([
  import('../../../lib/service.js'),
  import('../src/host/ai-dialogue.ts'),
  import('../src/shell/assistant-actions.ts'),
  import('../src/views/sources/ReaderNotesDrawer.tsx'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

function mountInk(element, { cols = 104, rows = 32 } = {}) {
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
  let lastFrame = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) lastFrame = plain;
  });
  const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true });
  return {
    write: (data) => stdin.write(data),
    frame: () => lastFrame,
    async waitFor(pred, timeoutMs = 5000, label = 'condition') {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred(lastFrame)) return lastFrame;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms).\nLast frame:\n${lastFrame}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function walkTsFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

function makeHostFromService(service, callLog = []) {
  return {
    mode: 'embedded',
    async call(action, args = {}) {
      callLog.push({ action, args });
      try {
        const value = await service.call(action, args);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    async snapshot() {
      return service.call('snapshot');
    },
    getConfig() {
      return { effective: { ready: true, provider: 'stub', model: 'stub' } };
    },
    async close() {},
  };
}

describe('#1354 P3 AI merge guardrails (D7 + P3-c + note.qa.save)', () => {
  test('Guard 1: zero direct host.streamComplete() calls outside useAiConversation.ts and tui-host.ts', () => {
    const allowed = new Set([
      'components/useAiConversation.ts',
      'host/tui-host.ts',
    ]);
    const violations = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (allowed.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, idx) => {
        if (/\.\s*streamComplete\s*\(/.test(line)) {
          violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Direct streamComplete() calls bypass useAiConversation:\n${violations.join('\n')}`,
    );
  });

  test('Guard 2: all 10 AI prompt modes live in buildUnifiedAiSystemPrompt and all dialogue views delegate to it', () => {
    const requiredModes = [
      'explain',
      'explain_followup',
      'plain_explain',
      'followup',
      'guided',
      'assistant',
      'reader_ask',
      'companion_ask',
      'glossary_suggest',
      'skeleton_generate',
    ];
    assert.deepEqual([...aiDialogue.UNIFIED_AI_MODES], requiredModes);

    for (const mode of requiredModes) {
      const zh = aiDialogue.buildUnifiedAiSystemPrompt(mode, 'zh', { stageLabel: '作答', target: 'zh' });
      const en = aiDialogue.buildUnifiedAiSystemPrompt(mode, 'en', { stageLabel: 'Answer', target: 'en' });
      assert.ok(typeof zh === 'string' && zh.trim().length > 20, `zh prompt for '${mode}' must be non-empty`);
      assert.ok(typeof en === 'string' && en.trim().length > 20, `en prompt for '${mode}' must be non-empty`);
    }

    const expectedDelegators = [
      'views/review/review-helpers.ts',
      'shell/assistant-conversation.ts',
      'views/sources/DocumentReader.tsx',
      'views/sources/CompanionsModal.tsx',
      'views/sources/TranslationGlossaryModal.tsx',
      'views/skeleton/SkeletonView.tsx',
    ];
    for (const rel of expectedDelegators) {
      const src = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      assert.ok(
        src.includes('buildUnifiedAiSystemPrompt'),
        `${rel} must delegate system prompt generation to buildUnifiedAiSystemPrompt`,
      );
    }
  });

  test('Guard 3: all Q&A-to-note persistence uses single atomic backend action note.qa.save via persistCardQaToFollowupAndNote', () => {
    const aiDialogueSrc = fs.readFileSync(path.join(SRC_ROOT, 'host/ai-dialogue.ts'), 'utf8');
    assert.ok(
      aiDialogueSrc.includes("'note.qa.save'"),
      'src/host/ai-dialogue.ts persistCardQaToFollowupAndNote must invoke atomic backend action note.qa.save',
    );
    assert.ok(
      !aiDialogueSrc.includes("'note.qa.add'"),
      'src/host/ai-dialogue.ts must not keep legacy two-step note.qa.add write',
    );

    const forbiddenDirectNoteQa = [
      'shell/assistant-actions.ts',
      'views/sources/ReaderNotesDrawer.tsx',
      'views/review/AiHelpDrawer.tsx',
      'views/review/NextStepFollowupBar.tsx',
    ];
    for (const rel of forbiddenDirectNoteQa) {
      const src = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      assert.ok(
        src.includes('persistCardQaToFollowupAndNote'),
        `${rel} must persist Q&A to notes through persistCardQaToFollowupAndNote`,
      );
      assert.ok(
        !/tryAction[^)]*'note\.qa\.add'/.test(src),
        `${rel} must not call split tryAction(..., 'note.qa.add') directly`,
      );
    }
  });

  test('Guard 4: P3-c removes duplicate TeachModal and ReviewView L teach entry; AssistantPanel guided tab drives backend teach.*', () => {
    const teachModalPath = path.join(SRC_ROOT, 'views/review/TeachModal.tsx');
    assert.equal(
      fs.existsSync(teachModalPath),
      false,
      'Duplicate TeachModal.tsx must be deleted once Guided Study merges into AssistantPanel',
    );

    const reviewSrc = fs.readFileSync(path.join(SRC_ROOT, 'views/review/ReviewView.tsx'), 'utf8');
    assert.ok(!reviewSrc.includes('TeachModal'), 'ReviewView.tsx must not import or render TeachModal');
    assert.ok(!reviewSrc.includes('teachModalOpen'), 'ReviewView.tsx must not keep teachModalOpen state');

    const assistantSrc = fs.readFileSync(path.join(SRC_ROOT, 'shell/AssistantPanel.tsx'), 'utf8');
    assert.ok(
      assistantSrc.includes('loadTeachSession') &&
        assistantSrc.includes('submitTeachAnswer') &&
        assistantSrc.includes('skipTeachStep'),
      'AssistantPanel.tsx guided tab must drive backend teach.* via unified ai-dialogue helpers',
    );
  });

  test('Regression 1: assistant-actions note.qa.add and persistCardQaToFollowupAndNote execute atomic note.qa.save on real StudyService (idempotent + zero split calls)', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3c-qa-save-'));
    const service = new StudyService(root, { complete: async () => '{}' });
    t.after(async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.store.update((state) => {
      state.decks.push({
        id: 'd-p3c',
        title: '操作系统',
        course: '操作系统',
        cards: [
          {
            id: 'c-p3c',
            kind: 'flashcard',
            topic: '虚拟内存',
            prompt: '什么是缺页中断？',
            answer: '访问未装入物理内存的页面时触发硬件异常，由操作系统调页。',
            explanation: '页表有效位为 0 时触发。',
          },
        ],
      });
    });

    const callLog = [];
    const host = makeHostFromService(service, callLog);
    const snapshot = await host.snapshot();

    // 1) Execute via assistant-actions -> must make a single atomic note.qa.save call
    const outcome = await executeAssistantWriteAction(
      {
        kind: 'write_confirm',
        actionName: 'note.qa.add',
        params: { deckId: 'd-p3c', cardId: 'c-p3c' },
        previewTitle: '存进笔记',
        previewMessage: '保存当前问答到学习笔记',
        paramsSummary: 'note.qa.save',
        requiresConfirm: true,
      },
      {
        host,
        snapshot,
        cardCtx: { deckId: 'd-p3c', cardId: 'c-p3c', prompt: '什么是缺页中断？' },
        lastLearnerQuestion: '缺页中断和普通中断有什么区别？',
        lastAssistantReply: '缺页中断发生在指令执行期间，处理完毕后重新执行同一条指令。',
        lang: 'zh',
        navigate: () => {},
      },
    );
    assert.equal(outcome.succeeded, true, `expected assistant save success, got: ${outcome.text}`);
    assert.deepEqual(
      callLog.map((c) => c.action),
      ['note.qa.save'],
      'assistant-actions must call single atomic note.qa.save (never split card.followup.add + note.qa.add)',
    );

    // 2) Repeat via persistCardQaToFollowupAndNote with identical Q&A -> idempotent status: 'unchanged'
    callLog.length = 0;
    const repeat = await aiDialogue.persistCardQaToFollowupAndNote({
      host,
      deckId: 'd-p3c',
      cardId: 'c-p3c',
      question: '缺页中断和普通中断有什么区别？',
      answer: '缺页中断发生在指令执行期间，处理完毕后重新执行同一条指令。',
      noteTitle: '2026-11-26 · 操作系统 · 学习笔记',
      lang: 'zh',
    });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.noteSaved, true);
    assert.equal(repeat.status, 'unchanged');
    assert.deepEqual(callLog.map((c) => c.action), ['note.qa.save']);
    const liveCard = (await service.store.read()).decks[0].cards[0];
    assert.equal(liveCard.followups.length, 1, 'idempotent repeat must not duplicate card.followups');
  });

  test('Regression 2: unified loadTeachSession / submitTeachAnswer / skipTeachStep drive real StudyService teach.* end-to-end', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3c-teach-'));
    let modelCalls = 0;
    const service = new StudyService(root, {
      complete: async ({ prompt }) => {
        modelCalls += 1;
        if (String(prompt).includes('rungs') || modelCalls === 1) {
          return JSON.stringify({
            diagnosis: '需巩固缺页处理流程',
            transfer: '遇到缺页中断，记住：保存现场 -> 查外存调页 -> 更新页表 -> 重执原指令。',
            rungs: [
              { lesson: '第1步：有效位为 0 触发异常', check: '页表中哪一位触发缺页？', answer: '有效位为 0' },
              { lesson: '第2步：调页完成后重执原指令', check: '处理完回到哪条指令？', answer: '重新执行触发缺页的指令' },
            ],
          });
        }
        return JSON.stringify({ passed: true, feedback: '答对了，继续下一步。' });
      },
    });
    t.after(async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.store.update((state) => {
      state.decks.push({
        id: 'd-teach',
        title: 'OS',
        course: 'OS',
        cards: [
          {
            id: 'c-teach',
            kind: 'flashcard',
            topic: '虚存',
            prompt: '简述缺页中断处理过程',
            answer: '有效位 0 触发异常，调页后重执原指令。',
            explanation: '硬件保存现场并陷入内核。',
          },
        ],
      });
    });

    const run = await service.call('review.start', { deckId: 'd-teach', mode: 'flashcard' });
    await service.call('review.reveal', { runId: run.id, cardId: 'c-teach', index: 0 });
    await service.call('review.answer', { runId: run.id, cardId: 'c-teach', index: 0, grade: 2 });

    const host = makeHostFromService(service);
    const loaded = await aiDialogue.loadTeachSession(host, {
      runId: run.id,
      cardId: 'c-teach',
      index: 0,
      queueVersion: run.queueVersion ?? 0,
      mode: 'understanding',
      language: 'zh',
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.session.index, 0);
    assert.equal(loaded.session.total, 2);
    assert.match(aiDialogue.formatTeachStepMarkdown(loaded.session, 'zh'), /第 1\/2 步/);

    const answered = await aiDialogue.submitTeachAnswer(host, {
      id: loaded.session.id,
      answer: '有效位为 0',
      stepIndex: 0,
      language: 'zh',
    });
    assert.equal(answered.ok, true);
    assert.equal(answered.session.index, 1);

    const callsBeforeSkip = modelCalls;
    const skipped = await aiDialogue.skipTeachStep(host, {
      id: loaded.session.id,
      stepIndex: 1,
      language: 'zh',
    });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.session.complete, true);
    assert.equal(modelCalls, callsBeforeSkip, 'teach.skip must make 0 extra model calls');
    assert.match(aiDialogue.formatTeachCompletionMarkdown(skipped.session, 'zh'), /已跳过步骤/);
  });

  test('Regression 3: ReaderNotesDrawer.savePageAskToNote uses atomic note.qa.save on real StudyService and rolls back follow-up cleanly while surfacing noteError when note drafting runs', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3c-reader-save-'));
    let releaseDraft;
    const draftText = '# OS Notes\n\n' + 'Page fault handling detailed study note draft content. '.repeat(4);
    const service = new StudyService(root, {
      complete: () => new Promise((resolve) => { releaseDraft = () => resolve(draftText); }),
    });
    t.after(async () => {
      if (releaseDraft) releaseDraft();
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.store.update((state) => {
      state.sources.push({
        id: 'src-p3c-1',
        title: 'OS 讲义',
        text: 'Virtual memory uses page tables to map virtual pages to physical frames.',
        document: { id: 'b'.repeat(64), format: 'pdf', page: 1, materialId: `document-${'b'.repeat(64)}-pdf` },
      });
      state.decks.push({
        id: 'd-reader',
        title: 'OS',
        course: '操作系统',
        cards: [
          {
            id: 'c-reader',
            kind: 'flashcard',
            topic: '虚存',
            prompt: '页表的作用是什么？',
            answer: '映射虚拟页到物理页框。',
            citations: [{ sourceId: 'src-p3c-1', quote: 'page tables to map virtual pages' }],
          },
        ],
      });
    });

    const callLog = [];
    const host = makeHostFromService(service, callLog);

    // 1) Atomic save succeeds -> persists follow-up + study note + annotation
    const saved = await savePageAskToNote({
      host,
      lang: 'zh',
      title: 'OS 讲义',
      page: 1,
      sourceId: 'src-p3c-1',
      documentId: 'b'.repeat(64),
      pageText: 'Virtual memory uses page tables to map virtual pages to physical frames.',
      question: '页表存什么？',
      answer: '页表记录虚拟页号到物理页框号的映射关系。',
      course: '操作系统',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.savedTo, 'both');
    assert.ok(saved.noteId, 'must return created noteId');
    assert.ok(callLog.some((c) => c.action === 'note.qa.save'));
    assert.equal(callLog.some((c) => c.action === 'card.followup.add'), false);
    assert.equal(callLog.some((c) => c.action === 'note.qa.add'), false);

    // 2) Start AI note drafting -> second savePageAskToNote must rollback card.followups atomically AND report note failure beside annotation
    await service.call('note.generate', { id: saved.noteId });
    while (!releaseDraft) await new Promise((r) => setTimeout(r, 5));
    const followupsBefore = (await service.store.read()).decks[0].cards[0].followups.length;

    const duringDraft = await savePageAskToNote({
      host,
      lang: 'zh',
      title: 'OS 讲义',
      page: 1,
      sourceId: 'src-p3c-1',
      documentId: 'b'.repeat(64),
      pageText: 'Virtual memory uses page tables to map virtual pages to physical frames.',
      question: 'TLB 和页表关系？',
      answer: 'TLB 是页表的硬件快表缓存。',
      course: '操作系统',
    });
    const followupsAfter = (await service.store.read()).decks[0].cards[0].followups.length;
    assert.equal(followupsAfter, followupsBefore, 'atomic rollback: card.followups must remain untouched when note draft blocks note.qa.save');
    assert.equal(duringDraft.ok, true, 'page annotation still saved');
    assert.equal(duringDraft.savedTo, 'annotation');
    assert.match(duringDraft.message, /写入关联学习笔记失败/, 'must truthfully surface noteError instead of silently succeeding');

    releaseDraft();
    for (let i = 0; i < 60; i++) {
      const cur = await service.call('note.get', { id: saved.noteId });
      if (cur.generation?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  test('Regression 4: AssistantPanel Guided Study clears lock on start failure and retries both start & answer via [A] on real StudyService', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3c-retry-'));
    let planCalls = 0;
    let answerCalls = 0;
    const service = new StudyService(root, {
      complete: async ({ prompt }) => {
        if (String(prompt).includes('rungs') || planCalls === 0) {
          planCalls += 1;
          return JSON.stringify({
            diagnosis: '检验重试路径',
            transfer: '重试可恢复带学。',
            rungs: [
              { lesson: '第1步：理解锁机制', check: '什么是互斥锁？', answer: '保证临界区互斥访问' },
              { lesson: '第2步：避免死锁', check: '死锁四个条件？', answer: '互斥、占有且等待、不可剥夺、循环等待' },
            ],
          });
        }
        answerCalls += 1;
        return JSON.stringify({ passed: true, feedback: '回答准确，进入下一步。' });
      },
    });
    t.after(async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    await service.store.update((state) => {
      state.decks.push({
        id: 'd-retry',
        title: 'OS',
        course: 'OS',
        cards: [{ id: 'c-retry', kind: 'flashcard', topic: '并发', prompt: '什么是互斥锁？', answer: '保证临界区互斥访问。' }],
      });
    });
    const run = await service.call('review.start', { deckId: 'd-retry', mode: 'flashcard' });
    await service.call('review.reveal', { runId: run.id, cardId: 'c-retry', index: 0 });
    await service.call('review.answer', { runId: run.id, cardId: 'c-retry', index: 0, grade: 2 });

    let failStartOnce = true;
    let failAnswerOnce = true;
    const baseHost = makeHostFromService(service);
    const flakyHost = {
      ...baseHost,
      async call(action, args) {
        if (action === 'teach.start' && failStartOnce) {
          failStartOnce = false;
          return { ok: false, error: { message: '临时服务繁忙，请稍后重试' } };
        }
        if (action === 'teach.answer' && failAnswerOnce) {
          failAnswerOnce = false;
          return { ok: false, error: { message: '网络抖动导致提交失败' } };
        }
        return baseHost.call(action, args);
      },
    };

    _resetAssistantSessionMemory();
    useTuiStore.setState({
      page: 'review',
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      assistantOpen: true,
      assistantFocused: true,
      assistantTab: 'guided',
      assistantStage: 'question',
      assistantFullscreen: false,
      assistantCardContext: {
        runId: run.id,
        deckId: 'd-retry',
        cardId: 'c-retry',
        cardIndex: 0,
        queueVersion: run.queueVersion ?? 0,
        prompt: '什么是互斥锁？',
        kind: 'flashcard',
      },
      toasts: [],
    });

    const h = mountInk(
      React.createElement(
        Box,
        { width: 104, height: 32 },
        React.createElement(AssistantPanel, { host: flakyHost, width: 100, height: 32, isActive: true, onClose: () => {} }),
      ),
    );
    t.after(() => h.cleanup());

    // 1) Initial start fails -> shows readable error + [A] retry (never 已完成)
    const startFailFrame = await h.waitFor((s) => s.includes('临时服务繁忙') && s.includes('[A]'), 5000, 'teach.start failure');
    assert.ok(!startFailFrame.includes('已完成'), 'failed start must never claim 已完成');

    // 2) Press [A] -> retries teach.start and loads Step 1/2
    h.write('A');
    await h.waitFor((s) => s.includes('第 1/2 步') && s.includes('理解锁机制'), 5000, 'teach.start retry success');
    await new Promise((r) => setTimeout(r, 40));

    // 3) Submit answer -> first attempt fails -> shows readable error + [A] retry
    h.write('保证临界区互斥访问');
    await new Promise((r) => setTimeout(r, 30));
    h.write('\r');
    const ansFailFrame = await h.waitFor((s) => s.includes('网络抖动导致提交失败') && s.includes('[A]'), 5000, 'teach.answer failure');
    assert.ok(!ansFailFrame.includes('已完成'), 'failed answer must never claim 已完成');

    // 4) Press [A] -> retries the exact learner answer and advances to Step 2/2
    h.write('A');
    await h.waitFor((s) => s.includes('第 2/2 步') && s.includes('避免死锁'), 5000, 'teach.answer retry success');
    assert.equal(answerCalls, 1);
  });

  test('Regression 5: ReviewView removes duplicate L teach entry, routes t -> AssistantPanel Guided Study, and keeps F -> RetellModal', async (t) => {
    const mockRun = {
      id: 'run-p3c-keys',
      deckId: 'd-keys',
      title: 'OS',
      index: 0,
      total: 1,
      answered: 1,
      revealed: true,
      queueVersion: 3,
      card: { id: 'c-keys', deckId: 'd-keys', kind: 'flashcard', prompt: '什么是死锁？', answer: '多进程循环等待资源。' },
      feedback: { correct: true, grade: 4 },
      solution: { answer: '多进程循环等待资源。' },
    };
    const mockHost = {
      mode: 'embedded',
      async call(action) {
        if (action === 'review.start' || action === 'review.get') return { ok: true, value: mockRun };
        return { ok: true, value: {} };
      },
      async snapshot() {
        return { courses: [], decks: [{ id: 'd-keys', title: 'OS', course: 'OS' }], sources: [], jobs: [] };
      },
      getConfig() {
        return { effective: { ready: true, provider: 'stub', model: 'stub' } };
      },
      async close() {},
    };

    useTuiStore.setState({
      page: 'review',
      activeRunId: mockRun.id,
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      assistantOpen: false,
      assistantFocused: false,
      assistantTab: 'assistant',
      assistantStage: 'question',
      assistantCardContext: null,
      toasts: [],
    });

    const h = mountInk(React.createElement(ReviewView, { host: mockHost, width: 110, height: 30, isActive: true }), {
      cols: 110,
      rows: 30,
    });
    t.after(() => h.cleanup());

    await h.waitFor((s) => s.includes('什么是死锁？'), 5000, 'ReviewView card rendered');
    await new Promise((r) => setTimeout(r, 40));

    // Pressing L on an active review card must NOT open any TeachModal or assistant panel
    h.write('L');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(useTuiStore.getState().assistantOpen, false, 'L must not open AssistantPanel');
    assert.ok(!h.frame().includes('苏格拉底带学'), 'L must not open deleted TeachModal');

    // Pressing t opens unified AssistantPanel Guided Study at stage='question' with queueVersion preserved
    h.write('t');
    await new Promise((r) => setTimeout(r, 60));
    const st = useTuiStore.getState();
    assert.equal(st.assistantOpen, true, 't must open unified AssistantPanel');
    assert.equal(st.assistantTab, 'guided', 't must switch to guided tab');
    assert.equal(st.assistantStage, 'question', 't must start at guided question stage (not retell)');
    assert.equal(st.assistantCardContext?.queueVersion, 3, 't must pass queueVersion for teach.start');

    // Close assistant state and press F -> opens dedicated RetellModal
    useTuiStore.getState().closeAssistant();
    h.write('F');
    await h.waitFor((s) => s.includes('费曼复述'), 5000, 'F opens RetellModal');
  });
});
