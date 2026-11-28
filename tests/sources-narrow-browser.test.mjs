/* global localStorage, getComputedStyle, document */
// The 资料 page at every width a learner meets it, in both languages (#1083 #1085): the sample library plus two PDFs and a long English note imported on an
// older day, grouped by import day (so 全部展开 exists), with the index coverage held at the network edge and let through once the page is drawn.
// Checked at each width: (a) typing in 筛选资料 moves nothing above the list; (b) the index badge is readable, never under the row's icon, and a row is as tall
// before its badge arrives as after; (c) 添加资料 ends the header's title row at its right edge, the other actions on that one line; (d) the follow mark stays
// inside the page's content box. Then, from what the same pages showed (#1083, round 5): (e) a wide row keeps no blank strip for its hidden actions, its facts
// are not cut while they fit, and hovering or focusing a row moves nothing; (f) a narrow row puts mastery and coverage on one line where they fit; (g) 查看 N 页
// starts where the title's text does, and the filter keeps only the room its count needs; (h) a choice in the compact header’s 更多 leaves focus on its
// trigger, which is the same element; (i) the compact header keeps one line in the narrowest docked column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { holdActions, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { openSourcesTools } from './helpers/sources-tools.mjs';

// 580 is the narrowest window with the sidebar docked (a 318px column), 600 a 338px one; 960–1340 is the docked band where the header used to wrap under
// its description.
const WIDTHS = [420, 580, 600, 720, 880, 960, 1000, 1180, 1340, 1440];
// A badge narrower than this many of its own letters cannot hold 「索引已建好 · 1/1 页」 / "Index built · 1/1 pages" (11 and 23 characters); the old fault squeezed it to 3.
const BADGE_FLOOR_EM = 8;

