/* global document, localStorage, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #1197 browser acceptance:
   A course with chaptered PDF materials and NO skeleton:
   1. On the practice page at 1280 and 420 px (zh and en), `.review-heading-links` shows `出处 · {资料名} › {章名}` / `Source · ...`,
      truncates long titles inside a single line without overflowing horizontally or squeezing other links, carries the full path in Tooltip
      (never `title=`), and stays absent in exam mode.
   2. Clicking `出处` opens the course outline with the cited document and chapter expanded and scrolled into view, and the outline header
      back button returns directly to the same question. */

const COURSE = 'Distributed Systems';
const DOC_TITLE = 'Distributed Systems Lecture Notes';
const DECK_TITLE = 'Consensus & Replication';
const CHAPTERS = [
  'Clock Synchronization',
  'Logical Time and Vector Clocks',
  'Consensus, Paxos and Raft Leader Election Under Network Partitions',
  'Distributed Snapshots',
  'Replication Logs',
  'Two-Phase Commit',
];
const at = '2026-10-05T08:00:00.000Z';
const quoteOf = (index) => `Chapter ${index + 1} (${CHAPTERS[index]}) guarantees monotonic safety across replicas.`;

async function seedLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'question-place-browser-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.call('snapshot');
  await service.store.update((state) => {
    CHAPTERS.forEach((title, index) => {
      state.sources.push({
        id: `ds-p${index + 1}`,
        title: `${DOC_TITLE} · p. ${index + 1}`,
        text: `${quoteOf(index)} Extra lecture details for section ${index + 1}.`,
        createdAt: at,
        courses: [COURSE],
        document: {
          materialId: 'ds-notes-pdf',
          page: index + 1,
          totalPages: CHAPTERS.length,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: `${DOC_TITLE}.pdf`,
          chapter: { index, title, level: 1 },
          extractionVersion: 2,
        },
      });
    });
    state.decks.push({
      id: 'ds-deck',
      title: DECK_TITLE,
      course: COURSE,
      cards: [
        {
          id: 'c-raft',
          kind: 'quiz',
          topic: 'Consensus',
          prompt: 'Which mechanism ensures leader election safety during a network partition in Raft?',
          answer: 'Majority quorum and term numbers.',
          options: [
            { id: 'a', text: 'Majority quorum and up-to-date log term checks', correct: true, explanation: 'Candidates need votes from a majority and at least as up-to-date a log.' },
            { id: 'b', text: 'Static priority configured by node IP', correct: false, explanation: 'Raft uses randomized election timeouts and term-checked quorums.' },
            { id: 'c', text: 'Broadcasting timestamps without persistence', correct: false, explanation: 'Terms must be persisted cleanly.' },
          ],
          citations: [{ sourceId: 'ds-p3', quote: quoteOf(2) }],
        },
        {
          id: 'c-snap',
          kind: 'quiz',
          topic: 'Replication',
          prompt: 'Why must replication logs keep entries in strict sequence order?',
          answer: 'State machines apply committed operations deterministically in log order.',
          options: [
            { id: 'a', text: 'Deterministic state machine replay requires identical order', correct: true, explanation: 'All replicas apply the same sequence.' },
            { id: 'b', text: 'Network packets always arrive in order', correct: false, explanation: 'Networks reorder packets.' },
            { id: 'c', text: 'Disks refuse random reads', correct: false, explanation: 'Order guarantees consistency.' },
          ],
          citations: [{ sourceId: 'ds-p5', quote: quoteOf(4) }],
        },
      ],
    });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  await service.dispose();
  return root;
}

const WORDS = {
  zh: {
    start: `开始学习 ${DECK_TITLE}`,
    prefix: '出处 ·',
    outlineHeading: new RegExp(`总纲 · ${COURSE}`),
    backToQuestion: /回到之前的第 1 题/,
  },
  en: {
    start: `Start studying ${DECK_TITLE}`,
    prefix: 'Source ·',
    outlineHeading: new RegExp(`Course outline · ${COURSE}`),
    backToQuestion: /Return to previous question \(1\)/,
  },
};

test('question source place renders cleanly at 1280 and 420 px, hides in exam mode, jumps to outline chapter and returns (zh & en)', { timeout: 600000 }, async (t) => {
  const root = await seedLibrary(t);
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }

  const shots = process.env.STUDYHUB_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  for (const lang of ['zh', 'en']) {
    const words = WORDS[lang];
    for (const [width, height] of [[1280, 800], [420, 900]]) {
      const where = `${lang} ${width}px`;
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));

      await page.addInitScript((language) => {
        localStorage.setItem('study-ui-language', language);
        localStorage.setItem('study-autopilot', 'off');
      }, lang);

      await page.goto(server.url);
      await page.getByRole('button', { name: words.start }).first().click();

      const placeLocator = page.locator('[data-review-place]');
      await placeLocator.waitFor({ state: 'visible', timeout: 30000 });

      const metrics = await page.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width };
        };
        const place = document.querySelector('[data-review-place]');
        const links = place.closest('.review-heading-links');
        const header = place.closest('header');
        const children = [...links.children].map((el) => ({ tag: el.tagName, cls: el.className, box: box(el) }));
        return {
          viewport: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          placeText: place.textContent.trim(),
          placeTag: place.tagName,
          placeBox: box(place),
          headerBox: box(header),
          linksCut: links.scrollWidth > links.clientWidth + 1,
          hasTitleAttr: Boolean(links.querySelector('[title]')),
          hasSkeleton: /知识骨架|Knowledge outline/.test(links.textContent || ''),
          children,
        };
      });

      assert.equal(metrics.placeTag, 'BUTTON', `${where}: clickable outline button when course has materials`);
      assert.ok(metrics.placeText.startsWith(`${words.prefix} ${DOC_TITLE} › ${CHAPTERS[2].slice(0, 12)}`), `${where}: shows doc › chapter (${metrics.placeText})`);
      assert.equal(metrics.hasTitleAttr, false, `${where}: uses Tooltip, never HTML title=`);
      assert.equal(metrics.hasSkeleton, false, `${where}: test course has no skeleton`);
      assert.ok(metrics.scrollWidth <= metrics.viewport, `${where}: no horizontal overflow (${metrics.scrollWidth} > ${metrics.viewport})`);
      assert.equal(metrics.linksCut, false, `${where}: review-heading-links does not overflow horizontally`);
      assert.ok(metrics.placeBox.height <= 44, `${where}: place button stays single-line (${metrics.placeBox.height}px)`);
      assert.ok(
        metrics.placeBox.left >= metrics.headerBox.left - 1 && metrics.placeBox.right <= Math.min(metrics.headerBox.right, metrics.viewport) + 1,
        `${where}: place fits inside heading bounds`,
      );
      for (const child of metrics.children) {
        if (child.box.width === 0) continue;
        assert.ok(
          child.box.left >= metrics.headerBox.left - 1 && child.box.right <= Math.min(metrics.headerBox.right, metrics.viewport) + 1,
          `${where}: link child (${child.cls}) fits within header/viewport`,
        );
      }

      if (shots) {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(shots, `question-place-${lang}-${width}.png`) });
      }

      await placeLocator.hover();
      const tooltip = page.locator('[role="tooltip"]', { hasText: CHAPTERS[2] }).first();
      await tooltip.waitFor({ state: 'visible', timeout: 10000 });

      // Click 出处 -> navigates to course outline, expands target document & chapter #2, scrolls into view, and returns cleanly.
      await placeLocator.click();
      await page.locator('.outline-tree').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.outline-page h1').innerText(), words.outlineHeading, `${where}: navigated to course outline`);

      const chapterRow = page.locator('[data-key="pdf:ds-notes-pdf#2"]');
      await chapterRow.waitFor({ state: 'visible', timeout: 30000 });
      assert.equal(await page.locator('[data-outline-toggle="pdf:ds-notes-pdf"]').getAttribute('aria-expanded'), 'true', `${where}: document row expanded`);
      assert.equal(await page.locator('[data-outline-toggle="pdf:ds-notes-pdf#2"]').getAttribute('aria-expanded'), 'true', `${where}: chapter #2 row expanded`);
      assert.equal(await page.locator('[data-outline-toggle="pdf:ds-notes-pdf#0"]').getAttribute('aria-expanded'), 'false', `${where}: unrelated chapter #0 stays collapsed`);
      await chapterRow.locator('.outline-q').first().waitFor({ state: 'visible', timeout: 15000 });

      const outlineMetrics = await page.evaluate(() => {
        const row = document.querySelector('[data-key="pdf:ds-notes-pdf#2"]');
        const r = row.getBoundingClientRect();
        return {
          inViewport: r.bottom > 0 && r.top < window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        };
      });
      assert.equal(outlineMetrics.inViewport, true, `${where}: target chapter scrolled into viewport`);
      assert.ok(outlineMetrics.scrollWidth <= outlineMetrics.viewport, `${where}: outline has no horizontal overflow`);

      await page.locator('.outline-header').getByRole('button', { name: words.backToQuestion }).click();
      await page.locator('[data-review-place]').waitFor({ state: 'visible', timeout: 30000 });
      assert.match(await page.locator('.question').innerText(), /leader election safety/i, `${where}: returned to the same question`);

      assert.deepEqual(errors, [], `${where}: zero page errors`);

      for (const openRun of (await previewCall(server, 'snapshot', {})).runs || []) {
        await previewCall(server, 'review.end', { runId: openRun.id });
      }
      await context.close();
    }
  }

  // Second question updates 出处, and completing the round or running an exam hides 出处.
  const examContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const examPage = await examContext.newPage();
  await examPage.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-autopilot', 'off'); });
  await examPage.goto(server.url);
  await examPage.getByRole('button', { name: WORDS.zh.start }).first().click();
  await examPage.locator('[data-review-place]').waitFor({ state: 'visible', timeout: 30000 });
  // Answer Q1 -> Next -> Q2 shows Replication Logs -> Answer Q2 -> Finish -> round complete hides 出处.
  await examPage.locator('.option', { hasText: 'Majority quorum' }).click();
  await examPage.locator('[data-usage="review.next"]:not([disabled])').click();
  await examPage.locator('[data-review-place]', { hasText: CHAPTERS[4] }).waitFor({ state: 'visible', timeout: 15000 });
  await examPage.locator('.option', { hasText: 'Deterministic state machine' }).click();
  await examPage.locator('[data-usage="review.next"]:not([disabled])').click();
  await examPage.locator('.result-page').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await examPage.locator('[data-review-place]').count(), 0, 'completed round hides 出处');

  const entry = await revealNavRow(examPage, 'exam');
  await entry.dispatchEvent('click');
  await examPage.locator('.es-sheet').waitFor({ timeout: 30000 });
  await examPage.getByRole('button', { name: '开始考试' }).click();
  await examPage.locator('.exam-card').waitFor({ timeout: 30000 });
  await examPage.waitForTimeout(200);
  assert.equal(await examPage.locator('[data-review-place]').count(), 0, 'exam mode does not render 出处');
  for (const openRun of (await previewCall(server, 'snapshot', {})).runs || []) {
    await previewCall(server, 'review.end', { runId: openRun.id });
  }
  await examContext.close();
});
