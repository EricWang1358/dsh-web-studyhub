import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAskTutorPrompt, applyAskTutorMessage } from '../ui/agent-prompts/guided-study.js';

test('buildAskTutorPrompt formats user message and context fence for main chat', () => {
  const promptZh = buildAskTutorPrompt({
    sessionId: 'sess-1',
    runId: 'run-1',
    deckId: 'deck-1',
    cardId: 'card-1',
    userMessage: '这道递归题终止条件怎么找？',
    language: 'zh',
  });

  assert.match(promptZh, /^这道递归题终止条件怎么找？/);
  assert.match(promptZh, /sessionId=sess-1 runId=run-1 deckId=deck-1 cardId=card-1/);
  assert.match(promptZh, /先用 study\.scene\.get \{"sessionId":"sess-1"\} 读我的作答/, 'says where to read the answer (#548)');
  assert.doesNotMatch(promptZh, /StudyHub Context/, 'no English machine tag in a Chinese message');

  // English fallback
  const promptEn = buildAskTutorPrompt({
    sessionId: 'sess-2',
    runId: 'run-2',
    deckId: 'deck-2',
    cardId: 'card-2',
    language: 'en',
  });

  assert.match(promptEn, /I'm stuck on this question/);
  assert.match(promptEn, /study\.scene\.get \{"sessionId":"sess-2"\}/);
  const withStem = buildAskTutorPrompt({ sessionId: 's', stem: '  二分查找  的循环\n不变式是什么？ ', answered: true, correct: false, language: 'zh' });
  assert.match(withStem, /题目：二分查找 的循环 不变式是什么？/, 'the stem, on one line');
  assert.match(withStem, /状态：已作答，答错了/);
  assert.match(buildAskTutorPrompt({ sessionId: 's', language: 'zh' }), /状态：还没作答/);
});

test('applyAskTutorMessage dispatches to host.askInChat or falls back to clipboard', async () => {
  let filledPrompt = null;
  const mockHost = {
    askInChat: async (text) => {
      filledPrompt = text;
      return 'filled';
    },
  };

  const res = await applyAskTutorMessage(mockHost, '请教思路');
  assert.equal(res.status, 'filled');
  assert.equal(filledPrompt, '请教思路');
  assert.match(res.message, /已填入主会话输入框/);

  // Host without askInChat falls back to clipboard
  const fallbackRes = await applyAskTutorMessage({}, '请教思路');
  assert.equal(fallbackRes.status, 'copied_to_clipboard');
  assert.match(fallbackRes.message, /已复制请教内容到剪贴板/);
});
