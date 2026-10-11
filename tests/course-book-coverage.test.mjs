/* 复习全书, 讲解详尽程度 (settings.book.coverage): a point backed by one long document (「04. Design Secure Architecture v4.7」, 80 pages) is read in passes over
   its page ranges at 标准 and 详尽, one call per pass; 精简 is the reading before levels existed. A rerun at the same level asks nothing, a higher level asks
   only the points whose material is bigger than what was read, a lower level keeps what is there; the page says 「覆盖：读了 N/M 页」 and 读更多 re-reads one
   point at the next level. A fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { INVENTED, bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { chooseRanges, coverageOf, readingOf } from '../lib/course-book-reading.js';
import { bookCoverage, mergeBookSettings } from '../lib/book-settings.js';

const SEC = 'Sec', PAGES = 80, TITLE = '04. Design Secure Architecture v4.7';
const pageText = page => Array.from({ length: 24 }, (_, i) => `Secure design page ${page} line ${i}: the architect checks each trust boundary and records the threat.`).join(' ');
/** One long converted PDF: 80 pages of about 2,400 characters, one chapter. */
export const longDocument = ({ course = SEC, chapter = 'Secure design', pages = PAGES } = {}) => Array.from({ length: pages }, (_, i) => ({
  id: `secure-p${i + 1}`, title: `${TITLE} · p. ${i + 1}`, text: pageText(i + 1), createdAt: '2026-09-20T00:00:00.000Z', courses: [course],
  document: { materialId: 'document-secure', page: i + 1, totalPages: pages, format: 'pdf', origin: 'converted', converter: 'marker', filename: `${TITLE}.pdf`,
    chapter: { index: 0, title: chapter, level: 1 }, extractionVersion: 2 } }));
const note = { id: 'week1', title: 'Week 1 note', text: 'Entropy measures disorder. Example: a melting ice cube gains entropy as its molecules spread out.',
  createdAt: '2026-09-01T00:00:00.000Z', courses: [SEC], document: { materialId: 'document-week1', format: 'md', filename: 'week1.md' } };

