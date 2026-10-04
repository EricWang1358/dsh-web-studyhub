import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { existingNoteMaterial } from '../ui/DailyRecap-material.js';
import { noteMaterial } from '../lib/note-material.js';

test('conversion retains course and content, reuses saved content across note revisions, and keeps later changes separate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-recap-material-'));
  const service = new StudyService(root), call = (action, args) => service.call(action, args);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const note = { id: 'recap-db', title: 'A useful recap', markdown: '# A useful recap\n\nReview joins.', daily: { course: 'Databases' }, revision: 2 };
  await service.store.update(state => { state.notes.push({ ...note, kind: 'daily-recap-history', cards: [], status: 'draft' }); });
  const material = await noteMaterial(note);
  assert.deepEqual(await call('note.material.prepare', { id: note.id, expectedRevision: 2 }), material);
  await assert.rejects(call('note.material.prepare', { id: note.id, expectedRevision: 1 }), /已有更新/);
  assert.equal(await existingNoteMaterial(call, material), null);
  const saved = await call('source.add', material);
  assert.deepEqual(saved.courses, ['Databases']);
  assert.equal(saved.text, note.markdown);
  assert.equal(saved.format, 'md');
  assert.equal((await call('materials.document.get', { sourceId: saved.id })).format, 'md');
  const again = await noteMaterial({ ...note, revision: 7 });
  assert.equal(again.id, material.id, 'saving an identical revision must reuse the existing source');
  assert.equal((await existingNoteMaterial(call, again)).id, saved.id);
  const changed = await noteMaterial({ ...note, markdown: `${note.markdown}\n\nReview grouping.` });
  assert.notEqual(changed.id, material.id);
  assert.equal(await existingNoteMaterial(call, changed), null);
  assert.equal((await call('source.get', { id: saved.id })).text, note.markdown, 'updating the recap never overwrites converted material');
  const contract = await call('library.context', { area: 'notes' });
  assert.match(JSON.stringify(contract), /note.material.prepare/);
  assert.match(JSON.stringify(contract), /note.daily.cancel/);
});

test('conversion does not treat unavailable sources as missing or permit empty content', async () => {
  await assert.rejects(existingNoteMaterial(async () => { throw new Error('offline'); }, { id: 'material' }), /offline/);
  assert.throws(() => noteMaterial({ id: 'recap', title: 'Title', markdown: '  ' }), /正文/);
});
