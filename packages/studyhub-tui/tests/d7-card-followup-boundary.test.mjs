// #1354 D7 P3-a/P3-c boundary & decision guardrail:
// Backend `card.followup` intentionally remains non-streaming request-response JSON
// (auto-persisting, deduplicated, full-answer context), while TUI live Q&A streams via
// `useAiConversation` + `host.streamComplete` (pre-reveal answer guard #1335, abortable,
// zero auto-writes until explicit save).
//
// node --test packages/studyhub-tui/tests/d7-card-followup-boundary.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ StudyService }, { followupSource }, { createTuiHost }, aiDialogue] = await Promise.all([
  import('../../../lib/service.js'),
  import('../../../lib/followup.js'),
  import('../src/host/tui-host.ts'),
  import('../src/host/ai-dialogue.ts'),
]);

const { buildCardDialogueUserPrompt, buildUnifiedAiSystemPrompt } = aiDialogue;

const SECRET_ANSWER = 'SECRET_ANSWER_VIRTUAL_MEMORY_TLB_402';
const SECRET_EXPLANATION = 'SECRET_EXPLANATION_TLB_HIT_FASTPATH_402';

const SAMPLE_CARD = {
  id: 'card-d7-1',
  deckId: 'deck-d7',
  kind: 'short_answer',
  topic: '虚拟内存',
  prompt: '为什么 TLB 命中可以显著降低地址转换开销？',
  answer: SECRET_ANSWER,
  explanation: SECRET_EXPLANATION,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createSeededHost(t, onComplete) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d7-boundary-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  const libraryRoot = path.join(base, 'library');
  await mkdir(libraryRoot, { recursive: true });

  const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
  await seed.store.update((s) => {
    s.decks.push({
      id: SAMPLE_CARD.deckId,
      title: '操作系统',
      course: '操作系统',
      cards: [{ ...SAMPLE_CARD }],
    });
  });
  await seed.dispose?.();

  const calls = [];
  const host = await createTuiHost({
    libraryRoot,
    env: { DSH_HOME: path.join(base, 'dsh-home') },
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language: 'zh',
    injectedComplete: async (system, prompt, execution) => {
      const record = {
        system: String(system ?? ''),
        prompt: String(prompt ?? ''),
        task: execution?.task,
        stream: Boolean(execution?.stream),
      };
      calls.push(record);
      return onComplete(record, execution, calls);
    },
  });
  t.after(() => host.dispose());
  return { host, calls, libraryRoot };
}

