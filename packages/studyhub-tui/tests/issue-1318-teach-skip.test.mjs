// Tests for #1318: Guided teaching allows skipping any step with 0 model calls,
// skip-phrase handling, consecutive wrong-try nudge, and early finish.
// node --test tests/issue-1318-teach-skip.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ StudyService }, { useTuiStore, DEFAULT_PREFERENCES }, { TeachModal }] = await Promise.all([
  import('../../../lib/service.js'),
  import('../src/state/store.ts'),
  import('../src/views/review/TeachModal.tsx'),
]);

const PLAN = {
  diagnosis: '对矩阵对角化与正交基的关系还不清晰',
  transfer: '遇到实对称矩阵对角化题，先想谱定理，再核对正交矩阵性质。',
  rungs: [
    {
      lesson: '第1步要点：实对称矩阵的特征值全为实数，不同特征值的特征向量正交。',
      check: '实对称矩阵不同特征值对应的特征向量有什么几何关系？',
      answer: '它们彼此正交（内积为 0）。',
    },
    {
      lesson: '第2步要点：将各特征空间的正交基单位化后拼成正交矩阵 Q。',
      check: '得到正交特征向量后，如何构造正交矩阵 Q？',
      answer: '对正交基做单位化，按列排成 Q。',
    },
    {
      lesson: '第3步要点：正交矩阵满足 Q^T Q = I，因此 Q^{-1} A Q = Q^T A Q = Λ。',
      check: '为什么可以把 Q^{-1} 换成 Q^T？',
      answer: '因为正交矩阵的逆等于它的转置。',
    },
  ],
};

async function setupTeachingService(t, { answerVerdict = { passed: false, feedback: '再想想几何关系。' } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1318-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));

  let modelCalls = 0;
  let currentVerdict = answerVerdict;
  const service = new StudyService(root, {
    complete: async (_system, prompt) => {
      modelCalls += 1;
      const parsed = JSON.parse(prompt);
      if (parsed.question) {
        return JSON.stringify(PLAN);
      }
      return JSON.stringify(currentVerdict);
    },
  });

  await service.store.update((s) => {
    s.decks.push({
      id: 'd-1318',
      title: '线性代数',
      cards: [
        {
          id: 'c-1318',
          kind: 'flashcard',
          topic: '谱定理',
          prompt: '为什么实对称矩阵可以正交对角化？',
          answer: '由谱定理存在正交矩阵 Q 使得 Q^T A Q = Λ。',
          explanation: '实对称矩阵可被正交矩阵对角化。',
        },
      ],
    });
  });

  const run = await service.call('review.start', { deckId: 'd-1318', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: 'c-1318' });
  await service.call('review.answer', { runId: run.id, cardId: 'c-1318', grade: 1 });

  return {
    service,
    run,
    getModelCalls: () => modelCalls,
    setVerdict: (v) => {
      currentVerdict = v;
    },
  };
}

function makeHostFromService(service) {
  return {
    mode: 'embedded',
    snapshot: async () => service.snapshot(),
    call: async (name, args) => {
      try {
        const value = await service.call(name, args);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };
}

function createInkHarness(element, { cols = 104, rows = 34 } = {}) {
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

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });

  return {
    write: (data) => stdin.write(data),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore(lang = 'zh') {
  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode: false },
    toasts: [],
  });
}

test('#1318 backend: teach.skip advances step with 0 model calls, reveals lesson, and excludes from mastered_rungs', async (t) => {
  const { service, run, getModelCalls } = await setupTeachingService(t);
  const started = await service.call('teach.start', { runId: run.id, cardId: 'c-1318', language: 'zh' });
  assert.equal(getModelCalls(), 1, 'teach.start calls model once to build plan');
  assert.equal(started.index, 0);
  assert.equal(started.total, 3);

  // Skip step 1 via teach.skip — MUST NOT call model
  const afterSkip = await service.call('teach.skip', { id: started.id, stepIndex: 0 });
  assert.equal(getModelCalls(), 1, 'teach.skip must make 0 model calls');
  assert.equal(afterSkip.index, 1, 'progress advances to step 2');
  assert.equal(afterSkip.complete, false);
  assert.ok(afterSkip.feedback.includes('第1步要点'), 'feedback must reveal skipped step lesson');
  assert.equal(afterSkip.skippedSteps.length, 1);
  assert.equal(afterSkip.skippedSteps[0].index, 0);
  assert.equal(afterSkip.masteredCount, 0);

  // Verify persisted record: skipped step is NOT in mastered_rungs
  const state = await service.store.read();
  const rec = state.teaching.find((x) => x.id === started.id);
  assert.equal(rec.mastered_rungs.length, 0, 'skipped step must not be recorded in mastered_rungs');
  assert.equal(rec.skipped_rungs.length, 1, 'skipped step must be recorded in skipped_rungs');
});

