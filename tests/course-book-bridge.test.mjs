/* 复习全书: plain, learner-first explanations (the readability rules of the notes prompt) and the transitions (过渡句) between the points of a chapter: a cheap
   call per at most 12 points, after the explanations, keyed by the titles and summaries of a point and its neighbours, so a changed point rewrites only the
   transitions around it and never an explanation. Shown in the book's files (preview and export) and on the 总纲 page as plain italic lines. A fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { genText } from '../lib/course-book-files.js';
import { notesPrompt, bridgePrompt } from '../lib/contexts/generation/book/prompts.js';
import { summaryOf } from '../lib/contexts/generation/book/work.js';

const COURSE = 'Bridges', N = 15;
const name = i => `Topic ${String(i).padStart(2, '0')}`;
const material = (i, text = `${name(i)} fact: the idea number ${i} builds on the one before it.`) => ({ id: `t${i}`, title: name(i), text, createdAt: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
  courses: [COURSE], document: { materialId: `document-t${i}`, format: 'md', filename: `${name(i)}.md` } });

async function world(t) {
  const fake = bookModel({ takeaway: true });
  const root = await privateRoot(t, 'course-book-bridge-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...Array.from({ length: N }, (_, at) => material(at + 1))); state.focus = { mode: 'class', course: COURSE }; });
  const finish = async () => {
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh' })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(job.error ?? null));
    return (await service.store.read()).sources.find(record => isCourseNotesSource(record) && !record.archived);
  };
  return { service, fake, finish };
}
const byTitle = record => Object.fromEntries(record.courseNotes.leaves.map(leaf => [leaf.title, leaf]));

test('the notes prompt asks for plain, learner-first writing and keeps the verified-quote rule and 补充', () => {
  const item = { title: 'Threat modelling', path: ['Security'], evidence: [{ quote: 'Q1' }], shown: [{ material: 'L6', text: 'Threat modelling finds what can go wrong.' }] };
  const zh = notesPrompt({ number: 1, items: [item] }, { language: 'zh' }), en = notesPrompt({ number: 1, items: [item] }, { language: 'en' });
  for (const rule of ['"explain" starts with 「一句话：」 and ONE sentence in everyday words', 'Short sentences, one idea each',
    'written once as 中文（English）, e.g. 威胁建模（threat modelling）; after that use ONE form of it throughout', 'An example only when the materials have one; never invent one.',
    'For a point marked "tested": true, say in one sentence why it matters for the exam', 'never 「原文说……意思就是……」', 'never 「重点在于」「需要注意」「非常重要」 without saying exactly what and why',
    'copied character for character from that material', 'Never invent a quote', 'goes ONLY into "extra"']) assert.ok(zh.prompt.includes(rule), rule);
  assert.match(zh.prompt, /"tested":true/, 'a point the papers test says so');
  assert.match(en.prompt, /"explain" starts with "In one sentence:"/);
  assert.doesNotMatch(en.prompt, /一句话|重点在于/, 'the English rules name English words');
  const bridge = bridgePrompt({ number: 1, chapter: 'Security', items: [{ title: 'A', summary: 'a.', after: { title: 'B', summary: 'b.' } }] }, { language: 'zh' });
  assert.match(bridge.prompt, /"in": ONE sentence leading into this point/);
  assert.match(bridge.prompt, /"wrap" is ONE sentence that wraps up/);
  assert.match(bridge.prompt, /never add a fact the summaries do not give/);
  assert.equal(summaryOf({ explain: '一句话：威胁建模就是提前想清楚哪里会出事 [^1]。然后……', points: [] }), '威胁建模就是提前想清楚哪里会出事。');
  assert.equal(summaryOf({ explain: '', points: [], parts: [{ explain: 'First part. More.', points: [] }] }), 'First part.');
});

test('the transitions: one call per at most 12 points of a chapter, after the explanations; in from the one before, out to the next, the chapter\'s wrap-up last', async t => {
  const w = await world(t);
  const record = await w.finish();
  const bridges = w.fake.of('bridge');
  assert.deepEqual(bridges.map(call => call.data.points.length), [12, 3], '15 points of one chapter: two calls');
  assert.ok(w.fake.stages().lastIndexOf('notes') < w.fake.stages().indexOf('bridge'), 'after the explanations');
  const leaves = byTitle(record), first = leaves[name(1)].bridge, middle = leaves[name(7)].bridge, last = leaves[name(N)].bridge;
  assert.deepEqual(first, { fingerprint: first.fingerprint, in: `Everything opens with ${name(1)}.`, out: `That leads on to ${name(2)}.` });
  assert.deepEqual([middle.in, middle.out, middle.wrap], [`After ${name(6)} comes ${name(7)}.`, `That leads on to ${name(8)}.`, undefined]);
  assert.deepEqual([last.out, last.wrap], [undefined, 'That closes Everything.'], 'the last point closes the chapter');
  assert.equal(bridges[0].data.points[1].before.summary, `${name(1)} fact: the idea number 1 builds on the one before。`, 'the neighbour\'s one-line summary (its 一句话)');
  // Shown: the book's file of a point (preview and export) and the 总纲 page, as plain italic lines around the point.
  const book = await w.service.call('course.book.open', { course: COURSE });
  const leafNodes = list => list.flatMap(node => (node.leaf ? [node] : leafNodes(node.children)));
  const seventh = leafNodes(book.nodes).find(node => node.title === name(7));
  assert.match(seventh.gen, new RegExp(`^\\*After ${name(6)} comes ${name(7)}\\.\\*\\n\\n\\*\\*知识梳理\\*\\*`));
  assert.match(seventh.gen, new RegExp(`\\*That leads on to ${name(8)}\\.\\*\\n\\n\\*\\*出处\\*\\*`));
  const exported = (await w.service.call('course.book.export', {})).text;
  assert.match(exported, new RegExp(`\\*After ${name(6)} comes ${name(7)}\\.\\*`));
  assert.match(exported, /\*That closes Everything\.\*/);
  const points = list => list.flatMap(node => (node.children ? points(node.children) : [node]));
  const key = points((await w.service.call('course.outline', { course: COURSE })).book.nodes).find(node => node.title === name(7)).key;
  const opened = (await w.service.call('course.outline', { course: COURSE, expand: [key] })).open[key].notes;
  assert.deepEqual(opened.bridge, { in: middle.in, out: middle.out });
  // Again: nothing changed, nothing asked.
  const mark = w.fake.calls.length;
  await w.finish();
  assert.equal(w.fake.calls.length, mark);
});

