/* global localStorage, document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';

/* 修题 on the card, with the learner's own phrases, in a real browser: the button is on the toolbar (not behind 更多), the box offers the built-in choices, a typed
   line is kept with one click and comes back as a chip after a reload (it is in the library's settings, not in the browser), a click on the chip fills the box, its ✕
   removes it with 撤销, and the page never scrolls sideways at 1440 or 420 px. Nothing is sent to a model. STUDYHUB_SHOTS=<folder> keeps the screenshots. */

const OWN = '请采用代码块格式改写题目的原有口述代码形式';
const flash = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '', explanation: 'Because.', misconception: '', citations: [] });

test('修题 is a button on the card, the box keeps my own phrases as chips, and they survive a reload (zh 1440 and 420 px, en 420 px)', { timeout: 600000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fix-phrases-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'Flash deck', cards: [1, 2, 3].map((n) => flash(`c${n}`, n)) }); });
  await service.dispose(); // the preview server owns the library from here
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir }); // 修题 is behind the model gate
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const shots = process.env.STUDYHUB_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const savedPhrases = async () => (await previewCall(server, 'snapshot')).settings.practice?.fixPhrases;

  const WORDS = {
    zh: { start: 'Flash deck', improve: '修题', more: '更多', own: '我的常用语句', save: '存为我的常用语句', removeOwn: '删除常用语句「请采用代码块格式改写题目的原有口述代码形式」', undo: '撤销' },
    en: { start: 'Flash deck', improve: 'Improve question', more: 'More', own: 'My phrases', save: 'Save as my phrase', removeOwn: 'Delete phrase “请采用代码块格式改写题目的原有口述代码形式”', undo: 'Undo' },
  };
  for (const [lang, width, height] of [['zh', 1440, 900], ['zh', 420, 900], ['en', 420, 900]]) {
    const where = `${lang} ${width}px`, words = WORDS[lang];
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((language) => { localStorage.setItem('study-ui-language', language); localStorage.setItem('study-autopilot', 'off'); }, lang);
    const open = async () => {
      await page.goto(server.url);
      // the home's one big button starts the day's round, or goes on with the run that was left open
      const card = page.locator('.flashcard');
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await card.waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200); // the toolbar is rebuilt once when the run's first refresh lands
    };
    await open();

    // 修题 is on the toolbar: visible without opening 更多, beside 帮我弄懂, and not an item of the menu
    const toolbar = page.locator('.question-toolbar');
    const improve = toolbar.getByRole('button', { name: words.improve, exact: true });
    await improve.waitFor();
    const read = await page.evaluate(() => {
      const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const buttons = [...document.querySelectorAll('.question-toolbar button')].map((button) => ({ text: button.textContent.trim(), ...box(button) }));
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, buttons };
    });
    assert.ok(read.scrollWidth <= read.viewport, `${where}: no sideways scroll (${read.scrollWidth} in ${read.viewport})`);
    for (const button of read.buttons) assert.ok(button.left >= -0.5 && button.right <= read.viewport + 0.5, `${where}: ${button.text} is inside the window`);
    if (shots && lang === 'zh') await page.screenshot({ path: join(shots, `card-${lang}-${width}.png`) });
    await toolbar.getByRole('button', { name: words.more, exact: true }).click();
    assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: words.improve, exact: true }).count(), 0, `${where}: 修题 is not in the menu`);
    await page.keyboard.press('Escape');

    // the box: built-in choices, no own chips yet
    await improve.click();
    const box = page.locator('.assist-form');
    await box.waitFor();
    assert.equal(await box.locator('[data-fix-phrases]').count(), 0, `${where}: no own phrases yet`);
    assert.ok(await box.locator('.sh-chip__main').count() >= 5, `${where}: the built-in choices are there`);
    assert.equal(await box.getByRole('button', { name: words.save }).count(), 0, `${where}: nothing typed, nothing to keep`);

    // keep what was typed, with one click
    const field = box.locator('textarea');
    await field.fill(OWN);
    await box.locator('.assist-actions').scrollIntoViewIfNeeded();
    if (shots && lang === 'zh') await page.screenshot({ path: join(shots, `panel-typed-${lang}-${width}.png`) });
    await box.getByRole('button', { name: words.save }).click();
    const group = box.locator('[data-fix-phrases]');
    await group.waitFor({ timeout: 15000 });
    assert.match(await group.innerText(), new RegExp(words.own), `${where}: the group is named`);
    assert.equal(await group.locator('.sh-chip__main').innerText(), OWN, `${where}: the phrase is a chip`);
    assert.deepEqual(await savedPhrases(), [OWN], `${where}: it is in the library settings`);
    assert.equal(await box.getByRole('button', { name: words.save }).count(), 0, `${where}: the same text is not offered twice`);
    assert.ok(/Already in my phrases|已在我的常用语句里/.test(await box.innerText()), `${where}: and says it is kept`);

    // it survives a reload; a click fills the box
    await open(); // a new page load, the run begins again
    await toolbar.getByRole('button', { name: words.improve, exact: true }).click();
    await box.waitFor();
    const chip = box.locator('[data-fix-phrases] .sh-chip__main');
    await chip.waitFor();
    await box.locator('textarea').fill('');
    await chip.click();
    assert.equal(await box.locator('textarea').inputValue(), OWN, `${where}: a click fills the box with the phrase`);
    await box.locator('.assist-actions').scrollIntoViewIfNeeded();
    if (shots && lang === 'zh') await page.screenshot({ path: join(shots, `panel-${lang}-${width}.png`) });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(wide, `${where}: the box fits the window`);

    // remove it, then take it back
    await box.getByRole('button', { name: words.removeOwn }).click();
    await box.locator('[data-fix-phrases]').waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await savedPhrases(), undefined, `${where}: removed from the library settings`);
    await page.getByRole('button', { name: words.undo, exact: true }).click();
    await box.locator('[data-fix-phrases]').waitFor({ timeout: 15000 });
    assert.deepEqual(await savedPhrases(), [OWN], `${where}: 撤销 puts it back`);

    // leave the library as it was for the next round
    await previewCall(server, 'settings.practice.set', { patch: { fixPhrases: null } });
    assert.deepEqual(errors, [], `${where}: no page errors`);
    await context.close();
  }
});
