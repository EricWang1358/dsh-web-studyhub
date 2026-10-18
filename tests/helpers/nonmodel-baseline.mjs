import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertPdf, prepareJob } from '../../lib/mineru-job.js';
import { makePdf } from './pdf.mjs';

/* Shared set-up of the S5-0 characterization tests (tests/nonmodel-baseline-*.test.mjs): a private DSH home and library, a PDF on disk, a stand-in for the
   local window runner (it records the windows it was asked for), and `prepare` / `run` over the job functions the real service calls (lib/mineru-job.js). */

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

/** A window runner that writes nothing: page N of the book says "page N". `windows` lists the ranges it was asked for. */
export function standInRunner() {
  const windows = [];
  return { windows, local: { cli: { file: 'stand-in', prefix: [], env: {} }, liveness: false,
    parseWindow: async ({ startPage, endPage, signal }) => {
      signal?.throwIfAborted();
      windows.push([startPage, endPage]);
      return { content: Array.from({ length: endPage - startPage + 1 }, (_, offset) => ({ type: 'text', text: `page ${startPage + offset}`, page_idx: offset })), markers: endPage - startPage + 1, warnings: [] };
    } } };
}

/** The job functions of one PDF of `pages` pages in a private library, converted by the stand-in runner (`runner.windows` lists what it converted). */
export async function pdfJob(t, { pages = 3, extra = {} } = {}) {
  const { home, library } = await isolatedHome(t);
  const source = join(library, 'Book.pdf');
  await writeFile(source, await makePdf({ pages }));
  const imports = [], progress = [], runner = standInRunner();
  const job = {
    home, library, source, imports, progress, runner,
    prepare: (options = {}) => prepareJob({ root: library, source, filename: 'Book.pdf', courses: ['Databases'], tier: 'basic', ...extra, ...options }),
    run: (prepared, options = {}) => convertPdf({ dir: prepared.dir, manifest: prepared.manifest, root: library, local: runner.local, limits: { livenessMs: 0 },
      onProgress: patch => progress.push(patch), importMerged: async input => { imports.push(input); return { sourceIds: ['s1'] }; }, ...options }),
  };
  return job;
}
