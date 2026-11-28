// The 资料 page and the 添加资料 dialog, tidied (#1081, #1083, #1085): one box per purpose, one add icon, no reserved blank under a narrow row, and the
// course scope and the filter as one small form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_PATHS } from '../ui/components/icon-paths.js';

const require = createRequire(import.meta.url);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const compiled = await build({ stdin: { contents: `export { default } from './ui/components/FileDrop.jsx';`, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const FileDrop = module.exports.default;

/** The block of the first rule whose selector is exactly `selector`. */
const ruleOf = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

test('#1081: the compact drop zone has one add icon, the upload on its button, as 添加资料 has', () => {
  const markup = renderToStaticMarkup(React.createElement(FileDrop, { compact: true, multiple: true, onFiles() {} }));
  assert.doesNotMatch(markup, /sh-drop__icon/, 'no second, round upload icon beside the button');
  assert.ok(markup.includes(ICON_PATHS.upload.slice(0, 40)), 'the button shows the upload icon');
  assert.ok(!markup.includes(ICON_PATHS.plus.slice(0, 40)), 'no plus on 选择文件');
});

test('#1081: where the files go is a line of text in the dialog, not a box', async () => {
  const css = await read('ui/import-hub.css');
  const course = ruleOf(css, '.import-hub__course');
  assert.doesNotMatch(course, /border\s*:|background\s*:/, 'the course line has no border or fill');
  const hub = await read('ui/ImportHub.jsx');
  assert.match(hub, /ui\('归入：未分类'\)/, 'no course chosen says where the files go, not a bare 未分类');
});

test('#1083: the index badge has one place on every row, the status line, in a slot of a real width; the row width is decided in one place', async () => {
  const jsx = await read('ui/Sources.jsx');
  const css = await read('ui/sources.css');
  assert.match(jsx, /export const ROWS_NARROW = \d+;/);
  assert.match(jsx, /useNarrow\(pageRef, ROWS_NARROW, \{ content: true \}\)/, 'the page measures its own column, not the window');
  assert.match(jsx, /className=\{`page sources-page\$\{narrow \? ' is-narrow' : ''\}\$\{tight \? ' is-tight' : ''\}`\}/, 'and says so with one class (.is-tight is the toolbar\'s alone, #1694)');
  assert.doesNotMatch(css, /@container/, 'sources.css follows that class; no second width of its own');
  const page = await read('ui/sources-page.css');
  assert.doesNotMatch(page.slice(page.indexOf('@container')), /index-badge__full|\.source-main small/, 'no 资料 row rule follows the window width');
  assert.match(jsx, /className="source-doc__status"[^]*?\{indexSlot\}\s*<\/div>/, 'the slot ends the status line');
  assert.equal(jsx.match(/\{[^{}]*indexSlot\}/g).length, 1, 'and is drawn nowhere else (not on the actions line of a narrow row)');
  assert.doesNotMatch(jsx, /DocumentRow\([^)]*\bnarrow\b/, 'a row does not depend on the page width');
  assert.match(css, /\.source-doc__status > \.source-doc__index \{[^}]*min-width: var\(--index-slot\)/, 'the slot is never narrower than --index-slot, so a long button line cannot crush it');
  assert.match(css, /\.source-doc__line > \.source-doc__status \{[^}]*grid-column: text-start \/ -1/, 'the status line runs under the actions too: hidden actions never narrow it');
  // Round 6: the actions are always shown, in a column as wide as they are (at most half the row), so they lie over no word and hover moves nothing; one line
  // of buttons; before the status line in the DOM (Tab follows the lines); rename lives in 更多 and F2, not in a pencil on the row.
  assert.match(css, /\.source-doc__line \{[^}]*grid-template-columns: \[text-start\] minmax\(0, 1fr\) \[text-end\] fit-content\(50%\);/, 'a content-sized column, capped at half the row');
  // Round 7: the row shows ONE action (补题 where it is offered, else 从这份资料出题) and 更多, which holds the rest; a button is never narrower than its words.
  assert.match(jsx, /\{topUp \? <DocumentTopUp [^>]*buttonClassName="source-doc__action" \/>\s*: canGenerate && <Button/, 'one action beside the title: 补题, else 从这份资料出题');
  assert.match(jsx, /onGenerate=\{topUp && canGenerate \?/, 'and 从这份资料出题 in 更多 when 补题 is that action');
  assert.match(jsx, /onCompanion=\{companionTarget && openModal \?/, 'the interactive companion in 更多');
  assert.equal(jsx.match(/ui\('打开交互伴学页'\)/g).length, 1, 'and nowhere else on the row');
  assert.match(css, /\.source-doc__line > \.source-doc__actions \{[^}]*flex-wrap: nowrap;/, 'one line of buttons, never one alone on a line');
  assert.match(css, /\.source-doc__actions \.source-doc__action \{ white-space: normal; word-break: keep-all; text-wrap: pretty; text-align: start; \}/, 'a label breaks only at a space, with no lone last word, its lines beside its icon; a zh label keeps its words whole');
  assert.doesNotMatch(css, /\.source-doc__actions?[^{]*\{[^}]*overflow-wrap: anywhere/, 'no button is squeezed into a column of letters');
  assert.match(css, /\.source-doc__actions \{[^}]*justify-content: safe flex-end;/, 'a narrow row never pushes a button out past its start');
  assert.match(jsx, /<Tooltip layer group="source-facts" anchorClassName="source-doc__facts-tip" content=\{coursesCut \? coursesText : ''\} forceOpen=\{titleFocus\}>/, 'a cut courses piece says all of it on hover and on keyboard focus of the title, one card at a time');
  const hover = css.slice(css.indexOf('@media (hover: hover) and (pointer: fine)'), css.indexOf('/* A narrow 资料 page'));
  assert.doesNotMatch(hover, /source-doc__actions|--source-doc-veil/, 'hover only tints the row: no actions laid over it');
  assert.doesNotMatch(css, /\.source-doc__actions \{[^}]*(position: absolute|opacity: 0)/, 'no overlay, no hidden actions');
  assert.doesNotMatch(css, /var\(--bg-canvas\) var\(--space-8\)/, 'no fade painted in a fixed colour');
  assert.ok(jsx.indexOf('<div className="source-doc__actions">') < jsx.indexOf('<div className="source-doc__status"'), 'the actions come before the status line in the DOM');
  assert.doesNotMatch(jsx, /source-doc__rename/, 'no pencil on the row');
  assert.match(jsx, /onRename=\{editor \? startEditing : undefined\}/, 'rename stays in 更多');
  assert.doesNotMatch(css, /max-width: 45%/, 'the facts line has no fixed cap that cuts a line that fits');
  // The shared Badge may wrap elsewhere (the 创建题组 picker); in a 资料 row's slot its words keep one line and end in an ellipsis, so it is never taller than its slot.
  const badgeCss = await read('ui/sources-page.css');
  assert.match(badgeCss, /\.source-doc__index \.index-badge__text \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/, 'the row badge keeps one line (it ends in an ellipsis), so it is never taller than its slot');
});

test('#1083: the header keeps 添加资料 last on the title row and shows the other actions only when they fit', async () => {
  const jsx = await read('ui/Sources.jsx');
  assert.match(jsx, /actions=\{headerActions\} actionsOnTitleRow \/>/, 'the actions always end the title row');
  assert.match(jsx, /const fullHeader = useRowFit\(pageRef,/, 'whether the full set fits is measured, not read from a width');
  assert.match(jsx, /<div className="sources-page__fit" aria-hidden="true" inert><div className="sh-page-header__actions">\{fullActions\(false\)\}/, 'on a hidden copy, so the visible header is never drawn only to be measured');
  const hook = await read('ui/use-row-fit.js');
  assert.doesNotMatch(hook, /setFits\(true\)/, 'the hook never flips the visible set back to measure it');
  const compact = jsx.slice(jsx.indexOf('    : <>', jsx.indexOf('const headerActions = fullHeader')), jsx.indexOf('</>;', jsx.indexOf('const headerActions = fullHeader')));
  assert.match(compact, /<Menu[^]*\{addButton\}\s*$/, 'compact: 更多, then the primary at the right edge');
  for (const id of ['archived', 'groups', 'companions']) assert.match(compact, new RegExp(`id: '${id}'`));
  assert.match(compact, /data-tour="sources-archived"/, 'the finder still has an anchor for 已归档');
  assert.match(jsx, /const allOpen = scopeView\.groupKeys/, '全部展开 is named by the scope, not the filter, so typing never renames it');
  assert.match(jsx, /manyGroups = scopeView\.groupKeys\.length > 1/, 'and is there by the scope, so typing never removes it');
  const finder = await read('ui/finder/entries.js');
  assert.match(finder, /窄窗口里在「添加资料」旁的「更多」里/, 'the finder says where 已归档 went');
});

test('#1085: 课程范围 and 筛选资料 share one grid column; the follow mark and the filter count take no width from it', async () => {
  const scope = await read('ui/course-active.css');
  assert.match(ruleOf(scope, '.page-scope-form'), /grid-template-columns: auto minmax\(0, 24rem\) auto/, 'the third column is as wide as the mark, so the mark stays inside a narrow page');
  assert.match(scope, /\.page-scope-form \.page-scope__select \{ grid-column: 2;/);
  const css = await read('ui/sources.css');
  assert.match(css, /\.sources-toolbar > \.sources-filter \{[^}]*grid-column: 2;/);
  assert.match(css, /\.sources-filter__state\) > \.sources-filter__input \{ padding-inline-end: var\(--sources-filter-end\)/, 'while filtering the field keeps the room its count needs, inside its own box');
  assert.match(css, /\.sources-filter__state \{ position: absolute;/, 'the count and 清除筛选 sit inside the field, so typing changes no box');
  const jsx = await read('ui/Sources.jsx');
  assert.match(jsx, /<div className="page-scope-form sources-toolbar">\s*<PageScope/);
});

test('#1083: a row\'s 更多 has the ink of the header\'s 更多, not a grey word', async () => {
  const page = await read('ui/sources-page.css');
  assert.match(page, /\.source-row-actions > summary \{[^}]*color: var\(--text\);/);
});
