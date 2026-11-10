/* The three tools under a practice question (#950, #949): every sentence of the flow says where the result shows first, and only then that the 信箱 says when it
   is done. One wording per fact, the same in the form's note, the sentence after the submit, the tours and 找功能. The facts were read in the code:
     帮我弄懂  the answer is kept on the card as a 追问 (lib/assist-content.js card.followup.add) and drawn under the question in 理解这道题 (ui/ExplanationFollowup.jsx);
     出前置题  the new question is added to the same deck and linked as this card's prerequisite (addAssistCard + card.link), shown in the 前置题 strip;
     修题      the card is updated in place with a revision (card.update); the 信箱 letter has 「回退这次改题」 (lib/inbox.js canRevert, ui/Inbox.jsx), one click.
   The sentences of the other flows (audio, translation, case grading, passage top-up, notes) are not here and stay as they were. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TOUR_STEPS, CORE_TOUR_LENGTH } from '../ui/tour/steps.js';
import { FINDER_ENTRIES } from '../ui/finder/entries.js';

const han = /[㐀-鿿]/;
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const catalogue = Object.assign({}, ...await Promise.all((await readdir('ui/locales')).filter(name => /^en(\..+)?\.json$/.test(name))
  .map(async name => JSON.parse(await readFile(join('ui/locales', name), 'utf8')))));
const step = id => TOUR_STEPS.find(entry => entry.id === id);
const entry = id => FINDER_ENTRIES.find(item => item.id === id);

/* The one wording of each fact (Chinese source text). */
const ASK_WHERE = '讲解会出现在这道题下面的问答里';
const DERIVE_WHERE = '新题会放进同一题组';
const FIX_WHERE = '直接改这张卡';
const INBOX_DONE = '完成时信箱会提醒你';
const FIX_UNDO = '在信箱里可以一步撤销';

const inOrder = (text, first, second, label) => {
  assert.ok(text.includes(first), `${label}: says ${first}`);
  assert.ok(text.includes(second), `${label}: says ${second}`);
  assert.ok(text.indexOf(first) < text.indexOf(second), `${label}: where the result shows comes before the 信箱`);
};

test('the 帮我弄懂 form note, the sentence after submitting, the full tour and 找功能 all say the explanation is under the question, then that the 信箱 says when', async () => {
  const run = await read('ui/review/QuestionRun.jsx'), session = await read('ui/review/useReviewSession.js');
  const note = '提交后才启动后台助教。讲解会出现在这道题下面的问答里，完成时信箱会提醒你；做题和主会话可以继续。';
  assert.ok(run.includes(`ui("${note}")`), 'the note under the form');
  inOrder(note, ASK_WHERE, INBOX_DONE, 'form note');
  const notified = '后台助教正在解答。讲解会出现在这道题下面的问答里，完成时信箱会提醒你。';
  assert.ok(session.includes(`ui('${notified}')`), 'the sentence after submitting');
  inOrder(notified, ASK_WHERE, INBOX_DONE, 'after submit');
  inOrder(step('help').body, ASK_WHERE, INBOX_DONE, 'full tour help step');
  inOrder(entry('help-me-understand').what, ASK_WHERE, INBOX_DONE, '找功能: 帮我弄懂');
});

test('出前置题: the new question goes into the same deck, then the 信箱 says when (after submitting, the tour, 找功能)', async () => {
  const session = await read('ui/review/useReviewSession.js');
  const notified = '后台助教正在出题。新题会放进同一题组，完成时信箱会提醒你。';
  assert.ok(session.includes(`ui('${notified}')`));
  inOrder(notified, DERIVE_WHERE, INBOX_DONE, 'after submit');
  const derive = entry('derive-prerequisite');
  assert.ok(derive, 'the finder has an entry for 出前置题 (there was none)');
  assert.deepEqual(derive.path, ['练习', '题目下方', '更多', '出前置题…']);
  assert.deepEqual(derive.anchors, ['review-more']);
  inOrder(derive.what, '同一题组', INBOX_DONE, '找功能: 出前置题');
  assert.ok(derive.what.includes('出成前置题'), 'and where the other way in is: under a saved answer');
});

