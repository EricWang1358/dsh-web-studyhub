/* UI guard-rail scanner and baseline updater (ui-consistency wave 1, tracker #161).
   tests/ui-guardrails.test.mjs imports `scanUi`; this file is also a CLI:
     node scripts/qa/guardrail-baseline.mjs                    show the diff against the baseline
     node scripts/qa/guardrail-baseline.mjs --update           lower counts in the baseline (refuses increases)
     node scripts/qa/guardrail-baseline.mjs --update --allow-increase   also accept increases (coordinator at integration)
   The baseline lives in tests/fixtures/ui-guardrail-baseline.json. */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BASELINE_FILE = join(ROOT, 'tests/fixtures/ui-guardrail-baseline.json');

/* Per-file ratchets: each count may only fall. `why` is shown when one rises. */
export const RULES = {
  rawButton: { issue: '#135', why: 'raw <button> outside ui/components', fix: 'use <Button> or <IconButton> from ui/components' },
  legacyButtonClass: { issue: '#135', why: 'legacy button class (primary|link-btn|ghost-btn|pill|danger-text|wf-danger) in a className', fix: 'use <Button variant="primary|quiet|link|danger">' },
  glyphIcon: { issue: '#145', why: 'JSX text node that is a single icon glyph', fix: 'use <Icon name=...> (or <IconButton>) from ui/components' },
  fontSizePx: { issue: '#147', why: 'raw px font-size', fix: 'use var(--fs-xs|sm|md|lg|xl|2xl|3xl)' },
  fontWeightNumeric: { issue: '#147', why: 'numeric font-weight', fix: 'use var(--fw-light|regular|medium|strong)' },
  radiusPx: { issue: '#148', why: 'raw px border-radius', fix: 'use var(--radius-xs|sm|radius|radius-card|radius-pill) or 50%' },
  radius999: { issue: '#148', why: 'border-radius: 999px', fix: 'use var(--radius-pill)' },
  zIndexNumeric: { issue: '#76', why: 'numeric z-index above 2', fix: 'use var(--z-raised|sticky|toast|popover|overlay|tour|fullscreen)' },
  important: { issue: '#136', why: '!important outside the allow-list', fix: 'raise specificity or fix the cascade instead (allow-list: CodeMirror overrides in blog-notes.css, reduced-motion blocks)' },
  rawColor: { issue: '#156', why: 'raw #hex / rgb() / hsl() outside token definitions', fix: 'use a colour token or color-mix() of tokens (only #000 inside mask-image is allowed)' },
  spacingPx: { issue: '#148', why: 'raw px padding/margin/gap', fix: 'use var(--space-*)' },
  longLine: { issue: '#156', why: 'CSS line longer than 400 characters (minified)', fix: 'format the stylesheet (one declaration per line)' },
};

/* Hard rules: allow-listed exceptions live here with the issue that removes them. */
export const ALLOW = {
  /* ui/Manage.jsx is blocked in wave 1; the migration to a ConfirmDialog removes this entry. */
  dialogCalls: [{ file: 'ui/Manage.jsx', issue: '#67' }],
  /* No exceptions: CSS-generated text cannot be translated (the follow-up fold label is rendered in JSX, #160). */
  cjkContent: [],
  /* Custom properties that no ui CSS or JS defines because the host or the runtime provides them. */
  undefinedVars: [
    /* Provided by the DSH host shell, never by StudyHub CSS (each use has a fallback). */
    { name: '--dsh-windows-titlebar-height', reason: 'host-provided' },
    { name: '--dsh-composer-height', reason: 'host-provided' },
    { name: '--dsh-frame-top-clearance', reason: 'host-provided' },
    /* Optional overrides: the default sits in the var() fallback on purpose. */
    { name: '--sh-toast-offset', reason: 'optional override set by a host page' },
    { name: '--dur-leave', reason: 'optional override, ui/quick-actions.css fallback is the default' },
    /* Stale token names that never existed. Each is a latent bug; replace the use, then delete the entry. */
    { name: '--bg', reason: 'use --bg-surface (large-documents.css, mineru.css)' },
    { name: '--font-mono', reason: 'no mono token exists (mineru.css fallback is used)' },
    { name: '--danger', reason: 'use --bad (style.css:561, blocked in wave 1)' },
    { name: '--radius-md', reason: 'use --radius (token-usage.css)' },
    { name: '--fs-15', reason: 'use --fs-md (workflow-scope.css)' },
  ],
};

