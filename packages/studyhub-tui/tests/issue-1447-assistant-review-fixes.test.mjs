// #1447: the assistant's new actions were tested only against a fake host, so a wrong action name or a
// made-up return shape still looked green. Every assertion below drives the REAL backend (`StudyService`
// on a temp library, i.e. `lib/contexts/**/operations.js`), never a canned response.
// Run: node --test tests/issue-1447-assistant-review-fixes.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';
import { StudyService } from '../../../lib/service.js';
import { importExample } from '../../../ui/json-prompts.js';
import { createFakeModel } from '../../../scripts/fake-model.mjs';
import { allowedOpenRoots, resolveAllowedLocalHtmlUrl } from '../src/host/local-html.ts';

const unregisterTsx = register();
after(() => unregisterTsx?.());

const [{ parseAssistantIntent }, actions, { buildConversationRequest }] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-actions.ts'),
  import('../src/shell/assistant-conversation.ts'),
]);
const { executeAssistantReadAction, executeAssistantWriteAction } = actions;

const SOURCE_TEXT = 'Bridge separates an abstraction from its implementation so the two can vary independently.';

/** The host the assistant talks to: this one forwards every call to the real service (no canned values). */
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

async function library(t, { cards = 3, options = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-1447-'));
  const service = new StudyService(root, options);
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

describe('#1447 · 1) 跳过这道题 uses review.skip / an index, never review.move{direction:1}', () => {
  test('the old action really fails on an unanswered question (the bug the review found)', async (t) => {
    const { service, run } = await library(t);
    await assert.rejects(service.call('review.move', { runId: run.id, direction: 1 }), /Answer this question before continuing/);
  });

  test('an unanswered question is skipped by index through the real round', async (t) => {
    const { service, host, run } = await library(t);
    const intent = parse('跳过这道题', run);
    assert.equal(intent.kind, 'run_action');
    assert.equal(intent.actionName, 'review.skip');

    let applied = null;
    const outcome = await executeAssistantReadAction(intent, deps(host, run, { applyRun: (r) => { applied = r; } }));
    assert.equal(outcome.succeeded, true, outcome.text);

    const after = await service.call('review.get', { runId: run.id });
    assert.equal(after.index, 1, 'the round moved to the next question');
    assert.equal(after.navigation.length, 3, 'skipping by index removes nothing');
    assert.equal(after.navigation[0].answered, false, 'the skipped question stays in the round');
    assert.ok(applied, 'the returned run is handed to Review');
    assert.equal(applied.index, after.index);
  });

  test('alone in the round it says so instead of throwing a backend error', async (t) => {
    const { service, host, ids } = await library(t);
    const solo = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: ids[0] }], fresh: true });
    const intent = parse('下一题', solo);
    const outcome = await executeAssistantReadAction(intent, deps(host, solo));
    assert.equal(outcome.succeeded, false);
    assert.match(outcome.text, /只剩这一道待答题目/);
    assert.doesNotMatch(outcome.text, /Answer this question/i);
  });

  test('an ungradable question leaves the round through review.skip', async (t) => {
    const { service, host } = await library(t);
    // The backend marks cards that cannot be graded the way `lib/card-content.js` does; the run copies
    // the card when it starts, so the mark is set before `review.start`.
    await service.store.update((state) => {
      const deck = state.decks.find((item) => item.id === 'd');
      deck.cards.find((card) => card.id === 'q2').publicationUngrable = true;
    });
    const moved = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'q2' }], fresh: true });
    assert.equal(moved.card.id, 'q2');
    assert.equal(moved.card.publicationUngrable, true);

    const intent = parse('跳过这道题', moved);
    const outcome = await executeAssistantReadAction(intent, deps(host, moved));
    assert.equal(outcome.succeeded, true, outcome.text);

    const after = await service.call('review.get', { runId: moved.id });
    assert.equal(after.navigation.length, 0, 'the ungradable question left the round');
    assert.equal(after.navigation.some((item) => item.cardId === 'q2'), false);
  });
});

