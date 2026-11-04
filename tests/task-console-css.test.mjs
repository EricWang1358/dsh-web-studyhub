import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

/* The 任务 console's look, read from its stylesheet (the browser walk is tests/task-console-browser.test.mjs):
   #659 numbers are tabular figures of the interface face, only the model's own output and the log are monospace;
   #658 a picked job is the neutral selected surface, never an accent edge;
   #680 at a narrow width the filters stay on one line (they scroll) and the metrics are a short list, not a grid of empty tiles. */
const css = readFileSync(new URL('../ui/tasks/task-console.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { declarations } = parseCss(css);
const selectorOf = (decl) => decl.ctx[decl.ctx.length - 1] || '';
const decls = (prop) => declarations.filter((d) => d.prop === prop);

test('the console draws its numbers in the interface face; only the live output and the log are monospace (#659)', () => {
  const mono = decls('font-family').filter((d) => /font-stack-mono/.test(d.value)).map(selectorOf);
  assert.deepEqual(mono.sort(), ['.tc-line__block', '.tc-log__body', '.tc-output__body'], 'a metric, a percent, a tick of the timeline, a count or a stepper value is not monospace');
  for (const selector of ['.tc-num', '.tc-metric__v', '.tc-metric__pct', '.tc-axis', '.tc-figures__cell dd', '.tc-stepper__value']) {
    const rule = declarations.filter((d) => selectorOf(d) === selector);
    assert.ok(rule.some((d) => d.prop === 'font-family' && /var\(--font-ui\)/.test(d.value)), `${selector} sets the interface face`);
    assert.ok(rule.some((d) => d.prop === 'font-variant-numeric' && /tabular-nums/.test(d.value)), `${selector} keeps the digits tabular`);
  }
});

test('a picked or running row is the neutral selected surface with a neutral edge, not an accent edge (#658)', () => {
  const edges = declarations.filter((d) => d.prop === 'box-shadow' && /\binset\b/.test(d.value) && !/:focus/.test(selectorOf(d)));
  assert.ok(edges.length >= 4, 'the picked list row, call row, round and the ticked row keep an edge');
  for (const edge of edges) assert.doesNotMatch(edge.value, /--accent/, `${selectorOf(edge)} marks the selection in the accent`);
  const selected = declarations.filter((d) => d.prop === 'background' && /\[aria-pressed='true'\]/.test(selectorOf(d)) && !/:is\(/.test(selectorOf(d)));
  for (const fill of selected) assert.equal(fill.value, 'var(--bg-selected)', selectorOf(fill));
  const tab = declarations.find((d) => d.prop === 'box-shadow' && selectorOf(d) === ".tc-tab[aria-selected='true']");
  assert.ok(tab && !/--accent/.test(tab.value), 'the selected tab underline is the ink, not the accent');
});

test('narrow: the filters are one scrolling line and the metrics are a compact list (#680)', () => {
  const narrow = css.slice(css.indexOf('@container study (max-width: 560px)'));
  assert.ok(narrow.startsWith('@container study (max-width: 560px)'), 'a container rule for the narrow console');
  assert.match(css, /\.tc-scope\s*\{[^}]*flex-wrap: nowrap/, 'the filter control never wraps');
  assert.match(css, /\.tc-scope-wrap\s*\{[^}]*overflow-x: auto/, 'and its box scrolls sideways when it must');
  assert.doesNotMatch(css, /\.sh-page-header__actions|\.sh-seg__item/, 'the shared header and segmented control keep their own classes (css-ownership)');
  const rules = declarations.filter((d) => /@container study \(max-width: 560px\)/.test(d.ctx.join('|')));
  const metrics = rules.filter((d) => /\.tc-metrics$/.test(selectorOf(d)) && d.prop === 'grid-template-columns');
  assert.deepEqual(metrics.map((d) => d.value), ['minmax(0, 1fr)'], 'one metric per row');
  assert.ok(rules.some((d) => /\.tc-metric:not\(\.tc-metric--progress\)$/.test(selectorOf(d)) && d.prop === 'grid-template-columns' && d.value === 'auto minmax(0, 1fr)'), 'a metric is its name and its value on one line');
});
