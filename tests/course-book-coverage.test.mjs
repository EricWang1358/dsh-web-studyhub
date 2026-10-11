/* 复习全书, 讲解详尽程度 (settings.book.coverage) and big points: the level sets which checklist items are a must (精简: terms, definitions, concepts and
   formulas; 标准 also steps, rules and warnings; 详尽 everything), never a template or a length. A point backed by one long document (「04. Design Secure
   Architecture v4.7」, 80 pages) is written in passes of whole pages, each pass its own call over its own pages and the items taught there; a pass that fails
   is kept pending and the next build writes only it. A fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { bookCoverage, mergeBookSettings } from '../lib/book-settings.js';

const SEC = 'Sec', PAGES = 80, TITLE = '04. Design Secure Architecture v4.7';
const pageText = page => Array.from({ length: 24 }, (_, i) => (i === 0 ? `Secure design fact ${page}: the architect checks each trust boundary of page ${page}.`
  : `Line ${i} of page ${page} goes on about the trust boundary and records the threat.`)).join(' ');
/** One long converted PDF: 80 pages of about 2,000 characters, one fact a page. */
export const longDocument = ({ course = SEC, pages = PAGES } = {}) => Array.from({ length: pages }, (_, i) => ({
  id: `secure-p${i + 1}`, title: `${TITLE} · p. ${i + 1}`, text: pageText(i + 1), createdAt: '2026-09-20T00:00:00.000Z', courses: [course],
  document: { materialId: 'document-secure', page: i + 1, totalPages: pages, format: 'pdf', origin: 'converted', converter: 'marker', filename: `${TITLE}.pdf` } }));

const finish = (w, args) => w.finish(args);

async function world(t, { fake = bookModel(), sources = longDocument(), course = SEC } = {}) {
  const root = await privateRoot(t, 'course-book-coverage-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.focus = { mode: 'class', course }; });
  const notes = async () => (await service.store.read()).sources.filter(record => isCourseNotesSource(record) && !record.archived);
  const finish = async args => {
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course, language: 'zh', ...args })).jobId);
    assert.equal(job.status, 'complete', JSON.stringify(job.error ?? null));
    return (await notes())[0];
  };
  return { service, fake, finish, notes };
}

test('a point of 80 pages is written in passes of whole pages, each its own call over its own pages and the items taught there; a rerun asks nothing', async t => {
  const w = await world(t);
  const record = await finish(w);
  const writes = w.fake.of('write');
  assert.ok(writes.length >= 8 && writes.length <= 10, `${writes.length} passes`);
  assert.ok(writes.every(call => call.data.pages.reduce((sum, page) => sum + page.text.length, 0) <= 20000), 'at most 20,000 characters a pass');
  const pages = writes.map(call => call.data.pages.map(page => page.page));
  assert.deepEqual(pages.flat(), Array.from({ length: PAGES }, (_, i) => i + 1), 'every page once, in order, whole');
  for (const call of writes) assert.ok(call.data.checklist.every(item => call.data.pages.some(page => page.page === item.page)), 'a pass sees the items of its own pages');
  const [leaf] = record.courseNotes.leaves;
  assert.deepEqual([leaf.body.units.length, leaf.body.status, leaf.body.coverage.must, leaf.body.coverage.missing.length], [writes.length, 'ok', PAGES, 0]);
  const mark = w.fake.calls.length;
  await finish(w);
  assert.equal(w.fake.calls.length, mark, 'nothing asked again');
});

test('a pass that fails is kept pending; the point is short and the next build writes only that pass', async t => {
  let failing = true;
  const w = await world(t, { fake: bookModel({ fail: call => failing && call.stage === 'write' && /^3 of /.test(call.data.point.part ?? '') }) });
  const record = await finish(w);
  const [leaf] = record.courseNotes.leaves;
  assert.equal(leaf.body.status, 'short');
  assert.equal(leaf.body.units[2].status, 'pending');
  assert.ok(leaf.body.coverage.missing.length > 0, 'the items of the pass that was not written are missing');
  const writesBefore = [...new Set(w.fake.of('write').map(call => call.data.point.part))];
  failing = false;
  const mark = w.fake.calls.length;
  const fresh = await finish(w);
  assert.deepEqual(w.fake.calls.slice(mark).map(call => [call.stage, call.data.point?.part]), [['write', writesBefore[2]], ['review', writesBefore[2]]], 'only that pass');
  assert.equal(fresh.courseNotes.leaves[0].body.status, 'ok');
});

test('the detail level decides what is a must, not a template: 精简 terms and concepts, 标准 steps too, 详尽 every item', async t => {
  // One point holding a term, a step and an example (a point is always checked against at least its main item, so the levels differ inside one point).
  const kinds = ['term', 'step', 'example'];
  const sources = kinds.map((kind, at) => ({ id: `n${at}`, title: `${kind} note`, text: `Unit fact ${at + 1}: something the course says.`, createdAt: '2026-09-01T00:00:00.000Z', courses: ['K'],
    document: { materialId: `document-n${at}`, format: 'md', filename: `${kind}.md` } }));
  const fake = bookModel();
  const kindOf = name => kinds[Number(/fact (\d+)/.exec(name)?.[1]) - 1] ?? 'concept';
  const complete = fake.complete;
  fake.complete = async (system, prompt, request) => {
    const text = await complete(system, prompt, request);
    if (!prompt.includes('"stage":"inventory"')) return text;
    const value = JSON.parse(text);
    for (const item of value.items) item.kind = kindOf(item.name);
    return JSON.stringify(value);
  };
  const w = await world(t, { fake, sources, course: 'K' });
  const must = async coverage => { const record = await w.finish({ coverage }); return record.courseNotes.leaves.reduce((sum, leaf) => sum + (leaf.body?.coverage.must ?? 0), 0); };
  assert.deepEqual([await must('brief'), await must('standard'), await must('full')], [1, 2, 3]);
  assert.ok(fake.of('write').some(call => call.data.checklist.some(item => item.priority === 'optional')), 'an optional item is shown to the writer as such');
  assert.equal(bookCoverage(mergeBookSettings({}, { coverage: 'full' })), 'full');
});
