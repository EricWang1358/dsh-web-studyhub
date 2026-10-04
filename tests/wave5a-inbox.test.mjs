import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #93: no kind-prefix decision outside lib/inbox-kinds.js, anywhere in lib/ or ui/.
const walk = dir => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.(?:js|jsx|mjs)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
// lib/client.* are bundler output of the sources below.
const files = [...walk('lib'), ...walk('ui')].filter(file => !/^lib\/client\./.test(file) && file !== 'lib/inbox-kinds.js');

test('no source decides a letter\'s domain from the prefix of its kind', () => {
  const found = files.filter(file => /startsWith\(\s*['"](?:pdf|audio|translate)-|\(\?:audio\|pdf\|translate\)|kind\.split\(['"]-['"]\)/.test(read(file)));
  assert.deepEqual(found, []);
});

test('inbox.open reads the job domain from the registry', () => {
  const source = read('lib/contexts/library/operations.js');
  assert.match(source, /jobDomainOf\(item\.kind\)/);
});
