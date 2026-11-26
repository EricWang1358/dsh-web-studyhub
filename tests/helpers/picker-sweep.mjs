/* global document, window, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../../scripts/preview-server.mjs';
import { createFakeModel } from '../../scripts/fake-model.mjs';
import { launchChromium } from '../../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../../scripts/qa/layout-late.mjs';
import { StudyService } from '../../lib/service.js';
import { revealNavRow } from '../../scripts/qa/nav-reveal.mjs';

/* #1084, round 4: the rows of 创建题组 › 01 / 选择资料 over a sweep of title lengths (titles that grow one character at a time, Chinese and English, notes and
   PDFs with 选择页面), at 420, 900 and 1440 px, in zh and en, for every index answer (badges, no index, a failed read) arriving at once or late (1.5 s).
   The badge's place is a slot at the end of the row's facts line: held on every row while the answer is coming, then kept on every row, badge or none, at
   one width (round 8: so the names on the facts line keep their room when the answer lands; a row without a badge lends it to its format and size only).
   - No row's height changes between the first frame it is drawn in and when everything has settled.
   - No row has a blank band: nothing under its content, nothing between its title and its facts. The slot sits on the facts' first line, not on a line of its own.
   - At one width every badge ends at the same x (±1 px), with or without 选择页面 on its row, and its middle is the facts' first line's middle.
   - No title loses width to the badge: each title has as many lines with badges as without.
   - A badge that comes late is shown like one that comes at once: every row of the badges answer shows its badge. */

