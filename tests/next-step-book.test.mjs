/* 3.7 guidance step 3 (fix pass): the 下一步 card offers 复习全书 only for a course that has one. The snapshot says which courses do (bookCourses), read from the
   library as it is: a current 总纲 and the 复习全书 notes written from it, both not archived. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';

test('the snapshot names the courses that have a review book; a library without one names none', async () => {
  const base = await mkdtemp(join(tmpdir(), 'study-book-courses-'));
  const root = join(base, 'library');
  try {
    await seedBookFixture(root, 'archss');
    const service = new StudyService(root, {});
    assert.deepEqual((await service.call('snapshot')).bookCourses, [BOOK_COURSE]);
    await service.store.update(state => { for (const source of state.sources) if (source.courseNotes) source.archived = true; });
    assert.deepEqual((await service.call('snapshot')).bookCourses, [], 'archived notes: no book to open');
    await service.store.update(state => { for (const source of state.sources) if (source.courseNotes) source.archived = false; else if (source.courseOutline) source.archived = true; });
    assert.deepEqual((await service.call('snapshot')).bookCourses, [], 'notes without a current outline: the book page is not a book');
    await service.store.update(state => { for (const source of state.sources) if (source.courseOutline) source.archived = false; });
    assert.deepEqual((await service.call('snapshot')).bookCourses, [BOOK_COURSE], 'both back: a book again');
    await service.store.update(state => { for (const source of state.sources) if (source.courseNotes) source.archived = true; });
    await service.dispose();
    const empty = new StudyService(join(base, 'empty'), {});
    assert.deepEqual((await empty.call('snapshot')).bookCourses, []);
    await empty.dispose();
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
});
