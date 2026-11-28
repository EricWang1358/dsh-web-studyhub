/* Switching pages stuttered (owner, 2026-11-05). scripts/qa/page-switch-perf.mjs measured why: the leaving page's state rule set
   `pointer-events: none`, an inherited property, so every switch restyled every element of the old page inside the click (2 600 elements,
   17 ms on 学习库; 9 800 elements, 80 ms on a long page) before the leave motion could start. A leaving page changes only opacity and
   transform (each restyles the page root alone); a press on it during the beat is refused by ui/app/leave-guard.js instead. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT, walk, parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { refuseLeavingPress } from '../ui/app/leave-guard.js';
import { appearanceAttrs, seatAttrs } from '../ui/appearance-prefs.js';

const PAGE_ROOT = /\.(page|review-page|board-page)\b/;

test('the leaving page changes opacity and transform only, never an inherited property that restyles the whole page', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const d of parseCss(readFileSync(file, 'utf8')).declarations) {
      const selector = d.ctx.at(-1) || '';
      if (selector.includes('.is-leaving') && /\bmain\b/.test(selector) && PAGE_ROOT.test(selector)) found.push(`${rel} (line ${d.line}): ${d.prop}`);
    }
  }
  assert.ok(found.length > 0, 'the leaving state rule is still found');
  assert.deepEqual(found.filter((entry) => !/: (opacity|transform)$/.test(entry)), [], 'set only opacity or transform on a leaving page');
});

/** A press as the browser hands it: the element it landed on, and the two calls that refuse it. */
function press(target) {
  const event = { target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  return event;
}
const element = (insidePage) => ({ closest: (selector) => (insidePage && selector.includes('.page') ? {} : null) });

test('a press on the page that is leaving does nothing', () => {
  const event = press(element(true));
  refuseLeavingPress(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('a press outside the leaving page (the top bar, a banner) still works', () => {
  const event = press(element(false));
  refuseLeavingPress(event);
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
});

test('a press on a text node or a target without closest() is left alone', () => {
  const event = press({});
  refuseLeavingPress(event);
  assert.equal(event.stopped, false);
});

/* The new page arriving is a DOM insertion, and so is every toast, row and badge React adds later. A :has() that is not in the subject of
   its selector (`.x:has(...) <target>`) is checked again on such insertions, and when the target names no class, id, element or attribute
   (`*`, `:focus-visible`, `:not(...)`) Chrome restyles everything under the elements the :has() was tried on: on 创建题组, with
   `.study-app:is([data-motion='off'], :has(> .study-app[data-motion='off'])) *` in the sheet, inserting one <p> restyled all 6 266
   elements (70-110 ms in the development build) where it restyles 289 without such a rule. Name the target, or stamp what the :has()
   asked for on the element itself. */
const splitTop = (text, separators) => {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && separators.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((part) => part.trim()).filter(Boolean);
};
/** The flat selectors a declaration's nesting chain stands for (`&` is the parent; a nested selector without one is its descendant). */
const flatSelectors = (ctx) => ctx.filter((prelude) => !prelude.startsWith('@')).reduce((parents, prelude) => parents.flatMap((parent) =>
  splitTop(prelude, ',').map((part) => (!parent ? part : part.includes('&') ? part.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${part}`))), ['']);
/** A compound without its :not(...) and :has(...) groups and pseudo-classes (:is and :where keep what they name). */
const withoutNegations = (compound) => {
  let out = '';
  for (let i = 0; i < compound.length; i++) {
    const head = compound.slice(i, i + 5);
    if (head === ':not(' || head === ':has(') {
      let depth = 0, j = i + 4;
      for (; j < compound.length; j++) { if (compound[j] === '(') depth++; else if (compound[j] === ')' && --depth === 0) break; }
      i = j;
      continue;
    }
    out += compound[i];
  }
  return out.replace(/::?[\w-]+/g, (pseudo) => (/^:(is|where)$/.test(pseudo) ? pseudo : ''));
};
/** Selectors whose :has() sits before a combinator and whose target names nothing Chrome can narrow the restyle to. */
function unboundedHasSelectors(css) {
  const found = new Set();
  for (const d of parseCss(css).declarations) for (const flat of flatSelectors(d.ctx)) for (const selector of splitTop(flat, ',')) {
    const compounds = splitTop(selector, ' >+~');
    if (!compounds.slice(0, -1).some((compound) => compound.includes(':has('))) continue;
    if (!/[.#[]|^[a-z]/i.test(withoutNegations(compounds.at(-1)).replace(/^\*/, ''))) found.add(selector);
  }
  return [...found];
}

test('the :has() guard tells a whole-app restyle from a narrow one', () => {
  const scope = (body) => `@layer study.features {\n  :is(.study-app, .study-seat) {\n${body}\n  }\n}\n`;
  assert.equal(unboundedHasSelectors(scope("&:is([data-motion='off'], :has(> .study-app[data-motion='off'])) *::before { transition: none; }")).length, 1);
  assert.equal(unboundedHasSelectors(scope('.row:has(> .delete) > :not(.open, .delete) { grid-column: 1 / -1; }')).length, 1);
  assert.equal(unboundedHasSelectors(scope('.x:has(.y) {\n  :focus-visible { outline: 0; }\n}')).length, 1, 'nesting puts the :has() before the combinator too');
  assert.equal(unboundedHasSelectors(scope('.row:has(> .delete) { gap: 0; }\n.row:has(> .delete) > .meta { gap: 0; }')).length, 0, 'a subject :has() and a named target are fine');
  assert.equal(unboundedHasSelectors(scope("&[data-motion='off'] *:not(.spin) { transition: none; }")).length, 0, 'an attribute on the root needs no :has()');
});

test('no stylesheet has a :has() that makes every insertion restyle the whole app', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const entry of unboundedHasSelectors(readFileSync(file, 'utf8'))) found.push(`${rel}: ${entry}`);
  }
  assert.deepEqual(found, []);
});

const appProbe = {
  name: 'app-probe',
  setup(builder) {
    builder.onResolve({ filter: /[\\/]App\.jsx$/ }, () => ({ path: 'app-probe', namespace: 'probe' }));
    builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
      loader: 'js',
      contents: "import React from 'react'; export default function App() { return React.createElement('div', { 'data-probe': 'app' }); }",
    }));
  },
};

async function loadWorkspaceSeat() {
  const compiled = await build({
    stdin: {
      contents: `
        export { createWorkspaceHost } from './ui/host/workspace.jsx';
        export { appearanceStore } from './ui/use-appearance.js';
      `,
      resolveDir: ROOT,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom'],
    loader: { '.css': 'text' },
    plugins: [appProbe],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
}

test('the DSH seat wears the motion and contrast choices itself, so what sits beside the app (a note, the candidate dialog) follows them without a :has()', async () => {
  const dark = { light: false, reducedMotion: false, contrast: false };
  assert.deepEqual(seatAttrs(appearanceAttrs({ motion: 'off', contrast: 'high', craft: 'refined', minimal: 'on' }, dark)), { 'data-motion': 'off', 'data-contrast': 'high', 'data-craft': 'refined', 'data-minimal': 'on' });
  assert.deepEqual(seatAttrs(appearanceAttrs({}, { ...dark, reducedMotion: true })), { 'data-motion': 'reduced', 'data-contrast': 'standard', 'data-craft': 'standard', 'data-minimal': 'off' }, 'auto follows the system');
  const { createWorkspaceHost, appearanceStore } = await loadWorkspaceSeat();
  const { Seat } = createWorkspaceHost({ get: () => null }, { effect: () => {} });
  const renderSeatTag = () => {
    const html = renderToStaticMarkup(React.createElement(Seat, { sessionId: 's-1', placement: 'page' }));
    const match = html.match(/<div\b[^>]*class="study-seat"[^>]*>/);
    assert.ok(match, `expected .study-seat root in ${html}`);
    return match[0];
  };
  const previous = appearanceStore.get();
  try {
    appearanceStore.reset();
    const defaultTag = renderSeatTag();
    assert.match(defaultTag, /\bdata-motion="full"/);
    assert.match(defaultTag, /\bdata-contrast="standard"/);
    assert.match(defaultTag, /\bdata-craft="standard"/);
    assert.match(defaultTag, /\bdata-minimal="off"/);
    assert.doesNotMatch(defaultTag, /\bdata-theme=/);

    appearanceStore.update({ motion: 'off', contrast: 'high', craft: 'refined', minimal: 'on' });
    const updatedTag = renderSeatTag();
    assert.match(updatedTag, /\bdata-motion="off"/);
    assert.match(updatedTag, /\bdata-contrast="high"/);
    assert.match(updatedTag, /\bdata-craft="refined"/);
    assert.match(updatedTag, /\bdata-minimal="on"/);
    assert.doesNotMatch(updatedTag, /\bdata-theme=/);
  } finally {
    appearanceStore.update(previous);
  }
});

/* 4.11.1 felt slow to switch pages inside DSH (owner, 2026-11-17): 控件与字阶 (ui/appearance-craft.css) asked
   `.study-seat:has(> .study-app[data-craft='refined']) <target>` in 26 rules, and `.sh-btn:has(> :first-child:is(.sh-icon, .sh-spinner))` of every
   button, even with the choice off. In a real DSH host (4x CPU throttle) style recalculation went from 6.8 s to 10.6 s over the same switches.
   The seat wears the choice itself (seatAttrs), and the glyph at a button's end takes its half step back itself. */
function rootHasBeforeCombinator(css) {
  const found = new Set();
  for (const d of parseCss(css).declarations) for (const flat of flatSelectors(d.ctx)) for (const selector of splitTop(flat, ',')) {
    const compounds = splitTop(selector, ' >+~');
    if (compounds.slice(0, -1).some((compound) => /\.study-(seat|app)\b[^ ]*:has\(/.test(compound))) found.add(selector);
  }
  return [...found];
}
const positionalHas = (css) => [...css.matchAll(/:has\(([^{}]*?)\)\s*[,{]/g)].map((m) => m[0]).filter((text) => /:(first|last|only|nth)-(child|of-type)/.test(text));

test('no stylesheet asks the seat or the app root with :has() before a combinator, and no :has() asks where a child stands', () => {
  assert.equal(rootHasBeforeCombinator(".study-seat:has(> .study-app[data-craft='refined']) small { color: red; }").length, 1);
  assert.equal(rootHasBeforeCombinator(".study-seat[data-craft='refined'] small { color: red; }\n.study-seat[data-craft='refined']:has(> .study-app[data-theme='light']) { --x: 1; }").length, 0);
  assert.equal(positionalHas('.sh-btn:has(> :first-child:is(.sh-icon)) { padding: 0; }').length, 1);
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/'), css = readFileSync(file, 'utf8');
    for (const entry of [...rootHasBeforeCombinator(css), ...positionalHas(css)]) found.push(`${rel}: ${entry}`);
  }
  assert.deepEqual(found, []);
});

test('控件与字阶 reads the choice from the seat and the glyph, never from a :has()', () => {
  const { declarations, blocks } = parseCss(readFileSync(join(ROOT, 'ui/appearance-craft.css'), 'utf8'));
  const selectors = [...new Set(declarations.flatMap((d) => flatSelectors(d.ctx)))];
  assert.ok(declarations.length > 0, 'appearance-craft.css declares styles');
  assert.equal(
    selectors.some((sel) => /\.study-seat\[data-craft=['"]refined['"]\]\s+/.test(sel)),
    true,
    'appearance-craft.css reads refined craft directly from .study-seat[data-craft="refined"]',
  );
  assert.equal(
    declarations.some(
      (d) => d.prop === 'margin-inline-start'
        && flatSelectors(d.ctx).some((sel) => />\s*:is\(\.sh-icon,\s*\.sh-spinner\):first-child\b/.test(sel)),
    ),
    true,
    'the leading glyph adjusts its own margin via > :is(.sh-icon, .sh-spinner):first-child',
  );
  const craftHasRe = /:has\(\s*>\s*\.study-app\[data-craft/;
  assert.deepEqual(
    [
      ...declarations.flatMap((d) => d.ctx).filter((c) => craftHasRe.test(c)),
      ...blocks.map((b) => b.prelude).filter((p) => craftHasRe.test(p)),
    ],
    [],
    'appearance-craft.css never queries data-craft via :has(> .study-app[data-craft...])',
  );
});

/* 2026-11-18, measured with page-switch-perf on React's production build (300 资料, 1440 px, 21 switches): long tasks 1948 ms -> 996 ms, the
   worst frame entering 资料 208 -> 125 ms and entering 创建题组 325 -> 167 ms (docs/performance.md). What made the difference is pinned below:
   each is a read of the layout in the middle of building a page, or a list that laid out rows nobody could see. */
const source = (file) => readFileSync(join(ROOT, file), 'utf8');

test('the sidebar highlight is measured by the resize observer, after the browser laid the page out, and lands in the same paint', () => {
  const nav = source('ui/app/SidebarNav.jsx');
  assert.match(nav, /if \(typeof ResizeObserver !== 'function'\) \{ measure\(\); return undefined; \}/, 'rows are read in the commit only where there is no observer');
  assert.match(nav, /new ResizeObserver\(\(\) => flushSync\(measure\)\)/, 'the report is committed before the paint (tests/nav-layout.test.mjs measures it)');
  assert.match(nav, /useMemo\(\(\) => \(sources \? countDocuments\(sources\) : 0\), \[sources\]\)/, 'the number on 资料 is counted once per snapshot');
  assert.doesNotMatch(nav, /hint=\{[^}]*countDocuments\(/, 'not in every render of every row');
});

test('a segmented control reads before it writes, and only places a newly chosen item during the commit', () => {
  const seg = source('ui/components/SegmentedControl.jsx');
  const place = seg.slice(seg.indexOf('const place = useCallback('), seg.indexOf('const mounted = useRef(false)'));
  const writes = place.slice(place.indexOf("mark.style.transition = 'none'"));
  assert.ok(place.length > 0 && writes.length > 0, 'the placement code is still found');
  assert.doesNotMatch(writes, /item\.offset/, 'no measurement of the item after the first write (each one was a layout of the page)');
  assert.match(seg, /const watched = typeof ResizeObserver !== 'undefined' && \(!mounted\.current \|\| active\.current === activeIndex\)/);
  assert.match(seg, /if \(!watched\) place\(moved\)/, 'with an observer, a render that chose nothing new measures nothing');
  assert.match(seg, /new ResizeObserver\(\(\) => place\(false, true\)\)/, 'the first placement and every resize are the observer\'s');
  assert.doesNotMatch(seg, /fonts\?\.ready/, 'reading document.fonts.ready lays the page out on the spot: the loadingdone event is listened to instead');
  assert.match(seg, /addEventListener\?\.\('loadingdone', refit\)/);
});

test('a 资料 row far from the window is not laid out, and a row never clips its own open menu or tooltip', () => {
  const css = source('ui/sources.css');
  assert.match(css, /\.source-doc \{ content-visibility: auto; contain-intrinsic-size: auto \d+px; \}/);
  assert.match(css, /\.source-doc:is\(:hover, :focus-within, \.source-doc--menu\) \{ content-visibility: visible; \}/, 'the containment is lifted where a row draws outside itself');
  const rows = source('ui/Sources.jsx');
  assert.match(rows, /<details className="source-row-actions" onToggle=\{event => setMenuOpen\(event\.currentTarget\.open\)\}>/, 'the row knows its menu is open');
  assert.match(rows, /\(menuOpen \? " source-doc--menu" : ""\)/);
});

test('--production measures the bundle the harness serves, and leaves the repository dist/ alone', () => {
  assert.match(source('scripts/qa/harness.mjs'), /buildPreview\(\{ outdir: distDir, production: options\.production === "true", readable: options\.readable === "true" \}\)/);
  for (const file of ['scripts/qa/page-switch-perf.mjs', 'scripts/qa/ui-motion.mjs', 'scripts/qa/ui-profile.mjs'])
    assert.doesNotMatch(source(file), /buildPreview\(\{ production: true \}\)/, `${file} used to rebuild dist/ for production and then measure the harness's development bundle`);
});

/* A reader's report (2026-11-19): 「答题后显示对错以及资料库原文索引有点卡」, 「主要还是链接原文资料库的时候卡」. Measured at 1440 px with a material open
   beside the question (a book of 800 pages, 800 elements in the reader): every answer and every next question restyled the whole page, 200 to 500 ms of
   style each. Three causes in the stylesheets, each pinned below; the fourth, the reader's ::highlight() rules, is tests/highlight-gate.test.mjs.

   1. A sibling selector whose left side names no class, id or attribute (`> * + *`, `li + li`, `p + p`). Chrome keeps such rules in one set that it
      applies to the neighbours of EVERY element added or removed, anywhere, and restyles what the rule could reach under them: with three `> * + *`
      rules in the sheet (the plan card's, the board's, the audio settings'), one hidden button put before the reader restyled all of the reader, and
      thirteen tag + tag rules did the same for its paragraphs and spans (261 ms an insertion with them all, 1 ms with none). Say "not the first child"
      (`> :where(:not(:first-child))`, `li:where(:not(:first-child))`) or name the left side. */
/** A selector's compounds with the combinator before each ('' for the first, ' ' for a descendant). */
function compoundsOf(selector) {
  const out = [];
  let depth = 0, quote = '', cur = '', pending = '';
  const push = () => { if (cur.trim()) { out.push({ compound: cur.trim(), combinator: pending }); pending = ' '; } cur = ''; };
  for (const ch of selector) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && ' >+~'.includes(ch)) { push(); if (ch !== ' ') pending = ch; continue; }
    cur += ch;
  }
  push();
  return out;
}
const namesItself = (compound) => /[.#[]/.test(withoutNegations(compound));
/** Sibling selectors Chrome cannot tie to an element: the left side is `*`, a tag or a :not(), and the right side is more than one named element. */
function unnamedSiblingSelectors(css) {
  const found = new Set();
  for (const d of parseCss(css).declarations) for (const flat of flatSelectors(d.ctx)) for (const selector of splitTop(flat, ',')) {
    const parts = compoundsOf(selector);
    parts.forEach((part, at) => {
      if ((part.combinator !== '+' && part.combinator !== '~') || namesItself(parts[at - 1].compound)) return;
      // One named element right after the combinator and nothing under it (`:not(.note) + .note`): only a neighbour of that name is looked at.
      if (at === parts.length - 1 && namesItself(part.compound)) return;
      found.add(selector);
    });
  }
  return [...found];
}

test('the sibling guard tells a rule every insertion pays for from one tied to a named element', () => {
  const scope = (body) => `@layer study.features {\n  :is(.study-app, .study-seat) {\n${body}\n  }\n}\n`;
  assert.equal(unnamedSiblingSelectors(scope('.plan > * + * { margin-top: 0; }')).length, 1);
  assert.equal(unnamedSiblingSelectors(scope('.list li + li { margin-top: 0; }')).length, 1);
  assert.equal(unnamedSiblingSelectors(scope('.list li + li .item { border: 0; }')).length, 1);
  assert.equal(unnamedSiblingSelectors(scope('.meta > small ~ small::before { content: "x"; }')).length, 1);
  assert.equal(unnamedSiblingSelectors(scope('.prose :not(.note) + .note { margin: 0; }')).length, 0, 'only a .note beside the change is looked at');
  assert.equal(unnamedSiblingSelectors(scope('.pop__label + .opt { margin: 0; }\n[data-x="a + b"] + p { margin: 0; }')).length, 0, 'a named left side');
  assert.equal(unnamedSiblingSelectors(scope('.plan > :where(:not(:first-child)) { margin-top: 0; }\n.list li:where(:not(:first-child)) { margin-top: 0; }')).length, 0);
});

test('no stylesheet has a sibling rule that every insertion in the app pays for', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const entry of unnamedSiblingSelectors(readFileSync(file, 'utf8'))) found.push(`${rel}: ${entry}`);
  }
  assert.deepEqual(found, []);
});

/* 2. A change of scroll-padding on the page's scroller (.study-app) restyles every element of the page in Chrome, whatever makes the change: a :has(),
      an attribute or an inline style (200 ms with the reader open, measured each way). The room above the stuck answer bar was
      `root:has(.review-sticky-bar[data-answered]) { scroll-padding-bottom }`, so every answer and every next question paid it. The question area now
      gives what can take the focus a scroll-margin-bottom while the bar is stuck (the same clearance: WCAG 2.4.11), which restyles the question's own
      controls. The one rule left flips when 创建题组 is entered and left, with the whole page, not inside it. */
/** Rules that set scroll-padding on the app's root under a condition. */
function statefulRootScrollPadding(css) {
  const found = new Set();
  for (const d of parseCss(css).declarations) {
    if (!d.prop.startsWith('scroll-padding')) continue;
    for (const flat of flatSelectors(d.ctx)) for (const selector of splitTop(flat, ',')) {
      const subject = splitTop(selector, ' >+~').at(-1);
      if (!/\.study-(app|seat)\b/.test(subject)) continue;
      if (subject.replace(/\.study-(app|seat)\b|:is\(|:where\(|[(),\s]/g, '')) found.add(selector);
    }
  }
  return [...found];
}

test('the page scroller\'s scroll-padding does not follow a state of the page', () => {
  const scope = (body) => `:is(.study-app, .study-seat) {\n${body}\n}\n`;
  assert.equal(statefulRootScrollPadding(scope('&:has(.bar[data-answered]) { scroll-padding-bottom: 8px; }')).length, 1);
  assert.equal(statefulRootScrollPadding(scope('&[data-bar-stuck="true"] { scroll-padding-bottom: 8px; }')).length, 1);
  assert.equal(statefulRootScrollPadding('.study-app { scroll-padding-top: 8px; }\n.study-app .strip[data-x] { scroll-padding-inline: 2px; }').length, 0);
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (statefulRootScrollPadding(readFileSync(file, 'utf8')).length) found.push(rel);
  }
  assert.deepEqual(found, ['ui/generate-home.css']);
});

test('the stuck answer bar keeps the focus clear of itself from the question area, not from the page scroller', () => {
  const css = source('ui/review/review.css');
  assert.doesNotMatch(css.replace(/\/\*[^]*?\*\//g, ''), /scroll-padding/);
  assert.match(css, /\.question-area\[data-bar-stuck="true"\] > :not\(\.review-sticky-bar\) :is\(a\[href\], :enabled, summary, \[tabindex\], \[contenteditable\]\),/);
  assert.match(css, /\[contenteditable\]\):not\(\.review-sticky-bar\) \{\s*scroll-margin-bottom: [^;]*var\(--review-bar-room\)/, 'the bar\'s own controls are excluded from its measured focus clearance');
  const run = source('ui/review/QuestionRun.jsx');
  assert.match(run, /const barStuck = !!run\.feedback \|\| barGrading;/);
  assert.match(run, /data-bar-stuck=\{barStuck \? "true" : undefined\}/);
});

/* 3. A :has() whose argument holds :disabled or :enabled. Chrome then looks for elements such a rule could affect every time ANY control is disabled or
      enabled, and an answer disables or enables every option, tick and toolbar button at once: locking the practice page's buttons took 255 ms instead
      of 129 with `.sh-seg:has(> .sh-seg__item.is-active:disabled) > .sh-seg__thumb` in the sheet. The thumb is told instead (data-muted). */
test('no :has() asks whether a control is disabled; the segmented control tells its thumb', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (/:has\([^{}]*:(disabled|enabled)/.test(readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, ''))) found.push(rel);
  }
  assert.deepEqual(found, []);
  assert.match(source('ui/components/components.css'), /\.sh-seg > \.sh-seg__thumb\[data-muted="true"\],/);
  // The control only knows its own props: one inside a disabled <fieldset> is passed the same condition, or its thumb keeps the accent over greyed text.
  assert.match(source('ui/board/CardEditor.jsx'), /<fieldset className="board-editor__fields" disabled=\{saving \|\| readOnly\}>/);
  assert.match(source('ui/board/CardEditor.jsx'), /<SegmentedControl size="sm" label=\{ui\('备注模式'\)\}[^>]* disabled=\{saving \|\| readOnly\}/);
  assert.match(source('ui/components/SegmentedControl.jsx'), /data-muted=\{activeIndex >= 0 && \(disabled \|\| options\[activeIndex\]\?\.disabled\) \? 'true' : undefined\}/);
});
