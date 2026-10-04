import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Wave 4 item 4 (#145): one icon registry, ui/components/Icon.jsx. The rail glyphs, the board's, the bilingual reader's and the inline
// marks all draw from it; the old span wrapper and the four private glyph files are gone.
const read = (file) => readFileSync(file, 'utf8');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { Icon, IconBox, ICON_NAMES } from './ui/components/index.js'; export { default as NavItemHost } from './ui/SideNav.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Icon, IconBox, ICON_NAMES } = module.exports;
const h = React.createElement;

const RAIL = ['audio', 'live', 'workflows', 'coach', 'resume', 'library', 'sources', 'generate', 'skeleton', 'dashboard', 'exam', 'wrongbook', 'notes', 'board', 'settings', 'auto', 'dark', 'language', 'light', 'tour'];
const BOARD = ['calendar', 'filter', 'edit', 'trash', 'archive', 'link', 'checklist', 'move', 'sync', 'undo', 'chevron-down', 'clock', 'more', 'arrow-up', 'arrow-down'];
const READER = ['copy', 'book'];

test('the registry holds the rail, board and reader glyphs and the brand marks under unique names (#145)', () => {
  for (const name of [...RAIL.map((n) => `nav-${n}`), ...BOARD, ...READER, 'brand', 'brand-compact']) assert.ok(ICON_NAMES.includes(name), `Icon has ${name}`);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  for (const name of ICON_NAMES) assert.match(renderToStaticMarkup(h(Icon, { name })), /<svg[^>]*class="sh-icon/, name);
});

test('IconBox is the span the rail styles (the old ui/Icon.jsx wrapper) (#145)', () => {
  assert.equal(renderToStaticMarkup(h(IconBox, null, 'x')), '<span class="icon" aria-hidden="true">x</span>');
});

test('the old wrapper and the four private glyph sets are deleted, and nothing imports them (#145)', () => {
  for (const file of ['ui/Icon.jsx', 'ui/NavGlyph.jsx', 'ui/tour/TourGlyph.jsx', 'ui/board/icons.jsx', 'ui/document-preview/translation/Glyph.jsx']) assert.equal(existsSync(file), false, `${file} is gone`);
  const walk = (dir, out = []) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (['locales', 'node_modules'].includes(name)) continue; if (statSync(path).isDirectory()) walk(path, out); else if (/\.jsx?$/.test(name)) out.push(path); } return out; };
  for (const file of walk('ui')) {
    const text = read(file);
    if (!file.split('\\').join('/').startsWith('ui/components/')) assert.doesNotMatch(text, /from ['"](\.\/|\.\.\/)Icon\.jsx['"]/, `${file} imports the old wrapper`);
    assert.doesNotMatch(text, /NavGlyph|TourGlyph|board\/icons|\.\/icons\.jsx|translation\/Glyph|from ['"]\.\/Glyph\.jsx['"]/, `${file} uses a private glyph set`);
  }
});

test('no inline <svg> glyph is left outside the registry, the charts and the canvases (#145)', () => {
  for (const file of ['ui/app/AppTopbar.jsx', 'ui/ThumbFeedback.jsx', 'ui/host/studyhub-page.jsx', 'ui/components/Menu.jsx', 'ui/Inbox.jsx', 'ui/App.jsx']) {
    assert.doesNotMatch(read(file), /<svg\b/, `${file} draws its own svg`);
  }
});