async function world(t, { fake = bookModel(), sources = [...longDocument(), note], decks = [], course = SEC } = {}) {
  const root = await privateRoot(t, 'course-book-coverage-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course }; });
  const build = (args = {}) => service.call('generation.courseBook.build', { course, language: 'zh', ...args });
  const notes = async () => (await service.store.read()).sources.filter(record => isCourseNotesSource(record) && !record.archived);
  const finish = async args => {
    const job = await settleJob(service, (await build(args)).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(job.error ?? null));
    return (await notes())[0];
  };
  const view = args => service.call('course.outline', { course, ...args });
  const notesCalls = () => fake.of('notes');
  return { service, fake, build, finish, notes, view, notesCalls };
}
const leafOf = (record, title) => record.courseNotes.leaves.find(leaf => leaf.title === title);
const passCalls = calls => calls.filter(call => call.stage === 'notes' && call.data.leaves[0].part);
const pagesOf = call => call.data.leaves[0].materials.map(material => Number(/^Secure design page (\d+) /.exec(material.text)?.[1]));
const leavesOf = nodes => nodes.flatMap(node => (node.children ? leavesOf(node.children) : [node]));

test('the reading: ranges never cut a page, the passes are spread evenly with the first and the last, 精简 keeps the fingerprint of before', () => {
  const segments = longDocument().map(source => ({ sourceId: source.id, start: 0, end: source.text.length, text: source.text, material: TITLE, page: source.document.page }));
  const brief = readingOf(segments, 'brief', 'zh'), standard = readingOf(segments, 'standard', 'zh'), full = readingOf(segments, 'full', 'zh');
  assert.deepEqual([brief.mode, standard.mode, full.mode], ['excerpt', 'passes', 'passes']);
  assert.deepEqual([standard.of, standard.passes.length, full.passes.length], [10, 3, 8], '80 pages of about 2,400 characters: 10 ranges of 8 pages');
  assert.ok(full.passes.every(pass => pass.pieces.every(piece => !piece.cut) && pass.pieces.reduce((sum, piece) => sum + piece.text.length, 0) <= 20000), 'a pass is whole pages, at most 20,000 characters');
  assert.deepEqual(standard.passes.map(pass => pass.labels), [[{ material: TITLE, unit: 'page', from: 1, to: 8 }], [{ material: TITLE, unit: 'page', from: 41, to: 48 }],
    [{ material: TITLE, unit: 'page', from: 73, to: 80 }]]);
  assert.deepEqual(chooseRanges(10, 8), [0, 1, 3, 4, 5, 6, 8, 9]);
  assert.deepEqual(chooseRanges(2, 3), [0, 1]);
  assert.deepEqual(standard.passes.map(pass => pass.quotes), [4, 3, 3], '标准 keeps at most 10 cites, spread over its passes');
  assert.deepEqual(full.passes.map(pass => pass.quotes), Array(8).fill(3), '详尽 at most 24');
  assert.deepEqual([coverageOf(segments, brief.read).read, coverageOf(segments, brief.read).partial], [0, 80], '精简: a beginning of every page, none whole');
  assert.deepEqual([coverageOf(segments, standard.read).read, coverageOf(segments, full.read).read, coverageOf(segments, full.read).total], [24, 64, 80]);
  const small = segments.slice(0, 3);
  assert.equal(new Set(['brief', 'standard', 'full'].map(level => readingOf(small, level, 'zh').fingerprint)).size, 1, 'a point that fits is read whole at every level');
  // A source without pages is cut at a line, and counted in characters.
  const plain = [{ sourceId: 'md', start: 0, end: 50000, text: 'x'.repeat(99) + '\n'.repeat(1) + 'y'.repeat(49900), material: 'Notes' }];
  const parts = readingOf(plain, 'full', 'zh');
  assert.equal(parts.passes.reduce((sum, pass) => sum + pass.pieces.reduce((n, piece) => n + piece.text.length, 0), 0), 50000);
  assert.deepEqual(coverageOf(plain, parts.read), { unit: 'char', read: 50000, total: 50000, chars: { read: 50000, total: 50000 } });
});

test('levels change the number of calls: 精简 2, 标准 4 (one shared, three passes), 详尽 9 (one shared, eight passes)', async t => {
  const counts = {};
  for (const level of ['brief', 'standard', 'full']) {
    const w = await world(t);
    const record = await w.finish({ coverage: level });
    counts[level] = [w.notesCalls().length, passCalls(w.notesCalls()).length];
    const body = leafOf(record, 'Secure design').body;
    if (level === 'brief') assert.ok(!body.parts && !body.read, '精简 writes as before levels existed');
    else {
      assert.equal(body.parts.length, counts[level][1], 'one part per pass');
      assert.deepEqual(body.points, []);
      assert.ok(body.cites.length === body.parts.length, 'each pass\'s quote kept, numbered through the parts');
      assert.deepEqual(body.cites.map(cite => cite.n), body.parts.map((_, at) => at + 1));
      assert.match(body.parts[1].points[0], /\[\^2\]$/, 'a part\'s marks follow the numbering through the parts');
      const state = await w.service.store.read(), byId = new Map(state.sources.map(source => [source.id, source]));
      for (const cite of body.cites) assert.equal(byId.get(cite.sourceId).text.slice(cite.start, cite.end).replace(/\s+/g, ' '), cite.quote, 'a cite is the original\'s words');
      assert.match(record.text, /### 第 1–8 页\n\n#### 知识梳理/);
    }
    const passes = passCalls(w.notesCalls());
    if (passes.length) {
      const ranges = passes.map(pagesOf);
      assert.equal(ranges[0][0], 1, 'the first range is read');
      assert.equal(ranges.at(-1).at(-1), PAGES, 'the last range is read');
      assert.equal(new Set(ranges.flat()).size, ranges.flat().length, 'the passes read distinct pages');
      assert.ok(passes.every(call => call.data.leaves.length === 1 && call.prompt.length < 30000), 'a pass is its own modest call');
      assert.match(passes[0].data.leaves[0].part, /^1 of \d: 04\. Design Secure Architecture v4\.7, pages 1-8$/);
    }
  }
  assert.deepEqual(counts, { brief: [2, 0], standard: [4, 3], full: [9, 8] });
});

test('a rerun at the same level asks nothing; raising the level re-reads only the big point; lowering keeps the more detailed notes', async t => {
  const w = await world(t);
  const brief = await w.finish({ coverage: 'brief' });
  let mark = w.fake.calls.length;
  await w.finish({ coverage: 'brief' });
  assert.equal(w.fake.calls.length, mark, 'the same level: no call');
  const standard = await w.finish({ coverage: 'standard' });
  const raised = w.fake.calls.slice(mark).filter(call => call.stage === 'notes');
  assert.deepEqual([raised.length, passCalls(raised).length], [3, 3], 'only the big point, in its three passes');
  assert.equal(JSON.stringify(leafOf(standard, 'Week 1 note').body), JSON.stringify(leafOf(brief, 'Week 1 note').body), 'the small point is kept byte for byte');
  assert.equal(leafOf(standard, 'Secure design').body.replaces, brief.id);
  mark = w.fake.calls.length;
  const lowered = await w.finish({ coverage: 'brief' });
  assert.equal(w.fake.calls.length, mark, 'a lower level: no call');
  assert.equal(lowered.id, standard.id, 'nothing written: the more detailed notes stay');
  assert.equal((await w.view()).book.notes.stale, false, 'notes of any level are current');
  // The saved setting is the default level of a build without one.
  await w.service.store.update(state => { state.settings.book = mergeBookSettings(state.settings.book, { coverage: 'full' }); });
  assert.equal(bookCoverage((await w.service.store.read()).settings.book), 'full');
  mark = w.fake.calls.length;
  await w.finish();
  assert.equal(passCalls(w.fake.calls.slice(mark)).length, 8, 'the saved 详尽');
});

test('notes written before levels existed count as 精简: the same build asks nothing, the page says what they read and offers 读更多', async t => {
  const w = await world(t);
  const old = await w.finish({ coverage: 'brief' });
  assert.ok(old.courseNotes.leaves.every(leaf => !leaf.body.parts && !leaf.body.read), 'the format of before');
  const outline = await w.view(), point = leavesOf(outline.book.nodes).find(node => node.title === 'Secure design'), small = leavesOf(outline.book.nodes).find(node => node.title === 'Week 1 note');
  const opened = (await w.view({ expand: [point.key, small.key] })).open;
  assert.deepEqual(opened[point.key].notes.coverage, { unit: 'page', read: 0, total: 80, partial: 80, more: 'standard' });
  assert.deepEqual(opened[small.key].notes.coverage, { unit: 'char', read: note.text.length, total: note.text.length, more: null }, 'a small point read whole: nothing more to read');
  assert.equal(opened[point.key].notes.body.read, undefined, 'the ranges stay in the record');
  const line = outline.book.notes.coverage;
  assert.equal(line.partial, 1);
  assert.ok(line.read < line.total);
  // 读更多: only that point, at the next level, a visible task.
  const mark = w.fake.calls.length;
  const more = await w.finish({ coverage: 'standard', point: point.id });
  assert.equal(passCalls(w.fake.of('notes').slice(-3)).length, 3);
  assert.deepEqual(w.fake.calls.slice(mark).map(call => call.stage), ['notes', 'notes', 'notes'],
    'only the passes of that point (its one-line summary is the same, so the transitions around it stay)');
  const now = (await w.view({ expand: [point.key] })).open[point.key].notes;
  assert.deepEqual(now.coverage, { unit: 'page', read: 24, total: 80, more: 'full' });
  assert.equal(now.body.parts.length, 3);
  assert.equal(JSON.stringify(leafOf(more, 'Week 1 note').body), JSON.stringify(leafOf(old, 'Week 1 note').body));
  const after = await w.finish({ coverage: 'full', point: point.id });
  assert.deepEqual((await w.view({ expand: [point.key] })).open[point.key].notes.coverage, { unit: 'page', read: 64, total: 80, more: null }, '详尽 is the most');
  assert.equal(leafOf(after, 'Secure design').body.parts.length, 8);
});

test('a quote that is not in the pass\'s own pages is dropped; a failed pass is asked again alone on retry', async t => {
  const w = await world(t, { fake: bookModel({ invent: true }) });
  const record = await w.finish({ coverage: 'standard' });
  const body = leafOf(record, 'Secure design').body;
  assert.ok(body.cites.every(cite => cite.quote !== INVENTED) && body.cites.length === 3);
  assert.ok(body.parts.every(part => !/\[\^\d+\]/.test(part.explain.replace(/\[\^\d+\]$/, '')) || /rests on nothing\.$/.test(part.explain)), 'the mark of the dropped quote is gone');
  assert.equal(record.courseNotes.counts.dropped, 3 + 1, 'one invented quote per pass and per shared point');

  let broken = 2;
  const f = await world(t, { fake: bookModel({ junk: call => call.stage === 'notes' && /^2 of 3/.test(call.data.leaves[0].part ?? '') && broken-- > 0 }) });
  const started = await f.build({ coverage: 'standard' });
  assert.equal((await settleJob(f.service, started.jobId)).status, 'failed');
  assert.deepEqual(await f.notes(), []);
  const before = f.fake.calls.length;
  await f.service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(f.service, started.jobId)).status, 'complete');
  const retried = f.fake.calls.slice(before).filter(call => call.stage === 'notes');
  assert.deepEqual(retried.map(call => call.data.leaves[0].part?.slice(0, 6) ?? 'shared'), ['2 of 3', '3 of 3'], 'the shared call and pass 1 were kept');
});

