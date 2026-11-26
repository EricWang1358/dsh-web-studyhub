import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p3a-ai-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      `export * from './src/host/ai-dialogue.ts';`,
      `export { buildCardHelpSystemPrompt, buildCardHelpUserPrompt } from './src/views/review/review-helpers.ts';`,
      `export { buildNextStepSystemPrompt, buildNextStepUserPrompt } from './src/views/review/NextStepFollowupBar.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const Bundle = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

test('P3-a: unified AI prompt builders respect pre-reveal answer guard across explain and followup', () => {
  const unrevealedRun = {
    id: 'run-1',
    index: 0,
    revealed: false,
    feedback: null,
    card: {
      id: 'c1',
      kind: 'single',
      prompt: 'What is 2 + 2?',
      topic: 'Arithmetic',
      answer: 'SECRET_ANSWER_4',
    },
    solution: { answer: 'SECRET_ANSWER_4', explanation: 'SECRET_EXPLANATION' },
  };
  const revealedRun = { ...unrevealedRun, revealed: true };

  // Both explain and followup must hide reference answer before reveal
  const explainPre = Bundle.buildCardHelpUserPrompt({
    run: unrevealedRun,
    kind: 'single',
    userAnswer: '',
    history: [],
    question: 'Give me a hint',
    lang: 'en',
  });
  assert.ok(!explainPre.includes('SECRET_ANSWER_4'), 'Explain prompt must NOT leak reference answer before reveal');

  const followupPre = Bundle.buildNextStepUserPrompt({
    run: unrevealedRun,
    kind: 'single',
    userAnswer: '',
    toolLabel: 'Teach',
    resultContext: 'Step 1 hint',
    history: [],
    instruction: 'Explain simply',
    lang: 'en',
  });
  assert.ok(!followupPre.includes('SECRET_ANSWER_4'), 'Follow-up prompt must NOT leak reference answer before reveal');

  // After reveal, both expose reference answer
  const explainPost = Bundle.buildCardHelpUserPrompt({
    run: revealedRun,
    kind: 'single',
    userAnswer: '4',
    history: [],
    question: 'Why?',
    lang: 'en',
  });
  assert.ok(explainPost.includes('SECRET_ANSWER_4'), 'Explain prompt should include reference answer after reveal');

  const followupPost = Bundle.buildNextStepUserPrompt({
    run: revealedRun,
    kind: 'single',
    userAnswer: '4',
    toolLabel: 'Teach',
    resultContext: 'Step 1',
    history: [],
    instruction: 'Example',
    lang: 'en',
  });
  assert.ok(followupPost.includes('SECRET_ANSWER_4'), 'Follow-up prompt should include reference answer after reveal');
});

test('P3: unified persistCardQaToFollowupAndNote calls single atomic note.qa.save with replace:true + title and reports failures truthfully', async () => {
  const calls = [];
  const atomicHost = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === 'note.qa.save') {
        return {
          ok: true,
          value: {
            item: { id: 'fu-99', question: params.question, answer: params.answer },
            status: 'created',
            note: { id: 'note-1', title: params.title },
          },
        };
      }
      return { ok: false, error: { message: 'unexpected action' } };
    },
  };

  const res = await Bundle.persistCardQaToFollowupAndNote({
    host: atomicHost,
    deckId: 'd1',
    cardId: 'c1',
    question: 'Why?',
    answer: 'Because.',
    noteTitle: '2026-11-24 · Math · 学习笔记',
    lang: 'zh',
  });

  assert.equal(res.ok, true);
  assert.equal(res.followupId, 'fu-99');
  assert.equal(res.noteSaved, true);
  assert.equal(calls.length, 1, 'must use single atomic note.qa.save call');
  assert.equal(calls[0].action, 'note.qa.save');
  assert.equal(calls[0].params.replace, true);
  assert.equal(calls[0].params.title, '2026-11-24 · Math · 学习笔记');

  const failingHost = {
    async call() {
      return { ok: false, error: { message: 'disk full' } };
    },
  };
  const failed = await Bundle.persistCardQaToFollowupAndNote({
    host: failingHost,
    deckId: 'd1',
    cardId: 'c1',
    question: 'Why?',
    answer: 'Because.',
    noteTitle: '2026-11-24 · Math · 学习笔记',
    lang: 'zh',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.noteSaved, false);
  assert.match(failed.error, /disk full/);
});

test('P3-a: unified submitRetellEvaluation & isModelUnavailableError handle teach.retell and model errors consistently', async () => {
  assert.equal(Bundle.isModelUnavailableError('401 unauthorized'), true);
  assert.equal(Bundle.isModelUnavailableError('模型不可用'), true);
  assert.equal(Bundle.isModelUnavailableError('Invalid cardId'), false);

  const calls = [];
  const host = {
    async call(action, params) {
      calls.push({ action, params });
      return {
        ok: true,
        value: { passed: true, right: ['核心定义准确'], missed: [], wrong: [], gap: 'none' },
      };
    },
  };
  const retell = await Bundle.submitRetellEvaluation(host, {
    deckId: 'd1',
    cardId: 'c1',
    text: 'My explanation',
    language: 'zh',
  });
  assert.equal(retell.ok, true);
  assert.equal(calls[0].action, 'teach.retell');
  const lines = Bundle.formatRetellVerdictLines(retell.verdict, 'zh');
  assert.ok(lines.some((l) => l.includes('复述通过')));
  assert.ok(lines.some((l) => l.includes('核心定义准确')));
});

test('P3 guardrail: all AI entrypoints (explain/retell/guided/followup/reader/companion/glossary/skeleton) share host/ai-dialogue.ts with zero duplicate model-error regexes', () => {
  const consumers = [
    'views/review/review-helpers.ts',
    'views/review/AiHelpDrawer.tsx',
    'views/review/NextStepFollowupBar.tsx',
    'views/review/RetellModal.tsx',
    'shell/AssistantPanel.tsx',
    'shell/assistant-conversation.ts',
    'views/sources/DocumentReader.tsx',
    'views/sources/CompanionsModal.tsx',
    'views/sources/TranslationGlossaryModal.tsx',
    'views/skeleton/SkeletonView.tsx',
  ];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(srcDir, rel), 'utf8');
    assert.match(src, /ai-dialogue\.js/, `${rel} must import shared AI dialogue helpers from host/ai-dialogue.js`);
    assert.doesNotMatch(
      src,
      /configure a model\|model\.\*unavailable/,
      `${rel} must use isModelUnavailableError() from host/ai-dialogue.ts instead of duplicating the regex`,
    );
  }
});