const ICON_GLYPHS = '×✕−＋↑↓▸▾▶‹›✓♫✧♧◌';
const LEGACY_BUTTON = /(?<![\w-])(primary|link-btn|ghost-btn|pill|danger-text|wf-danger)(?![\w-])/g;
const CJK = /[　-鿿＀-￯]/;

const toRel = (file) => relative(ROOT, file).split(sep).join('/');

export function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

/* Replace comment text with spaces, keeping newlines so line numbers stay true. */
export const stripCssComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '));
export const stripJsComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '))
  .replace(/(^|[^:\\'"`])\/\/[^\n\r]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));

/* Minimal CSS reader: walks braces, strings and parentheses and returns every
   declaration with the chain of enclosing preludes, plus the at-rule preludes. */
export function parseCss(source) {
  const text = stripCssComments(source);
  const declarations = [], blocks = [], stack = [];
  let cur = '', curLine = 1, line = 1, paren = 0, quote = '';
  const emit = () => {
    const raw = cur.trim();
    cur = '';
    if (!raw) return;
    const colon = raw.indexOf(':');
    if (colon < 1) return;
    const prop = raw.slice(0, colon).trim().toLowerCase();
    let value = raw.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    declarations.push({ prop, value, important, line: curLine, ctx: stack.map((s) => s.prelude) });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += text[++i] ?? ''; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { if (!cur.trim()) curLine = line; quote = ch; cur += ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren === 0 && ch === '{') {
      const prelude = cur.trim().replace(/\s+/g, ' ');
      stack.push({ prelude, line: curLine });
      if (prelude.startsWith('@')) blocks.push({ prelude, line: curLine, ctx: stack.slice(0, -1).map((s) => s.prelude) });
      cur = '';
      continue;
    }
    if (paren === 0 && ch === ';') { emit(); continue; }
    if (paren === 0 && ch === '}') { emit(); stack.pop(); continue; }
    if (!cur.trim() && !/\s/.test(ch)) curLine = line;
    cur += ch;
  }
  return { declarations, blocks };
}

const stripUrlAndStrings = (value) => value.replace(/url\([^)]*\)/gi, 'url()').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
const PX = /(?<![\w.-])-?\d*\.?\d+px\b/g;
const nonZeroPx = (value) => (stripUrlAndStrings(value).match(PX) || []).filter((m) => parseFloat(m) !== 0);

function isAllowedImportant(file, decl) {
  const ctx = decl.ctx.join(' | ');
  if (/prefers-reduced-motion/.test(ctx) || /data-motion/.test(ctx) || /forced-colors/.test(ctx)) return true;
  return file === 'ui/blog-notes.css' && /\.cm-|CodeMirror/.test(ctx);
}

/** The theme files: their custom properties are the palette itself (base tokens, accent presets, high-contrast / OLED / paper themes). */
const TOKEN_FILES = new Set(['ui/style.css', 'ui/accent.css', 'ui/appearance-themes.css']);

function isTokenDefinition(file, decl) {
  return TOKEN_FILES.has(file) && decl.prop.startsWith('--');
}

function scanCssFile(file, source, metrics, found) {
  const bump = (name, n = 1) => { if (n) (metrics[name][file] = (metrics[name][file] || 0) + n); };
  const { declarations, blocks } = parseCss(source);
  for (const decl of declarations) {
    const { prop, value } = decl;
    if (prop.startsWith('--')) {
      (found.defined ||= new Set()).add(prop);
    }
    if (decl.important && !isAllowedImportant(file, decl)) bump('important');
    if (prop === 'font-size' && nonZeroPx(value).length) bump('fontSizePx');
    if (prop === 'font-weight' && /^\d{3}$/.test(value)) bump('fontWeightNumeric');
    if (prop === 'border-radius') {
      if (/(?<![\w.-])9{3,}px\b/.test(value)) bump('radius999');
      else if (nonZeroPx(value).length) bump('radiusPx');
    }
    if (prop === 'z-index' && /^\d+$/.test(value) && Number(value) > 2) bump('zIndexNumeric');
    if (/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(prop) && nonZeroPx(value).length) bump('spacingPx');
    if (!isTokenDefinition(file, decl)) {
      let probe = stripUrlAndStrings(value);
      if (/^(-webkit-)?mask(-image)?$/.test(prop)) probe = probe.replace(/#000(000)?\b/g, '');
      const hits = (probe.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length + (probe.match(/\b(rgba?|hsla?)\(/gi) || []).length;
      bump('rawColor', hits);
    }
    if (prop === 'content' && CJK.test(value)) {
      const selector = decl.ctx[decl.ctx.length - 1] || '';
      found.cjk.push({ file, line: decl.line, selector, value });
    }
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) found.used.push({ name: m[1], file, line: decl.line });
  }
  for (const block of blocks) {
    const m = block.prelude.match(/^@(?:-webkit-|-moz-)?keyframes\s+([\w-]+)/);
    if (m) found.keyframes.push({ name: m[1], file, line: block.line });
  }
  source.split(/\r?\n/).forEach((text) => { if (text.length > 400) bump('longLine'); });
}

/* Extract the source text of every attribute expression after `className=`. */
function classNameStrings(source) {
  const out = [];
  const re = /className\s*=\s*/g;
  while (re.exec(source)) {
    const i = re.lastIndex;
    const first = source[i];
    let body = '';
    if (first === '"' || first === "'") {
      const end = source.indexOf(first, i + 1);
      body = source.slice(i + 1, end < 0 ? i + 1 : end);
      out.push(body);
    } else if (first === '{') {
      let depth = 0, j = i, quote = '';
      for (; j < source.length; j++) {
        const c = source[j];
        if (quote) { if (c === '\\') j++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      body = source.slice(i + 1, j);
      for (const s of body.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g)) out.push(s[1] ?? s[2] ?? s[3] ?? '');
    }
  }
  return out;
}

function scanJsxFile(file, source, metrics, found) {
  const bump = (name, n = 1) => { if (n) (metrics[name][file] = (metrics[name][file] || 0) + n); };
  const text = stripJsComments(source);
  if (!file.startsWith('ui/components/')) {
    bump('rawButton', (text.match(/<button(?![\w-])/g) || []).length);
    let legacy = 0;
    for (const body of classNameStrings(text)) legacy += (body.match(LEGACY_BUTTON) || []).length;
    bump('legacyButtonClass', legacy);
  }
  const glyph = new RegExp(`>\\s*(?:[${ICON_GLYPHS}]|\\{\\s*['"\`][${ICON_GLYPHS}]['"\`]\\s*\\})\\s*<`, 'g');
  bump('glyphIcon', (text.match(glyph) || []).length);
}

function scanJsFile(file, source, found) {
  const text = stripJsComments(source);
  const call = /(?<![\w$.])(window\.|globalThis\.)?(confirm|alert|prompt)\s*\(/g;
  /* A function the file declares itself (RemoveDialog's confirm()) is not the browser dialog. */
  const local = new Set([...text.matchAll(/\b(?:function\s+|(?:const|let|var)\s+)(confirm|alert|prompt)\b/g)].map((d) => d[1]));
  let m;
  while ((m = call.exec(text))) {
    if (!m[1] && local.has(m[2])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    found.dialogs.push({ file, line, call: m[0].trim() });
  }
  for (const d of source.matchAll(/(--[\w-]+)\s*['"`]?\s*:/g)) (found.defined ||= new Set()).add(d[1]);
  for (const d of source.matchAll(/['"`](--[\w-]+)['"`]/g)) (found.defined ||= new Set()).add(d[1]);
}

/* Scan ui/**: returns the ratchet counts and the hard-rule violations. */
export function scanUi(root = ROOT) {
  const metrics = Object.fromEntries(Object.keys(RULES).map((name) => [name, {}]));
  const found = { keyframes: [], cjk: [], dialogs: [], used: [], defined: new Set() };
  const ui = join(root, 'ui');
  for (const abs of walk(ui, ['.css', '.js', '.jsx']).sort()) {
    const file = relative(root, abs).split(sep).join('/');
    const source = readFileSync(abs, 'utf8');
    if (file.endsWith('.css')) scanCssFile(file, source, metrics, found);
    else {
      if (file.endsWith('.jsx')) scanJsxFile(file, source, metrics, found);
      scanJsFile(file, source, found);
    }
  }
  const byName = new Map();
  for (const k of found.keyframes) byName.set(k.name, [...(byName.get(k.name) || []), k]);
  const duplicateKeyframes = [...byName].filter(([, list]) => list.length > 1).map(([name, list]) => ({ name, sites: list.map((k) => `${k.file}:${k.line}`) }));
  const cjkContent = found.cjk.filter((hit) => !ALLOW.cjkContent.some((a) => a.file === hit.file && hit.selector.includes(a.selector)));
  const dialogCalls = found.dialogs.filter((hit) => !ALLOW.dialogCalls.some((a) => a.file === hit.file));
  const allowedVars = new Set(ALLOW.undefinedVars.map((a) => a.name));
  const undefinedVars = [];
  const seen = new Set();
  for (const use of found.used) {
    if (found.defined.has(use.name) || allowedVars.has(use.name) || seen.has(use.name)) continue;
    seen.add(use.name);
    undefinedVars.push({ name: use.name, site: `${use.file}:${use.line}` });
  }
  for (const rule of Object.values(metrics)) for (const file of Object.keys(rule)) if (!rule[file]) delete rule[file];
  /* An allow-list entry that no longer matches anything must be deleted so the rule stays tight. */
  const usedNames = new Set(found.used.map((use) => use.name));
  const staleAllow = [
    ...ALLOW.dialogCalls.filter((a) => !found.dialogs.some((hit) => hit.file === a.file)).map((a) => `dialogCalls ${a.file} (${a.issue})`),
    ...ALLOW.cjkContent.filter((a) => !found.cjk.some((hit) => hit.file === a.file && hit.selector.includes(a.selector))).map((a) => `cjkContent ${a.file} ${a.selector} (${a.issue})`),
    ...ALLOW.undefinedVars.filter((a) => found.defined.has(a.name) || !usedNames.has(a.name)).map((a) => `undefinedVars ${a.name}`),
  ];
  return { metrics, duplicateKeyframes, cjkContent, dialogCalls, undefinedVars, staleAllow };
}

export function readBaseline() {
  return existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).metrics : {};
}

/* Compare current counts with a baseline: lists regressions (up) and gains (down). */
export function diffMetrics(current, baseline) {
  const regressions = [], gains = [];
  for (const rule of Object.keys(RULES)) {
    const now = current[rule] || {}, was = baseline[rule] || {};
    for (const file of new Set([...Object.keys(now), ...Object.keys(was)])) {
      const a = now[file] || 0, b = was[file] || 0;
      if (a > b) regressions.push({ rule, file, was: b, now: a });
      else if (a < b) gains.push({ rule, file, was: b, now: a });
    }
  }
  return { regressions, gains };
}

export const describe = ({ rule, file, was, now }) => `  ${rule.padEnd(18)} ${file}  ${was} -> ${now}  (${RULES[rule].issue}: ${RULES[rule].why}; fix: ${RULES[rule].fix})`;

function sortedMetrics(metrics) {
  return Object.fromEntries(Object.keys(RULES).map((rule) => [rule,
    Object.fromEntries(Object.keys(metrics[rule] || {}).sort().map((file) => [file, metrics[rule][file]]))]));
}

export function writeBaseline(metrics) {
  const payload = {
    note: 'Per-file counts may only fall. Regenerate with node scripts/qa/guardrail-baseline.mjs --update (lowers only; --allow-increase for the coordinator).',
    metrics: sortedMetrics(metrics),
  };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const { metrics } = scanUi();
  const baseline = readBaseline();
  const { regressions, gains } = diffMetrics(metrics, baseline);
  const totals = Object.keys(RULES).map((rule) => `${rule}=${Object.values(metrics[rule]).reduce((a, b) => a + b, 0)}`).join(' ');
  console.log(`current totals: ${totals}`);
  if (regressions.length) console.log(`\nIncreases vs baseline (${regressions.length}):\n${regressions.map(describe).join('\n')}`);
  if (gains.length) console.log(`\nDecreases vs baseline (${gains.length}):\n${gains.map(describe).join('\n')}`);
  if (!regressions.length && !gains.length) console.log('Baseline matches the tree.');
  if (!args.has('--update')) { process.exitCode = regressions.length ? 1 : 0; return; }
  if (regressions.length && !args.has('--allow-increase')) {
    console.error('\nRefusing to update: counts went up. Fix the new raw values, or pass --allow-increase (coordinator only).');
    process.exitCode = 1;
    return;
  }
  const next = args.has('--allow-increase') ? metrics : mergeLowered(metrics, baseline);
  writeBaseline(next);
  console.log(`\nBaseline written: ${toRel(BASELINE_FILE)}`);
}

/* Keep each baseline count unless the tree now has fewer; files absent from the baseline stay absent. */
export function mergeLowered(current, baseline) {
  const out = {};
  for (const rule of Object.keys(RULES)) {
    out[rule] = {};
    for (const file of Object.keys(current[rule] || {})) {
      const was = (baseline[rule] || {})[file];
      out[rule][file] = was === undefined ? current[rule][file] : Math.min(was, current[rule][file]);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