test('#1318 backend: typing "跳过，下一问" into teach.answer skips with 0 model calls, tracks wrongTries, and supports early finish', async (t) => {
  const { service, run, getModelCalls, setVerdict } = await setupTeachingService(t);
  const started = await service.call('teach.start', { runId: run.id, cardId: 'c-1318', language: 'zh' });
  assert.equal(getModelCalls(), 1);

  // Typing skip phrase in teach.answer -> 0 model calls
  const skipped = await service.call('teach.answer', {
    id: started.id,
    stepIndex: 0,
    answer: '跳过，下一问',
  });
  assert.equal(getModelCalls(), 1, 'skip phrase in teach.answer must not call model');
  assert.equal(skipped.index, 1);
  assert.ok(skipped.feedback.includes('第1步要点'));
  assert.equal(skipped.skippedSteps.length, 1);
  assert.equal(skipped.masteredCount, 0);

  // Step 2: 2 consecutive wrong answers increment wrongTries to 2
  setVerdict({ passed: false, feedback: '还不对，再想想单位化。' });
  const wrong1 = await service.call('teach.answer', { id: started.id, stepIndex: 1, answer: '直接拼起来' });
  assert.equal(getModelCalls(), 2);
  assert.equal(wrong1.index, 1);
  assert.equal(wrong1.wrongTries, 1);

  const wrong2 = await service.call('teach.answer', { id: started.id, stepIndex: 1, answer: '取行列式' });
  assert.equal(getModelCalls(), 3);
  assert.equal(wrong2.index, 1);
  assert.equal(wrong2.wrongTries, 2);

  // Early finish: reveal all remaining steps (step 2 & step 3) at once with 0 model calls
  const finished = await service.call('teach.skip', { id: started.id, stepIndex: 1, all: true });
  assert.equal(getModelCalls(), 3, 'early finish (all: true) must make 0 model calls');
  assert.equal(finished.complete, true);
  assert.equal(finished.index, 3);
  assert.equal(finished.skippedSteps.length, 3);
  assert.equal(finished.masteredCount, 0);
  assert.ok(finished.feedback.includes('第2步要点'));
  assert.ok(finished.feedback.includes('第3步要点'));
  assert.ok(finished.transfer.includes('谱定理'));
});

test('#1318 TUI TeachModal: skip shortcut, "跳过，下一问", 2-wrong nudge, and completion skipped summary', async (t) => {
  resetStore('zh');
  const { service, run, getModelCalls, setVerdict } = await setupTeachingService(t);
  const host = makeHostFromService(service);

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 104, height: 34 },
      React.createElement(TeachModal, {
        host,
        run,
        cardId: 'c-1318',
        kind: 'flashcard',
        width: 100,
        height: 34,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
      }),
    ),
  );
  t.after(() => h.cleanup());

  // Wait for Step 1/3 to load (1 model call for plan) and let Ink attach TextInput useInput effect
  await h.waitFor((s) => s.includes('第 1/3 步') && s.includes('检验提问'), 4000, 'step 1 loaded');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getModelCalls(), 1);

  // 1) Press Tab then 's' to skip Step 1 -> 0 extra model calls, shows Step 1 key point & advances to Step 2/3
  h.write('\t');
  await h.waitFor((s) => s.includes('[s] 跳过'), 2000, 'input unfocused after Tab');
  await new Promise((r) => setTimeout(r, 40));
  h.write('s');
  const afterSkipKey = await h.waitFor(
    (s) => s.includes('第 2/3 步') && s.includes('已跳过 1'),
    4000,
    'step 2 after skip key',
  );
  assert.equal(getModelCalls(), 1, 'pressing skip key in TeachModal must make 0 extra model calls');
  assert.ok(afterSkipKey.includes('第1步要点'), 'screen should reveal step 1 lesson');

  // 2) Focus input and submit 2 wrong answers on Step 2 -> shows "看要点并继续" nudge
  h.write('i');
  await h.waitFor((s) => s.includes('Ctrl+N 跳过此步'), 2000, 'input focused after i');
  await new Promise((r) => setTimeout(r, 40));
  setVerdict({ passed: false, feedback: '再核对单位化步骤。' });
  h.write('随便答1');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');
  await h.waitFor((s) => s.includes('再核对单位化步骤'), 4000, 'wrong try 1');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getModelCalls(), 2);

  h.write('随便答2');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');
  const afterTwoWrong = await h.waitFor((s) => s.includes('看要点并继续'), 4000, 'nudge after 2 wrong tries');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getModelCalls(), 3);
  assert.ok(afterTwoWrong.includes('看要点并继续'));

  // 3) Type "跳过，下一问" into input -> skips Step 2 with 0 extra model calls -> reaches Step 3/3
  h.write('跳过，下一问');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');
  await h.waitFor((s) => s.includes('第 3/3 步') && s.includes('已跳过 2'), 4000, 'step 3 after phrase skip');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(getModelCalls(), 3, 'typing 跳过，下一问 must make 0 extra model calls');

  // 4) Press Tab then 'e' (early finish remaining) -> completes with 0 extra model calls, lists skipped steps
  h.write('\t');
  await h.waitFor((s) => s.includes('[e] 剩余直接讲'), 2000, 'input unfocused before e');
  await new Promise((r) => setTimeout(r, 40));
  h.write('e');
  const completeFrame = await h.waitFor(
    (s) => s.includes('已跳过步骤') && s.includes('第 1 步') && s.includes('第 3 步'),
    4000,
    'complete frame with skipped steps summary',
  );
  assert.equal(getModelCalls(), 3, 'early finish must make 0 extra model calls');
  assert.ok(!completeFrame.includes('✓ 已掌握'), 'all-skipped completion must not claim mastered');
});

