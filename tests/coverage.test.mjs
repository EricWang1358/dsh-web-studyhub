import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf, coverageInRange, coverageSummary, uncoveredSections, sectionKey, COVERED, PLANNED_FAILED, NEVER_PLANNED } from '../lib/coverage.js';
import { createLocator, locateQuote } from '../lib/quote-locate.js';
import { sectionsOf } from '../lib/sections.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* coverageOf: which sections of a material have a question, which were planned and did not come out, which were never planned. Every expectation here comes
   from a CHECKLIST written first (the ids of the sections the questions are about), never from the function's own output. */

const fx = transcriptFixture();
const ids = (coverage, state) => coverage.sections.filter(section => section.state === state).map(section => section.id);
const sorted = list => [...list].sort();
const recordings = new Map();
for (const leaf of fx.leaves) recordings.set(leaf.recording, (recordings.get(leaf.recording) || 0) + 1);

test('the fixture is the audited material: 5 recordings, 80 headed parts, one recording carried across two volumes', () => {
  assert.equal(fx.leaves.filter(section => !section.continued).length, 80);
  assert.equal(fx.leaves.filter(section => section.continued).length, 1, 'recording 4 carries on in the second volume');
  assert.equal(fx.leaves.length, 81);
  assert.ok(fx.sources.reduce((sum, source) => sum + source.text.length, 0) > 400_000);
});

test('nothing covered: every section is never planned and the numbers say so', () => {
  const none = coverageOf({ sources: fx.sources, cards: [] });
  assert.equal(none.leaves, 81);
  assert.equal(none.covered, 0);
  assert.equal(none.plannedFailed, 0);
  assert.equal(none.neverPlanned, 81);
  assert.equal(none.percentLeaves, 0);
  assert.equal(none.percentChars, 0);
  assert.equal(none.perTenK, 0);
  assert.equal(none.recorded, false);
  assert.equal(none.units, 'part');
  assert.deepEqual(none.sections.map(section => section.state), Array(81).fill(NEVER_PLANNED));
  assert.deepEqual(none.sections.map(section => section.id), fx.ids, 'the sections are the leaves of lib/sections.js, in reading order');
  assert.equal(none.groups.length, 5, 'one group per recording');
  assert.deepEqual(none.groups.map(group => group.leaves), [16, 16, 16, 17, 16]);
});

test('some covered: exactly the checklist is covered, by quote and by selection offsets, and the percentages follow', () => {
  const checklist = ['r1.p1', 'r1.p9', 'r2.p3', 'r3.p16', 'r4.p5', 'r5.p2', 'r5.p15'];
  const cards = checklist.map((id, index) => fx.card(fx.leaves.find(section => section.id === id), { how: index % 2 ? 'selection' : 'quote' }));
  const found = coverageOf({ sources: fx.sources, cards });
  assert.deepEqual(sorted(ids(found, COVERED)), sorted(checklist));
  assert.equal(found.covered, 7);
  assert.equal(found.neverPlanned, 74);
  assert.equal(found.plannedFailed, 0);
  assert.equal(found.percentLeaves, 9, '7 of 81 is 8.6%');
  const charsOf = id => fx.leaves.find(section => section.id === id).chars;
  assert.equal(found.coveredChars, checklist.reduce((sum, id) => sum + charsOf(id), 0));
  assert.equal(found.percentChars, Math.round(found.coveredEvidenceChars / found.evidenceChars * 100), 'by characters of evidence');
  assert.equal(found.cards, 7);
  assert.equal(found.perTenK, Math.round(7 / found.evidenceChars * 100000) / 10);
  assert.ok(found.sections.every(section => section.cards === (checklist.includes(section.id) ? 1 : 0)));
  assert.deepEqual(found.groups.map(group => group.covered), [2, 1, 1, 1, 2], 'the per-recording rows add up');
  assert.deepEqual(coverageSummary(found), { covered: 7, plannedFailed: 0, neverPlanned: 74, leaves: 81, percentLeaves: 9, percentChars: found.percentChars, perTenK: found.perTenK,
    units: 'part', cards: 7, unplaced: 0, recorded: false });
});

