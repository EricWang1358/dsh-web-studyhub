import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { applyEdits, cleanEdits, editableBlocks, emptiedPages, mergeEdits, savedBy, withoutEmptied } from '../lib/converted-edit.js';
import { convertHome, discardHeld, discardUnlessHeld, jobDir, listManifests, readManifest, saveManifest, sweepStale } from '../lib/mineru-job.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { jobArchive } from '../lib/job-archive.js';
import { capabilityIndex } from '../lib/runtime/tools.js';
import { createJobNotifier } from '../lib/runtime/job-notice.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { resultsDir } from '../lib/mineru-paths.js';
import { makePdf } from './helpers/pdf.mjs';
import { harness } from './helpers/pdf-convert-harness.mjs';
import { until } from './helpers/wait.mjs';

/* Issue #54: 导入前先让我改. With the switch on a conversion stops before the import, the job says so, the learner removes or corrects text block by block, and one press imports
   exactly that. Off (the default) nothing changes. The junk never reaches a model, and citations stay valid because nothing already imported is touched. */

const CONTENT = [
  { type: 'text', text: 'Chapter', text_level: 1, page_idx: 0, bbox: [1, 2, 3, 4] },
  { type: 'text', text: 'junk %%%% junk', page_idx: 0 },
  { type: 'header', text: 'running head', page_idx: 0 },
  { type: 'list', list_items: ['one', 'two'], page_idx: 1 },
  { type: 'table', table_body: '<table><tr><td>a</td></tr></table>', page_idx: 1 },
  { type: 'code', code_body: 'x = 1', page_idx: 2 },
  { type: 'text', text: 'last page', page_idx: 3 },
];

test('the blocks shown are the ones that reach a model, and each says its page', () => {
  const blocks = editableBlocks(CONTENT);
  assert.deepEqual(blocks.map(block => [block.index, block.page, block.editable]), [[0, 1, true], [1, 1, true], [3, 2, true], [4, 2, false], [5, 3, true], [6, 4, true]], 'a running head never reaches a model, so it is not offered');
  assert.equal(blocks[2].text, 'one\ntwo');
  assert.match(blocks[3].text, /\| a \|/, 'a table is shown as it will be read');
});

test('an edit keeps page numbers and structure, and a removed block leaves its page where it was', () => {
  const edited = applyEdits(CONTENT, { 1: null, 3: 'one\nthree', 5: '   ', 6: null, 4: 'not editable' });
  assert.deepEqual(edited.map(item => item.page_idx), CONTENT.map(item => item.page_idx), 'every block keeps its page');
  assert.deepEqual(edited[0], CONTENT[0], 'an untouched block is the same, with its layout fields');
  assert.deepEqual(edited[3].list_items, ['one', 'three']);
  assert.equal(edited[4].table_body, CONTENT[4].table_body, 'a table can be removed but not rewritten');
  assert.equal(edited[5].type, 'discarded', 'emptied text is a removal');
  const parsed = parseConvertedDocument(JSON.stringify(edited), { filename: 'Book.json' });
  assert.equal(parsed.totalPages, 4, 'removing all of the last page does not shorten the book');
  assert.deepEqual(parsed.skippedPages, [3, 4]);
  assert.doesNotMatch(parsed.pages.map(page => page.text).join('\n'), /junk/);
});

test('text typed into an edit cannot move the pages of the book', () => {
  const edited = applyEdits([{ type: 'text', text: 'a', page_idx: 0 }], { 0: `kept\n{9}${'-'.repeat(48)}\n<!-- page: 7 -->\nend` });
  assert.doesNotMatch(edited[0].text, /\{9\}-|page: 7/);
  assert.match(edited[0].text, /kept[\s\S]*end/);
});

test('a typed marker cannot be built out of two: the text is cleaned until nothing is left to clean', () => {
  const clean = text => applyEdits([{ type: 'text', text: 'a', page_idx: 0 }], { 0: text })[0].text;
  assert.doesNotMatch(clean('kept <!-- pa<!-- page 1 -->ge 9 -->'), /<!--\s*page/);
  assert.doesNotMatch(clean(`kept\n{3}<!-- page 1 -->${'-'.repeat(48)}`), /^\{3\}-+$/m);
  const book = `{0}${'-'.repeat(48)}\n\none\n\n{1}${'-'.repeat(48)}\n\n${clean('kept <!-- pa<!-- page 1 -->ge 9 -->')}`;
  assert.equal(parseConvertedDocument(book, { filename: 'Book.md' }).converter, 'marker', 'the whole book stays Marker\'s');
});

