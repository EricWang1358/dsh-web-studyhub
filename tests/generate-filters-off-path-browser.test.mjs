/* global document, window, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';

/* #1182: the 类型 / 内容分类 / AI 智能分类 filters of 01 / 选择资料 (#1177) are off the main path of 创建题组.
   - Shut by default: one icon button on the list's own filter line (beside 「筛选资料…」), so the first screen shows as many material rows as before
     #1177 (round 14, measured on the same library: zh 320/375/420/1440 = 0/3/3/7 rows, en = 0/0/2/6) and the filters draw nothing.
   - Open: the labels stand in one column and the selects in the next, every label on its select's line, at every width; opening moves the list by the
     height of what opened and nothing else, the bottom bar not at all, and shutting puts the list back.
   - A filter in use stays said while the filters are shut (「只显示：…」 with 「清除筛选」), so no row goes missing unexplained. */

const STAMP = '2026-10-01T08:00:00.000Z';
const ZH = '分布式系统一致性原理与共识协议的失败模式及其工程实践讲义第二版含习题与参考答案附录';
const EN = 'Distributed consensus protocols and their failure modes in practice with exercises and answers appendix';
const LONG = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';
const ROUND_14 = { zh: { 320: 0, 375: 3, 420: 3, 1440: 7 }, en: { 320: 0, 375: 0, 420: 2, 1440: 6 } };
const SIZES = [[320, 760], [375, 812], [420, 860], [1440, 900]];

/** The library of the round-14/15 reviews: the sample course plus two PDFs, a long English note and nine long-titled notes (14 materials in the course). */
async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, args) => service.call(name, args), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  await service.store.update(state => {
    const course = state.sampleLibrary.course;
    for (const [name, pages] of [['网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf', 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP,
        courses: [course, LONG], document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'n1', title: 'A very long English lecture title about distributed consensus protocols and their failure modes.md', text: 'Consensus, quorum and failure. '.repeat(30),
      createdAt: STAMP, courses: [course, LONG], chars: 900 });
    for (let n = 14; n <= 30; n += 4) state.sources.push({ id: `z${n}`, title: `${String(n).padStart(2, '0')}${ZH.slice(0, n - 2)}.md`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [course], chars: 180 });
    for (let n = 30; n <= 60; n += 10) state.sources.push({ id: `e${n}`, title: `${String(n).padStart(2, '0')} ${EN.slice(0, n - 3)}.md`, text: 'Point. '.repeat(60), createdAt: STAMP, courses: [course], chars: 420 });
    state.focus = { ...(state.focus || {}), course, mode: 'class' };
  });
  service.dispose?.();
}

const PICKER = '[data-tour="generate-sources"]';

/** What the first screen shows of the list (rows with any part between the list window's top and the bottom bar), and where the parts stand: in the
    page's own coordinates (a click may scroll the page to reach its target), the bottom bar where it is drawn. */
const measure = page => page.evaluate(picker => {
  let scroller = document.querySelector('[data-generate-bar]');
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const y = scroller ? scroller.scrollTop : window.scrollY;
  const box = element => { const r = element?.getBoundingClientRect(); return r && r.height ? { top: r.top + y, bottom: r.bottom + y, left: r.left, right: r.right, height: r.height } : null; };
  const bar = document.querySelector('[data-generate-bar]').getBoundingClientRect();
  const viewport = document.querySelector(`${picker} .sh-scroll__viewport`)?.getBoundingClientRect();
  const low = Math.max(0, viewport ? viewport.top : 0), high = Math.min(bar.top, viewport ? viewport.bottom : window.innerHeight);
  const seen = [...document.querySelectorAll(`${picker} .source-picker__item`)].filter(row => {
    const r = row.getBoundingClientRect();
    return Math.min(r.bottom, high) - Math.max(r.top, low) >= 1;
  }).length;
  const filters = document.querySelector(`${picker} [data-material-category-bar]`);
  const drawn = bar;
  return {
    seen, bar: { top: drawn.top, bottom: drawn.bottom }, frame: box(document.querySelector(`${picker} .sh-scroll__frame`)),
    filter: box(document.querySelector(`${picker} .sh-scroll__filter`)), line: box(document.querySelector(`${picker} .sh-scroll__bar`)), toggle: box(document.querySelector(`${picker} [data-material-filters-toggle]`)),
    expanded: document.querySelector(`${picker} [data-material-filters-toggle]`)?.getAttribute('aria-expanded') ?? null,
    filtersDrawn: !!filters && filters.getClientRects().length > 0, panel: box(filters),
    labels: [...document.querySelectorAll(`${picker} .material-category-bar__label`)].map(box), selects: [...document.querySelectorAll(`${picker} .material-category-bar__select`)].map(box),
    ai: box(document.querySelector(`${picker} [data-ai-classify]`)), on: document.querySelector(`${picker} [data-material-filters-on]`)?.innerText ?? null,
    scrolled: y,
    rows: document.querySelectorAll(`${picker} .source-picker__item`).length, sideways: document.documentElement.scrollWidth - window.innerWidth,
  };
}, PICKER);

