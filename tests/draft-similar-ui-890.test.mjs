import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* #890 S2: on the draft page a question that `draft.similar` flags carries ONE short notice in its row (「与《X》第 12 题相似」, or the draft's own number),
   and opening the question shows the other question's stem. Nothing is blocked or removed and no button is added. A page rendered outside the app cannot
   ask the backend, so the answer is seeded into the page's memo (ui/draft-similar.js) under the key the page asks with: the draft id and
   `${data.revision}:${draft.draftVersion}`. */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { askSimilar, seedSimilar, forgetSimilar } from './ui/draft-similar.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const noop = () => {};
const card = (id, prompt) => ({ id, kind: 'quiz', topic: 't', prompt, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x', options: [], citations: [] });
const draft = { id: 'd1', title: 'T', draftVersion: 3, cards: [card('c1', '请简要解释熵在信息论中的含义'), card('c2', '操作系统为什么需要进程调度'), card('c3', '请简要说明熵在信息论中的含义')],
  editorial: { reviewedCards: {} } };
const answer = { status: 'ok', draftId: 'd1', draftVersion: 3, threshold: 0.72, similar: [
  { cardId: 'c1', n: 1, similarity: 0.77, other: { where: 'draft', deckId: null, deckTitle: null, cardId: 'c3', n: 3, prompt: '请简要说明熵在信息论中的含义' } },
  { cardId: 'c3', n: 3, similarity: 0.85, other: { where: 'deck', deckId: 'deck', deckTitle: '信息论基础', cardId: 'old', n: 12, prompt: '熵在信息论中的含义是什么？' } },
] };
const data = { sources: [], decks: [], drafts: [draft], jobs: [], modelReady: true, runs: [], revision: 'r7' };
const page = (language = 'zh', seeded = answer, shown = draft) => {
  m.setUiLanguage(language);
  try {
    m.forgetSimilar();
    if (seeded) m.seedSimilar('d1', 'r7:3', seeded);
    return renderToStaticMarkup(inApp(m, React.createElement(m.Draft, { data: { ...data, drafts: [shown] }, draft: shown, draftLoaded: JSON.stringify(shown), setDraft: noop, draftText: '', setDraftText: noop, jsonMode: false,
      setJsonMode: noop, openDraft: noop, onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setModal: noop, blankCard: noop, patchCard: noop,
      parseDraft: JSON.parse, topUpDraft: noop }), { data: { ...data, drafts: [shown] } }));
  } finally { m.setUiLanguage('zh'); }
};
const questions = (html) => html.split('<details class="').filter((part) => part.startsWith('draft-card') || part.includes(' draft-card')).slice(0, 3);
const rowOf = (part) => part.slice(part.indexOf('<summary'), part.indexOf('</summary>'));
/** The notice of a row as its text, and the part of it that is not the (cut-short) deck title. */
const notice = (part) => { const tag = rowOf(part).match(/<small[^>]*data-similar[^>]*>([\s\S]*?)<\/small>/)?.[1] ?? ''; return { text: tag.replace(/<[^>]+>/g, ''), fixed: tag.replace(/<span[^>]*data-similar-title[^>]*>[\s\S]*?<\/span>/, '') }; };

test('only the flagged questions carry the notice, in their row, naming the draft number or the deck and its number', () => {
  const [first, second, third] = questions(page());
  assert.equal(notice(first).text, '与本草稿第 3 题相似');
  assert.doesNotMatch(second, /data-similar/, 'a question with no near-duplicate has no notice');
  assert.equal(notice(third).text, '与《信息论基础》第 12 题相似');
  for (const part of [first, third]) assert.equal(rowOf(part).split('data-similar=').length - 1, 1, 'one notice per question');
});

test('opening a flagged question shows the other question\'s stem and says nothing is blocked; no button is added', () => {
  const [first, , third] = questions(page());
  assert.match(first, /data-similar-detail[\s\S]*请简要说明熵在信息论中的含义/);
  assert.match(third, /data-similar-detail[\s\S]*熵在信息论中的含义是什么？/);
  assert.match(third, /相似度 85%/);
  const detail = third.slice(third.indexOf('data-similar-detail'));
  assert.doesNotMatch(detail.slice(0, detail.indexOf('</div>')), /<button/, 'the notice has no button of its own');
  assert.equal((page().match(/<button/g) || []).length, (page('zh', null).match(/<button/g) || []).length, 'the page has exactly the buttons it had without the notice');
});

test('in English the notice reads naturally and keeps the numbers', () => {
  const [first, , third] = questions(page('en'));
  assert.equal(notice(first).text, 'Similar to Q3 here');
  assert.equal(notice(third).text, 'Similar to Q12 of “信息论基础”');
  assert.match(third, /85% similar/);
});

test('without an answer for this draft (not loaded yet, or one about another draft) the page shows no notice', () => {
  assert.doesNotMatch(page('zh', null), /data-similar/);
  assert.doesNotMatch(page('zh', { ...answer, draftId: 'other' }), /data-similar/, 'an answer about another draft is not shown');
});

test('a long deck title is cut in its own span: 「相似」 and the number are outside it and always show', () => {
  const title = '操作系统原理与设计第二版·第三章进程管理与调度算法（含历年真题）';
  const long = { ...answer, similar: [{ ...answer.similar[1], other: { ...answer.similar[1].other, deckTitle: title } }] };
  for (const [language, said] of [['zh', /^与第 12 题相似$/], ['en', /^Similar to Q12 of $/]]) {
    m.setUiLanguage(language);
    const [, , third] = questions(page(language, long));
    m.setUiLanguage('zh');
    const { text, fixed } = notice(third);
    assert.ok(text.includes(title), 'the whole title is in the page (cut by the stylesheet, not by the text)');
    assert.match(fixed, said, `the words and the number are not in the part that is cut: ${fixed}`);
    assert.match(rowOf(third), /<span class="draft-card__similar-title" data-similar-title="true">/);
  }
});

test('an embedded image in a question is named in its row, never drawn or spelled out', () => {
  const pictured = { ...draft, cards: [card('c1', `![电路图](data:image/png;base64,${'A'.repeat(2000)})图中电路的输出是什么？`), ...draft.cards.slice(1)] };
  const [first] = questions(page('zh', null, pictured));
  assert.match(rowOf(first), /\[电路图\]图中电路的输出是什么？/);
  assert.doesNotMatch(rowOf(first), /data:image/);
});

test('one question in flight per draft and at most one more: asks made meanwhile share the later answer', async () => {
  const asked = [], waiting = [];
  const call = (action, args) => { asked.push([action, args.id]); return new Promise((resolve) => waiting.push(resolve)); };
  const first = m.askSimilar(call, 'd1');
  const meanwhile = [m.askSimilar(call, 'd1'), m.askSimilar(call, 'd1'), m.askSimilar(call, 'd1')];
  assert.deepEqual(asked, [['draft.similar', 'd1']], 'one question while the first is out');
  waiting.shift()({ status: 'ok', draftId: 'd1', similar: [], answer: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked.length, 2, 'asked once more, for everything that changed meanwhile');
  waiting.shift()({ status: 'ok', draftId: 'd1', similar: [], answer: 2 });
  assert.deepEqual((await Promise.all([first, ...meanwhile])).map((item) => item.answer), [2, 2, 2, 2]);
  const later = m.askSimilar(call, 'd1');
  assert.equal(asked.length, 3, 'a question after the answer asks again');
  waiting.shift()({ status: 'ok', draftId: 'd1', similar: [], answer: 3 });
  assert.equal((await later).answer, 3);
});
