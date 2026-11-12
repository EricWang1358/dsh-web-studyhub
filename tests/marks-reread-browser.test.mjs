/* global window document CSS */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* 今日 「重读 N 段」 (#1018) in the real page at 1280 and 420 px. Two passages of an imported text were highlighted and bolded days ago and its questions
   were answered wrong, so the home's today card shows 「重读 2 段」. The home is drawn before the answer comes (the request is held back here: the line
   never delays the first screen). The line opens the reader at the passage (quoted, painted, in view); 已重读 keeps the time and moves on to the
   next passage; back home the count dropped. At 420: 再练这一节 starts the section's questions; 已重读 on the last passage ends it and the line goes.
   Screenshots go to REREAD_SHOTS when set. */

const COURSE = 'SA';
const FIRST = 'tactics detect faults and recover from them';
const SECOND = 'a heartbeat tells a monitor the process is alive';
const TEXT = `# Availability\n\nAvailability ${FIRST} before users notice a failure.\n\nIn a ping/echo or heartbeat tactic, ${SECOND} at a fixed interval.\n`;
const DAY = 86400000;

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const imported = await service.call('materials.document.import', { filename: 'availability.md', courses: [COURSE], dataBase64: Buffer.from(TEXT).toString('base64') });
  const document = await service.call('materials.document.get', { id: imported.documentId }), sourceId = document.sources[0].id;
  const id = { documentId: document.documentId, revision: document.revision };
  for (const [quote, style] of [[FIRST, 'highlight'], [SECOND, 'bold']]) {
    const saved = await service.call('materials.marks.save', { ...id, selection: { ...id, sourceId, quote }, style });
    assert.equal(saved.status, 'saved');
  }
  await service.store.update(state => {
    // Marked 6 and 5 days ago; the section's two questions were answered wrong.
    const items = state.documents.flatMap(item => item.versions).flatMap(version => version.marks?.items || []);
    items.forEach((item, index) => { item.at = new Date(Date.now() - (6 - index) * DAY).toISOString(); });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    state.decks.push({ id: 'availability', title: 'Availability', course: COURSE, cards: [
      { id: 'q1', topic: 'Availability', prompt: 'What does an availability tactic do?', answer: 'Detects faults and recovers from them.', citations: [{ sourceId, quote: FIRST }] },
      { id: 'q2', topic: 'Availability', prompt: 'What does a heartbeat tell a monitor?', answer: 'That the process is alive.', citations: [{ sourceId, quote: SECOND }] }] });
    for (const cardId of ['q1', 'q2']) state.attempts.push({ deckId: 'availability', quiz_id: cardId, grade: 1, at: new Date(Date.now() - 4 * DAY).toISOString() });
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Is the reader's quote painted once, and inside the reading column's view? */
const placed = page => page.evaluate(() => {
  const range = [...(CSS.highlights?.get('study-source-quote') || [])][0];
  const scroller = document.querySelector('.reader-scroll');
  if (!range || !scroller) return false;
  const box = range.getBoundingClientRect(), view = scroller.getBoundingClientRect();
  return box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
});

test('重读 N 段: the line comes after the home is drawn, opens the reader at the passage, 已重读 lowers the count, 再练这一节 practises (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-marks-reread-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.REREAD_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => { try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
      const shot = async name => { if (shots) { await settleAnimations(page); await page.screenshot({ path: join(shots, `reread-${width}-${name}.png`) }); } };
      const line = page.locator('[data-reread]'), open = page.locator('[data-usage="home.reread"]');
      const dialog = page.locator('.source-preview'), quote = dialog.locator('.reader-aux__quote');
      const closeReader = async () => { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached', timeout: 30000 }); };

      // The home is drawn while materials.marks.reread is still unanswered: the line never holds the first screen back.
      let release = () => {};
      const held = new Promise(resolve => { release = resolve; });
      let asked = 0;
      await page.route('**/*', async route => {
        let action = '';
        try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
        if (action === 'materials.marks.reread') { asked += 1; if (asked === 1) await held; }
        await route.continue();
      });
      await page.goto(running.server.url);
      await page.locator('.today-card').waitFor({ timeout: 30000 });
      assert.equal(await line.count(), 0, `${width}px: no line before the answer`);
      release();
      await open.waitFor({ timeout: 30000 });
      assert.ok(asked >= 1, `${width}px: asked once the home was drawn`);
      const expected = width === 1280 ? 2 : 1;
      assert.equal((await open.innerText()).trim(), `重读 ${expected} 段`);
      assert.ok(await sideways(page) <= 0, `${width}px: the home does not scroll sideways`);
      await shot('1-home');

      // The line → the reader at the (first) passage: quoted above the text, painted in it and in view.
      await open.click();
      await dialog.waitFor({ timeout: 30000 });
      const first = width === 1280 ? FIRST : SECOND;
      await quote.getByText(first).waitFor({ timeout: 30000 });
      await page.waitForFunction(() => (CSS.highlights?.get('study-source-quote')?.size || 0) > 0, null, { timeout: 30000 });
      assert.ok(await placed(page), `${width}px: the reader lands on the passage`);
      assert.equal(await dialog.locator('.reader-notices').getByText('此引用来自较早版本', { exact: false }).count(), 0, `${width}px: the passage is of the current revision, no warning`);
      const done = dialog.locator('[data-reread="done"]'), practise = dialog.locator('[data-reread="practise"]');
      assert.equal((await done.innerText()).trim(), '已重读');
      await practise.waitFor({ timeout: 30000 });
      assert.ok(await sideways(page) <= 0, `${width}px: the reader does not scroll sideways`);
      await shot('2-reader');

      if (width === 1280) {
        // 已重读 → kept on the mark, and the reader moves on to the second passage.
        await done.click();
        await quote.getByText(SECOND).waitFor({ timeout: 30000 });
        await page.waitForFunction(() => (CSS.highlights?.get('study-source-quote')?.size || 0) > 0, null, { timeout: 30000 });
        assert.ok(await placed(page), `${width}px: the next passage is in view`);
        await closeReader();
        await open.waitFor({ timeout: 30000 });
        await page.waitForFunction(() => document.querySelector('[data-usage="home.reread"]')?.textContent.includes('1'), null, { timeout: 30000 });
        assert.equal((await open.innerText()).trim(), '重读 1 段', `${width}px: the count dropped`);
        await shot('3-home-after');
      } else {
        // 再练这一节 → the questions of the section being read.
        await practise.click();
        await dialog.waitFor({ state: 'detached', timeout: 30000 });
        await page.getByText(/What does (an availability tactic do|a heartbeat tell a monitor)\?/).first().waitFor({ timeout: 30000 });
        await shot('3-practice');
        // Still waiting on the home; 已重读 on the last passage ends it, and the line goes.
        await page.goto(running.server.url);
        await open.waitFor({ timeout: 30000 });
        await open.click();
        await quote.getByText(SECOND).waitFor({ timeout: 30000 });
        await done.click();
        await done.waitFor({ state: 'detached', timeout: 30000 });
        await closeReader();
        await page.locator('.today-card').waitFor({ timeout: 30000 });
        await line.waitFor({ state: 'detached', timeout: 30000 });
        assert.equal(await line.count(), 0, `${width}px: nothing left to re-read, no line`);
        await shot('4-home-done');
      }
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
    const kept = await running.api('materials.marks.reread', { course: COURSE });
    assert.equal(kept.count, 0, 'both re-read today');
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
