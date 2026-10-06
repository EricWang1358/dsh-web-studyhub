import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPdf, readManifest } from '../lib/mineru-job.js';
import { createMineruClient } from '../lib/mineru-api.js';
import { StudyService } from '../lib/service.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { pdfJob } from './helpers/nonmodel-baseline.mjs';

/* S5-6: the unknown-side-effect and stop/recovery matrix of the non-model paths (docs/plans/unified-job-runtime/s5-6-recovery-matrix.md).
   Rows are paths, columns are three failure points: BEFORE the side effect, COMMITTED but not yet recorded, STOP not confirmed.
   Every cell is a test against a real fake (fake MinerU server, fake CLIs, fake extension); the title starts with its cell. */

/* ---------- PDF (cloud): the import is the commit ---------- */

test('PDF cloud · committed, terminal not saved: a resume after the import happened (crash before the receipt) imports the same pages once, not twice', async t => {
  const fake = await startFakeMineru();
  t.after(() => fake.close());
  const job = await pdfJob(t, { pages: 3 });
  const service = new StudyService(job.library, {});
  t.after(() => service.dispose());
  const client = createMineruClient({ token: fake.token, baseUrl: fake.baseUrl });
  const realImport = input => service.call('materials.document.import', { dataBase64: input.bytes.toString('base64'), filename: input.filename, format: input.format,
    ...(input.title ? { title: input.title } : {}), ...(input.courses ? { courses: input.courses } : {}) });
  const prepared = await job.prepare();
  let crashed = false;
  const run = (manifest, importMerged) => convertPdf({ dir: prepared.dir, manifest, root: job.library, client, sleep: job.sleep, now: job.now, importMerged });
  await assert.rejects(run(prepared.manifest, async input => { const done = await realImport(input); crashed = true; void done; throw new Error('the process died after the import'); }), /died/);
  assert.equal(crashed, true);
  const afterCrash = (await service.call('snapshot')).sources.filter(source => source.document);
  assert.equal(afterCrash.length, 3);
  const uploads = fake.uploads.length;
  await run(await readManifest(prepared.dir), realImport);
  const after = await service.call('snapshot');
  assert.equal(after.sources.filter(source => source.document).length, 3, 'the same three pages, not six');
  assert.equal(new Set(after.sources.filter(source => source.document).map(source => source.document.id)).size, 1, 'one document');
  assert.equal(fake.uploads.length, uploads, 'finished pieces are not uploaded again');
});
