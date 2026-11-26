/* global document, window, localStorage, getComputedStyle */
import { commitPreviewAction } from './helpers/preview-write.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const uiMods = await loadUi(`
  export { default as Review } from './ui/Review.jsx';
  export { MAX_QUESTION_META_BADGES } from './ui/review/QuestionParts.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('Post-answer surface & header badge budget: 1 primary 下一题, closed disclosure for LearningActions/NextDue/distractors, <= 2 header badges, slim summary', () => {
  const noop = () => {};
  const longExplanation = 'Core explanation sentence about distributed consensus and quorum intersection. '.repeat(6);
  const card = {
    id: 'q1',
    kind: 'quiz',
    topic: 'Consensus',
    prompt: 'Why must read and write quorums intersect?',
    focus: true,
    sourceQa: true,
    importedFromJson: true,
    options: [
      { id: 'a', text: 'So every read sees the latest committed write' },
      { id: 'b', text: 'To avoid network encryption' },
      { id: 'c', text: 'To eliminate disk storage' },
      { id: 'd', text: 'To double latency' },
    ],
  };
  const html = renderToStaticMarkup(reviewElement(uiMods.Review, uiMods.StudyServicesContext, {
    run: {
      id: 'r-budget',
      deckId: 'd1',
      mode: 'path',
      index: 0,
      total: 3,
      complete: false,
      revealed: true,
      card,
      cardSource: { sourceId: 's1', page: 12, unit: 'page' },
      origin: { reason: 'followup', prompt: 'How do quorums prevent stale reads?' },
      feedback: { correct: false, selected: ['b'], level: 'weak', nextDue: '2026-10-20T00:00:00.000Z' },
      solution: {
        answer: 'So every read sees the latest committed write',
        explanation: longExplanation,
        misconception: 'Quorum intersection is about overlap, not total node count.',
        rubric: 'Must mention overlap >= 1 node.',
        options: [
          { id: 'a', correct: true, explanation: 'Overlap guarantees at least one node holds the newest write.' },
          { id: 'b', correct: false, explanation: 'Picked distractor note.' },
          { id: 'c', correct: false, explanation: 'Unpicked distractor C explanation.' },
          { id: 'd', correct: false, explanation: 'Unpicked distractor D explanation.' },
        ],
      },
    },
    data: {
      sources: [{ id: 's1', title: 'Lecture 4', format: 'pdf' }],
      noteBadges: {
        q1: [
          { noteId: 'n1', title: 'Quorum Notes', status: 'draft' },
          { noteId: 'n2', title: 'Published Summary', status: 'published', url: 'https://example.com/n2' },
        ],
      },
    },
    host: {},
    choice: true,
    isCloze: false,
    selected: ['b'],
    clozeValues: {},
    shellTitle: 'Systems Review',
    busy: false,
    onOpenNote: noop,
  }));

  // (c.1) Exactly ONE primary 下一题 button on the entire post-answer surface, even when explanation >= 280 chars.
  assert.equal((html.match(/data-usage="review\.next"/g) || []).length, 1, 'exactly 1 review.next button');
  assert.equal((html.match(/下一题/g) || []).length, 1, 'never renders duplicate 下一题 in explanation footer');
  assert.match(html, /class="review-sticky-bar"/, 'primary toolbar lives inside sticky bottom bar');

  // (c.2) Verdict + concise core explanation visible outside disclosure; LearningActions + distractor notes + misconception folded inside closed <details>.
  const foldStart = html.indexOf('<details class="post-answer-more"');
  assert.ok(foldStart > 0, 'renders post-answer-more disclosure');
  const foldOpenTag = html.slice(foldStart, html.indexOf('>', foldStart) + 1);
  assert.doesNotMatch(foldOpenTag, /\bopen\b/, 'post-answer-more disclosure is closed by default');

  const outsideFold = html.slice(0, foldStart);
  const insideFold = html.slice(foldStart);
  assert.match(outsideFold, /理解这道题/, 'core explanation heading stays visible outside fold');
  assert.match(outsideFold, /Overlap guarantees at least one node/, 'correct option note stays visible on card');
  assert.match(outsideFold, /Picked distractor note/, 'picked wrong option note stays visible on card');
  assert.doesNotMatch(outsideFold, /Unpicked distractor C explanation/, 'unpicked distractor notes folded away');
  assert.doesNotMatch(outsideFold, /逐步理解|计算题引导练习|用自己的话讲一遍/, 'LearningActions folded away by default');
  assert.match(insideFold, /Unpicked distractor C explanation/, 'unpicked distractor notes accessible inside disclosure');
  assert.match(insideFold, /逐步理解/, 'LearningActions accessible inside disclosure');

  // (d) Header QuestionMetaBadges capped to MAX_QUESTION_META_BADGES (2) inline even when 7 metadata items exist.
  const metaStart = html.indexOf('<div class="question-meta">');
  const topicStart = html.indexOf('<span class="question-meta__topic"', metaStart);
  const metaRightBeforeTopic = html.slice(html.indexOf('<div>', metaStart), topicStart);
  const inlineBadgesAndLinks = (metaRightBeforeTopic.match(/class="(?:[^"]*\borigin-note\b|[^"]*\bquestion-source-page\b|[^"]*\bresult-note-link\b)/g) || []).length;
  assert.ok(inlineBadgesAndLinks <= uiMods.MAX_QUESTION_META_BADGES, `inline meta badges (${inlineBadgesAndLinks}) <= ${uiMods.MAX_QUESTION_META_BADGES}`);
  assert.match(html.slice(topicStart, topicStart + 240), /\+5/, '5 overflow metadata items summarized as +5');

  // Option badges: clean A/B/C/D without trailing dot clutter.
  const letters = [...outsideFold.matchAll(/<span class="option-letter">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(letters, ['A', 'B', 'C', 'D']);

  // Round-end summary slimming: hides 接下来重点复习 completely when weakTopics is empty!
  const summaryClean = renderToStaticMarkup(reviewElement(uiMods.Review, uiMods.StudyServicesContext, {
    run: {
      id: 'r-done',
      mode: 'path',
      complete: true,
      index: 3,
      total: 3,
      questions: 3,
      answered: 3,
      correct: 3,
      weakTopics: [],
      scope: [],
      card,
    },
    data: { sources: [] },
    host: {},
    choice: true,
    isCloze: false,
    selected: [],
    clozeValues: {},
    shellTitle: 'Systems Review',
    busy: false,
    act: noop,
    enterRun: noop,
  }));
  assert.doesNotMatch(summaryClean, /summary-topics|本轮没有低分记录/, 'empty weakTopics card hidden completely on clean round summary');
});

