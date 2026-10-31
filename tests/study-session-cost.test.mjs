import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSessionCost } from '../lib/study-session-cost.js';

test('calculateSessionCost with zero independent passed items reports pending_first_pass (Section 4.7)', () => {
  const session = { id: 's-1' };
  const progress = { independentPassedCount: 0 };
  const usageRecords = [
    { kind: 'tutoring', tokens: 1200 },
    { kind: 'reuse_existing', count: 2 },
  ];

  const cost = calculateSessionCost(session, progress, usageRecords);

  assert.equal(cost.independentPassedCount, 0);
  assert.equal(cost.costPerIndependentCheckItem, 'pending_first_pass');
  assert.equal(cost.breakdown.tutoring.tokens, 1200);
  assert.equal(cost.breakdown.reusedQuestions.count, 2);
  assert.equal(cost.breakdown.generation.tokens, 0);
  assert.equal(cost.breakdown.qaOrganize.tokens, 0);
  assert.match(cost.breakdown.qaOrganize.note, /0 额外模型调用/);
  assert.equal(cost.totalTokens, 1200);
});

test('calculateSessionCost aggregates all four cost categories and computes unit cost in tokens (Section 4.7)', () => {
  const session = { id: 's-2' };
  const progress = { independentPassedCount: 2 };
  const usageRecords = [
    { kind: 'tutoring', tokens: 1500 },
    { kind: 'scene_read', tokens: 500 },
    { kind: 'generation', tokens: 800 },
    { kind: 'qa_organize', tokens: 200 },
    { kind: 'reuse_existing', count: 3 },
  ];

  const cost = calculateSessionCost(session, progress, usageRecords);

  assert.equal(cost.breakdown.tutoring.tokens, 2000);
  assert.equal(cost.breakdown.reusedQuestions.count, 3);
  assert.equal(cost.breakdown.generation.tokens, 800);
  assert.equal(cost.breakdown.qaOrganize.tokens, 200);
  assert.match(cost.breakdown.qaOrganize.note, /独立模型组织 QA/);

  assert.equal(cost.totalTokens, 3000); // 2000 + 800 + 200
  assert.equal(cost.independentPassedCount, 2);
  assert.deepEqual(cost.costPerIndependentCheckItem, { tokens: 1500, includesTutoring: true }); // 3000 / 2
});

test('calculateSessionCost never carries a price, whatever a record holds (owner rule: tokens only)', () => {
  const cost = calculateSessionCost({ id: 's-3' }, { independentPassedCount: 1 }, [{ kind: 'generation', tokens: 400, costUsd: 0.004 }]);
  assert.doesNotMatch(JSON.stringify(cost), /usd/i);
  assert.equal(cost.breakdown.generation.tokens, 400);
});

test('calculateSessionCost does not call the main chat reasoning 0 tokens when nothing measured it', () => {
  const cost = calculateSessionCost({ id: 's-4' }, { independentPassedCount: 1 }, [{ kind: 'generation', tokens: 400 }]);
  assert.equal(cost.breakdown.tutoring.tokens, null);
  assert.equal(cost.breakdown.tutoring.measured, false);
  assert.equal(cost.totalTokens, 400, 'the total is only what was measured');
  assert.deepEqual(cost.costPerIndependentCheckItem, { tokens: 400, includesTutoring: false });
});

test('calculateSessionCost handles empty or missing inputs gracefully', () => {
  const cost = calculateSessionCost();
  assert.equal(cost.totalTokens, 0);
  assert.equal(cost.independentPassedCount, 0);
  assert.equal(cost.costPerIndependentCheckItem, 'pending_first_pass');
  assert.equal(cost.breakdown.reusedQuestions.count, 0);
  assert.equal(cost.breakdown.tutoring.measured, false);
});
