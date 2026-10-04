import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F (#124): the prompts that hand a practice question to the conversation are the agent contract.
// They live in one pure module, with the exact text pinned in both languages.
const { cardBrief, askAboutCardPrompt, improveCardPrompt, HELP_CHOICES, IMPROVE_SUGGESTIONS } = await loadUi("export * from './ui/agent-prompts/card.js';");

const run = { deckId: 'deck-1', card: { id: 'card-9', topic: 'Retry', prompt: 'Why is a retry idempotent?',
  options: [{ id: 'a', text: 'Same result' }, { id: 'b', text: 'Twice the cost' }] } };
const location = JSON.stringify({ deckId: 'deck-1', cardId: 'card-9' });

test('the brief: deck, topic, question, lettered options and where the question lives', () => {
  assert.equal(cardBrief({ run, deckTitle: 'Distributed systems' }, 'zh'),
    `题组「Distributed systems」· 主题「Retry」\n题目：Why is a retry idempotent?\n选项：\nA. Same result\nB. Twice the cost\n题库定位：${location}`);
  assert.equal(cardBrief({ run, deckTitle: 'Distributed systems' }, 'en'),
    `Deck “Distributed systems” · Topic “Retry”\nQuestion: Why is a retry idempotent?\nOptions:\nA. Same result\nB. Twice the cost\nLibrary reference: ${location}`);
});

test('the brief without options or a known deck', () => {
  const bare = { ...run, card: { ...run.card, options: [] } };
  assert.equal(cardBrief({ run: bare }, 'zh'), `题组「」· 主题「Retry」\n题目：Why is a retry idempotent?\n题库定位：${location}`);
  assert.equal(cardBrief({ run: { ...run, card: { ...run.card, options: undefined } }, deckTitle: 'D' }, 'en'),
    `Deck “D” · Topic “Retry”\nQuestion: Why is a retry idempotent?\nLibrary reference: ${location}`);
});

test('asking about a card: the exact Chinese text the app always sent, and its English counterpart', () => {
  const zh = askAboutCardPrompt({ run, deckTitle: 'D', extra: '为什么？' }, 'zh');
  const brief = cardBrief({ run, deckTitle: 'D' }, 'zh');
  assert.equal(zh, '我在做这道题时卡住了，想先把前置知识问清楚（先别直接告诉我答案）：\n' + brief
    + '\n\n请先用 study_workspace 的 card.get 读这道题。需要资料依据时，用 source.search 一次查所有关键词，只读命中片段附近的原文，不要逐份翻资料；题库里已有的相关题用 card.search 找。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：为什么？');
  const en = askAboutCardPrompt({ run, deckTitle: 'D', extra: 'Why?' }, 'en');
  assert.equal(en, 'I am stuck on this question and want to understand its prerequisites first. Do not reveal the answer yet:\n' + cardBrief({ run, deckTitle: 'D' }, 'en')
    + '\n\nFirst read the question with study_workspace card.get. When evidence is needed, search all keywords together with source.search and read only matching passages, not every source in sequence. Use card.search for related existing questions. After clarifying each prerequisite, add it with capture, setting requiredBy to the library reference above; link existing questions with card.link.\nMy question: Why?');
  assert.ok(askAboutCardPrompt({ run, deckTitle: 'D' }, 'zh').endsWith('我的问题：'), 'no extra text leaves the question open');
});

test('improving a card: the exact Chinese text the app always sent, and its English counterpart', () => {
  const zh = improveCardPrompt({ run, deckTitle: 'D', extra: '选项 B 太明显' }, 'zh');
  assert.equal(zh, '这道题的质量需要提升：\n' + cardBrief({ run, deckTitle: 'D' }, 'zh')
    + '\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析），核对原文时用 source.search 查关键词、只读命中片段，按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：选项 B 太明显');
  const en = improveCardPrompt({ run, deckTitle: 'D', extra: 'B is obvious' }, 'en');
  assert.equal(en, 'This question needs improvement:\n' + cardBrief({ run, deckTitle: 'D' }, 'en')
    + '\n\nRead the full question, answer and option explanations with study_workspace card.get. Verify sources using keyword searches with source.search and read only matching passages. Apply the requested changes, save with card.update and a clear reason, then explain what changed.\nIssue: B is obvious');
});

test('text that looks like a placeholder passes through untouched', () => {
  const tricky = { ...run, card: { ...run.card, prompt: 'Replace {0} with {1} and keep $& literal', topic: '{2}' } };
  const out = cardBrief({ run: tricky, deckTitle: '{4}' }, 'zh');
  assert.ok(out.includes('Replace {0} with {1} and keep $& literal'));
  assert.ok(out.includes('主题「{2}」'));
  assert.ok(out.startsWith('题组「{4}」'));
});

test('the prompts follow the interface language when none is given', async () => {
  const language = await loadUi("import { setUiLanguage } from './ui/i18n.js'; import { cardBrief } from './ui/agent-prompts/card.js'; setUiLanguage('en'); export const out = cardBrief({ run: " + JSON.stringify(run) + " });");
  assert.match(language.out, /^Deck “/);
});

test('the quick requests of the improve and help forms live with the prompts', () => {
  assert.deepEqual(HELP_CHOICES.map((choice) => choice.id), ['plain', 'angle', 'example', 'steps', 'prerequisite', 'mistake']);
  assert.equal(IMPROVE_SUGGESTIONS.length, 5);
  for (const [label, body] of IMPROVE_SUGGESTIONS) { assert.equal(typeof label, 'string'); assert.ok(body.length > 10); }
});

test('no component holds the agent contract: study_workspace is named only in the prompt modules', async () => {
  for (const file of ['ui/App.jsx', 'ui/Review.jsx', 'ui/ReviewToolbar.jsx', 'ui/ExplanationFollowup.jsx']) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /study_workspace/, file);
  }
});
