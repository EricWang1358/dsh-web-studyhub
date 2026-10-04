import test from 'node:test';
import assert from 'node:assert/strict';
import { classOwners, readAllow, subjectClasses } from '../scripts/qa/css-ownership.mjs';

// #151: a class is styled in one stylesheet. The allow-list is the debt that is left; it may only shrink.
const owners = classOwners();
const allow = readAllow();

test('a class that two stylesheets both write rules for is on the allow-list, with exactly those files', () => {
  const unlisted = Object.entries(owners).filter(([name]) => !allow[name]).map(([name, files]) => `.${name}: ${files.join(', ')}`);
  assert.deepEqual(unlisted, [], 'give the class one owning stylesheet (move or delete the second rule). The allow-list only shrinks: node scripts/qa/css-ownership.mjs --update');
  const widened = Object.entries(owners).filter(([name, files]) => allow[name] && files.some((file) => !allow[name].includes(file))).map(([name, files]) => `.${name}: ${files.join(', ')}`);
  assert.deepEqual(widened, [], 'a new stylesheet started to style an owned class');
});

test('the allow-list holds no entry that is already fixed', () => {
  const stale = Object.keys(allow).filter((name) => !owners[name]);
  assert.deepEqual(stale, [], 'delete these from tests/fixtures/css-ownership-allow.json (node scripts/qa/css-ownership.mjs --update)');
  const loose = Object.entries(allow).filter(([name, files]) => owners[name] && files.some((file) => !owners[name].includes(file))).map(([name]) => `.${name}`);
  assert.deepEqual(loose, [], 'an allowed file no longer styles the class: run --update to shrink the entry');
});

test('the subject of a selector is its last compound', () => {
  assert.deepEqual(subjectClasses('.a .b:hover'), ['b']);
  assert.deepEqual(subjectClasses('.a > .b.c'), ['b', 'c']);
  assert.deepEqual(subjectClasses('.a :is(.b, .c)'), ['b', 'c']);
  assert.deepEqual(subjectClasses('.a .b:not(.c)'), ['b'], ':not() names what the element is not');
  assert.deepEqual(subjectClasses('.a button'), []);
  assert.deepEqual(subjectClasses('.a [data-x=".z"] .y'), ['y']);
});
