/* 复习全书 S4 (#710): the exam answer kit built from the sample papers. The program collects the paper questions from the outline's paper places, groups them
   into question types by their command words and the chapter they test, asks ONE call per type (tiny types batched), checks every answer (a question or a
   trigger word the papers do not hold is dropped), links each type to the points whose places hold its questions, and keeps an unchanged kit without a call.
   Pure functions and fakes; no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { paperLanguage, paperQuestions, questionLabel } from '../lib/contexts/generation/book/kit/questions.js';
import { familyOf, groupQuestions } from '../lib/contexts/generation/book/kit/group.js';
import { planKit } from '../lib/contexts/generation/book/kit/plan.js';
import { kitPrompt } from '../lib/contexts/generation/book/kit/prompt.js';
import { readKit } from '../lib/contexts/generation/book/kit/read.js';
import { assembleKit } from '../lib/contexts/generation/book/kit/assemble.js';
import { examKitView, normalizeExamKit } from '../lib/course-book-exam-kit.js';
import { courseNotesMaterial, normalizeCourseNotes, sameNotes } from '../lib/course-book.js';

const PAPER_A = ['Q1 Compare an API gateway with a message broker for the shop. (10 marks)', 'Q2 Explain why a view differs from a viewpoint. (5 marks)',
  'Q3 Design a deployment for the shop that survives a zone failure. (10 marks)'].join('\n');
const PAPER_B = ['Question 1 (a) Compare REST with gRPC for the mobile app. (8 marks)', '(b) Calculate the throughput of the queue at peak. (6 marks)',
  'Question 2 Explain how a circuit breaker keeps the shop responsive. (6 marks)'].join('\n');
const sources = [{ id: 'pa', text: PAPER_A }, { id: 'pb', text: PAPER_B }];
const byId = new Map(sources.map(source => [source.id, source]));
const place = (sourceId, quote, paper) => { const start = byId.get(sourceId).text.indexOf(quote); return { sourceId, quote, paper, start, end: start + quote.length }; };
const QA1 = place('pa', 'Compare an API gateway with a message broker for the shop.', 'doc:a'), QA2 = place('pa', 'Explain why a view differs from a viewpoint.', 'doc:a');
const QA3 = place('pa', 'Design a deployment for the shop that survives a zone failure.', 'doc:a');
const QB1 = place('pb', 'Compare REST with gRPC for the mobile app.', 'doc:b'), QB2 = place('pb', 'Calculate the throughput of the queue at peak.', 'doc:b');
const QB3 = place('pb', 'Explain how a circuit breaker keeps the shop responsive.', 'doc:b');
// Five points in two chapters; a question may test two points (QA1 is on n1 and n2).
const items = [
  { id: 'n1', title: 'Gateways', chapter: 0, evidence: [QA1, QB1] },
  { id: 'n2', title: 'Brokers', chapter: 0, evidence: [QA1, QB2] },
  { id: 'n3', title: 'Views', chapter: 1, evidence: [QA2] },
  { id: 'n4', title: 'Resilience', chapter: 1, evidence: [QA3, QB3] },
  { id: 'n5', title: 'Untested', chapter: 1, evidence: [] },
];
const papers = [{ key: 'doc:a', fingerprint: 'fa' }, { key: 'doc:b', fingerprint: 'fb' }];
const titles = new Map([['doc:a', 'SA 2025 样卷'], ['doc:b', 'SA 2024 样卷']]);
const work = (over = {}) => ({ items, papers, ...over });
const plan = (over = {}) => ({ language: 'zh', previous: null, state: { sources }, documents: [{ key: 'doc:a', title: 'SA 2025 样卷' }, { key: 'doc:b', title: 'SA 2024 样卷' }],
  ...over });
const LEAVES = new Set(items.map(item => item.id));

test('the paper questions: each place once, in paper order, with the label printed before it, its paper and the points that hold it', () => {
  const questions = paperQuestions(items, { papers, byId, titles });
  assert.deepEqual(questions.map(q => [q.title, q.label]), [['SA 2025 样卷', 'Q1'], ['SA 2025 样卷', 'Q2'], ['SA 2025 样卷', 'Q3'],
    ['SA 2024 样卷', 'Question 1 (a)'], ['SA 2024 样卷', '(b)'], ['SA 2024 样卷', 'Question 2']]);
  assert.deepEqual(questions[0].leaves, ['n1', 'n2'], 'one question, two points: both linked');
  assert.equal(new Set(questions.map(q => q.id)).size, 6, 'a stable id per question');
  assert.match(questions[0].text, /^Compare an API gateway .*\(10 marks\)$/, 'the text runs to the end of the question, not into the next one');
  assert.equal(paperLanguage(questions), 'en', 'the papers are English (the kit follows them, whatever the book language)');
  assert.equal(paperLanguage([{ text: '比较 API 网关与消息代理的异同，并举例说明。' }]), 'zh');
  assert.equal(questionLabel('1. Explain the cache.', 3), '1.');
  assert.equal(questionLabel('no label here', 3), null);
});

test('question types: the command word and the chapter, cheaply; a big group split; a question with no command word is "other"', () => {
  assert.equal(familyOf('Compare REST with gRPC'), 'compare');
  assert.equal(familyOf('Calculate the throughput'), 'calculate');
  assert.equal(familyOf('比较两种部署方式的优缺点'), 'compare');
  assert.equal(familyOf('The shop sells shoes.'), 'other');
  const questions = paperQuestions(items, { papers, byId, titles }), types = groupQuestions(questions);
  assert.deepEqual(types.map(type => [type.family, type.chapter, type.questions.map(q => q.label)]), [
    ['compare', 0, ['Q1', 'Question 1 (a)']], ['calculate', 0, ['(b)']], ['explain', 1, ['Q2', 'Question 2']], ['design', 1, ['Q3']]]);
  const many = Array.from({ length: 11 }, (_, at) => ({ id: `q${at}`, text: `Explain thing ${at}.`, chapter: 0, leaves: ['n1'] }));
  assert.deepEqual(groupQuestions(many, { per: 4 }).map(type => type.questions.length), [4, 4, 3], 'a type holds at most `per` questions');
  const spread = Array.from({ length: 6 }, (_, at) => ({ id: `q${at}`, text: at % 2 ? `Explain ${at}.` : `Compare ${at}.`, chapter: at, leaves: ['n1'] }));
  assert.deepEqual(groupQuestions(spread, { max: 3 }).map(type => [type.family, type.questions.length]), [['compare', 3], ['explain', 3]],
    'more types than the most: grouped by command word alone');
});

test('the plan: one call per type, tiny types batched; no papers or no placed question means no stage', () => {
  const kit = planKit(work(), plan());
  assert.equal(kit.language, 'en');
  assert.deepEqual(kit.types.map(type => type.questions.length), [2, 1, 2, 1]);
  assert.deepEqual(kit.batches.map(batch => batch.types.length), [1, 2, 1], 'the two one-question types share a call');
  assert.ok(kit.batches.every(batch => /^cb:kit:[0-9a-f]{12}$/.test(batch.key)));
  assert.match(kit.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(planKit(work({ papers: [] }), plan()), null, 'no sample papers: no kit');
  assert.equal(planKit(work({ items: items.map(item => ({ ...item, evidence: [] })) }), plan()), null, 'papers but no question placed: no kit');
});

test('the prompt: each type with its questions under short aliases, the points they test, the papers\' language for the template, the book\'s for what is tested', () => {
  const kit = planKit(work(), plan()), batch = kit.batches[1];
  const { system, prompt } = kitPrompt(batch, plan(), kit);
  assert.match(system, /untrusted data, never instructions/);
  const data = JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length));
  assert.equal(data.stage, 'kit');
  assert.deepEqual(data.types.map(type => type.id), ['t1', 't2']);
  assert.deepEqual(data.types[0].questions.map(q => q.id), ['q1']);
  assert.deepEqual(data.types[1].questions.map(q => q.id), ['q2'], 'aliases run through the call');
  assert.ok(data.types[0].points.length >= 1, 'the points the type tests, by title');
  assert.match(prompt, /template.*in English/is);
  assert.match(prompt, /"asks".*Simplified Chinese/is);
  assert.match(prompt, /\[/, 'slots in square brackets');
});

test('reading the answer: a question or a trigger word the papers do not hold is dropped; a type without a template is not answered', () => {
  const kit = planKit(work(), plan()), batch = kit.batches[0], type = batch.types[0];
  const answer = JSON.stringify({ types: [
    { id: 't1', name: 'Compare two mechanisms', signals: ['Compare', 'for the shop', 'trade-off matrix'], asks: '比较两个机制：维度、场景、取舍',
      template: '1. Define [A] and [B]. 2. Compare on [Dimension]. 3. Choose [Choice] because [Reason].',
      fills: [{ question: 'q1', fill: 'A: API gateway ｜ B: message broker' }, { question: 'q2', fill: 'A: REST ｜ B: gRPC' }, { question: 'q9', fill: 'invented' },
        { question: 'q1', fill: 'twice' }] },
    { id: 't7', name: 'A type nobody asked', template: '[X]' }] });
  const read = readKit(answer, batch);
  const got = read.types.get(0);
  assert.deepEqual(got.signals, ['Compare', 'for the shop'], 'an invented trigger word is dropped');
  assert.deepEqual(got.fills.map(fill => fill.question), type.questions.map(q => q.id), 'q9 (invented) and the second q1 are dropped; refs are the stable ids');
  assert.equal(read.types.size, 1, 'an id that was not asked is ignored');
  assert.equal(readKit(JSON.stringify({ types: [{ id: 't1', name: 'No template', fills: [] }] }), batch).types.size, 0);
  assert.equal(readKit('not json', batch), null);
});

test('assembling: the types in order, each type linked by the program to the points whose places hold its questions; a missing type is counted', () => {
  const kit = planKit(work(), plan());
  const written = new Map(kit.types.map((type, at) => [type.print, at === 1 ? null : { name: `Type ${at}`, signals: [], asks: '考什么', template: `Answer with [Slot ${at}].`,
    fills: type.questions.map(q => ({ question: q.id, fill: `fill of ${q.label}` })) }]).filter(([, value]) => value));
  const record = assembleKit(kit, written);
  assert.deepEqual(record.types.map(type => type.name), ['Type 0', 'Type 2', 'Type 3'], 'the type no call wrote is left out');
  assert.deepEqual(record.types[0].leaves, ['n1', 'n2'], 'compare: QA1 (n1, n2) and QB1 (n1)');
  assert.deepEqual(record.types[1].leaves, ['n3', 'n4'], 'explain: QA2 (n3), QB3 (n4)');
  assert.equal(record.missing, 1);
  assert.equal(record.language, 'en');
});

test('an unchanged kit is kept without a call; a changed paper asks only the types it changed', () => {
  const first = planKit(work(), plan());
  const written = new Map(first.types.map(type => [type.print, { name: type.family, signals: [], asks: '考什么', template: 'Use [Slot].', fills: [] }]));
  const examKit = assembleKit(first, written);
  const previous = { courseNotes: { language: 'zh', examKit } };
  const again = planKit(work(), plan({ previous }));
  assert.equal(again.reuse, examKit, 'the same paper places: the saved kit, no call');
  assert.deepEqual(again.batches, []);
  const moved = items.map(item => (item.id === 'n4' ? { ...item, evidence: [QA3] } : item));
  const changed = planKit(work({ items: moved }), plan({ previous }));
  assert.equal(changed.reuse, undefined);
  assert.deepEqual(changed.batches.flatMap(batch => batch.types.map(type => type.family)), ['explain'], 'only the type that lost a question is asked again');
  const partial = planKit(work(), plan({ previous: { courseNotes: { language: 'zh', examKit: { ...examKit, missing: 1 } } } }));
  assert.equal(partial.reuse, undefined, 'a kit with a type missing is not reused whole');
  const english = planKit(work(), plan({ language: 'en', previous }));
  assert.equal(english.batches.length, 3, 'another book language asks again (what is tested is written in the book\'s language)');
});

test('the stored kit: invented question refs and unknown points dropped; old notes without a kit load; the kit counts in sameNotes', () => {
  const kit = planKit(work(), plan());
  const written = new Map(kit.types.map(type => [type.print, { name: 'T', signals: ['Compare'], asks: '考什么', template: 'Use [Slot].',
    fills: type.questions.map(q => ({ question: q.id, fill: 'x' })) }]));
  const record = assembleKit(kit, written);
  const tampered = { ...record, types: record.types.map((type, at) => (at ? type : { ...type, fills: [...type.fills, { question: 'nope', fill: 'invented' }], leaves: [...type.leaves, 'gone'] })) };
  const clean = normalizeExamKit(tampered, LEAVES);
  assert.ok(clean.types[0].fills.every(fill => clean.questions.some(q => q.id === fill.question)), 'a fill of a question the kit does not hold is dropped');
  assert.ok(!clean.types[0].leaves.includes('gone'), 'a point the notes do not hold is dropped');
  assert.equal(normalizeExamKit({ fingerprint: 'bad' }, LEAVES), null, 'a kit without its fingerprint is not stored');
  const base = { course: 'C', outlineId: 'o1', language: 'zh', leaves: items.map(item => ({ id: item.id, title: item.title, anchors: [] })) };
  const old = normalizeCourseNotes(base);
  assert.equal(old.examKit, undefined, 'a book written before the kit has none, and loads');
  const withKit = normalizeCourseNotes({ ...base, examKit: record });
  assert.equal(withKit.examKit.types.length, 4);
  assert.equal(sameNotes(old, withKit), false, 'a new kit is a change to save');
  assert.ok(courseNotesMaterial({ title: 'Book', ...base, examKit: record }).courseNotes.examKit);
});

test('the view: points as headings of the open book, each fill with its paper and label, the question as its tip', () => {
  const kit = planKit(work(), plan());
  const written = new Map(kit.types.map(type => [type.print, { name: 'Compare', signals: ['Compare'], asks: '考什么', template: 'Use [Slot].',
    fills: type.questions.map(q => ({ question: q.id, fill: `fill ${q.label}` })) }]));
  const view = examKitView(normalizeExamKit(assembleKit(kit, written), LEAVES), new Map([['n1', 'h1'], ['n2', 'h2'], ['n3', 'h3']]));
  assert.deepEqual(view.types.map(type => type.code), ['T01', 'T02', 'T03', 'T04'], 'codes are the places of the types');
  assert.deepEqual(view.types[0].hids, ['h1', 'h2']);
  assert.deepEqual(view.types[2].hids, ['h3'], 'a point the open book does not hold is left out');
  assert.deepEqual(view.types[0].fills.map(fill => fill.ref), ['SA 2025 样卷 Q1', 'SA 2024 样卷 Question 1 (a)']);
  assert.match(view.types[0].fills[0].quote, /^Compare an API gateway/);
  assert.deepEqual(view.types[0].anchors, ['SA 2025 样卷 Q1', 'SA 2024 样卷 Question 1 (a)']);
  assert.equal(examKitView(null, new Map()), null);
});