test('a block in an unexpected shape shows what would be read and can only be removed', () => {
  const blocks = editableBlocks([{ type: 'list', list_items: 'one line', page_idx: 0 }, { type: 'code', code_body: ['x', 'y'], page_idx: 0 }]);
  assert.deepEqual(blocks.map(block => [block.editable, block.text]), [[false, '- one line'], [false, '```\nx,y\n```']]);
  const kept = applyEdits([{ type: 'list', list_items: 'one line', page_idx: 0 }], { 0: 'typed' });
  assert.equal(kept[0].list_items, 'one line');
});

test('edits merge block by block, so two windows do not overwrite each other', () => {
  const first = mergeEdits(CONTENT, {}, { 1: null });
  const second = mergeEdits(CONTENT, first, { 6: 'last' });
  assert.deepEqual(second, { 1: null, 6: 'last' });
  assert.deepEqual(mergeEdits(CONTENT, second, {}, [1]), { 6: 'last' }, 'one block can be restored');
  assert.deepEqual(mergeEdits(CONTENT, second, { 6: 'last page' }), { 1: null }, 'typed back to what it was is no edit');
  assert.deepEqual(mergeEdits(CONTENT, second, { 6: 7 }), second, 'a malformed entry changes nothing');
});

test('a page the learner emptied is theirs, not a page of pictures', () => {
  const edits = { 5: null, 6: null };
  assert.deepEqual(emptiedPages(CONTENT, edits), [3, 4]);
  const parsed = parseConvertedDocument(JSON.stringify(applyEdits(CONTENT, edits)), { filename: 'Book.json' });
  assert.match(parsed.warnings[0], /no text/);
  assert.deepEqual(withoutEmptied({ skippedPages: parsed.skippedPages, warnings: parsed.warnings }, [3, 4]), { skippedPages: [], warnings: [] });
  const mixed = withoutEmptied({ skippedPages: [2, 3], warnings: ['Pages 2, 3 have no text in the converted output (pictures or blank pages) and were skipped.', 'other'] }, [3]);
  assert.deepEqual(mixed.skippedPages, [2]);
  assert.match(mixed.warnings[0], /^Pages 2 have no text/);
  assert.equal(mixed.warnings[1], 'other');
});

test('the text of a waiting conversion belongs to the learner\'s own clicks: the main chat can neither read, change nor import it', () => {
  for (const action of ['mineru.edit.read', 'mineru.edit.save', 'mineru.edit.import']) assert.match(assistantRefusal(action) || '', /not available to the assistant/, action);
  assert.equal(assistantRefusal('mineru.retry'), null, 'a retry only stops again, so it stays');
  const index = JSON.stringify(capabilityIndex([{ id: 'audio', api: 'study.audio', operations: ['mineru.edit.read', 'mineru.edit.save', 'mineru.edit.import', 'mineru.retry'].map(name => ({ name })) }]));
  assert.doesNotMatch(index, /edit/, 'and it is not listed to the assistant');
  assert.match(index, /retry/);
});

test('the notice to the main chat says the conversion waits, that nothing failed, and that a retry only stops again', () => {
  const said = [], announce = createJobNotifier(notice => said.push(notice));
  for (const language of ['zh', 'en']) announce({ id: `held-${language}`, type: 'pdf-convert', filename: 'Book.pdf', status: 'failed', stage: CONVERT_TEXT.held, held: { blocks: 3 }, language });
  const [zh, en] = said.map(notice => JSON.stringify(notice));
  assert.doesNotMatch(en, /has status failed|incomplete/);
  assert.match(en, /waiting for the learner/);
  assert.match(en, /only stops again/i);
  assert.doesNotMatch(zh, /状态 failed|未完成/);
  assert.match(zh, /只会再次停下/);
});

