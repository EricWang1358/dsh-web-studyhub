/* A course with a 复习全书 for the main chat's book tools (docs/review-book-agent.md): the synthetic library of tests/helpers/course-outline-library.mjs,
   an outline of two knowledge points of lecture 1 ('what': chapter 0, pages 1-2; 'who': chapter 1, pages 3-4) and notes citing page 1. With `long`
   the four pages hold about 3 000 characters each, so the page caps show. No model, no network. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { courseOutlineMaterial, materialsFingerprint } from '../../lib/course-outline-book.js';
import { courseNotesMaterial } from '../../lib/course-book.js';
import { buildOutlineIndex } from '../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { COURSE, outlineLibrary } from './course-outline-library.mjs';

export { COURSE };
export const pageLine = (id, i) => `${id} line ${i}: the architect writes down why each decision was taken, and who agreed to it.`;

/** `chapters` ([{ id, title, children }], or a function (lecture 1's document key, n -> lecture n's) giving them) lays out a bigger book (several chapters) in place of the one chapter of `points`. */
export function bookLibrary({ long = false, language = 'zh', points = null, chapters = null } = {}) {
  const { sources, decks } = outlineLibrary();
  // Each page its own text (the fixture's two pages of a chapter are copies, which a point counts once).
  for (const source of sources) if (/^document-l1-p[1-4]$/.test(source.id)) source.text = long ? Array.from({ length: 32 }, (_, i) => pageLine(source.id, i)).join('\n') : `${source.text} ${pageLine(source.id, 0)}`;
  const state = { sources, decks, documents: [], drafts: [], attempts: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const nodes = (typeof chapters === 'function' ? chapters(lecture, n => groupSourcesByDocument(sources).find(item => item.sourceIds.includes(`document-l${n}-p1`)).key) : chapters) ?? [{ id: 'c1', title: 'Introduction', children: points ?? [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }];
  const children = nodes.flatMap(node => node.children);
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: children.length, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1');
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language, papers: [], counts: {}, leaves: children.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  return { state, lecture, outline };
}

/** A service over a fresh library folder holding that library (the book not opened yet). */
export async function bookService(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { state, lecture, outline } = bookLibrary(options);
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  return { study, root, lecture, outline };
}

/** The serialized size of a result, as the host's tool output measures it. */
export const sizeOf = value => JSON.stringify(value).length;