describe('#1447 · 2) 改判分数 only uses the grade the learner named', () => {
  const card = { runId: 'r', deckId: 'd', cardId: 'c', cardIndex: 0 };
  const ctx = { currentCardId: 'c', currentDeckId: 'd', card: { ...card, runId: 'r' }, lang: 'zh' };

  test('0 分 stays 0 分 (it used to become 4)', () => {
    const intent = parseAssistantIntent('把这道题改判为0分', ctx);
    assert.equal(intent.kind, 'write_confirm');
    assert.equal(intent.actionName, 'review.grade.adjust');
    assert.equal(intent.params.grade, 0);
  });

  test('no number at all asks instead of inventing 4', () => {
    for (const text of ['改判一下这道题', '把评分改成正确', '改判为10分']) {
      const intent = parseAssistantIntent(text, ctx);
      assert.equal(intent.kind, 'clarify', text);
      assert.match(intent.question, /0–5|0-5/);
    }
  });

  test('a question about the grade is not an adjustment', () => {
    for (const text of ['这题判对了吗', '这题我答对了吗？']) {
      const intent = parseAssistantIntent(text, ctx);
      assert.notEqual(intent.kind, 'write_confirm', text);
      assert.notEqual(intent.actionName, 'review.grade.adjust', text);
    }
  });

  test('the preview follows the backend rule (grade >= 3 counts as correct)', () => {
    assert.match(parseAssistantIntent('改判为2分', ctx).previewMessage, /未掌握/);
    assert.match(parseAssistantIntent('改判为5分', ctx).previewMessage, /掌握/);
  });

  test('the parsed grade drives the real review.grade.adjust handler', async (t) => {
    const criteria = [
      { id: 'c1', label: 'Core idea', marks: 2, descriptor: 'Names the idea.', keyPoints: ['Bridge'] },
      { id: 'c2', label: 'Link', marks: 1, descriptor: 'Ties it to the case.', keyPoints: ['abstraction'] },
    ];
    const { service } = await library(t, { options: { complete: createFakeModel() } });
    await service.store.update((state) => {
      state.decks.push({
        id: 'open-deck',
        title: 'Open',
        cards: [{
          id: 'o1', kind: 'open', topic: 'Bridge', objective: 'Explain bridge',
          prompt: 'Why does Bridge help?', answer: 'It separates abstraction from implementation.',
          hint: 'Think about variation.', explanation: 'Both sides vary independently.', misconception: 'Confusing it with adapter.',
          marks: 3, rubricCriteria: criteria, rubric: 'core idea 2; link 1',
          citations: [{ sourceId: 's', quote: SOURCE_TEXT }],
        }],
      });
    });
    const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'open-deck', cardId: 'o1' }], fresh: true });
    await service.call('card.grade', {
      deckId: 'open-deck',
      cardId: 'o1',
      runId: run.id,
      answer: 'Bridge separates an abstraction from its implementation, so both sides vary on their own.',
    });
    const graded = await service.call('review.get', { runId: run.id });
    assert.ok(graded.feedback?.rubric, 'the answer was graded by rubric');

    const raise = parseAssistantIntent('把这道题改判为5分', {
      currentCardId: 'o1', currentDeckId: 'open-deck', card: { cardId: 'o1', deckId: 'open-deck', runId: run.id, cardIndex: 0 }, lang: 'zh',
    });
    const up = await service.call('review.grade.adjust', { ...raise.params, runId: run.id, cardId: 'o1' });
    assert.equal(up.feedback.grade, 5);
    assert.equal(up.feedback.correct, true, 'grade 5 counts as correct in the backend');

    const lower = parseAssistantIntent('把这道题改判为1分', {
      currentCardId: 'o1', currentDeckId: 'open-deck', card: { cardId: 'o1', deckId: 'open-deck', runId: run.id, cardIndex: 0 }, lang: 'zh',
    });
    const down = await service.call('review.grade.adjust', { ...lower.params, runId: run.id, cardId: 'o1' });
    assert.equal(down.feedback.grade, 1);
    assert.equal(down.feedback.correct, false, 'grade 1 is not correct in the backend');
  });
});

