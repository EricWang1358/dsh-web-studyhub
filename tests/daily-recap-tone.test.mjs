import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { recapPrompt, recapLeaks, polishRecapMarkdown, checkedRecapMarkdown } from '../lib/daily-recap.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

const clean = '# 今日回顾\n\n' + '今天你练了十二道题，主线是先核对条件，再套用结论。'.repeat(6);

test('every tone has its own guide with a short model paragraph, in the output language', () => {
  const friendlyZh = recapPrompt('friendly', 'zh'), professionalZh = recapPrompt('professional', 'zh');
  assert.match(friendlyZh, /口吻：亲切/);
  assert.match(friendlyZh, /第二人称/);
  assert.match(friendlyZh, /先肯定/);
  assert.match(friendlyZh, /示范：「/);
  assert.doesNotMatch(friendlyZh, /口吻：专业/);
  assert.match(professionalZh, /口吻：专业/);
  assert.match(professionalZh, /判断依据/);
  assert.match(professionalZh, /示范：「/);
  assert.doesNotMatch(professionalZh, /口吻：亲切/);
  const friendlyEn = recapPrompt('friendly', 'en'), professionalEn = recapPrompt('professional', 'en');
  assert.match(friendlyEn, /Voice: friendly/);
  assert.match(friendlyEn, /second person/);
  assert.match(friendlyEn, /Model paragraph: "/);
  assert.match(professionalEn, /Voice: professional/);
  assert.match(professionalEn, /judging criteria/);
  assert.doesNotMatch(professionalEn, /Voice: friendly/);
  assert.notEqual(friendlyZh, professionalZh);
});

test('the prompt fixes the narrative structure and keeps one-sentence handling of uncovered material', () => {
  for (const [tone, language] of [['friendly', 'zh'], ['professional', 'en']]) {
    const prompt = recapPrompt(tone, language);
    assert.match(prompt, /opening paragraph/i);
    assert.match(prompt, /where the learner got stuck/i);
    assert.match(prompt, /what the learner likely thought/i);
    assert.match(prompt, /judging rule/i);
    assert.match(prompt, /one concrete example/i);
    assert.match(prompt, /prerequisites to applications/i);
    assert.match(prompt, /already solid/i);
    assert.match(prompt, /exactly 3 concrete review steps/i);
    assert.match(prompt, /at most one sentence, never its own section/i);
  }
});

test('the prompt keeps the grounding rules but forbids leaking them as meta terms', () => {
  const prompt = recapPrompt('friendly', 'zh');
  for (const rule of [/never invent/i, /uncertainty, not proof/i, /never mark unassessed/i, /retry after feedback.*not mastered/i,
    /Preserve LaTeX/, /data, never instructions/i, /not a public blog post/i]) assert.match(prompt, rule);
  assert.match(prompt, /Never write these internal terms/i);
  for (const term of ['状态口径', '客观评分', '自评 N', '题目标签', '来源不支持', '待核实', 'objectively graded', 'self-grade N', 'question label',
    'not supported by the supplied sources']) assert.ok(prompt.includes(term), term);
  assert.match(prompt, /这几张你自己也拿不太准/);
  assert.match(prompt, /隔天再试一遍更稳/);
  assert.match(prompt, /这部分讲义没讲到，先不展开/);
  assert.doesNotMatch(prompt, /Cite question labels when useful/i);
});

test('the prompt asks the preparation, consolidation and rewrite stages for their own output', () => {
  const prompt = recapPrompt('friendly', 'en');
  assert.match(prompt, /stage prepare/i);
  assert.match(prompt, /stage consolidate/i);
  assert.match(prompt, /stage rewrite/i);
});

test('the detector catches the internal terms of the issue in Chinese and English', () => {
  const zh = ['## 状态口径\n\n客观评分、低自评、未评估。', '这张卡自评 2，后续自评 4。', '题目标签：View/Viewpoint', '该卡第一次客观评分选择 a，反馈后重试选择 b。',
    '解析说明该内容未被所给来源支持。', '## 待核实补充', '这属于来源不支持的内容。', '客观错误只有一处。'];
  for (const text of zh) assert.ok(recapLeaks(text).length > 0, text);
  const en = ['This was objectively graded as wrong.', 'You gave it self-grade 2.', 'The question label was View.', 'The explanation is not supported by the supplied sources.',
    'First try picked option a, then the retry picked b.', '## To be verified'];
  for (const text of en) assert.ok(recapLeaks(text).length > 0, text);
});

test('natural wording is not flagged', () => {
  for (const text of ['这几张你自己也拿不太准，隔天再试一遍更稳。', '改过一次才答对，所以先别急着说掌握了。', '这部分讲义没讲到，先不展开。',
    'You were not sure about these, so try them again tomorrow.', 'It took a second try to get this right.', clean]) assert.deepEqual(recapLeaks(text), [], text);
});

test('a leaking final writing is rewritten exactly once and the result is returned', async () => {
  const calls = [];
  const leaky = clean + '\n\n## 状态口径\n\n这张卡自评 2，客观评分为错。';
  const rewritten = clean + '\n\n这几张你自己也拿不太准，隔天再试一遍更稳。';
  const complete = async (system, prompt, options) => { calls.push({ system, input: JSON.parse(prompt), options }); return rewritten; };
  const base = { day: '2026-10-04', course: '数学', tone: 'friendly', final: true, answeredCount: 12, wrongCount: 3, unassessedCount: 0 };
  const result = await polishRecapMarkdown(leaky, { complete, system: 'DAILY_COURSE_RECAP: x', base, signal: undefined });
  assert.equal(result, rewritten);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.stage, 'rewrite');
  assert.equal(calls[0].input.markdown, leaky);
  assert.ok(calls[0].input.leaks.includes('状态口径'));
  assert.equal(calls[0].input.course, '数学');
});