test('a folder whose manifest cannot be read counts as holding edits: nothing deletes it', async t => {
  const h = await harness(t, { runtime: false });
  const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId), dir = jobDir(h.root, job.id);
  assert.equal(await discardUnlessHeld(h.root, job.id, { keepResults: true }), false, 'a retry\'s clean-up leaves a waiting job alone');
  await readManifest(dir);
  const good = await readFile(join(dir, 'manifest.json'), 'utf8');
  await writeFile(join(dir, 'manifest.json'), '{ not json');
  assert.equal(await discardUnlessHeld(h.root, job.id, { keepResults: true }), false);
  assert.equal(await discardHeld(h.root, job.id), false);
  const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  await utimes(dir, old, old);
  await sweepStale(h.root);
  assert.ok((await stat(join(dir, 'held.json'))).isFile(), 'still there');
  await writeFile(join(dir, 'manifest.json'), good);
  const plain = { ...JSON.parse(good) }; delete plain.held;
  await saveManifest(dir, plain);
  assert.equal(await discardUnlessHeld(h.root, job.id, { keepResults: true }), true, 'an ordinary conversion is cleaned as before');
});

test('saved edits drop what is not an edit, and the saving is the existing token measure', () => {
  assert.deepEqual(cleanEdits(CONTENT, { 0: 'Chapter', 1: null, 2: null, 99: null, x: 'y', 3: 7, 6: 'last' }), { 1: null, 6: 'last' }, 'unchanged, unseen, unknown and malformed entries go');
  assert.throws(() => cleanEdits(CONTENT, []), /edits/);
  const saved = savedBy(CONTENT, { 1: null });
  assert.equal(saved.chars, 'junk %%%% junk'.length);
  assert.equal(saved.tokens, 4, 'chars / 4, as DSH prices a message');
  assert.deepEqual(savedBy(CONTENT, {}), { chars: 0, tokens: 0 });
});

const held = async (h, id) => until(async () => { const job = (await h.jobs()).find(item => item.id === id); return job?.contract?.detail?.held && job.status !== 'running' && job.status !== 'queued' ? job : null; }, 'the conversion to stop before the import');
// The letters of conversions, as the inbox has them; the letter is written just after the job says it ended.
const letters = async h => (await h.call('snapshot')).inbox.items.filter(item => item.kind.startsWith('pdf-')).map(item => item.kind);
const mineruSources = async h => (await h.call('export')).sources.filter(source => source.document?.converter === 'mineru');