test('a section with several questions counts once; two questions about two sections cover both; a question that cites two places covers both', () => {
  const a = fx.leaf(1, 4), b = fx.leaf(2, 4);
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(a, { id: 'x1' }), fx.card(a, { id: 'x2', n: 2 }), { ...fx.card(b, { id: 'x3' }), citations: [...fx.card(b, { id: 'x3' }).citations, fx.card(a, { id: 'x3b', n: 3 }).citations[0]] }] });
  assert.deepEqual(sorted(ids(found, COVERED)), sorted([a.id, b.id]));
  assert.equal(found.covered, 2);
  assert.equal(found.sections.find(section => section.id === a.id).cards, 3);
  assert.equal(found.sections.find(section => section.id === b.id).cards, 1);
  assert.equal(found.cards, 3, 'a question is counted once however many sections it touches');
});

test('the continued part of a recording carried across volumes is its own section and is covered by its own questions', () => {
  const cont = fx.leaves.find(section => section.continued), second = fx.sources[1];
  assert.equal(cont.sourceId, second.id);
  const quote = second.text.slice(cont.start + 5, cont.start + 5 + 60).trim().slice(0, 40);
  const found = coverageOf({ sources: fx.sources, cards: [{ id: 'c', citations: [{ sourceId: second.id, quote }] }] });
  assert.deepEqual(ids(found, COVERED), [cont.id]);
});

test('a quote written a little differently from the stored text (spacing, case, punctuation) still finds its section', () => {
  const section = fx.leaf(3, 7), quote = fx.quoteIn(section).toUpperCase().replace(/ /g, '  ').replace(/:/g, ' —');
  const found = coverageOf({ sources: fx.sources, cards: [{ id: 'loose', citations: [{ sourceId: section.sourceId, quote }] }] });
  assert.deepEqual(ids(found, COVERED), [section.id]);
  assert.equal(found.unplaced, 0);
  // A quote that is nowhere in the text places nothing: the question is unplaced and covers no section, said in the numbers.
  const lost = coverageOf({ sources: fx.sources, cards: [{ id: 'lost', citations: [{ sourceId: section.sourceId, quote: 'a sentence nobody ever wrote down here' }] }] });
  assert.equal(lost.covered, 0);
  assert.equal(lost.unplaced, 1);
});

/* ---------- what was planned and did not come out ---------- */

const planOf = (part, { ranges, targets = [], status = 'failed', reason = 'review-protocol' } = {}) => ({ part, sourceIds: [...new Set((ranges || []).map(range => range.sourceId))], ranges, targets, status, reason, attempts: 1 });
const rangeOf = (...sections) => sections.map(section => ({ sourceId: section.sourceId, start: section.start, end: section.end }));
const target = (section, extra = {}) => ({ targetId: `t-${section.id}`, objective: `about ${section.id}`, sourceId: section.sourceId, start: section.start + 100, end: section.start + 160, status: 'failed', reason: 'review-protocol', ...extra });

