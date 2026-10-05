import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanUi, readBaseline, diffMetrics, describe as describeDrift, mergeLowered, parseCss, RULES, BASELINE_FILE, ROOT,
} from '../scripts/qa/guardrail-baseline.mjs';

// UI consistency guard rails (tracker #161). Per-file ratchets may only fall; the hard rules
// have no baseline. Regenerate the baseline with `node scripts/qa/guardrail-baseline.mjs --update`.
const started = performance.now(), cpuStarted = process.cpuUsage();
const scan = scanUi();
const scanMs = Math.round(performance.now() - started);
// The work done by the scan, not the time it waited for a core: a full test run shares the machine with dozens of other processes.
const scanCpu = process.cpuUsage(cpuStarted), scanCpuMs = Math.round((scanCpu.user + scanCpu.system) / 1000);
const baseline = readBaseline();
const UPDATE = 'Fix the new value, or lower-only update: node scripts/qa/guardrail-baseline.mjs --update';

test('the ratchet baseline exists and covers every rule', () => {
  assert.ok(Object.keys(baseline).length, `${BASELINE_FILE} is missing: run node scripts/qa/guardrail-baseline.mjs --update --allow-increase`);
  for (const rule of Object.keys(RULES)) assert.ok(baseline[rule], `baseline has no "${rule}" section`);
});

for (const rule of Object.keys(RULES)) {
  test(`ratchet ${rule}: no file gets worse (${RULES[rule].issue})`, (t) => {
    const { regressions, gains } = diffMetrics({ [rule]: scan.metrics[rule] }, { [rule]: baseline[rule] || {} });
    assert.deepEqual(regressions.map(describeDrift), [], `\n${RULES[rule].why} increased. ${UPDATE}\n`);
    if (gains.length) t.diagnostic(`${gains.length} file(s) improved on "${rule}"; run guardrail-baseline.mjs --update to lock the gain in`);
  });
}

test('no !important outside CodeMirror overrides, reduced-motion and forced-colors blocks (#136)', () => {
  assert.deepEqual(scan.metrics.important, {}, 'fix the cascade (layer, specificity, a Button variant) instead of forcing the value; the allow-list is isAllowedImportant in scripts/qa/guardrail-baseline.mjs');
});

test('no raw colour outside the theme token files and no CSS line over 400 characters (#156)', () => {
  assert.deepEqual(scan.metrics.rawColor, {}, 'use a colour token or color-mix() of tokens; a PDF page is var(--pdf-page), a quote highlight var(--warn-mark)');
  assert.deepEqual(scan.metrics.longLine, {}, 'format the stylesheet, one declaration per line');
});

test('no raw px font size, numeric font weight, px radius or 999px pill in a stylesheet, font shorthand included (#147 #148)', () => {
  for (const rule of ['fontSizePx', 'fontWeightNumeric', 'radiusPx', 'radius999']) assert.deepEqual(scan.metrics[rule], {}, `${rule}: ${RULES[rule].fix}`);
});

test('keyframe names are unique across ui/**/*.css (#102)', () => {
  assert.deepEqual(scan.duplicateKeyframes, [], 'two @keyframes share a name, so whichever stylesheet is injected last silently wins; give each an sh- prefixed unique name');
});

test('no CJK text in CSS content: strings (#160)', () => {
  assert.deepEqual(scan.cjkContent.map((hit) => `${hit.file}:${hit.line} ${hit.selector} -> ${hit.value}`), [],
    'CSS-generated text cannot be translated; render ui(\'...\') in JSX instead (existing exception: see ALLOW.cjkContent)');
});

test('no window.confirm / alert / prompt in ui (#67)', () => {
  assert.deepEqual(scan.dialogCalls.map((hit) => `${hit.file}:${hit.line} ${hit.call}`), [],
    'host webviews can block native dialogs; use the in-app Dialog / InlineMessage confirmation (existing exception: see ALLOW.dialogCalls)');
});

test('every var(--x) used in ui CSS is defined (#96)', () => {
  assert.deepEqual(scan.undefinedVars.map((v) => `${v.name} first used at ${v.site}`), [],
    'define the token (ui/tokens.css or ui/components/components.css) or fix the name; host-provided variables go in ALLOW.undefinedVars with a reason');
});

test('allow-list entries that no longer match anything are removed', () => {
  assert.deepEqual(scan.staleAllow, [], 'delete the stale entry from ALLOW in scripts/qa/guardrail-baseline.mjs');
});

test('the scan stays fast', (t) => {
  t.diagnostic(`ui scan took ${scanMs} ms (${scanCpuMs} ms of CPU)`);
  assert.ok(scanCpuMs < 5000, `scan used ${scanCpuMs} ms of CPU`);
  assert.ok(scanMs < 120_000, `scan took ${scanMs} ms: it is not merely slow, it is stuck`); // a loose wall-clock bound, a hang guard only
});

