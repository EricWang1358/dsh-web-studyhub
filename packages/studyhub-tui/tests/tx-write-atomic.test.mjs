import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');
const srcDir = path.join(pkgRoot, 'src');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p3b-tx-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/host/tx-write.ts';`,
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
const Tx = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

test('P3-b: runAtomicSteps rolls back completed steps in reverse (LIFO) order when a later step fails', async () => {
  const log = [];
  const res = await Tx.runAtomicSteps([
    {
      name: 'create-draft',
      run: async () => {
        log.push('run:1');
        return { ok: true, value: { draftId: 'd-1' } };
      },
      rollback: async (val) => {
        log.push(`rollback:1:${val.draftId}`);
      },
    },
    {
      name: 'save-title',
      run: async () => {
        log.push('run:2');
        return { ok: true, value: { version: 2 } };
      },
      rollback: async (val) => {
        log.push(`rollback:2:${val.version}`);
      },
    },
    {
      name: 'publish',
      run: async () => {
        log.push('run:3');
        return { ok: false, error: 'publish failed' };
      },
    },
  ]);

  assert.equal(res.ok, false);
  assert.equal(res.failedStep, 'publish');
  assert.equal(res.error, 'publish failed');
  assert.equal(res.rolledBack, true);
  assert.deepEqual(res.rollbackErrors, []);
  assert.deepEqual(log, ['run:1', 'run:2', 'run:3', 'rollback:2:2', 'rollback:1:d-1']);
});

test('P3-b: runIdempotentTwoStep caches step-1 on step-2 failure to prevent duplicate writes on retry', async () => {
  let step1Calls = 0;
  let step2Calls = 0;
  let cached = null;

  const first = await Tx.runIdempotentTwoStep({
    cachedStep1: cached,
    setCachedStep1: (v) => { cached = v; },
    step1: async () => {
      step1Calls += 1;
      return { ok: true, value: { id: 'note-1' } };
    },
    step2: async () => {
      step2Calls += 1;
      return { ok: false, error: 'network timeout' };
    },
  });
  assert.equal(first.ok, false);
  assert.equal(first.step1Succeeded, true);
  assert.equal(step1Calls, 1);
  assert.equal(cached?.id, 'note-1');

  const retry = await Tx.runIdempotentTwoStep({
    cachedStep1: cached,
    setCachedStep1: (v) => { cached = v; },
    step1: async () => {
      step1Calls += 1;
      return { ok: true, value: { id: 'note-dup' } };
    },
    step2: async (note) => {
      step2Calls += 1;
      return { ok: true, value: { id: note.id, saved: true } };
    },
  });
  assert.equal(retry.ok, true);
  assert.equal(step1Calls, 1, 'Retry must reuse cached step-1 result without duplicating');
  assert.equal(step2Calls, 2);
  assert.equal(cached, null, 'Cache must clear once step-2 succeeds');
});

test('P3-b: runOptimisticWrite restores exact snapshot on write failure or thrown exception', async () => {
  let state = { version: 1, cards: ['a', 'b'] };
  const failRes = await Tx.runOptimisticWrite({
    getSnapshot: () => state,
    applyOptimistic: () => { state = { version: 1, cards: ['a'] }; },
    write: async () => ({ ok: false, error: 'disk readonly' }),
    restoreSnapshot: (snap) => { state = snap; },
  });
  assert.equal(failRes.ok, false);
  assert.deepEqual(state, { version: 1, cards: ['a', 'b'] });
});

test('P3-b: desktop applyConfigPatch persists mode + openai + reasoningEffort in one single atomic patch', async () => {
  const policyPath = path.join(repoRoot, 'packages/studyhub-desktop/domain/config-policy.js');
  const { applyConfigPatch } = await import(pathToFileURL(policyPath).href);
  const { config } = applyConfigPatch(
    { mode: 'agy', openai: { providerId: 'custom', baseUrl: '', model: '', apiKey: '' }, reasoningEffort: '' },
    {
      mode: 'openai',
      openai: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      reasoningEffort: 'high',
    },
  );
  assert.equal(config.mode, 'openai');
  assert.equal(config.openai.model, 'gpt-4o');
  assert.equal(config.reasoningEffort, 'high');
});

test('P3-b guardrail: settings, decks, board, drafts, notes, and focus use single atomic writes or tx-write rollback helpers', () => {
  const modelsPath = path.join(srcDir, 'views/settings/ModelsTab.tsx');
  const modelsSf = ts.createSourceFile(
    modelsPath,
    fs.readFileSync(modelsPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let hasReasoningEffortPatch = false;
  let callsBindingSet = false;
  const visitModels = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'reasoningEffort' &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === 'openaiEffort'
    ) {
      hasReasoningEffortPatch = true;
    }
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        if (ts.isStringLiteral(arg) && arg.text === 'binding.set') {
          callsBindingSet = true;
        }
      }
    }
    ts.forEachChild(node, visitModels);
  };
  visitModels(modelsSf);
  assert.equal(
    hasReasoningEffortPatch,
    true,
    'ModelsTab must send reasoningEffort: openaiEffort in the single desktop.config.save write',
  );
  assert.equal(
    callsBindingSet,
    false,
    'ModelsTab must not split OpenAI save into two writes (desktop.config.save + binding.set)',
  );

  for (const rel of [
    'views/library/DeckManageModal.tsx',
    'views/board/BoardView.tsx',
    'views/generate/DraftEditor.tsx',
    'views/notes/NoteEditorModal.tsx',
    'views/examprep/AddFocusModal.tsx',
  ]) {
    const filePath = path.join(srcDir, rel);
    const sf = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const importsTxWrite = sf.statements.some(
      (stmt) =>
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.moduleSpecifier.text.endsWith('/tx-write.js'),
    );
    assert.equal(importsTxWrite, true, `${rel} must import host/tx-write.js transactional write/rollback primitives`);
  }
});