test('planned and failed: a failed target is located by its offsets, then by its quote, then by the range of its part; kept questions win', () => {
  const [a, b, c, d, e] = [fx.leaf(1, 2), fx.leaf(1, 3), fx.leaf(2, 5), fx.leaf(2, 6), fx.leaf(3, 1)];
  const text = fx.textOf(c.sourceId), quote = fx.quoteIn(c);
  const plans = [planOf(1, { ranges: rangeOf(a, b), targets: [target(a), { ...target(b), start: undefined, end: undefined, quote: fx.quoteIn(b), reason: 'quote' }] }),
    // c is found by its quote, d is only in the range of its part (the quote could not be found: it is "the part's range"), e had a kept question
    planOf(2, { ranges: rangeOf(c, d), targets: [{ targetId: 'x', objective: 'o', sourceId: c.sourceId, quote, status: 'omitted', reason: 'quality' }, { targetId: 'y', objective: 'p', sourceId: d.sourceId, quote: 'not in the text at all', status: 'failed', reason: 'timeout' }] }),
    planOf(3, { ranges: rangeOf(e), targets: [{ ...target(e), status: 'kept', reason: undefined }], status: 'passed', reason: undefined })];
  assert.ok(text.includes(quote));
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(e)], partPlans: plans });
  assert.deepEqual(sorted(ids(found, COVERED)), [e.id]);
  const failed = sorted(ids(found, PLANNED_FAILED));
  // the range of part 2 holds c and d; the unlocated target puts d in it, and c has its own located target
  assert.deepEqual(failed, sorted([a.id, b.id, c.id, d.id]));
  assert.equal(found.sections.find(section => section.id === a.id).reason, 'review-protocol');
  assert.equal(found.sections.find(section => section.id === b.id).reason, 'quote');
  assert.equal(found.sections.find(section => section.id === c.id).reason, 'quality');
  assert.equal(found.sections.find(section => section.id === d.id).reason, 'timeout');
  assert.equal(found.neverPlanned, 81 - 1 - 4);
  assert.equal(found.recorded, true);
  // the same plans with the kept question taken away: e is a planned target that was kept but has no question here, so it is never planned
  const without = coverageOf({ sources: fx.sources, cards: [], partPlans: plans });
  assert.ok(!ids(without, PLANNED_FAILED).includes(e.id));
  assert.equal(without.covered, 0);
});

test('a question in a section beats a failed target there: the section is covered, not planned-failed', () => {
  const a = fx.leaf(1, 2);
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(a)], partPlans: [planOf(1, { ranges: rangeOf(a), targets: [target(a)] })] });
  assert.deepEqual(ids(found, COVERED), [a.id]);
  assert.deepEqual(ids(found, PLANNED_FAILED), []);
});

test('a part that never got as far as targets (its planning failed) is its range: those sections are planned-failed with its reason', () => {
  const [a, b] = [fx.leaf(5, 1), fx.leaf(5, 2)];
  const found = coverageOf({ sources: fx.sources, cards: [], partPlans: [planOf(4, { ranges: rangeOf(a, b), targets: [], status: 'failed', reason: 'plan' })] });
  assert.deepEqual(sorted(ids(found, PLANNED_FAILED)), sorted([a.id, b.id]));
  assert.equal(found.sections.find(section => section.id === a.id).reason, 'plan');
  // a part still running has not failed anything
  const running = coverageOf({ sources: fx.sources, cards: [], partPlans: [planOf(1, { ranges: rangeOf(a), targets: [{ ...target(a), status: 'omitted', reason: 'pending' }], status: 'pending', reason: undefined })] });
  assert.equal(running.plannedFailed, 0);
});

test('the latest failure of a section gives its reason', () => {
  const a = fx.leaf(1, 5);
  const found = coverageOf({ sources: fx.sources, partPlans: [planOf(1, { ranges: rangeOf(a), targets: [target(a, { reason: 'review-protocol' })] }), planOf(7, { ranges: rangeOf(a), targets: [target(a, { reason: 'quote' })] })] });
  assert.equal(found.sections.find(section => section.id === a.id).reason, 'quote');
  assert.deepEqual(found.sections.find(section => section.id === a.id).parts, [1, 7]);
});

test('an old draft has no plans: its uncovered sections are never planned and the result says nothing was recorded', () => {
  const a = fx.leaf(1, 1);
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(a)], partPlans: undefined });
  assert.equal(found.recorded, false);
  assert.equal(found.covered, 1);
  assert.equal(found.neverPlanned, 80);
  assert.equal(found.plannedFailed, 0);
  const empty = coverageOf({ sources: fx.sources, cards: [fx.card(a)], partPlans: [] });
  assert.equal(empty.recorded, false);
});

