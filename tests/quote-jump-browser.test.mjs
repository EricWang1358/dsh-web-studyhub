/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { until } from './helpers/wait.mjs';

/* Question <-> source: the reader finds a citation the way the citation was checked (letters and digits), also when it is not a literal
   substring of the stored text, and shows a plain notice when it cannot. Set JUMP_FALLBACK_SHOTS=<dir> to keep a screenshot of each step. */

const FILLER = Array.from({ length: 40 }, (_, n) => `Filler paragraph ${n + 1} says nothing about the cited passage, it only makes the page long enough to scroll.`).join('\n\n');
const NOTES = `# Indexes\n\n${FILLER}\n\n## B-trees\n\nThe **B-tree** keeps keys in sorted or-\nder so range scans read pages in sequence, which is why databases use it.\n\n${FILLER}\n`;
const LINES = (page, extra) => Array.from({ length: 14 }, (_, line) => (line === 10 && extra ? extra : `Page ${page} line ${line + 1} is ordinary course text that has no bearing on the question.`));
const PAGES = [1, 2, 3, 4, 5, 6].map((page) => LINES(page, page === 5 ? 'Virtual memory gives every process its own address space that the kernel maps onto physical frames.' : ''));

const CASES = [
  { prompt: 'Why use a B-tree for ranges?', find: 'keepskeysinsortedordersorangescansreadpages', kind: 'markdown' },
  { prompt: 'What does virtual memory give a process?', find: 'givesevery' + 'process' + 'itsownaddressspacethatthekernelmaps', kind: 'pdf' },
  { prompt: 'What does coalescing do to interrupts?', find: null, kind: 'pdf-unfound' },
];

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const notes = await runtime.call('materials.document.import', { filename: 'index-notes.md', courses: ['QA'], dataBase64: Buffer.from(NOTES).toString('base64') });
  const pdf = await runtime.call('materials.document.import', { filename: 'operating-systems.pdf', courses: ['QA'], dataBase64: (await makeTextPdf(PAGES)).toString('base64') });
  runtime.dispose();
  const card = (id, prompt, sourceId, quote) => ({ id, kind: 'flashcard', topic: 'Quote jump', objective: `Objective ${id}`, prompt, answer: `Answer to ${prompt}`, hint: 'Think.',
    explanation: 'Because it is in the text.', misconception: 'The common mistake.', citations: [{ sourceId, quote }] });
  await new Store(root).update((state) => {
    state.decks.push({ id: 'jump', title: 'Quote jump', course: 'QA', cards: [
      // Not substrings of the stored text: markup and a hyphenated line break; a hyphen inside a word; words that are on no page at all.
      card('c1', CASES[0].prompt, notes.sourceIds[0], 'keeps keys in sorted order so range scans read pages'),
      card('c2', CASES[1].prompt, pdf.sourceIds[4], 'gives every proc-ess its own address space that the kernel maps'),
      card('c3', CASES[2].prompt, pdf.sourceIds[5], 'Interrupt coalescing batches many completions into one signal'),
    ] });
  });
}

/** The highlighted passage of the reader: its words and whether it is inside the reading area. */
const highlight = (page) => page.evaluate(() => {
  const set = window.CSS?.highlights?.get('study-source-quote');
  const range = set ? [...set][0] : null;
  if (!range) return null;
  const rect = range.getBoundingClientRect(), area = document.querySelector('.study-document-viewer .reader-scroll').getBoundingClientRect();
  return { text: range.toString(), top: rect.top, bottom: rect.bottom, areaTop: area.top, areaBottom: area.bottom, inView: rect.height > 0 && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1 };
});

