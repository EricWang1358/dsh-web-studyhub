/* The input schemas of the 复习全书's write actions (#465, #470) and of source.courses.set, which files the pages the book is built from (#465):
   study_capabilities {operation} shows them, so a caller finds the keys without trying (lib/runtime/tools.js). Short on purpose: the host cuts a tool result at 8 192 characters and these sit in the library context's listing; the
   prose is the book area of library.context (lib/study-contracts.js) and docs/review-book-agent.md. The runtime checks what a schema declares BEFORE
   the action runs (lib/runtime.js validate: a plain message, no code, not localised), so:
   - course.book.save and book.write only NAME their keys (no type, no required): every mistake there reaches the action and gets its own coded,
     bilingual refusal (course-book-text-missing, course-book-version-required, book-write-mode, book-point-missing, book-write-op, ...);
   - course.book.rename / move / delete declare `hid` and `version` required with their types: a call without them is the caller's bug the schema
     names; every value (titles, places, children) is checked by the action, with refusals that name what is allowed;
   - source.courses.set names the keys of an assignment and nothing else: a call without `assignments`, or with an id that is a document's, gets the action's
     own bilingual message (lib/source-courses.js), which says the shape. */
import { FILE_TEXT_MAX } from '../../course-book-edit.js';
import { WRITE_CHARS } from '../../book-agent-write.js';

const keys = names => Object.fromEntries(names.map(name => [name, {}]));
const typed = (properties, required) => ({ type: 'object', properties, required });
const string = { type: 'string' }, integer = { type: 'integer' };

export const bookActionSchemas = {
  'course.book.save': { input: { type: 'object', properties: keys(['course', 'file', 'text', 'version']) },
    description: `One file's text (<=${FILE_TEXT_MAX} chars), version compare-and-set.` },
  'course.book.rename': { input: typed({ hid: string, title: string, version: integer }, ['hid', 'version']),
    description: 'Rename a chapter or point. version: structureVersion.' },
  'course.book.move': { input: typed({ hid: string, toParent: string, afterHid: string, beforeHid: string, version: integer }, ['hid', 'version']),
    description: 'Move a node with all below. toParent (hid|book), afterHid or beforeHid.' },
  'course.book.delete': { input: typed({ hid: string, children: string, version: integer }, ['hid', 'version']),
    description: 'Delete a node; children promote|toUnplaced; own text goes to 未归位.' },
  'course.book.place': { input: { type: 'object', properties: keys(['section', 'toHid', 'version']) }, description: 'Put 未归位 section in point.' },
  'course.book.rebuild': { input: { type: 'object', properties: keys(['action', 'outlineId']) }, description: 'apply|undo' },
  'book.write': { input: { type: 'object', properties: keys(['hid', 'file', 'markdown', 'section', 'edits', 'op', 'heading', 'title', 'children', 'after', 'before', 'within', 'position', 'version']) },
    description: `One point's file: markdown|section|edits|op insert/delete/rename/move by heading id; <=${WRITE_CHARS} chars.` },
  'source.courses.set': { input: { type: 'object', properties: { assignments: { items: { properties: keys(['id', 'courses', 'expectedCourses']) } } } },
    description: 'Pages to courses: assignments [{id: page id (not document-…), courses, expectedCourses?}], 1–5000; [] unassigns.' },
};
