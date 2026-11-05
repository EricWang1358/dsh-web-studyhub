/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 深度定制 (skills/study-custom) in the real page, zh dark 1440 and en light 420: the review book's 更多 › 整本书 › 深度定制… hands the interview to the main chat (the preview has
   no chat, so the message is copied: the clipboard is the test's stand-in for askInChat), and the 解析历史 row of a converted book of 150 pages or more offers 深度定制这本书 once
   (a shorter one does not). Nothing scrolls sideways. Screenshots go to CUSTOM_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}#1`] }] }],
      other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The architect of ${leaf.title} writes each decision down with its reasons.`,
        cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }), createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('main *, dialog *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const flat = (page, label) => sideways(page).then(overflow => assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${label}: nothing scrolls sideways: ${JSON.stringify(overflow)}`));

const record = (id, filename, pages) => ({ id, version: 1, filename, bytes: 9 << 20, pages, pieces: 1, route: 'local', tier: 'basic', status: 'complete', phase: 'done', pagesDone: pages, attempts: 1,
  elapsedMs: 600_000, startedAt: new Date(Date.now() - 3_600_000).toISOString(), finishedAt: new Date(Date.now() - 600_000).toISOString(), importedPages: pages, skippedPages: 0,
  documentId: `document-${id}`, title: filename.replace(/\.pdf$/, ''), canRetry: false, live: false, document: { exists: true, title: filename.replace(/\.pdf$/, ''), pages, sourceIds: ['s1'] } });

test('深度定制: the review book\'s 更多 hands the interview over; the 解析历史 row of a 450-page book offers it once, a 120-page one does not (zh dark 1440, en light 420)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.CUSTOM_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const [lang, theme, width] of [['zh', 'dark', 1440], ['en', 'light', 420]]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { lang, theme, width, height: 900 });
      await context.addInitScript(() => {
        window.__sentToChat = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__sentToChat.push(text); } } });
      });
      const records = [record('long', 'Databases.pdf', 450), record('short', 'Handout.pdf', 120)];
      await page.route('**/api/call', async route => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action === 'mineru.history.list') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { records } }) });
        return route.continue();
      });
      const label = `${lang} ${theme} ${width}`;

      // 解析历史 on the sources page: 450 pages offers it, 120 does not; pressing it hands the message over and the row stops offering it.
      await page.goto(running.server.url);
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      const history = page.locator('.pdf-history');
      await history.first().waitFor({ timeout: 30000 });
      await history.locator('summary, button').first().click().catch(() => {});
      const long = page.locator('.pdf-history__item[data-record="long"]'), short = page.locator('.pdf-history__item[data-record="short"]');
      await long.waitFor({ timeout: 15000 });
      await short.waitFor({ timeout: 15000 });
      assert.equal(await long.locator('[data-hand-off="custom.start"]').count(), 1, `${label}: the 450-page book offers it`);
      assert.equal(await short.locator('[data-hand-off="custom.start"]').count(), 0, `${label}: the 120-page one does not`);
      assert.equal(await long.locator('[data-hand-off="custom.start"]').innerText(), lang === 'en' ? 'Customize this book in depth' : '深度定制这本书');
      await long.scrollIntoViewIfNeeded();
      await flat(page, `${label} history`);
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `history-row-${lang}-${theme}-${width}.png`) }); }
      await long.locator('[data-hand-off="custom.start"]').click();
      await page.waitForFunction(() => window.__sentToChat.length > 0, null, { timeout: 15000 });
      const sent = (await page.evaluate(() => window.__sentToChat.slice())).at(-1);
      assert.match(sent, lang === 'en' ? /^Help me customize this book in depth \(450 pages\)/ : /^帮我给这本书（共 450 页）做深度定制/, `${label}: the learner's sentence first`);
      assert.match(sent, /study-custom/);
      assert.ok(sent.includes('"document-long"'), `${label}: the document key`);
      await long.locator('[data-hand-off="custom.start"]').waitFor({ state: 'detached', timeout: 5000 });

      // 更多 › 整本书 › 深度定制…: always in the menu of the review book; it hands over the course with no document.
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
      await page.locator('.book-bar__more').click();
      const item = page.getByRole('menuitem', { name: lang === 'en' ? /^Customize in depth/ : /^深度定制/ });
      await item.waitFor({ timeout: 5000 });
      if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `book-more-${lang}-${theme}-${width}.png`) }); }
      const before = await page.evaluate(() => window.__sentToChat.length);
      await item.click();
      await page.waitForFunction(count => window.__sentToChat.length > count, before, { timeout: 15000 });
      const whole = (await page.evaluate(() => window.__sentToChat.slice())).at(-1);
      assert.match(whole, lang === 'en' ? /^Help me customize the course `.+` in depth/ : /^帮我给课程 `.+` 做深度定制/, `${label}: the course sentence`);
      assert.doesNotMatch(whole, /文档 key|document key/, `${label}: no document from the menu`);
      await flat(page, `${label} book`);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