for (const width of [1280, 420]) {
  test(`${width}px: a citation that is not a literal substring is highlighted and in view; one that is nowhere says so`, { timeout: 600000 }, async (t) => {
    let browser;
    try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
    const dist = await mkdtemp(join(tmpdir(), 'study-jump-dist-'));
    await buildPreview({ outdir: dist });
    const running = await startLateServer({ distDir: dist, seed });
    const shots = process.env.JUMP_FALLBACK_SHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${width}-${name}.png`) }); };
    const { context, page, errors } = await openPage(browser, running, { width, height: 900 });
    try {
      await page.goto(running.server.url);
      await page.getByRole('button', { name: '开始今日学习' }).first().click();
      await page.locator('.review-page').waitFor();
      const seen = new Set();
      for (let guard = 0; guard < 6 && seen.size < CASES.length; guard += 1) {
        const text = await page.locator('.review-page').innerText();
        const current = CASES.find((one) => text.includes(one.prompt));
        assert.ok(current, `a seeded question is on the page: ${text.slice(0, 80)}`);
        assert.ok(!seen.has(current.kind), `${current.kind} is shown once`);
        seen.add(current.kind);
        const button = page.getByRole('button', { name: '看这题的原文' });
        assert.equal(await button.count(), 0, `${current.kind}: no source button before the question is answered`);
        await page.locator('.review-heading h1').first().click().catch(() => {});
        await page.keyboard.press('Space');
        await page.waitForTimeout(400);
        assert.equal(await button.count(), 0, `${current.kind}: none while the answer is only revealed`);
        await page.keyboard.press('5'); // a right answer: the source is one click away too
        await button.waitFor({ timeout: 15000 });
        await button.scrollIntoViewIfNeeded();
        await shot(page, `${current.kind}-after-answer`);
        await button.click();
        const viewer = page.locator('.study-document-viewer');
        await viewer.waitFor();
        await viewer.locator('.reader-scroll').waitFor();
        await page.waitForTimeout(900);
        const notices = await viewer.locator('.study-document-notices').innerText();
        if (current.find) {
          let found;
          await until(async () => (found = await highlight(page)), `${current.kind}: a highlighted passage`, { timeoutMs: 20000 });
          assert.equal(found.text.replace(/[^A-Za-z0-9]/g, '').toLowerCase(), current.find, `${current.kind}: the highlight covers the citation (${JSON.stringify(found.text)})`);
          assert.ok(found.inView, `${current.kind}: the highlight is in view (${found.top}..${found.bottom} in ${found.areaTop}..${found.areaBottom})`);
          assert.ok(!notices.includes('没能精确定位'), `${current.kind}: nothing to apologise for`);
        } else {
          assert.equal(await highlight(page), null, 'nothing is highlighted for a citation that is nowhere');
          assert.ok(notices.includes('没能精确定位这段引文，已显示所在资料'), `the notice is shown: ${JSON.stringify(notices)}`);
          const where = await page.evaluate(() => {
            const section = document.querySelector('.study-document-viewer [data-study-page="6"]'), area = document.querySelector('.study-document-viewer .reader-scroll').getBoundingClientRect();
            const rect = section?.getBoundingClientRect();
            return rect ? { top: rect.top - area.top, height: area.height } : null;
          });
          assert.ok(where && where.top < where.height, `the page of the citation is shown (${JSON.stringify(where)})`);
        }
        await shot(page, `${current.kind}-reader`);
        await viewer.getByRole('button', { name: '回到这道题' }).click();
        await page.locator('.review-page').waitFor();
        assert.equal(await viewer.count(), 0, 'back at the question');
        await page.locator('.review-heading h1').first().click().catch(() => {});
        await page.keyboard.press('Enter');
        await until(async () => !(await page.locator('.review-page').innerText().catch(() => current.prompt)).includes(current.prompt) || (await page.locator('.result-page').count()), 'the next question', { timeoutMs: 15000 });
      }
      assert.equal(seen.size, CASES.length, 'all three kinds were looked at');
      assert.deepEqual(errors, [], 'no console or page errors');
    } finally {
      await context.close();
      await browser.close();
      await running.close();
    }
  });
}
