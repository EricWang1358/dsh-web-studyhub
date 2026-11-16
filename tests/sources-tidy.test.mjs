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

test('#1083: a narrow row puts the index badge on its actions line; the width rule is the one of sources.css', async () => {
  const jsx = await read('ui/Sources.jsx');
  const css = await read('ui/sources.css');
  const width = Number(jsx.match(/export const ROWS_NARROW = (\d+);/)?.[1]);
  assert.ok(css.includes(`@container study (max-width: ${width - 1}px)`), 'ROWS_NARROW mirrors the container query that gives the actions their own line');
  assert.match(jsx, /\{!narrow && indexSlot\}/, 'a wide row keeps the badge on its status line');
  assert.match(jsx, /source-doc__actions">\s*\{narrow && indexSlot\}/, 'a narrow row starts its actions line with it');
  assert.match(css, /\.source-doc__actions > \.source-doc__index \{[^}]*flex: 1 1 0/, 'the badge shrinks instead of pushing the buttons to a second line');
});

test('#1083: in a narrow window the header keeps 添加资料 and puts the rest in one 更多', async () => {
  const jsx = await read('ui/Sources.jsx');
  const narrow = jsx.slice(jsx.indexOf('const headerActions = narrow'), jsx.indexOf('    : <>', jsx.indexOf('const headerActions = narrow')));
  assert.match(narrow, /\{addButton\}\s*<Menu/, 'the primary first, then 更多');
  for (const id of ['archived', 'groups', 'companions']) assert.match(narrow, new RegExp(`id: '${id}'`));
  assert.match(narrow, /data-tour="sources-archived"/, 'the finder still has an anchor for 已归档');
  const finder = await read('ui/finder/entries.js');
  assert.match(finder, /窄窗口里在「添加资料」旁的「更多」里/, 'the finder says where 已归档 went');
});

test('#1085: 课程范围 and 筛选资料 share one grid column', async () => {
  const scope = await read('ui/course-active.css');
  assert.match(ruleOf(scope, '.page-scope-form'), /grid-template-columns: auto minmax\(0, 24rem\) auto/);
  assert.match(scope, /\.page-scope-form \.page-scope__select \{ grid-column: 2;/);
  const css = await read('ui/sources.css');
  assert.match(css, /\.sources-filter__input \{ grid-column: 2;/);
  const jsx = await read('ui/Sources.jsx');
  assert.match(jsx, /<div className="page-scope-form sources-toolbar">\s*<PageScope/);
});