for (const runtime of [false, true]) {
  const path = runtime ? 'a Job' : 'the original run';

  test(`${path}: with the switch on the conversion stops before the import, says so, and imports what was edited`, async t => {
    const h = await harness(t, { runtime });
    const started = await h.start(5, { reviewBeforeImport: true, courses: ['Databases'] });
    assert.match(started.next, /修改/, 'the receipt does not promise an automatic save');
    const job = await held(h, started.jobId);

    assert.equal(job.phase, 'held');
    assert.equal(job.retryable, true);
    assert.equal(job.contract.detail.held.blocks > 0, true);
    assert.equal((await mineruSources(h)).length, 0, 'nothing is in the library yet');
    await until(async () => (await letters(h)).length > 0, 'the letter');
    assert.deepEqual(await letters(h), ['pdf-held'], 'a letter that it is waiting, not that it failed');
    await until(async () => (await h.call('mineru.history.list')).records[0].status === 'held', 'the history to say it waits');
    assert.deepEqual((await readdir(jobDir(h.root, job.id))).includes('source.pdf'), false, 'the PDF copy is not kept while it waits');

    const opened = await h.call('mineru.edit.read', { jobId: job.id });
    assert.equal(opened.pages, 5);
    assert.deepEqual([...new Set(opened.blocks.map(block => block.page))], [1, 2, 3, 4, 5]);
    const onFirst = opened.blocks.filter(block => block.page === 1), last = opened.blocks.filter(block => block.page === 5);
    const edits = { [onFirst[0].index]: 'corrected first page', ...Object.fromEntries(onFirst.slice(1).map(block => [block.index, null])) };
    const saved = await h.call('mineru.edit.save', { jobId: job.id, edits });
    assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).edits[onFirst[0].index], 'corrected first page');
    assert.equal(typeof saved.saved.tokens, 'number');

    const parsesBefore = (await h.parses()).length;
    const imported = await h.call('mineru.edit.import', { jobId: job.id, edits: { ...edits, ...Object.fromEntries(last.map(block => [block.index, null])) } });
    const done = await h.settled(imported.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal(done.id, job.id);
    assert.equal(done.contract?.detail?.held ?? null, null);
    assert.equal((await h.parses()).length, parsesBefore, 'the import converts nothing again');

    const sources = await mineruSources(h);
    assert.match(sources.find(source => source.document.page === 1).text, /^# corrected first page$/m);
    assert.equal(sources.some(source => source.document.page === 5), false, 'the removed page is not there');
    assert.deepEqual(sources.map(source => source.document.page), [1, 2, 3, 4], 'the other pages keep their numbers');
    assert.deepEqual(sources[0].courses, ['Databases']);
    assert.equal(done.sourceIds.length, 4);

    await until(async () => (await letters(h)).includes('pdf-result'), 'the letter of the import');
    assert.deepEqual(await letters(h), ['pdf-result'], 'the letter about waiting is gone');
    await until(async () => (await h.call('mineru.history.list')).records[0].status === 'complete', 'the history to say it is done');
    assert.equal((await listManifests(h.root)).length, 0, 'the working folder is gone after the import');
  });

  test(`${path}: edits survive a restart, and the waiting job comes back waiting`, async t => {
    const h = await harness(t, { runtime });
    const started = await h.start(3, { reviewBeforeImport: true });
    const job = await held(h, started.jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    const page = blocks[0].page, removed = Object.fromEntries(blocks.filter(block => block.page === page).map(block => [block.index, null]));
    await h.call('mineru.edit.save', { jobId: job.id, edits: removed });

    await h.restart();
    const back = (await h.jobs()).find(item => item.id === job.id);
    assert.equal(back.phase, 'held');
    assert.ok(back.contract.detail.held);
    assert.equal(back.retryable, true);
    assert.equal((await h.call('mineru.history.list')).records[0].status, 'held');
    assert.deepEqual((await h.call('mineru.edit.read', { jobId: job.id })).edits, removed);

    const imported = await h.call('mineru.edit.import', { jobId: job.id });
    const done = await h.settled(imported.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal((await mineruSources(h)).some(source => source.document.page === page), false);
  });

  test(`${path}: the press of 导入 does not cross an attempt: a restart or a refused retry takes it back`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId), dir = jobDir(h.root, job.id);
    const pressed = await readManifest(dir);
    pressed.held.approved = true;
    await saveManifest(dir, pressed);
    await h.restart();
    assert.equal((await readManifest(dir)).held.approved, false, 'a restart takes it back');
    await held(h, (await h.call('mineru.retry', { jobId: job.id })).jobId);
    assert.equal((await mineruSources(h)).length, 0, 'so a later retry imports nothing');

    const refused = await readManifest(dir);
    refused.route = 'cloud';
    await saveManifest(dir, refused);
    // The original path refuses the start; a Job starts and refuses in its attempt: either way the press is taken back.
    const pressedAgain = h.call('mineru.edit.import', { jobId: job.id });
    if (runtime) await pressedAgain; else await assert.rejects(pressedAgain);
    await h.settled(job.id);
    assert.equal((await readManifest(dir)).held.approved, false, 'a refused start takes it back');
    assert.equal((await mineruSources(h)).length, 0);
  });

  test(`${path}: two windows: saves merge block by block, and the second press of 导入 is a plain refusal`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(3, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    await Promise.all([h.call('mineru.edit.save', { jobId: job.id, edits: { [blocks[0].index]: 'from window A' } }), h.call('mineru.edit.save', { jobId: job.id, edits: { [blocks[1].index]: 'from window B' } })]);
    const { edits } = await h.call('mineru.edit.read', { jobId: job.id });
    assert.deepEqual([edits[blocks[0].index], edits[blocks[1].index]], ['from window A', 'from window B']);
    const answered = await h.call('mineru.edit.save', { jobId: job.id, restore: [blocks[1].index] });
    assert.deepEqual(answered.edits, { [blocks[0].index]: 'from window A' });

    const presses = await Promise.allSettled([h.call('mineru.edit.import', { jobId: job.id }), h.call('mineru.edit.import', { jobId: job.id })]);
    assert.equal(presses.filter(press => press.status === 'fulfilled').length, 1, 'one import');
    const refusal = presses.find(press => press.status === 'rejected').reason.message;
    assert.doesNotMatch(refusal, /ENOENT|[\\/]/, refusal);
    const done = await h.settled(job.id);
    assert.equal(done.status, 'complete', done.stage);
    assert.equal(done.contract?.detail?.held ?? null, null, 'the card does not go back to waiting');
    assert.ok((await mineruSources(h)).some(source => source.text.includes('from window A')));
  });

  test(`${path}: letting it go also takes back the letter that says it waits`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    await until(async () => (await letters(h)).includes('pdf-held'), 'the letter');
    await h.call('job.delete', { jobIds: [job.id] });
    assert.deepEqual(await letters(h), [], 'no letter points at a job that is gone');
  });

  test(`${path}: 全部归档 and 全部移除 leave a waiting conversion where it is`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    const reply = await h.call('job.archive', { all: true });
    assert.deepEqual(reply.skipped.filter(item => item.reason === 'waiting').map(item => item.id).length, 1);
    assert.deepEqual(reply.archived, []);
    await h.call('job.dismiss', { all: true });
    assert.ok((await h.jobs()).some(item => item.id === job.id));
    assert.ok((await h.call('mineru.edit.read', { jobId: job.id })).blocks.length > 0);
  });

  test(`${path}: archived, the app restarted, unarchived: 导入 still works`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    await h.call('job.archive', { jobId: job.id });
    await h.restart();
    await h.call('job.unarchive', { jobId: job.id });
    const back = await until(async () => (await h.jobs()).find(item => item.id === job.id), 'the job to come back');
    assert.ok(back.contract.detail.held);
    const imported = await h.call('mineru.edit.import', { jobId: job.id });
    const done = await h.settled(imported.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.ok((await mineruSources(h)).length > 0);
  });

  test(`${path}: archived and unarchived with no restart: 导入 still works`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    await h.call('job.archive', { jobId: job.id });
    await h.call('job.unarchive', { jobId: job.id });
    await until(async () => (await h.jobs()).find(item => item.id === job.id), 'the job to come back');
    const done = await h.settled((await h.call('mineru.edit.import', { jobId: job.id })).jobId);
    assert.equal(done.status, 'complete', done.stage);
  });

  test(`${path}: asked for the job, the answer says it waits and that a retry only stops again; a page the learner emptied is not called blank`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(3, { reviewBeforeImport: true })).jobId);
    const told = await h.call('job.status', { jobId: job.id }), listed = (await h.call('job.status')).jobs.find(item => item.id === job.id);
    for (const answer of [told, listed]) {
      assert.equal(answer.status, job.status, 'the status stays what the job model says');
      assert.equal(answer.stageCode, 'held');
      assert.equal(answer.waitingForLearner, true);
      assert.match(answer.note, /only stops again/);
    }
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    const page = blocks[blocks.length - 1].page;
    const done = await h.settled((await h.call('mineru.edit.import', { jobId: job.id, edits: Object.fromEntries(blocks.filter(block => block.page === page).map(block => [block.index, null])) })).jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual(done.skippedPages, []);
    assert.equal(done.warnings.some(text => /no text|pictures|blank/.test(text)), false, done.warnings.join(' | '));
  });

  test(`${path}: 接着做 on a waiting job does not import behind the learner's back`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    await h.call('mineru.edit.save', { jobId: job.id, edits: { [blocks[0].index]: 'kept edit' } });
    const again = await h.call('mineru.retry', { jobId: job.id });
    await held(h, again.jobId);
    assert.equal((await mineruSources(h)).length, 0);
    assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).edits[blocks[0].index], 'kept edit');
  });

  test(`${path}: converting the same PDF again keeps what was edited until the learner lets it go`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(4, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    await h.call('mineru.edit.save', { jobId: job.id, edits: { [blocks[0].index]: 'my correction' } });

    await assert.rejects(h.start(4), error => error.code === 'edit-pending' && /1 处/.test(error.message) && /不会覆盖/.test(error.message));
    assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).edits[blocks[0].index], 'my correction', 'the refused start changed nothing');
    assert.equal((await readManifest(jobDir(h.root, job.id))).held.approved, false);

    // Another book is not held up by it.
    await h.set({ total: 2 });
    const other = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 2, title: 'another book' }), 'Other.pdf') });
    assert.equal((await h.settled(other.jobId)).status, 'complete');

    // Letting it go is the learner's: the windows stay, so converting again costs nothing and the text is the converter's own again.
    const parses = (await h.parses()).length;
    await h.call('job.delete', { jobIds: [job.id] });
    assert.equal((await listManifests(h.root)).some(item => item.manifest.id === job.id), false);
    assert.equal((await h.call('mineru.history.list')).records.find(record => record.id === job.id).status, 'cancelled');
    const fresh = await h.start(4);
    assert.equal((await h.settled(fresh.jobId)).status, 'complete');
    assert.equal((await h.parses()).length, parses, 'the converted windows were reused');
  });

  test(`${path}: an archived waiting job keeps its text and comes back from the archive`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    await h.call('mineru.edit.save', { jobId: job.id, edits: { [blocks[0].index]: 'kept through the archive' } });
    await h.call('job.archive', { jobId: job.id });
    assert.deepEqual(await h.call('mineru.edit.read', { jobId: job.id }), { archived: true }, 'read-only until it is unarchived, and it says so');
    await assert.rejects(h.call('mineru.edit.save', { jobId: job.id, edits: {} }), /取消归档/);
    await assert.rejects(h.start(2), error => error.code === 'edit-pending' && /已归档/.test(error.message));
    await h.call('job.unarchive', { jobId: job.id });
    const back = await until(async () => (await h.jobs()).find(item => item.id === job.id), 'the job to come back');
    assert.ok(back.contract.detail.held);
    assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).edits[blocks[0].index], 'kept through the archive');
  });

  test(`${path}: removing every block is refused, and the job stays waiting with its edits`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    await assert.rejects(h.call('mineru.edit.import', { jobId: job.id, edits: Object.fromEntries(blocks.map(block => [block.index, null])) }), /没有可用的文字/);
    assert.equal((await readManifest(jobDir(h.root, job.id))).held.approved, false);
    assert.equal((await h.jobs()).find(item => item.id === job.id).phase, 'held');
    assert.equal((await mineruSources(h)).length, 0);
  });

  test(`${path}: a stop during the import goes back to waiting and keeps the edits`, async t => {
    const h = await harness(t, { runtime });
    const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
    const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
    // A second conversion holds the one-at-a-time line, so the import waits in the queue and can be stopped.
    await h.set({ delayMs: 400, total: 2 });
    const other = await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 2, title: 'in front' }), 'Front.pdf') });
    const imported = await h.call('mineru.edit.import', { jobId: job.id, edits: { [blocks[0].index]: 'my words' } });
    await h.call('job.cancel', { jobId: imported.jobId });
    await h.settled(other.jobId);
    const back = await held(h, job.id);
    assert.ok(back.contract.detail.held);
    assert.equal((await readManifest(jobDir(h.root, job.id))).held.approved, false);
    assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).edits[blocks[0].index], 'my words');
    assert.equal((await mineruSources(h)).some(source => source.text === 'my words'), false);
  });
}

