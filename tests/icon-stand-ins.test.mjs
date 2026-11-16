import test from 'node:test';
import assert from 'node:assert/strict';
import { cssContents, frontArrowProblems, glyphProblems, localeEntries, stringsOf, uiSources, uiStrings } from './helpers/icon-stand-ins.mjs';

/* #1073: no typed → ← ✓ × ⚑ ↻ ＋ ↗ in what the learner reads. A "go on" arrow is `<Button iconEnd="arrow-right">`, a way back `icon="arrow-left"`,
   a tick / cross / flag / refresh is a registry icon (ui/DESIGN.md, Icons). What stays text is listed here, one string at a time, with why; an entry
   that no string uses any more fails, so the list only shrinks. */

/** Exact strings that keep a typed glyph, and why. */
const KEEP = Object.freeze([
  { text: '[已完成 ✓] {0}', why: 'the browser tab title: plain text only, no markup' },
  { text: '长按并拖动可调整顺序（键盘：Alt+↑/↓）', why: 'names the keys Alt and the arrow keys' },
  { text: '上一个知识点（也可以按 ←）', why: 'names the arrow key' },
  { text: '下一个知识点（也可以按 →）', why: 'names the arrow key' },
  { text: '← → 仍按知识点走', why: 'names the arrow keys' },
  { text: '← →', why: 'the shortcut sheet: the legend of the arrow keys' },
  { text: '← → / Esc', why: 'the shortcut sheet: the legend of the arrow keys' },
  { text: 'Alt+↑ / Alt+↓', why: 'the shortcut sheet: the legend of the arrow keys' },
  { text: '↩︎', why: 'the standard footnote back-link mark (ui/markdown-page.js); the learner reads it as the footnote sign, not as an icon' },
]);

/** Files another branch is rewriting at the moment; delete the line when it lands. */
const keptText = new Set(KEEP.map((entry) => entry.text));

test('the rule: edge arrows, icon glyphs and a close-mark × are stand-ins; sentence arrows, joiners and multiplications are not', () => {
  for (const text of ['下一题 →', '← 上一题', '→', '✓ 已选 · 正确', '× 你的选择', '⚑', '↻ 将继续巩固', '＋ 添加', '打开 ↗', '「发布并开始练 →」', '回到 ←', '点 👎 标记', '👍 这题不错', '↩︎']) assert.notDeepEqual(glyphProblems(text), [], text);
  for (const text of ['本组 40% → 55%', '读 → 做题 → 回到阅读', ' → ', '{0} → {1}', '间隔 {0} 天 → {1} 天', '时间 × 精度倾向', '×3', '行 ×{}', '失败 {0}×', '3× 速度', '', '继续学习']) assert.deepEqual(glyphProblems(text), [], text);
  assert.deepEqual(glyphProblems('点关闭 ×'), ['"×" is not a multiplication, use the close icon']);
});

test('the scanner reads the strings of formatted JavaScript, not its comments or regular expressions', () => {
  const code = 'const a = "下一题 →"; // 注释 →\n/* ✓ */ const b = `x ${f("✓ 已选")} →`; const c = /[→←]/g; const d = \'it\\\'s ×\'; const e = x / 2 / "tail";';
  assert.deepEqual(stringsOf(code), ['下一题 →', '✓ 已选', 'x {} →', "it's ×", 'tail']);
});

test('no string of ui/ uses a typed glyph for an icon (#1073)', async () => {
  const found = [];
  for (const { file, text } of await uiStrings()) if (!keptText.has(text)) for (const problem of glyphProblems(text)) found.push(`${file}: ${JSON.stringify(text.slice(0, 70))}: ${problem}`);
  assert.deepEqual([...new Set(found)], [], `${new Set(found).size} string(s) with a typed glyph; draw an icon, or list a key name or a window title in KEEP with why`);
});

test('the front-arrow check sees a Button, a Banner action, a conditional and an object `icon` that holds arrow-right, and leaves iconEnd and arrow-left alone', () => {
  for (const source of ['<Button icon="arrow-right">', '<Button variant="x" icon={"arrow-right"}>', "<Button icon={'arrow-right'}>", "<Banner action={{ label: 'Go', icon: 'arrow-right' }} />",
    "<Button icon={ahead ? 'arrow-right' : 'arrow-left'}>", "const step = { label: 'x', icon: next ? 'arrow-right' : undefined, run }", '<EmptyState action={{ icon: "arrow-right", onClick }} />']) assert.notDeepEqual(frontArrowProblems(source), [], source);
  for (const source of ['<Button iconEnd="arrow-right">', '<Button icon="arrow-left" iconEnd="arrow-right">', "<Banner action={{ iconEnd: 'arrow-right' }} />", '<Icon name="arrow-right" />', "const a = { icon: 'plus' }, b = 'arrow-right'", '<Button icon={plan.action.icon} iconEnd="arrow-right">',
    '<IconButton size="sm" icon="arrow-right" label="next" />']) assert.deepEqual(frontArrowProblems(source), [], source);
});

test('a go-on arrow is on the right of a Button or an action, never icon="arrow-right" in front of the words (#1073)', async () => {
  const found = [];
  for (const { file, source } of await uiSources()) for (const problem of frontArrowProblems(source)) found.push(`${file}: ${problem}`);
  assert.deepEqual(found, []);
});

test('no stylesheet draws a typed glyph with content (a pseudo-element is no icon either)', async () => {
  const found = (await cssContents()).flatMap(({ file, text }) => glyphProblems(text).map((problem) => `${file}: ${JSON.stringify(text)}: ${problem}`));
  assert.deepEqual(found, []);
});

test('no English catalogue key or text uses a typed glyph for an icon (the key is the Chinese source string)', async () => {
  const found = [];
  for (const { file, key, value } of await localeEntries()) {
    if (keptText.has(key)) continue;
    for (const [side, text] of [['key', key], ['value', value]]) for (const problem of glyphProblems(String(text))) found.push(`${file} ${side}: ${JSON.stringify(String(text).slice(0, 70))}: ${problem}`);
  }
  assert.deepEqual(found, [], `${found.length} catalogue text(s) with a typed glyph`);
});

test('every KEEP entry is a string some file still has, with a reason', async () => {
  const texts = new Set((await uiStrings()).map((row) => row.text));
  for (const { text, why } of KEEP) {
    assert.ok(texts.has(text), `no string "${text}" left in ui/: delete the KEEP entry`);
    assert.ok(why.length > 8, `say why "${text}" stays typed`);
  }
});