describe('#1354 D7 card.followup non-streaming decision & TUI streaming boundary', () => {
  test('1. backend card.followup remains request-response JSON with full answer context, auto-persist, dedup & inflight coalescing', async (t) => {
    const gate = deferred();
    const { host, calls, libraryRoot } = await createSeededHost(t, async (record) => {
      if (record.task === 'card.followup') {
        await gate.promise;
        return JSON.stringify({
          question: '为什么 TLB 命中后不必多次访问内存页表？',
          answer: 'TLB 是高速相联缓存，命中时直接给出物理页框号，跳过多级页表访存。',
        });
      }
      return '{}';
    });
    t.after(() => gate.resolve());

    // Verify backend followupSource intentionally exposes full reference answer (post-answer contract).
    const backendSource = followupSource(SAMPLE_CARD);
    assert.equal(backendSource.answer, SECRET_ANSWER);
    assert.equal(backendSource.explanation, SECRET_EXPLANATION);

    // Concurrent identical card.followup calls coalesce into one backend model invocation.
    const q = '为什么不用查页表？';
    const p1 = host.call('card.followup', { deckId: SAMPLE_CARD.deckId, cardId: SAMPLE_CARD.id, question: q });
    const p2 = host.call('card.followup', { deckId: SAMPLE_CARD.deckId, cardId: SAMPLE_CARD.id, question: q });
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.ok, true, `first card.followup should succeed: ${r1.error?.message}`);
    assert.equal(r2.ok, true, `coalesced card.followup should succeed: ${r2.error?.message}`);
    assert.equal(calls.filter((c) => c.task === 'card.followup').length, 1, 'concurrent identical calls must coalesce into 1 model call');
    assert.equal(r1.value.item.id, r2.value.item.id, 'coalesced calls return the exact same persisted item');
    assert.equal(r1.value.item.originalQuestion, q);
    assert.ok(
      calls[0].prompt.includes(SECRET_ANSWER),
      'backend card.followup payload includes full reference answer (explaining why pre-reveal TUI streaming must not route through it)',
    );

    // Repeating the same question reuses persisted follow-up with zero extra model calls.
    const r3 = await host.call('card.followup', { deckId: SAMPLE_CARD.deckId, cardId: SAMPLE_CARD.id, question: q });
    assert.equal(r3.ok, true);
    assert.equal(r3.value.item.id, r1.value.item.id);
    assert.equal(calls.filter((c) => c.task === 'card.followup').length, 1, 'repeat question must reuse persisted answer with 0 extra model calls');

    // Confirm auto-persistence into deck storage on disk.
    const verifier = new StudyService(libraryRoot, { complete: async () => '{}' });
    try {
      const state = await verifier.store.read();
      const savedCard = state.decks.find((d) => d.id === SAMPLE_CARD.deckId)?.cards.find((c) => c.id === SAMPLE_CARD.id);
      assert.equal(savedCard?.followups?.length, 1, 'card.followup auto-persists to card.followups');
      assert.equal(savedCard.followups[0].id, r1.value.item.id);
    } finally {
      await verifier.dispose?.();
    }
  });

  test('2. TUI host.streamComplete enforces pre-reveal answer guard (#1335), emits incremental chunks, supports AbortSignal, and performs zero auto-writes', async (t) => {
    const midStreamGate = deferred();
    let streamTurn = 0;

    const { host, calls, libraryRoot } = await createSeededHost(t, async (_record, execution) => {
      streamTurn += 1;
      if (streamTurn === 1) {
        execution?.onChunk?.('第一步：');
        execution?.onChunk?.('先回忆地址转换的路径。');
        return '第一步：先回忆地址转换的路径。';
      }
      execution?.onChunk?.('前半段');
      await midStreamGate.promise;
      if (execution?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      execution?.onChunk?.('不应到达的后半段');
      return '前半段不应到达的后半段';
    });
    t.after(() => midStreamGate.resolve());

    // Pre-reveal prompt builder must omit reference answer & explanation (#1335),
    // while post-reveal prompt includes them.
    const systemPrompt = buildUnifiedAiSystemPrompt('explain', 'zh', false);
    const preRevealUserPrompt = buildCardDialogueUserPrompt({
      kindLabel: '简答题',
      topic: SAMPLE_CARD.topic,
      prompt: SAMPLE_CARD.prompt,
      revealed: false,
      referenceAnswer: SAMPLE_CARD.answer,
      explanation: SAMPLE_CARD.explanation,
      history: [],
      question: '给我一点提示，不要直接给答案',
      lang: 'zh',
    });
    assert.ok(!systemPrompt.includes(SECRET_ANSWER), 'pre-reveal system prompt must not leak answer');
    assert.ok(!preRevealUserPrompt.includes(SECRET_ANSWER), 'pre-reveal user prompt must not leak answer');
    assert.ok(!preRevealUserPrompt.includes(SECRET_EXPLANATION), 'pre-reveal user prompt must not leak explanation');

    const postRevealUserPrompt = buildCardDialogueUserPrompt({
      kindLabel: '简答题',
      topic: SAMPLE_CARD.topic,
      prompt: SAMPLE_CARD.prompt,
      revealed: true,
      referenceAnswer: SAMPLE_CARD.answer,
      explanation: SAMPLE_CARD.explanation,
      history: [],
      question: '再讲讲为什么快？',
      lang: 'zh',
    });
    assert.ok(postRevealUserPrompt.includes(SECRET_ANSWER), 'post-reveal user prompt should include reference answer');

    // Turn 1: incremental streaming chunks arrive in order without writing card.followups.
    const chunks = [];
    const reply = await host.streamComplete({
      system: systemPrompt,
      prompt: preRevealUserPrompt,
      onChunk: (delta) => chunks.push(delta),
    });
    assert.deepEqual(chunks, ['第一步：', '先回忆地址转换的路径。']);
    assert.equal(reply, '第一步：先回忆地址转换的路径。');
    assert.equal(calls[0].stream, true);

    // Turn 2: AbortSignal cancels mid-stream cleanly and drops trailing chunks.
    const controller = new AbortController();
    const abortedChunks = [];
    const inflight = host.streamComplete({
      system: systemPrompt,
      prompt: preRevealUserPrompt,
      signal: controller.signal,
      onChunk: (delta) => {
        abortedChunks.push(delta);
        controller.abort();
        midStreamGate.resolve();
      },
    });
    await assert.rejects(inflight, (err) => err?.name === 'AbortError');
    assert.deepEqual(abortedChunks, ['前半段']);

    // Storage must have ZERO auto-written followups from streaming Q&A.
    const verifier = new StudyService(libraryRoot, { complete: async () => '{}' });
    try {
      const state = await verifier.store.read();
      const savedCard = state.decks.find((d) => d.id === SAMPLE_CARD.deckId)?.cards.find((c) => c.id === SAMPLE_CARD.id);
      assert.equal(savedCard?.followups?.length ?? 0, 0, 'host.streamComplete must never auto-persist to card.followups');
    } finally {
      await verifier.dispose?.();
    }
  });
});