test('the CSS reader handles comments, nesting, CRLF, strings and data urls', () => {
  const css = '/* a { color: #fff; } */\r\n.a {\r\n  color: red; /* c */\r\n  &:hover { color: #abc }\r\n  background: url("data:image/svg+xml;base64,AAA") no-repeat;\r\n}\r\n@media (prefers-reduced-motion: reduce) {\r\n  .b { transition: none !important; content: "展开; {" }\r\n}\r\n@keyframes spin { to { transform: rotate(1turn) } }\r\n';
  const { declarations, blocks } = parseCss(css);
  const find = (prop) => declarations.filter((d) => d.prop === prop);
  assert.equal(find('color').length, 2, 'commented-out rule is ignored, nested rule is read');
  assert.equal(find('color')[1].value, '#abc');
  assert.match(find('background')[0].value, /base64,AAA/);
  assert.equal(find('transition')[0].important, true);
  assert.match(find('transition')[0].ctx.join('|'), /prefers-reduced-motion/);
  assert.equal(find('content')[0].value, '"展开; {"');
  assert.equal(find('color')[0].line, 3);
  assert.deepEqual(blocks.filter((b) => b.prelude.startsWith('@keyframes')).map((b) => b.prelude), ['@keyframes spin']);
});

test('the updater only lowers counts and notices new files', () => {
  const base = { rawButton: { 'ui/a.jsx': 5, 'ui/b.jsx': 2 } };
  const now = { rawButton: { 'ui/a.jsx': 3, 'ui/b.jsx': 4, 'ui/c.jsx': 1 } };
  const { regressions } = diffMetrics(now, base);
  assert.deepEqual(regressions.map((r) => `${r.file} ${r.was}->${r.now}`), ['ui/b.jsx 2->4', 'ui/c.jsx 0->1']);
  assert.deepEqual(mergeLowered({ rawButton: { 'ui/a.jsx': 3, 'ui/b.jsx': 1 } }, base).rawButton, { 'ui/a.jsx': 3, 'ui/b.jsx': 1 });
});

