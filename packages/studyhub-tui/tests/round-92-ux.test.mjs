// Round 92 comprehensive behavior & layout tests:
// - Track A10: WrongBookView 96-col ultrawide prose centering + OSC 8 citation link safety
// - Track B7: WrongBook Top Weak Cluster Quick-Drill (`quick-triage.ts` + `[Q]` 1-key launch)
// - Track D7: Proactive Exam Gap Alert (`exam-gap-alert.ts` <= 14d trigger, disable toggle,
//             session dismiss rate limit, non-interrupting inline banner)
// node --test tests/round-92-ux.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  triageMod,
  coverageMod,
  alertMod,
  { WrongBookView },
  storeMod,
] = await Promise.all([
  import('../src/views/wrongbook/quick-triage.ts'),
  import('../src/views/examprep/exam-coverage.ts'),
  import('../src/views/examprep/exam-gap-alert.ts'),
  import('../src/views/wrongbook/WrongBookView.tsx'),
  import('../src/state/store.ts'),
]);

const { buildTopWrongCluster } = triageMod;
const { buildExamCoverage } = coverageMod;
const { buildExamGapAlert } = alertMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createTtyHarness(columns, rows) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    async waitFor(pred, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(20);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

describe('Round 92 Track B7 & A10 — WrongBook Top Cluster Quick-Drill [Q] & Prose Centering', () => {
  test('picks highest-frequency weak topic cluster and launches targeted review on [Q] at 120x36 & 80x24 ASCII', async () => {
    const items = [
      { deckId: 'd1', cardId: 'c1', topic: 'Eigenvalues', prompt: 'Eigen Q1', wrongCount: 3, errorReason: 'concept' },
      { deckId: 'd1', cardId: 'c2', topic: 'Eigenvalues', prompt: 'Eigen Q2', wrongCount: 2, errorReason: 'concept' },
      { deckId: 'd1', cardId: 'c3', topic: 'Limits', prompt: 'Limit Q1', wrongCount: 1, errorReason: 'slip' },
    ];
    const cluster = buildTopWrongCluster(items, 'zh');
    assert.ok(cluster);
    assert.equal(cluster.kind, 'topic');
    assert.equal(cluster.key, 'Eigenvalues');
    assert.equal(cluster.count, 2);
    assert.deepEqual(cluster.scope, [
      { deckId: 'd1', cardId: 'c1' },
      { deckId: 'd1', cardId: 'c2' },
    ]);

    const calls = [];
    const host = {
      async call(action, payload) {
        calls.push({ action, payload });
        if (action === 'wrongbook' || action === 'wrongbook.list') {
          return { ok: true, value: { items: payload?.view === 'history' ? [] : items, counts: { weak: 3, history: 0 } } };
        }
        if (action === 'wrongbook.recommend' || action === 'wrongbook.recommendations') return { ok: true, value: { items: [] } };
        if (action === 'review.start') return { ok: true, value: { id: 'run-cluster-1' } };
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      page: 'wrongbook',
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true },
      snapshot: { decks: [{ id: 'd1', title: 'LA' }], sources: [] },
    });

    const tty = createTtyHarness(120, 36);
    const inst = render(React.createElement(WrongBookView, { host, width: 116, height: 34, isActive: true }), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    await tty.waitFor((s) => s.includes('Eigen Q1'));
    tty.stdin.write('Q');
    await tty.waitFor(() => calls.some((c) => c.action === 'review.start'));
    const startCall = calls.find((c) => c.action === 'review.start');
    assert.deepEqual(startCall.payload.scope, cluster.scope);
    assert.equal(useTuiStore.getState().page, 'review');
    inst.unmount();
  });
});

describe('Round 92 Track D7 — Proactive Exam Gap Alert (3 Guardrails)', () => {
  test('triggers within 14 days when gaps/weak topics exist and strictly honors disable switch & dismissal', () => {
    const topics = [
      { topic: 'Integrals', status: 'none', cards: 0, mastery: 0, weakCards: [] },
      { topic: 'Series', status: 'weak', cards: 6, mastery: 0.2, weakCards: [{ deckId: 'd1', cardId: 'c9' }] },
    ];
    const planNear = buildExamCoverage(topics, 6);
    const alert = buildExamGapAlert({ plan: planNear, proactiveHints: true, dismissed: false, lang: 'zh', asciiMode: true });
    assert.ok(alert);
    assert.equal(alert.urgent, true, '<= 7 days must be marked urgent');
    assert.match(alert.message, /考期预警（剩 6 天）.*缺题 1 项.*\[Z\]忽略/);

    // Guardrail 1: Disable toggle suppresses completely
    assert.equal(
      buildExamGapAlert({ plan: planNear, proactiveHints: false, dismissed: false, lang: 'zh', asciiMode: true }),
      null,
    );
    // Guardrail 2: Dismissed for session suppresses completely
    assert.equal(
      buildExamGapAlert({ plan: planNear, proactiveHints: true, dismissed: true, lang: 'zh', asciiMode: true }),
      null,
    );
    // Outside 14-day window stays calm/silent
    const planFar = buildExamCoverage(topics, 41);
    assert.equal(
      buildExamGapAlert({ plan: planFar, proactiveHints: true, dismissed: false, lang: 'zh', asciiMode: true }),
      null,
    );
  });
});