const STAMP = '2026-10-01T08:00:00.000Z';
const COURSE = '分布式系统';
const ZH = '分布式系统一致性原理与共识协议的失败模式及其工程实践讲义第二版含习题与参考答案附录';
const EN = 'Distributed consensus protocols and their failure modes in practice with exercises and answers appendix';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (let n = 14; n <= 44; n++) state.sources.push({ id: `z${n}`, title: `${String(n).padStart(2, '0')}${ZH.slice(0, n - 2)}.md`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE], chars: 180 });
    for (let n = 30; n <= 76; n += 3) state.sources.push({ id: `e${n}`, title: `${String(n).padStart(2, '0')} ${EN.slice(0, n - 3)}.md`, text: 'Point. '.repeat(60), createdAt: STAMP, courses: [COURSE], chars: 420 });
    // documents of several pages, so 选择页面 is on some rows of the sweep
    for (const n of [16, 22, 29]) {
      const name = `P${n}${ZH.slice(0, n - 3)}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `p${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：一致性。`.repeat(20), createdAt: STAMP, courses: [COURSE],
        document: { id: name, filename: name, page, totalPages: 3, extractionVersion: 2, format: 'pdf' } });
    }
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

/** Every row's shape (height, empty bands, title lines, where its slot and badge are), recorded in the first frame the row is drawn in, before anything else can move it. */
function recordFirstFrames() {
  const linesOf = element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].filter(r => r.width > 0.5).sort((a, b) => a.top - b.top)
      .reduce((all, r) => { const last = all.at(-1); if (last && Math.abs((r.top + r.bottom) / 2 - (last.top + last.bottom) / 2) < 6) { last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); } else all.push({ top: r.top, bottom: r.bottom }); return all; }, []);
  };
  const shape = item => {
    const row = item.querySelector('.source-picker__row'), style = getComputedStyle(row), box = row.getBoundingClientRect();
    const title = item.querySelector('.source-picker__text strong'), titleLines = linesOf(title);
    const factsElement = item.querySelector('.source-picker__facts') ?? [...item.querySelectorAll('.source-picker__text small')].find(small => !small.classList.contains('source-picker__partial'));
    const facts = linesOf(factsElement), factsLine = facts[0];
    // a slot that is not drawn is no slot
    const slotElement = item.querySelector('[data-index-slot]'), slot = slotElement && getComputedStyle(slotElement).display !== 'none' ? slotElement.getBoundingClientRect() : null;
    const badge = item.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
    const bottoms = [...item.querySelectorAll('.source-picker__text strong, .source-picker__text small, .source-picker__expand, [data-index-slot] [data-state]')]
      .map(element => element.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.bottom);
    return { at: performance.now(), title: title.textContent.slice(0, 14), height: item.getBoundingClientRect().height, lines: titleLines.length, expand: !!item.querySelector('.source-picker__expand'),
      below: box.bottom - parseFloat(style.paddingBottom) - Math.max(...bottoms), between: factsLine.top - titleLines.at(-1).bottom,
      slot: !!slot, slotOnFacts: slot ? slot.top >= factsLine.top - 1 && slot.bottom <= factsLine.bottom + 1 : null,
      badge: badge ? { right: badge.right, middle: (badge.top + badge.bottom) / 2 - (factsLine.top + factsLine.bottom) / 2 } : null };
  };
  window.__rowShape = shape;
  window.__firstFrames = {};
  // when the index answer reached the page: a row first drawn after it (rows past the first 24 are drawn on scroll) never had an answer to wait for
  window.__answeredAt = Infinity;
  const fetchFirst = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fetchFirst(...args);
    if (String(args[1]?.body ?? '').includes('retrieval.index.coverage')) window.__answeredAt = Math.min(window.__answeredAt, performance.now());
    return response;
  };
  const tick = () => {
    for (const item of document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')) {
      const key = item.getAttribute('data-document-key');
      if (key && !(key in window.__firstFrames) && item.getBoundingClientRect().height > 0) window.__firstFrames[key] = shape(item);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // every drawn row is laid out (the list skips the layout of rows out of its window, which would read as 90 px first)
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '.source-picker__entry { content-visibility: visible !important; }';
    document.head.append(style);
  });
}

/** Scroll the list to its end and back so every row is drawn, then read every row as it has settled. */
const settledRows = page => page.evaluate(async () => {
  const list = document.querySelector('[data-tour="generate-sources"] .source-picker__list');
  let box = list.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  for (let step = 0; box && step < 60 && box.scrollTop + box.clientHeight < box.scrollHeight - 1; step++) {
    box.scrollTop += box.clientHeight * 0.8;
    await new Promise(done => setTimeout(done, 120));
  }
  await new Promise(done => setTimeout(done, 300));
  if (box) box.scrollTop = 0;
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  return Object.fromEntries([...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => [item.getAttribute('data-document-key'), window.__rowShape(item)]));
});

/** The sweep for one interface language (the test files split zh and en so each stays well inside the per-test limit and the shards can balance them). */
export async function pickerSweep(t, lang) {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-picker-sweep-dist-'));
  await buildPreview({ outdir: dist });
  const base = await mkdtemp(join(tmpdir(), 'study-picker-sweep-'));
  await seed(join(base, 'library'));
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  try {
    const ids = (await previewCall(server, 'snapshot')).sources.map(source => source.id);
    const partial = ids.filter(id => id.startsWith('p22-')).slice(0, 2);
    const answers = {
      'no index': { ok: true, value: { indexed: [], stale: [], missing: ids, hasIndex: false, canIndex: true, building: null } },
      'a failed read': { ok: false, error: 'no search component' },
      badges: { ok: true, value: { indexed: ids.filter(id => !partial.includes(id)), stale: [], missing: partial, hasIndex: true, canIndex: true, building: null } },
    };
    const failures = [];
    for (const width of [420, 900, 1440]) for (const late of [false, true]) {
      const titleLines = {};
      for (const [answer, body] of Object.entries(answers)) {
        const tag = `${lang} ${width}, ${answer} ${late ? 'late (1.5 s)' : 'at once'}`;
        const { page, errors, context } = await openPage(browser, { server }, { lang, theme: 'dark', width, height: 860 });
        await page.addInitScript(recordFirstFrames);
        let answered = false;
        await page.route('**/api/call', async route => {
          let action = '';
          try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
          if (action !== 'retrieval.index.coverage') return route.continue();
          if (late) await new Promise(done => setTimeout(done, 1500));
          answered = true;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        });
        await page.goto(server.url);
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        await (await revealNavRow(page, 'generate')).dispatchEvent('click');
        await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
        await until(() => answered, `${tag}: the index answer`);
        await settleAnimations(page);
        await frames(page, 8);
        const settled = await settledRows(page);
        const first = await page.evaluate(() => window.__firstFrames);
        const answeredAt = await page.evaluate(() => window.__answeredAt);
        if (late && answeredAt === Infinity) failures.push(`${tag}: the page never saw the index answer`);
        const keys = Object.keys(settled);
        assert.ok(keys.length >= 50, `${tag}: the whole sweep is drawn (${keys.length} rows)`);
        for (const key of keys) {
          const before = first[key], after = settled[key];
          if (!before) { failures.push(`${tag}: ${after.title}: never seen drawn`); continue; }
          if (Math.abs(before.height - after.height) > 0.5) failures.push(`${tag}: ${after.title} (${after.lines} lines): ${Math.round(before.height)} → ${Math.round(after.height)} px after its first frame`);
          for (const [when, shape] of [['first frame', before], ['settled', after]]) {
            if (shape.below > 1) failures.push(`${tag}, ${when}: ${shape.title}: ${Math.round(shape.below)} px of blank band under the content`);
            if (shape.between > 6) failures.push(`${tag}, ${when}: ${shape.title}: ${Math.round(shape.between)} px of blank band between the title and its facts`);
            if (shape.slot && !shape.slotOnFacts) failures.push(`${tag}, ${when}: ${shape.title}: the badge's slot is not on the facts' first line`);
          }
          // settled, every row keeps the slot, badge or none (round 8); a late answer's rows drawn before it held one in their first frame
          if (!after.slot) failures.push(`${tag}: ${after.title}: ${after.badge ? 'a badge with no slot' : 'no slot kept'}`);
          if (late && before.at < answeredAt && !before.slot) failures.push(`${tag}: ${before.title}: no slot held while the answer was coming`);
          if (after.badge && Math.abs(after.badge.middle) > 1) failures.push(`${tag}: ${after.title}: the badge is ${after.badge.middle.toFixed(1)} px off the facts' first line's middle`);
          if (answer === 'no index') titleLines[key] = after.lines;
          else if (titleLines[key] !== undefined && titleLines[key] !== after.lines) failures.push(`${tag}: ${after.title}: the title has ${after.lines} lines, ${titleLines[key]} without badges`);
        }
        const ends = keys.map(key => settled[key].badge?.right).filter(end => end !== undefined);
        if (answer === 'badges' && ends.length !== keys.length) failures.push(`${tag}: ${ends.length} of ${keys.length} rows show their badge`);
        if (ends.length && Math.max(...ends) - Math.min(...ends) > 1) failures.push(`${tag}: the badges end at x ${Math.round(Math.min(...ends))}–${Math.round(Math.max(...ends))}, not one column`);
        if (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) > 0) failures.push(`${tag}: sideways scroll`);
        if (errors.length) failures.push(`${tag}: errors ${errors.join(' | ')}`);
        const mine = failures.filter(line => line.startsWith(tag));
        t.diagnostic(`${tag}: ${keys.length} rows, ${ends.length} badges, ${mine.length} failures${mine.length ? ` (${[...new Set(mine.map(line => line.replace(/^.*?: [^:]*: /, '').replace(/[\d.]+/g, 'N')))].slice(0, 4).join(' / ')})` : ''}`);
        await context.close();
      }
    }
    assert.deepEqual(failures.slice(0, 40), [], `${failures.length} failures`);
  } finally { await browser.close(); await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); await rm(dist, { recursive: true, force: true }); }
}
