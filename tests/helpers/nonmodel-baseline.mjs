import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertPdf, prepareJob } from '../../lib/mineru-job.js';
import { makePdf } from './pdf.mjs';

/* Shared set-up of the S5-0 characterization tests (tests/nonmodel-baseline-*.test.mjs): a private DSH home and library, a PDF on disk,
   a clock that never waits, and `prepare` / `run` over the job functions the real service calls (lib/mineru-job.js). */

/** A private DSH_HOME and library folder; both are removed (and DSH_HOME restored) when the test ends. */
export async function isolatedHome(t, prefix = 'nonmodel-baseline') {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-home-`)), library = await mkdtemp(join(tmpdir(), `${prefix}-lib-`));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    for (const folder of [home, library]) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, library };
}

/** The job functions of one PDF of `pages` pages in a private library; `clock.slept` lists every wait the job asked for (none is real). */
export async function pdfJob(t, { pages = 3, extra = {} } = {}) {
  const { home, library } = await isolatedHome(t);
  const source = join(library, 'Book.pdf');
  await writeFile(source, await makePdf({ pages }));
  const clock = { time: 1_000_000, slept: [] }, imports = [], progress = [];
  const job = {
    home, library, source, clock, imports, progress,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.slept.push(ms); clock.time += ms; },
    now: () => clock.time,
    prepare: (options = {}) => prepareJob({ root: library, source, filename: 'Book.pdf', courses: ['Databases'], ...extra, ...options }),
    run: (prepared, options = {}) => convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: library, sleep: job.sleep, now: job.now,
      onProgress: patch => progress.push(patch), importMerged: async input => { imports.push(input); return { sourceIds: ['s1'] }; }, ...options }),
  };
  return job;
}