test('a point that changed rewrites only the transitions of it and its two neighbours; no explanation is rewritten for them', async t => {
  const w = await world(t);
  const old = await w.finish();
  await w.service.store.update(state => { state.sources.find(source => source.id === 't7').text = `${name(7)} changed: a new way to see the seventh idea.`; });
  const mark = w.fake.calls.length;
  const fresh = await w.finish();
  const calls = w.fake.calls.slice(mark);
  assert.deepEqual(calls.filter(call => call.stage === 'notes').map(call => call.data.leaves.map(leaf => leaf.title)), [[name(7)]], 'one explanation: the changed point');
  assert.deepEqual(calls.filter(call => call.stage === 'bridge').map(call => call.data.points.map(point => point.title)), [[name(6), name(7), name(8)]],
    'one bridges call: the point and its two neighbours');
  const was = byTitle(old), now = byTitle(fresh);
  for (let i = 1; i <= N; i++) {
    if (i !== 7) assert.equal(JSON.stringify(now[name(i)].body), JSON.stringify(was[name(i)].body), `${name(i)}: its explanation byte for byte`);
    if (i < 6 || i > 8) assert.equal(JSON.stringify(now[name(i)].bridge), JSON.stringify(was[name(i)].bridge), `${name(i)}: its transitions kept`);
  }
  assert.notEqual(now[name(6)].bridge.fingerprint, was[name(6)].bridge.fingerprint);
});

test('notes written before transitions existed render as before: no italic line, no empty marker', () => {
  const body = { fingerprint: '0123456789abcdef', points: ['A point [^1]'], explain: 'Why it matters [^1].', cites: [{ n: 1, sourceId: 's1', quote: 'the quote', title: 'S1' }] };
  const text = genText({ notes: { id: 'n1', body }, hid: 'h1', title: 'Point', language: 'zh' });
  assert.doesNotMatch(text, /^\*[^*]/m, 'no transition line');
  assert.match(text, /^\*\*知识梳理\*\*/);
  const bridged = genText({ notes: { id: 'n1', body, bridge: { in: 'From the last one.', wrap: 'That closes the chapter.' } }, hid: 'h1', title: 'Point', language: 'en' });
  assert.match(bridged, /^\*From the last one\.\*\n\n\*\*Key points\*\*/);
  assert.match(bridged, /\*That closes the chapter\.\*\n\n\*\*Sources\*\*/);
});
