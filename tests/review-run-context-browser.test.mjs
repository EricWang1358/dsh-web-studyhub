/* global localStorage, document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* The line under the title of the practice page (查看 N 份资料) also says the course, how this chapter (the deck) stands and how the whole course stands, in the
   words of the lists. In a real browser, in both languages at 1280 and 420 px: the figures are there and say what the library says, the line sits inside the
   heading and the window (it wraps, the page does not scroll sideways), and the hover of a part carries its words. STUDYHUB_SHOTS=<folder> keeps the screenshots. */

const COURSE = 'Architecting Software Solutions';
const A = 'API 粒度与产品思维 / API Granularity and Product Mindset', B = 'Event-driven architecture';
const flash = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '', explanation: 'Because.', misconception: '', citations: [] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-context-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => {
    s.decks.push({ id: 'da', title: A, course: COURSE, cards: [1, 2, 3].map((n) => flash(`a${n}`, n)) });
    s.decks.push({ id: 'db', title: B, course: COURSE, cards: [4, 5, 6, 7, 8].map((n) => flash(`b${n}`, n)) });
  });
  // The first deck is learned (every card answered once), the second is untouched: its chapter says 未学, the whole course is part-learned.
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'da' }], fresh: true });
  while (!run.complete) {
    await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
    await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 4 });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return { root, service };
}

const WORDS = {
  zh: { start: (title) => `开始学习 ${title}`, chapter: '本章', whole: '整课程', fresh: '未学 · 5 题', learned: /^掌握 \d+% · 3 题$/, course: /^掌握 \d+% · 8 题$/, tip: /这道题所在的题组/ },
  en: { start: (title) => `Start studying ${title}`, chapter: 'This chapter', whole: 'Whole course', fresh: 'New · 5 questions', learned: /^Mastery \d+% · 3 questions$/, course: /^Mastery \d+% · 8 questions$/, tip: /The deck this question is in/ },
};

test('the practice page names the course and how this chapter and the whole course stand, and the line holds together (zh and en, 1280 and 420 px)', { timeout: 600000 }, async (t) => {
  const { root } = await library(t);
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const shots = process.env.STUDYHUB_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const lang of ['zh', 'en']) {
    for (const [width, height] of [[1280, 800], [420, 900]]) {
      for (const [deckTitle, deckId] of [[B, 'db'], [A, 'da']]) {
        const where = `${lang} ${width}px ${deckId}`, words = WORDS[lang];
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript((language) => { localStorage.setItem('study-ui-language', language); localStorage.setItem('study-autopilot', 'off'); }, lang);
        await page.goto(server.url);
        await page.getByRole('button', { name: words.start(deckTitle) }).first().click();
        const line = page.locator('[data-review-context]');
        await line.waitFor({ timeout: 30000 });
        const read = await page.evaluate(() => {
          const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
          const context = document.querySelector('[data-review-context]'), links = context.closest('.review-heading-links'), header = context.closest('header');
          const parts = [...context.querySelectorAll('.review-context__part')].map((part) => {
            const label = part.querySelector('.review-context__label').textContent;
            return { label, text: part.textContent.replace(label, '').trim(), box: box(part) };
          });
          return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, course: context.querySelector('.review-context__course').textContent, parts,
            courseBox: box(context.querySelector('.review-context__course')), header: box(header), button: box(links.querySelector('button')), cut: links.scrollWidth > links.clientWidth + 1, titleAttribute: !!context.querySelector('[title]') };
        });
        assert.equal(read.course, COURSE, `${where}: the course`);
        assert.deepEqual(read.parts.map((part) => part.label), [words.chapter, words.whole], `${where}: both figures`);
        if (deckId === 'db') assert.equal(read.parts[0].text, words.fresh, `${where}: the untouched deck's chapter is 未学`);
        else assert.match(read.parts[0].text, words.learned, `${where}: the learned deck's chapter`);
        assert.match(read.parts[1].text, words.course, `${where}: the whole course counts both decks`);
        assert.equal(read.titleAttribute, false, `${where}: no title attribute`);
        assert.ok(read.scrollWidth <= read.viewport, `${where}: no sideways scroll (${read.scrollWidth} in ${read.viewport})`);
        assert.equal(read.cut, false, `${where}: nothing hidden beyond the edge of the row`);
        for (const [name, inner] of [['the course', read.courseBox], ...read.parts.map((part) => [part.label, part.box])])
          assert.ok(inner.left >= read.header.left - 0.75 && inner.right <= Math.min(read.header.right, read.viewport) + 0.75, `${where}: ${name} is inside the heading and the window (${Math.round(inner.left)}-${Math.round(inner.right)} of ${Math.round(read.header.left)}-${Math.round(read.header.right)})`);
        assert.ok(read.courseBox.top >= read.button.bottom - 1 || read.courseBox.left >= read.button.right - 1, `${where}: the course sits beside or below the button, never over it`);
        // the hover of a part carries its words
        await page.locator('.review-context__part').first().hover();
        const tip = page.locator('.review-context .sh-tooltip').first();
        await tip.waitFor({ state: 'visible' });
        assert.match(await tip.innerText(), words.tip, `${where}: the hover says what this chapter is`);
        if (shots) await page.screenshot({ path: join(shots, `review-context-${lang}-${width}-${deckId}.png`) });
        assert.deepEqual(errors, [], `${where}: no page errors`);
        await context.close();
      }
    }
  }
});
