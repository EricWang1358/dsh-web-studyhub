/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* #1127 in a real browser: the 先深度定制这本书？ dialog's recommended button (a 160-page converted book of the course 宏经, as tests/icon-round10-browser.test.mjs seeds it) wraps
   in English at the narrow widths; its icon stays beside the first line of words (it was 59px away at 420px, 8px is the usual gap), at 320, 375 and 420px, light and dark,
   and the button stays inside the dialog. ICON_ROUND12_SHOTS=<dir> keeps a picture of each. */

const SHOTS = process.env.ICON_ROUND12_SHOTS || '';
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

/** Where the icon sits against the lines of words of a button: the gap between the icon and the nearest line start, and whether the icon's middle is on the first line. */
const measure = (button) => button.evaluate((element) => {
  const icon = element.querySelector('svg').getBoundingClientRect(), range = document.createRange(), box = element.getBoundingClientRect();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 4 && rect.height > 4 && rect.left >= icon.right - 1);
  const first = lines.reduce((top, rect) => (rect.top < top.top ? rect : top), lines[0]), middle = (icon.top + icon.bottom) / 2;
  return { gap: Math.round((Math.min(...lines.map((rect) => rect.left)) - icon.right) * 10) / 10, lines: new Set(lines.map((rect) => Math.round(rect.top))).size,
    onFirstLine: middle >= first.top - 1 && middle <= first.bottom + 1, left: box.left, right: box.right };
});

test('#1127 in the browser: the recommended button of the gate dialog keeps its icon beside its first line at 320, 375 and 420px (en, light and dark; zh at 420)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-icon-round12-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  let wrapped = 0;
  for (const lang of ['en', 'zh']) {
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      for (const [theme, width] of lang === 'en' ? [['light', 320], ['dark', 320], ['light', 375], ['dark', 375], ['light', 420], ['dark', 420]] : [['light', 420]]) {
        const { page: view, context } = await openPage(browser, running, { lang, theme, width, height: 900 });
        try {
          const label = `${lang} ${theme} ${width}px`;
          await view.goto(running.server.url);
          await view.locator('.course-header .outline-entry').first().click();
          await view.locator('.outline-organise').waitFor({ timeout: 30000 });
          await view.getByRole('button', { name: lang === 'en' ? /Write the review book/ : '生成复习全书' }).first().click();
          const dialog = view.locator('dialog[data-custom-gate][open]');
          await dialog.waitFor({ timeout: 10000 });
          await settleAnimations(view);
          const button = dialog.locator('[data-custom-gate-action="custom"]'), found = await measure(button), box = await dialog.boundingBox();
          assert.ok(found.gap >= 0 && found.gap <= 12, `${label}: the icon is ${found.gap}px from the words (${JSON.stringify(found)})`);
          assert.equal(found.onFirstLine, true, `${label}: the icon is level with the first line (${JSON.stringify(found)})`);
          assert.ok(found.left >= box.x && found.right <= box.x + box.width, `${label}: the button stays inside the dialog (${JSON.stringify(found)})`);
          if (found.lines > 1) wrapped += 1;
          if (SHOTS) await dialog.screenshot({ path: join(SHOTS, `gate-${lang}-${theme}-${width}.png`) });
        } finally { await context.close(); }
      }
    } finally { await running.close(); }
  }
  assert.ok(wrapped >= 2, `the button wrapped in ${wrapped} of the narrow cases: the measure means something`);
});
