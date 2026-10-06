import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { createFakeModel } from '../../scripts/fake-model.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { until } from './wait.mjs';

/* A library with a four-page course and the search-index build on the runtime, with a fake extension; nothing is indexed anywhere. */

export const INDEX_KIND = 'retrieval-index', PAGES = 4;

export async function library(t, fake, { runtime = {}, name = 'OS' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-index-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-index-lib-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const { starts: _starts, ...options } = managedRuntimeOptions({ paths: ['retrievalIndex'] });
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port, ...options, ...runtime });
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 5 }); await rm(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const book = Array.from({ length: PAGES }, (_, index) => `<!-- page: ${index + 1} -->\n${name} 第 ${index + 1} 页讲进程。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: `${name}.md`, courses: [name] });
  const jobs = async () => (await service.call('snapshot')).jobs.filter(job => job.type === INDEX_KIND);
  const status = () => service.call('retrieval.index.status', {});
  const finished = what => until(async () => { const run = await status(); return ['complete', 'failed', 'cancelled'].includes(run.status) ? run : null; }, what);
  return { service, root, home, jobs, status, finished };
}
