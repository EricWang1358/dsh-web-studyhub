import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #679: 设置 › 界面 keeps the everyday choices in the open (language, look, accent colour, size), folds the rest into 更多外观选项, and carries the
   whole look to another computer with a copy button, a file and a paste dialog, never a raw text box on the page. */

const h = React.createElement;
const noop = () => {};
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const full = { language: 'zh', onLanguage: noop, theme: 'dark', onTheme: noop, accent: 'cinnabar', onAccent: noop, scale: 100, onScale: noop, font: 'system', onFont: noop,
  fontCustom: '', onFontCustom: noop, fontTitle: 'follow', onFontTitle: noop, motion: 'auto', onMotion: noop, contrast: 'auto', onContrast: noop, density: 'standard', onDensity: noop,
  radius: 'standard', onRadius: noop, onReset: noop, onExport: () => '{"studyhubAppearance":1}', onImport: () => true };

async function draw(appearance = full, lang = 'zh') {
  const mod = await loadUi(`export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
  mod.setUiLanguage(lang);
  try { return renderToStaticMarkup(h(mod.AppearanceSection, { appearance })); } finally { mod.setUiLanguage('zh'); }
}
const split = (html) => {
  const at = html.indexOf('appearance-more');
  assert.ok(at > 0, 'the fold for the other options exists');
  const start = html.lastIndexOf('<details', at);
  return { main: html.slice(0, start), more: html.slice(start) };
};
const anchorsIn = (html) => [...html.matchAll(/data-tour="(settings-appearance-[a-z-]+)"/g)].map((match) => match[1]);

test('without opening anything there are four choices: language, look, accent colour, size', async () => {
  const { main } = split(await draw());
  assert.deepEqual(anchorsIn(main).filter((anchor) => !anchor.endsWith('-reset')), ['settings-appearance-language', 'settings-appearance-theme', 'settings-appearance-accent', 'settings-appearance-scale']);
  for (const gone of ['界面字体', '标题字体', '动画', '对比度', '界面密度', '圆角']) assert.doesNotMatch(main, new RegExp(`>${gone}<`), `${gone} is not in the open`);
});

test('every other choice is still there, inside 更多外观选项, with its anchor', async () => {
  const { more } = split(await draw());
  assert.match(more, /更多外观选项/);
  assert.deepEqual(anchorsIn(more).filter((anchor) => !anchor.endsWith('-transfer')),
    ['settings-appearance-font', 'settings-appearance-motion', 'settings-appearance-contrast', 'settings-appearance-density', 'settings-appearance-radius']);
  for (const label of ['界面字体', '标题字体', '动画', '对比度', '界面密度', '圆角', '无动画', '高对比', '圆润']) assert.match(more, new RegExp(label), label);
});

test('a typed font name still shows when 本机字体 is chosen, inside the fold', async () => {
  const { main, more } = split(await draw({ ...full, font: 'custom', fontCustom: 'Fira Code' }));
  assert.doesNotMatch(main, /本机字体/);
  assert.match(more, /aria-label="本机字体"/);
});

test('reset stays in the open; export and import are buttons inside the fold, and no text box is drawn', async () => {
  const { main, more } = split(await draw());
  assert.match(main, /恢复默认外观/, 'reset is one click away whatever the size or font went to');
  assert.deepEqual(anchorsIn(main).filter((anchor) => /reset/.test(anchor)), ['settings-appearance-reset']);
  assert.match(more, /data-tour="settings-appearance-transfer"/);
  for (const label of ['复制外观设置', '下载为文件', '导入外观']) assert.match(more, new RegExp(label), label);
  assert.doesNotMatch(await draw(), /<textarea/, 'the paste box lives in a dialog that opens on demand');
  assert.doesNotMatch(await draw(), /导出外观/, 'the old raw-text export is gone');
});

test('without the handlers there is nothing to restore or carry; in English the same places have English words', async () => {
  const bare = await draw({ ...full, onReset: undefined, onExport: undefined, onImport: undefined });
  assert.doesNotMatch(bare, /恢复默认外观|复制外观设置|导入外观/);
  const en = await draw(full, 'en');
  for (const label of ['More appearance options', 'Restore default appearance', 'Copy appearance settings', 'Save as file', 'Import appearance']) assert.match(en, new RegExp(label), label);
});

test('the finder and the settings category know the new places', async () => {
  const [entries, groups] = await Promise.all([read('ui/finder/entries.js'), read('ui/settings-groups.js')]);
  assert.match(entries, /settings-appearance-reset/);
  assert.match(groups, /'settings-appearance-reset'/);
  assert.doesNotMatch(entries, /把整套外观导出成一小段文字/, 'the old export sentence is gone');
  const section = await read('ui/settings/AppearanceSection.jsx');
  assert.doesNotMatch(section, /TextArea/, 'no raw text box on the settings surface');
});
