import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `export { default as Ingest } from './ui/Ingest.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } }); // CourseField uses the component library (WP14)
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Ingest, setUiLanguage } = module.exports;
const render = (decks = []) => renderToStaticMarkup(React.createElement(Ingest, { data: { decks, modelReady: true }, start() {} }));

test('English recording setup translates every option, tooltip and default description', () => {
  try {
    setUiLanguage('en');
    const html = render();
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    for (const label of ['Auto-detect', 'Single choice', 'Use my markings', 'Mark all as mistakes', 'Mark none as mistakes', 'Only record questions I mark as answered incorrectly']) assert.ok(html.includes(label), label);
    const userDeck = '我的原文题组';
    assert.ok(render([{ id: 'user', title: userDeck }]).includes(userDeck), 'user content stays in its original language');
    setUiLanguage('zh');
    assert.match(render(), /自动识别/);
    assert.match(render(), /标了自己选错的才记为错题/);
  } finally { setUiLanguage('zh'); }
});
