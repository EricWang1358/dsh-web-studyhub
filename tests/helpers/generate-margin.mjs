/* global document, getComputedStyle */
import { before, after } from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../../scripts/preview-server.mjs';
import { createFakeModel } from '../../scripts/fake-model.mjs';
import { launchChromium } from '../../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../../scripts/qa/env.mjs';
import { StudyService } from '../../lib/service.js';
import { frames, openPage, settleAnimations, until } from '../../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../../scripts/qa/nav-reveal.mjs';

const STAMP = '2026-10-01T08:00:00.000Z';
export const COURSE = '示例课程 · 设计模式';
export const LONG = '分布式系统与网络协议（2026 秋季学期 · 周三晚班）';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    // notes whose size piece grows by a digit (the size is counted from the text): the room left for the course names differs from row to row
    for (const [at, times] of [3, 33, 333, 3333, 33334, 4, 44, 444, 4444, 5, 55, 5555].entries()) {
      state.sources.push({ id: `n${at}`, title: `笔记 ${at + 1}${at % 2 ? '.md' : ''}`, text: '要点。'.repeat(times), createdAt: STAMP, courses: [COURSE, LONG] });
    }
    for (const n of [1, 2]) {
      const name = `讲义 ${n}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `p${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：一致性。`.repeat(20), createdAt: STAMP, courses: [COURSE, LONG],
        document: { id: name, filename: name, page, totalPages: 3, extractionVersion: 2, format: 'pdf' } });
    }
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

/* A list longer than the 24 rows a window draws at first: 30 notes, then PDFs whose format, size and notes are long (drawn only on scroll). */
async function seedLong(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (let n = 1; n <= 30; n++) state.sources.push({ id: `m${n}`, title: `第 ${n} 讲 笔记.md`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE, '网络'] });
    for (const n of [1, 2, 3, 4]) {
      const name = `扫描讲义 ${n}.pdf`;
      for (let page = 1; page <= 3; page++) state.sources.push({ id: `s${n}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：锁。`.repeat(20), createdAt: STAMP, courses: [COURSE, '网络'],
        document: { id: name, filename: name, page, totalPages: 3, extractionVersion: 2, format: 'pdf', warnings: ['complex'], sparseText: true } });
    }
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

/* Round 11 (rv30): the reviewer's sample library: a Markdown note, Text notes (one in the long course), and two PDFs with 选择页面 in the long course. */
async function seedKinds(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push({ id: 'k-md', title: '示例 · 设计模式讲义', format: 'md', text: '模式。'.repeat(186) + '模式', createdAt: STAMP, courses: [COURSE] });
    state.sources.push({ id: 'k-case', title: '案例：墨笺笔记应用', text: '笔记。'.repeat(89), createdAt: STAMP, courses: [COURSE] });
    for (const [name, pages] of [['网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf', 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP,
        courses: [COURSE, LONG], document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'k-long', title: 'A very long English lecture title about distributed consensus protocols and their failure modes', text: 'Consensus, quorum and failure. '.repeat(30), createdAt: STAMP, courses: [COURSE, LONG] });
    for (let n = 1; n <= 5; n++) state.sources.push({ id: `k-z${n}`, title: `第 ${n} 讲 一致性原理`, text: '要点。'.repeat(60), createdAt: STAMP, courses: [COURSE] });
    for (let n = 1; n <= 4; n++) state.sources.push({ id: `k-e${n}`, title: `Lecture ${n}: consensus in practice`, text: 'Point. '.repeat(60), createdAt: STAMP, courses: [COURSE] });
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

/** Start only the libraries this group exercises; each file owns its browser and server cleanup. */
export function generateMarginFixture(variant = 'standard') {
  const state = { skip: '', server: null, longServer: null };
  let browser, base, dist, ids;
  before(async () => {
    try { browser = await launchChromium(); } catch (error) { state.skip = `no Chromium to measure with: ${String(error.message).split('\n')[0]}`; return; }
    scrubProcessEnv();
    dist = await mkdtemp(join(tmpdir(), 'study-generate-margin-dist-'));
    await buildPreview({ outdir: dist });
    base = await mkdtemp(join(tmpdir(), 'study-generate-margin-'));
    const start = async (name, seedLibrary) => {
      const libraryRoot = join(base, name);
      await seedLibrary(libraryRoot);
      return createPreviewServer({ libraryRoot, home: join(base, name + '-home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
    };
    state.server = await start('library', variant === 'kinds' ? seedKinds : seed);
    ids = (await previewCall(state.server, 'snapshot')).sources.map(source => source.id);
    if (variant === 'long') state.longServer = await start('long', seedLong);
  });
  after(async () => {
    await browser?.close();
    await state.server?.close();
    await state.longServer?.close();
    if (base) await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    if (dist) await rm(dist, { recursive: true, force: true });
  });

  const answers = (all = ids) => ({
    'no index': { ok: true, value: { indexed: [], stale: [], missing: all, hasIndex: false, canIndex: true, building: null } },
    badges: { ok: true, value: { indexed: all, stale: [], missing: [], hasIndex: true, canIndex: true, building: null } },
  });

  /** 创建题组 with the index answer held until `release()` (or given at once with `now`). */
  async function openGenerate({ lang, theme = 'light', width, height = 860, answer = answers()['no index'], now = true, on = state.server }) {
    const opened = await openPage(browser, { server: on }, { lang, theme, width, height });
    let release; const held = new Promise(done => { release = done; }); let asked = false;
    if (now) release();
    await opened.page.route('**/api/call', async route => {
      let action = '';
      try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
      if (action !== 'retrieval.index.coverage') return route.continue();
      asked = true;
      await held;
      if (answer === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'the search server is down' }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) });
    });
    await opened.page.goto(on.url);
    await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await (await revealNavRow(opened.page, 'generate')).dispatchEvent('click');
    await opened.page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
    await until(() => asked, 'the page to ask for index coverage');
    await settleAnimations(opened.page);
    return { ...opened, release: () => release() };
  }
  return { state, answers, openGenerate };
}

/**
 * Each row's facts line as a learner sees it: the pieces on its one line that are drawn (not hidden), each with the words it shows. A cut piece shows its
 * words up to the 「…」: the characters (and the unbreakable parts, inline blocks) that end before the ellipsis.
 */
export const factsLines = page => page.evaluate(() => {
  const canvas = document.createElement('canvas').getContext('2d'), widths = new Map();
  const ellipsis = element => {
    const font = getComputedStyle(element).font;
    if (!widths.has(font)) { canvas.font = font; widths.set(font, canvas.measureText('…').width); }
    return widths.get(font);
  };
  const range = document.createRange();
  // a part left out of a piece (see-through, out of the line's flow) is not seen (#1134, #1135: the size and the pages give way whole)
  const seen = (element, cut) => {
    const text = [], edge = cut ? element.getBoundingClientRect().right - ellipsis(element) + 0.5 : Infinity;
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && Number(getComputedStyle(child).opacity) === 0) continue;
        if (child.nodeType === 3) {
          // An uncut piece is wholly readable. For a clipped piece, only the text node
          // that actually meets the ellipsis needs a separate rectangle per character.
          if (cut) range.selectNodeContents(child);
          if (!cut || range.getBoundingClientRect().right <= edge) {
            text.push(child.data);
            continue;
          }
          for (let at = 0; at < child.data.length; at++) {
            range.setStart(child, at);
            range.setEnd(child, at + 1);
            const box = range.getBoundingClientRect();
            if (box.right > edge) return false;
            text.push(child.data[at]);
          }
        } else if (getComputedStyle(child).display.startsWith('inline-')) {
          if (child.getBoundingClientRect().right > edge) return false;
          text.push(child.textContent);
        } else if (!walk(child)) return false;
      }
      return true;
    };
    walk(element);
    // round 11: the characters' short words, drawn after the lead from its data-short where the list says them (not in the checkbox's name)
    const after = getComputedStyle(element, '::after');
    if (element.dataset.short && !['none', 'normal'].includes(after.content) && Number(after.opacity) !== 0 && after.position !== 'absolute') text.push(element.dataset.short);
    return text.join('');
  };
  return [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
    const facts = item.querySelector('.source-picker__facts'), line = facts.getBoundingClientRect(), lineHeight = parseFloat(getComputedStyle(facts).height);
    const unseen = piece => { for (let element = piece; element && element !== facts; element = element.parentElement) { const style = getComputedStyle(element); if (style.visibility !== 'visible' || Number(style.opacity) === 0) return true; } return false; };
    const drawn = piece => { const box = piece.getBoundingClientRect(); return box.width > 0 && box.top < line.top + lineHeight / 2 && box.left < line.right - 0.5 && !unseen(piece); };
    // #1133: a piece is cut bare where a box around it that clips (the notes' box, the line) ends before it does: its own box is whole, so its own widths
    // do not show it
    const clipRight = piece => {
      let right = Infinity;
      for (let element = piece.parentElement; element; element = element.parentElement) {
        if (getComputedStyle(element).overflowX !== 'visible') right = Math.min(right, element.getBoundingClientRect().right);
        if (element === facts) break;
      }
      return right;
    };
    const pieces = [...facts.querySelectorAll('.source-picker__fact')].map(piece => {
      const cut = piece.scrollWidth > piece.clientWidth + 0.5, tip = document.getElementById(piece.getAttribute('aria-describedby') || ''), box = piece.getBoundingClientRect();
      return { text: piece.textContent, short: piece.dataset.short || '', name: piece.classList.contains('source-picker__fact--name'), note: piece.classList.contains('source-picker__fact--note'), shown: drawn(piece), cut, seen: seen(piece, cut),
        clipped: box.right > clipRight(piece) + 0.5, tip: tip ? tip.textContent : null, right: box.right };
    });
    const shown = pieces.filter(piece => piece.shown);
    // the first character drawn inside the line (a piece pulled left of the line's start is clipped there)
    let start = '';
    for (const piece of [...facts.querySelectorAll('.source-picker__fact')].filter(element => drawn(element))) {
      const walker = document.createTreeWalker(piece, 4);
      for (let node = walker.nextNode(); node && !start; node = walker.nextNode()) {
        for (let at = 0; at < node.data.length && !start; at++) {
          if (/\s/.test(node.data[at])) continue;
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const box = range.getBoundingClientRect();
          if (box.width > 0 && box.left >= line.left - 0.5) start = node.data[at];
        }
      }
      if (start) break;
    }
    return { title: item.querySelector('strong').textContent, line: line.width, wide: item.querySelector('.source-picker__row').classList.contains('has-expand'),
      lead: pieces[0], pieces, names: pieces.filter(piece => piece.name), text: shown.map(piece => piece.seen + (piece.cut ? '…' : '')).join(' '),
      room: line.right - Math.max(...shown.map(piece => piece.right)), start };
  });
});

/**
 * #1134, #1135: what is wrong with the rows' formats and sizes, in words. The format (the lead's first part) is said whole on every row; the pages and the
 * characters are each said whole or left out, never cut (round 11: the characters in their long words or their short ones); and the rows of a kind (the
 * rows with pages; the rows of one format without) say their characters all or none, in one kind of words for the list.
 */
export const leadProblems = rows => {
  const bad = [], says = new Map(), words = new Set();
  for (const row of rows) {
    const parts = row.lead.text.split(' · '), [kind] = parts, paged = parts.length > 2, seen = row.lead.seen.trim(), sized = paged ? parts.slice(0, 2).join(' · ') : kind;
    if (!row.lead.shown || !seen.startsWith(kind)) { bad.push(`the format is not said whole: ${row.title}: ${row.text}`); continue; }
    const wholes = [kind, sized, row.lead.text, `${sized}${row.lead.short}`];
    if (row.lead.cut || !wholes.includes(seen)) bad.push(`the size is cut: ${row.title}: ${row.text}`);
    const group = paged ? 'with pages' : `${kind} without pages`;
    if (!says.has(group)) says.set(group, new Set());
    says.get(group).add(seen.length > sized.length);
    if (seen.length > sized.length) words.add(seen === row.lead.text ? 'long' : 'short');
  }
  for (const [group, said] of says) if (said.size > 1) bad.push(`rows ${group} disagree on their characters`);
  if (words.size > 1) bad.push('the list says its characters in two kinds of words');
  return bad;
};

/** 课程范围: 全部课程. */
export async function allCourses(page, lang) {
  await page.locator('[data-tour="generate-sources"] .page-scope__select').first().click();
  await page.getByRole('option', { name: lang === 'zh' ? '全部课程' : 'All courses' }).first().click();
  await until(async () => (await factsLines(page)).some(row => row.names.some(name => name.text.includes(COURSE))), `${lang}: 全部课程`);
  await settleAnimations(page);
  await frames(page, 4);
}

/** The checkboxes' accessible names, as Chromium computes them for a screen reader (the row's title, its facts and its badge's word). */
export async function boxNames(page, count) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]' });
    const names = [];
    for (const nodeId of nodeIds.slice(0, count)) names.push((await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes[0]?.name?.value ?? '');
    return names;
  } finally { await cdp.detach(); }
}

/** Scroll the list's window to its end (the window then draws more rows) or back to its top. The number of rows drawn. */
export const scrollList = (page, { top = false } = {}) => page.evaluate(top => {
  const box = document.querySelector('[data-tour="generate-sources"] .sh-scroll__viewport');
  box.scrollTop = top ? 0 : box.scrollHeight;
  return document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item').length;
}, top);

/** Every row of the list: scrolled to its end step by step (the window draws more rows as it goes), the rows' facts lines by title. */
export async function everyRow(page) {
  const rows = new Map();
  for (let step = 0, drawn = 0, still = 0; step <= 30 && still < 2; step++) {
    for (const row of await factsLines(page)) rows.set(row.title, row);
    const now = await scrollList(page);
    still = now === drawn ? still + 1 : 0;
    drawn = now;
    await frames(page, 3);
  }
  for (const row of await factsLines(page)) rows.set(row.title, row);
  return rows;
}

export const cutsOf = row => row.pieces.filter(piece => piece.shown && piece.cut);

/** On a failing renderer, compare the room assigned to each piece with its text metrics on a PDF and a note. */
export const factsGeometry = page => page.evaluate(() => {
  const picker = document.querySelector('[data-tour="generate-sources"] .source-picker');
  const canvas = document.createElement('canvas').getContext('2d');
  const seen = new Set(), examples = [];
  for (const row of picker.querySelectorAll('.source-picker__row')) {
    const group = row.dataset.sizeGroup;
    if (seen.has(group)) continue;
    seen.add(group);
    const line = row.querySelector('.source-picker__facts'), style = getComputedStyle(line);
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const measure = node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { text: node.textContent, left: rect.left, width: rect.width, scrollWidth: node.scrollWidth,
        canvasText: canvas.measureText(node.textContent).width, flex: css.flex, opacity: css.opacity, position: css.position };
    };
    examples.push({ group, line: line.getBoundingClientRect().width, font: canvas.font, gap: style.columnGap,
      pieces: [...line.querySelectorAll('.source-picker__fact, .source-picker__part')].map(measure) });
  }
  return { settings: { ...picker.dataset }, examples };
});
