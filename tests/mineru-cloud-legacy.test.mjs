import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareJob, saveManifest } from '../lib/mineru-job.js';
import { closeRecord, openRecord } from '../lib/mineru-history.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { CONVERT_TEXT } from '../lib/contexts/audio/convert-support.js';
import { MINERU_INSTALL_MESSAGES } from '../lib/mineru-install-text.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { harness } from './helpers/pdf-convert-harness.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* The MinerU cloud route (a token, the PDF uploaded) was removed in 3.6. What is left of it: a request for it is refused with what to do instead, the
   token and test operations are gone, an unfinished cloud conversion comes back failed for good, and old cloud rows still list but never resume. */

test('a cloud import is refused before anything is read, and an import without a route is local', async t => {
  const h = await harness(t, { runtime: false });
  const uploadId = await h.upload(await makePdf({ pages: 3 }));
  await assert.rejects(h.call('mineru.import', { uploadId, route: 'cloud' }), error => error.code === 'cloud-removed' && error.message === MINERU_INSTALL_MESSAGES.cloudRemoved);
  assert.deepEqual(await h.jobs(), []);
  await assert.rejects(h.call('mineru.import', { uploadId, route: 'remote' }), /local 或 auto/);
  await h.set({ total: 3 });
  const { jobId } = await h.call('mineru.import', { uploadId });
  const done = await h.settled(jobId);
  assert.deepEqual([done.status, done.route], ['complete', 'local']);
});

test('the token, consent, test and old setup operations are gone for every door', async t => {
  const h = await harness(t, { runtime: false });
  for (const action of ['mineru.settings.get', 'mineru.settings.set', 'mineru.test', 'mineru.local.setup', 'mineru.local.setup.status', 'mineru.local.setup.cancel'])
    await assert.rejects(h.call(action, {}), /Unknown/, action);
  assert.equal(assistantRefusal('mineru.settings.set'), null, 'nothing left to refuse: the operation does not exist');
});

test('an unfinished conversion of the cloud route, or from before routes existed, comes back failed for good with what to do instead', async t => {
  const h = await harness(t, { runtime: false });
  const made = [];
  for (const route of ['cloud', undefined]) {
    const source = join(h.root, `${route || 'old'}.pdf`);
    await writeFile(source, await makePdf({ pages: 3 }));
    const prepared = await prepareJob({ root: h.root, source, filename: `${route || 'old'}.pdf`, courses: [], route: 'local' });
    // What an older version left on disk: a cloud manifest, or one without a route at all.
    if (route) prepared.manifest.route = route; else delete prepared.manifest.route;
    await saveManifest(prepared.dir, prepared.manifest);
    made.push(prepared.manifest.id);
  }
  const { StudyService } = await import('../lib/service.js');
  const again = new StudyService(h.root, { mineru: { limits: { windowPages: 200, livenessMs: 0 }, local: { cli: h.cli, home: h.work } } });
  t.after(() => again.dispose());
  const rows = (await again.call('mineru.history.list')).records.filter(record => made.includes(record.id));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual([row.route, row.canRetry], ['cloud', false]);
  const jobs = (await again.call('snapshot')).jobs.filter(job => made.includes(job.id));
  for (const job of jobs) {
    assert.deepEqual([job.status, job.retryable, job.errorCode], ['failed', false, 'cloud-removed']);
    assert.equal(job.stage, CONVERT_TEXT.cloudGone);
    await assert.rejects(again.call('mineru.retry', { jobId: job.id }), /云端解析已停用|不能重试/);
  }
});

test('an old cloud history row lists with its route and never offers 接着做; removing it still works', async t => {
  const h = await harness(t, { runtime: false });
  await openRecord(h.root, { id: 'job-cloud-old', filename: 'Old.pdf', bytes: 10, pages: 450, pieces: 3, route: 'cloud' });
  await closeRecord(h.root, 'job-cloud-old', { status: 'failed', pagesDone: 200, failure: { stage: 'parse', piece: 2, reason: 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。', code: 'invalid-token' } });
  const [row] = (await h.call('mineru.history.list')).records;
  assert.deepEqual([row.route, row.status, row.canRetry], ['cloud', 'failed', false]);
  assert.equal((await h.call('mineru.history.remove', { id: row.id })).removed, true);
});

test('every new sentence of the removal has its English form', () => {
  for (const text of [CONVERT_TEXT.cloudGone, MINERU_INSTALL_MESSAGES.cloudRemoved, MINERU_INSTALL_MESSAGES.notInstalled, MINERU_INSTALL_MESSAGES.installing])
    assert.notEqual(localizeAppMessage(text, 'en'), text, text);
});
