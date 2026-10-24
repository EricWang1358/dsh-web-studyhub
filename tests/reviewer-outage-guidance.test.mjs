// #463 / #464: the permission review ("auto-review") belongs to the DSH host, not to StudyHub. What this repo can do is state truthfully what it declares
// and tell the learner and the chat what to do when the host's review fails. These checks pin both, so the guidance does not drift from the declarations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writesFor } from '../lib/runtime/domain-contracts.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('what StudyHub declares for the book calls: course.book.save and book.write write the same records, the read calls write nothing', () => {
  assert.deepEqual(writesFor('library', 'course.book.save'), ['sources']);
  assert.deepEqual(writesFor('library', 'book.write'), writesFor('library', 'course.book.save'));
  // book.toc brings the book up to date first, so it is declared as a write on purpose.
  assert.deepEqual(writesFor('library', 'book.toc'), ['sources']);
  for (const action of ['book.read', 'book.coverage', 'source.pages', 'source.list']) assert.deepEqual(writesFor('library', action), [], action);
});

test('docs (English and 简体中文) say that a failing permission review comes from the host and what to do, without promising a workaround', async () => {
  const en = await read('docs/review-book-agent.md'), zh = await read('docs/review-book-agent.zh-CN.md');
  assert.match(en, /### If the permission review itself fails/);
  assert.match(en, /INVALID_REQUEST/);
  assert.match(en, /DSH/);
  assert.match(zh, /### 权限审查本身出错时/);
  assert.match(zh, /INVALID_REQUEST/);
  assert.match(zh, /DSH/);
});

test('the study-book skill tells the chat to stop and report a review failure instead of retrying or switching to a heavier call', async () => {
  const skill = await read('skills/study-book/SKILL.md');
  assert.match(skill, /INVALID_REQUEST/);
  assert.match(skill, /do not retry/i);
  assert.match(skill, /course\.book\.save/);
});