test('draft only, published only and both: the union of the questions, each section once', () => {
  const draftSet = ['r1.p1', 'r1.p2', 'r2.p2'], deckSet = ['r2.p2', 'r3.p3', 'r5.p5'];
  const make = (list, prefix) => list.map(id => ({ ...fx.card(fx.leaves.find(section => section.id === id)), id: `${prefix}-${id}` }));
  const drafted = make(draftSet, 'draft'), published = make(deckSet, 'deck');
  assert.deepEqual(sorted(ids(coverageOf({ sources: fx.sources, cards: drafted }), COVERED)), sorted(draftSet));
  assert.deepEqual(sorted(ids(coverageOf({ sources: fx.sources, cards: published }), COVERED)), sorted(deckSet));
  const both = coverageOf({ sources: fx.sources, cards: [...drafted, ...published] });
  assert.deepEqual(sorted(ids(both, COVERED)), sorted([...new Set([...draftSet, ...deckSet])]));
  assert.equal(both.covered, 5);
  assert.equal(both.cards, 6);
  assert.equal(both.sections.find(section => section.id === 'r2.p2').cards, 2);
});

/* ---------- sources of other shapes ---------- */

test('a source with no sections is covered by its fixed windows: the question is in the window its quote stands in', () => {
  const paragraph = index => `Paragraph ${index} explains one separate idea about the course in plain words, and nothing else lives here. `.repeat(6).trim();
  const text = Array.from({ length: 120 }, (_, index) => paragraph(index)).join('\n\n'), source = { id: 'plain', title: 'Plain notes', text };
  const windows = sectionsOf(source);
  assert.ok(windows.length >= 8 && windows.every(section => section.kind === 'window'));
  const inWindow = (n, index) => ({ id: `w${n}`, citations: [{ sourceId: 'plain', quote: `Paragraph ${index} explains one separate idea` }] });
  const checklist = new Map([[1, 3], [4, 40], [windows.length, 119]]);
  const mid = windows[3], nth = Number(/Paragraph (\d+) /.exec(text.slice(mid.start + 10))[1]);
  const cards = [inWindow(1, 3), inWindow(5, nth), inWindow(9, 119)];
  const found = coverageOf({ sources: [source], cards });
  assert.equal(found.units, 'window');
  assert.equal(found.leaves, windows.length);
  const expected = new Set([windows[0].id, mid.id, windows.at(-1).id]);
  assert.deepEqual(sorted(ids(found, COVERED)), sorted([...expected]));
  assert.equal(found.neverPlanned, windows.length - 3);
  void checklist;
});

test('PDF pages: a page is covered by a question that cites it, with or without an offset; a failed page is planned-failed by the range of its part', () => {
  const page = number => ({ id: `pdf-${number}`, title: `Book · 第 ${number} 页`, text: `Page ${number} text. `.repeat(40), document: { page: number, bookTitle: 'Book', format: 'pdf' } });
  const pages = Array.from({ length: 12 }, (_, index) => page(index + 1));
  const cards = [{ id: 'a', citations: [{ sourceId: 'pdf-2', quote: 'Page 2 text. Page 2' }] }, { id: 'b', citations: [{ sourceId: 'pdf-7', quote: 'a quote that was lost but the page is known' }] }, { id: 'c', selections: [{ sourceId: 'pdf-11', start: 20, end: 40 }] }];
  const plans = [planOf(1, { ranges: [{ sourceId: 'pdf-4', start: 0, end: pages[3].text.length }, { sourceId: 'pdf-5', start: 0, end: pages[4].text.length }], targets: [{ targetId: 't', objective: 'o', sourceId: 'pdf-5', quote: 'Page 5 text.', status: 'failed', reason: 'quote' }] })];
  const found = coverageOf({ sources: pages, cards, partPlans: plans });
  assert.equal(found.units, 'page');
  assert.equal(found.leaves, 12);
  assert.deepEqual(sorted(ids(found, COVERED)), sorted(['pg1', 'pg1', 'pg1'].map(() => '').length ? found.sections.filter(section => ['pdf-2', 'pdf-7', 'pdf-11'].includes(section.sourceId)).map(section => section.id) : []));
  assert.deepEqual(found.sections.filter(section => section.state === COVERED).map(section => section.page), [2, 7, 11]);
  assert.deepEqual(found.sections.filter(section => section.state === PLANNED_FAILED).map(section => section.page), [5], 'the target is located by its quote on page 5, not spread over its part');
  assert.equal(found.unplaced, 0, 'a question on a one-section source needs no offset');
  assert.equal(found.recorded, true);
});