test('修题: this card is changed in place and the 信箱 holds the undo (the form, after submitting, the tour, 找功能)', async () => {
  const run = await read('ui/review/QuestionRun.jsx'), session = await read('ui/review/useReviewSession.js');
  assert.ok(run.includes('这道题哪里不好？后台助教会直接改这张卡，改完可在信箱里一步撤销'), 'the label above the box');
  const notified = '后台助教正在改这道题，会直接改这张卡。完成时信箱会提醒你，在信箱里可以一步撤销。';
  assert.ok(session.includes(`ui('${notified}')`));
  inOrder(notified, FIX_WHERE, INBOX_DONE, 'after submit');
  assert.ok(notified.includes(FIX_UNDO));
  inOrder(entry('fix-question').what, FIX_WHERE, INBOX_DONE, '找功能: 修题');
  assert.ok(entry('fix-question').what.includes(FIX_UNDO));
  assert.ok(step('help').body.includes('「修题」'), 'the full tour names 修题');
});

test('no sentence of this flow still says the result "goes to" the 信箱 first', async () => {
  const run = await read('ui/review/QuestionRun.jsx'), session = await read('ui/review/useReviewSession.js'), steps = await read('ui/tour/steps.js');
  for (const [file, text] of [['QuestionRun.jsx', run], ['useReviewSession.js', session.replace(/'已提交批改[^']*'/, '')], ['steps.js', steps]]) {
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /(送进|进|投递到)信箱/, `${file}: ${text.match(/.{12}(送进|进|投递到)信箱.{6}/)?.[0]}`);
  }
  for (const id of ['help-me-understand', 'fix-question', 'derive-prerequisite']) assert.doesNotMatch(entry(id).what, /(送进|进|投递到)信箱/, id);
  // 信箱's own finder entry no longer says everything is "delivered" there: the explanations, new questions and edits are where they belong.
  assert.doesNotMatch(entry('mailbox').what, /都投递到信箱/);
  assert.match(entry('mailbox').what, /完成时/);
});

test('the short tour names the three tools under the question in its practice step and keeps its seven steps; the full tour says where each is', () => {
  const practice = step('practice').body;
  for (const word of ['「帮我弄懂」', '「修题」', '「出前置题…」', '「更多」']) assert.ok(practice.includes(word), `practice step: ${word}`);
  assert.ok(practice.includes('这道题下面'), 'the explanation is under the question');
  assert.ok(practice.indexOf('试着答一题吧') > practice.indexOf('「修题」'), 'still ends on the invitation to answer one');
  assert.equal(CORE_TOUR_LENGTH, 7, 'one more sentence, not one more step');
  const help = step('help').body;
  for (const word of ['「修题」', '「更多」', '「出前置题…」', '「出成前置题」']) assert.ok(help.includes(word), `help step: ${word}`);
});

test('every new or changed sentence has its English, and the English has no Chinese', async () => {
  const run = await read('ui/review/QuestionRun.jsx'), session = await read('ui/review/useReviewSession.js');
  const texts = [
    ...[...(run + session).matchAll(/ui\((["'])((?:(?!\1).)*信箱(?:(?!\1).)*)\1\)/g)].map(match => match[2]),
    step('practice').body, step('help').body, entry('help-me-understand').what, entry('fix-question').what, entry('derive-prerequisite').what, entry('mailbox').what,
    entry('derive-prerequisite').title, entry('derive-prerequisite').path.at(-1),
    '这道题哪里不好？后台助教会直接改这张卡，改完可在信箱里一步撤销',
    '没懂？点「帮我弄懂」，讲解会直接出现在这道题下面。', '觉得题目有问题？点「修题」，助教直接改这张卡，改完在信箱里能一步撤销。',
    '基础不牢？点「出成前置题」，在同一题组里补一道更基础的题，练完再回到这道题。',
  ];
  assert.ok(texts.length >= 14);
  for (const text of texts) {
    assert.ok(catalogue[text], `no English for: ${text}`);
    assert.doesNotMatch(catalogue[text], han, `Chinese left in the English of: ${text}`);
  }
});