test('资料 holds still and tidy at every width in zh and en: header, controls, follow mark and late index badges', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sources-narrow-'));
  const service = new StudyService(join(root, 'library'));
  await service.call('snapshot');
  await sampleAction({ call: (name, input) => service.call(name, input), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  const older = '2026-10-01T08:00:00.000Z';
  await service.store.update(state => {
    const course = state.sampleLibrary?.course;
    for (const [name, pages] of [['网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf', 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20),
        createdAt: older, courses: [course], document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'long-en', title: 'A very long English lecture title about distributed consensus protocols and their failure modes.md', text: 'Raft and Paxos. '.repeat(20),
      createdAt: older, courses: [course] });
    state.focus = { ...(state.focus || {}), course, mode: 'class' };
  });
  const ids = (await service.store.read()).sources.map(source => source.id);
  const partial = ids.filter(id => id.startsWith('网络协议')).slice(0, 2);
  const coverage = { indexed: ids.filter(id => !partial.includes(id)), stale: [], missing: partial, hasIndex: true, canIndex: true, building: null };
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }

  const open = async (lang, width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
    const hold = await holdActions(page, ['retrieval.index.coverage']);
    await page.addInitScript(l => { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-autopilot', 'off'); }, lang);
    await page.goto(server.url);
    await (await revealNavRow(page, 'sources')).click();
    await page.locator('.source-doc').first().waitFor();
    await openSourcesTools(page);
    await page.locator('.sources-view-bar').getByText(lang === 'en' ? 'By import date' : '按导入日期').click();
    await page.locator('.source-group').nth(1).waitFor();
    await page.mouse.move(1, 1);
    await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for index coverage', { timeoutMs: 30000 });
    return { page, errors, hold };
  };
  const look = page => page.evaluate(() => {
    // Positions inside the page's content box: the app above it (top bar, notices) may still settle, which is not the page's doing.
    const sources = document.querySelector('.sources-page'), origin = sources.getBoundingClientRect(), style = getComputedStyle(sources);
    const left = origin.left + parseFloat(style.paddingLeft), right = origin.right - parseFloat(style.paddingRight);
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left - left, r.right - left, r.top - origin.top, r.bottom - origin.top]; };
    const titleRow = document.querySelector('.sources-page__header .sh-page-header__title-row');
    const rows = [...document.querySelectorAll('.source-doc')].slice(0, 6);
    return {
      column: right - left,
      titleRow: box(titleRow), title: box(document.querySelector('.sources-page__header h1')),
      header: [...document.querySelectorAll('.sources-page__header .sh-page-header__actions > *')].map(box),
      headerOnTitleRow: !!titleRow?.querySelector('.sh-page-header__actions'),
      add: box(document.querySelector('[data-tour="sources-add"]')),
      select: box(document.querySelector('.page-scope__select')), filter: box(document.querySelector('.sources-filter__input')),
      viewBar: box(document.querySelector('.sources-view-bar')),
      follow: box(document.querySelector('.page-scope__follow')),
      rows: rows.map(row => {
        const badge = row.querySelector('.index-badge'), text = badge?.querySelector('.index-badge__text');
        const shown = text && [...text.children].find(el => getComputedStyle(el).display !== 'none') || text;
        return { key: row.getAttribute('data-document-key'), height: row.getBoundingClientRect().height,
          titleLeft: row.querySelector('.source-title').getBoundingClientRect().left,
          statusLeft: row.querySelector('.source-doc__status')?.firstElementChild?.getBoundingClientRect().left,
          badge: badge && { left: badge.getBoundingClientRect().left, width: badge.getBoundingClientRect().width, em: parseFloat(getComputedStyle(badge).fontSize),
            state: badge.getAttribute('data-state'), cut: !!shown && shown.scrollWidth > shown.clientWidth + 1 } };
      }),
    };
  });
  // A row's own boxes, for (e)–(g): the text column against the line it sits in, each piece of the facts line (natural width = scrollWidth), the title and
  // the facts, the status line's mastery and coverage, and where the text of 查看 N 页 starts.
  const rowsLook = page => page.evaluate(() => [...document.querySelectorAll('.source-doc')].slice(0, 6).map(row => {
    // In the row's own coordinates, so a scroll of the page is not taken for a move.
    const at = row.getBoundingClientRect();
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.left - at.left, b.right - at.left, b.top - at.top, b.bottom - at.top]; };
    const meta = row.querySelector('.source-doc__meta'), gap = parseFloat(getComputedStyle(meta).columnGap) || 0;
    const facts = [...meta.children].map(small => ({ text: small.textContent.trim(), natural: small.scrollWidth, shown: small.clientWidth }));
    const toggle = row.querySelector('.source-doc__pages-toggle'), words = toggle && [...toggle.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
    let toggleText = null;
    if (words) { const range = document.createRange(); range.selectNodeContents(words); toggleText = range.getBoundingClientRect().left - at.left; }
    return { key: row.getAttribute('data-document-key'), height: row.getBoundingClientRect().height, line: r(row.querySelector('.source-doc__line')),
      text: r(row.querySelector('.source-main > span')), title: r(row.querySelector('.source-title')), meta: r(meta), metaWidth: meta.clientWidth,
      factsNatural: facts.reduce((sum, f) => sum + f.natural, 0) + gap * Math.max(0, facts.length - 1), facts,
      mastery: r(row.querySelector('.source-doc__quality .mastery-line')), coverage: r(row.querySelector('.source-doc__quality [data-coverage-chip]')), toggleText,
      status: r(row.querySelector('.source-doc__status')), quality: r(row.querySelector('.source-doc__quality')),
      qualityGap: parseFloat(getComputedStyle(row.querySelector('.source-doc__quality')).columnGap) || 0,
      lineGap: parseFloat(getComputedStyle(row.querySelector('.source-doc__line')).columnGap) || 0,
      actions: getComputedStyle(row.querySelector('.source-doc__actions')).opacity === '0' ? null : r(row.querySelector('.source-doc__actions')),
      // Every line of words the row shows (title, facts, status), one box per line: what the actions must never lie over.
      words: [...row.querySelectorAll('.source-main, .source-doc__status')].flatMap(part => {
        const walker = document.createTreeWalker(part, 4), boxes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || node.parentElement.closest('.source-doc__actions')) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          // Only the part it shows: a fact that ends in an ellipsis hides the rest of its text box behind its own edge.
          let left = -Infinity, right = Infinity;
          for (let el = node.parentElement; el && el !== row; el = el.parentElement) if (getComputedStyle(el).overflowX !== 'visible') {
            const clip = el.getBoundingClientRect(); left = Math.max(left, clip.left); right = Math.min(right, clip.right);
          }
          for (const b of range.getClientRects()) {
            const l = Math.max(b.left, left), rr = Math.min(b.right, right);
            if (rr - l > 0) boxes.push({ text: node.textContent.trim().slice(0, 24), box: [l - at.left, rr - at.left, b.top - at.top, b.bottom - at.top] });
          }
        }
        return boxes;
      }),
      // The row's action buttons, each with its line, for a narrow row (no button alone on a line).
      buttons: [...row.querySelectorAll('.source-doc__actions > *')].map(el => el.matches('details') ? el.querySelector('summary') : el).filter(el => el.getBoundingClientRect().width > 0)
        .map(el => ({ text: el.textContent.trim().slice(0, 16) || el.getAttribute('aria-label'), top: el.getBoundingClientRect().top - at.top, bottom: el.getBoundingClientRect().bottom - at.top })) };
  }));
  const wide = [], narrowRows = [], pagesToggle = [], filterRoom = [];
  const near = (a, b) => Math.abs(a - b) < 1;
  // Within a pixel: the edges are fractional, and a moved or narrowed control (the old faults) was off by ten pixels or more.
  const still = (now, was, what) => assert.ok(now && was && now.every((v, i) => near(v, was[i])), `${what}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);

  for (const lang of ['zh', 'en']) {
    for (const width of WIDTHS) {
      const at = `${lang} ${width}`;
      const { page, errors, hold } = await open(lang, width);
      const waiting = await look(page);
      hold.release('retrieval.index.coverage', coverage);
      await page.locator('.source-doc .index-badge').first().waitFor();
      await page.waitForTimeout(150);
      const before = await look(page);

      // (b) a late badge moves nothing: every row is as tall as it was before the coverage answer; the badge is readable; the status line it ends starts under
      // the title's text, and so does the badge on a line of its own (never under the icon, as it did on a narrow row's actions line).
      before.rows.forEach((row, i) => assert.ok(near(row.height, waiting.rows[i].height), `${at}: row ${row.key} was ${waiting.rows[i].height}px before its badge, ${row.height}px after`));
      const badged = before.rows.filter(row => row.badge);
      assert.ok(badged.length >= 3, `${at}: the rows show their index badges`);
      for (const row of badged) {
        assert.ok(row.badge.width >= BADGE_FLOOR_EM * row.badge.em, `${at}: ${row.key}'s badge is ${row.badge.width}px wide, under ${BADGE_FLOOR_EM}em`);
        assert.ok(near(row.statusLeft, row.titleLeft), `${at}: ${row.key}'s status line starts at ${row.statusLeft}, the title text at ${row.titleLeft}`);
        assert.ok(row.badge.left >= row.titleLeft - 0.5, `${at}: ${row.key}'s badge starts at ${row.badge.left}, left of the title text (${row.titleLeft})`);
        if (row.badge.state === 'indexed') assert.equal(row.badge.cut, false, `${at}: ${row.key}'s "index built" words are not cut`);
      }

      // (c) the header: one line, 添加资料 last and at the right edge; the title row holds the actions.
      assert.ok(before.headerOnTitleRow, `${at}: the header's actions sit on the title's own row`);
      assert.ok(near(before.add[1], before.column), `${at}: 添加资料 ends at ${before.add[1]}, the header's right edge is ${before.column}`);
      assert.ok(before.header.every(b => near(b[2], before.add[2])), `${at}: the header's actions share one line: ${JSON.stringify(before.header)}`);
      assert.ok(before.header.every(b => b[0] >= before.title[1]), `${at}: no action starts left of the title's end`);

      // (d) the follow mark is inside the content box.
      if (before.follow) assert.ok(before.follow[1] <= before.column + 0.5, `${at}: the follow mark ends at ${before.follow[1]}, past the column (${before.column})`);

      // Data for (e)–(g), asserted after the loop so that each of them reports every width it fails at.
      const rows = await rowsLook(page), isNarrow = await page.locator('.sources-page.is-narrow').count() > 0;
      pagesToggle.push(...rows.filter(row => row.toggleText != null).map(row => ({ at, key: row.key, toggle: row.toggleText, title: row.title[0] })));
      if (isNarrow) narrowRows.push({ at, rows });
      else {
        await page.locator('.source-doc').nth(1).hover();
        await page.waitForTimeout(250);
        const hovered = await rowsLook(page);
        await page.mouse.move(1, 1);
        await page.locator('.source-doc').nth(2).locator('.source-main').evaluate(el => el.focus({ preventScroll: true }));
        await page.waitForTimeout(250);
        const focused = await rowsLook(page);
        await page.evaluate(() => document.activeElement?.blur());
        // A fresh import (.is-new) shows its actions with no pointer: try it on the row with the longest title.
        const fresh = page.locator('.source-doc[data-document-key="source:long-en"]');
        await fresh.evaluate(el => el.classList.add('is-new'));
        await page.waitForTimeout(250);
        const freshRows = await rowsLook(page);
        await fresh.evaluate(el => el.classList.remove('is-new'));
        // Tab from a row's title goes to the actions beside it (line 1) before the index link under it (line 2): the row with 建立索引.
        const linked = page.locator('.source-doc', { has: page.locator('.index-badge__go') }).first();
        await linked.locator('.source-main').evaluate(el => el.focus({ preventScroll: true }));
        await page.keyboard.press('Tab');
        const tabbed = await page.evaluate(() => ({ inActions: !!document.activeElement?.closest('.source-doc__actions'), text: document.activeElement?.textContent?.trim().slice(0, 30) }));
        await page.evaluate(() => document.activeElement?.blur());
        wide.push({ at, rows, hovered, focused, fresh: freshRows, tabbed });
      }

      // (a) typing changes nothing above the list: the header's actions, the scope select, the filter and the view bar keep their boxes.
      await page.locator('.sources-filter__input').fill(lang === 'en' ? 'lecture' : '讲义');
      await page.locator('.sources-filter__count').waitFor();
      await page.waitForTimeout(100);
      const typing = await look(page);
      filterRoom.push({ at, ...await page.evaluate(() => {
        const input = document.querySelector('.sources-filter__input'), state = document.querySelector('.sources-filter__state');
        return { padding: parseFloat(getComputedStyle(input).paddingInlineEnd), state: state.getBoundingClientRect().width,
          inset: input.getBoundingClientRect().right - state.getBoundingClientRect().right };
      }) });
      assert.equal(typing.header.length, before.header.length, `${at}: typing adds or removes no header action`);
      typing.header.forEach((b, i) => still(b, before.header[i], `${at}: header action ${i} while typing`));
      still(typing.select, before.select, `${at}: the scope select while typing`);
      still(typing.filter, before.filter, `${at}: the filter while typing`);
      still(typing.viewBar, before.viewBar, `${at}: the view bar while typing`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }

  // Each of (e)–(i) is a subtest, so a fault in one does not hide the others; each lists every width it fails at.
  const box = (row, key) => row[key].map(v => v.toFixed(1)).join(',');
  // Two boxes share more than half a pixel each way.
  const overlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0.5 && Math.min(a[3], b[3]) - Math.max(a[2], b[2]) > 0.5;
  await t.test('(e) a wide row keeps no blank strip, its actions lie over no words (at rest, hover, focus, fresh import), its facts are not cut while they fit, hover or focus moves nothing, and Tab follows the lines', () => {
    const faults = [];
    for (const { at, rows, hovered, focused, fresh, tabbed } of wide) {
      for (const row of rows) {
        // The text column runs to the row's end, or to the actions the row shows beside it: no room is kept for actions that are not there.
        const end = row.actions ? row.actions[0] - row.lineGap : row.line[1], strip = end - row.text[1];
        if (strip > 1) faults.push(`${at}: ${row.key}'s text column ends ${strip.toFixed(1)}px before ${row.actions ? 'its actions' : "the row's end"}`);
        if (row.factsNatural <= row.metaWidth + 1) {
          for (const fact of row.facts) if (fact.natural > fact.shown + 1) faults.push(`${at}: ${row.key}'s facts fit (${row.factsNatural.toFixed(0)} of ${row.metaWidth}px) yet "${fact.text}" is cut to ${fact.shown}px`);
        }
        const numbers = row.facts.at(-1);
        if (numbers.natural > numbers.shown + 1) faults.push(`${at}: ${row.key}'s numbers "${numbers.text}" are cut to ${numbers.shown}px`);
      }
      for (const [how, now] of [['hovering', hovered], ['focusing', focused]]) now.forEach((row, i) => {
        const was = rows[i];
        if (!near(row.height, was.height) || !row.title.every((v, k) => near(v, was.title[k])) || !row.meta.every((v, k) => near(v, was.meta[k])))
          faults.push(`${at}: ${how} a row moves ${row.key}: height ${was.height} -> ${row.height}, title ${box(was, 'title')} -> ${box(row, 'title')}, facts ${box(was, 'meta')} -> ${box(row, 'meta')}`);
      });
      if (![hovered, focused].every(now => now.some(row => row.actions))) faults.push(`${at}: hovering or focusing a row shows no actions`);
      // Wherever the actions show (at rest, on hover, on focus, on a fresh import), they lie over no words of the row: not the title, the facts or the status.
      for (const [how, now] of [['at rest', rows], ['hovering', hovered], ['focusing', focused], ['on a fresh import', fresh]]) for (const row of now) {
        if (!row.actions) continue;
        for (const word of row.words) if (overlap(word.box, row.actions)) faults.push(`${at}: ${how}, ${row.key}'s actions (${box(row, 'actions')}) lie over "${word.text}" (${word.box.map(v => v.toFixed(1)).join(',')})`);
      }
      if (!tabbed.inActions) faults.push(`${at}: Tab from a row's title goes to "${tabbed.text}", not to the actions beside the title`);
    }
    assert.equal(wide.length, 10, 'the wide widths (960–1440) were measured in both languages');
    assert.deepEqual(faults, []);
  });

  await t.test('(f) a narrow row puts its mastery and coverage on one line where they fit, and never leaves one action alone on a line', () => {
    const faults = [];
    for (const { at, rows } of narrowRows) for (const row of rows) {
      // The actions line never leaves one button alone on a line of its own (「More」 did, under 「Generate from this source」, at en 580).
      const lines = [];
      // A button is on a line when it shares more than half its height with the line's first button (buttons of different heights are centred on it).
      for (const b of row.buttons) {
        const line = lines.find(l => Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top) > (b.bottom - b.top) / 2);
        if (line) line.texts.push(b.text); else lines.push({ top: b.top, bottom: b.bottom, texts: [b.text] });
      }
      if (row.buttons.length > 1 && lines.some(line => line.texts.length === 1)) faults.push(`${at}: ${row.key}'s actions break into ${JSON.stringify(lines.map(line => line.texts))}`);
      if (!row.mastery || !row.coverage) continue;
      // Where the two fit side by side (en 580's 270px does not hold "Mastery 30% · 2 questions" and "Covered 100%"), they share the line: they overlap
      // vertically (they are centred on it), instead of the coverage starting under the mastery.
      const fits = (row.mastery[1] - row.mastery[0]) + row.qualityGap + (row.coverage[1] - row.coverage[0]) <= row.quality[1] - row.quality[0] + 0.5;
      if (fits && !(row.coverage[2] < row.mastery[3] && row.coverage[3] > row.mastery[2])) faults.push(`${at}: ${row.key}'s coverage (${box(row, 'coverage')}) is under its mastery (${box(row, 'mastery')})`);
    }
    assert.ok(narrowRows.some(({ rows }) => rows.some(row => row.mastery && row.coverage)), 'some narrow row has both');
    assert.deepEqual(faults, []);
  });

  await t.test('(g) 查看 N 页 starts where the title text does; the filter keeps only the room its count needs', () => {
    const faults = pagesToggle.filter(({ toggle, title }) => !near(toggle, title)).map(({ at, key, toggle, title }) => `${at}: ${key}'s 查看 N 页 starts at ${toggle.toFixed(1)}, the title at ${title.toFixed(1)}`);
    assert.ok(pagesToggle.length >= WIDTHS.length * 2, 'the multi-page rows were measured');
    // The count (and its ×) sit inside the field's end: the field's end padding holds them, with no more than one small gap to spare.
    for (const { at, padding, state, inset } of filterRoom) {
      if (padding < state + inset - 0.5 || padding > state + inset + 8) faults.push(`${at}: the filter keeps ${padding}px at its end for a count of ${(state + inset).toFixed(1)}px`);
    }
    assert.deepEqual(faults, []);
  });

  await t.test('(h) a choice in the compact header’s 更多 leaves focus on its trigger, and the header is not drawn again', async () => {
    for (const [lang, width] of [['zh', 720], ['en', 1000]]) {
      const { page, errors, hold } = await open(lang, width);
      hold.release('retrieval.index.coverage', coverage);
      const trigger = page.locator('.sources-page__header').getByRole('button', { name: lang === 'en' ? 'More' : '更多', exact: true });
      await trigger.waitFor();
      const node = await trigger.elementHandle();
      for (const item of lang === 'en' ? [/^(Expand|Collapse) all$/, /^Archived/] : [/^全部(展开|收起)$/, /^已归档/]) {
        await trigger.click();
        await page.getByRole('menuitem', { name: item }).click();
        await page.waitForTimeout(300);
        const after = await node.evaluate(el => ({ connected: el.isConnected, focused: document.activeElement === el, active: `${document.activeElement?.tagName} ${document.activeElement?.textContent?.trim().slice(0, 20)}` }));
        assert.ok(after.connected, `${lang} ${width}: choosing ${item} drew the header's 更多 again`);
        assert.ok(after.focused, `${lang} ${width}: after choosing ${item} the focus is on ${after.active}, not on 更多`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  });

  // 580 is the narrowest window with the sidebar docked (a 318px column). A phone (360) may put the compact header under the title: not asserted here.
  await t.test('(i) the compact header keeps one line in the narrowest docked column and around it', async () => {
    const faults = [];
    for (const lang of ['en', 'zh']) for (const width of [560, 580, 600]) {
      const { page } = await open(lang, width);
      const { title, actions } = await page.evaluate(() => {
        const r = el => { const b = el.getBoundingClientRect(); return [b.top, b.bottom]; };
        return { title: r(document.querySelector('.sources-page__header h1')), actions: [...document.querySelectorAll('.sources-page__header .sh-page-header__actions > *')].map(r) };
      });
      if (!actions.every(([top, bottom]) => top < title[1] && bottom > title[0])) faults.push(`${lang} ${width}: the title is ${title} and its actions ${JSON.stringify(actions)}: not one line`);
      await page.close();
    }
    assert.deepEqual(faults, []);
  });
});