test('#1318 x #1322/#1355 rebase merge conflict guard: skip-before-model + nonRetryableError + TeachingPanel + domain-contracts coexist', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  // 1) lib/teaching.js runtime: skip phrase succeeds with complete=null (0 calls),
  //    while non-skip answer with complete=null throws main's nonRetryableError('teaching-no-model').
  const { service, run, getModelCalls } = await setupTeachingService(t);
  const started = await service.call('teach.start', { runId: run.id, index: 0, mode: 'understanding' });
  assert.equal(getModelCalls(), 1);

  const { answerTeaching } = await import('../../../lib/teaching.js');
  const noModelErr = await answerTeaching(service.store, null, {
    id: started.id,
    stepIndex: 0,
    answer: 'normal non-skip answer',
  }).then(
    () => null,
    (err) => err,
  );
  assert.ok(noModelErr, 'non-skip answerTeaching without model must throw');
  assert.equal(noModelErr.code, 'teaching-no-model', 'must preserve main nonRetryableError code teaching-no-model');
  assert.equal(noModelErr.retryable, false, 'must preserve nonRetryableError retryable=false');

  const skippedWithoutModel = await answerTeaching(service.store, null, {
    id: started.id,
    stepIndex: 0,
    answer: '跳过',
  });
  assert.equal(skippedWithoutModel.skipped, true, 'skip phrase must bypass model requirement with 0 calls');
  assert.equal(skippedWithoutModel.index, 1, 'skip phrase must advance to step 1');
  assert.equal(getModelCalls(), 1, 'skip phrase without model must make 0 extra model calls');

  // 2) lib/runtime/domain-contracts.js & lib/contexts/study/operations.js: teach.skip & socratic.* coexist.
  const contractsSrc = readFileSync(resolve(repoRoot, 'lib/runtime/domain-contracts.js'), 'utf8');
  assert.ok(contractsSrc.includes("'teach.skip': ['teaching']"), 'domain-contracts must keep teach.skip');
  assert.ok(contractsSrc.includes("'socratic.get': ['runs']") && contractsSrc.includes("'socratic.step': ['decks', 'runs']"), 'domain-contracts must keep socratic.get/step');

  const opsSrc = readFileSync(resolve(repoRoot, 'lib/contexts/study/operations.js'), 'utf8');
  assert.ok(opsSrc.includes('skipTeaching') && opsSrc.includes('./socratic-inline.js'), 'study operations must import both skipTeaching and socratic-inline');

  // 3) ui/review/TeachingPanel.jsx: preserves main's LazySimilarTry + TeachingStatus + busyLabel AND #1318 skip UI.
  const panelSrc = readFileSync(resolve(repoRoot, 'ui/review/TeachingPanel.jsx'), 'utf8');
  assert.ok(panelSrc.includes('<LazySimilarTry'), 'TeachingPanel must keep main LazySimilarTry');
  assert.ok(panelSrc.includes('<TeachingStatus'), 'TeachingPanel must keep main TeachingStatus');
  assert.ok(panelSrc.includes('busyLabel='), 'TeachingPanel must keep main busyLabel on submit button');
  assert.ok(panelSrc.includes('teaching-skipped-summary'), 'TeachingPanel must keep #1318 skipped summary');
  assert.ok(panelSrc.includes('teaching-panel__skip') && panelSrc.includes('teaching-panel__skip-all'), 'TeachingPanel must keep #1318 skip buttons');
});
