import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GENERATION_PERFORMANCE_DEFAULTS, GENERATION_SETTINGS_LIMITS } from '../lib/generation-settings.js';
import { GOAL_QUESTIONS_MAX } from '../lib/limits.js';
import { ROUND_LIMIT } from '../lib/coverage-round.js';
import { createOperations } from '../lib/contexts/workflows/operations.js';

/* #849: the numbers the generation pages state are the ones the code holds (lib/generation-settings.js, lib/limits.js, lib/coverage-round.js), in both languages,
   and the retired learning flow is described by what the code refuses. Only the numbers and names are pinned, never the sentences around them. */

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8').then(text => text.replace(/\r\n/g, '\n'));
const { concurrency, jobTimeoutMinutes } = GENERATION_PERFORMANCE_DEFAULTS;
const range = ({ min, max }) => `${min}–${max}`;

test('the pages that state the default parallel batches say the default of the code, and the range of the setting', async () => {
  for (const [path, pattern] of [
    ['docs/assessment-quality.md', `up to ${concurrency} batches run at the same time by default (you can set ${range(GENERATION_SETTINGS_LIMITS.concurrency)})`],
    ['docs/assessment-quality.zh-CN.md', `之后默认最多 ${concurrency} 批同时进行（可设为 ${range(GENERATION_SETTINGS_LIMITS.concurrency)} 批）`],
    ['docs/generation-agents-sidebar.md', `up to ${concurrency} batches run at the same time (you can set ${range(GENERATION_SETTINGS_LIMITS.concurrency)})`],
    ['docs/generation-agents-sidebar.md', `**Parallel batches** (${range(GENERATION_SETTINGS_LIMITS.concurrency)})`],
    ['docs/generation-agents-sidebar.zh-CN.md', `默认最多 ${concurrency} 批同时进行（可设为 ${range(GENERATION_SETTINGS_LIMITS.concurrency)}）`],
    ['docs/generation-agents-sidebar.zh-CN.md', `「同时生成的批数」（${range(GENERATION_SETTINGS_LIMITS.concurrency)}）`],
    ['docs/pdf-workflow.md', `up to ${concurrency} batches run at once (${range(GENERATION_SETTINGS_LIMITS.concurrency)} can be set)`],
    ['docs/pdf-workflow.zh-CN.md', `最多 ${concurrency} 批同时进行（可设为 ${range(GENERATION_SETTINGS_LIMITS.concurrency)}）`],
  ]) assert.ok((await read(path)).includes(pattern), `${path} should say: ${pattern}`);
});

test('no page keeps the old default of three batches or the old range of 1–6', async () => {
  assert.equal(GENERATION_PERFORMANCE_DEFAULTS.concurrency, 4);
  for (const path of ['docs/assessment-quality.md', 'docs/assessment-quality.zh-CN.md', 'docs/generation-agents-sidebar.md', 'docs/generation-agents-sidebar.zh-CN.md',
    'docs/pdf-workflow.md', 'docs/pdf-workflow.zh-CN.md', 'docs/parallel-generation.md']) {
    const text = await read(path);
    assert.doesNotMatch(text, /up to 3 batches|最多 3 批|最多 3 个批次|\(1–6\)|（1–6）|3 parallel batches/, path);
  }
});

test('the time budget is described by the code: its default and range, per round for a coverage plan', async () => {
  const range5 = range(GENERATION_SETTINGS_LIMITS.jobTimeoutMinutes);
  assert.equal(jobTimeoutMinutes, 20);
  for (const [path, pattern] of [
    ['docs/generation-agents-sidebar.md', `${jobTimeoutMinutes} minutes by default (${range5})`],
    ['docs/generation-agents-sidebar.zh-CN.md', `默认 ${jobTimeoutMinutes} 分钟（${range5}）`],
    ['docs/generation-cancellation.md', `20 by default (${range5})`],
    ['docs/pdf-workflow.md', `${jobTimeoutMinutes} minutes by default (${range5})`],
    ['docs/pdf-workflow.zh-CN.md', `默认 ${jobTimeoutMinutes} 分钟（${range5}）`],
  ]) assert.ok((await read(path)).includes(pattern), `${path} should say: ${pattern}`);
  for (const path of ['docs/generation-agents-sidebar.md', 'docs/generation-cancellation.md', 'docs/pdf-workflow.md', 'docs/assessment-quality.md'])
    assert.match(await read(path), /(?:each round|per round)[^.]*(?:no limit as a whole|has none)|no limit as a whole/, `${path} says a coverage plan has no total limit`);
  for (const path of ['docs/generation-agents-sidebar.zh-CN.md', 'docs/pdf-workflow.zh-CN.md', 'docs/assessment-quality.zh-CN.md'])
    assert.match(await read(path), /整个计划没有总时限/, path);
  assert.doesNotMatch(await read('docs/generation-cancellation.md'), /Each job has a 20-minute execution budget/);
});

test('the question counts: a total up to the goal limit, made in rounds of the round limit', async () => {
  assert.equal(GOAL_QUESTIONS_MAX, 500);
  assert.equal(ROUND_LIMIT, 30);
  for (const [path, pattern] of [
    ['docs/pdf-workflow.md', `1–${ROUND_LIMIT} in one round | A total up to ${GOAL_QUESTIONS_MAX}`],
    ['docs/pdf-workflow.zh-CN.md', `一轮 1–${ROUND_LIMIT} 题 | 总数最多 ${GOAL_QUESTIONS_MAX} 题`],
    ['docs/generation-agents-sidebar.md', `(1–${GENERATION_SETTINGS_LIMITS.count.max}; a total above ${ROUND_LIMIT} is made in rounds of at most ${ROUND_LIMIT})`],
    ['docs/generation-agents-sidebar.zh-CN.md', `（1–${GENERATION_SETTINGS_LIMITS.count.max}；超过 ${ROUND_LIMIT} 的总数分成每轮最多 ${ROUND_LIMIT} 题的几轮来做）`],
  ]) assert.ok((await read(path)).includes(pattern), `${path} should say: ${pattern}`);
  for (const path of ['docs/pdf-workflow.md', 'docs/pdf-workflow.zh-CN.md', 'docs/generation-agents-sidebar.md', 'docs/generation-agents-sidebar.zh-CN.md'])
    assert.doesNotMatch(await read(path), /count \(1–30\)|题数（1–30）|\| 1–30 \| Choose|\| 1–30 题 \|/, `${path} keeps no fixed 1–30 claim`);
});

test('references/workflows.md says the learning flow is retired and names every call the code refuses', async () => {
  const text = await read('references/workflows.md');
  const { mutations } = createOperations({});
  assert.ok(Object.keys(mutations).length > 5);
  for (const name of Object.keys(mutations)) assert.ok(text.includes(`\`${name}\``), `${name} is named`);
  for (const name of ['workflow.list', 'workflow.context', 'workflow.session.get']) assert.ok(text.includes(`\`${name}\``), `${name} is named as still readable`);
  assert.ok(text.includes('WORKFLOW_RETIRED'));
  for (const name of ['course.method.get', 'course.method.save', 'study.session.start']) assert.ok(text.includes(`\`${name}\``), `${name} is named as the replacement`);
  assert.doesNotMatch(text, /workflow\.quickstart|workflow\.skeleton\.generate|最多五条|Portal 中的回答/, 'no teaching of the retired steps is left');
  assert.ok(text.split('\n').length < 40, 'a short stub');
});