test('a waiting conversion that falls off the end of the archive keeps its text and comes back', async t => {
  const h = await harness(t, { runtime: false });
  const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
  await h.call('job.archive', { jobId: job.id });
  const file = join(h.root, 'job-archive.json'), record = JSON.parse(await readFile(file, 'utf8')).records.find(item => item.id === job.id);
  const at = Date.now() + 1000;
  await jobArchive(h.root).add(Array.from({ length: 199 }, (_, index) => ({ ...record, id: `filler-${index}`, ids: [`filler-${index}`], archivedAt: new Date(at).toISOString(), job: { ...record.job, id: `filler-${index}` } })));
  await h.set({ total: 2 });
  const other = await h.settled((await h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages: 2, title: 'one more' }), 'More.pdf') })).jobId);
  await h.call('job.archive', { jobId: other.id });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records.some(item => item.id === job.id), false, 'it fell off');
  assert.ok((await listManifests(h.root)).some(item => item.manifest.id === job.id), 'its text did not');
});

test('the default stays automatic: without the switch nothing waits', async t => {
  const h = await harness(t, { runtime: false });
  const started = await h.start(2);
  assert.doesNotMatch(started.next, /修改/);
  const done = await h.settled(started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.held, undefined);
  await assert.rejects(h.call('mineru.edit.read', { jobId: done.id }), /没有等你导入|已被清理/, 'an imported document is not offered for editing');
});