describe('#1447 · 3) 撤销钩子检查后端返回值', () => {
  test('a refused restore throws, so the panel never says 已撤销', async (t) => {
    const { service, host, run } = await library(t);
    const intent = parse('斩掉这道题', run);
    assert.equal(intent.actionName, 'card.slay');
    const outcome = await executeAssistantWriteAction(intent, deps(host, run));
    assert.equal(outcome.succeeded, true, outcome.text);
    assert.ok(outcome.undo, 'slaying offers an undo');

    // The real restore succeeds once…
    await outcome.undo.run();
    assert.equal((await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card.slain, undefined);
    // …and the second call is refused by `lib/slay.js`, which the hook must report as a failure.
    await assert.rejects(outcome.undo.run(), /不在斩题组/);
  });

  test('flag undo restores the reason that was there instead of clearing it', async (t) => {
    const { service, host, run } = await library(t);
    await service.call('card.flag', { deckId: 'd', cardId: run.card.id, reason: '人工标记：公式写错' });
    const intent = parse('这题答案有问题，标记一下', run);
    assert.equal(intent.actionName, 'card.flag');
    const outcome = await executeAssistantWriteAction(intent, deps(host, run));
    assert.equal(outcome.succeeded, true, outcome.text);
    assert.equal((await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card.flag, intent.params.reason);

    await outcome.undo.run();
    assert.equal(
      (await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card.flag,
      '人工标记：公式写错',
      'the earlier manual flag comes back',
    );
  });

  test('focus undo restores the earlier value', async (t) => {
    const { service, host, run } = await library(t);
    await service.call('card.focus', { deckId: 'd', cardId: run.card.id, focus: true });
    const intent = parse('取消重点标记', run);
    assert.equal(intent.actionName, 'card.focus');
    const outcome = await executeAssistantWriteAction(intent, deps(host, run));
    assert.equal(outcome.succeeded, true, outcome.text);
    assert.equal((await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card.focus, undefined);
    await outcome.undo.run();
    assert.equal((await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card.focus, true);
  });
});

describe('#1447 · 4) 后端返回的 run 应用回页面', () => {
  test('card.slay hands Review the run the backend now has', async (t) => {
    const { service, host, run } = await library(t);
    let applied = null;
    const outcome = await executeAssistantWriteAction(parse('斩掉这道题', run), deps(host, run, { applyRun: (r) => { applied = r; } }));
    assert.equal(outcome.succeeded, true, outcome.text);
    const live = await service.call('review.get', { runId: run.id });
    assert.ok(applied, 'applyRun was called');
    assert.equal(applied.id, run.id);
    assert.deepEqual(applied.navigation.map((n) => n.cardId), live.navigation.map((n) => n.cardId));
    assert.equal(applied.navigation.some((n) => n.cardId === run.card.id), false, 'the slain card is gone from the run');
  });

  test('review.undo hands back the question the backend restored', async (t) => {
    const { service, host, run } = await library(t);
    const card = (await service.call('review.get', { runId: run.id })).card;
    // `review.get` hides which option is correct until the answer is in; the fixture's answer is option a.
    await service.call('review.answer', { runId: run.id, cardId: card.id, selected: ['a'] });
    const answered = await service.call('review.get', { runId: run.id });
    assert.equal(answered.feedback.correct, true);

    let applied = null;
    const outcome = await executeAssistantWriteAction(
      parse('撤销上一题评分', answered),
      deps(host, answered, { applyRun: (r) => { applied = r; } }),
    );
    assert.equal(outcome.succeeded, true, outcome.text);
    const live = await service.call('review.get', { runId: run.id });
    assert.ok(applied, 'applyRun was called');
    assert.equal(applied.feedback, null, 'the restored question shows no feedback');
    assert.equal(applied.index, live.index);
    assert.equal(live.undoable === undefined || live.undoable === null, true, 'nothing left to undo');
  });

  test('review.queue.edit hands back the reordered round', async (t) => {
    const { service, host, run } = await library(t);
    let applied = null;
    const outcome = await executeAssistantWriteAction(
      parse('把这题挪到最后', run),
      deps(host, run, { applyRun: (r) => { applied = r; } }),
    );
    assert.equal(outcome.succeeded, true, outcome.text);
    const live = await service.call('review.get', { runId: run.id });
    assert.ok(applied, 'applyRun was called');
    assert.deepEqual(applied.navigation.map((n) => n.cardId), live.navigation.map((n) => n.cardId));
    assert.equal(live.navigation.at(-1).cardId, run.card.id, 'the question is last in the round');
  });
});

describe('#1447 · 5) 存到笔记 saves the Q&A the backend can find', () => {
  test('without followupId the backend refuses the note (why the id matters)', async (t) => {
    const { service, run } = await library(t);
    await assert.rejects(
      service.call('note.qa.add', { deckId: 'd', cardId: run.card.id, title: 'x', language: 'zh' }),
      /这条问答已不在这道题上/,
    );
  });

  test('the learner question is kept, the answer is cut at 8000 chars, and the note is written', async (t) => {
    const { service, host, run } = await library(t);
    const longAnswer = `${'答'.repeat(9000)}`;
    const outcome = await executeAssistantWriteAction(parse('存到笔记', run), deps(host, run, {
      lastAssistantReply: longAnswer,
      lastLearnerQuestion: '为什么 Bridge 能让两边独立变化？',
    }));
    assert.equal(outcome.succeeded, true, outcome.text);

    const card = (await service.call('card.get', { deckId: 'd', cardId: run.card.id })).card;
    const followup = card.followups.at(-1);
    assert.equal(followup.question, '为什么 Bridge 能让两边独立变化？', 'the learner’s own question is stored');
    assert.equal(followup.answer.length, 8000, 'the answer is truncated to the backend limit');

    const notes = await service.call('note.list', {});
    const note = (notes.notes || notes.items || []).find((n) => String(n.markdown || '').includes('为什么 Bridge 能让两边独立变化？'));
    assert.ok(note, 'the Q&A reached a study note');
    assert.doesNotMatch(String(note.title), /^学习笔记 · 当前题/, 'the title is learner-facing, not a placeholder');
  });

  test('a follow-up that cannot be saved stops before any note is written', async (t) => {
    const { service, host, run } = await library(t);
    // The question is gone from the library, so `card.followup.add` is refused: no note may be written.
    const ghost = { runId: run.id, deckId: 'd', cardId: 'ghost', cardIndex: 0, total: 3 };
    const intent = parseAssistantIntent('存到笔记', {
      currentCardId: 'ghost',
      currentDeckId: 'd',
      card: ghost,
      lang: 'zh',
    });
    const outcome = await executeAssistantWriteAction(intent, {
      host,
      snapshot: null,
      cardCtx: ghost,
      lang: 'zh',
      navigate: () => {},
      lastAssistantReply: '一段解答',
      lastLearnerQuestion: '为什么？',
    });
    assert.equal(outcome.succeeded, false);
    assert.equal((await service.call('note.list', {})).notes?.length ?? 0, 0);
  });
});

describe('#1447 · 6) 挪到最后 does not copy an answered question', () => {
  test('an answered question is not duplicated', async (t) => {
    const { service, host, run } = await library(t);
    const card = (await service.call('review.get', { runId: run.id })).card;
    await service.call('review.answer', { runId: run.id, cardId: card.id, selected: ['a'] });
    const before = await service.call('review.get', { runId: run.id });

    const outcome = await executeAssistantWriteAction(parse('把这题挪到最后', before), deps(host, before));
    assert.equal(outcome.succeeded, false);
    assert.match(outcome.text, /已经作答/);

    const after = await service.call('review.get', { runId: run.id });
    assert.equal(after.navigation.length, before.navigation.length, 'no duplicate question was added');
    assert.equal(after.navigation.filter((item) => item.cardId === card.id).length, 1);
  });

  test('the raw remove+add the old code sent really does duplicate (proof of the bug)', async (t) => {
    const { service, run } = await library(t);
    const card = (await service.call('review.get', { runId: run.id })).card;
    await service.call('review.answer', { runId: run.id, cardId: card.id, selected: ['a'] });
    const before = await service.call('review.get', { runId: run.id });
    const res = await service.call('review.queue.edit', {
      runId: run.id,
      remove: [{ deckId: 'd', cardId: card.id }],
      add: [{ deckId: 'd', cardId: card.id }],
      position: 'end',
      allowCurrent: true,
    });
    assert.equal(Array.isArray(res.kept) && res.kept.some((item) => item.cardId === card.id), true, 'the backend kept the answered question');
    assert.equal(res.navigation.length, before.navigation.length + 1, 'and appended a copy');
  });
});

describe('#1447 · 7) 出前置题 sends a knowledge point, not the command', () => {
  const card = { runId: 'r', deckId: 'd', cardId: 'c', topic: '虚拟内存', cardIndex: 0 };
  const ctx = { currentCardId: 'c', currentDeckId: 'd', card, lang: 'zh' };

  test('the command is never used as the topic', () => {
    const intent = parseAssistantIntent('出前置题下次补强', ctx);
    assert.equal(intent.kind, 'write_confirm');
    assert.equal(intent.actionName, 'assist.start');
    assert.equal(intent.params.text, '虚拟内存');
    assert.doesNotMatch(intent.params.text, /出|前置题/);
    assert.match(intent.previewMessage, /虚拟内存/);
  });

  test('a knowledge point typed after the colon wins', () => {
    const intent = parseAssistantIntent('出前置题：虚拟地址翻译', ctx);
    assert.equal(intent.params.text, '虚拟地址翻译');
  });

  test('without a topic it asks instead of starting a task', () => {
    const intent = parseAssistantIntent('出前置题', {
      currentCardId: 'c', currentDeckId: 'd', card: { cardId: 'c', deckId: 'd' }, lang: 'zh',
    });
    assert.equal(intent.kind, 'clarify');
  });

  test('the backend accepts the topic as the derive question', async () => {
    const { normalizeAssistRequest } = await import('../../../lib/assist.js');
    const request = normalizeAssistRequest('derive', '虚拟内存', [], { relation: 'prerequisite' });
    assert.equal(request.question, '虚拟内存');
    assert.equal(request.relation, 'prerequisite');
  });
});

describe('#1447 · 建议修', async () => {
  const card = { runId: 'r', deckId: 'd', cardId: 'c', topic: '虚拟内存', cardIndex: 0 };
  const ctx = { currentCardId: 'c', currentDeckId: 'd', card, lang: 'zh' };

  test('a study request phrased with 把 is chat, not a refusal', () => {
    for (const text of ['把这道题讲清楚一点', '帮我把这个公式推导一下']) {
      const intent = parseAssistantIntent(text, ctx);
      assert.equal(intent.kind, 'chat', text);
    }
  });

  test('ordinary questions are not turned into write actions', () => {
    const cases = [
      ['这道题有问题吗？', 'card.flag'],
      ['刷错题有用吗', 'review.start'],
      ['前置题怎么用', 'assist.start'],
    ];
    for (const [text, action] of cases) {
      const intent = parseAssistantIntent(text, ctx);
      assert.notEqual(intent.actionName, action, text);
      if (intent.kind === 'write_confirm') assert.fail(`${text} must not be a silent write`);
    }
  });

  test('translate and terms ask first (they spend model quota)', () => {
    for (const text of ['翻译这道题', '提取术语']) {
      const intent = parseAssistantIntent(text, ctx);
      assert.equal(intent.kind, 'write_confirm', text);
      assert.equal(intent.requiresConfirm, true, text);
    }
  });

  test('a companion HTML inside an authorized companion folder is openable', async (t) => {
    // `app.open` now resolves library roots + `companion.roots.get` (#1447); linked pages live outside the library.
    const base = await mkdtemp(join(tmpdir(), 'study-1447-links-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const { mkdir, writeFile } = await import('node:fs/promises');
    const libraryRoot = join(base, 'library');
    const companionRoot = join(base, 'companions', 'lesson-42');
    await mkdir(libraryRoot, { recursive: true });
    await mkdir(companionRoot, { recursive: true });
    const file = join(companionRoot, 'lesson.html');
    await writeFile(file, '<html><body>lesson</body></html>');
    const href = `file://${file}`;

    assert.equal(resolveAllowedLocalHtmlUrl(href, allowedOpenRoots([libraryRoot])), null, 'the library root alone refuses it');
    assert.equal(
      resolveAllowedLocalHtmlUrl(href, allowedOpenRoots([libraryRoot], [companionRoot])),
      href,
      'an authorized companion folder makes it openable',
    );
    assert.deepEqual(allowedOpenRoots([libraryRoot], [libraryRoot]), [libraryRoot], 'duplicates collapse');
  });
});

describe('#1447 · 复述检查不把助手内容当学习者答案', () => {
  test('the retell prompt names the distinction', async () => {
    const { checkRetell } = await import('../../../lib/teaching.js');
    const seen = [];
    const complete = async (system, prompt) => {
      seen.push({ system, prompt });
      return JSON.stringify({ passed: true, right: ['ok'], missed: [], wrong: [], cite: null });
    };
    const verdict = await checkRetell(complete, {
      material: { prompt: 'Why does Bridge help?' },
      citations: 0,
      text: '它让抽象与实现各自变化。',
      language: 'zh',
      conversationHistory: [
        { role: 'assistant', content: 'Bridge 把抽象和实现分开，因此两者可以独立变化。' },
        { role: 'user', content: '明白了' },
      ],
    });
    assert.equal(verdict.passed, true);
    assert.match(seen[0].system, /priorDiscussion/);
    assert.match(seen[0].system, /not the learner's answer/i);
    assert.match(JSON.stringify(JSON.parse(seen[0].prompt)), /priorDiscussion/);
  });
});

describe('#1447 · 多轮 messages 保持不变', () => {
  test('the assistant still sends native multi-turn messages', () => {
    const built = buildConversationRequest({
      turns: [
        { id: '1', role: 'user', text: '第一个问题' },
        { id: '2', role: 'assistant', text: '第一个回答' },
      ],
      currentUserText: '第二个问题',
      card: null,
      tab: 'assistant',
      stage: 'question',
      isPlainExplain: false,
      lang: 'zh',
    });
    assert.deepEqual(built.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(built.compressed, false);
  });
});
