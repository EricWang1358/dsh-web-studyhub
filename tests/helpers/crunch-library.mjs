/* A small library with a review book of two points, for the tests of 期末一周 and 备考计划 (the same library tests/course-book-crunch.test.mjs builds). */
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
const options = [{ id: 'a', text: 'Yes', correct: true }, { id: 'b', text: 'No', correct: false }];


/** Two points of lecture 1: 'what' (chapter 0: six single choice, one multiple choice, one open question and flashcards) and 'who' (chapter 1: flashcards only). */
export function library() {
  const { sources, decks } = outlineLibrary();
  const deck = decks.find(item => item.id === 'deck-l1');
  deck.cards.slice(0, 6).forEach(card => Object.assign(card, { kind: 'quiz', options }));
  Object.assign(deck.cards[6], { kind: 'multi', options: [...options, { id: 'c', text: 'Both', correct: true }] });
  Object.assign(deck.cards[7], { kind: 'open', answer: 'A decision and its reasons.' });
  const state = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  return { state, deck };
}

export async function service(t, { book = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-crunch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const { state, deck } = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  if (book) await study.call('course.book.open');
  const opened = await study.call('course.book.open');
  const [what, who] = opened.nodes[0].children;
  return { study, deck, what, who };
}