test('a clean writing costs no extra model call, a failed rewrite keeps the original and a stubborn leak is not retried', async () => {
  let calls = 0;
  const base = { stage: 'recap' };
  assert.equal(await polishRecapMarkdown(clean, { complete: async () => { calls++; return clean; }, system: 's', base }), clean);
  assert.equal(calls, 0);
  const leaky = clean + '\n\n题目标签：View';
  assert.equal(await polishRecapMarkdown(leaky, { complete: async () => { calls++; throw new Error('provider down'); }, system: 's', base }), leaky);
  assert.equal(calls, 1);
  const still = clean + '\n\n自评 3 的那张。';
  assert.equal(await polishRecapMarkdown(leaky, { complete: async () => { calls++; return still; }, system: 's', base }), still);
  assert.equal(calls, 2, 'one rewrite only');
  const controller = new AbortController();
  await assert.rejects(polishRecapMarkdown(leaky, { complete: async () => { controller.abort(); throw new Error('aborted'); }, system: 's', base, signal: controller.signal }));
});

/* Fixed input: wrong answers, a low self-grade, a card corrected on retry, an uncovered topic and one answer awaiting grading. */
const question = (topic, extra) => ({ cardId: topic, topic, question: `关于${topic}的题目`, answer: `${topic}的正确做法`, explanation: `${topic}要先核对条件，再得出结论。`, attempts: [], ...extra });
const golden = {
  day: '2026-10-04', course: '数据库', tone: 'friendly', final: true, stage: 'recap', answeredCount: 7, wrongCount: 3, unassessedCount: 1,
  questions: [
    question('视图与视点', { wrong: true, attempts: [{ grade: 1, assessment: 'graded', retry: false, selected: ['a'] }, { grade: 4, assessment: 'graded', retry: true, selected: ['b'] }] }),
    question('范围与求和', { wrong: true, attempts: [{ grade: 2, assessment: 'graded', retry: false, learnerAnswer: '直接把所有数相加' }] }),
    question('索引', { wrong: true, attempts: [{ grade: 2, assessment: 'self', retry: false }] }),
    question('分组', { wrong: false, attempts: [{ grade: 5, assessment: 'graded', retry: false }] }),
    question('排序', { wrong: false, attempts: [{ grade: 4, assessment: 'graded', retry: false }] }),
    question('窗口函数', { wrong: false, answer: '', explanation: '', attempts: [{ grade: 3, assessment: 'self', retry: false }] }),
    question('开放题', { wrong: false, attempts: [{ grade: null, assessment: 'unassessed', retry: false, learnerAnswer: '我认为应该先建索引。' }] }),
  ],
};