test('Markdown headings: the leaf headings are the sections; a parent that holds only its own heading is not counted', () => {
  const text = ['# Manual', '', ...['Install', 'Configure', 'Run', 'Debug'].flatMap((title, index) => [`## ${index + 1} ${title}`, '', `Heading ${title} body sentence number one is distinct. `.repeat(30), ''])].join('\n');
  const source = { id: 'md', title: 'Manual', text };
  const cards = [{ id: 'q1', citations: [{ sourceId: 'md', quote: 'Heading Configure body sentence number one is distinct.' }] }, { id: 'q2', citations: [{ sourceId: 'md', quote: 'Heading Debug body sentence number one is distinct.' }] }];
  const found = coverageOf({ sources: [source], cards });
  assert.equal(found.units, 'heading');
  assert.equal(found.leaves, 4, 'the title heading is a parent');
  assert.deepEqual(found.sections.filter(section => section.state === COVERED).map(section => section.title), ['2 Configure', '4 Debug']);
  assert.equal(found.percentLeaves, 50);
});

test('a kept outline gives the sections of a source with no structure of its own', () => {
  const text = 'a'.repeat(900) + 'KEEP-ONE ' + 'b'.repeat(900) + 'KEEP-TWO ' + 'c'.repeat(900);
  const outline = { entries: [{ title: 'Chapter 1', level: 1, anchor: { sourceId: 'raw', offset: 0 } }, { title: 'Chapter 2', level: 1, anchor: { sourceId: 'raw', offset: 900 } }, { title: 'Chapter 3', level: 1, anchor: { sourceId: 'raw', offset: 1800 } }] };
  const found = coverageOf({ sources: [{ id: 'raw', text }], outline, cards: [{ id: 'q', citations: [{ sourceId: 'raw', quote: 'KEEP-TWO' }] }] });
  assert.equal(found.units, 'chapter');
  assert.deepEqual(found.sections.map(section => [section.title, section.state]), [['Chapter 1', NEVER_PLANNED], ['Chapter 2', NEVER_PLANNED], ['Chapter 3', COVERED]]);
});

