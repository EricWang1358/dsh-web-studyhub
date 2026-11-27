/* global localStorage, getComputedStyle, document, NodeFilter */
// A 资料 row with several actions (#1083, round 7): a material a published deck uses but does not fully cover offers 为没覆盖的部分补题 beside 从这份资料出题,
// and one with an interactive companion also offers 打开交互伴学页. Round 6 squeezed those into a column of single letters at en 1000 and pushed a button over
// the sidebar at en 580. At every width from 420 to 1440, in zh and en, on every row:
// (a) no button is cut and none is squeezed below its words: a zh label keeps one line, an en label breaks only at a space, into two lines at most;
// (b) every action lies inside the row's content box;
// (c) the actions add no height to a wide row (they fit beside the title and the facts), and a narrow row's actions are at most one label line taller than
//     those of a row with one action: never another line of buttons;
// (d) the facts' numbers are never cut, and a courses / 用于 piece that ends in an ellipsis says the rest in a hover tip;
// (e) every action is still offered on the row, shown or in 更多.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { sourceItemKey } from '../lib/source-groups.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

const WIDTHS = [420, 580, 600, 720, 960, 1000, 1100, 1200, 1340, 1440];
// One more line of a wrapped en label (a 14px label at the button's line height); a second line of buttons is 40px.
const LABEL_LINE = 22;
const LABELS = {
  zh: ['打开交互伴学页', '从这份资料出题', '为没覆盖的部分补题'],
  en: ['Open interactive companion', 'Generate from this source', 'Add questions for the uncovered parts'],
};

