/* global document, getComputedStyle, NodeFilter */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { StudyService } from '../lib/service.js';

/* #1073 round 9 of the review of PR #1118, in a real browser:
     1  an English library of one source says "1 source, grouped by course (1 group)" on the 资料 page (it said "1 sources … (1 groups)": the template starts with a
        space and the singular lookup did not trim it), and no page of that library says "1 <plural>" (the 创建题组 picker said "1 / 1 sources selected");
     5  the breadcrumb separates StudyHub and the page with the chevron, not the go-on arrow.
   ICON_ROUND9_SHOTS=<dir> keeps a screenshot of each place. */

const SHOTS = process.env.ICON_ROUND9_SHOTS || '';
const ARROW = 'M220.24,132.24', CHEVRON = 'M180.24,132.24';
const PAGES = ['library', 'sources', 'generate', 'tasks', 'wrongbook', 'notes', 'dashboard'];

async function serve(base, name, count) {
  const root = join(base, name, 'library');
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    for (let index = 1; index <= count; index++) state.sources.push({ id: `own${index}`, title: `Lecture ${index}.md`, text: 'Threads, locks and deadlock. '.repeat(40), createdAt: '2026-11-01T08:00:00.000Z', courses: ['Operating Systems'], chars: 1160 });
  });
  await service.dispose?.();
  return createPreviewServer({ libraryRoot: root, home: join(base, name, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: join(base, 'dist') });
}

async function open(browser, server, { lang = 'en', width = 1440 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', locale: lang === 'en' ? 'en-US' : 'zh-CN' });
  await context.addInitScript((l) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(server.url);
  await page.locator('.study-app').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  const later = page.getByRole('button', { name: lang === 'en' ? /Maybe later|Not now/ : '以后再说' });
  if (await later.count()) { await later.first().click(); await page.waitForTimeout(800); }
  return { context, page, errors };
}
async function go(page, id) {
  const target = page.locator(`[data-tour="nav-${id}"]`).first();
  for (const fold of await page.locator('.nav-fold__toggle').all()) { if (await target.isVisible().catch(() => false)) break; await fold.click().catch(() => {}); await page.waitForTimeout(300); }
  await target.click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
/** Visible text that says "1 <plural noun>". */
const oneWithPlural = (page) => page.evaluate(() => {
  const nouns = 'sources|questions|decks|groups|cards|pages|items|rounds|times|attempts|days|minutes|hours|sections|chapters|points|topics|materials|drafts|jobs|notes|files|words|characters|parts|batches|steps|courses|lessons|mistakes|answers|marks|tokens|calls|runs|tasks|entries';
  const re = new RegExp(`(?<![\\d.,/–-])\\b1 (?:[a-z-]+ )?(?:${nouns})\\b`, 'g'), out = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
    for (const hit of (element.innerText || node.data).replace(/\s+/g, ' ').matchAll(re)) out.add(hit[0]);
  }
  return [...out];
});
const summary = (page) => page.locator('.sh-page-header').first().evaluate((header) => header.innerText.replace(/\s+/g, ' '));

test('round 9 in the browser: English singulars on every page of a one-source library, and the breadcrumb\'s chevron', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-icon-round9-'));
  await buildPreview({ outdir: join(base, 'dist') });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  const one = await serve(base, 'one', 1), two = await serve(base, 'two', 2);
  try {
    await t.test('1: one source says "1 source … (1 group)", two say "2 sources … (1 group)", and no page of the one-source library says "1 <plural>"', async () => {
      const { context, page, errors } = await open(browser, one);
      const found = {};
      for (const id of PAGES) {
        await go(page, id);
        if (id === 'sources') {
          const line = await summary(page);
          assert.match(line, /\b1 source, grouped by course \(1 group\)\./, line);
          await shot(page, 'sources-en-1440-one');
        }
        const hits = await oneWithPlural(page);
        if (hits.length) found[id] = hits;
      }
      assert.deepEqual(found, {});
      assert.deepEqual(errors, []);
      await context.close();
      const second = await open(browser, two);
      await go(second.page, 'sources');
      const line = await summary(second.page);
      assert.match(line, /\b2 sources, grouped by course \(1 group\)\./, line);
      await shot(second.page, 'sources-en-1440-two');
      await second.context.close();
    });

    await t.test('5: the breadcrumb separates its path with the chevron, never the go-on arrow (zh and en, 1440)', async () => {
      for (const lang of ['zh', 'en']) {
        const { context, page } = await open(browser, one, { lang });
        const marks = await page.locator('.crumbs').first().evaluate((crumbs) => [...crumbs.querySelectorAll('svg path')].map((path) => path.getAttribute('d').slice(0, 14)));
        assert.equal(marks.length, 1, `${lang}: one separator`);
        assert.ok(marks[0].startsWith(CHEVRON) && !marks[0].startsWith(ARROW), `${lang}: the chevron (${marks[0]})`);
        await shot(page, `crumbs-${lang}-1440`);
        await context.close();
      }
    });
  } finally {
    await one.close();
    await two.close();
    await browser.close();
    await rm(base, { recursive: true, force: true });
  }
});