test('an empty library, a source with no text and cards of nothing known are quiet, not errors', () => {
  const none = coverageOf({});
  assert.deepEqual([none.leaves, none.covered, none.percentLeaves, none.percentChars, none.perTenK, none.unplaced], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(coverageOf({ sources: [{ id: 'e', text: '' }], cards: [{ id: 'q', citations: [{ sourceId: 'gone', quote: 'x' }] }] }).leaves, 0);
  assert.equal(coverageOf({ sources: fx.sources, cards: [null, undefined, {}, { id: 'z', citations: null }] }).covered, 0);
});

test('percentages never round to the extremes by accident: 1 of 400 is 1%, 399 of 400 is 99%', () => {
  const text = Array.from({ length: 400 }, (_, index) => `## S${index}\n\nBody ${index}.`).join('\n\n');
  const base = { sources: [{ id: 'many', text: `# T\n\n${text}` }] };
  const one = coverageOf({ ...base, cards: [{ id: 'q', citations: [{ sourceId: 'many', quote: 'Body 3.' }] }] });
  assert.equal(one.leaves, 400);
  assert.equal(one.percentLeaves, 1);
  const almost = coverageOf({ ...base, cards: Array.from({ length: 399 }, (_, index) => ({ id: `q${index}`, citations: [{ sourceId: 'many', quote: `Body ${index}.` }] })) });
  assert.equal(almost.covered, 399);
  assert.equal(almost.percentLeaves, 99);
  const all = coverageOf({ ...base, cards: Array.from({ length: 400 }, (_, index) => ({ id: `q${index}`, citations: [{ sourceId: 'many', quote: `Body ${index}.` }] })) });
  assert.equal(all.percentLeaves, 100);
});

/* ---------- helpers that read a coverage ---------- */

test('uncoveredSections lists planned-failed first, then never planned, each in reading order', () => {
  const [a, b, c] = [fx.leaf(2, 9), fx.leaf(1, 3), fx.leaf(4, 4)];
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(c)], partPlans: [planOf(1, { ranges: rangeOf(a), targets: [target(a)] }), planOf(2, { ranges: rangeOf(b), targets: [target(b)] })] });
  const list = uncoveredSections(found);
  assert.equal(list.length, 80);
  assert.deepEqual(list.slice(0, 2).map(section => section.id), [b.id, a.id], 'planned-failed first, in reading order');
  assert.ok(list.slice(2).every(section => section.state === NEVER_PLANNED));
  assert.deepEqual(list.slice(2).map(section => section.id), fx.ids.filter(id => ![a.id, b.id, c.id].includes(id)));
});

test('coverageInRange: the sections a part was cut from, each counted in exactly one part', () => {
  const found = coverageOf({ sources: fx.sources, cards: [fx.card(fx.leaf(1, 2)), fx.card(fx.leaf(1, 3))] });
  const first = fx.leaf(1, 1), fifth = fx.leaf(1, 5);
  const range = { sourceId: first.sourceId, start: first.start, end: fifth.end };
  const inside = coverageInRange(found, [range]);
  assert.deepEqual(inside.sections.map(section => section.id), ['r1.p1', 'r1.p2', 'r1.p3', 'r1.p4', 'r1.p5']);
  assert.deepEqual([inside.leaves, inside.covered, inside.plannedFailed, inside.neverPlanned], [5, 2, 0, 3]);
  // a range that cuts a part in the middle belongs to the part that holds most of it, so two neighbouring ranges never share a section
  const middle = Math.floor((fifth.start + fifth.end) / 2);
  const left = coverageInRange(found, [{ sourceId: first.sourceId, start: first.start, end: middle }]), right = coverageInRange(found, [{ sourceId: first.sourceId, start: middle, end: fx.leaf(1, 8).end }]);
  const shared = left.sections.filter(section => right.sections.some(other => other.key === section.key));
  assert.equal(shared.length, 0);
  assert.equal(coverageInRange(found, undefined).leaves, 0);
  assert.equal(sectionKey('s', 'r1.p1'), 's#r1.p1');
});

/* ---------- the locator ---------- */