test('创建题组 keeps the type and category filters off its main path: shut by default, one aligned grid when open, a filter in use always said', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-filters-'));
  const distDir = join(base, 'dist');
  await buildPreview({ outdir: distDir });
  await seed(join(base, 'library'));
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  try {
    for (const lang of ['zh', 'en']) for (const [width, height] of SIZES) {
      const where = `${lang} ${width}`;
      const { page, errors, context } = await openPage(browser, { server }, { lang, theme: lang === 'zh' ? 'dark' : 'light', width, height });
      await page.goto(server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator(`${PICKER} .source-picker__item`).first().waitFor({ timeout: 30000 });
      await page.keyboard.press('Escape');
      await settleAnimations(page);
      await frames(page, 4);

      const shut = await measure(page);
      assert.equal(shut.filtersDrawn, false, `${where}: the filters draw nothing while shut`);
      assert.ok(shut.toggle, `${where}: the filters' button is there`);
      assert.equal(shut.expanded, 'false', `${where}: the filters start shut`);
      assert.ok(shut.filter && Math.abs((shut.toggle.top + shut.toggle.bottom) / 2 - (shut.filter.top + shut.filter.bottom) / 2) < 1.5,
        `${where}: the button sits on the line of 「筛选资料…」 (${JSON.stringify(shut.toggle)} vs ${JSON.stringify(shut.filter)})`);
      assert.ok(shut.seen >= ROUND_14[lang][width], `${where}: the first screen shows ${shut.seen} material rows, round 14 showed ${ROUND_14[lang][width]}`);
      assert.ok(shut.sideways <= 0, `${where}: no sideways scroll`);

      await page.locator(`${PICKER} [data-material-filters-toggle]`).click();
      await settleAnimations(page);
      await frames(page, 4);
      const open = await measure(page);
      assert.equal(open.expanded, 'true', `${where}: the button says the filters are open`);
      assert.ok(open.filtersDrawn && open.panel, `${where}: the filters are drawn when open`);
      assert.equal(open.labels.length, 2, `${where}: two labels`);
      assert.equal(open.selects.length, 2, `${where}: two selects`);
      assert.ok(Math.abs(open.labels[0].left - open.labels[1].left) < 0.5, `${where}: the labels share one left edge`);
      assert.ok(Math.abs(open.selects[0].left - open.selects[1].left) < 0.5, `${where}: the selects share one left edge (${open.selects.map(s => s.left)})`);
      for (const [at, label] of open.labels.entries()) {
        const select = open.selects[at];
        assert.ok(label.right <= select.left + 0.5, `${where}: label ${at} is beside its select, not on top of it`);
        assert.ok(Math.abs((label.top + label.bottom) / 2 - (select.top + select.bottom) / 2) < 1.5, `${where}: label ${at} is on its select's line`);
      }
      assert.ok(open.ai && Math.abs(open.ai.left - open.selects[0].left) < 0.5, `${where}: AI 智能分类 stands in the selects' column`);
      const moved = open.frame.top - shut.frame.top;
      assert.ok(Math.abs(moved - (open.panel.bottom - shut.line.bottom)) < 1, `${where}: the list moves by what opened (${moved} vs ${open.panel.bottom - shut.line.bottom})`);
      assert.ok(Math.abs(open.bar.top - shut.bar.top) < 0.5 && Math.abs(open.bar.bottom - shut.bar.bottom) < 0.5, `${where}: the bottom bar does not move`);
      assert.ok(open.sideways <= 0, `${where}: no sideways scroll when open`);

      await page.locator(`${PICKER} [data-material-filters-toggle]`).click();
      await settleAnimations(page);
      await frames(page, 4);
      const again = await measure(page);
      assert.ok(Math.abs(again.frame.top - shut.frame.top) < 0.5, `${where}: shutting puts the list back (${again.frame.top} vs ${shut.frame.top}, scrolled ${again.scrolled} vs ${shut.scrolled})`);
      assert.equal(again.filtersDrawn, false, `${where}: shut again, the filters draw nothing`);

      if ((lang === 'zh' && width === 420) || (lang === 'en' && width === 1440)) {
        // A filter in use: pick the first type, shut the filters; the line under the filter says it, and 「清除筛选」 brings every row back.
        await page.locator(`${PICKER} [data-material-filters-toggle]`).click();
        await page.locator(`${PICKER} .material-category-bar__select`).first().click();
        const option = page.locator('[role="option"]').nth(1);
        const picked = (await option.innerText()).replace(/\s*\(\d+\)\s*$/, '').trim();
        const kept = Number((await option.innerText()).match(/\((\d+)\)/)?.[1]);
        await option.click();
        await until(async () => (await measure(page)).rows === kept, `${where}: the list keeps the ${kept} ${picked} rows`);
        await page.locator(`${PICKER} [data-material-filters-toggle]`).click();
        await settleAnimations(page);
        const filtered = await measure(page);
        assert.equal(filtered.filtersDrawn, false, `${where}: shut with a filter in use`);
        assert.ok(filtered.on && filtered.on.includes(picked), `${where}: the filter in use is said while shut (${filtered.on})`);
        assert.doesNotMatch(filtered.on, /全部|\bAll\b/, `${where}: only the filter in use is said, not the facet left at all (${filtered.on})`);
        if (lang === 'en') assert.doesNotMatch(filtered.on, /[㐀-鿿]/, `${where}: said in English`);
        await page.locator(`${PICKER} [data-material-filters-on] button`).click();
        await until(async () => (await measure(page)).rows === shut.rows, `${where}: 清除筛选 brings every row back`);
        assert.equal((await measure(page)).on, null, `${where}: nothing said once cleared`);
      }
      assert.deepEqual(errors, [], `${where}: no errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
