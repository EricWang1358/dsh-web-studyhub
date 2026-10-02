import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JEV_FEATURES } from '../lib/jev-settings.js';
import { JEV_REPLACE_SITES } from '../lib/jev-sites.js';

/* docs/jev-experimental.md says what the product guarantees. These tests keep its promises in step with the code. */

const doc = await readFile(new URL('../docs/jev-experimental.md', import.meta.url), 'utf8');

test('the document states the privacy facts exactly: no training commitment, enterprise-only zero retention, normal-account retention not documented', () => {
  assert.match(doc, /commits not to train models on user data/);
  assert.match(doc, /zero data retention is offered\s+to \*enterprise\* customers/);
  assert.match(doc, /How long a normal account's data is retained is not documented/);
  assert.match(doc, /off by\s+default/);
  assert.match(doc, /Not claimed anywhere in the product/);
});

test('every experiment of the settings is described', () => {
  for (const feature of JEV_FEATURES) assert.match(doc, new RegExp(`\`${feature}\``), feature);
});

test('the results template is blank: nobody has measured anything yet, so no number may be invented', () => {
  const rows = doc.split('\n').filter(line => /^\| (courseSuggest|preReview:|outlineNoise|levelCheck \()/.test(line));
  assert.equal(rows.length, 8);
  for (const row of rows) assert.equal(row.split('|').slice(2, -1).filter(cell => cell.trim()).length, 0, row);
  assert.match(doc, /nothing here is measured yet/);
});

test('it documents the seam, the outline hook and the evaluation commands that really exist', () => {
  assert.match(doc, /provider\.decide\(state, questions/);
  assert.match(doc, /applyOutlineLabels/);
  assert.match(doc, /scripts\/eval-jev\.mjs/);
  assert.match(doc, /scripts\/jev-live-check\.mjs/);
  assert.match(doc, /tests\/fixtures\/jev-eval\/README\.md/);
});

test('the providers section states the OpenCode facts exactly and what is unverified', () => {
  for (const id of ['typesafe', 'opencode-zen-free', 'opencode-zen']) assert.match(doc, new RegExp(`\`${id}\``), id);
  assert.match(doc, /https:\/\/opencode\.ai\/zen\/v1\/systemone/);
  assert.match(doc, /`jev-1\.13-free`/);
  assert.match(doc, /`jev-1\.13`/);
  assert.match(doc, /OPENCODE_GO_API_KEY_2/);
  assert.match(doc, /does not say whether prompts are retained or used for training/i);
  assert.match(doc, /limited time/i);
  assert.match(doc, /never stored/i);
  assert.match(doc, /Not verified/);
  assert.match(doc, /JEV_NOTICE_VERSION/);
  assert.match(doc, /--provider/);
});

test('the first paragraph says plainly that Jev is only ever an experimental feature, hidden unless shown, and promises nothing about its future', () => {
  const first = doc.replace(/\r\n/g, '\n').split('\n\n')[1];
  assert.match(first, /Jev is only ever an experimental feature of this plugin/);
  assert.match(first, /opt-in, off by default, hidden until a learner turns on \*Show experimental\s+features\*/);
  assert.match(first, /nothing in StudyHub depends on it/);
  assert.doesNotMatch(doc, /for now|until stable|will become the default|recommended provider/i);
});

test('the audit lists every replaceable site and marks which are wired and which are audited only', () => {
  for (const site of JEV_REPLACE_SITES) assert.ok(doc.includes(`**wired: \`${site}\``), `${site} is marked wired`);
  const rows = doc.split('\n').filter(line => /^\| (G\d|F\d|V\d) \|/.test(line));
  assert.ok(rows.length >= 18, `the audit has its rows (${rows.length})`);
  assert.ok(rows.every(row => /wired|not replaceable|audited, not wired/.test(row)), 'every row has a status');
  assert.match(doc, /Jev returns \*\*no free text\*\*/);
  assert.match(doc, /byte-identical/);
});
