/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatPreview } from './helpers/chat-preview.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #1073 round 10 of the review of PR #1118, in a real browser (a 160-page converted book of the course 宏经, as tests/custom-entry-gate-browser.test.mjs seeds it):
     1  the home's 总纲 buttons end in → and draw nothing in front;
     2  the hand-off to the main chat leads with the external mark and draws no arrow: 深度定制 on the 资料 row, 深度定制这本书（推荐） in the gate dialog of the 总纲 page;
     4  the 资料 page's header has no space after 「。」 in Chinese, and one space after a full stop in English.
   ICON_ROUND10_SHOTS=<dir> keeps a picture of each place. */

const SHOTS = process.env.ICON_ROUND10_SHOTS || '';
const ARROW = 'M220.24,132.24', EXTERNAL = 'M222,104a6,6,0,0,1-12,0V54.49';
const at = '2026-11-01T08:00:00.000Z', PAGES = 160, COURSE = '宏经';
const fact = (topic, i) => `${topic} fact ${i}: aggregate demand, aggregate supply and the multiplier move output and prices in the short run.`;
const page = (n) => ({ id: `${COURSE}-p${n}`, title: `Macro book · p. ${n}`, text: Array.from({ length: 4 }, (_, i) => fact(`Page${n}`, i)).join(' '), createdAt: at, courses: [COURSE],
  document: { materialId: `document-${COURSE}-book`, page: n, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: `${COURSE}-book.pdf`, extractionVersion: 2 } });
const seed = async (root) => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => page(index + 1)));
    state.decks.push({ id: `deck-${COURSE}`, title: `${COURSE} deck`, course: COURSE, cards: [1, 2, 3].map((n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Output', prompt: `Question ${n}: what moves output in the short run?`,
      answer: 'Aggregate demand.', explanation: 'See the book.', citations: [{ sourceId: `${COURSE}-p${n}`, quote: fact(`Page${n}`, 1) }] })) });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  await service.call('course.save', { name: COURSE });
  await service.dispose();
};

/** The marks inside a button: where each svg sits (before or after the words) and which glyph it is. */
const marks = (button) => button.evaluate((element) => {
  const box = element.getBoundingClientRect();
  return [...element.querySelectorAll('svg')].filter((svg) => svg.getClientRects().length).map((svg) => ({
    side: svg.getBoundingClientRect().left < box.left + box.width / 2 ? 'lead' : 'trail', d: svg.querySelector('path')?.getAttribute('d')?.slice(0, 40) ?? '' }));
});
const description = (target) => target.locator('.sh-page-header__description').first().innerText();

test('round 10 in the browser: 总纲 ends in →, the hand-off leads with the external mark, the 资料 header joins its sentences', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-icon-round10-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildChatPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  for (const { lang, width } of [{ lang: 'zh', width: 1440 }, { lang: 'en', width: 1440 }, { lang: 'zh', width: 420 }]) {
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      const { page: view, context } = await openPage(browser, running, { lang, theme: 'light', width, height: 900 });
      await view.goto(running.server.url);
      await view.locator('.course-header .outline-entry').first().waitFor({ timeout: 30000 });
      const label = `${lang} ${width}px`;
      // ---- 1: the home's 总纲 buttons ----
      const buttons = view.locator('.outline-entry');
      for (let index = 0; index < await buttons.count(); index++) {
        const one = buttons.nth(index), found = await marks(one);
        assert.equal(found.length, 1, `${label}: 总纲 #${index} draws one mark`);
        assert.equal(found[0].side, 'trail', `${label}: 总纲 #${index}: after the words`);
        assert.ok(found[0].d.startsWith(ARROW), `${label}: 总纲 #${index}: the go-on arrow (${found[0].d})`);
        const box = await one.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${label}: 总纲 #${index} inside the window`);
      }
      if (SHOTS) await view.screenshot({ path: join(SHOTS, `home-${lang}-${width}.png`) });
      // ---- 4: the 资料 page's header ----
      await (await revealNavRow(view, 'sources')).dispatchEvent('click');
      await view.locator('.sh-page-header__description').first().waitFor({ timeout: 30000 });
      const header = (await description(view)).replace(/\n+/g, ' ');
      if (lang === 'zh') {
        assert.match(header, /原文与引用一直保留。共 \d+ 份资料/, `${label}: ${header}`);
        assert.doesNotMatch(header, /。\s+共/, `${label}: no space after 。`);
      } else assert.match(header, /citations are retained\. \d+ sources?, grouped/, `${label}: ${header}`);
      if (SHOTS) await view.locator('.sources-page__header').first().screenshot({ path: join(SHOTS, `sources-header-${lang}-${width}.png`) });
      // ---- 2: the hand-off ----
      if (lang === 'zh' && width === 1440) {
        const entry = view.locator('.source-doc [data-hand-off="custom.start"]').first();
        await entry.waitFor({ timeout: 30000 });
        const row = await marks(entry);
        assert.equal(row.length, 1, 'the 资料 row\'s 深度定制: one mark');
        assert.deepEqual([row[0].side, row[0].d.startsWith(EXTERNAL)], ['lead', true], 'in front, the external mark');
        await settleAnimations(view);
        if (SHOTS) await view.locator('article.source-doc').first().screenshot({ path: join(SHOTS, 'handoff-sources-row-zh-1440.png') });
        await view.goto(running.server.url);
        await view.locator('.course-header .outline-entry').first().click();
        await view.locator('.outline-organise').waitFor({ timeout: 30000 });
        await view.getByRole('button', { name: '生成复习全书', exact: true }).first().click();
        const dialog = view.locator('dialog[data-custom-gate][open]');
        await dialog.waitFor({ timeout: 10000 });
        const gate = await marks(dialog.locator('[data-custom-gate-action="custom"]'));
        assert.equal(gate.length, 1, 'the gate\'s 深度定制这本书（推荐）: one mark');
        assert.deepEqual([gate[0].side, gate[0].d.startsWith(EXTERNAL)], ['lead', true], 'in front, the external mark');
        await settleAnimations(view);
        if (SHOTS) await view.screenshot({ path: join(SHOTS, 'handoff-gate-zh-1440.png') });
        const sideways = await view.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(sideways <= 0, 'the gate does not scroll sideways');
      }
      await context.close();
    } finally { await running.close(); }
  }
});