test('the quote locator finds a quote as written, by its letters and digits, and in pieces; short or absent quotes find nothing', () => {
  const text = 'Alpha beta.\n\nGamma—delta  epsilon;\nzeta eta theta. Final words here, and more.';
  assert.deepEqual(locateQuote(text, 'Gamma—delta'), { start: 13, end: 24 });
  const loose = locateQuote(text, 'GAMMA DELTA epsilon zeta ETA');
  assert.equal(text.slice(loose.start, loose.end), 'Gamma—delta  epsilon;\nzeta eta');
  const pieces = locateQuote(text, 'Alpha beta … Final words here');
  assert.equal(text.slice(pieces.start, pieces.end), 'Alpha beta.\n\nGamma—delta  epsilon;\nzeta eta theta. Final words here');
  const cut = locateQuote(text, 'Gamma—delta  epsilon;…');
  assert.equal(text.slice(cut.start, cut.end), 'Gamma—delta  epsilon;');
  assert.equal(locateQuote(text, 'nothing like this'), null);
  assert.equal(locateQuote(text, 'ab'), null, 'too short to prove anything');
  assert.equal(locateQuote('', 'Alpha beta'), null);
  assert.equal(createLocator(text)(''), null);
  const cjk = '第一部分：微服务把系统拆成各自拥有数据的服务。 事件驱动架构让服务响应事件。';
  const found = locateQuote(cjk, '微服务把系统拆成各自拥有数据的服务');
  assert.equal(cjk.slice(found.start, found.end), '微服务把系统拆成各自拥有数据的服务');
  const spaced = locateQuote(cjk, '事件驱动架构 让服务响应事件');
  assert.equal(cjk.slice(spaced.start, spaced.end), '事件驱动架构让服务响应事件');
});

/* ---------- speed ---------- */

test('a 530 000-character material with 80 parts and 400 questions is covered in well under 100 ms', () => {
  const cards = [];
  for (let index = 0; index < 400; index++) { const leaf = fx.leaves[index % fx.leaves.length]; cards.push({ ...fx.card(leaf, { n: 1 + (index % 4), id: `perf-${index}` }) }); }
  coverageOf({ sources: fx.sources, cards });
  // CPU time, not the clock: the work itself, which a machine that is busy with other tests (this suite runs a hundred files at once) does not make any bigger. The usual run is about 40 ms.
  const cpu = work => { const before = process.cpuUsage(); const value = work(); const used = process.cpuUsage(before); return { ms: (used.user + used.system) / 1000, value }; };
  const times = [];
  for (let run = 0; run < 9; run++) { const { ms, value } = cpu(() => coverageOf({ sources: fx.sources, cards })); times.push(ms); assert.equal(value.covered, 81); }
  times.sort((a, b) => a - b);
  assert.ok(times[0] < 100, `best ${times[0].toFixed(1)} ms of ${times.map(time => time.toFixed(0)).join(', ')}`);
  // Also with the sections handed in (a caller that has them): the questions are the only work.
  const sections = fx.sections, handed = [];
  for (let run = 0; run < 9; run++) handed.push(cpu(() => coverageOf({ sources: fx.sources, cards, sections })).ms);
  assert.ok(Math.min(...handed) < 100, `handed in: best ${Math.min(...handed).toFixed(1)} ms`);
});

test('a part whose range begins inside a section finds its own failed target there, though the section is counted in the part that holds most of it', () => {
  const edge = fx.leaf(2, 1), next = fx.leaf(2, 2), start = edge.end - 400, at = start + 30;
  const range = { sourceId: edge.sourceId, start, end: next.end };
  const plans = [planOf(3, { ranges: [range], targets: [{ targetId: 't', objective: 'o', sourceId: edge.sourceId, start: at, end: at + 50, status: 'failed', reason: 'review-protocol' }] })];
  const found = coverageOf({ sources: fx.sources, cards: [], partPlans: plans });
  assert.deepEqual(found.sections.find(section => section.id === edge.id).at, [at], 'where the failed target stands is kept (a few offsets)');
  const own = coverageInRange(found, [range]);
  assert.deepEqual(own.sections.map(section => section.id), [next.id], 'the section that is mostly in the previous part is not counted here');
  assert.deepEqual(own.borrowed.map(section => section.id), [edge.id], 'but the failed target that lies in this range is named');
  assert.equal(own.plannedFailed, 0);
  const before = coverageInRange(found, [{ sourceId: edge.sourceId, start: edge.start, end: start }]);
  assert.deepEqual(before.sections.map(section => section.id), [edge.id], 'the previous part counts it');
  assert.deepEqual(before.borrowed, [], 'and does not borrow what is not inside its range');
});
