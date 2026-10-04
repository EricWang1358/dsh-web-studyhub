/* Computed-style regression check for stylesheet refactors (ui-consistency wave 3, WP-S1).
     node scripts/qa/css-fingerprint.mjs capture --dist <dir> --out <file.json> [--lang zh|en --theme dark|light --width 1280]
     node scripts/qa/css-fingerprint.mjs diff <before.json> <after.json> [--limit 40]
   `capture` serves a built preview (`node scripts/build.mjs`, or a copy of its dist/) over a seeded temporary library,
   visits every page of the sidebar plus the dialogs, tabs and disclosures it can reach, and records for every element the
   computed values of the properties that make up its look (box, type, colour, effects) and its rounded layout rectangle.
   `diff` lists what changed between two captures. A pure CSS reorganisation (split, layers, tokens) must produce none.
   Nothing here touches a real library, a key or the network. */
/* global document, getComputedStyle, window */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createPreviewServer } from '../preview-server.mjs';
import { createFakeModel } from '../fake-model.mjs';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';
import { seedLibrary } from './perf-seed.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'visibility', 'opacity', 'overflow-x', 'overflow-y',
  'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'color', 'background-color', 'background-image', 'box-shadow', 'outline-style', 'outline-width', 'outline-color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'text-overflow', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'cursor', 'pointer-events', 'transform', 'filter', 'backdrop-filter',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content', 'justify-items', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'order', 'list-style-type',
  'transition-property', 'transition-duration', 'animation-name', 'appearance', 'accent-color', 'resize', 'content-visibility', 'zoom',
];
export const HOVER_PROPS = ['color', 'background-color', 'background-image', 'border-top-color', 'border-top-width', 'box-shadow', 'opacity', 'transform', 'outline-style', 'text-decoration-line', 'cursor', 'filter'];
export const FOCUS_PROPS = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-top-width', 'background-color', 'color'];
export const PSEUDO_PROPS = ['content', 'display', 'color', 'background-color', 'width', 'height', 'position', 'border-top-width', 'opacity', 'transform', 'font-size', 'font-weight'];