test('an imported edited document stays as it is when the same PDF is converted again', async t => {
  const h = await harness(t, { runtime: false });
  const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
  const { blocks } = await h.call('mineru.edit.read', { jobId: job.id });
  const imported = await h.call('mineru.edit.import', { jobId: job.id, edits: Object.fromEntries(blocks.filter(block => block.page === 1).map((block, index) => [block.index, index ? null : 'the corrected text'])) });
  const first = await h.settled(imported.jobId);
  assert.equal(first.status, 'complete', first.stage);
  const again = await h.settled((await h.start(2)).jobId);
  assert.equal(again.status, 'complete', again.stage);
  assert.notEqual(again.documentId, first.documentId, 'the converter\'s own text is a document of its own');
  const kept = (await h.call('export')).sources.find(source => source.id === first.sourceIds[0]);
  assert.match(kept.text, /the corrected text/, 'the edited pages, and any citation of them, did not change');
});

test('a job waiting for the learner outlives the sweep of stale conversions; its PDF windows do not need to', async t => {
  const h = await harness(t, { runtime: false });
  const job = await held(h, (await h.start(2, { reviewBeforeImport: true })).jobId);
  const dir = jobDir(h.root, job.id), old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  await utimes(dir, old, old);
  await sweepStale(h.root);
  assert.ok((await stat(join(dir, 'manifest.json'))).isFile());
  assert.equal((await h.call('mineru.edit.read', { jobId: job.id })).blocks.length > 0, true);
  assert.ok(convertHome(h.root));
});

