/* global document, localStorage, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { confirmStart } from '../scripts/qa/confirm-start.mjs';

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
      await confirmStart(page);

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
      assert.equal(await page.locator('.context-return').count(), 0, `${where}: outline from review hides duplicate .context-return banner`);
      assert.equal(await page.locator('.outline-header').getByRole('button', { name: words.backToQuestion }).count(), 1, `${where}: outline header shows single return button`);
      assert.equal(await page.getByRole('button', { name: words.backToQuestion }).count(), 1, `${where}: only one return-to-question control is rendered`);

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
  await confirmStart(examPage);
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

const BOOK2_TITLE = 'Replication Handbook';
const BOOK2_CHAPTERS = [
  'State Machine Basics',
  'Quorum Intersection',
  'Byzantine Fault Tolerance Under Partial Synchrony',
];
const quoteBOf = (index) => `Handbook chapter ${index + 1} (${BOOK2_CHAPTERS[index]}) enforces linearizable state.`;

async function seedMultiDeckLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'question-place-multi-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.call('snapshot');
  await service.store.update((state) => {
    CHAPTERS.slice(0, 3).forEach((title, index) => {
      state.sources.push({
        id: `ds-p${index + 1}`,
        title: `${DOC_TITLE} · p. ${index + 1}`,
        text: `${quoteOf(index)} Extra lecture details for section ${index + 1}.`,
        createdAt: at,
        courses: [COURSE],
        document: {
          materialId: 'ds-notes-pdf',
          page: index + 1,
          totalPages: 3,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: `${DOC_TITLE}.pdf`,
          chapter: { index, title, level: 1 },
          extractionVersion: 2,
        },
      });
    });
    BOOK2_CHAPTERS.forEach((title, index) => {
      state.sources.push({
        id: `ds-b2-p${index + 1}`,
        title: `${BOOK2_TITLE} · p. ${index + 1}`,
        text: `${quoteBOf(index)} Detailed notes for handbook chapter ${index + 1}.`,
        createdAt: at,
        courses: [COURSE],
        document: {
          materialId: 'ds-book2-pdf',
          page: index + 1,
          totalPages: BOOK2_CHAPTERS.length,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: `${BOOK2_TITLE}.pdf`,
          chapter: { index, title, level: 1 },
          extractionVersion: 2,
        },
      });
    });
    state.decks.push(
      {
        id: 'ds-deck-a',
        title: 'Consensus Deck',
        course: COURSE,
        cards: [
          {
            id: 'c-a1',
            kind: 'quiz',
            topic: 'Clock',
            prompt: 'Why is physical clock synchronization bounded in distributed systems?',
            answer: 'Crystal drift and asymmetric network delays.',
            options: [
              { id: 'a', text: 'Crystal drift and asymmetric network delays', correct: true },
              { id: 'b', text: 'Zero latency fiber', correct: false },
            ],
            citations: [{ sourceId: 'ds-p1', quote: quoteOf(0) }],
          },
        ],
      },
      {
        id: 'ds-deck-b',
        title: 'Replication Deck',
        course: COURSE,
        cards: [
          {
            id: 'c-b1',
            kind: 'quiz',
            topic: 'BFT',
            prompt: 'How many replicas tolerate f Byzantine faults under partial synchrony?',
            answer: '3f + 1 replicas.',
            options: [
              { id: 'a', text: '3f + 1 replicas', correct: true },
              { id: 'b', text: 'f + 1 replicas', correct: false },
            ],
            citations: [{ sourceId: 'ds-b2-p3', quote: quoteBOf(2) }],
          },
        ],
      },
    );
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  await service.dispose();
  return root;
}

test('outline target resets stale deck filter, restores filter without target, cleans up on early exit/failure, notifies missing row, and works under StrictMode (#1224, #1226)', { timeout: 600000 }, async (t) => {
  const root = await seedMultiDeckLibrary(t);
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }

  const endRuns = async () => {
    for (const openRun of (await previewCall(server, 'snapshot', {})).runs || []) {
      await previewCall(server, 'review.end', { runId: openRun.id });
    }
  };

  // 1. #1226: filter by Deck A -> restore without target -> click 出处 from Deck B -> filter resets to all decks and Deck B chapter opens & scrolls; missing row notifies.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('study-ui-language', 'zh');
      localStorage.setItem('study-autopilot', 'off');
    });

    await page.goto(server.url);
    await page.locator('.course-header .outline-entry').click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    await page.locator('.outline-row', { hasText: BOOK2_TITLE }).waitFor({ state: 'visible', timeout: 15000 });

    const deckCombo = page.locator('.outline-deck[role="combobox"]');
    await deckCombo.waitFor({ state: 'visible', timeout: 30000 });
    await deckCombo.click();
    await page.locator('.sh-pop__popup:not([data-closed]) .sh-opt', { hasText: 'Consensus Deck' }).click();
    await page.locator('.outline-row', { hasText: BOOK2_TITLE }).waitFor({ state: 'detached', timeout: 15000 });
    assert.match(await deckCombo.innerText(), /Consensus Deck/);

    // Return to library and re-open Outline normally: saved Deck A filter still restores when there is no target.
    await page.locator('.outline-header').getByRole('button', { name: '返回学习库' }).click();
    await page.locator('.course-header .outline-entry').click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.context-return').count(), 0, 'normal outline entry from library has no .context-return banner');
    assert.equal(await page.locator('.outline-header').getByRole('button', { name: '返回学习库' }).count(), 1, 'normal outline entry shows 返回学习库');
    await deckCombo.waitFor({ state: 'visible', timeout: 30000 });
    assert.match(await deckCombo.innerText(), /Consensus Deck/, 'normal entry without target restores saved deck filter');
    assert.equal(await page.locator('.outline-row', { hasText: BOOK2_TITLE }).count(), 0, 'Deck B document remains filtered out');

    // Return to library, practise Deck B, and click 出处 -> filter resets to all decks and Deck B chapter #2 expands into viewport.
    await page.locator('.outline-header').getByRole('button', { name: '返回学习库' }).click();
    await page.getByRole('button', { name: '开始学习 Replication Deck' }).first().click();
    await confirmStart(page);
    const place = page.locator('[data-review-place]');
    await place.waitFor({ state: 'visible', timeout: 30000 });
    await place.click();

    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.context-return').count(), 0, 'outline from review hides duplicate .context-return banner');
    assert.equal(await page.getByRole('button', { name: /回到之前的第 1 题/ }).count(), 1, 'only one return-to-question control is rendered');
    await deckCombo.waitFor({ state: 'visible', timeout: 30000 });
    assert.match(await deckCombo.innerText(), /全部题组/, 'arriving via 出处 resets stale deck filter to all decks');
    await page.locator('.outline-row', { hasText: DOC_TITLE }).waitFor({ state: 'visible', timeout: 15000 });
    const targetChapter = page.locator('[data-key="pdf:ds-book2-pdf#2"]');
    await targetChapter.waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.locator('[data-outline-toggle="pdf:ds-book2-pdf"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-outline-toggle="pdf:ds-book2-pdf#2"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-outline-toggle="pdf:ds-book2-pdf#0"]').getAttribute('aria-expanded'), 'false');
    const inViewport = await page.evaluate(() => {
      const r = document.querySelector('[data-key="pdf:ds-book2-pdf#2"]').getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    assert.equal(inViewport, true, 'Deck B target chapter scrolled into viewport');

    // Missing target row in Outline notifies instead of failing silently.
    await page.locator('.outline-header').getByRole('button', { name: /回到之前的第 1 题/ }).click();
    await place.waitFor({ state: 'visible', timeout: 30000 });
    let stripNextOutline = true;
    const stripHandler = async (route) => {
      const body = route.request().postData() || '';
      if (stripNextOutline && /"action":"course\.outline"/.test(body)) {
        stripNextOutline = false;
        const response = await route.fetch();
        const json = await response.json();
        if (json?.value) {
          json.value.documents = (json.value.documents || []).filter((doc) => doc.key !== 'pdf:ds-book2-pdf');
          if (json.value.open) {
            for (const key of Object.keys(json.value.open)) {
              if (key.startsWith('pdf:ds-book2-pdf')) delete json.value.open[key];
            }
          }
        }
        await route.fulfill({ response, json });
        return;
      }
      await route.continue();
    };
    await page.route('**/api/call', stripHandler);
    await place.click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    await page.locator('.sh-toasts .sh-toast', { hasText: '没有在总纲里找到这道题的出处' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/call', stripHandler);

    assert.deepEqual(errors, []);
    await endRuns();
    await context.close();
  }

  // 2. #1224: leaving before course.outline finishes AND load failure both clear the one-shot target so later normal Outline open does not auto-expand.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('study-ui-language', 'zh');
      localStorage.setItem('study-autopilot', 'off');
    });

    // 2a. Abort while loading (back before course.outline settles).
    await page.goto(server.url);
    await page.getByRole('button', { name: '开始学习 Consensus Deck' }).first().click();
    await confirmStart(page);
    const place = page.locator('[data-review-place]');
    await place.waitFor({ state: 'visible', timeout: 30000 });

    let markRequested;
    const outlineRequested = new Promise((resolve) => { markRequested = resolve; });
    let releaseOutline;
    let markDone;
    const outlineDone = new Promise((resolve) => { markDone = resolve; });
    let holdNext = true;
    const holdHandler = async (route) => {
      const body = route.request().postData() || '';
      if (holdNext && /"action":"course\.outline"/.test(body)) {
        holdNext = false;
        markRequested();
        await new Promise((resolve) => { releaseOutline = resolve; });
        await route.continue().catch(() => {});
        markDone();
        return;
      }
      await route.continue();
    };
    await page.route('**/api/call', holdHandler);
    await place.click();
    await outlineRequested;
    await page.locator('text=正在读取总纲…').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.outline-header').getByRole('button', { name: /回到之前的第 1 题/ }).click();
    await page.locator('.question').waitFor({ state: 'visible', timeout: 15000 });
    releaseOutline();
    await outlineDone;
    await page.unroute('**/api/call', holdHandler);

    await (await revealNavRow(page, 'library')).click();
    await page.locator('.course-header .outline-entry').click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-outline-toggle="pdf:ds-notes-pdf"]').getAttribute('aria-expanded'), 'false', 'aborted target does not auto-expand document');
    assert.equal(await page.locator('[data-key="pdf:ds-notes-pdf#0"]').count(), 0, 'aborted target does not auto-expand chapter');

    // 2b. Load failure clears target.
    await endRuns();
    await page.goto(server.url);
    await page.getByRole('button', { name: '开始学习 Consensus Deck' }).first().click();
    await confirmStart(page);
    await place.waitFor({ state: 'visible', timeout: 30000 });

    let failNext = true;
    const failHandler = async (route) => {
      const body = route.request().postData() || '';
      if (failNext && /"action":"course\.outline"/.test(body)) {
        failNext = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Simulated outline failure' }) });
        return;
      }
      await route.continue();
    };
    await page.route('**/api/call', failHandler);
    await place.click();
    await page.locator('.sh-error-state', { hasText: '没能打开总纲' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/call', failHandler);

    await (await revealNavRow(page, 'library')).click();
    await page.locator('.course-header .outline-entry').click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-outline-toggle="pdf:ds-notes-pdf"]').getAttribute('aria-expanded'), 'false', 'failed outline load does not leave target expanded');
    assert.equal(await page.locator('[data-key="pdf:ds-notes-pdf#0"]').count(), 0);

    assert.deepEqual(errors, []);
    await endRuns();
    await context.close();
  }

  // 3. #1224: React StrictMode simulated cleanup clears map without breaking pendingTarget scroll in real Chromium DOM.
  {
    const bundle = await build({
      stdin: {
        contents: `
          import React, { StrictMode } from 'react';
          import { createRoot } from 'react-dom/client';
          import CourseOutline from './ui/outline/CourseOutline.jsx';
          import { keepOutline, keptOutlineTarget } from './ui/outline/model.js';
          import { StudyServicesContext } from './ui/study-context.jsx';

          const summary = { total: 1, counts: { new: 1, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: 1, inactive: 0, percent: 0, state: 'unlearned' };
          keepOutline('/strict', 'StrictCourse', { target: 'pdf:strict#1' });
          window.strictTargetAtMount = keptOutlineTarget('/strict', 'StrictCourse');
          window.getStrictTargetAfter = () => keptOutlineTarget('/strict', 'StrictCourse');
          window.scrolledKeys = [];
          const origScroll = Element.prototype.scrollIntoView;
          Element.prototype.scrollIntoView = function (opts) {
            window.scrolledKeys.push([this.getAttribute('data-key'), opts?.block]);
            return origScroll?.call(this, opts);
          };

          const services = {
            busy: false, notify: () => {}, askInChat: () => {}, host: {}, openSettings: () => {}, navigate: () => {}, openModal: () => {},
            act: async () => undefined,
            call: async (action) => {
              if (action !== 'course.outline') return {};
              await new Promise(resolve => setTimeout(resolve, 20));
              return {
                status: 'ok', course: 'StrictCourse', total: 1, placed: 1, summary, draftCards: 0, limit: 200,
                decks: [], deckId: null,
                documents: [{ key: 'pdf:strict', title: 'Strict.pdf', format: 'pdf', chapters: 2, total: 1, summary, deckCount: 1 }],
                unplaced: { key: 'unplaced', total: 0, summary, reasons: {}, materials: [] },
                open: {
                  'pdf:strict': { chapters: [
                    { key: 'pdf:strict#0', kind: 'chapter', index: 0, title: 'Ch 0', level: 1, total: 0, summary, deckCount: 0 },
                    { key: 'pdf:strict#1', kind: 'chapter', index: 1, title: 'Ch 1', level: 1, total: 1, summary, deckCount: 1 },
                  ] },
                  'pdf:strict#1': { cards: [], more: 0 },
                },
              };
            },
          };

          createRoot(document.getElementById('root')).render(
            <StrictMode>
              <StudyServicesContext.Provider value={services}>
                <CourseOutline data={{ root: '/strict', revision: 1, focus: { course: 'StrictCourse' }, sources: [], jobs: [], settings: {} }}
                  onBack={() => {}} onCreate={() => {}} onPractice={() => {}} />
              </StudyServicesContext.Provider>
            </StrictMode>
          );
        `,
        resolveDir: process.cwd(),
        loader: 'jsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      loader: { '.css': 'text' },
      logLevel: 'silent',
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('[data-key="pdf:strict#1"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => window.scrolledKeys.length > 0, null, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => window.scrolledKeys), [['pdf:strict#1', 'center']]);
    assert.equal(await page.evaluate(() => window.getStrictTargetAfter()), null);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('cross-course 出处 switches focus course to card course, restores previous focus course on return, and still returns when focus.set fails (#1223)', { timeout: 600000 }, async (t) => {
  const COURSE_A = 'Operating Systems';
  const root = await mkdtemp(join(tmpdir(), 'question-place-cross-course-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.call('snapshot');
  await service.store.update((state) => {
    CHAPTERS.slice(0, 3).forEach((title, index) => {
      state.sources.push({
        id: `ds-p${index + 1}`,
        title: `${DOC_TITLE} · p. ${index + 1}`,
        text: `${quoteOf(index)} Extra lecture details for section ${index + 1}.`,
        createdAt: at,
        courses: [COURSE],
        document: {
          materialId: 'ds-notes-pdf',
          page: index + 1,
          totalPages: 3,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: `${DOC_TITLE}.pdf`,
          chapter: { index, title, level: 1 },
          extractionVersion: 2,
        },
      });
    });
    state.decks.push(
      {
        id: 'os-deck',
        title: 'OS Scheduling',
        course: COURSE_A,
        cards: [
          {
            id: 'os-c1',
            kind: 'quiz',
            topic: 'Scheduling',
            prompt: 'Which scheduling algorithm prevents starvation by increasing priority over time?',
            answer: 'Aging.',
            options: [
              { id: 'a', text: 'Aging', correct: true },
              { id: 'b', text: 'Strict FIFO without preemption', correct: false },
            ],
            citations: [],
          },
        ],
      },
      {
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
            // A mixed path puts due reviews before new questions, independently of the order of the scope array.
            review: { repetitions: 1, interval_days: 1, last_review: '2000-01-01T00:00:00Z', due_at: '2000-01-02T00:00:00Z' },
            options: [
              { id: 'a', text: 'Majority quorum and up-to-date log term checks', correct: true },
              { id: 'b', text: 'Static priority configured by node IP', correct: false },
            ],
            citations: [{ sourceId: 'ds-p3', quote: quoteOf(2) }],
          },
        ],
      },
    );
    state.focus = { mode: 'class', course: COURSE_A, role: '', jd: '', targetTopics: [] };
  });
  await service.dispose();

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }

  const mixedRun = await previewCall(server, 'review.start', {
    mode: 'path',
    scope: [{ deckId: 'ds-deck', cardId: 'c-raft' }, { deckId: 'os-deck', cardId: 'os-c1' }],
    ordered: true,
    fresh: true,
  });
  assert.equal(mixedRun.card.id, 'c-raft', 'the resumed question belongs to the course outside the current focus');
  assert.equal((await previewCall(server, 'snapshot', {})).focus.course, COURSE_A);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-autopilot', 'off');
  });

  // 1. Course A active -> mixed run card from Course B still offers 出处 (even though Course A has no materials)
  //    -> clicking 出处 switches focus to Course B -> returning restores focus to Course A and resumes the exact run.
  await page.goto(server.url);
  await page.locator('.course-heading', { hasText: COURSE_A }).waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-usage="nav.resume"]').click();
  const place = page.locator('[data-review-place]');
  await place.waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await place.evaluate((el) => el.tagName), 'BUTTON', '出处 is clickable even when current focus course has no materials');
  assert.match(await place.innerText(), new RegExp(CHAPTERS[2].slice(0, 12)));

  await place.click();
  await page.locator('.outline-tree').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.context-return').count(), 0, 'cross-course outline from review hides duplicate .context-return banner');
  assert.equal(await page.getByRole('button', { name: /回到之前的第 1 题/ }).count(), 1, 'cross-course outline renders only one return-to-question control');
  assert.match(await page.locator('.outline-page h1').innerText(), new RegExp(`总纲 · ${COURSE}`));
  assert.equal((await previewCall(server, 'snapshot', {})).focus.course, COURSE, 'jumping to 出处 switches active course to Course B');
  await page.locator('[data-key="pdf:ds-notes-pdf#2"]').waitFor({ state: 'visible', timeout: 30000 });

  await page.locator('.outline-header').getByRole('button', { name: /回到之前的第 1 题/ }).click();
  await place.waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page.locator('.question').innerText(), /leader election safety/i, 'returned to exact Course B question in mixed run');
  assert.equal((await previewCall(server, 'snapshot', {})).focus.course, COURSE_A, 'returning restored focus course back to Course A');
  const activeRun = (await previewCall(server, 'snapshot', {})).lastRun;
  assert.equal(activeRun?.id, mixedRun.id, 'resumed the exact same mixed review run');

  await (await revealNavRow(page, 'library')).click();
  await page.locator('.course-heading', { hasText: COURSE_A }).waitFor({ state: 'visible', timeout: 30000 });

  // 2. If restoring focus.set throws or returns falsy, returning still brings learner back to the question and surfaces an error.
  for (const mode of ['throw', 'falsy']) {
    await page.locator('[data-usage="nav.resume"]').click();
    await place.waitFor({ state: 'visible', timeout: 30000 });
    await place.click();
    await page.locator('.outline-tree').waitFor({ timeout: 30000 });

    const failRestore = async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && request.url().endsWith('/api/call')) {
        const body = JSON.parse(request.postData() || '{}');
        if (body.action === 'focus.set' && body.args?.course === COURSE_A) {
          if (mode === 'throw') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '请选择已有课程' }) });
          } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: null }) });
          }
          return;
        }
      }
      await route.continue();
    };
    await page.route('**/api/call', failRestore);
    await page.locator('.outline-header').getByRole('button', { name: /回到之前的第 1 题/ }).click();
    await place.waitFor({ state: 'visible', timeout: 30000 });
    assert.match(await page.locator('.question').innerText(), /leader election safety/i, `still returned to question on focus.set ${mode}`);
    const expectedError = mode === 'throw'
      ? '已回到原位置，但没能切回之前的课程：请选择已有课程'
      : '已回到原位置，但没能切回之前的课程。可以在学习库重新切换当前课程。';
    await page.locator('.sh-toasts .sh-toast--error', { hasText: expectedError }).waitFor({ state: 'visible', timeout: 15000 });
    await page.unroute('**/api/call', failRestore);

    // Restore course back to A cleanly before next iteration or library check.
    await previewCall(server, 'focus.set', { course: COURSE_A });
    await (await revealNavRow(page, 'library')).click();
    await page.locator('.course-heading', { hasText: COURSE_A }).waitFor({ state: 'visible', timeout: 30000 });
  }

  assert.deepEqual(errors, [], 'zero uncaught page errors');
  for (const openRun of (await previewCall(server, 'snapshot', {})).runs || []) {
    await previewCall(server, 'review.end', { runId: openRun.id });
  }
  await context.close();
});
