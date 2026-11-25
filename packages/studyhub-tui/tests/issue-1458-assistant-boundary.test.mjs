// #1458: the TUI assistant is a personal-study helper, not an exam proctor. A question mark must not
// downgrade an executable request to chat; only a pure question (no executable verb) is answered.
// Every action assertion drives the REAL backend (`StudyService`) — no canned host values.
// Run: node --test tests/issue-1458-assistant-boundary.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { importExample } from '../../../ui/json-prompts.js';

const unregisterTsx = register();
after(() => unregisterTsx?.());

const [{ parseAssistantIntent }, actions] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-actions.ts'),
]);
const { executeAssistantReadAction, readCurrentGradeStatus } = actions;

const SOURCE_TEXT = 'Bridge separates an abstraction from its implementation so the two can vary independently.';

/** The host the assistant talks to: forwards every call to the real service. */
function hostFor(service, root) {
  return {
    call: async (action, args = {}) => {
      try {
        return { ok: true, value: await service.call(action, args) };
      } catch (error) {
        return { ok: false, error: { message: error?.message || String(error), code: error?.code } };
      }
    },
    subscribeEvents: () => () => {},
    getLibraryRoot: () => root,
    getConfig: () => null,
    dispose: async () => {},
  };
}

async function library(t, { cards = 3 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-1458-'));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await service.call('source.add', { id: 's', title: 'Bridge', text: SOURCE_TEXT });
  const base = JSON.parse(importExample('quiz')).cards[0];
  const ids = Array.from({ length: cards }, (_, i) => `q${i + 1}`);
  await service.call('draft.save', {
    deck: {
      id: 'd',
      title: 'Round',
      cards: ids.map((id) => ({
        ...base,
        id,
        prompt: `${base.prompt} (${id})`,
        objective: `${base.objective} (${id})`,
        citations: [{ sourceId: 's', quote: SOURCE_TEXT }],
      })),
    },
  });
  await service.call('draft.publish', { id: 'd' });
  const run = await service.call('review.start', { deckId: 'd', mode: 'quiz' });
  return { root, service, host: hostFor(service, root), ids, run };
}

const cardCtx = (run, overrides = {}) => ({
  runId: run.id,
  deckId: 'd',
  cardId: run.card.id,
  cardIndex: run.index,
  total: run.total,
  topic: run.card.topic,
  prompt: run.card.prompt,
  ...overrides,
});

const deps = (host, run, overrides = {}) => ({
  host,
  snapshot: null,
  cardCtx: cardCtx(run),
  lang: 'zh',
  navigate: () => {},
  ...overrides,
});

const parse = (text, run, lang = 'zh') =>
  parseAssistantIntent(text, {
    currentCardId: run.card.id,
    currentDeckId: 'd',
    card: cardCtx(run),
    lang,
  });

describe('#1458 疑问句式 + 可执行动词 → 执行', () => {
  test('「可以跳过这道题吗？」really skips through the real round and stays undoable', async (t) => {
    const { service, host, run } = await library(t);
    const intent = parse('可以跳过这道题吗？', run);
    assert.equal(intent.kind, 'run_action', `got ${intent.kind}`);
    assert.equal(intent.actionName, 'review.skip');
    assert.equal(intent.requiresConfirm, false, 'a reversible skip never asks for confirmation');

    let applied = null;
    const startIndex = run.index;
    const startCardId = run.card.id;
    const outcome = await executeAssistantReadAction(intent, deps(host, run, { applyRun: (r) => { applied = r; } }));
    assert.equal(outcome.succeeded, true, outcome.text);

    const afterSkip = await service.call('review.get', { runId: run.id });
    assert.notEqual(afterSkip.index, startIndex, 'the round moved to another question');
    assert.equal(afterSkip.navigation.length, 3, 'skipping keeps the question in the round');
    assert.equal(afterSkip.navigation.find((n) => n.cardId === startCardId)?.answered, false);
    assert.ok(applied && applied.index === afterSkip.index, 'the returned run is handed back to Review');
    assert.ok(outcome.undo, 'a skip stays undoable with [z]');

    const undone = await outcome.undo.run();
    assert.match(undone, /已撤销/);
    const back = await service.call('review.get', { runId: run.id });
    assert.equal(back.index, startIndex, 'undo returns to the skipped question');
  });

  test('「帮我把这题挪到最后」executes without a confirmation dialog', async (t) => {
    const { service, host, run } = await library(t);
    const intent = parse('帮我把这题挪到最后', run);
    assert.equal(intent.kind, 'run_action', `got ${intent.kind}`);
    assert.equal(intent.actionName, 'review.queue.edit');
    assert.equal(intent.requiresConfirm, false);

    const outcome = await executeAssistantReadAction(intent, deps(host, run));
    assert.equal(outcome.succeeded, true, outcome.text);
    const afterMove = await service.call('review.get', { runId: run.id });
    assert.equal(afterMove.navigation.at(-1).cardId, run.card.id, 'the current question is now last');
  });

  test('「把这道题讲清楚一点」goes to explanation, not a refusal', async () => {
    const ctx = { currentCardId: 'c', currentDeckId: 'd', card: { cardId: 'c', deckId: 'd' }, lang: 'zh' };
    const intent = parseAssistantIntent('把这道题讲清楚一点', ctx);
    assert.equal(intent.kind, 'explain_card', `got ${intent.kind}`);
    assert.equal(intent.actionName, 'assistant.explain');
    assert.equal(intent.requiresConfirm, false, 'explaining writes nothing');
  });
});

describe('#1458 疑问句式 + 纯询问 → 回答，不改数据', () => {
  test('「这题判对了吗」answers the real verdict and never changes it', async (t) => {
    const { service, host, run } = await library(t);
    const before = await service.call('review.get', { runId: run.id });
    const status = await readCurrentGradeStatus(deps(host, run));
    assert.equal(status.succeeded, true, status.text);
    assert.match(status.text, /还没有|未作答|没有判定/);

    const unchanged = await service.call('review.get', { runId: run.id });
    assert.deepEqual(
      { index: unchanged.index, feedback: unchanged.feedback, total: unchanged.total },
      { index: before.index, feedback: before.feedback, total: before.total },
      'reading the verdict must not grade or move anything',
    );

    const intent = parse('这题判对了吗', run);
    assert.equal(intent.kind, 'read_grade_status', `got ${intent.kind}`);
    assert.equal(intent.actionName, 'review.get');
    assert.equal(intent.requiresConfirm, false);
    assert.notEqual(intent.actionName, 'review.grade.adjust');
  });

  test('「前置题怎么用」states the boundary with a real entry, never starts 出题', () => {
    const ctx = { currentCardId: 'c', currentDeckId: 'd', card: { cardId: 'c', deckId: 'd' }, lang: 'zh' };
    const intent = parseAssistantIntent('前置题怎么用', ctx);
    assert.equal(intent.kind, 'boundary', `got ${intent.kind}`);
    assert.notEqual(intent.actionName, 'assist.start', 'a how-to question must not start an assist task');
    for (const text of [intent.canDo, intent.cannotDo, intent.entryLabel]) {
      assert.ok(text && text.length > 0, 'boundary states what it can/cannot do and where to go');
    }
    assert.match(`${intent.canDo}${intent.entryLabel}`, /前置题/);
    assert.doesNotMatch(intent.entryLabel, /已完成/);
  });
});

describe('#1458 做不了的指令 → boundary（不谎报已完成）', () => {
  test('manual-only edits return boundary with the real shortcut, not chat "done"', () => {
    for (const text of ['把这题的答案改成 B', '把这段加入待出题', '帮我自动把所有题按难度重排并同步到 Notion']) {
      const intent = parseAssistantIntent(text, { lang: 'zh' });
      assert.equal(intent.kind, 'boundary', `"${text}" got ${intent.kind}`);
      const message = `${intent.reason}${intent.alternativeLabel}`;
      assert.match(message, /不能直接/);
      assert.doesNotMatch(message, /已完成/);
      assert.ok(intent.entryLabel && intent.entryLabel.length > 0, 'boundary names a real entry');
      assert.ok(intent.alternativeCommand && intent.alternativeCommand.length > 0);
    }
  });

  test('a pure conceptual question is still answered', () => {
    for (const text of ['什么是 Belady 异常？', '为什么 TLB 命中率高？']) {
      const intent = parseAssistantIntent(text, { lang: 'zh' });
      assert.equal(intent.kind, 'chat', text);
    }
  });

  test('irreversible actions still ask first (斩题)', () => {
    const ctx = { currentCardId: 'c', currentDeckId: 'd', card: { cardId: 'c', deckId: 'd' }, lang: 'zh' };
    const intent = parseAssistantIntent('斩掉这道题', ctx);
    assert.equal(intent.kind, 'write_confirm');
    assert.equal(intent.actionName, 'card.slay');
    assert.equal(intent.requiresConfirm, true);
  });
});
