/* Surface details (owner decision 2026-10-06, docs/design/select-combobox.html section 6D): every floating surface, card and dialog gets the same three
   refinements, as tokens, with no blur, no glass and no cost:
   1. a 1px inner highlight on the top edge          (--edge-highlight, --edge-highlight-soft, --edge-highlight-paper)
   2. a tight contact shadow plus a far elevation    (--shadow-popover, --shadow-dialog, --shadow-item; --edge-shade is the contact ink)
   3. concentric radii: an item's corner is the surface's corner minus the padding between them and the border (--sh-inset)
   These tests pin the token set per theme, which surface uses which token, and that no sheet draws an ad-hoc elevation of its own. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, walk, parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const decls = (file) => parseCss(read(file)).declarations;
/** The declarations of one rule: `selector` must equal the rule's own selector (whitespace-collapsed), whatever wraps it. */
const rule = (file, selector) => decls(file).filter((d) => d.ctx.at(-1) === selector);
const value = (file, selector, prop) => rule(file, selector).find((d) => d.prop === prop)?.value;

/* ---- the token set, resolved per theme ---- */

const TOKEN_FILES = ['ui/tokens.css', 'ui/appearance-themes.css', 'ui/paper.css'];
const allDecls = TOKEN_FILES.flatMap(decls).filter((d) => d.prop.startsWith('--'));
/** Merge the custom properties of every block whose selector mentions all the attributes in `attrs` (a theme is a combination of attributes). */
function theme(attrs) {
  const scope = {};
  const matches = (selector) => {
    const parts = selector.split(',').map((s) => s.trim());
    return parts.some((part) => {
      if (/:is\(\.sh-paper/.test(part)) return false;
      const has = [...part.matchAll(/\[data-([\w-]+)=["']?([\w-]+)["']?\]/g)].map((m) => `${m[1]}=${m[2]}`);
      return has.every((a) => attrs.includes(a));
    });
  };
  // cascade order: base blocks first (no attribute), then attribute blocks by how many attributes they name
  const blocks = [];
  for (const d of allDecls) {
    const selector = d.ctx.at(-1) ?? '';
    if (selector.startsWith('@') || !/^\.study-(app|seat)/.test(selector)) continue;
    if (!matches(selector)) continue;
    const named = Math.max(...selector.split(',').map((s) => [...s.matchAll(/\[data-/g)].length));
    blocks.push({ named, d });
  }
  blocks.sort((a, b) => a.named - b.named);
  for (const { d } of blocks) scope[d.prop] = d.value;
  return scope;
}

const THEMES = {
  dark: ['theme=dark'],
  light: ['theme=light'],
  oled: ['theme=dark', 'palette=oled'],
  paper: ['theme=light', 'palette=paper'],
  'dark high contrast': ['theme=dark', 'contrast=high'],
  'light high contrast': ['theme=light', 'contrast=high'],
};
const EDGE = ['--edge-highlight', '--edge-highlight-soft', '--edge-highlight-paper', '--edge-shade'];
const COMPOSITE = ['--shadow-popover', '--shadow-dialog', '--shadow-item', '--shadow-panel'];

test('every theme resolves the edge tokens, and no theme leaves one empty', () => {
  for (const [name, attrs] of Object.entries(THEMES)) {
    const scope = theme(attrs);
    for (const token of EDGE) assert.ok(scope[token], `${name}: ${token} is defined`);
    for (const token of COMPOSITE) assert.ok(scope[token], `${name}: ${token} is defined`);
  }
});

test('light themes do not reuse the dark highlight and shade: a white line vanishes on white stock, so they are designed on their own', () => {
  const dark = theme(THEMES.dark), light = theme(THEMES.light);
  assert.notEqual(light['--edge-highlight'], dark['--edge-highlight']);
  assert.notEqual(light['--edge-highlight-soft'], dark['--edge-highlight-soft']);
  assert.notEqual(light['--edge-shade'], dark['--edge-shade']);
  assert.equal(theme(THEMES.paper)['--edge-shade'], light['--edge-shade'], 'the sepia palette keeps the light shade');
  assert.equal(theme(THEMES.oled)['--edge-shade'], dark['--edge-shade'], 'OLED keeps the dark shade');
});

test('the composite shadows are built from the edge tokens and the elevation steps, with no raw colour or blur of their own', () => {
  const tokens = Object.fromEntries(decls('ui/tokens.css').filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
  for (const token of COMPOSITE) {
    const v = tokens[token];
    assert.ok(v, `${token} is in ui/tokens.css`);
    assert.doesNotMatch(v, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${token} has no raw colour`);
    assert.match(v, /inset 0 1px 0 var\(--edge-highlight/, `${token} starts with the 1px top highlight`);
  }
  for (const token of ['--shadow-popover', '--shadow-dialog']) {
    assert.match(tokens[token], /0 0 0 1px var\(--edge-shade\)/, `${token}: the hairline ring`);
    assert.match(tokens[token], /0 1px 2px var\(--edge-shade\)|var\(--shadow-contact\)/, `${token}: the tight contact shadow`);
  }
  assert.match(tokens['--shadow-popover'], /var\(--shadow-md\)\s*$/, 'a popover lifts with the md step');
  assert.match(tokens['--shadow-dialog'], /var\(--shadow-lg\)\s*$/, 'a dialog lifts with the lg step');
  assert.match(tokens['--shadow-item'], /var\(--shadow-sm\)\s*$/);
  assert.match(tokens['--shadow-card'], /inset 0 1px 0 var\(--edge-highlight-paper\)/, 'the paper card has the top highlight too');
  assert.match(tokens['--shadow-card'], /var\(--paper-rule\)/, 'and keeps its rule ring');
});

test('--hairline is the 1px border a concentric radius subtracts, written once', () => {
  assert.equal(decls('ui/tokens.css').filter((d) => d.prop === '--hairline').map((d) => d.value).join(), '1px');
});

test('the Select / Combobox popup tokens are the names that surface references (fallback-free)', () => {
  const css = read('ui/tokens.css');
  for (const name of ['--shadow-popover', '--shadow-dialog', '--edge-highlight']) assert.match(css, new RegExp(`\\n\\s*${name}:`), name);
});

/* ---- which surface uses which token ---- */

const OVERLAYS = 'ui/components/overlays.css';
const COMPONENTS = 'ui/components/components.css';
const shadowOf = (file, selector) => decls(file).find((d) => d.prop === 'box-shadow' && d.ctx.at(-1) === selector)?.value;

test('popovers, tooltips, menus and the shared floating panels use --shadow-popover', () => {
  assert.equal(shadowOf(OVERLAYS, '.sh-popover'), 'var(--shadow-popover)');
  assert.equal(shadowOf(OVERLAYS, '.sh-menu'), 'var(--shadow-popover)');
  assert.equal(shadowOf(OVERLAYS, '.source-row-menu'), 'var(--shadow-popover)');
  assert.equal(shadowOf(OVERLAYS, ':is(.reader-popover__panel, .shortcut-sheet, .page-peek, .course-field__panel, .thumb-tray, .thumbs__error)'), 'var(--shadow-popover)');
  // the tooltip is a popover with another class, so it gets the shadow from .sh-popover; the top-layer variant must not unset it
  assert.match(read('ui/components/Tooltip.jsx'), /cx\('sh-popover', 'sh-tooltip'/);
  assert.equal(shadowOf('ui/components/tooltip-layer.css', '.sh-tooltip[popover]'), undefined, 'the top-layer tooltip keeps the popover shadow');
});

test('dialogs use --shadow-dialog, in both of their rules', () => {
  const found = decls(COMPONENTS).filter((d) => d.prop === 'box-shadow' && d.ctx.some((c) => /\.sh-dialog$/.test(c)) && d.ctx.at(-1).endsWith('.sh-dialog'));
  assert.equal(found.length, 2);
  for (const d of found) assert.equal(d.value, 'var(--shadow-dialog)');
});

test('a floating toast keeps its tone bar and takes the popover elevation', () => {
  assert.equal(shadowOf(COMPONENTS, '.sh-toast'), 'inset 3px 0 0 var(--sh-tone), var(--shadow-popover)');
});

test('the paper card keeps its contract (one shadow token, spelled in paper.css) and the card token carries the highlight', () => {
  assert.equal(shadowOf('ui/paper.css', '.sh-paper-card, .sh-panel.sh-paper-card, :where(.study-document-viewer[data-tone=\'paper\'] .reader-page, .study-reading[data-tone=\'paper\'])'), 'var(--shadow-card)');
});

test('desk panels and provider cards carry the soft top highlight (the accent tone inherits it); sunken and dashed panels stay flat', () => {
  assert.equal(shadowOf(COMPONENTS, '.sh-panel'), 'var(--shadow-panel)');
  for (const tone of ['.sh-panel--sunken', '.sh-panel--dashed']) assert.equal(shadowOf('ui/components/panel-tones.css', tone), 'none', tone);
  assert.equal(shadowOf('ui/components/fields.css', '.sh-provider'), 'var(--shadow-panel)');
});

test('feature floating surfaces use the elevation tokens', () => {
  const expect = {
    'ui/inbox.css': 'var(--shadow-dialog)',
    'ui/study-map/catalog.css': 'var(--shadow-dialog)',
    'ui/tour/tour.css': 'var(--shadow-dialog)',
    'ui/document-preview/reader/reader.css': 'var(--shadow-dialog)',
  };
  for (const [file, token] of Object.entries(expect)) assert.ok(decls(file).some((d) => d.prop === 'box-shadow' && d.value.startsWith(token)), `${file} uses ${token}`);
  for (const file of ['ui/draft.css', 'ui/document-preview/translation/translation.css', 'ui/coach.css'])
    assert.ok(decls(file).some((d) => d.prop === 'box-shadow' && /^var\(--shadow-(popover|item)\)$/.test(d.value)), `${file} uses a surface token`);
});

/* ---- no ad-hoc elevation anywhere ---- */

const UI_CSS = walk(join(ROOT, 'ui'), ['.css']).map((file) => relative(ROOT, file).split('\\').join('/'));
const TOKEN_SHEETS = new Set(['ui/tokens.css', 'ui/appearance-themes.css']);

test('no sheet writes an elevation step (--shadow-sm / md / lg) as its own box-shadow: surfaces use --shadow-popover, --shadow-dialog, --shadow-card, --shadow-item or --shadow-panel', () => {
  const hits = [];
  for (const file of UI_CSS) {
    if (TOKEN_SHEETS.has(file)) continue;
    for (const d of decls(file)) if (d.prop === 'box-shadow' && /var\(--shadow-(sm|md|lg)\)/.test(d.value)) hits.push(`${file}:${d.line} ${d.value}`);
  }
  assert.deepEqual(hits, [], `use the surface tokens (ui/tokens.css):\n${hits.join('\n')}`);
});

/** The blur radius of one shadow layer (`[inset] x y blur [spread] colour`), or 0. A layer that starts with a colour is not written that way here. */
const blurOf = (layer) => {
  const flat = layer.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '()').replace(/^\s*inset\s+/, '').trim();
  const lengths = flat.split(/\s+/).slice(0, 3);
  return lengths.length === 3 && lengths.every((t) => /^-?[\d.]+(px|vmax|em|rem)?$/.test(t)) ? Math.abs(parseFloat(lengths[2])) : 0;
};

test('no sheet draws a literal blurred drop shadow (0 0 0 rings, inset bars and the primary button glow are not surface elevation)', () => {
  const hits = [];
  for (const file of UI_CSS) {
    if (TOKEN_SHEETS.has(file)) continue;
    for (const d of decls(file)) {
      if (d.prop !== 'box-shadow') continue;
      for (const layer of d.value.split(/,(?![^(]*\))/)) if (blurOf(layer) > 0 && !/--accent-glow/.test(layer)) hits.push(`${file}:${d.line} ${layer.trim()}`);
    }
  }
  assert.deepEqual(hits, [], `a drop shadow is a token:\n${hits.join('\n')}`);
});

test('the blur reader understands the shapes it guards (fixtures)', () => {
  assert.equal(blurOf('0 0 0 3px var(--ok-halo)'), 0);
  assert.equal(blurOf('inset 3px 0 0 var(--accent)'), 0);
  assert.equal(blurOf('0 14px 34px -20px #000'), 34);
  assert.equal(blurOf('0 2px 10px color-mix(in srgb, #000 40%, transparent)'), 10);
  assert.equal(blurOf('var(--shadow-md)'), 0);
});

test('no new glass: still no backdrop-filter outside a dialog ::backdrop', () => {
  const hits = [];
  for (const file of UI_CSS) for (const d of decls(file)) if (d.prop === 'backdrop-filter' && !d.ctx.at(-1).includes('::backdrop')) hits.push(`${file}:${d.line}`);
  assert.deepEqual(hits, []);
});

/* ---- concentric radii ---- */

test('menu items are concentric with their menu: item corner = menu corner - inset - border (--hairline)', () => {
  assert.equal(value(OVERLAYS, '.sh-menu', 'border-radius'), 'var(--radius)');
  assert.equal(value(OVERLAYS, '.sh-menu', '--sh-inset'), 'var(--space-1)');
  assert.equal(value(OVERLAYS, '.sh-menu', 'padding'), 'var(--sh-inset)');
  const item = decls(OVERLAYS).find((d) => d.prop === 'border-radius' && d.ctx.at(-1).startsWith('.sh-menu__item'));
  assert.equal(item.value, 'calc(var(--radius) - var(--sh-inset) - var(--hairline))');
});

test('the segmented control thumb and items are concentric with the track', () => {
  const track = value(COMPONENTS, '.sh-seg', 'border-radius');
  assert.equal(track, 'calc(var(--radius-sm) + var(--radius-xs))');
  const inner = 'calc(var(--radius-sm) + var(--radius-xs) - var(--space-1) - var(--hairline))';
  assert.equal(value(COMPONENTS, '.sh-seg__thumb', 'border-radius'), inner);
  assert.equal(value(COMPONENTS, '.sh-seg__item', 'border-radius'), inner);
});

test('this work never moves layout: the shared surfaces keep their padding and size declarations', () => {
  // padding is spelled through --sh-inset where the radius needs it, and that is still the old --space-1
  assert.equal(value(OVERLAYS, '.sh-popover', 'padding'), 'var(--space-3)');
  assert.equal(value(OVERLAYS, '.source-row-menu', 'padding'), 'var(--space-1)');
});