test('a 资料 row with several actions stays tidy at every width in zh and en', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sources-actions-'));
  const service = new StudyService(join(root, 'library'));
  await service.call('snapshot');
  await sampleAction({ call: (name, input) => service.call(name, input), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  await service.store.update(state => {
    const course = state.sampleLibrary?.course;
    state.sources.push({ id: 'long-en', title: 'A very long English lecture title about distributed consensus protocols and their failure modes.md', text: 'Raft and Paxos. '.repeat(20),
      createdAt: '2026-10-01T08:00:00.000Z', courses: [course] });
  });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  let browser;
  const closePage = async page => {
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  };
  t.after(async () => {
    for (const context of browser?.contexts() || []) await Promise.all(context.pages().map(closePage));
    await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }

  // A model is ready (the fake one), and in the snapshot as the page sees it both sample materials are used by a deck and only partly covered (so each offers 补题), and the
  // lecture notes have an interactive companion. The two decks of the sample library hold them.
  const open = async (lang, width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') return route.abort();
      let action = '';
      try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not a call */ }
      if (!url.pathname.endsWith('/api/call') || action !== 'snapshot') return route.fallback();
      const response = await route.fetch(), body = await response.json();
      const value = body?.value;
      if (value?.sources) {
        // Keyed as the page keys a material (the server may not have counted its coverage yet): 1 of 2 sections covered.
        const used = value.sources.filter(source => /设计模式讲义|墨笺笔记应用/.test(source.title || ''));
        value.materialCoverage = { ...value.materialCoverage, ...Object.fromEntries(used.map(source => [sourceItemKey(source), [2, 1, 3, 1, 'section']])) };
        const notes = value.sources.find(source => /设计模式讲义/.test(source.title || ''));
        if (notes) notes.companionId = 'demo-companion';
      }
      return route.fulfill({ response, json: body });
    });
    await page.addInitScript(l => { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-autopilot', 'off'); }, lang);
    await page.goto(server.url);
    await (await revealNavRow(page, 'sources')).click();
    await page.locator('.source-doc').first().waitFor();
    await page.locator('.source-doc [data-document-topup-open], .source-doc .source-row-menu [data-document-topup-open]').first().waitFor({ state: 'attached' });
    await page.mouse.move(1, 1);
    await page.waitForTimeout(300);
    return { page, errors };
  };
  const rowsLook = page => page.evaluate(() => [...document.querySelectorAll('.source-doc')].map(row => {
    const at = row.getBoundingClientRect(), style = getComputedStyle(row);
    const content = [at.left + parseFloat(style.paddingLeft), at.right - parseFloat(style.paddingRight)];
    const box = el => { const b = el.getBoundingClientRect(); return [b.left, b.right, b.top, b.bottom]; };
    const actions = row.querySelector('.source-doc__actions');
    // Each visible control of the actions (a <details> by its summary), with its label's lines and where each line break falls.
    const controls = [...actions.querySelectorAll('button, summary')].filter(el => el.getClientRects().length && !el.closest('.source-row-menu')).map(el => {
      const breaks = [], walker = document.createTreeWalker(el, 4);
      let lastTop = null, lastChar = '', lines = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.length; i++) {
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = [...range.getClientRects()].find(r => r.width > 0);
          const char = node.data[i];
          if (!rect) { lastChar = char; continue; }
          if (lastTop == null || rect.top > lastTop + 2) { lines++; if (lastTop != null) breaks.push(/\s/.test(lastChar) || /\s/.test(char)); lastTop = rect.top; }
          lastChar = char;
        }
      }
      return { text: el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label'), box: box(el), cut: el.scrollWidth > el.clientWidth + 1, lines, breaks };
    });
    const tipOf = el => {
      const anchor = el.querySelector('[aria-describedby]');
      const tips = anchor ? anchor.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id)).filter(tip => tip?.getAttribute('role') === 'tooltip') : [];
      return tips.map(tip => tip.textContent.trim()).join(' ');
    };
    const shownText = el => { const copy = el.cloneNode(true); copy.querySelectorAll('[role="tooltip"]').forEach(tip => tip.remove()); return copy.textContent.trim(); };
    const facts = [...row.querySelectorAll('.source-doc__meta > small')].map(small => ({ text: shownText(small), cut: small.scrollWidth > small.clientWidth + 1, tip: tipOf(small) }));
    return { key: row.getAttribute('data-document-key'), title: row.querySelector('.source-title').textContent.trim().slice(0, 20), height: at.height, content,
      main: box(row.querySelector('.source-main')), actions: box(actions), controls, facts,
      offered: [...actions.querySelectorAll('button, summary')].map(el => el.textContent.trim()) };
  }));

  const faults = [];
  for (const lang of ['zh', 'en']) {
    for (const width of WIDTHS) {
      const at = `${lang} ${width}`;
      const { page, errors } = await open(lang, width);
      const narrow = await page.locator('.sources-page.is-narrow').count() > 0;
      const rows = await rowsLook(page);
      const notes = rows.find(row => /设计模式讲义/.test(row.title)), single = rows.find(row => row.key === 'source:long-en');
      assert.ok(notes && single, `${at}: the lecture notes and the long English note are on the page`);
      // (e) the lecture notes still offer the companion, generating and the top-up.
      for (const label of LABELS[lang]) if (!notes.offered.some(text => text.includes(label))) faults.push(`${at}: the lecture notes no longer offer "${label}"`);
      for (const row of rows) {
        for (const control of row.controls) {
          // (a)
          if (control.cut) faults.push(`${at}: ${row.title}: "${control.text}" is cut`);
          if (lang === 'zh' && control.lines > 1) faults.push(`${at}: ${row.title}: "${control.text}" takes ${control.lines} lines`);
          if (lang === 'en' && (control.lines > 2 || control.breaks.includes(false))) faults.push(`${at}: ${row.title}: "${control.text}" takes ${control.lines} lines, breaking inside a word: ${JSON.stringify(control.breaks)}`);
          // (b)
          if (control.box[0] < row.content[0] - 0.5 || control.box[1] > row.content[1] + 0.5) faults.push(`${at}: ${row.title}: "${control.text}" (${control.box.slice(0, 2).map(Math.round)}) leaves the row (${row.content.map(Math.round)})`);
        }
        // (c)
        const actionsHeight = row.actions[3] - row.actions[2];
        if (!narrow && actionsHeight > row.main[3] - row.main[2] + 0.5) faults.push(`${at}: ${row.title}: its actions are ${actionsHeight.toFixed(1)}px tall, taller than its title and facts (${(row.main[3] - row.main[2]).toFixed(1)}px)`);
        if (narrow && actionsHeight > single.actions[3] - single.actions[2] + LABEL_LINE) faults.push(`${at}: ${row.title}: its actions are ${actionsHeight.toFixed(1)}px tall, a single action's ${(single.actions[3] - single.actions[2]).toFixed(1)}px`);
        // (d)
        const [courses, numbers] = row.facts;
        if (numbers?.cut) faults.push(`${at}: ${row.title}: the numbers "${numbers.text}" are cut`);
        if (courses?.cut && courses.tip !== courses.text) faults.push(`${at}: ${row.title}: "${courses.text.slice(0, 30)}" is cut and its tip says "${courses.tip}"`);
      }
      // (f) one look for the row's actions (rounds 9 and 12 of #1073): 从这份资料出题 leaves for the 出题 page and ends in → with nothing in front; the top-up starts a round where it stands and has no icon at all.
      const looks = await page.evaluate(() => [...document.querySelectorAll('.source-doc__actions .source-doc__action')].filter(b => b.getClientRects().length).map(b => {
        const box = b.getBoundingClientRect(), marks = [...b.querySelectorAll('svg')].map(svg => (svg.getBoundingClientRect().left < box.left + box.width / 2 ? 'lead' : 'trail'));
        return { text: b.textContent.trim(), top: b.hasAttribute('data-document-topup-open'), marks };
      }));
      for (const { text, top, marks } of looks) {
        if (top && marks.length) faults.push(`${at}: the row action "${text}" has an icon (${marks}), it acts where it stands`);
        if (!top && marks.join() !== 'trail') faults.push(`${at}: the row action "${text}" should end in the arrow and lead with nothing (${marks})`);
      }
      // (h) the arrow stays beside its words when a label wraps: the gap from the words to the arrow is the button's own gap, not a centred hole.
      const apart = await page.evaluate(() => [...document.querySelectorAll('.source-doc__actions .source-doc__action')].filter(b => b.getClientRects().length && b.querySelector('svg')).map(button => {
        const icon = button.querySelector('svg').getBoundingClientRect();
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        let left = Infinity, right = -Infinity;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (!node.data.trim()) continue; const range = document.createRange(); range.selectNodeContents(node); for (const r of range.getClientRects()) if (r.width > 0) { left = Math.min(left, r.left); right = Math.max(right, r.right); } }
        const box = button.getBoundingClientRect(), style = getComputedStyle(button), trailing = icon.left >= box.left + box.width / 2;
        return trailing ? { text: button.textContent.trim().slice(0, 30), gap: icon.left - right, hole: left - (box.left + parseFloat(style.paddingLeft)) }
          : { text: button.textContent.trim().slice(0, 30), gap: left - icon.right, hole: box.right - parseFloat(style.paddingRight) - right };
      }).filter(found => found.gap > 12 || found.hole > 16));
      // and the button hugs its words: no empty band beside the longest line (a wrapped label's box is otherwise as wide as the room it was offered).
      for (const found of apart) faults.push(`${at}: "${found.text}": the icon is ${found.gap.toFixed(1)}px from its words, and ${found.hole.toFixed(1)}px is empty beside them`);
      // (g) a cut courses piece's tip also opens when the title button has keyboard focus, not only on hover.
      const cutAt = rows.findIndex(row => row.facts[0]?.cut);
      if (cutAt >= 0) {
        await page.keyboard.press('Shift');
        await page.locator('.source-doc').nth(cutAt).locator('.source-main').focus();
        await page.waitForTimeout(80);
        const shown = await page.locator('.source-doc').nth(cutAt).evaluate(row => !!row.querySelector('.source-doc__facts-tip [role="tooltip"]')?.matches(':popover-open'));
        if (!shown) faults.push(`${at}: ${rows[cutAt].title}: the cut courses tip does not open on keyboard focus of the title`);
        // (k) the mouse passing over the focused title's own cut piece and leaving it does not close the card while the title keeps focus.
        const piece = page.locator('.source-doc').nth(cutAt).locator('.source-doc__facts-tip');
        await piece.hover();
        await page.waitForTimeout(150);
        await page.mouse.move(0, 0);
        await page.waitForTimeout(150);
        const kept = await page.locator('.source-doc').nth(cutAt).evaluate(row => !!row.querySelector('.source-doc__facts-tip [role="tooltip"]')?.matches(':popover-open'));
        if (!kept) faults.push(`${at}: ${rows[cutAt].title}: the mouse leaving the cut piece closes the card while the title keeps focus`);
        // (i) a second cut piece hovered while the first is open: one card on screen, never two.
        const other = rows.findIndex((row, index) => index !== cutAt && row.facts[0]?.cut);
        if (other >= 0) {
          await page.locator('.source-doc').nth(other).locator('.source-doc__facts-tip').hover();
          await page.waitForTimeout(700);
          const cards = await page.evaluate(() => [...document.querySelectorAll('.source-doc__facts-tip [role="tooltip"]')].filter(tip => tip.matches(':popover-open')).length);
          if (cards > 1) faults.push(`${at}: ${cards} courses tips are on screen at once`);
          await page.mouse.move(0, 0);
        }
        // (j) after a rename is opened and cancelled (F2, Esc), the cut piece still has its tip on keyboard focus.
        await page.locator('.source-doc').nth(cutAt).locator('.source-main').focus();
        await page.keyboard.press('F2');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        await page.keyboard.press('Shift');
        await page.locator('.source-doc').nth(cutAt).locator('.source-main').focus();
        await page.waitForTimeout(80);
        const after = await page.locator('.source-doc').nth(cutAt).evaluate(row => !!row.querySelector('.source-doc__facts-tip [role="tooltip"]')?.matches(':popover-open'));
        if (!after) faults.push(`${at}: ${rows[cutAt].title}: after F2 then Esc the cut courses tip no longer opens`);
      }
      assert.deepEqual(errors, [], `${at}: page errors`);
      await closePage(page);
    }
  }
  assert.deepEqual(faults, []);
});
