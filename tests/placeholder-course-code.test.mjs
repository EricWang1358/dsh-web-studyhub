import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

/* #1706 (and #134 before it): an example in a field is read by every learner, so it never names one school's course. This guard parses every module of ui/ and
   reads each placeholder (a JSX attribute or a prop whose name ends in "placeholder"): the words it can show and their English in ui/locales. */

const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve('eslint/package.json'))('espree');

/* A course code as schools write it: 2 to 4 capitals right before 4 digits, with an optional letter (AB1234, XY2040S). */
const COURSE_CODE = /(?<![A-Za-z0-9])[A-Z]{2,4}\d{4}[A-Z]?(?![A-Za-z0-9])/;
const PLACEHOLDER = /placeholder$/i;

async function modules(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'locales') found.push(...await modules(path));
    else if (/\.(jsx|js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

const nameOf = key => (typeof key?.name === 'string' ? key.name : typeof key?.value === 'string' ? key.value : '');

/** Every string written inside the value of a placeholder in `code`: literals and the fixed parts of templates, through ui(), uiFormat() and conditions. */
export function placeholderStrings(code) {
  const tree = parse(code, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } });
  const found = [];
  const collect = value => walk(value, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') found.push(node.value);
    else if (node.type === 'TemplateElement') found.push(node.value.cooked ?? '');
  });
  walk(tree, node => {
    if (node.type === 'JSXAttribute' && PLACEHOLDER.test(nameOf(node.name))) collect(node.value);
    else if (node.type === 'Property' && !node.computed && PLACEHOLDER.test(nameOf(node.key))) collect(node.value);
  });
  return found;
}

async function english() {
  const words = {};
  for (const name of await readdir('ui/locales')) if (name.endsWith('.json')) Object.assign(words, JSON.parse(await readFile(`ui/locales/${name}`, 'utf8')));
  return words;
}

test('the guard reads a placeholder wherever it is written, and knows a course code from other figures', () => {
  assert.deepEqual(placeholderStrings(`const a = <input placeholder={ui('例如 AB1234 · 课')} />; const b = <Pick searchPlaceholder={wide ? 'x' : \`y \${n}\`} />; const c = { filterPlaceholder: 'z' };`),
    ['例如 AB1234 · 课', 'x', 'y ', '', 'z']);
  for (const code of ['AB1234', '例如 XY2040S', 'For example: ZQ5002 · Networks']) assert.match(code, COURSE_CODE);
  for (const plain of ['2M', 'sk-xxxx', 'Lab2', 'HTTP 404', 'AES256', 'https://api.example.com/v1']) assert.doesNotMatch(plain, COURSE_CODE);
});

test('no placeholder of ui/ names a school course, in Chinese or in English', async () => {
  const words = await english();
  const offenders = [];
  let read = 0;
  for (const path of await modules('ui')) {
    for (const text of placeholderStrings(await readFile(path, 'utf8'))) {
      read += 1;
      for (const said of [text, words[text]]) if (typeof said === 'string' && COURSE_CODE.test(said)) offenders.push(`${path}: ${said}`);
    }
  }
  assert.ok(read > 50, `the guard read only ${read} placeholder strings: it no longer sees them`);
  assert.deepEqual(offenders, [], 'use a generic example (例如：数据库 · 索引与事务)');
});
