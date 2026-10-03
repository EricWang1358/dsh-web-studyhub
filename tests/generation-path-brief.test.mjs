import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { pathBrief, MATTER_WORDS } from '../ui/generation-path-flow.js';
import { CALL_PAGES, CALL_QUESTIONS } from '../lib/generation-path.js';

/* 2.5.8: the brief that opens the conversation about the path. It carries the book page range of every step (so "p.55-76" can be mapped without guessing), how to get
   the sourceIds of a custom range, the size of one generate call, how to see a job (job.status) and to start the next step only after the one before ended, and
   it says which steps to skip. English and Chinese say the same things. */

const book = 'Architecting Software Solutions';
const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `src-${from + i}`);
const steps = (zh = true) => [
  { id: 'step-1', order: 1, title: zh ? 'Fundamentals of Software Architecture · 第 6–22 页' : 'Fundamentals of Software Architecture · Pages 6–22', sourceIds: ids(6, 22), pages: 17, chars: 29_750, count: 6, focus: '',
    ranges: [{ document: book, from: 6, to: 22 }], included: true, optional: false, matter: '' },
  { id: 'step-2', order: 2, title: zh ? '第 55–76 页' : 'Pages 55–76', sourceIds: ids(55, 76), pages: 22, chars: 39_000, count: 25, focus: zh ? '概念' : 'concepts',
    ranges: [{ document: book, from: 55, to: 76 }, { document: book, from: 80, to: 80 }], included: true, optional: false, matter: '' },
  { id: 'step-3', order: 3, title: zh ? 'Index … Colophon · 第 406–422 页' : 'Index … Colophon · Pages 406–422', sourceIds: ids(406, 422), pages: 17, chars: 29_750, count: 6, focus: '',
    ranges: [{ document: book, from: 406, to: 422 }], included: false, optional: true, matter: 'index' },
];
const brief = (language, extra = {}) => pathBrief({ steps: steps(language === 'zh'), course: 'SWE', goal: '', indexed: true, language, ...extra });

test('every step carries the book pages it covers, so the learner\'s "p.55–76" can be mapped to pages without guessing', () => {
  const zh = brief('zh');
  assert.match(zh, /第 6–22 页/);
  assert.match(zh, /第 55–76 页、第 80 页/, 'the runs of pages, not just first and last');
  assert.ok(zh.includes(book), 'the name of the book');
  assert.match(zh, /PDF/, 'says what the numbers are');
  const en = brief('en');
  assert.match(en, /pages 6–22/i);
  assert.match(en, /pages 55–76, 80/);
  assert.ok(en.includes(book));
});

test('it says how to get the sourceIds of a custom page range, and that ids are fetched when they were left out', () => {
  for (const text of [brief('zh'), brief('en')]) {
    assert.match(text, /source\.list/);
    assert.match(text, /groupBy/);
    assert.match(text, /memberOffset|memberLimit/);
  }
});

test('the size of one generate call is told: at most 20 pages and 15 questions, a bigger step is split into several calls', () => {
  assert.equal(CALL_PAGES, 20); assert.equal(CALL_QUESTIONS, 15);
  const zh = brief('zh'), en = brief('en');
  assert.match(zh, new RegExp(`至多 ${CALL_PAGES} 页`));
  assert.match(zh, new RegExp(`${CALL_QUESTIONS} 题`));
  assert.match(zh, /拆成/);
  assert.match(en, new RegExp(`at most ${CALL_PAGES} pages`, 'i'));
  assert.match(en, new RegExp(`${CALL_QUESTIONS} questions`));
  assert.match(en, /split/i);
});

test('it tells the agent to look at a job with job.status, to report what it sees, and to start the next step only after the one before ended', () => {
  const zh = brief('zh'), en = brief('en');
  assert.match(zh, /job\.status/);
  assert.match(zh, /上一步[^。]*(完成|结束)[^。]*(再|才)/, 'the next step only after the previous one finished');
  assert.match(zh, /不要.*(承诺|自己).*?(回报|汇报|告诉)|(无法|不能).*(自己|主动)/s, 'no promise to report on its own');
  assert.match(en, /job\.status/);
  assert.match(en, /previous (step|call)[^.]*finished/i);
  assert.match(en, /(cannot|can't) watch|do not promise/i);
});

test('a step that is optional or switched off is listed as one to skip (no ids), with what it is; the steps in use keep their ids', () => {
  const zh = brief('zh'), en = brief('en');
  assert.match(zh, /第 3 步[^\n]*建议跳过/);
  assert.match(zh, new RegExp(MATTER_WORDS.index.zh));
  assert.ok(!zh.includes('src-410'), 'no page ids for a step to skip');
  assert.ok(zh.includes('src-6,src-7'), 'the ids of the steps in use');
  assert.match(en, /Step 3[^\n]*skip/i);
  assert.match(en, new RegExp(MATTER_WORDS.index.en, 'i'));
  assert.ok(!en.includes('src-410'));
  // a step the learner switched off (not optional by nature) is skipped too, in words that say so
  const off = pathBrief({ steps: steps().map(step => step.id === 'step-2' ? { ...step, included: false } : step), course: '', goal: '', indexed: false, language: 'zh' });
  assert.match(off, /第 2 步[^\n]*跳过/);
});

test('English and Chinese carry the same things; the English brief has no Han at all', () => {
  const zh = brief('zh'), en = brief('en');
  for (const token of ['source.list', 'job.status', 'generate', 'source.search', String(CALL_PAGES), String(CALL_QUESTIONS), book, 'step-1'.replace('step-1', 'src-6')])
    for (const [name, text] of [['zh', zh], ['en', en]]) assert.ok(text.includes(token), `${name} brief is missing ${token}`);
  assert.doesNotMatch(en, /[㐀-鿿]/);
  assert.match(en, /Do not generate anything until I confirm/);
  assert.match(zh, /确认之前不要生成/);
});

test('the words for the kinds of matter are the ones the English locale carries (the panel shows them through the locale)', () => {
  const dir = new URL('../ui/locales/', import.meta.url);
  const locale = Object.assign({}, ...readdirSync(dir).filter(name => /^en.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'))));
  for (const [kind, words] of Object.entries(MATTER_WORDS)) assert.equal(locale[words.zh], words.en, `locale entry for ${kind}`);
});

test('a long plan still keeps the brief short', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `step-${i + 1}`, order: i + 1, title: `第 ${i + 1} 章`, sourceIds: Array.from({ length: 20 }, (_, k) => `src-${i}-${k}`), pages: 20, chars: 100_000, count: 10, focus: '',
    ranges: [{ document: book, from: i * 20 + 1, to: i * 20 + 20 }] }));
  const text = pathBrief({ steps: many, course: 'C', goal: '', indexed: true, language: 'zh' });
  assert.ok(text.length < 12_000, `${text.length} chars`);
  assert.match(text, /source\.list/);
});