test('a pass the model leaves out: the point keeps its other parts, says what it read, and the next update asks it again', async t => {
  const fake = bookModel(), original = fake.complete;
  let skip = true;
  // The answer of pass 2 names no point.
  const w2 = await world(t, { fake: { ...fake, complete: async (system, prompt, request) => {
    const text = await original(system, prompt, request);
    return skip && /"part":"2 of 3/.test(prompt) ? JSON.stringify({ leaves: [] }) : text;
  } } });
  const record = await w2.finish({ coverage: 'standard' });
  const body = leafOf(record, 'Secure design').body;
  assert.deepEqual([body.parts.length, record.courseNotes.counts.missed], [2, 1]);
  assert.equal((await w2.view()).book.notes.stale, true, 'partly written: out of date');
  skip = false;
  const again = await w2.finish({ coverage: 'standard' });
  assert.equal(leafOf(again, 'Secure design').body.parts.length, 3);
});

test('the 134-material library with the long document: calls per level', async t => {
  const counts = {};
  for (const level of ['brief', 'standard', 'full']) {
    const { sources, decks } = outlineLibrary();
    const w = await world(t, { sources: [...sources, ...longDocument({ course: COURSE, chapter: 'Threat modelling' })], decks, course: COURSE });
    await w.finish({ coverage: level });
    counts[level] = { notes: w.notesCalls().length, passes: passCalls(w.notesCalls()).length };
  }
  // The big point (Threat modelling: the long document and its lecture, handouts and notes) in passes; the others three a call (6 calls), as at 精简.
  assert.deepEqual(counts, { brief: { notes: 8, passes: 0 }, standard: { notes: 9, passes: 3 }, full: { notes: 14, passes: 8 } });
});
