/* The input schemas of the 复习全书's write actions (#465, #470): study_capabilities {operation} shows them, so a caller finds the shape without
   trying (lib/runtime/tools.js). The runtime checks the types and the required keys before an action runs (lib/runtime.js validate); the values are
   checked by the actions themselves, with refusals that name what is allowed (lib/course-book-edit.js, lib/course-book-structure.js,
   lib/book-agent-write.js). No enums here on purpose: the runtime's own message for an enum names no allowed value, the action's does. */
import { FILE_TEXT_MAX } from '../../course-book-edit.js';
import { EDITS_MAX, WRITE_CHARS } from '../../book-agent-write.js';
import { DELETE_CHILDREN, SECTION_OPS, SECTION_POSITIONS } from '../../book-section-ops.js';
import { DELETE_NODE_CHILDREN, STRUCTURE_FILE } from '../../course-book-structure.js';
import { MAX_TITLE_CHARS } from '../../document-title.js';

const text = description => ({ type: 'string', description });
const integer = description => ({ type: 'integer', description });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: true, properties, ...(required.length ? { required } : {}) });
const course = { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'The course (left out: the current course; "" is the uncategorised one).' };
const structureVersion = integer('The book\'s structureVersion as book.toc or course.book.open said it (compare-and-set: a stale one is refused with course-book-conflict).');
const answer = text('brief (default): a small answer; book: the whole book like course.book.open.');
const nodeId = text('The hid of a chapter, section or knowledge point (book.toc lists them).');
const result = { type: 'object', additionalProperties: true };

export const bookActionSchemas = {
  'course.book.save': { output: result, input: object({ course, file: text('The file name, such as p12.gen.md, p12.mine.md, p12.qa.md or unplaced.md (course.book.open lists them).'),
    text: text(`The WHOLE text of that one file (not a part, not the book), at most ${FILE_TEXT_MAX} characters.`), version: integer('The file\'s version the text was started from (course.book.open says it).') }),
  description: `Save the whole text of ONE file of the review book (required: file, text, version; at most ${FILE_TEXT_MAX} characters), compare-and-set on the file's version: a file changed meanwhile keeps this text and offers the other as a suggestion. For one point's section use book.write; for the book's chapters and points use course.book.rename / move / delete.` },
  'course.book.rename': { output: result, input: object({ course, hid: nodeId, title: text(`The new title: one line, 1-${MAX_TITLE_CHARS} characters, not the same as a node next to it.`), version: structureVersion, answer }, ['hid', 'version']),
    description: 'Rename a chapter, section or knowledge point of the review book (required: hid, title, version). Only the title the book shows changes: the id, files and questions stay, the outline keeps its own title and is not rebuilt; a rebuilt outline keeps this title for the same point. Undo: course.book.revert {file: "book.structure"}.' },
  'course.book.move': { output: result, input: object({ course, hid: nodeId, toParent: text('The hid of the chapter or section to move it under (last there), or "book" for the top level.'),
    afterHid: text('Put it right after this node (with toParent too, a node directly under toParent).'), beforeHid: text('Put it right before this node.'), version: structureVersion, answer }, ['hid', 'version']),
    description: 'Move a chapter, section or knowledge point of the review book with everything below it (required: hid, version, and toParent, afterHid or beforeHid). Its id, files and questions go with it; the headings in its files follow its new depth. Never inside itself; a knowledge point holds no other node. Undo: course.book.revert {file: "book.structure"}.' },
  'course.book.delete': { output: result, input: object({ course, hid: nodeId, children: text(`${DELETE_NODE_CHILDREN.join(' | ')}: promote (default) puts what is below it in its place; toUnplaced removes all below it too and keeps what the learner wrote there in 未归位.`),
    version: structureVersion, answer }, ['hid', 'version']),
    description: `Delete a chapter, section or knowledge point of the review book (required: hid, version), leaving nothing in its place (no empty heading, no placeholder text). A point's files go with it; everything removed stays in the version history: course.book.revert {file: "${STRUCTURE_FILE}"} brings it back.` },
  'book.write': { output: result, input: object({ course, hid: text('The knowledge point (book.toc lists them).'), file: text('gen (default), mine or qa.'),
    markdown: text(`The whole file (at most ${WRITE_CHARS} characters).`), section: object({ heading: text('A heading id or title (op insert: the new title).'), markdown: text('The section\'s text.') }),
    edits: { type: 'array', items: object({ find: text('Exact words, once in the file.'), replace: text('Their replacement.') }), description: `1-${EDITS_MAX} exact replacements.` },
    op: text(`${SECTION_OPS.join(' | ')}: the file's sections as a tree, by heading id (book.read lists them); leave it out for markdown, section or edits.`),
    heading: text('delete / rename / move: the id of the heading.'), title: text('rename: the new title.'),
    children: text(`delete: ${DELETE_CHILDREN.join(' | ')} (promote, the default, lifts its sub-sections one level).`),
    after: text('insert / move: right after this heading (and all below it).'), before: text('insert / move: right before this heading.'),
    within: text('insert / move: as the last sub-section of this heading.'), position: text(`insert / move: ${SECTION_POSITIONS.join(' | ')} of the file.`),
    version: integer('The file\'s version you read (a stale one: a whole file is still saved and the other text kept as a suggestion; a section or op is applied to the file as it is now).') }, ['hid']),
    description: `Write ONE knowledge point's file of the review book from the chat: the whole file (markdown), one section (section), exact edits, or a section op (op ${SECTION_OPS.join('/')} with heading ids: insert at a place instead of the end, delete without a shell, rename, move). At most ${WRITE_CHARS} characters a call. Footnotes are checked word for word against the materials.` },
};
