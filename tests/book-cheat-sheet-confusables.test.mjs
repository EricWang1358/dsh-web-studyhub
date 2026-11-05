/* The 速查表 (#710 S5) shows the comparisons a build wrote (#710 S3): the two were built side by side, each against the agreed shape, so this pins the join.
   A book built on the fake model with confusable pairs, opened as the page opens it, laid out as the sheet lays it out. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { seedConfusableBook } from './helpers/book-fixtures.mjs';
import { COURSE } from './helpers/course-outline-library.mjs';
import { cheatSheet } from '../ui/book/cheat-sheet-model.js';
import { cheatSheetHtml } from '../ui/book/cheat-sheet-html.js';

test('the comparisons a build wrote are on the 速查表, each with its two cards', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-cheat-confusables-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }));
  await seedConfusableBook(root);
  const service = new StudyService(root);
  try {
    const book = await service.call('course.book.open', { course: COURSE });
    assert.ok(book.confusables?.length > 0, 'the build wrote comparisons');
    const sheet = cheatSheet(book);
    assert.equal(sheet.confusables.length, book.confusables.length, 'every comparison is on the sheet');
    assert.equal(sheet.counts.confusables, book.confusables.length);
    const codes = new Set(sheet.chapters.flatMap(chapter => chapter.cards.map(card => card.code)));
    for (const pair of sheet.confusables) assert.ok(pair.items.every(code => codes.has(code)), `${pair.id} names cards on the sheet`);
    const html = cheatSheetHtml(sheet);
    assert.ok(html.includes(sheet.confusables[0].id) && html.includes(sheet.confusables[0].names[0]));
  } finally { await service.dispose(); }
});
