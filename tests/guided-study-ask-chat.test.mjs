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
  assert.match(promptZh, /\[StudyHub Context: sessionId=sess-1, runId=run-1, deckId=deck-1, cardId=card-1\]/);

  // English fallback
  const promptEn = buildAskTutorPrompt({
    sessionId: 'sess-2',
    runId: 'run-2',
    deckId: 'deck-2',
    cardId: 'card-2',
    language: 'en',
  });

  assert.match(promptEn, /I'm stuck on this question/);
  assert.match(promptEn, /\[StudyHub Context: sessionId=sess-2/);
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
