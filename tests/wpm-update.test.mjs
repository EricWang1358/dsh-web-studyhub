import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCopyFeedback } from '../ui/use-copy-feedback.js';

// UI wave 2, WP-M: the update center says when a check failed, and "copied" resets (#106 #91 #87 #95).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/UpdateCenter.jsx';
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const update = (extra = {}) => ({ current: '2.1.0', latest: '2.1.1', newer: true, publishedAt: '2026-10-05T08:00:00Z', url: 'https://example.test/release',
  checkedAt: '2026-10-06T00:00:00.000Z', autoCheck: true, snoozed: false, pendingRestart: null, ...extra });
const settings = (props = {}, language) => render(h(m.UpdateSettings, { update: update(), call: async () => ({}), onOpen() {}, ...props }), language);

test('a manual check that cannot reach the host answers with the error; an automatic one stays silent (#106)', async () => {
  const down = async () => { throw new Error('Study connection is unavailable'); };
  assert.equal(await m.refreshUpdate(down), null, 'the automatic check never shows an error');
  const failed = await m.refreshUpdate(down, { force: true });
  assert.match(failed.error, /unavailable/);
  const fresh = await m.refreshUpdate(async () => update({ latest: '2.1.0', newer: false }), { force: true });
  assert.equal(fresh.latest, '2.1.0');
  assert.equal(fresh.error, undefined);
});

test('a failed manual check shows an error with a retry; the last answer is not mistaken for "up to date" (#106)', () => {
  const out = settings({ initialCheckError: 'Study connection is unavailable', update: update({ newer: false, latest: '2.1.0' }) });
  assert.match(out, /sh-inline--error/);
  assert.match(out, /role="alert"/);
  assert.match(out, /没能检查更新/);
  assert.match(out, /sh-inline__action[^>]*>重试</);
  assert.doesNotMatch(out, /已是最新版本/);
  assert.doesNotMatch(settings({ update: update({ newer: false, latest: '2.1.0' }) }), /sh-inline--error/);
  assert.doesNotMatch(settings({ initialCheckError: 'x', update: update({ newer: false }) }, 'en'), han);
});

test('"up to date" and "cannot reach GitHub" look different (#106)', () => {
  const current = settings({ update: update({ newer: false, latest: '2.1.0' }) });
  assert.match(current, /sh-inline--success[^>]*>(?:(?!<\/div>).)*已是最新版本/s);
  assert.doesNotMatch(current, /update-status/);
  const offline = settings({ update: update({ newer: false, latest: '2.1.0', error: 'network' }) });
  assert.match(offline, /sh-inline--warning[^>]*>(?:(?!<\/div>).)*暂时无法连接 GitHub/s);
  assert.match(offline, /sh-inline__action[^>]*>重试</);
  assert.doesNotMatch(offline, /已是最新版本/);
  assert.doesNotMatch(offline, /role="alert"/, 'a failed automatic check is a warning, not an alarm');
});

test('a setting that could not be saved says so instead of silently flipping back (#106)', () => {
  const out = settings({ initialSaveError: 'Study connection is unavailable' });
  assert.match(out, /sh-inline--error/);
  assert.match(out, /没能保存这个设置/);
  assert.doesNotMatch(settings(), /没能保存这个设置/);
});

test('a new version is a Banner with the one primary action; the sidebar chip is a Badge (#87 #95 #106)', () => {
  const out = settings();
  assert.match(out, /sh-banner--info/);
  assert.match(out, /有新版本 2\.1\.1/);
  assert.match(out, /sh-btn--primary[^>]*>查看升级</);
  assert.doesNotMatch(out, /update-available/);
  const chip = render(h(m.UpdateChip, { update: update(), onOpen() {} }));
  assert.match(chip, /<button[^>]*class="update-chip[^"]*"/);
  assert.match(chip, /<span class="sh-badge[^"]*"[^>]*data-tone="info"/);
  assert.match(chip, /有新版本 2\.1\.1/);
  const compact = render(h(m.UpdateChip, { update: update(), onOpen() {}, compact: true }));
  assert.match(compact, /aria-label="有新版本 2\.1\.1"/);
  assert.match(render(h(m.UpdateChip, { update: update({ pendingRestart: '2.1.1', newer: false }), onOpen() {} })), /重启 DSH 完成升级/);
  lacks('ui/update.css', /color-mix\(in srgb, var\(--accent\)/, /\.update-available/);
});

test('copy feedback is one hook that resets (#91)', async () => {
  const timers = [], writes = [], seen = [];
  const feedback = createCopyFeedback({ text: 'abc', resetMs: 2500, write: async text => { writes.push(text); }, onChange: value => seen.push(value),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  assert.equal(await feedback.copy(), true);
  assert.deepEqual(writes, ['abc']);
  assert.deepEqual(seen, [true]);
  assert.equal(timers[0].ms, 2500);
  timers[0].fn();
  assert.deepEqual(seen, [true, false], 'it goes back to "copy"');
  const broken = createCopyFeedback({ text: 'x', write: async () => { throw new Error('denied'); }, onChange: value => seen.push(value), setTimer() { return 1; }, clearTimer() {} });
  assert.equal(await broken.copy(), false);
  assert.equal(seen.at(-1), false);
  const again = createCopyFeedback({ text: 'x', resetMs: 100, write: async () => {}, onChange() {}, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: id => { timers.cleared = id; } });
  await again.copy();
  await again.copy();
  assert.ok(timers.cleared, 'a second copy restarts the countdown');
  again.dispose();
  for (const file of ['ui/UpdateCenter.jsx', 'ui/LargeDocumentCard.jsx']) { has(file, /useCopyFeedback/); lacks(file, /navigator\.clipboard/, /setTimeout\(\(\) => setCopied/); }
});

test('the large-document card uses the shared badge and hint, and its limits come from the constants (#95 #122)', () => {
  const out = render(h(m.LargeDocumentCard, { reason: 'pdf-size', detail: { name: 'Book.pdf' } }));
  assert.match(out, /Book\.pdf/);
  assert.match(out, /超过 8 MB/);
  assert.doesNotMatch(out, /large-doc__badge|large-doc__needs|large-doc__note/);
  assert.match(out, /sh-badge[^>]*>推荐</);
  assert.match(out, /sh-hint/);
  assert.match(render(h(m.LargeDocumentCard, { reason: 'pdf-pages' })), /超过 200 页/);
  assert.match(render(h(m.LargeDocumentCard, { reason: 'text-chars' })), /超过 600,000 字符/);
  assert.doesNotMatch(render(h(m.LargeDocumentCard, { reason: 'pdf-pages' }), 'en'), han);
});
