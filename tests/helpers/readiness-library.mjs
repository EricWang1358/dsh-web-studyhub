/* A small library with a review book of three chapters for the tests of 章节准备度 and 补齐 (深度定制 S5, lib/custom-readiness.js):
     c1 Introduction   what (4 questions), who (2 questions): written, with answers
     c2 Requirements   fr, qa, tr: written, no question at all
     c3 Patterns       layers (2 questions, 1 answered, 1 sent back in a draft): not written yet (未生成)
   The days are counted back from today, so the answers are as old as the test says. */
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
const DAY = 86400e3;
export const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();
const attempt = (deckId, quizId, grade, days) => ({ id: `a-${quizId}-${days}-${grade}`, quiz_id: quizId, deckId, timestamp: daysAgo(days), grade, assessment: 'graded' });

export function library() {
  const { sources, decks: all } = outlineLibrary();
  const pick = (id, from, count) => all.find(deck => deck.id === id).cards.slice(from, from + count);
  const l1 = all.find(deck => deck.id === 'deck-l1'), l2 = all.find(deck => deck.id === 'deck-l2'), l3 = all.find(deck => deck.id === 'deck-l3');
  const what = pick('deck-l1', 0, 4), who = pick('deck-l1', 25, 2), layers = pick('deck-l3', 0, 2), draftCard = { ...pick('deck-l3', 3, 1)[0], id: 'draft-q1' };
  l1.cards = [...what, ...who]; l2.cards = []; l3.cards = layers;
  const decks = [l1, l2, l3];
  const state = { sources, decks, focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const key = id => groupSourcesByDocument(sources).find(item => item.sourceIds.includes(id)).key;
  const [k1, k2, k3] = ['document-l1-p1', 'document-l2-p1', 'document-l3-p1'].map(key);
  const node = (id, title, anchors) => ({ id, title, anchors });
  const nodes = [
    { id: 'c1', title: 'Introduction', children: [node('what', 'What architects do', [`${k1}#0`]), node('who', 'Stakeholders', [`${k1}#1`])] },
    { id: 'c2', title: 'Requirements', children: [node('fr', 'Functional requirements', [`${k2}#0`]), node('qa', 'Quality attributes', [`${k2}#1`]), node('tr', 'Trade-offs', [`${k2}#2`])] },
    { id: 'c3', title: 'Patterns', children: [node('layers', 'Layers', [`${k3}#0`])] },
  ];
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] },
    fingerprint: materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [], attempts: [] }, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 6, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  sources.push(outline);
  const written = nodes.slice(0, 2).flatMap(chapter => chapter.children);
  sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: written.map(leaf => {
    const page = sources.find(source => source.id === `document-l${leaf.anchors[0].includes(k1) ? 1 : 2}-p1`);
    return { id: leaf.id, title: leaf.title, anchors: leaf.anchors, body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`,
      cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } };
  }) }), createdAt: '2026-10-09T01:00:00.000Z' });
  const [q1, q2, q3] = what, [w1, w2] = who, [l1q] = layers;
  const attempts = [
    // what: q1 right on two days (solid), q2 right once, q3 wrong (weak), q4 never answered: one solid of four, one weak: the point is not solid.
    attempt('deck-l1', q1.id, 4, 2), attempt('deck-l1', q1.id, 4, 1), attempt('deck-l1', q2.id, 4, 0), attempt('deck-l1', q3.id, 1, 0),
    // who: w1 is 已掌握 by its schedule after one right answer, w2 right on two days: both solid, so the point is.
    attempt('deck-l1', w1.id, 4, 0), attempt('deck-l1', w2.id, 4, 3), attempt('deck-l1', w2.id, 4, 1),
    // layers: answered once.
    attempt('deck-l3', l1q.id, 4, 0),
  ];
  Object.assign(w1, { review: { interval_days: 30, repetitions: 3, due_at: daysAgo(-20) } });
  const drafts = [{ id: 'draft-1', title: 'Patterns draft', course: COURSE, cards: [draftCard], editorial: { rejectedIssues: { 'draft-q1': ['The options give the answer away.'] } } }];
  return { state, attempts, drafts, ids: { what: what.map(card => card.id), who: who.map(card => card.id), layers: layers.map(card => card.id) } };
}

export async function service(t, { plan = true, custom, options = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-readiness-'));
  const study = new StudyService(root, options);
  t.after(async () => { await study.dispose?.(); await rm(root, { recursive: true, force: true }); });
  await study.call('snapshot');
  const { state, attempts, drafts, ids } = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.attempts.push(...attempts); own.drafts.push(...drafts); own.focus = state.focus; });
  if (plan) await study.call('course.save', { name: COURSE, custom: custom ?? planOf() });
  return { study, ids };
}

/** The plan these tests use: all three chapters, the explanations and the questions, lean. */
export const planOf = (over = {}) => ({ version: 1, purpose: 'follow', scope: { kind: 'chapters', chapters: ['c1', 'c2', 'c3'] }, book: { make: true, coverage: 'brief', parts: ['explain'] },
  questions: { make: true, kinds: ['quiz', 'cloze'], strength: 'lean', variants: true }, plan: { make: false, by: 'weekly', chaptersPerWeek: 1 }, sampleFirst: false, ...over });
