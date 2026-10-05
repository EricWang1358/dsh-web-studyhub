import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chunkSources, planGeneration } from '../lib/batch.js';
import { partPlanOf, partPlanText, readPartPlan, PART_PLAN_RANGES, PART_PLAN_LABEL } from '../lib/part-plan.js';
import { sectionsOf, sliceRangeOf, sectionAtOffset } from '../lib/sections.js';
import { jobContract } from '../lib/job-contract.js';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

// What each part of a run covers, as ranges of the sources it was cut from (lib/batch.js slices) and as a label made from the sections those ranges are in
// (lib/sections.js): 「录音 2 · 第 1–5 部分」, 「第 12–14 页」, 「§2.1–2.3」. The 任务 console's 资料部分 shows them and 在资料中查看 opens the first one.

const world = mergedTranscript();

test('a long source is sliced into pieces that remember where in the stored text they were cut, without changing what the pieces look like', () => {
  const text = ('一个段落写得足够长。'.repeat(30) + '\n\n').repeat(900);
  const [source] = [{ id: 'long', title: 'Long', text }];
  const pieces = chunkSources([source]).flat();
  assert.ok(pieces.length > 3);
  let at = 0;
  for (const piece of pieces) {
    const { start, end } = sliceRangeOf(piece);
    assert.equal(start, at, 'the pieces follow one another');
    assert.equal(text.slice(start, end), piece.text, 'every piece is exactly the stored text between its offsets');
    at = end;
  }
  assert.equal(at, text.length);
  // A piece is the source's own fields with the text cut: nothing new is enumerable, so prompts and JSON that carry it are unchanged.
  assert.deepEqual(Object.keys(pieces[0]).sort(), ['id', 'text', 'title']);
  assert.equal(JSON.stringify(pieces[1]), JSON.stringify({ id: 'long', title: 'Long', text: pieces[1].text }));
  assert.deepEqual(chunkSources([{ id: 'short', text: 'tiny' }]).flat().map(piece => sliceRangeOf(piece)), [{ start: 0, end: 4 }]);
  assert.deepEqual(sliceRangeOf({ text: 'whole' }), { start: 0, end: 5 }, 'a source that was never cut is whole');
});

test('slices of the merged transcript: each part of the plan covers a range, and the ranges of a source never overlap', () => {
  const planned = planGeneration({ sources: world.sources, count: 24, kind: 'quiz', performance: { batchSize: 5 } });
  assert.ok(planned.length >= 5);
  const plan = partPlanOf(planned, partPlanText('zh'), { sections: sectionsOf(world.sources) });
  assert.equal(plan.length, planned.length);
  const seen = new Map();
  for (const entry of plan) {
    assert.ok(entry.ranges.length >= 1 && entry.ranges.length <= PART_PLAN_RANGES);
    for (const range of entry.ranges) {
      const source = world.sources.find(item => item.id === range.sourceId);
      assert.ok(source && Number.isInteger(range.start) && range.end > range.start && range.end <= source.text.length);
    }
  }
  // Parts that share one group of pages split it: every offset is claimed by the parts of its group, and each group's ranges are disjoint.
  const groups = new Map();
  planned.forEach((part, index) => { const key = part.sources.map(piece => `${piece.id}:${sliceRangeOf(piece).start}`).join('|'); if (!groups.has(key)) groups.set(key, plan[index].ranges); else assert.deepEqual(plan[index].ranges, groups.get(key)); });
  for (const ranges of groups.values()) for (const range of ranges) {
    const taken = seen.get(range.sourceId) || [];
    assert.ok(taken.every(other => range.end <= other.start || range.start >= other.end), 'groups do not overlap');
    taken.push(range); seen.set(range.sourceId, taken);
  }
});

test('the label of a part of a merged transcript names the recording and the parts, so every row says something different', () => {
  const planned = planGeneration({ sources: world.sources, count: 24, kind: 'quiz', performance: { batchSize: 5 } });
  const zh = partPlanOf(planned, partPlanText('zh'), { sections: sectionsOf(world.sources) }), en = partPlanOf(planned, partPlanText('en'), { sections: sectionsOf(world.sources) });
  for (const entry of zh) assert.match(entry.label, /^录音 \d+ · 第 \d+(–\d+)? 部分(、录音 \d+ · 第 \d+(–\d+)? 部分)*$/, entry.label);
  for (const entry of en) assert.match(entry.label, /^Recording \d+ · parts? \d+(–\d+)?(, Recording \d+ · parts? \d+(–\d+)?)*$/, entry.label);
  assert.ok(new Set(zh.map(entry => entry.label)).size >= zh.length - 2, 'the parts of a long run are told apart');
  assert.ok(zh.every(entry => entry.label.length <= PART_PLAN_LABEL));
  // The first part starts at the first part of the first recording.
  assert.match(zh[0].label, /^录音 1 · 第 1/);
});