test('Browser step budget & zero-wait flip guardrail: flashcard <= 2 steps (even during in-flight reveal), choice <= 2 steps (1 with autopilot), sticky bar & 390px/1280px clean', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`); return; }
  const root = await mkdtemp(join(tmpdir(), 'study-step-budget-'));
  const libraryRoot = join(root, 'library');
  const distDir = join(root, 'dist');
  const service = new StudyService(libraryRoot);
  await service.store.update((s) => {
    s.decks.push(
      {
        id: 'flash-deck',
        title: 'Flash Budget',
        course: 'Systems',
        cards: [
          { id: 'f1', kind: 'flashcard', topic: 'Locks', prompt: 'Flash Question 1?', answer: 'Flash Answer 1', explanation: 'Short explanation 1.' },
          { id: 'f2', kind: 'flashcard', topic: 'Locks', prompt: 'Flash Question 2?', answer: 'Flash Answer 2', explanation: 'Short explanation 2.' },
        ],
      },
      {
        id: 'choice-deck',
        title: 'Choice Budget',
        course: 'Systems',
        cards: [
          {
            id: 'q1',
            kind: 'quiz',
            topic: 'Quorums',
            prompt: 'Choice Question 1?',
            explanation: 'Detailed explanation paragraph. '.repeat(20),
            misconception: 'Common pitfall.',
            options: [
              { id: 'a', text: 'Right option A', correct: true, explanation: 'Why A is right.' },
              { id: 'b', text: 'Wrong option B', correct: false, explanation: 'Why B is wrong.' },
              { id: 'c', text: 'Wrong option C', correct: false, explanation: 'Why C is wrong.' },
            ],
          },
          {
            id: 'q2',
            kind: 'truefalse',
            topic: 'Verdict',
            prompt: 'Choice Question 2 (True/False)?',
            explanation: 'Brief verdict explanation.',
            options: [
              { id: 'true', text: '对', correct: true, explanation: 'Statement holds.' },
              { id: 'false', text: '错', correct: false, explanation: 'Statement holds.' },
            ],
          },
        ],
      },
    );
  });
  await service.dispose();
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot, home: join(root, 'home'), port: 0, model: null, distDir });
  t.after(async () => {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // ── 1. Flashcard 2-step budget + Zero-Wait Local Flip + In-Flight Reveal Grade Key Race + Undo (1280x800 dark) ──
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: 'flash-deck' }] });
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'dark'); });

    // Hold the first review.reveal behind an explicit gate so we deterministically prove:
    // (1) local flip + grade buttons render BEFORE review.reveal settles, and
    // (2) pressing grade key '4' while review.reveal is still in flight awaits reveal and never drops the press!
    let releaseFirstReveal = null;
    let firstRevealSettled = false;
    const firstRevealArrived = new Promise((resolve) => {
      page.route('**/api/call', async (route) => {
        const body = route.request().postData() || '';
        if (!releaseFirstReveal && /"action":"review\.reveal"/.test(body)) {
          await new Promise((r) => {
            releaseFirstReveal = r;
            resolve();
          });
          await route.continue();
          firstRevealSettled = true;
          return;
        }
        await route.continue();
      });
    });

    await page.goto(server.url);
    await page.getByRole('button', { name: /Flash Budget|接着做/ }).first().click();
    await page.locator('.flashcard').waitFor({ timeout: 30000 });
    assert.match(await page.locator('.flashcard').innerText(), /Flash Question 1\?/);

    // Step 1: Flip -> instant local flip & grade scale rendered while review.reveal is STILL held in flight!
    await page.locator('.flip-control').click();
    await firstRevealArrived;
    await page.waitForFunction(() => document.querySelector('.flashcard')?.classList.contains('flipped') && document.querySelectorAll('.grade').length === 6);
    assert.equal(firstRevealSettled, false, 'card flipped and grade buttons enabled while review.reveal is still in flight');
    assert.equal(await page.locator('.grade').nth(4).isDisabled(), false, 'grade buttons are not locked by background reveal');

    // Step 2: Press grade key '4' while review.reveal is STILL in flight, then release reveal -> press is queued & advances directly to Card 2!
    await page.keyboard.press('4');
    releaseFirstReveal();
    await page.waitForFunction(() => /Flash Question 2\?/.test(document.querySelector('.flashcard')?.innerText || ''), null, { timeout: 15000 });

    // Undo ('z'): returns right back to Card 1's revealed back with grade buttons ready!
    await page.keyboard.press('z');
    await page.waitForFunction(() => /Flash Question 1\?/.test(document.querySelector('.flashcard')?.innerText || '') && document.querySelectorAll('.grade').length === 6, null, { timeout: 15000 });
    assert.equal(await page.locator('.flashcard').evaluate((el) => el.classList.contains('flipped')), true, 'undo returns to revealed back face');

    // Re-grade Card 1 (2 steps total) and Card 2 (2 steps total) -> result page with compact RoundLookBack & hidden weakTopics!
    await page.keyboard.press('4');
    await page.waitForFunction(() => /Flash Question 2\?/.test(document.querySelector('.flashcard')?.innerText || ''), null, { timeout: 15000 });
    await page.keyboard.press(' ');
    await page.locator('.grade-scale').waitFor();
    await page.keyboard.press('5');
    await page.locator('.result-page').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.summary-topics').count(), 0, 'no empty weakTopics card');
    assert.equal(await page.locator('details.round-look-back--compact').evaluate((el) => el.open), false, 'all-passed RoundLookBack starts compact/folded');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '1280x800 dark no horizontal overflow');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // ── 2. Choice 2-step budget (and 1-step with autopilot) + Sticky Bar + Verdict 1/2 Hints + Mobile 390x844 English Zero-Han ──
  for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: 'choice-deck' }] });
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-theme', 'light'); });
    await page.goto(server.url);
    await page.getByRole('button', { name: /Choice Budget|Continue/ }).first().click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });

    // Choice step 1: pick the right option -> sticky bar stays visible at bottom of viewport, 1 Next button, closed disclosure.
    const rightIdx = (await page.locator('.option').allInnerTexts()).findIndex((txt) => /Right option A/.test(txt));
    assert.ok(rightIdx >= 0, 'Right option A present');
    await page.keyboard.press(String(rightIdx + 1));
    await page.locator('.option.correct').waitFor();
    const budgetCheck = await page.evaluate(() => {
      const sticky = document.querySelector('.review-sticky-bar');
      const nextBtns = document.querySelectorAll('[data-usage="review.next"]');
      const moreFold = document.querySelector('details.post-answer-more');
      const stickyStyle = sticky ? getComputedStyle(sticky) : null;
      const nextRect = nextBtns[0]?.getBoundingClientRect();
      return {
        stickyPosition: stickyStyle?.position,
        nextCount: nextBtns.length,
        nextVisibleInViewport: !!nextRect && nextRect.bottom <= window.innerHeight + 1 && nextRect.top >= 0,
        foldOpen: moreFold?.open,
        scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
        uiChromeText: [...document.querySelectorAll('.review-sticky-bar, .post-answer-more__summary, .next-due--verdict')]
          .map((el) => el.textContent || '').join(' '),
      };
    });
    assert.equal(budgetCheck.stickyPosition, 'sticky');
    assert.equal(budgetCheck.nextCount, 1, 'single Next question button');
    assert.equal(budgetCheck.nextVisibleInViewport, true, 'sticky bottom action bar keeps Next visible without scrolling');
    assert.equal(budgetCheck.foldOpen, false, 'secondary post-answer surface stays folded');
    assert.ok(budgetCheck.scrollOverflow <= 0, `390x844 mobile zero horizontal overflow (${budgetCheck.scrollOverflow})`);
    assert.doesNotMatch(budgetCheck.uiChromeText, /[\u3400-\u9fff]/, 'zero leaked Han characters in 390px English review chrome');

    // Choice step 2: Enter advances to Choice Question 2 (True/False verdict with '1'/'2' badges).
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Choice Question 2/.test(document.querySelector('.question-card')?.innerText || ''));
    const verdictMarks = await page.locator('.option-letter').allInnerTexts();
    assert.deepEqual(verdictMarks.map((s) => s.trim()), ['1', '2'], 'verdict badges show clean 1 / 2 keyboard hints');

    // Turn on autopilot ('a') -> picking right option auto-advances in 1 learner step!
    const firstIsTrue = /对|True|Right/i.test(await page.locator('.option').first().innerText());
    await page.mouse.move(0, 0); // hovering over the explanation intentionally pauses automatic advance
    await commitPreviewAction(page, 'settings.practice.set', () => page.keyboard.press('a'));
    assert.equal((await previewCall(server, 'snapshot')).settings.practice.autopilot, true);
    await page.keyboard.press(firstIsTrue ? '1' : '2');
    await page.locator('.result-page').waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
