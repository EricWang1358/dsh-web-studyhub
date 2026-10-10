/* 复习全书 M2 (docs/plans/review-book.md): the learner edits the book's files. Mutations of the state, no I/O; the ops (lib/contexts/library/operations.js) run
   them one at a time per course (one writer queue) inside one store transaction each (the record is written whole or not at all), and keep the text
   each one replaces in the version history (lib/course-book-history.js, outside the library's sources).

   course.book.save { course?, file, text, version }: the learner's text of one file, compare-and-set on the file's `version`. A heading without an id
   gets one (assignHeadingIds, with every id of the manifest and of the other files taken, so a typed heading never takes the outline's). When the file
   changed since `version` (a program write, or another editor), the learner's text is still saved (their unsaved edits are kept) and the other text is
   kept as a suggestion (`kind: 'theirs'`) to take back with 采用: status 'merged' (the page says 书已更新). Editing a generated file forks it (the program
   then never writes over it, lib/course-book-files.js). -> { status: 'saved' | 'merged' | 'unchanged', before }.
   course.book.suggestion { course?, file, action: 'accept' | 'ignore', version }: 采用 takes the suggested text as the file's; 忽略 drops it (a generated
   text set aside is not offered again).
   revertBookFile: the text of an earlier version back, as a new version (回退到上一版). */
import { assignHeadingIds, bookIndex } from './course-book-links.js';
import { courseOf, recordOf, textHash } from './course-book-files.js';

export const FILE_TEXT_MAX = 400_000;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const isGen = name => name.endsWith('.gen.md');

function bookOf(state, args) {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  if (!record) fail('这门课还没有复习全书，先打开书页 / This course has no review book yet; open the book page first', 'course-book-missing');
  return { course, doc: record.bookDoc };
}
function fileOf(doc, name) {
  if (typeof name !== 'string' || !Object.hasOwn(doc.files, name)) fail('书里没有这份文件 / The book has no such file', 'course-book-file-missing');
  return doc.files[name];
}
const checkVersion = version => { if (!Number.isInteger(version)) fail('version is required (the file version the edit started from)', 'course-book-version-required'); };
const touch = doc => Object.assign(doc, { revision: doc.revision + 1, updatedAt: new Date().toISOString() });

/** Every heading id of the book except those of `except`: the manifest's, the book's and 未归位's own, and those written in the other files. */
export function takenIds(doc, except) {
  const ids = ['book', 'unplaced'], walk = list => (list || []).forEach(node => { ids.push(node.hid); walk(node.children); });
  walk(doc.manifest?.nodes);
  for (const [name, file] of Object.entries(doc.files)) if (name !== except) for (const heading of bookIndex(file.text).flat) if (heading.id) ids.push(heading.id);
  return ids;
}

/** course.book.save (see the top of this file). */
export function saveBookFile(state, args = {}) {
  if (typeof args.text !== 'string' || args.text.length > FILE_TEXT_MAX) fail(`text must be a string of at most ${FILE_TEXT_MAX} characters`, 'course-book-text-invalid');
  checkVersion(args.version);
  const { doc } = bookOf(state, args), file = fileOf(doc, args.file);
  const named = assignHeadingIds(args.text.replace(/\r\n?/g, '\n'), { next: doc.nextId, taken: takenIds(doc, args.file) });
  if (named.text === file.text) return { status: 'unchanged', before: null };
  const before = { file: args.file, version: file.version, text: file.text };
  const conflict = args.version !== file.version;
  if (conflict) file.suggestion = { text: file.text, kind: 'theirs' };
  Object.assign(file, { text: named.text, version: file.version + 1 });
  doc.nextId = Math.max(doc.nextId || 1, named.next);
  if (isGen(args.file)) {
    file.forked = named.text !== (file.generated ?? '');
    if (!file.forked && file.suggestion?.kind === 'generated') delete file.suggestion;
  }
  touch(doc);
  return { status: conflict ? 'merged' : 'saved', before };
}

/** course.book.suggestion (see the top of this file). */
export function bookSuggestion(state, args = {}) {
  if (args.action !== 'accept' && args.action !== 'ignore') fail('action must be accept or ignore', 'course-book-action-invalid');
  checkVersion(args.version);
  const { doc } = bookOf(state, args), file = fileOf(doc, args.file);
  if (!file.suggestion) return { status: 'unchanged', before: null };
  if (args.version !== file.version) fail('书已更新，请看一下新的内容再决定 / The book changed; look at it again before deciding', 'course-book-conflict');
  const before = { file: args.file, version: file.version, text: file.text };
  if (args.action === 'accept') {
    Object.assign(file, { text: file.suggestion.text, version: file.version + 1 });
    if (isGen(args.file)) file.forked = file.text !== (file.generated ?? '');
  } else if (file.suggestion.kind === 'generated') file.ignored = textHash(file.suggestion.text);
  delete file.suggestion;
  touch(doc);
  return { status: args.action === 'accept' ? 'accepted' : 'ignored', before: args.action === 'accept' ? before : null };
}

/** 回退到上一版: `text` (an earlier version from the history) becomes the file's text as a new version. A generated file that no longer matches what the program wrote is forked, so the program does not write over what was taken back. */
export function revertBookFile(state, args = {}) {
  const { doc } = bookOf(state, args), file = fileOf(doc, args.file);
  if (typeof args.text !== 'string') fail('没有更早的版本 / There is no earlier version', 'course-book-no-version');
  const before = { file: args.file, version: file.version, text: file.text };
  Object.assign(file, { text: args.text, version: file.version + 1 });
  if (isGen(args.file)) file.forked = file.text !== (file.generated ?? '');
  delete file.suggestion;
  touch(doc);
  return { status: 'reverted', before };
}