async function markerHarness(t) {
  const folder = await mkdtemp(join(tmpdir(), 'convert-edit-marker-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(folder, 'home');
  const root = join(folder, 'library'), statePath = join(folder, 'state.json'), log = join(folder, 'log.jsonl');
  await writeFile(statePath, '{}'); await writeFile(log, '');
  const fake = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
  const service = new StudyService(root, { marker: { limits: { windowPages: 2 }, local: { cli: { file: process.execPath, prefix: [fake], env: { FAKE_MARKER_STATE: statePath, FAKE_MARKER_LOG: log } } } } });
  t.after(async () => { service.dispose(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = (name, args) => service.call(name, args);
  return { root, call, job: async () => (await call('snapshot')).jobs.find(job => job.type === 'pdf-convert'),
    upload: async pages => {
      const bytes = await makePdf({ pages }), { uploadId, chunkBytes } = await call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
      await call('mineru.upload.finish', { uploadId });
      return uploadId;
    } };
}

test('Marker takes the same path: page markers stay right, and typed markers cannot move pages', async t => {
  const h = await markerHarness(t);
  const started = await h.call('marker.import', { uploadId: await h.upload(4), reviewBeforeImport: true });
  const job = await until(async () => { const item = await h.job(); return item?.contract?.detail?.held ? item : null; }, 'the Marker conversion to stop');
  assert.equal(job.id, started.jobId);
  assert.equal((await h.call('snapshot')).sources.filter(source => source.document?.converter === 'marker').length, 0);
  const { blocks, converter, pages } = await h.call('mineru.edit.read', { jobId: job.id });
  assert.equal(converter, 'marker');
  assert.equal(pages, 4);
  const page = number => blocks.find(block => block.page === number);
  const imported = await h.call('mineru.edit.import', { jobId: job.id, edits: { [page(1).index]: `first page edited\n{3}${'-'.repeat(48)}\nstill first`, [page(2).index]: null } });
  const done = await until(async () => { const item = (await h.call('snapshot')).jobs.find(entry => entry.id === imported.jobId); return item?.status === 'complete' && item; }, 'the import');
  const sources = (await h.call('export')).sources.filter(source => source.document?.converter === 'marker');
  assert.deepEqual(sources.map(source => source.document.page), [1, 3, 4], 'the pages keep their numbers');
  assert.match(sources[0].text, /first page edited[\s\S]*still first/);
  assert.equal(done.sourceIds.length, 3);
  await until(async () => (await readdir(resultsDir(h.root, job.fingerprint)).catch(() => [])).length === 0, 'the windows to go with the folder, as after any import');
});
