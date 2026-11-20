import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  auditCircuitBreaker,
  auditCoachCommitPlan,
  auditVoiceTurns,
  detectAnswerLeak,
  loadEvalSuites,
  runContractEvals,
} from '../evals/run-contract-evals.mjs';

const execFileAsync = promisify(execFile);
const RUNNER_PATH = fileURLToPath(new URL('../evals/run-contract-evals.mjs', import.meta.url));
const PROMPTFOO_CONFIG_PATH = fileURLToPath(new URL('../evals/promptfooconfig.yaml', import.meta.url));

test('evals/promptfooconfig.yaml is valid Promptfoo YAML covering all 4 core agent contracts', async () => {
  const raw = await readFile(PROMPTFOO_CONFIG_PATH, 'utf8');
  const config = YAML.parse(raw);
  assert.ok(config && typeof config === 'object');
  assert.equal(typeof config.description, 'string');
  assert.ok(Array.isArray(config.prompts) && config.prompts.length >= 4, 'must declare >= 4 contract prompts');
  assert.ok(Array.isArray(config.providers) && config.providers.length >= 1, 'must declare provider template');
  assert.ok(Array.isArray(config.tests) && config.tests.length >= 6, 'must declare live Promptfoo test cases');
  const promptIds = new Set(config.prompts.map((p) => p.id));
  for (const requiredId of ['anti-spoiling-tutor', 'voice-study-tutor', 'coach-team-debrief', 'bilingual-card-author']) {
    assert.ok(promptIds.has(requiredId), `promptfooconfig missing prompt id: ${requiredId}`);
  }
});

test('evals/cases/*.json contains >= 30 unique high-value cases across all 4 required contract suites', async () => {
  const suites = await loadEvalSuites();
  const names = suites.map((s) => s.suite).sort();
  assert.deepEqual(names, [
    'anti-spoiling-tutor',
    'bilingual-json-latex',
    'coach-team-guardrails',
    'voice-study-pack',
  ]);
  const allCases = suites.flatMap((s) => s.cases || []);
  assert.ok(allCases.length >= 30, `expected >= 30 eval cases, got ${allCases.length}`);
  const uniqueIds = new Set(allCases.map((c) => c.id));
  assert.equal(uniqueIds.size, allCases.length, 'all eval case IDs must be unique');
});

test('offline deterministic contract evaluator passes 100% across all 4 agent contract suites', async () => {
  const report = await runContractEvals();
  assert.equal(report.failed, 0, report.cases.filter((c) => !c.passed).map((c) => `${c.id}: ${c.error}`).join('\n'));
  assert.equal(report.ok, true);
  assert.ok(report.total >= 30, `expected >= 30 evaluated cases, got ${report.total}`);
  assert.equal(report.passed, report.total);
  assert.equal(report.passRate, 1);
  for (const suite of ['anti-spoiling-tutor', 'voice-study-pack', 'coach-team-guardrails', 'bilingual-json-latex']) {
    assert.ok(report.suites[suite], `missing suite stats for ${suite}`);
    assert.equal(report.suites[suite].failed, 0, `${suite} had failures`);
    assert.equal(report.suites[suite].passRate, 1, `${suite} passRate must be 1`);
  }
});

test('node evals/run-contract-evals.mjs --json runs standalone with zero API keys and outputs structured score report', async () => {
  const { stdout } = await execFileAsync(process.execPath, [RUNNER_PATH, '--json'], {
    env: { ...process.env, OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(report.total >= 30);
  assert.equal(report.failed, 0);
  assert.equal(report.passRate, 1);
});

test('deterministic guardrail helpers flag adversarial leaks, drift, and ungrounded mastery accurately', () => {
  const leak = detectAnswerLeak('你可以看选项 B，也就是半连接队列', {
    tier: 'cue_only',
    secretAnswer: '半连接队列',
    correctOptionId: 'B',
    correctOptionText: '半连接队列',
  });
  assert.equal(leak.leaked, true);
  assert.equal(detectAnswerLeak('先想想三次握手第二包之后服务端保存了什么？', {
    tier: 'cue_only',
    secretAnswer: '半连接队列',
    correctOptionId: 'B',
    correctOptionText: '半连接队列',
  }).leaked, false);

  assert.equal(auditVoiceTurns(['[进度 1/2 · 本题第 4/3 轮] 还在死磕'], 2).valid, false);
  assert.equal(auditCircuitBreaker([
    '[进度 1/2 · 本题第 3/3 轮] 记入卡壳待回炉，强制推进到第 2 题',
    '[进度 2/2 · 本题第 1/3 轮] 下一题开始',
  ], 2).valid, true);
  assert.equal(auditCoachCommitPlan([{ cardId: 'c1', grade: 5, evidence: '' }]).valid, false);
  assert.equal(auditCoachCommitPlan([{ cardId: 'c1', grade: 4, evidence: '嗯懂了' }]).valid, false);
});