test('a range that ends inside a part names that part for the piece that holds most of it', () => {
  const sections = sectionsOf(world.sources), first = sections.filter(section => section.sourceId === 'audio-batch-vol1' && section.kind === 'part');
  const third = first.find(section => section.part === 3 && section.recording === 1), fourth = first.find(section => section.part === 4 && section.recording === 1);
  const middle = Math.floor((third.start + third.end) / 2);
  const piece = (start, end) => Object.defineProperty({ id: 'audio-batch-vol1', title: 't', text: world.sources[0].text.slice(start, end) }, 'sliceRange', { value: { start, end } });
  const label = (...pieces) => partPlanOf([{ sources: pieces, count: 2 }], partPlanText('zh'), { sections })[0].label;
  assert.equal(label(piece(0, third.start + 5)), '录音 1 · 第 1–2 部分', 'a few characters of part 3 do not make it part of the range');
  assert.equal(label(piece(third.start, fourth.end)), '录音 1 · 第 3–4 部分');
  assert.equal(label(piece(middle, fourth.end)), '录音 1 · 第 3–4 部分', 'half of part 3 is enough');
});

test('pages keep their book and page label; a part of a document with no sections is named as before', () => {
  const page = (id, number) => ({ id, title: `Networks · 第 ${number} 页`, text: `page ${number} `.repeat(20), document: { page: number, bookTitle: 'Networks', format: 'pdf' } });
  const pages = [page('p1', 12), page('p2', 13), page('p3', 14)];
  assert.equal(partPlanOf([{ sources: pages, count: 3 }], partPlanText('zh'), { sections: sectionsOf(pages) })[0].label, 'Networks · 第 12–14 页');
  assert.equal(partPlanOf([{ sources: pages, count: 3 }], partPlanText('en'), { sections: sectionsOf(pages) })[0].label, 'Networks · pp. 12–14');
  assert.equal(partPlanOf([{ sources: [{ id: 'n', title: 'Notes', text: 'x' }], count: 1 }], partPlanText('zh'))[0].label, 'Notes');
  assert.equal(partPlanOf([{ sources: pages, count: 3 }], partPlanText('zh'), { sections: sectionsOf(pages) })[0].ranges.length, 3, 'a page is a range of its own source');
});

test('Markdown headings: §2.1–2.3 when the headings are numbered, their titles when they are not', () => {
  const numbered = ['# 手册', '', ...['1 安装', '2.1 配置', '2.2 运行', '2.3 排错', '3 附录'].flatMap(title => [`## ${title}`, '', `${title} 的正文。`.repeat(40), ''])].join('\n');
  const source = { id: 'md', title: 'Manual', text: numbered }, sections = sectionsOf(source);
  const at = title => sections.find(section => section.title === title);
  const piece = (from, to) => Object.defineProperty({ ...source, text: numbered.slice(at(from).start, at(to).end) }, 'sliceRange', { value: { start: at(from).start, end: at(to).end } });
  assert.equal(partPlanOf([{ sources: [piece('2.1 配置', '2.3 排错')], count: 3 }], partPlanText('zh'), { sections })[0].label, '§2.1–2.3');
  assert.equal(partPlanOf([{ sources: [piece('2.2 运行', '2.2 运行')], count: 3 }], partPlanText('en'), { sections })[0].label, '§2.2');
  const plain = ['# 手册', ...['概述', '安装', '运行'].flatMap(title => ['', `## ${title}`, '', '正文。'.repeat(40)])].join('\n');
  const named = { id: 'pl', title: 'Plain', text: plain }, list = sectionsOf(named);
  const cut = Object.defineProperty({ ...named, text: plain.slice(list[1].start, list[3].end) }, 'sliceRange', { value: { start: list[1].start, end: list[3].end } });
  assert.equal(partPlanOf([{ sources: [cut], count: 2 }], partPlanText('zh'), { sections: list })[0].label, '「概述」–「运行」');
});

