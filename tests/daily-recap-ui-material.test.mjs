import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { existingNoteMaterial, noteMaterial } from '../ui/DailyRecap-material.js';

test('conversion retains course and content, reuses saved content across note revisions, and keeps later changes separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-recap-material-'));
  const service = new StudyService(root), call = (action, args) => service.call(action, args);
  const note = { id: 'recap-db', title: 'A useful recap', markdown: '# A useful recap\n\nReview joins.', daily: { course: 'Databases' }, revision: 2 };
  const material = await noteMaterial(note);
  assert.equal(await existingNoteMaterial(call, material), null);
  const saved = await call('source.add', material);
  assert.deepEqual(saved.courses, ['Databases']);
  assert.equal(saved.text, note.markdown);
  const again = await noteMaterial({ ...note, revision: 7 });
  assert.equal(again.id, material.id, 'saving an identical revision must reuse the existing source');
  assert.equal((await existingNoteMaterial(call, again)).id, saved.id);
  const changed = await noteMaterial({ ...note, markdown: `${note.markdown}\n\nReview grouping.` });
  assert.notEqual(changed.id, material.id);
  assert.equal(await existingNoteMaterial(call, changed), null);
  assert.equal((await call('source.get', { id: saved.id })).text, note.markdown, 'updating the recap never overwrites converted material');
});

test('conversion does not treat unavailable sources as missing or permit empty content', async () => {
  await assert.rejects(existingNoteMaterial(async () => { throw new Error('offline'); }, { id: 'material' }), /offline/);
  await assert.rejects(noteMaterial({ id: 'recap', title: 'Title', markdown: '  ' }), /正文/);
});
