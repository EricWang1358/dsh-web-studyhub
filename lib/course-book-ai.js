/* 弄懂 / 「加一段」 (M4, docs/plans/review-book.md): the writes of an AI block into a point's own file (`<leaf>.mine.md`), and the learner's 保留 / 删除 of one.
   Mutations of the state, no I/O; the writer queue and the version history are the callers' (lib/course-book-writer.js). Only the own file is written, and
   only by a NEW block (or the block the learner asked to write again): existing text is never edited. The text format is lib/course-book-ai-text.js.

   writeAiBlock(state, { course, leafId, id, at, about, body, mode?, ask?, after?, replace? }) -> { status: 'written', file, before }
     `after`: the block a follow-up continues (the new one goes under it); `replace`: the block 重新生成 writes again (it is replaced whole).
   course.book.block { course?, file, id, action: 'keep' | 'delete' } -> { status: 'kept' | 'deleted' | 'unchanged', before } */
import { courseOf, mineFile, recordOf } from './course-book-files.js';
import { aiBlock, aiBlocks, insertAiBlock, replaceAiBlock } from './course-book-ai-text.js';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const touch = doc => Object.assign(doc, { revision: doc.revision + 1, updatedAt: new Date().toISOString() });
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

/** The block of the 弄懂 task in the point's own file. */
export function writeAiBlock(state, args = {}) {
  const record = recordOf(state, args.course);
  if (!record) fail('这门课还没有复习全书 / This course has no review book', 'course-book-missing');
  const doc = record.bookDoc;
  if (!leavesOf(doc.manifest.nodes).some(leaf => leaf.id === args.leafId)) fail('这个知识点已不在书里 / This point is no longer in the book', 'course-book-ai-point-gone');
  const name = mineFile(args.leafId), file = doc.files[name] || (doc.files[name] = { text: '', version: 1 });
  const before = { file: name, version: file.version, text: file.text };
  const block = aiBlock({ id: args.id, at: args.at, about: args.about, body: args.body, mode: args.mode, ask: args.ask }, doc.language);
  const replaced = args.replace ? replaceAiBlock(file.text, args.replace, block) : null;
  Object.assign(file, { text: replaced ?? insertAiBlock(file.text, block, { after: args.after }), version: file.version + 1 });
  touch(doc);
  return { status: 'written', file: name, before };
}

/** course.book.block: 保留 marks the block as the learner's (state=kept), 删除 takes it out. */
export function aiBlockAction(state, args = {}) {
  if (args.action !== 'keep' && args.action !== 'delete') fail('action must be keep or delete', 'course-book-action-invalid');
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  const file = record?.bookDoc.files[args.file], block = file ? aiBlocks(file.text).find(item => item.id === args.id) : null;
  if (!block) return { status: 'unchanged', before: null };
  const before = { file: args.file, version: file.version, text: file.text };
  const next = args.action === 'delete' ? replaceAiBlock(file.text, block.id, '') : replaceAiBlock(file.text, block.id, block.raw.replace(/^(<!-- sh:ai [^\n]*?) state=new\b/, '$1 state=kept'));
  if (next === file.text) return { status: 'unchanged', before: null };
  Object.assign(file, { text: next, version: file.version + 1 });
  touch(record.bookDoc);
  return { status: args.action === 'delete' ? 'deleted' : 'kept', before };
}