test('text with no structure: windows are named by their number', () => {
  const text = ('这是一个段落，写得足够长以便切分。'.repeat(20) + '\n\n').repeat(160), source = { id: 'w', title: 'Notes', text }, sections = sectionsOf(source);
  const piece = (from, to) => Object.defineProperty({ ...source, text: text.slice(sections[from].start, sections[to].end) }, 'sliceRange', { value: { start: sections[from].start, end: sections[to].end } });
  assert.equal(partPlanOf([{ sources: [piece(2, 4)], count: 3 }], partPlanText('zh'), { sections })[0].label, '第 3–5 段');
  assert.equal(partPlanOf([{ sources: [piece(0, 0)], count: 3 }], partPlanText('en'), { sections })[0].label, 'segment 1');
});

test('several documents in one part are named, one document is not', () => {
  const a = { id: 'a', title: 'Week 1 notes.md', text: '# A\n\n## 1 x\n\n' + 'x'.repeat(100) + '\n\n## 2 y\n\n' + 'y'.repeat(100) }, b = { id: 'b', title: 'Week 2 notes.md', text: '# B\n\n## 1 x\n\n' + 'x'.repeat(100) + '\n\n## 2 y\n\ny' };
  const sections = sectionsOf([a, b]);
  const [entry] = partPlanOf([{ sources: [a, b], count: 2 }], partPlanText('zh'), { sections });
  assert.match(entry.label, /Week 1 notes\.md · §1–2、Week 2 notes\.md · §1–2/);
});

test('what is kept stays small: ranges are merged when they touch and at most PART_PLAN_RANGES are kept', () => {
  const text = 'word '.repeat(60000), source = { id: 'big', title: 'Big', text };
  const pieces = chunkSources([source], 6000).flat();
  const [one] = partPlanOf([{ sources: pieces.slice(0, 5), count: 5 }], partPlanText('zh'));
  assert.deepEqual(one.ranges, [{ sourceId: 'big', start: 0, end: pieces[4] && sliceRangeOf(pieces[4]).end }], 'touching pieces are one range');
  const apart = Array.from({ length: 60 }, (_, index) => Object.defineProperty({ id: `s${index}`, title: `S${index}`, text: 'x' }, 'sliceRange', { value: { start: 0, end: 1 } }));
  const [many] = partPlanOf([{ sources: apart, count: 5 }], partPlanText('zh'));
  assert.equal(many.ranges.length, PART_PLAN_RANGES);
  assert.ok(many.label.length <= PART_PLAN_LABEL);
  assert.ok(JSON.stringify(many).length < 4000, 'a part of the persisted plan is small');
});

/* ---------- the plan on the job, and what reads it ---------- */

test('readPartPlan keeps well-formed ranges only, bounded; a plan without ranges (an older run) is read as before', () => {
  const ranges = [{ sourceId: 'a', start: 0, end: 10 }, { sourceId: 'b', start: 5, end: 5 }, { sourceId: '', start: 0, end: 3 }, { start: 0, end: 3 }, { sourceId: 'c', start: -1, end: 3 }, { sourceId: 'd', start: 1.5, end: 3 }, null, 'x',
    ...Array.from({ length: 50 }, (_, index) => ({ sourceId: `s${index}`, start: 0, end: 1 }))];
  const read = readPartPlan([{ part: 1, sourceIds: ['a'], label: 'L', ranges }, { part: 2, sourceIds: ['a'], label: 'M' }, { part: 3, label: 'N', ranges: 'nope' }]);
  assert.equal(read.get(1).ranges[0].sourceId, 'a');
  assert.ok(read.get(1).ranges.every(range => range.end > range.start && range.start >= 0 && Number.isInteger(range.start) && typeof range.sourceId === 'string' && range.sourceId));
  assert.ok(read.get(1).ranges.length <= PART_PLAN_RANGES);
  assert.equal(read.get(2).ranges, undefined);
  assert.equal(read.get(3).ranges, undefined);
});

const generation = extra => ({ id: 'g', status: 'running', deckTitle: 'Deck', requestedTotal: 10, savedCount: 0, parts: 2, startedAt: '2026-10-05T10:00:00Z', steps: [], ...extra });

