/* global window, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* The learning loop under a question in a real browser, with the preview's fake model (#1015, #1016), at 1280 and 420 px (and English at 420):
   a wrong answer → 试一道同类题 practises a similar question of the bank as a detour → its result page's 回到原题 is one click back to the question, as it
   was left, and the round's own counts did not move; 用自己的话讲一遍 checks an explanation (讲对了的 / 漏掉的 / 讲错的, 去原文看这段 opens the cited source and
   回到这道题 comes back in the dialog at 420 px; at 1280 the original opens in the 对照栏 beside the question instead) and the library keeps no words; on the 复习全书 a point's 用自己的话讲一遍 leaves 讲清楚过 ✓, which a reload keeps. Nothing scrolls
   sideways. With no similar question 生成一道变式 has the fake model write one, and 做这道变式题 (still there after a reload) practises it the same way; a
   check that fails keeps the words; without a model both stand behind the model gate. LEARNING_LOOP_SHOTS=<folder> keeps screenshots. */

const RUNS = [['zh', 1280, 900], ['zh', 420, 900], ['en', 420, 900]];
const SOURCE = { id: 'breaker-notes', title: 'Breaker notes', text: 'A circuit breaker opens after repeated failures and rejects calls. After a pause it lets a few trial calls through; success closes it again.' };
const options = [{ id: 'a', text: 'yes', correct: true, explanation: 'Right.' }, { id: 'b', text: 'no', correct: false, explanation: 'Wrong.' }];
const quiz = (id, topic, prompt) => ({ id, kind: 'quiz', topic, objective: 'Understand', prompt, hint: 'Think.', explanation: `Explanation of ${id}.`, misconception: 'A usual mix-up.',
  citations: [{ sourceId: SOURCE.id, quote: SOURCE.text.slice(0, 60) }], options });
// One deck per run: a similar question answered right is not offered again for a week (lib/recommend.js).
const deckOf = (i) => ({ id: `loop${i}`, title: `Breakers ${i}`, course: 'SRE', cards: [quiz(`loop${i}-orig`, `Half-open ${i}`, `What does a half-open breaker do (${i})?`),
  quiz(`loop${i}-twin`, `Half-open ${i}`, `When does a breaker turn half-open (${i})?`), quiz(`loop${i}-far`, `Logging ${i}`, `Why structured logs (${i})?`)] });
// A deck with no similar question anywhere in the bank: its own source, its own topics (the variant segment).
const AUDIT = { id: 'audit-notes', title: 'Audit notes', text: 'Audit trails keep a record of who changed what and when; they are kept for a long time and never edited.' };
const auditQuiz = (id, topic, prompt) => ({ ...quiz(id, topic, prompt), citations: [{ sourceId: AUDIT.id, quote: AUDIT.text.slice(0, 50) }] });
const VARIANT_DECK = { id: 'audit', title: 'Audit', course: 'SRE', cards: [auditQuiz('audit-orig', 'Audit trails', 'Which record keeps who changed what?'),
  auditQuiz('audit-far', 'Key rotation', 'Why rotate signing keys?')] };
const WORDS = {
  zh: { similar: '试一道同类题', back: /回到原题/, retell: '用自己的话讲一遍', check: '让 AI 看看', parts: ['讲对了的', '漏掉的', '讲错的'],
    source: '去原文看这段', backToQuestion: '回到这道题', retold: '讲清楚过' },
  en: { similar: 'Try a similar question', back: /Return to original question/, retell: 'Explain it in your own words', check: 'Ask the AI to check',
    parts: ['What you got right', 'What you left out', 'What was wrong'], source: 'See this in the source', backToQuestion: 'Back to this question', retold: 'Explained clearly' },
};
const SECRET = 'A breaker rejects calls when open, then tries a few calls and closes on success — words that must never be stored';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(SOURCE, AUDIT, ...sources);
    state.decks.push(...RUNS.map((_, i) => deckOf(i)), VARIANT_DECK, ...decks);
    const lecture = groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}#1`] }] }],
      other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The explanation of ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = (page, scope) => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(`${selector} *`)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, scope);
