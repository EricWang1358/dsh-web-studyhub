import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #87 (one banner / notice box) and #88 (.warning is not a status colour for three meanings).
const walk = (dir, ext) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, ext) : entry.name.endsWith(ext) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const jsx = walk('ui', '.jsx').map(file => ({ file, text: read(file) }));
const css = walk('ui', '.css').map(file => ({ file, text: read(file).replace(/\/\*[\s\S]*?\*\//g, '') }));

test('#87 no hand-written banner or notice class is rendered any more', () => {
  const pattern = /className=(?:"|\{`)[^"`]*\b(alert|notice|wf-notice|update-available|ingest-banner)\b/;
  assert.deepEqual(jsx.filter(({ text }) => pattern.test(text)).map(({ file }) => file), []);
});

test('#87 the stylesheets no longer define .alert, .notice, .wf-notice or the quality-note warning', () => {
  const defined = css.flatMap(({ file, text }) => [...text.matchAll(/(?:^|[\s,}{])\.(alert|notice|wf-notice|update-available|ingest-banner)\b/g)].map(match => `${file}: .${match[1]}`));
  assert.deepEqual(defined, []);
  assert.deepEqual(jsx.filter(({ text }) => /quality-note warning/.test(text)).map(({ file }) => file), []);
});

test('#88 nothing renders .warning or .is-warning: an error is an error InlineMessage, a warning a warning one', () => {
  const used = jsx.filter(({ text }) => /className=(?:"|\{`)[^"`}]*(?<![\w-])(?:is-)?warning(?![\w-])/.test(text.replace(/\$\{[^}]*\}/g, '')) || /['"`]is-warning['"`]/.test(text)).map(({ file }) => file);
  assert.deepEqual(used, []);
  const defined = css.flatMap(({ file, text }) => [...text.matchAll(/\.(?:is-)?warning(?![\w-])/g)].map(() => file));
  assert.deepEqual(defined, []);
  assert.match(read('ui/ThumbFeedback.jsx'), /<InlineMessage tone="error" className="thumbs__error">\{error\}<\/InlineMessage>/);
  assert.match(read('ui/Review.jsx'), /<InlineMessage tone="warning" className="review-updated">\{ui\("题目已更新，请按新版重新作答。之前的作答历史已保留。"\)\}<\/InlineMessage>/);
});

test('#87 the ingest banner is an info Banner and the app banners carry no accent colour', () => {
  const banners = read('ui/app/AppBanners.jsx');
  assert.match(banners, /<Banner role="status" tone="info" title=\{ui\('录题中'\)\}/);
  const shell = css.find(({ file }) => file === 'ui/app/app-shell.css').text;
  assert.doesNotMatch(shell, /\.app-banner[^{]*\{[^}]*accent/);
});
