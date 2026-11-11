/* global document, getSelection, NodeFilter, MouseEvent, CSS */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { until } from './helpers/wait.mjs';
import { chooseMore } from './helpers/reader-more.mjs';

/* The reader's right-click menu in the real page (owner request 2026-11-11): select words, right-click, and 下划线 / 加粗 / 荧光笔 them, put
   passages on the 待出题 list (also from the keyboard), take a mark off by right-clicking it, find every mark again after reopening, then
   一次性出题: ONE background run with the fake model while the reader stays open and can still be read and marked, its questions landing as one
   draft and the list emptied; and an AI 词解 that stays on the words and shows on hover. Pictures go to READER_MARKS_SHOTS when set. */

const PARAGRAPHS = [
  'Architecture includes the principles guiding a system design and evolution over many releases.',
  'Quality attributes such as latency and availability shape which tactics a team selects for a product.',
  'A CQRS design separates the read model from the write model so each can scale on its own.',
  'Event sourcing keeps every change as an event, and the current state is rebuilt by replaying them.',
  'A bounded context names the part of a domain where one model and its words keep a single meaning.',
  'Caching trades freshness for speed, so every cache needs a rule for when its entries expire.',
];
const markdown = `# Software architecture notes\n\n${PARAGRAPHS.join('\n\n')}\n`;

let built = null;
const previewDist = () => built ??= (async () => {
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-marks-dist-'));
  await buildPreview({ outdir: dist });
  return dist;
})();
test.after(async () => { if (built) await rm(await built.catch(() => null) ?? '', { recursive: true, force: true }); });

/** Select `words` in the document's own text, as a drag would, and tell the reader. Returns the selection's last rectangle. */
const select = (page, words) => page.evaluate(phrase => {
  const body = document.querySelector('.study-document-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(phrase);
    if (at < 0 || node.parentElement.closest('[data-study-marker]')) continue;
    const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + phrase.length);
    range.startContainer.parentElement.scrollIntoView({ block: 'center' });
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const rect = [...range.getClientRects()].at(-1);
    return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 };
  }
  return null;
}, words);
/** The ranges painted in one highlight (0 when none). */
const painted = (page, name) => page.evaluate(key => CSS.highlights.get(key)?.size ?? 0, name);
const menu = page => page.getByRole('menu', { name: '选中文字的操作' });

