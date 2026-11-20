/* Zero-copy WeakMap indices and source collectors for `trap-projection.js`.
   Pure, 0-token, browser-safe, read-only over frozen viewState. */

import { qaBlocks } from '../../course-book-qa-text.js';
import { confusablesView } from '../../course-book-confusables.js';
import { leavesOf, withCardNumbers } from '../../course-book-card-numbers.js';
import { isCourseBookDocSource, isCourseNotesSource, isCourseOutlineSource } from '../../exam-point-list.js';
import { courseKey } from '../../courses.js';

export const clipText = (val, max) => {
  const text = String(val ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}...` : text;
};
export const normText = val => String(val ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export const pushUnique = (arr, val, max) => {
  if (!val || arr.length >= max || arr.includes(val)) return;
  arr.push(val);
};

const sourceIdxCache = new WeakMap();
const docAnnCache = new WeakMap();
const confusableIdxCache = new WeakMap();

export function indexTrapSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (Object.isFrozen(list) && sourceIdxCache.has(list)) return sourceIdxCache.get(list);
  const byId = new Map();
  const books = new Map();
  const notes = new Map();
  const outlines = new Map();
  for (const src of list) {
    if (!src?.id) continue;
    byId.set(src.id, src);
    if (src.archived) continue;
    if (isCourseBookDocSource(src)) {
      const key = courseKey(src.bookDoc?.course || src.courses?.[0]);
      if (key) books.set(key, src);
    } else if (isCourseNotesSource(src)) {
      const key = courseKey(src.courseNotes?.course || src.courses?.[0]);
      if (key) notes.set(key, src);
    } else if (isCourseOutlineSource(src)) {
      const key = courseKey(src.courseOutline?.course || src.courses?.[0]);
      if (key) outlines.set(key, src);
    }
  }
  const result = { byId, books, notes, outlines };
  if (Object.isFrozen(list)) sourceIdxCache.set(list, result);
  return result;
}

function indexDocAnnotations(documents) {
  const list = Array.isArray(documents) ? documents : [];
  if (Object.isFrozen(list) && docAnnCache.has(list)) return docAnnCache.get(list);
  const bySource = new Map();
  for (const doc of list) {
    for (const ver of doc?.versions || []) {
      const items = ver?.annotations?.items;
      if (!Array.isArray(items) || !items.length) continue;
      for (const item of items) {
        if (!item?.sourceId || item.status === 'stale') continue;
        let bucket = bySource.get(item.sourceId);
        if (!bucket) bySource.set(item.sourceId, bucket = []);
        bucket.push(item);
      }
    }
  }
  if (Object.isFrozen(list)) docAnnCache.set(list, bySource);
  return bySource;
}

function indexConfusables(notesSource, outlineSource) {
  const stored = notesSource?.courseNotes?.confusables;
  if (!Array.isArray(stored) || !stored.length) return null;
  if (Object.isFrozen(notesSource) && confusableIdxCache.has(notesSource)) return confusableIdxCache.get(notesSource);
  const leaves = notesSource.courseNotes?.leaves || [];
  const rawTree = Array.isArray(outlineSource?.courseOutline?.nodes)
    ? outlineSource.courseOutline.nodes
    : leaves.map(leaf => ({ hid: leaf.id, id: leaf.id, leaf: true, title: leaf.title, cards: (leaf.body?.units || []).flatMap(u => u.cards || []) }));
  const cardsByLeaf = new Map(leaves.map(leaf => [leaf.id, (leaf.body?.units || []).flatMap(u => u.cards || [])]));
  const hydrate = nodes => (Array.isArray(nodes) ? nodes : []).map(node => {
    if (Array.isArray(node?.children) && node.children.length) return { ...node, children: hydrate(node.children) };
    const cards = Array.isArray(node?.cards) && node.cards.length ? node.cards : (cardsByLeaf.get(node.id) || []);
    return { ...node, hid: node.hid || node.id, leaf: true, cards };
  });
  const numbered = withCardNumbers(hydrate(rawTree));
  const codeToLeaf = new Map();
  for (const leaf of leavesOf(numbered)) {
    const lid = leaf.id || leaf.hid;
    for (const card of leaf.cards || []) codeToLeaf.set(card.code, lid);
  }
  const all = confusablesView(stored, numbered);
  const byLeaf = new Map();
  for (const pair of all) {
    for (const code of pair.items || []) {
      const lid = codeToLeaf.get(code);
      if (!lid) continue;
      let bucket = byLeaf.get(lid);
      if (!bucket) byLeaf.set(lid, bucket = []);
      if (!bucket.some(item => item.id === pair.id)) bucket.push(pair);
    }
  }
  const out = { all, byLeaf };
  if (Object.isFrozen(notesSource)) confusableIdxCache.set(notesSource, out);
  return out;
}

function parseBookQaBlock(raw) {
  const lines = String(raw ?? '').split('\n').map(l => l.replace(/^>\s?/, '').trim()).filter(Boolean);
  let question = '';
  let answer = '';
  let inAnswer = false;
  for (const line of lines) {
    const qm = /^\*\*(?:\u8ffd\u95ee|Follow-up)[\uff1a:]\*\*\s*(.*)$/i.exec(line);
    if (qm) { question = qm[1].trim(); inAnswer = false; continue; }
    const am = /^\*\*(?:\u7b54|Answer)[\uff1a:]\*\*\s*(.*)$/i.exec(line);
    if (am) { answer = am[1].trim(); inAnswer = true; continue; }
    if (inAnswer) answer = answer ? `${answer} ${line}` : line;
  }
  return { question: clipText(question, 90), answer: clipText(answer, 220) };
}

export function collectQaTraps({ card, targetId, hid, bookSrc }) {
  const qaQuestions = [];
  const qaAnswers = [];
  for (const fu of Array.isArray(card?.followups) ? card.followups : []) {
    if (!fu || fu.stale === true) continue;
    const q = clipText(fu?.question, 90);
    const ans = clipText(fu?.answer, 220);
    pushUnique(qaQuestions, q, 3);
    if (q && ans && qaAnswers.length < 2) qaAnswers.push({ question: q, answer: ans });
  }
  if (bookSrc?.bookDoc?.files) {
    const targetFile = hid && bookSrc.bookDoc.files[`${hid}.qa.md`] ? [bookSrc.bookDoc.files[`${hid}.qa.md`]] : [];
    const files = targetFile.length ? targetFile : Object.entries(bookSrc.bookDoc.files).filter(([k]) => k.endsWith('.qa.md')).map(([, v]) => v);
    for (const file of files) {
      if (!file?.text || !file.text.includes(`card=${targetId}`)) continue;
      for (const block of qaBlocks(file.text)) {
        if (block.cardId !== targetId) continue;
        const parsed = parseBookQaBlock(block.raw);
        pushUnique(qaQuestions, parsed.question, 3);
        if (parsed.question && parsed.answer && qaAnswers.length < 2 && !qaAnswers.some(a => a.question === parsed.question)) {
          qaAnswers.push(parsed);
        }
      }
    }
  }
  return { qaQuestions, qaAnswers };
}

export function collectConfusableTraps({ notesSrc, outlineSrc, hid, card }) {
  const confusableIds = [];
  const confusablePairs = [];
  const confusableMistakes = [];
  const confusableComparisons = [];
  const confIdx = notesSrc ? indexConfusables(notesSrc, outlineSrc) : null;
  if (!confIdx) return { confusableIds, confusablePairs, confusableMistakes, confusableComparisons };
  let matched = hid ? (confIdx.byLeaf.get(hid) || []) : [];
  if (!matched.length && (card?.topic || card?.prompt)) {
    const hay = normText(`${card?.topic || ''} ${card?.prompt || ''}`);
    matched = confIdx.all.filter(p => (p.names || []).some(n => n && hay.includes(normText(n))));
  }
  for (const pair of matched.slice(0, 3)) {
    confusableIds.push(pair.id);
    confusablePairs.push({ id: pair.id, names: (pair.names || []).map(n => clipText(n, 40)) });
    const diffRow = (pair.rows || []).find(r => r.aspect === 'difference');
    const misRow = (pair.rows || []).find(r => r.aspect === 'mistake');
    if (misRow?.cells?.length && confusableMistakes.length < 2) {
      confusableMistakes.push({ id: pair.id, mistake: misRow.cells.map(c => clipText(c, 90)) });
    }
    if (confusableComparisons.length < 2) {
      confusableComparisons.push({
        id: pair.id, names: (pair.names || []).map(n => clipText(n, 40)),
        ...(diffRow?.cells ? { difference: diffRow.cells.map(c => clipText(c, 100)) } : {}),
        ...(misRow?.cells ? { mistake: misRow.cells.map(c => clipText(c, 100)) } : {}),
      });
    }
  }
  return { confusableIds, confusablePairs, confusableMistakes, confusableComparisons };
}

export function collectCatchupAndDoubts({ viewState, srcIdx, card, targetId, cKey }) {
  const citedSourceIds = new Set([
    ...(Array.isArray(card?.citations) ? card.citations.map(c => c?.sourceId) : []),
    ...(Array.isArray(card?.selections) ? card.selections.map(s => s?.sourceId || s?.selection?.sourceId) : []),
  ].filter(Boolean));
  const cardCompId = card?.companionRef?.companionId || null;
  const cardTopicKey = normText(card?.topic);
  let catchupCount = 0;
  const catchupCues = [];
  const catchupAnswers = [];
  for (const deck of viewState.decks || []) {
    if (!deck || deck.archived || !deck.companionCatchup) continue;
    if (cKey && courseKey(deck.course || deck.folder) !== cKey) continue;
    for (const item of deck.cards || []) {
      if (!item || item.id === targetId) continue;
      const hitComp = cardCompId && item.companionRef?.companionId === cardCompId;
      const hitSrc = (item.citations || []).some(c => citedSourceIds.has(c?.sourceId));
      const hitTopic = cardTopicKey && normText(item.topic) === cardTopicKey;
      if (!hitComp && !hitSrc && !hitTopic) continue;
      catchupCount += 1;
      const cuePrompt = clipText(item.prompt, 90);
      pushUnique(catchupCues, cuePrompt, 2);
      if (cuePrompt && item.answer && catchupAnswers.length < 2) {
        catchupAnswers.push({ prompt: cuePrompt, answer: clipText(item.answer, 180) });
      }
    }
  }
  let doubtCount = 0;
  const doubtCues = [];
  const doubtAnswers = [];
  if (citedSourceIds.size) {
    const docAnns = indexDocAnnotations(viewState.documents);
    const seen = new Set();
    for (const sid of citedSourceIds) {
      const srcItems = srcIdx.byId.get(sid)?.annotations?.items;
      const combined = [...(Array.isArray(srcItems) ? srcItems : []), ...(docAnns.get(sid) || [])];
      for (const item of combined) {
        if (!item || item.status === 'stale') continue;
        const q = clipText(item.label || item.question, 90);
        if (!q || seen.has(item.id || q)) continue;
        seen.add(item.id || q);
        doubtCount += 1;
        pushUnique(doubtCues, q, 2);
        if (item.answer && doubtAnswers.length < 2) doubtAnswers.push({ question: q, answer: clipText(item.answer, 180) });
      }
    }
  }
  return { catchupCount, catchupCues, catchupAnswers, doubtCount, doubtCues, doubtAnswers };
}
