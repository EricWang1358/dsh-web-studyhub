import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { normalizeQuery } from './search.js';

/* Live library search for 找功能 (Ctrl K): pure scoring across active courses, decks, grouped materials, and notes. */

function matchScore(primaryTexts, secondaryTexts, wanted) {
  let bestRank = -1;
  let bestPos = Infinity;
  const check = (text, baseRank) => {
    const norm = normalizeQuery(text);
    if (!norm) return;
    if (norm === wanted) {
      if (bestRank < 0 || baseRank < bestRank) { bestRank = baseRank; bestPos = 0; }
      return;
    }
    const idx = norm.indexOf(wanted);
    if (idx < 0) return;
    const rank = idx === 0 ? baseRank + 1 : baseRank + 2;
    if (bestRank < 0 || rank < bestRank || (rank === bestRank && idx < bestPos)) {
      bestRank = rank;
      bestPos = idx;
    }
  };
  for (const text of primaryTexts) check(text, 0);
  if (bestRank >= 0) return { rank: bestRank, pos: bestPos };
  for (const text of secondaryTexts) check(text, 3);
  return { rank: bestRank, pos: bestPos };
}

function collectCandidates(data) {
  const candidates = [];
  const courses = Array.isArray(data?.focus?.courses) ? data.focus.courses : [];
  for (const item of courses) {
    const name = typeof item === 'string' ? item : item?.name;
    if (!name) continue;
    const focusTopics = Array.isArray(item?.focusTopics) ? item.focusTopics : [];
    candidates.push({
      id: `library:course:${name}`,
      kind: 'library',
      libraryKind: 'course',
      title: name,
      course: '',
      current: data?.focus?.course === name,
      target: { kind: 'course', course: name },
      primary: [name],
      secondary: focusTopics,
    });
  }

  const decks = Array.isArray(data?.decks) ? data.decks : [];
  for (const deck of decks) {
    if (!deck || deck.archived || !deck.id) continue;
    const topics = Array.isArray(deck.topics) ? deck.topics : [];
    candidates.push({
      id: `library:deck:${deck.id}`,
      kind: 'library',
      libraryKind: 'deck',
      title: deck.title || deck.id,
      course: deck.course || deck.folder || '',
      count: deck.available ?? deck.count ?? 0,
      target: { kind: 'deck', id: deck.id },
      primary: [deck.title],
      secondary: [deck.course, deck.folder, ...topics],
    });
  }

  const docs = groupSourcesByDocument(data?.sources);
  for (const doc of docs) {
    if (!doc || doc.archived || !doc.sourceIds?.length) continue;
    const docKey = doc.key || doc.documentId || doc.sourceIds[0];
    candidates.push({
      id: `library:source:${docKey}`,
      kind: 'library',
      libraryKind: 'source',
      title: doc.title || doc.filename || doc.sourceIds[0],
      course: doc.courses?.[0] || '',
      pages: doc.pages?.length || 0,
      target: { kind: 'source', id: doc.sourceIds[0] },
      primary: [doc.title, doc.filename],
      secondary: [...(doc.courses || []), doc.excerpt],
    });
  }

  const notes = Array.isArray(data?.notes) ? data.notes : [];
  for (const note of notes) {
    if (!note || note.archived || !note.id) continue;
    const title = note.title || note.heading || note.daily?.title || note.date || '';
    const noteCourse = note.course || note.courses?.[0] || '';
    const tags = Array.isArray(note.tags) ? note.tags : [];
    candidates.push({
      id: `library:note:${note.id}`,
      kind: 'library',
      libraryKind: 'note',
      title,
      course: noteCourse,
      target: { kind: 'note', id: note.id },
      primary: [title, note.date],
      secondary: [noteCourse, ...(note.courses || []), ...tags, note.excerpt, note.snippet, note.text, note.body],
    });
  }

  return candidates;
}

/**
 * Compute up to `limit` scored library hits for a non-empty Finder query across courses,
 * non-archived decks, grouped non-archived materials, and notes.
 */
export function searchLibraryHits(data, query, { limit = 6 } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return [];
  const wanted = normalizeQuery(trimmed);
  if (!wanted) return [];
  const candidates = collectCandidates(data);
  const scored = [];
  for (let order = 0; order < candidates.length; order++) {
    const entry = candidates[order];
    const { rank, pos } = matchScore(entry.primary, entry.secondary, wanted);
    if (rank < 0) continue;
    const { primary: _primary, secondary: _secondary, ...hit } = entry;
    scored.push({ hit, rank, pos, order });
  }
  scored.sort((a, b) => a.rank - b.rank || a.pos - b.pos || a.order - b.order);
  return scored.slice(0, limit).map((item) => item.hit);
}
