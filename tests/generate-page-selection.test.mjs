import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* #658, the 创建题组 part: what is selected on the page (a ticked material row, the chosen way in) is `--bg-selected` with a neutral tick, never the accent (ui/DESIGN.md:
   the accent is the one primary action, the card head rule, progress and the heatmap). The global guard over every feature sheet is tests/ui-guardrails.test.mjs. */

const css = async name => (await readFile(new URL(`../ui/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const rule = (sheet, selector) => {
  const at = sheet.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return sheet.slice(at, sheet.indexOf('}', at) + 1);
};

test('a ticked material row is the selection colour, with no accent colour or left rule', async () => {
  const picker = await css('source-picker.css'), selected = rule(picker, '.source-picker__item.is-selected');
  assert.match(selected, /background:\s*var\(--bg-selected\)/);
  assert.doesNotMatch(selected, /--accent|accent-soft|box-shadow/, 'no accent tint and no rule down the left edge');
  assert.doesNotMatch(picker, /color-mix\([^)]*--accent/, 'nothing else in the picker is tinted with the accent');
});

test('the tick of a material is neutral', async () => {
  const check = rule(await css('source-picker.css'), '.source-picker .source-picker__check:is(:checked, :indeterminate)');
  assert.match(check, /background:\s*var\(--text\)/);
  assert.doesNotMatch(check, /--accent/);
});

test('the chosen way in (用资料出题 / 导入 JSON / 案例分析题) is the selection colour too', async () => {
  const home = await css('generate-home.css'), active = rule(home, '.generate-page .source-mode > .source-tab.is-active');
  assert.match(active, /background:\s*var\(--bg-selected\)/);
  assert.doesNotMatch(active, /--accent/);
});
