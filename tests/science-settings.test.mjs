import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCIENCE_DEFAULTS, SCIENCE_KEY, normalizeScienceSettings, loadScienceSettings, saveScienceSettings, scienceVars } from '../ui/science-settings.js';
import { validImageMarkdown, omitLocalImagePayloads } from '../lib/study-image-markdown.js';
import { modelServices } from '../lib/runtime/models.js';
import { StudyService } from '../lib/service.js';
import { renderNoteMarkdown } from '../ui/note-markdown.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
test('science preferences persist bounded independent choices and survive blocked or corrupt storage', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const wanted = { ...SCIENCE_DEFAULTS, formulaScale: 150, imageHeight: 540, imageCaptions: false, chemistry: false };
  saveScienceSettings(wanted, storage);
  assert.deepEqual(loadScienceSettings(storage), wanted);
  assert.equal(values.has(SCIENCE_KEY), true);
  values.set(SCIENCE_KEY, '{broken'); assert.deepEqual(loadScienceSettings(storage), SCIENCE_DEFAULTS);
  const hostile = normalizeScienceSettings({ formulaScale: '999px; color:red', imageHeight: -1, formulaAlign: '__proto__', localImages: 'false', symbolic: false });
  assert.deepEqual(hostile, { ...SCIENCE_DEFAULTS, symbolic: false });
  assert.deepEqual(scienceVars(wanted), { '--study-formula-scale': 1.5, '--study-formula-align': 'center', '--study-image-height': '540px' });
  assert.doesNotThrow(() => saveScienceSettings(wanted, { setItem() { throw new Error('blocked'); } }));
});
test('notes allow portable raster bytes without relaxing the original prose budget or active image policy', () => {
  const large = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(180000)]).toString('base64');
  assert.equal(validImageMarkdown('Figure ![diagram](' + large + ')'), true);
  assert.equal(validImageMarkdown('x'.repeat(200001) + ' ![diagram](' + png + ')'), false);
  assert.equal(validImageMarkdown('![bad](data:image/svg+xml;base64,PHN2Zy8+)'), false);
  assert.equal(validImageMarkdown('x'.repeat(3 * 1024 * 1024 + 1)), false);
  assert.equal(validImageMarkdown(undefined), false);
  const html = renderNoteMarkdown('![<diagram>](' + png + ')');
  assert.ok(html.includes('src="' + png + '"'));
  assert.match(html, /&lt;diagram&gt;/); assert.doesNotMatch(html, /<diagram>/);
  assert.doesNotMatch(renderNoteMarkdown('![caption](' + png + ')', { imageCaptions: false }), /md-image-caption/);
  assert.doesNotMatch(renderNoteMarkdown('![bad](data:image/svg+xml;base64,PHN2Zy8+)'), /<img/);
});
test('text model routes and correction workers omit local image bytes and preserve JSON text', async () => {
  const records = [];
  const model = (system, prompt, options) => { records.push({ system, prompt, options }); return 'ok'; };
  model.spawnCorrection = model;
  const services = modelServices({ complete: model, language: 'en' });
  const prompt = JSON.stringify({ text: '![figure](' + png + ') $x^2$' });
  await services.complete('Answer using evidence', prompt);
  await services.light('Answer using evidence', prompt, { stage: 'test' });
  await services.complete.spawnCorrection('Answer using evidence', prompt, { stage: 'test' });
  for (const record of records) {
    assert.doesNotMatch(record.prompt, /iVBOR|data:image/);
    assert.match(record.system, /do not infer/);
    assert.match(JSON.parse(record.prompt).text, /figure.*omitted/);
  }
  assert.equal(omitLocalImagePayloads('No image $x$'), 'No image $x$');
});
test('saved embedded images survive actual note service and storage reopen while stale note saves are refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'science-note-')); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update(s => { s.decks.push({ id: 'deck', title: 'Deck', cards: [{ id: 'card', kind: 'flashcard', prompt: 'Question', answer: 'Answer', citations: [] }] }); });
  const note = await service.call('note.create', { title: 'Image note', cards: [{ deckId: 'deck', cardId: 'card' }] });
  const markdown = 'Image ![diagram](' + png + ')';
  const saved = await service.call('note.save', { id: note.id, markdown, expectedRevision: note.revision });
  const reopened = new StudyService(root);
  assert.equal((await reopened.call('note.get', { id: note.id })).markdown, markdown);
  assert.equal((await reopened.store.read()).notes.find(n => n.id === note.id).markdown, markdown);
  await assert.rejects(service.call('note.save', { id: note.id, markdown: 'stale', expectedRevision: note.revision }), /更新|修订/);
  assert.ok(saved.revision > note.revision);
});
