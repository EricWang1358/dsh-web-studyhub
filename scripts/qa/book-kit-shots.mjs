/* KIT_SHOTS=<dir> [BOOK_DIST=dist] node scripts/qa/book-kit-shots.mjs   (build first: node scripts/build.mjs)
   复习全书 S4 (#710): the exam answer kit in the real page. A temporary library is seeded with the synthetic 134-material course of
   tests/helpers/course-outline-library.mjs and two sample papers (its SA 2025 样卷 and a SA 2024 样卷 whose questions test the same points), and the review
   book is BUILT through the real Job with the fake book model (tests/helpers/course-book-model.mjs): the kit is the stage's own output, not a hand-made record.
   Then, in Chinese and light, at 1440 and 420 px, it opens 更多 › 答题模板… and saves <width>-kit-top.png (the dialog as it opens), <width>-kit-card.png (a
   card with two past questions), <width>-kit-matrix.png (the signal matrix) and <width>-kit-tip.png (a past question's words on hover). It prints the dialog's
   numbers (cards, rows, slots, horizontal overflow) as one JSON line per width. Seeded temporary library, fake model, no network, no key. */
/* global document */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { openPage, settleAnimations, startLateServer } from './layout-late.mjs';
import { openBook } from './book-shots.mjs';
import { StudyService } from '../../lib/service.js';
import { COURSE, outlineLibrary } from '../../tests/helpers/course-outline-library.mjs';
import { bookModel } from '../../tests/helpers/course-book-model.mjs';
import { switchOptions } from '../../tests/helpers/runtime-switch.mjs';
import { settleJob } from '../../tests/helpers/wait.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** A second sample paper: the same three points asked again in other words (its Q2 and Q3 join the 2025 paper's in two types of two questions). */
const PAPER_2024 = ['Q1 Compare a view with a viewpoint for the payment system, and say which one a stakeholder reads. (10 marks)',
  'Q2 Write a quality attribute scenario for performance under the exam-week peak. (10 marks)',
  'Q3 Compare an API gateway with a service mesh for the mobile shop. (10 marks)'].join('\n');

/** The library: the course with two sample papers, and its review book built by the real Job with the fake book model. */
async function seedKitLibrary(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel(), built = outlineLibrary({ paper: true }), paper = built.sources.find(source => source.id === 'paper-2025');
  const second = { ...paper, id: 'paper-2024', title: 'SA 2024 样卷', text: PAPER_2024, createdAt: '2026-09-30T00:00:00.000Z',
    document: { ...paper.document, materialId: 'document-paper-2024', filename: 'SA 2024 样卷.md' } };
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  try {
    await service.store.update(state => { state.sources.push(...structuredClone([...built.sources, second])); state.decks.push(...structuredClone(built.decks));
      state.focus = { mode: 'class', course: COURSE }; });
    const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh' })).jobId);
    if (job.status !== 'complete') throw new Error(`the book build ended ${job.status}`);
    return { kitCalls: fake.of('kit').length, types: fake.of('kit').flatMap(call => call.data.types).length };
  } finally { await service.dispose(); }
}

/** In the page: what the dialog holds and whether anything is wider than it. */
const measure = () => {
  const dialog = document.querySelector('dialog.book-kit-dialog'), body = dialog?.querySelector('.book-kit');
  return { cards: dialog?.querySelectorAll('.book-kit__type').length ?? 0, rows: dialog?.querySelectorAll('.book-kit__row').length ?? 0,
    slots: dialog?.querySelectorAll('.book-kit__slot').length ?? 0, overflowX: body ? body.scrollWidth - body.clientWidth : null,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
};

async function lookAt(browser, running, { width, shots }) {
  const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme: 'light' });
  const save = async (shot, locator) => { await page.waitForTimeout(250); await settleAnimations(page); await (locator ?? page).screenshot({ path: join(shots, `${width}-kit-${shot}.png`) }); };
  try {
    await openBook(page, running);
    await page.locator('.book-bar__more').click();
    await page.getByRole('menuitem', { name: '答题模板…' }).click();
    await page.locator('dialog.book-kit-dialog .book-kit').waitFor({ timeout: 30000 });
    await page.mouse.move(width - 10, 890);
    await save('top');
    const numbers = await page.evaluate(measure);
    const card = page.locator('.book-kit__type').filter({ has: page.locator('.book-kit__fill:nth-child(2)') }).first();
    if (await card.count()) { await card.scrollIntoViewIfNeeded(); await save('card'); }
    await page.locator('.book-kit__matrix').scrollIntoViewIfNeeded();
    await save('matrix');
    const ref = page.locator('.book-kit__ref').first();
    await ref.scrollIntoViewIfNeeded();
    await ref.hover();
    await page.waitForTimeout(600);
    await save('tip');
    return { numbers, errors };
  } finally { await context.close(); }
}

export async function bookKitShots({ shots = process.env.KIT_SHOTS, dist = process.env.BOOK_DIST } = {}) {
  if (!shots) throw new Error('KIT_SHOTS=<dir> is required');
  await mkdir(shots, { recursive: true });
  const browser = await launchChromium();
  const running = await startLateServer({ distDir: resolve(repoRoot, dist || 'dist'), seed: seedKitLibrary });
  try {
    await running.api('focus.set', { course: COURSE });
    console.log(JSON.stringify({ seeded: running.seeded }));
    for (const width of [1440, 420]) {
      const { numbers, errors } = await lookAt(browser, running, { width, shots });
      if (errors.length) console.error(`${width}: page errors ${JSON.stringify(errors)}`);
      console.log(JSON.stringify({ width, ...numbers }));
    }
  } finally { await running.close(); await browser.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bookKitShots().catch(error => { console.error(error); process.exitCode = 1; });
}
