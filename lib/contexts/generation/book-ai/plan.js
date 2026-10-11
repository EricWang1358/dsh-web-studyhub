import { createHash } from 'node:crypto';
import { buildOutlineIndex } from '../../../course-outline-index.js';
import { documentIndex, leafSegments } from '../../../course-book-inputs.js';
import { genFile, mineFile, recordOf } from '../../../course-book-files.js';
import { anchorIn, headingAnchor, shortHash } from '../../../course-book-ai-text.js';
import { excerpt } from '../../../course-book-reading.js';
import { REFUSALS, jobTitle } from './jobs/messages.js';

/* The plan of one explain / add-a-paragraph task of the review book, pure: no model, no write, no clock. It finds the knowledge point (by its heading id),
   the words the learner selected in its generated or own file (their anchor: lib/course-book-ai-text.js anchorIn), and the point's materials (the
   passages its anchors hold, cut to size the way the book build cuts them). It refuses, in the learner's words and with a code, before anything starts. */

export const MATERIAL_CHARS = 12000;
const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const clip = (value, size) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

/**
 * @param request { course, heading (a point's heading id), words? (the selected text), instruction?, mode: 'explain' | 'write' | 'here' | 'follow', after?, replace?, language }
 * @returns { course, language, mode, leaf, title, about, at, words, instruction, passage, materials, after, replace, key, title }
 */
export function planAi(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh', course = request.course;
  const record = typeof course === 'string' ? recordOf(state, course) : null;
  if (!record) throw refuse('course-book-ai-no-book', language);
  const doc = record.bookDoc, leaf = leavesOf(doc.manifest.nodes).find(node => node.hid === request.heading || node.id === request.leafId);
  if (!leaf) throw refuse('course-book-ai-no-point', language);
  const mode = ['explain', 'write', 'here', 'follow'].includes(request.mode) ? request.mode : 'explain';
  const words = clip(request.words, 600), instruction = clip(request.instruction, 600);
  if ((mode !== 'here' && !words) || (mode !== 'explain' && !instruction)) throw refuse('course-book-ai-no-request', language);
  const texts = [doc.files[genFile(leaf.id)]?.text ?? '', doc.files[mineFile(leaf.id)]?.text ?? ''];
  // The anchor: the selected words in the point's own text (else the words alone, hashed); a 加一段 sits under the heading.
  const anchor = words ? texts.map(text => anchorIn(text, words)).find(Boolean) : null;
  const at = mode === 'here' ? headingAnchor(leaf.hid) : anchor?.hash ?? shortHash(words);
  const passage = anchor ? texts.find(text => anchorIn(text, words))?.slice(Math.max(0, anchor.start - 600), anchor.end + 600) ?? '' : '';
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  const segments = leafSegments(byId, documentIndex(buildOutlineIndex(state, { course }).allDocuments), leaf.anchors || []);
  if (!segments.length) throw refuse('course-book-ai-no-materials', language);
  const materials = excerpt(segments, MATERIAL_CHARS);
  const key = createHash('sha1').update(JSON.stringify([course, leaf.id, mode, words, instruction, request.after ?? null, request.replace ?? null])).digest('hex').slice(0, 16);
  return { course, language, mode, leaf: { id: leaf.id, hid: leaf.hid, title: leaf.title }, about: mode === 'here' ? leaf.title : words, at, words, instruction, passage,
    materials, segments, after: request.after ?? null, replace: request.replace ?? null, key, title: jobTitle(language, mode, clip(leaf.title, 40)) };
}
