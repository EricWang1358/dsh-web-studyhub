import { createHash } from 'node:crypto';
import { bodyFingerprint, documentIndex, examFingerprint, leafSegments, outlineLeaves, previousLeaf } from '../../../course-book-inputs.js';
import { CALL_CHARS, EXAM_LEAVES_PER_CALL, LEAF_CHARS, LEAVES_PER_CALL, PASSAGE_MIN } from './constants.js';

/* What one review book build has to do, decided by the program before any call: for each knowledge point of the outline, whether its explanation (body) and
   its exam notes (exam) are kept as they are (no call) or written, and the calls they are written in. Pure: no model, no clock.

   A body is kept when an earlier explanation of the SAME texts in the same language exists: the leaf it continues (lib/course-book-inputs.js previousLeaf; after
   an outline rebuild the ids are new), else any earlier leaf of that fingerprint. Exam notes are kept when the leaf's paper places did not change; a leaf no paper
   tests needs no call (it says so); without papers there are none. A leaf whose materials have no readable text has an empty body and no call. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** The passages as one call shows them: all of them under `limit`, else a beginning of each, shared out so a short one keeps all of itself. */
export function excerpt(segments, limit = LEAF_CHARS) {
  const total = segments.reduce((sum, item) => sum + item.text.length, 0);
  if (total <= limit) return segments.map(item => ({ ...item, cut: false }));
  const sizes = new Map(), order = segments.map((item, at) => at).sort((a, b) => segments[a].text.length - segments[b].text.length);
  let left = limit, count = segments.length;
  for (const at of order) {
    const share = Math.max(PASSAGE_MIN, Math.floor(left / count--)), size = Math.min(segments[at].text.length, share);
    sizes.set(at, size); left = Math.max(0, left - size);
  }
  return segments.map((item, at) => ({ ...item, text: item.text.slice(0, sizes.get(at)), cut: sizes.get(at) < item.text.length }));
}

/** Consecutive leaves in calls of at most LEAVES_PER_CALL leaves and CALL_CHARS characters of material (a leaf alone may fill a call). */
export function packLeaves(items, { leaves = LEAVES_PER_CALL, chars = CALL_CHARS } = {}) {
  const batches = [];
  let current = [], size = 0;
  for (const item of items) {
    const length = item.shown.reduce((sum, part) => sum + part.text.length, 0);
    if (current.length && (current.length >= leaves || size + length > chars)) { batches.push(current); current = []; size = 0; }
    current.push(item); size += length;
  }
  if (current.length) batches.push(current);
  return batches.map((members, at) => ({ number: at + 1, items: members, key: `cb:notes:${short(members.map(item => [item.id, item.fingerprint]))}` }));
}

/**
 * @param state the library as read at the start; `documents` the course's documents (buildOutlineIndex allDocuments); `outline` the outline record explained;
 *        `previous` the course's current notes record or null.
 * @returns { items: [{ id, title, path, intro?, anchors, segments, shown, fingerprint, body?, needsBody, exam?, examFingerprint?, evidence, needsExam, replaces? }],
 *            bodyBatches, examBatches, papers }
 */
export function notesWork(state, documents, outline, previous, language) {
  const byId = new Map((state.sources || []).map(source => [source.id, source])), docs = documentIndex(documents);
  const papers = outline.courseOutline.papers || [], earlier = previous?.courseNotes.language === language ? previous.courseNotes.leaves : [];
  const byPrint = new Map(earlier.filter(leaf => leaf.body).map(leaf => [leaf.body.fingerprint, leaf.body]));
  const items = outlineLeaves(outline.courseOutline.nodes).map(({ node, path }) => {
    const segments = leafSegments(byId, docs, node.anchors), fingerprint = bodyFingerprint(language, segments);
    const before = previousLeaf(previous?.courseNotes.leaves, node);
    const same = before?.body?.fingerprint === fingerprint && earlier.includes(before) ? before.body : byPrint.get(fingerprint);
    const kept = same ? same : !segments.length ? { fingerprint, empty: true } : null;
    const item = { id: node.id, title: node.title, path, ...(node.intro ? { intro: node.intro } : {}), anchors: node.anchors, segments, shown: excerpt(segments),
      fingerprint, ...(kept ? { body: kept } : {}), needsBody: !kept, evidence: node.exam?.evidence || [], needsExam: false,
      ...(previous && before?.body && !kept ? { replaces: previous.id, earlier: before.body } : {}) };
    if (papers.length) {
      const examPrint = examFingerprint(language, node, papers);
      const keptExam = before?.exam?.fingerprint === examPrint && earlier.includes(before) ? before.exam : !item.evidence.length ? { fingerprint: examPrint, tested: false } : null;
      Object.assign(item, { examFingerprint: examPrint, ...(keptExam ? { exam: keptExam } : {}), needsExam: !keptExam,
        ...(previous && before?.exam && !keptExam ? { examReplaces: previous.id } : {}) });
    }
    return item;
  });
  const examNeeded = items.filter(item => item.needsExam), examBatches = [];
  for (let at = 0; at < examNeeded.length; at += EXAM_LEAVES_PER_CALL) {
    const members = examNeeded.slice(at, at + EXAM_LEAVES_PER_CALL);
    examBatches.push({ number: examBatches.length + 1, items: members, key: `cb:exam:${short(members.map(item => [item.id, item.examFingerprint]))}` });
  }
  return { items, bodyBatches: packLeaves(items.filter(item => item.needsBody)), examBatches, papers };
}