/* Runs in the page: { key: "p1|p2|..." } for every element, plus the pseudo-elements that render. */
export function collect([props, pseudoProps]) {
  const out = {};
  const round = (value) => value.replace(/-?\d+\.\d+/g, (n) => String(Math.round(parseFloat(n) * 10) / 10));
  const counters = new WeakMap();
  const keyOf = (el) => {
    if (counters.has(el)) return counters.get(el);
    const parent = el.parentElement;
    const index = parent ? [...parent.children].indexOf(el) : 0;
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0] || '';
    const key = `${parent ? keyOf(parent) : ''}>${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}[${index}]`;
    counters.set(el, key);
    return key;
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (/^(SCRIPT|STYLE|LINK|META|TITLE|NOSCRIPT|PATH|CIRCLE|LINE|RECT|POLYLINE|POLYGON|G|DEFS|USE|TEXT|TSPAN)$/i.test(el.tagName)) continue;
    if (el.closest('.mailbox__toggle')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') { out[keyOf(el)] = 'display:none'; continue; }
    const rect = el.getBoundingClientRect();
    const parts = props.map((p) => round(cs.getPropertyValue(p)));
    parts.push(`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
    out[keyOf(el)] = parts.join('|');
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== 'none' && ps.content !== 'normal') out[`${keyOf(el)}${pseudo}`] = pseudoProps.map((p) => round(ps.getPropertyValue(p))).join('|');
    }
  }
  return out;
}

const KILL_MOTION = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

export async function capture({ dist, out, lang = 'zh', theme = 'dark', width = 1280, height = 900 }) {
  scrubProcessEnv();
  const work = join(tmpdir(), `css-fp-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const library = join(work, 'library');
  await mkdir(library, { recursive: true });
  await seedLibrary(library, { sources: 20, decks: 3, cardsPerDeck: 8, runs: 3, attempts: 50, courses: 3, largeSources: 1, largeSourceChars: 6000 });
  /* One unpublished draft so the draft page and its row exist: a copy of the first deck's cards. */
  const { Store } = await import('../../lib/store.js');
  await new Store(library).update((state) => {
    const deck = state.decks[0];
    state.drafts.push({ id: 'draft-1', title: 'Draft 1', course: deck.course, folder: deck.folder, createdAt: deck.createdAt, version: 1,
      cards: deck.cards.map((card) => ({ ...structuredClone(card), id: `draft-${card.id}` })) });
  });
  const server = await createPreviewServer({ libraryRoot: library, home: join(work, 'home'), port: 0, model: createFakeModel({ latencyMs: 50, usage: true }), distDir: resolve(dist) });
  const browser = await launchChromium({ args: [`--lang=${lang === 'en' ? 'en-US' : 'zh-CN'}`] });
  const result = { options: { lang, theme, width, height }, states: {} };
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
    await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await page.addStyleTag({ content: KILL_MOTION });
    await sleep(900);
    const snap = async (name) => {
      await sleep(350);
      result.states[name] = await page.evaluate(collect, [PROPS, PSEUDO_PROPS]).catch((error) => ({ error: String(error) }));
    };
    const settle = (ms = 450) => sleep(ms);
    /* Hover each of the first interactive elements and record its look (hover rules, tooltips, focus rings follow the same cascade). */
    const hoverPass = async (name, selector, limit = 40) => {
      /* One element per distinct class list (the first of each kind), so every variant of a control is sampled, not the first screenful of one kind. */
      const rects = await page.evaluate(([sel, max]) => { const seen = new Set(); return [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 4 && r.height > 4 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth && getComputedStyle(el).visibility !== 'hidden')) return false;
        const sig = `${el.tagName}.${typeof el.className === 'string' ? el.className : ''}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      }).slice(0, max).map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; }); }, [selector, limit]).catch(() => []);
      const record = {}, focusRecord = {};
      await page.keyboard.press('Tab');
      for (let i = 0; i < rects.length; i++) {
        await page.mouse.move(rects[i][0], rects[i][1]);
        await sleep(90);
        const one = await page.evaluate(([x, y, props]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          const path = (node) => { const parent = node.parentElement; const idx = parent ? [...parent.children].indexOf(node) : 0; const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/)[0] || ''; return `${parent ? path(parent) : ''}>${node.tagName.toLowerCase()}${cls ? '.' + cls : ''}[${idx}]`; };
          const cs = getComputedStyle(el);
          const round = (v) => v.replace(/-?\d+\.\d+/g, (n) => String(Math.round(parseFloat(n) * 10) / 10));
          return [path(el), props.map((p) => round(cs.getPropertyValue(p))).join('|')];
        }, [rects[i][0], rects[i][1], HOVER_PROPS]).catch(() => null);
        if (one) record[`hover:${one[0]}`] = one[1];
        /* and the same element focused from the keyboard */
        const focused = await page.evaluate(([x, y, props]) => {
          const el = document.elementFromPoint(x, y);
          if (!el || typeof el.focus !== 'function') return null;
          el.focus({ focusVisible: true });
          if (document.activeElement !== el) return null;
          const path = (node) => { const parent = node.parentElement; const idx = parent ? [...parent.children].indexOf(node) : 0; const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/)[0] || ''; return `${parent ? path(parent) : ''}>${node.tagName.toLowerCase()}${cls ? '.' + cls : ''}[${idx}]`; };
          const cs = getComputedStyle(el);
          const round = (v) => v.replace(/-?\d+\.\d+/g, (n) => String(Math.round(parseFloat(n) * 10) / 10));
          const out = [path(el), props.map((p) => round(cs.getPropertyValue(p))).join('|')];
          el.blur();
          return out;
        }, [rects[i][0], rects[i][1], FOCUS_PROPS]).catch(() => null);
        if (focused) focusRecord[`focus:${focused[0]}`] = focused[1];
      }
      await page.mouse.move(0, 0);
      result.states[`hover-${name}`] = record;
      result.states[`focus-${name}`] = focusRecord;
    };
    const closeOverlays = async () => {
      for (let i = 0; i < 3; i++) {
        if (!await page.locator('dialog[open], [role=dialog]').count()) break;
        await page.keyboard.press('Escape'); await sleep(250);
      }
    };
    const navIds = await page.locator('[data-tour^="nav-"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-tour').slice(4)));
    await snap('home');
    for (const id of navIds) {
      const go = async () => { await closeOverlays(); await page.locator(`[data-tour="nav-${id}"]`).first().click({ timeout: 5000 }).catch(() => {}); await settle(); };
      await go();
      await snap(`page-${id}`);
      await hoverPass(`page-${id}`, 'main button, main a[href], main [role="tab"], main summary, main input, main select, main textarea, .sidebar button');
      /* Reach what the page hides: tabs, disclosures, segmented controls, menus. */
      const probes = await page.locator('main [role="tab"][aria-selected="false"], main summary, main [aria-expanded="false"]:not([data-tour^="nav-"]), main .sh-seg button[aria-pressed="false"], main .sh-seg button[aria-checked="false"], .settings-nav__item').evaluateAll((items) => items.slice(0, 40).map((_, index) => index)).catch(() => []);
      const sel = 'main [role="tab"][aria-selected="false"], main summary, main [aria-expanded="false"]:not([data-tour^="nav-"]), main .sh-seg button[aria-pressed="false"], main .sh-seg button[aria-checked="false"], .settings-nav__item';
      for (const index of probes.slice(0, id === 'settings' ? 40 : 10)) {
        await go();
        const target = page.locator(sel).nth(index);
        if (!await target.count() || !await target.isVisible().catch(() => false)) continue;
        const label = await target.evaluate((el) => (el.getAttribute('data-category') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24));
        await target.click({ timeout: 3000 }).catch(() => {});
        await settle(300);
        await snap(`page-${id}-probe-${index}-${label}`);
      }
      await closeOverlays();
    }
    /* Dialogs and flows by anchor. */
    const flows = [
      ['sources', 'sources-add', 'add-source'],
      ['generate', 'generate-case', 'case-create'],
      ['exam', 'exam-case', 'exam-case'],
      ['library', 'home-catalog', 'home-catalog'],
    ];
    for (const [pageId, anchor, name] of flows) {
      await closeOverlays();
      await page.locator(`[data-tour="nav-${pageId}"]`).first().click({ timeout: 5000 }).catch(() => {});
      await settle();
      const target = page.locator(`[data-tour="${anchor}"]`).first();
      if (await target.count()) { await target.scrollIntoViewIfNeeded().catch(() => {}); await target.click({ timeout: 3000 }).catch(() => {}); await settle(); }
      await snap(`flow-${name}`);
    }
    /* Click each button of a region one after another (popovers close with Escape) and record what it shows. */
    const probe = async (selector, prefix, limit = 8) => {
      const total = Math.min(await page.locator(selector).count(), limit);
      for (let i = 0; i < total; i++) {
        const target = page.locator(selector).nth(i);
        if (!await target.isVisible().catch(() => false)) continue;
        const label = await target.evaluate((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20)).catch(() => '');
        await target.click({ timeout: 2500 }).catch(() => {});
        await settle(300);
        await snap(`${prefix}-${i}-${label}`);
        await page.keyboard.press('Escape'); await sleep(200);
      }
    };
    /* A practice run: every card kind, before and after the answer, with the toolbar's popovers. */
    await closeOverlays();
    await page.locator('[data-tour="nav-library"]').first().click({ timeout: 5000 }).catch(() => {});
    await settle();
    if (await page.locator('.map-play').count()) {
      await page.locator('.map-play').first().click({ timeout: 3000 }).catch(() => {});
      await settle(800);
      const ticks = await page.locator('.review-tick').count();
      for (let i = 0; i < Math.min(ticks, 8); i++) {
        await page.locator('.review-tick').nth(i).click({ timeout: 2500 }).catch(() => {});
        await settle(400);
        await snap(`review-q${i}`);
        if (await page.locator('.flip-control').count()) { await page.locator('.flip-control').first().click().catch(() => {}); await settle(400); await snap(`review-q${i}-flipped`); }
        else if (await page.locator('.options .option').count()) {
          await page.locator('.options .option').first().click().catch(() => {});
          await page.locator('.options .option.correct').first().waitFor({ timeout: 2500 }).catch(() => {});
          await settle(300);
          await snap(`review-q${i}-picked`);
          const submit = page.locator('button.primary, .sh-btn--primary').filter({ hasText: /提交|Submit/ }).first();
          if (await submit.count() && await submit.isEnabled().catch(() => false)) { await submit.click().catch(() => {}); await page.locator('.options .option.correct').first().waitFor({ timeout: 2500 }).catch(() => {}); await settle(500); await snap(`review-q${i}-answered`); }
        } else if (await page.locator('main textarea, main input[type="text"]').count()) {
          await page.locator('main textarea, main input[type="text"]').first().fill('sample answer').catch(() => {});
          await settle(200);
          await snap(`review-q${i}-typed`);
          const submit = page.locator('button.primary, .sh-btn--primary').filter({ hasText: /提交|Submit|批改|Grade/ }).first();
          if (await submit.count() && await submit.isEnabled().catch(() => false)) { await submit.click().catch(() => {}); await settle(700); await snap(`review-q${i}-answered`); }
        }
      }
      await hoverPass('review', 'main button, .review-tick');
      await probe('.question-toolbar button, .review-toolbar button, main .tool-action, main .tool-icon', 'review-tool', 10);
    }
    /* A source in the reader: its toolbar and menus. */
    await closeOverlays();
    await page.locator('[data-tour="nav-sources"]').first().click({ timeout: 5000 }).catch(() => {});
    await settle();
    await page.locator('.source-group-head').first().click({ timeout: 3000 }).catch(() => {});
    await settle(300);
    if (await page.locator('.source-main').count()) {
      await page.locator('.source-main').first().click({ timeout: 3000 }).catch(() => {});
      await settle(1200);
      await snap('reader');
      await probe('.study-document-viewer button, [class*="reader"] button, .source-actions button', 'reader-tool', 14);
    }
    /* A draft: the editor and its row controls. */
    await closeOverlays();
    await page.locator('[data-tour="nav-library"]').first().click({ timeout: 5000 }).catch(() => {});
    await settle();
    if (await page.locator('.draft-row .draft-open').count()) {
      await page.locator('.draft-row .draft-open').first().click({ timeout: 3000 }).catch(() => {});
      await settle(900);
      await snap('draft');
      await probe('main .draft-card button, main .card-editor button, main details summary', 'draft-tool', 10);
    }
    /* Open the first row of the lists (a source in the reader, a deck, a draft, a run) one level deep. */
    for (const [pageId, rowSel, name] of [['sources', '.source-row, .source-item, [data-source-id], main li button', 'source-open'], ['library', '.map-deck, .map-row, .deck-row', 'deck-open'], ['wrongbook', 'main li button, main .wrong-item', 'wrong-open']]) {
      await closeOverlays();
      await page.locator(`[data-tour="nav-${pageId}"]`).first().click({ timeout: 5000 }).catch(() => {});
      await settle();
      const rows = page.locator(rowSel);
      if (await rows.count()) { await rows.first().click({ timeout: 3000 }).catch(() => {}); await settle(700); await snap(`flow-${name}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  result.errors = errors;
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(result));
  const count = Object.values(result.states).reduce((n, state) => n + Object.keys(state).length, 0);
  console.log(`captured ${Object.keys(result.states).length} states, ${count} element records, ${errors.length} page errors -> ${out}`);
  return result;
}

/** Differences between two captures: [{ state, key, prop, before, after }] (a missing element is reported as prop "(element)"). */
export function diffCaptures(a, b) {
  const names = [...PROPS, 'rect'];
  const out = [];
  for (const state of new Set([...Object.keys(a.states), ...Object.keys(b.states)])) {
    const left = a.states[state], right = b.states[state];
    if (!left || !right) { out.push({ state, key: '(state)', prop: '(state)', before: left ? 'present' : 'missing', after: right ? 'present' : 'missing' }); continue; }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const x = left[key], y = right[key];
      if (x === y) continue;
      if (x === undefined || y === undefined) { out.push({ state, key, prop: '(element)', before: x === undefined ? 'missing' : 'present', after: y === undefined ? 'missing' : 'present' }); continue; }
      const xs = x.split('|'), ys = y.split('|');
      const pseudo = key.endsWith('::before') || key.endsWith('::after'), hover = key.startsWith('hover:'), focus = key.startsWith('focus:');
      /* The colour of a border that is not drawn (zero width on that side) is not a visible difference. */
      const invisible = (i) => {
        const side = /^border-(top|right|bottom|left)-color$/.exec(names[i])?.[1];
        if (!side || hover || focus || pseudo) return false;
        const at = (list, name) => list[names.indexOf(name)];
        return at(xs, `border-${side}-width`) === '0px' && at(ys, `border-${side}-width`) === '0px';
      };
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) if (xs[i] !== ys[i] && !invisible(i)) out.push({ state, key, prop: focus ? `focus.${FOCUS_PROPS[i] ?? i}` : hover ? `hover.${HOVER_PROPS[i] ?? i}` : pseudo ? `pseudo.${PSEUDO_PROPS[i] ?? i}` : names[i] ?? i, before: xs[i], after: ys[i] });
    }
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const values = {}, positional = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) values[rest[i].slice(2)] = rest[++i]; else positional.push(rest[i]); }
  if (command === 'capture') {
    if (!values.dist || !values.out) throw new Error('capture needs --dist <dir> and --out <file>');
    await capture({ dist: values.dist, out: resolve(values.out), lang: values.lang, theme: values.theme, width: values.width ? Number(values.width) : undefined });
  } else if (command === 'diff') {
    const [a, b] = await Promise.all(positional.slice(0, 2).map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
    const diffs = diffCaptures(a, b);
    const byProp = new Map();
    for (const d of diffs) byProp.set(d.prop, (byProp.get(d.prop) || 0) + 1);
    console.log(`${diffs.length} difference(s) in ${new Set(diffs.map((d) => d.state)).size} state(s)`);
    for (const [prop, n] of [...byProp].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(6)}  ${prop}`);
    const limit = Number(values.limit ?? 40);
    for (const d of diffs.slice(0, limit)) console.log(`${d.state} ${d.key.slice(-110)} ${d.prop}: ${d.before} -> ${d.after}`);
    process.exitCode = diffs.length ? 1 : 0;
  } else throw new Error('usage: capture --dist <dir> --out <file> | diff <before> <after>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error?.message || error); process.exitCode = 2; });
}
