/* global localStorage, getComputedStyle, document */
// The 资料 page at every width a learner meets it, in both languages (#1083 #1085): the sample library plus two PDFs and a long English note imported on an
// older day, grouped by import day (so 全部展开 exists), with the index coverage held at the network edge and let through once the page is drawn.
// Checked at each width: (a) typing in 筛选资料 moves nothing above the list; (b) the index badge is readable, never under the row's icon, and a row is as tall
// before its badge arrives as after; (c) 添加资料 ends the header's title row at its right edge, the other actions on that one line; (d) the follow mark stays
// inside the page's content box.
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

// 600 is a window with the sidebar docked (a 338px column); 960–1340 is the docked band where the header used to wrap under its description.
const WIDTHS = [420, 600, 720, 880, 960, 1000, 1180, 1340, 1440];
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

      // (a) typing changes nothing above the list: the header's actions, the scope select, the filter and the view bar keep their boxes.
      await page.locator('.sources-filter__input').fill(lang === 'en' ? 'lecture' : '讲义');
      await page.locator('.sources-filter__count').waitFor();
      await page.waitForTimeout(100);
      const typing = await look(page);
      assert.equal(typing.header.length, before.header.length, `${at}: typing adds or removes no header action`);
      typing.header.forEach((b, i) => still(b, before.header[i], `${at}: header action ${i} while typing`));
      still(typing.select, before.select, `${at}: the scope select while typing`);
      still(typing.filter, before.filter, `${at}: the filter while typing`);
      still(typing.viewBar, before.viewBar, `${at}: the view bar while typing`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
});