test('a synthetic tree trips every rule (the guard rails can fail)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-guardrails-'));
  try {
    mkdirSync(join(root, 'ui', 'components'), { recursive: true });
    writeFileSync(join(root, 'ui', 'bad.css'), [
      '.root { --fs-md: 15px; --radius-card: 16px; --fw-strong: 650; --fs-xs: 12px; }',
      '.a { font-size: 15px; font-weight: 600; border-radius: 6px; z-index: 50; color: #abcdef; margin: 0 8px; }',
      '.b { border-radius: 999px; background: rgb(1 2 3); padding: 0; transition: none !important; }',
      '.c::after { content: "展开"; color: var(--nope); }',
      '.d { mask-image: linear-gradient(#000, transparent); font-size: var(--fs-md); z-index: 2; }',
      '.k { font: 600 12px/1 ui-monospace, monospace; } .l { font: var(--fw-strong) var(--fs-xs)/1 ui-monospace; } .m { font: inherit; }',
      '.i { border-radius: var(--radius-card); } .j { border-radius: 0 0 var(--radius-card) var(--radius-card); }',
      '.e button, .e > label small { position: relative; }', '.f .sh-btn, .g [type="checkbox"], .h:not(button) { position: relative; }',
      '@keyframes spin { to { opacity: 1 } }', '',
    ].join('\r\n'));
    writeFileSync(join(root, 'ui', 'other.css'), '@keyframes spin { to { opacity: 0 } }\n@media (prefers-reduced-motion: reduce) { .x { animation: none !important } }\n');
    writeFileSync(join(root, 'ui', 'Bad.jsx'), [
      'export const A = () => <div><button className={`row ${on ? "primary" : ""}`}>x</button><span className="pill">y</span>',
      '<button className="link-btn">×</button><i>  ▸ </i><b>text</b></div>;',
      'const pick = () => <label><input type="checkbox" checked /><input type="radio" /><input type="range" /></label>;',
      'const save = () => <div><Button onClick={go}>{saving ? ui("保存中…") : ui("保存")}</Button><Button busy={saving} busyLabel={ui("保存中…")}>{ui("保存")}</Button></div>;',
      'const tip = () => <div><span title="what this means">12</span><Button title="Open">x</Button><input title="t" /></div>;',
      'const go = () => window.confirm("sure?");',
      'const handoff = () => <div><Child call={call} busy={busy} /><Button busy={busy}>ok</Button></div>;', '',
    ].join('\n'));
    writeFileSync(join(root, 'ui', 'components', 'Ok.jsx'), 'export const B = () => <button className="primary">z</button>;\n');
    const found = scanUi(root);
    const total = (rule) => Object.values(found.metrics[rule]).reduce((a, b) => a + b, 0);
    assert.deepEqual(Object.fromEntries(Object.keys(RULES).map((rule) => [rule, total(rule)])), {
      rawButton: 2, legacyButtonClass: 3, glyphIcon: 2, fontSizePx: 2, fontWeightNumeric: 2, radiusPx: 1, radius999: 1,
      zIndexNumeric: 1, important: 1, rawColor: 2, spacingPx: 1, longLine: 0, serviceHandoff: 2, elementSelector: 1, rawChoiceInput: 2, radiusCard: 2, busyLabelSwap: 1, hostTitle: 1,
    });
    assert.deepEqual(found.duplicateKeyframes.map((k) => k.name), ['spin']);
    assert.equal(found.cjkContent.length, 1);
    assert.equal(found.dialogCalls.length, 1);
    assert.deepEqual(found.undefinedVars.map((v) => v.name), ['--nope']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Semantic tokens (tokens.css, on the app root and the seat so every theme derives them) ──
const tokenSheet = parseCss(readFileSync(new URL('../ui/tokens.css', import.meta.url), 'utf8'));
const tokenDecls = tokenSheet.declarations.filter((d) => d.prop.startsWith('--') && d.ctx.length === 2 && d.ctx[1] === '.study-app, .study-seat');
const tokens = Object.fromEntries(tokenDecls.map((d) => [d.prop, d.value]));

test('tone tokens use the component library formulas', () => {
  for (const tone of ['ok', 'warn', 'bad', 'info']) {
    assert.equal(tokens[`--${tone}-ink`], `color-mix(in srgb, var(--${tone}) 82%, var(--text))`, `--${tone}-ink`);
    assert.equal(tokens[`--${tone}-bg`], `color-mix(in srgb, var(--${tone}) 8%, var(--bg-surface))`, `--${tone}-bg`);
    assert.equal(tokens[`--${tone}-line`], `color-mix(in srgb, var(--${tone}) 30%, var(--line))`, `--${tone}-line`);
  }
});

test('--warn-text aliases --warn-ink so the reader and token-usage warnings render (#96)', () => {
  assert.equal(tokens['--warn-text'], 'var(--warn-ink)');
  for (const file of ['ui/token-usage.css']) {
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /var\(--warn-text/, `${file} still reads --warn-text`);
  }
});

test('layer, scrim, weight, radius and duration tokens are defined (#76 #147 #148)', () => {
  const expected = {
    '--z-raised': '1', '--z-sticky': '10', '--z-toast': '11', '--z-popover': '30', '--z-overlay': '40', '--z-tour': '80', '--z-fullscreen': '90',
    '--fw-light': '300', '--fw-regular': '400', '--fw-medium': '550', '--fw-strong': '650',
    '--radius-xs': '4px', '--dur-fast': '.15s', '--dur': '.2s', '--dur-slow': '.3s',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(tokens[name], value, name);
  const layers = ['raised', 'sticky', 'toast', 'popover', 'overlay', 'tour', 'fullscreen'].map((name) => Number(tokens[`--z-${name}`]));
  assert.deepEqual([...layers].sort((a, b) => a - b), layers, 'layers grow with the scale');
  for (const name of ['--scrim', '--scrim-strong']) {
    assert.match(tokens[name], /^color-mix\(in srgb, .*var\(--(bg-sunken|bg-canvas|text)\)/, `${name} derives from theme tokens`);
    assert.doesNotMatch(tokens[name], /#[0-9a-f]{3,8}\b|rgba?\(/i, `${name} has no raw colour`);
  }
});

test('the coach skeleton keyframes are renamed and still used (#102)', () => {
  const coach = readFileSync(new URL('../ui/coach.css', import.meta.url), 'utf8');
  assert.doesNotMatch(coach, /@keyframes shimmer\b/);
  assert.match(coach, /@keyframes sh-[\w-]*shimmer\b/);
  const name = coach.match(/@keyframes (sh-[\w-]*shimmer)\b/)[1];
  assert.match(coach, new RegExp(`animation:\\s*${name}\\b`));
});

test('tokens are documented in DESIGN.md', () => {
  const design = readFileSync(new URL('../ui/DESIGN.md', import.meta.url), 'utf8');
  for (const name of ['--ok-ink', '--warn-line', '--bad-bg', '--info-ink', '--warn-text', '--z-popover', '--z-fullscreen', '--scrim-strong', '--fw-medium', '--radius-xs', '--dur-slow']) {
    assert.ok(design.includes(name), `DESIGN.md does not mention ${name}`);
  }
  assert.ok(ROOT);
});