test('the job contract carries each part\'s ranges beside its label', () => {
  const list = jobContract(generation({ partPlan: [{ part: 1, sourceIds: ['v1'], sourceCount: 1, label: '录音 2 · 第 1–5 部分', ranges: [{ sourceId: 'v1', start: 10, end: 60000 }] }, { part: 2, sourceIds: ['v1'], sourceCount: 1, label: '录音 2 · 第 5–9 部分' }] })).detail.partList;
  assert.deepEqual(list[0].ranges, [{ sourceId: 'v1', start: 10, end: 60000 }]);
  assert.equal(list[0].range, '录音 2 · 第 1–5 部分');
  assert.equal(list[1].ranges, undefined);
});

/* ---------- 资料部分 on screen ---------- */

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as GenerationParts } from './ui/tasks/GenerationParts.jsx';
  export { partOpener } from './ui/tasks/task-actions.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const html = (element, { language = 'zh', app } = {}) => {
  m.setUiLanguage(language);
  try { return renderToStaticMarkup(inApp(m, element, { data: app?.data || {}, app })); } finally { m.setUiLanguage('zh'); }
};

test('the 资料部分 rows of a real plan over the merged transcript show a different range on every row', () => {
  const planned = planGeneration({ sources: world.sources, count: 24, kind: 'quiz', performance: { batchSize: 5 } });
  const partPlan = partPlanOf(planned, partPlanText('zh'), { sections: sectionsOf(world.sources) });
  const contract = jobContract(generation({ status: 'complete', parts: partPlan.length, partPlan, partReport: { summary: 's', parts: partPlan.map(entry => ({ part: entry.part, asked: 5, kept: 5, status: 'passed' })) } }));
  const app = { lib: { taskFocus: null }, host: {}, data: { sources: world.sources }, learn: { openAudioSources() {}, openSourceAt() {} } };
  const out = html(React.createElement(m.GenerationParts, { contract }), { app });
  const shown = [...out.matchAll(/class="tc-filerow__text tc-filerow__range">([^<]+)</g)].map(match => match[1]);
  assert.equal(shown.length, partPlan.length, 'every row has its range');
  assert.ok(new Set(shown).size >= shown.length - 2, `distinct ranges: ${shown.join(' | ')}`);
  assert.ok(shown.every(label => /^录音 \d+ · 第/.test(label)));
  assert.ok(!shown.some(label => /\(\d\/\d\)|merged/.test(label)), 'not the volume\'s title');
  const english = html(React.createElement(m.GenerationParts, { contract: jobContract(generation({ status: 'complete', parts: 1, partPlan: [{ ...partPlanOf(planned.slice(0, 1), partPlanText('en'), { sections: sectionsOf(world.sources) })[0] }] })) }), { language: 'en', app });
  assert.match(english, /Recording 1 · parts? 1/);
});

test('在资料中查看 opens the first range of the part at its section when the app can take a position, and the source as before when it cannot', () => {
  const calls = [];
  const part = { part: 2, sourceIds: ['v1', 'v2'], sourceCount: 2, ranges: [{ sourceId: 'v2', start: 120, end: 900 }, { sourceId: 'v1', start: 0, end: 10 }] };
  const base = { data: { sources: [{ id: 'v1' }, { id: 'v2' }] }, learn: { openAudioSources: ids => calls.push(['sources', ids]), openSourceAt: (id, at) => calls.push(['at', id, at]) } };
  const opener = m.partOpener(part, base);
  assert.equal(opener.available, true);
  assert.equal(opener.firstId, 'v2', 'the first range\'s source leads, not the first id');
  opener.run();
  assert.deepEqual(calls, [['at', 'v2', 120]]);
  calls.length = 0;
  m.partOpener(part, { ...base, learn: { openAudioSources: ids => calls.push(['sources', ids]) } }).run();
  assert.deepEqual(calls, [['sources', ['v2']]], 'an app that cannot take a position opens the source');
  calls.length = 0;
  m.partOpener({ ...part, ranges: undefined }, base).run();
  assert.deepEqual(calls, [['sources', ['v1']]], 'an older run has no ranges');
  calls.length = 0;
  const gone = m.partOpener(part, { ...base, data: { sources: [{ id: 'v1' }] } });
  gone.run();
  assert.deepEqual(calls, [['at', 'v1', 0]], 'the first range whose source is still there');
});

