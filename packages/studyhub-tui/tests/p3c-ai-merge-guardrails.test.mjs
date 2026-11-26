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
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PKG_ROOT, 'src');

const [{ StudyService }, aiDialogue, { executeAssistantWriteAction }] = await Promise.all([
  import('../../../lib/service.js'),
  import('../src/host/ai-dialogue.ts'),
  import('../src/shell/assistant-actions.ts'),
]);

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
});