test('select, right-click, mark and queue; reopen; 一次性出题 runs in the background while reading on; 词解 shows on hover', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  let documentId = '';
  const running = await startLateServer({ distDir: await previewDist(), seed: async root => {
    const runtime = createStudyRuntime(root);
    documentId = (await runtime.call('materials.document.import', { filename: 'architecture.md', dataBase64: Buffer.from(markdown).toString('base64'), courses: ['SWE'] })).documentId;
    runtime.dispose();
  } });
  t.after(() => running.close?.());
  const shots = process.env.READER_MARKS_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  for (const width of (process.env.READER_MARKS_WIDTHS || '1280,420').split(',').map(Number)) {
    const { context, page, errors } = await openPage(browser, running, { width, height: 900 });
    const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `marks-${width}-${name}.png`) }); };
    const viewer = page.locator('.study-document-viewer');
    const openReader = async () => {
      await page.goto(running.server.url);
      await (await revealNavRow(page, 'sources')).click().catch(() => {});
      try { await page.locator('.source-doc').first().locator('.source-main').click({ timeout: 30000 }); }
      catch (error) { if (shots) await page.screenshot({ path: join(shots, `marks-${width}-open-failed.png`) }); throw error; }
      await viewer.locator('.study-document-body').getByText('bounded context').waitFor({ timeout: 60000 });
    };
    // Right after 一次性出题 the page refreshes and can drop a selection made a moment before; a learner would select again, so up to three tries.
    const rightClickOn = async words => {
      for (let attempt = 1; ; attempt += 1) {
        const at = await select(page, words);
        assert.ok(at, `${width}: "${words}" is in the document`);
        await page.mouse.click(at.x, at.y, { button: 'right' });
        try { await menu(page).waitFor({ timeout: attempt < 3 ? 3000 : 10000 }); return; }
        catch (error) { if (attempt >= 3) throw error; }
      }
    };
    const choose = async label => { await menu(page).getByRole('menuitem', { name: label, exact: true }).click(); await menu(page).waitFor({ state: 'detached' }); };
    const marks = async () => (await running.api('materials.marks.list', { documentId })).items;
    const has = async (style, quote) => (await marks()).some(item => item.style === style && item.selection.quote === quote);
    try {
      await openReader();
      // The toolbar's controls stay on one row: every control's middle is within a few pixels of the others'.
      const toolbarRows = () => page.evaluate(() => { const mids = [...document.querySelectorAll('.reader-toolbar > *, .reader-toolbar__actions > *')].filter(node => node.getBoundingClientRect().height).map(node => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; }); return Math.round(Math.max(...mids) - Math.min(...mids)); });
      await shot('1-open');
      // 1. 下划线, 加粗, 荧光笔: each kept with the document and painted at once.
      await rightClickOn('principles guiding');
      assert.deepEqual(await menu(page).getByRole('menuitem').allInnerTexts().then(list => list.map(text => text.split('\n')[0].trim())),
        ['复制', '下划线', '加粗', '荧光笔', '加入待出题', 'AI 词解'], `${width}: the menu over a fresh selection`);
      await shot('2-menu');
      await choose('下划线');
      await until(() => has('underline', 'principles guiding'), `${width}: the underline is kept`);
      await until(async () => (await painted(page, 'study-mark-underline')) === 1, `${width}: the underline is painted`);
      await rightClickOn('latency and availability');
      await choose('加粗');
      await until(async () => (await painted(page, 'study-mark-bold')) === 1, `${width}: bold is painted`);
      await rightClickOn('read model from the write model');
      await choose('荧光笔');
      await until(async () => (await painted(page, 'study-mark-highlight')) === 1, `${width}: the highlighter is painted`);

      // 2. 加入待出题 twice by pointer, once by keyboard (the context-menu key opens the menu under the selection; arrows and Enter choose).
      await rightClickOn('every change as an event');
      await choose('加入待出题');
      await rightClickOn('one model and its words');
      await choose('加入待出题');
      await select(page, 'trades freshness for speed');
      await page.evaluate(() => document.querySelector('.study-document-body').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 })));
      await menu(page).waitFor();
      for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      // Wide, 待出题 N is a chip in the toolbar; at the narrowest (420 px) the toolbar is full and the same panel opens from 更多 › 待出题 N….
      const compact = width <= 520, chip = viewer.getByRole('button', { name: /^待出题 \d+$/ });
      const queued = async () => (await marks()).filter(item => item.style === 'queue').length;
      const openQueue = () => (compact ? chooseMore(page, '待出题') : chip.click());
      await until(async () => (await queued()) === 3, `${width}: three passages wait`);
      if (compact) assert.equal(await chip.count(), 0, `${width}: no chip in a full toolbar`);
      else await until(async () => (await chip.count()) && (await chip.innerText()).trim() === '待出题 3', `${width}: 待出题 3 in the toolbar`);
      const spread = await toolbarRows();
      assert.ok(spread <= 8, `${width}: the toolbar stays one row with 待出题 (middles ${spread}px apart)`);
      assert.equal(await painted(page, 'study-mark-queue'), 3);
      await shot('3-marked');

      // 3. A right-click on a mark with nothing selected offers its 去掉; the browser's own menu is left alone elsewhere.
      const underlined = await select(page, 'principles guiding');
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.mouse.click(underlined.x, underlined.y, { button: 'right' });
      await menu(page).waitFor();
      await choose('去掉下划线');
      await until(async () => !(await has('underline', 'principles guiding')), `${width}: the underline is gone`);
      await until(async () => (await painted(page, 'study-mark-underline')) === 0, `${width}: and no longer painted`);

      // 4. Reopened, every mark is drawn again.
      await page.keyboard.press('Escape');
      await until(async () => !(await viewer.count()), `${width}: the reader closes`, { timeoutMs: 15000 });
      await openReader();
      await until(async () => (await painted(page, 'study-mark-bold')) === 1 && (await painted(page, 'study-mark-highlight')) === 1 && (await painted(page, 'study-mark-queue')) === 3,
        `${width}: the marks after reopening`);

      // 5. The list: × takes one off; 每段 2 题; 一次性出题 starts ONE run and the reader stays open.
      await openQueue();
      const panel = page.getByRole('dialog', { name: '待出题' });
      await panel.waitFor();
      assert.equal(await panel.locator('.reader-queue__row').count(), 3);
      await panel.getByRole('button', { name: /^移出待出题：trades freshness/ }).click();
      await until(async () => (await panel.locator('.reader-queue__row').count()) === 2, `${width}: one passage removed`);
      await panel.getByRole('button', { name: '2 题', exact: true }).click();
      await shot('4-queue');
      const draftsBefore = (await running.api('snapshot')).drafts?.length ?? 0;
      await panel.getByRole('button', { name: /一次性出题 · 约 4 题/ }).click();
      await until(async () => (await queued()) === 0 && !(await chip.count()), `${width}: the used passages leave the list`);
      assert.equal(await viewer.count(), 1, `${width}: the reader is still open`);
      // Reading on while it runs: the menu still works and a new passage can be queued at once.
      await rightClickOn('separates the read model');
      await choose('加入待出题');
      await until(async () => (await queued()) === 1, `${width}: queued again while the run goes on`);
      if (compact) { await viewer.getByRole('button', { name: '更多', exact: true }).click(); await page.locator('.sh-menu [role^="menuitem"]', { hasText: '待出题 1…' }).waitFor(); await page.keyboard.press('Escape'); }
      else assert.equal((await chip.innerText()).trim(), '待出题 1');
      await shot('5-reading-on');
      let draft;
      await until(async () => {
        const snapshot = await running.api('snapshot');
        draft = (snapshot.drafts || []).find(item => /待出题 2 段/.test(item.title || ''));
        return (snapshot.drafts?.length ?? 0) > draftsBefore && draft && draft.cards?.length > 0;
      }, `${width}: the run lands as one draft`, { timeoutMs: 120000 });
      assert.ok(draft.cards.length >= 1);
      assert.equal(draft.course ?? draft.folder, 'SWE', `${width}: the draft is filed under the material's course`);
      assert.equal(await viewer.count(), 1, `${width}: still reading`);

      // 6. AI 词解: kept on the words, shown in a card on hover, in 阅读 mode.
      await rightClickOn('bounded context');
      await choose('AI 词解');
      await until(async () => (await running.api('materials.annotation.list', { documentId })).items.some(item => item.kind === 'explain' && item.selection.quote === 'bounded context'),
        `${width}: the 词解 is kept`, { timeoutMs: 60000 });
      await until(async () => (await painted(page, 'study-link-annotation')) >= 1, `${width}: the 词解's wavy line is drawn`);
      const term = await select(page, 'bounded context');
      await page.evaluate(() => getSelection().removeAllRanges());
      let nudge = 0;
      await until(async () => {
        await page.mouse.move(term.x + (nudge++ % 3), term.y);
        return page.locator('.reader-explain').isVisible();
      }, `${width}: the 词解 card on hover`, { timeoutMs: 15000 });
      assert.match(await page.locator('.reader-explain').innerText(), /bounded context/);
      assert.doesNotMatch(await page.locator('.reader-explain').innerText(), /\[\[/, `${width}: term marks read as plain words`);
      await shot('6-explain');

      // Clean up for the next width: the queued passage, the bold and the highlighter, the 词解 and the draft.
      await running.api('materials.marks.delete', { documentId, all: true });
      await running.api('materials.annotation.delete', { documentId, all: true });
      assert.deepEqual(errors, [], `${width}: no console or page errors`);
    } finally { await context.close(); }
  }
});
