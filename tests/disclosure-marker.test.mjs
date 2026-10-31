import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cssFiles, parseTree, walkTree, splitSelectorList, walkFiles, toRel } from '../scripts/qa/css-tools.mjs';
import { ICON_PATHS } from '../ui/components/icon-paths.js';

// #572: every fold opens on the same marker, the registry's chevron turned a quarter when open. A plain <summary> gets it from one
// rule in ui/base.css; the Disclosure (ui/components/Panel.jsx) and the DisclosureToggle draw the same glyph as an Icon. The browser's
// triangle, a typed ▶ / ▸ and a marker drawn by a feature sheet are what used to sit beside it on the same page.
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const SHARED = 'ui/base.css';
// Typed markers a summary must not start with: the triangles, the guillemet-like carets and a plus beside the chevron (「▶ ＋ 挑题成文」).
const TYPED_MARKER = /^[\s ]*[▶▸►▷▹▾▼▿›»+＋]/u;

/** The full selectors of a rule, nesting resolved (`&` is the parent; a bare nested selector is a descendant of it). */
function fullSelectors(node, ancestors) {
  let sels = [''];
  for (const rule of [...ancestors, node].filter((n) => n.kind === 'rule')) {
    sels = sels.flatMap((parent) => splitSelectorList(rule.prelude).map((own) => (own.includes('&') ? own.replaceAll('&', parent || ':scope') : parent ? `${parent} ${own}` : own)));
  }
  return sels;
}

/** The part of a selector after the summary it targets, or null when the summary is not in the subject (a descendant of a summary is not it). */
function summaryTail(selector) {
  let last = null;
  for (const m of selector.matchAll(/(?<![\w.#-])summary(?![\w-])/g)) last = m.index + m[0].length;
  if (last === null) return null;
  const tail = selector.slice(last);
  let depth = 0;
  for (const ch of tail) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(ch)) return null;
  }
  return tail;
}

function summaryRules() {
  const out = [];
  for (const file of cssFiles()) {
    walkTree(parseTree(read(file)), (node, ancestors) => {
      if (node.kind !== 'rule') return;
      const tails = fullSelectors(node, ancestors).map(summaryTail).filter((tail) => tail !== null);
      if (tails.length) out.push({ file, node, tails });
    });
  }
  return out;
}

test('the shared rule hides the native triangle and draws the registry chevron, turned when open (#572)', () => {
  const css = read(SHARED);
  assert.match(css, /& summary \{[^}]*list-style: none;/, 'a summary has no list marker');
  assert.match(css, /& summary::-webkit-details-marker \{\s*display: none;/, 'WebKit draws its triangle on its own pseudo-element');
  const encoded = /--sh-chevron-mask: url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css)?.[1];
  assert.ok(encoded, 'the marker is a mask of an inline SVG');
  const path = /d='([^']+)'/.exec(decodeURIComponent(encoded))?.[1];
  assert.equal(path, ICON_PATHS.chevron, 'the mask is the icon registry\'s chevron, the glyph of the Disclosure\'s Icon');
  assert.equal(ICON_PATHS.caret, ICON_PATHS.chevron, 'the DisclosureToggle\'s caret is the same glyph');
  assert.match(read('ui/components/Panel.jsx'), /<Icon name="chevron"[^>]*className="sh-disclosure__chevron"/);
  assert.match(css, /& details\[open\] > summary::before \{\s*transform: rotate\(90deg\);/, 'open turns it a quarter, as the toggles do');
  assert.match(css, /transition: transform var\(--dur-fast\) var\(--ease\);/, 'the turn is the only thing that moves');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:where\(\.study-app, \.study-seat\) \{\s*& summary::before \{\s*transition: none;/, 'reduced motion turns it at once');
});

test('no stylesheet brings back the native marker or draws a marker of its own outside the shared rule (#572)', () => {
  const offenders = [];
  for (const { file, node, tails } of summaryRules()) {
    if (file === SHARED) continue;
    const where = `${file}:${node.line} ${node.prelude}`;
    if (tails.some((tail) => /::(?:-webkit-details-)?marker\b/.test(tail))) offenders.push(`${where}: styles the native marker`);
    for (const decl of node.decls) {
      if (decl.prop.startsWith('list-style')) offenders.push(`${where}: ${decl.prop} (the shared rule owns the list marker)`);
      if (decl.prop === 'display' && /list-item/.test(decl.value)) offenders.push(`${where}: display: list-item brings the triangle back`);
      if (decl.prop === 'content' && tails.some((tail) => /::(?:before|after)\b/.test(tail))) offenders.push(`${where}: a hand-drawn marker (content: ${decl.value})`);
    }
  }
  assert.deepEqual(offenders, [], 'a <summary> takes its chevron from ui/base.css; set --sh-summary-marker: none only where the markup draws the same chevron or the summary is a menu trigger');
});

test('the opt-out of the shared marker only ever hides it (#572)', () => {
  const offenders = [];
  for (const file of cssFiles()) {
    walkTree(parseTree(read(file)), (node) => {
      for (const decl of node.decls) if (decl.prop === '--sh-summary-marker' && decl.value !== 'none') offenders.push(`${file}:${decl.line} ${decl.value}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no summary starts with a typed triangle or a plus beside the chevron, in the source or in English (#572)', () => {
  const english = {};
  for (const file of walkFiles(join(ROOT, 'ui/locales'), ['.json']).map((abs) => toRel(abs)).filter((f) => /\/en[\w.-]*\.json$/.test(f))) Object.assign(english, JSON.parse(read(file)));
  const offenders = [];
  for (const file of walkFiles(join(ROOT, 'ui'), ['.jsx']).map((abs) => toRel(abs))) {
    const text = read(file);
    for (const m of text.matchAll(/<summary\b[^>]*>([\s\S]{0,160})/g)) {
      const body = m[1];
      const literal = /^\s*\{\s*ui(?:Format)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(body)?.[2];
      const shown = literal ?? body.replace(/^\s*/, '');
      if (TYPED_MARKER.test(shown) && !/^[\s]*[{<]/.test(shown)) offenders.push(`${file}: ${shown.slice(0, 40)}`);
      if (literal !== undefined && TYPED_MARKER.test(english[literal] ?? '')) offenders.push(`${file}: en "${english[literal]}"`);
    }
  }
  assert.deepEqual(offenders, [], 'the chevron is the marker: drop the typed glyph from the string and from ui/locales/en*.json');
});
