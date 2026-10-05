import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { fileNameOf } from '../lib/document-title.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { materialRelations } from '../lib/source-relations.js';
import { loadUi } from './helpers/ui-module.mjs';

/* #207: a material is never named by the host's attachment storage path. The name is the file name: fixed where the title is written
   (source.add with a path as its title), and as a fallback for what is already stored. Materials made from one original file (the PDF, a
   text version, a diagram-normalized text) show how they belong together. */

const HOST_PATH = 'C:\\Users\\Eric1\\.dsh\\attachments\\v1\\files\\15\\15dd8b13a5318c2f6e1d\\01. Introduction to Solution Architecture v2.1.pdf';
const NAME = '01. Introduction to Solution Architecture v2.1.pdf';

test('fileNameOf keeps only the file name of a path, and leaves every other title alone', () => {
  assert.equal(fileNameOf(HOST_PATH), NAME);
  assert.equal(fileNameOf('\\\\server\\share\\dir\\notes.md'), 'notes.md');
  assert.equal(fileNameOf('/home/eric/.dsh/attachments/v1/files/ab/abcd/lecture 3.pdf'), 'lecture 3.pdf');
  assert.equal(fileNameOf(`${HOST_PATH} · p.3`), `${NAME} · p.3`, 'a page title keeps its page suffix');
  assert.equal(fileNameOf(`${HOST_PATH} (diagram-normalized text)`), `${NAME} (diagram-normalized text)`);
  assert.equal(fileNameOf('Week 3 / Replication'), 'Week 3 / Replication', 'a slash inside a normal title is not a path');
  assert.equal(fileNameOf('第 3 讲 一致性'), '第 3 讲 一致性');
  assert.equal(fileNameOf('C:\\'), 'C:\\', 'nothing is left of a bare root, so it stays');
  assert.equal(fileNameOf(''), '');
  assert.equal(fileNameOf(undefined), '');
});

test('source.add stores the file name when it is given a path as the title', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'source-title-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', { title: HOST_PATH, text: 'The architecture views of a solution: context, container and component.' });
  await service.call('source.add', { title: 'Week 3 / Replication', text: 'Leaders, followers and quorum reads.' });
  const { sources } = await service.call('snapshot');
  assert.deepEqual(sources.map((source) => source.title).sort(), [NAME, 'Week 3 / Replication'].sort());
  assert.ok(!sources.some((source) => /[\\/]\.dsh[\\/]/.test(source.title)), 'no host storage path is stored');
});

test('a material already stored with a path title is listed by its file name', () => {
  const stored = [
    { id: 'a', title: HOST_PATH, text: 'x'.repeat(40), createdAt: '2026-10-01T10:00:00Z', courses: [] },
    { id: 'b', title: `${HOST_PATH} · p.1`, text: 'y'.repeat(40), createdAt: '2026-10-01T10:00:00Z', courses: [], document: { id: 'f'.repeat(64), filename: HOST_PATH, page: 1, totalPages: 1, extractionVersion: 2, format: 'pdf' } },
  ];
  const titles = groupSourcesByDocument(stored).map((item) => item.title).sort();
  assert.deepEqual(titles, [NAME, NAME]);
});

const item = (key, title, format, extra = {}) => ({ key, title, format, filename: extra.filename || '', sourceIds: [key], pages: [{ sourceId: key, page: 1, chars: 10 }], courses: [], warnings: [], chars: 10, ...extra });

test('materials made from one original are related: original, derived text, diagram-normalized text', () => {
  const items = [
    item('pdf', NAME, 'pdf', { filename: NAME }),
    item('txt', NAME.replace(/\.pdf$/, ' (diagram-normalized text)'), 'text'),
    item('md', NAME, 'md'),
    item('other', 'Week 3 notes', 'text'),
  ];
  const related = materialRelations(items);
  assert.equal(related.get('other'), undefined, 'an unrelated material has no relation');
  assert.deepEqual({ role: related.get('pdf').role, count: related.get('pdf').derived }, { role: 'original', count: 2 });
  assert.equal(related.get('txt').role, 'derived');
  assert.equal(related.get('txt').of, NAME);
  assert.equal(related.get('md').role, 'derived');
  const loose = materialRelations([item('a', 'Lecture 4', 'text'), item('b', 'Lecture 4 (cleaned)', 'text')]);
  assert.deepEqual([loose.get('a').role, loose.get('a').count], ['same', 2], 'without an original file they are only said to belong together');
  assert.equal(materialRelations([item('solo', NAME, 'pdf', { filename: NAME })]).size, 0, 'one material is related to nothing');
});

test('the picker names the file, never the storage path, and says how related materials belong together', async () => {
  const { default: SourcePicker } = await loadUi(`export { default } from './ui/SourcePicker.jsx';`);
  const source = (id, title, text, extra = {}) => ({ id, title, text, createdAt: '2026-10-01T10:00:00Z', courses: [], ...extra });
  const sources = [
    source('a', HOST_PATH, 'The architecture views of a solution.'),
    source('b', `${NAME} (diagram-normalized text)`, 'Context diagram: users, system, partners.'),
    source('p1', `${NAME} · p.1`, 'Page one of the introduction lecture on solution architecture.', { document: { id: 'e'.repeat(64), filename: NAME, page: 1, totalPages: 1, extractionVersion: 2, format: 'pdf' } }),
  ];
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { sources, selected: [], onChange() {} }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /Users|\.dsh|attachments/, 'the storage path is not shown');
  assert.match(text, /派生自 01\. Introduction to Solution Architecture v2\.1(?!\.pdf)/, 'the original is named as everywhere else: without the extension');
  assert.match(text, /另有 2 份派生资料/);
});