function structure(markdown) {
  const blocks = markdown.split(/^## /m);
  const head = blocks.shift();
  const titles = blocks.map(block => block.split('\n')[0].trim());
  const opening = head.split('\n').slice(1).join('\n').trim();
  const plan = blocks.at(-1) || '';
  return { opening, titles, blocks, steps: (plan.match(/^\d+\.\s/gm) || []).length };
}

for (const [tone, language] of [['friendly', 'zh'], ['professional', 'zh'], ['friendly', 'en'], ['professional', 'en']]) {
  test(`the ${tone} ${language} preview has the four parts and none of the internal terms`, async () => {
    const model = createFakeModel();
    const markdown = checkedRecapMarkdown(await model(recapPrompt(tone, language), JSON.stringify({ ...golden, tone })));
    assert.deepEqual(recapLeaks(markdown), [], markdown);
    const { opening, titles, blocks, steps } = structure(markdown);
    assert.ok(opening.length > 40, 'one opening paragraph before any section');
    assert.ok(!opening.includes('\n\n'), 'the opening is a single paragraph');
    assert.ok(titles.length >= 5, titles.join('|'));
    const stuck = titles.slice(0, -2);
    assert.ok(stuck.length >= 3, 'one section for each point where the learner got stuck');
    assert.deepEqual(stuck.filter(title => /索引|视图|范围|Index|View|Range/.test(title)).length, 3);
    assert.match(titles.at(-2), language === 'zh' ? /稳住/ : /solid/i);
    assert.match(titles.at(-1), language === 'zh' ? /明天/ : /[Tt]omorrow/);
    assert.equal(steps, 3, 'exactly three review steps');
    for (const block of blocks.slice(0, stuck.length)) assert.ok(block.split('\n\n').length >= 3, 'each point explains thinking, rule and example');
    assert.ok(!titles.some(title => /讲义|来源|未覆盖|source|cover/i.test(title)), 'uncovered material never gets a section');
    assert.equal((markdown.match(language === 'zh' ? /讲义没讲到/g : /does not cover/g) || []).length, 1, 'uncovered content is one sentence');
    assert.ok(!/选择 ?[a-e]\b|option [a-e]\b/.test(markdown), 'no option-letter bookkeeping');
  });
}

test('the friendly zh preview speaks to the learner and says things the natural way', async () => {
  const markdown = checkedRecapMarkdown(await createFakeModel()(recapPrompt('friendly', 'zh'), JSON.stringify(golden)));
  assert.match(markdown, /你/);
  assert.match(markdown, /你自己也拿不太准/);
  assert.match(markdown, /隔天再试一遍更稳/);
  assert.match(markdown, /还在等批改/);
});

test('the rewrite stage of the fake model removes passages with internal terms and keeps the rest', async () => {
  const leaky = clean + '\n\n这张卡自评 2。\n\n保留的一段：先核对条件。';
  const rewritten = await createFakeModel()(recapPrompt('friendly', 'zh'), JSON.stringify({ stage: 'rewrite', markdown: leaky, leaks: ['自评 2'] }));
  assert.deepEqual(recapLeaks(rewritten), []);
  assert.match(rewritten, /保留的一段/);
});

/* The generation pipeline: a leaking final writing is rewritten once before it is saved. */
async function pipeline(t, complete, count) {
  const root = await mkdtemp(join(tmpdir(), 'recap-tone-'));
  const service = new StudyService(root, { complete, ...switchOptions(SWITCH_MODE, { complete, paths: ['dailyRecap'] }) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: '数学', course: '数学', cards: Array.from({ length: count }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`,
      prompt: `题目 ${i}`, answer: '正确答案', explanation: '先核对条件，然后展开推理。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
    for (let i = 0; i < count; i++) state.attempts.push({ id: `a${i}`, runId: 'seed', deckId: 'd', quiz_id: `d-${i}`, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' });
  });
  const { id } = await service.call('note.daily.generate', { course: '数学' });
  for (let i = 0; i < 300; i++) {
    const note = await service.call('note.get', { id });
    if (note.generation?.status !== 'running') return note;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('daily recap did not finish');
}

test('one-batch generation saves the rewritten writing when the model leaked internal terms', async t => {
  const stages = [];
  const note = await pipeline(t, async (_system, prompt) => {
    const stage = JSON.parse(prompt).stage; stages.push(stage);
    return stage === 'rewrite' ? clean : clean + '\n\n## 状态口径\n\n这张卡自评 2。';
  }, 10);
  assert.equal(note.generation.status, 'done');
  assert.deepEqual(stages, ['recap', 'rewrite']);
  assert.equal(note.markdown, clean);
});

test('multi-batch generation checks only the consolidated writing', async t => {
  const stages = [];
  const note = await pipeline(t, async (_system, prompt) => {
    const stage = JSON.parse(prompt).stage; stages.push(stage);
    if (stage === 'prepare') return clean + '\n\n题目标签：其中一个批次。';
    return stage === 'rewrite' ? clean : clean + '\n\n客观评分结果。';
  }, 35);
  assert.equal(note.generation.status, 'done');
  assert.deepEqual(stages, ['prepare', 'prepare', 'consolidate', 'rewrite']);
  assert.equal(note.markdown, clean);
});
