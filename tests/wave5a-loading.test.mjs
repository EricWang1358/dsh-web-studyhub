import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #102: one spinner, one loading look (LoadingState, a polite status), shared keyframes carry the sh- prefix.
const walk = (dir, extension) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extension) : entry.name.endsWith(extension) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const css = walk('ui', '.css').map(file => ({ file, text: read(file).replace(/\/\*[\s\S]*?\*\//g, '') }));

test('keyframe names are unique, spin/shimmer ones carry the sh- prefix, and only sh-spin rotates a full turn', () => {
  const names = css.flatMap(({ file, text }) => [...text.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map(match => ({ file, name: match[1] })));
  const seen = new Map(), duplicated = [];
  for (const { file, name } of names) { if (seen.has(name)) duplicated.push(`${name}: ${seen.get(name)} and ${file}`); else seen.set(name, file); }
  assert.deepEqual(duplicated, []);
  assert.deepEqual(names.filter(({ name }) => /spin|shimmer/.test(name) && !name.startsWith('sh-')).map(({ file, name }) => `${file}: ${name}`), []);
  const turns = css.flatMap(({ file, text }) => [...text.matchAll(/@keyframes\s+([\w-]+)\s*\{[^@]*?rotate\(\s*(?:360deg|1turn)\s*\)/g)].map(match => `${file}: ${match[1]}`));
  assert.deepEqual(turns, [`ui/components/components.css: sh-spin`]);
});

test('a reading / opening / counting message is a LoadingState (a polite status with the one spinner)', () => {
  const allowed = /busyLabel|<Button|const WORKING|return plan\.error|aria-label|后台修题/;
  const offenders = [];
  for (const file of walk('ui', '.jsx')) read(file).split('\n').forEach((line, index) => {
    if (!/ui\(\s*["'][^"']*正在(?:读取|载入|统计|打开|计算|恢复)[^"']*…["']\s*\)/.test(line)) return;
    if (/LoadingState|<Spinner/.test(line) || allowed.test(line) || file === 'ui/components/Loading.jsx') return;
    offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 100)}`);
  });
  assert.deepEqual(offenders, []);
});

test('the pulse dot and the daily-recap spinner are gone: loading shows the shared spinner', () => {
  const found = [...walk('ui', '.jsx'), ...walk('ui', '.css')].filter(file => /(?<![\w-])(?:wf-pulse|daily-recap-spinner|daily-recap-spin)(?![\w-])/.test(read(file)));
  assert.deepEqual(found, []);
});
