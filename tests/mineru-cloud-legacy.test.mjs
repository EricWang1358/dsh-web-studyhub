import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareJob, saveManifest } from '../lib/mineru-job.js';
import { closeRecord, openRecord } from '../lib/mineru-history.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { MINERU_INSTALL_MESSAGES } from '../lib/mineru-install-text.js';
import { NO_MINERU_ACK, NO_MINERU_TOKEN } from '../lib/mineru-settings.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { harness } from './helpers/pdf-convert-harness.mjs';
import { makePdf } from './helpers/pdf.mjs';

/* Issue #1765: MinerU cloud / third-party route is back as an optional provider while local remains the default.
   Old cloud manifests recover cleanly (resumable or switchable to local), legacy cloud history rows remain readable,
   and mineru.settings.set stays strictly Settings-only for the assistant. */

test('a cloud import without key is refused cleanly before anything is read, and an import without a route is local', async t => {
  const h = await harness(t, { runtime: false });
  const uploadId = await h.upload(await makePdf({ pages: 3 }));
  await assert.rejects(h.call('mineru.import', { uploadId, route: 'cloud' }), error => error.code === 'no-token' && error.message === NO_MINERU_TOKEN);
  assert.deepEqual(await h.jobs(), []);
  await assert.rejects(h.call('mineru.import', { uploadId, route: 'remote' }), /local、cloud 或 auto/);
  await h.set({ total: 3 });
  const { jobId } = await h.call('mineru.import', { uploadId });
  const done = await h.settled(jobId);
  assert.deepEqual([done.status, done.route], ['complete', 'local']);
});

test('mineru.settings.* and mineru.test are restored, mineru.settings.set is Settings-only, and old mineru.local.setup.* stay gone', async t => {
  const h = await harness(t, { runtime: false });
  const pub = await h.call('mineru.settings.get', {});
  assert.equal(pub.mode, 'local');
  assert.equal(pub.token.set, false);
  const tested = await h.call('mineru.test', {});
  assert.deepEqual([tested.ok, tested.state], [false, 'missing']);
  for (const action of ['mineru.local.setup', 'mineru.local.setup.status', 'mineru.local.setup.cancel'])
    await assert.rejects(h.call(action, {}), /Unknown/, action);
  assert.match(assistantRefusal('mineru.settings.set') || '', /not available to the assistant/);
});

test('an unfinished cloud conversion recovered after restart can be switched directly to local', async t => {
  const h = await harness(t, { runtime: false });
  const made = [];
  for (const route of ['cloud', undefined]) {
    const source = join(h.root, `${route || 'old'}.pdf`);
    await writeFile(source, await makePdf({ pages: 3 }));
    const prepared = await prepareJob({ root: h.root, source, filename: `${route || 'old'}.pdf`, courses: [], route: 'local' });
    if (route) prepared.manifest.route = route; else delete prepared.manifest.route;
    await saveManifest(prepared.dir, prepared.manifest);
    made.push(prepared.manifest.id);
  }
  const { StudyService } = await import('../lib/service.js');
  const again = new StudyService(h.root, { mineru: { limits: { windowPages: 200, livenessMs: 0 }, local: { cli: h.cli, home: h.work } } });
  t.after(() => again.dispose());
  await h.set({ total: 3 });
  const rows = (await again.call('mineru.history.list')).records.filter(record => made.includes(record.id));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual([row.route, row.canRetry], ['cloud', true]);
  const jobs = (await again.call('snapshot')).jobs.filter(job => made.includes(job.id));
  for (const job of jobs) {
    assert.deepEqual([job.status, job.retryable], ['failed', true]);
    assert.notEqual(job.errorCode, 'cloud-removed');
  }
  // Switch one recovered cloud job to local and watch it finish!
  await again.call('mineru.retry', { jobId: made[0], route: 'local' });
  const done = await (async () => {
    for (let i = 0; i < 400; i++) {
      const current = (await again.call('snapshot')).jobs.find(j => j.id === made[0]);
      if (current && !['queued', 'running', 'cancelling'].includes(current.status)) return current;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for switched job');
  })();
  assert.deepEqual([done.status, done.route], ['complete', 'local']);
});

test('an old cloud history row without temporary files lists with its route and offers no retry; removing it still works', async t => {
  const h = await harness(t, { runtime: false });
  await openRecord(h.root, { id: 'job-cloud-old', filename: 'Old.pdf', bytes: 10, pages: 450, pieces: 3, route: 'cloud' });
  await closeRecord(h.root, 'job-cloud-old', { status: 'failed', pagesDone: 200, failure: { stage: 'parse', piece: 2, reason: 'MinerU 令牌无效：请到「设置 › PDF 转换（MinerU）」检查接口地址并重新粘贴有效的密钥。', code: 'invalid-token' } });
  const [row] = (await h.call('mineru.history.list')).records;
  assert.deepEqual([row.route, row.status, row.canRetry], ['cloud', 'failed', false]);
  assert.equal((await h.call('mineru.history.remove', { id: row.id })).removed, true);
});

test('every new cloud/local sentence has its English form', () => {
  for (const text of [NO_MINERU_TOKEN, NO_MINERU_ACK, MINERU_INSTALL_MESSAGES.notInstalled, MINERU_INSTALL_MESSAGES.installing])
    assert.notEqual(localizeAppMessage(text, 'en'), text, text);
});