const flat = overflow => overflow.doc <= 0 && overflow.wide.length === 0;
const prompt = (page) => page.locator('.question-card .question').first().innerText();
/** A page on the open round of `running` (the home's 接着做). */
async function openRound(browser, running, { lang, width }) {
  const opened = await openPage(browser, running, { lang, width, height: 900 });
  await opened.page.goto(running.server.url);
  // 接着做: the next-step card's, or (without a model that card asks for one) the 接着上次 card's.
  await opened.page.getByRole('button', { name: lang === 'en' ? /^Continue/ : /^接着做/ }).first().click({ timeout: 30000 });
  await opened.page.locator('.question-card').waitFor({ timeout: 30000 });
  return opened;
}
const pendingText = async (page) => (await page.locator('.round-pending__trigger').count() && await page.locator('.round-pending__trigger').isVisible()
  ? (await page.locator('.round-pending__trigger').innerText()).trim() : '');

test('试一道同类题 and back in one click; 用自己的话讲一遍 on a question and on a book point (1280 and 420 px, zh and en)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-learning-loop-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.LEARNING_LOOP_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    await running.api('settings.practice.set', { patch: { autopilot: false, debrief: false } });
    for (const [i, [lang, width, height]] of RUNS.entries()) {
      const where = `${lang} ${width}px`, words = WORDS[lang], deck = deckOf(i), [orig, twin] = deck.cards;
      for (const open of (await running.api('snapshot', {})).runs || []) await running.api('review.end', { runId: open.id });
      const round = await running.api('review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: deck.id, cardId: orig.id }, { deckId: deck.id, cardId: deck.cards[2].id }] });
      const { page, errors, context } = await openPage(browser, running, { lang, width, height });
      await page.goto(running.server.url);
      // The home's next-step card: 有一组练习没做完 → 接着做.
      await page.locator('.next-card [data-next-action]').first().click({ timeout: 30000 });
      await page.locator('.question-card').waitFor({ timeout: 30000 });
      assert.ok((await prompt(page)).includes(orig.prompt), `${where}: the round opens on the original question`);

      // A wrong answer: 试一道同类题 under the explanation; the round's counts before the detour.
      await page.locator('.option', { hasText: 'no' }).click();
      const similar = page.locator('[data-usage="review.similar"]');
      await similar.waitFor({ timeout: 30000 });
      assert.equal((await similar.innerText()).trim(), words.similar, `${where}: the button's words`);
      const before = await running.api('review.get', { runId: round.id }), chipBefore = await pendingText(page);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `similar-offer-${lang}-${width}.png`), fullPage: true });
      let overflow = await sideways(page, '.review-body');
      assert.ok(flat(overflow), `${where}: nothing scrolls sideways under the question: ${JSON.stringify(overflow)}`);

      // One press: the similar question of the bank (not of this round), as a round of its own.
      await similar.click();
      await page.waitForFunction((text) => (document.querySelector('.question-card .question')?.textContent || '').includes(text), twin.prompt, { timeout: 30000 });
      await page.locator('.option', { hasText: 'yes' }).click();
      await page.locator('.option.correct').first().waitFor();
      await page.locator('[data-usage="review.next"]').click();
      await page.locator('.result-page').waitFor({ timeout: 30000 });
      if (shots) await page.screenshot({ path: join(shots, `similar-result-${lang}-${width}.png`) });
      // One click back to the question as it was left: still answered, the round's own counts unchanged.
      await page.locator('.result-page').getByRole('button', { name: words.back }).first().click();
      await page.waitForFunction((text) => (document.querySelector('.question-card .question')?.textContent || '').includes(text), orig.prompt, { timeout: 30000 });
      const after = await running.api('review.get', { runId: round.id });
      assert.deepEqual([after.index, after.questions, after.answered, after.total, after.complete], [before.index, before.questions, before.answered, before.total, false],
        `${where}: the detour added nothing to the round`);
      assert.equal(await pendingText(page), chipBefore, `${where}: 「N 题待答」 says the same as before`);
      assert.ok(await page.locator('[data-usage="review.similar"]').isVisible(), `${where}: back on the answered question, with its tools`);
      const state = await running.api('export', {});
      assert.deepEqual(state.attempts.filter((a) => a.deckId === deck.id).map((a) => [a.quiz_id, a.grade >= 3, !!a.implicit]).sort(),
        [[orig.id, false, false], [twin.id, true, false]].sort(), `${where}: one attempt each, no credit for the original`);

      // 用自己的话讲一遍: the box fits the page, one check, three parts, the way to the source and back.
      await page.locator('[data-usage="review.retell"]').click();
      const input = page.locator('.retell-panel__input');
      await input.waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains('retell-panel__input'), null, { timeout: 5000 });
      const box = await input.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.width >= Math.min(300, width - 80), `${where}: the text box is usable (${JSON.stringify(box)})`);
      await input.fill(SECRET);
      await page.getByRole('button', { name: words.check }).click();
      const result = page.locator('.retell-result');
      await result.waitFor({ timeout: 30000 });
      const said = await result.innerText();
      for (const part of words.parts) assert.ok(said.includes(part), `${where}: the answer has ${part}`);
      assert.equal(await input.inputValue(), '', `${where}: the box is emptied once checked`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `retell-${lang}-${width}.png`), fullPage: true });
      overflow = await sideways(page, '.review-body');
      assert.ok(flat(overflow), `${where}: nothing scrolls sideways with the retell open: ${JSON.stringify(overflow)}`);
      const kept = await running.api('export', {});
      assert.equal(kept.decks.find((d) => d.id === deck.id).cards.find((c) => c.id === orig.id).retell.tries, 1, `${where}: the aggregate is kept`);
      assert.equal(JSON.stringify(kept).includes(SECRET), false, `${where}: the words are not kept`);
      await result.getByRole('button', { name: words.source }).click();
      if (width >= 1280) {
        // On a wide page the original opens in the 对照栏 beside the question (#1012): there is no dialog to come back from, so no 回到这道题; the question stays where it is.
        await page.locator('.source-column .study-document-viewer').waitFor({ timeout: 30000 });
        assert.equal(await page.getByRole('button', { name: words.backToQuestion }).count(), 0, `${where}: the question is beside the original, nothing to go back to`);
        assert.ok(await page.locator('.question-card').isVisible(), `${where}: the question stays beside the original`);
      } else {
        const backButton = page.getByRole('button', { name: words.backToQuestion });
        await backButton.first().waitFor({ timeout: 30000 });
        await backButton.first().click();
      }
      await page.locator('.question-card').waitFor({ timeout: 30000 });
      assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver/.test(text)), [], `${where}: no page errors`);
      await context.close();
    }

    // 复习全书: a point's 用自己的话讲一遍 leaves 讲清楚过 ✓, kept after a reload.
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      const point = page.locator('[data-book-point]').first();
      await point.locator('.book-point__retell').click({ timeout: 30000 });
      await point.locator('.retell-panel__input').fill(SECRET);
      await point.getByRole('button', { name: WORDS.zh.check }).click();
      await point.locator('.retell-result').waitFor({ timeout: 30000 });
      await point.locator('.retold-mark', { hasText: WORDS.zh.retold }).waitFor({ timeout: 30000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-retell-${width}.png`) });
      const overflow = await sideways(page, '.book-page');
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways in the book: ${JSON.stringify(overflow)}`);
      await page.reload();
      await page.locator('.course-header .outline-entry, .book-page').first().waitFor({ timeout: 30000 });
      if (!(await page.locator('.book-page').count())) {
        await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
        await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      }
      await page.locator('[data-book-point] .retold-mark').first().waitFor({ timeout: 30000 });
      assert.equal(JSON.stringify(await running.api('export', {})).includes(SECRET), false, `${width}px: the words are not kept`);
      assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver/.test(text)), [], `${width}px: no page errors`);
      await context.close();
    }

    // No similar question: 生成一道变式 asks for one (the fake model writes it), 做这道变式题 is offered, still after a reload, and starts the detour.
    {
      const [vorig, vfar] = VARIANT_DECK.cards;
      for (const open of (await running.api('snapshot', {})).runs || []) await running.api('review.end', { runId: open.id });
      const round = await running.api('review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: VARIANT_DECK.id, cardId: vorig.id }, { deckId: VARIANT_DECK.id, cardId: vfar.id }] });
      const { page, errors, context } = await openRound(browser, running, { lang: 'zh', width: 1280 });
      await page.locator('.option', { hasText: 'no' }).click();
      await page.locator('[data-usage="review.similar"]').click();
      await page.locator('.similar-try__note', { hasText: '题库里没有这一轮之外的同类题' }).waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.similar-variant"]').click();
      const go = page.locator('[data-usage="review.similar-variant-go"]');
      await go.waitFor({ timeout: 60000 });
      const written = (await running.api('export', {})).decks.find((deck) => deck.id === VARIANT_DECK.id).cards.find((card) => !VARIANT_DECK.cards.some((own) => own.id === card.id));
      assert.ok(written, 'the variant is a new question of the same deck');
      // A reload keeps the offer: it is read from the task list, not from the page's memory.
      await page.reload();
      await page.locator('.next-card [data-next-action], .question-card').first().waitFor({ timeout: 30000 });
      if (!(await page.locator('.question-card').count())) await page.locator('.next-card [data-next-action]').first().click();
      await go.waitFor({ timeout: 30000 });
      await go.click();
      // (a flashcard: the prompt is on the card's face)
      await page.waitForFunction((text) => (document.querySelector('.question-card')?.textContent || '').includes(text), written.prompt, { timeout: 30000 });
      const detour = (await running.api('export', {})).runs.find((run) => run.returnTo === round.id);
      assert.deepEqual(detour?.similarFor, { deckId: VARIANT_DECK.id, cardId: vorig.id }, 'the variant is practised as a similar question of the original');

      // A check that fails keeps the words in the box (and in this tab) and stores nothing; the reason is said in the learner's language.
      await page.locator('.result-page, .question-card').first().waitFor();
      await running.api('review.end', { runId: detour.id });
      await page.goto(running.server.url);
      await page.locator('.next-card [data-next-action]').first().click({ timeout: 30000 });
      await page.locator('.question-card').waitFor({ timeout: 30000 });
      await page.route('**/api/call', async (route) => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action !== 'teach.retell') return route.continue();
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Invalid retell feedback; retry' }) });
      });
      await page.locator('[data-usage="review.retell"]').click();
      const input = page.locator('.retell-panel__input');
      await input.fill(SECRET);
      await page.getByRole('button', { name: WORDS.zh.check }).click();
      await page.locator('.retell-panel [role="alert"]', { hasText: '这次没有拿到 AI 的反馈' }).waitFor({ timeout: 30000 });
      assert.equal(await input.inputValue(), SECRET, 'the words stay in the box');
      assert.ok(await page.evaluate((secret) => Object.keys(sessionStorage).some((key) => key.startsWith('studyhub:retell:') && sessionStorage.getItem(key) === secret), SECRET),
        'and in this tab');
      const state = await running.api('export', {});
      assert.equal(state.decks.find((deck) => deck.id === VARIANT_DECK.id).cards.find((card) => card.id === vorig.id).retell, undefined, 'nothing is stored');
      assert.equal(JSON.stringify(state).includes(SECRET), false);
      assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver|400|Invalid retell/.test(text)), [], 'no page errors');
      await context.close();
    }

    // Without a model: 生成一道变式 and 用自己的话讲一遍 stand behind the model gate, at 420 px.
    {
      const base = await mkdtemp(join(tmpdir(), 'study-learning-loop-nomodel-'));
      await seed(join(base, 'library'));
      const bare = { server: await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: null, distDir: dist }) };
      try {
        const [vorig, vfar] = VARIANT_DECK.cards;
        await previewCall(bare.server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
        await previewCall(bare.server, 'review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: VARIANT_DECK.id, cardId: vorig.id }, { deckId: VARIANT_DECK.id, cardId: vfar.id }] });
        const { page, errors, context } = await openRound(browser, bare, { lang: 'zh', width: 420 });
        await page.locator('.option', { hasText: 'no' }).click();
        await page.locator('[data-usage="review.similar"]').click();
        await page.locator('[data-usage="review.similar-variant"]').click();
        await page.locator('.similar-try [role="status"], .similar-try .sh-inline').filter({ hasText: /模型/ }).first().waitFor({ timeout: 30000 });
        await page.locator('[data-usage="review.retell"]').click();
        await page.locator('.retell-panel .sh-inline').filter({ hasText: /模型/ }).first().waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.retell-panel__input').count(), 0, 'no box to write in without a model');
        const overflow = await sideways(page, '.review-body');
        assert.ok(flat(overflow), `no sideways scroll with the gates: ${JSON.stringify(overflow)}`);
        if (shots) await page.screenshot({ path: join(shots, 'gates-zh-420.png'), fullPage: true });
        assert.deepEqual(errors.filter((text) => !/favicon|ResizeObserver/.test(text)), [], 'no page errors');
        await context.close();
      } finally {
        await bare.server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  } finally {
    await browser.close();
    await running.close();
  }
});