test('sectionAtOffset: the section of a source an offset is in, for the reader to open at', () => {
  const at = world.sources[0].text.indexOf('【第五部分：预览段落 5】') + 40;
  const found = sectionAtOffset(world.sources, 'audio-batch-vol1', at);
  assert.equal(found.kind, 'part');
  assert.equal(found.title, '第五部分：预览段落 5');
  assert.equal(found.sectionId, 'r1.p5');
  assert.equal(sectionAtOffset(world.sources, 'audio-batch-vol1', 0).kind, 'recording');
  assert.equal(sectionAtOffset(world.sources, 'missing', 3), null);
  assert.equal(sectionAtOffset([{ id: 'p', text: 'x', document: { page: 3 } }], 'p', 0).kind, 'page');
  assert.equal(sectionAtOffset([{ id: 'e', text: '' }], 'e', 0), null);
});

const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
test('a real run records the ranges and a label made from the sections of its source on the job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-part-ranges-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const fake = createFakeModel({ latencyMs: 5, usage: true });
  const service = new StudyService(root, { complete: (system, prompt, context = {}) => fake(system, prompt, context), coach: false, language: 'zh' });
  t.after(async () => {
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const body = 'Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others. ';
  const text = [1, 2, 3].map((n) => `【第${'一二三'[n - 1]}部分：主题${n}】\n[Part ${n}: Topic ${n}]\n\n【英文原句】\n${body.repeat(2)}\n\n【中文对照】\n微服务把系统拆成各自拥有数据的服务。`).join('\n\n---\n\n');
  const source = await service.call('source.add', { title: 'Lecture', text });
  const started = await service.call('generate', { sourceIds: [source.id], count: 4, kind: 'quiz', title: 'Ranges', concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS,
    performance: { concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS } });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.partPlan[0].label, '第 1–3 部分');
  assert.deepEqual(job.partPlan[0].ranges, [{ sourceId: source.id, start: 0, end: text.length }]);
  assert.deepEqual(jobContract(job).detail.partList[0].ranges, job.partPlan[0].ranges);
});

test('a part opens at the section its label names: a range that begins in the tail of the recording before opens at the recording it is named for', () => {
  const sections = sectionsOf(world.sources), list = sections.filter(section => section.sourceId === 'audio-batch-vol1');
  const second = list.find(section => section.kind === 'part' && section.recording === 2 && section.part === 1), third = list.find(section => section.kind === 'part' && section.recording === 2 && section.part === 3);
  const start = second.start - 120, end = third.end;
  const piece = Object.defineProperty({ id: 'audio-batch-vol1', title: 't', text: world.sources[0].text.slice(start, end) }, 'sliceRange', { value: { start, end } });
  const [entry] = partPlanOf([{ sources: [piece], count: 2 }], partPlanText('zh'), { sections });
  assert.equal(entry.label, '录音 2 · 第 1–3 部分');
  assert.deepEqual(entry.ranges, [{ sourceId: 'audio-batch-vol1', start, end }], 'the range is exactly what was cut');
  assert.deepEqual(entry.open, { sourceId: 'audio-batch-vol1', start: second.start }, 'the reader opens at the heading of the first part named');
  assert.equal(sectionAtOffset(world.sources, entry.open.sourceId, entry.open.start).sectionId, 'r2.p1');
  const read = readPartPlan([{ part: 1, sourceIds: ['a'], label: 'L', open: entry.open }, { part: 2, sourceIds: ['a'], label: 'L', open: { sourceId: 'a', start: -4 } }, { part: 3, sourceIds: ['a'], label: 'L', open: 'x' }]);
  assert.deepEqual(read.get(1).open, entry.open);
  assert.equal(read.get(2).open, undefined);
  assert.equal(read.get(3).open, undefined);
  const calls = [];
  const app = { data: { sources: [{ id: 'audio-batch-vol1' }] }, learn: { openAudioSources: ids => calls.push(['sources', ids]), openSourceAt: (id, at) => calls.push(['at', id, at]) } };
  m.partOpener({ part: 1, sourceIds: ['audio-batch-vol1'], ranges: entry.ranges, open: entry.open }, app).run();
  assert.deepEqual(calls, [['at', 'audio-batch-vol1', second.start]]);
});
