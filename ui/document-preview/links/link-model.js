/* Which passages of a document are linked to what (owner request, 2.3.2): pure, no DOM, runs under node:test.
   Input: the groups of `groupPassageLinks` (one per selected passage, all its links). Output: the passages that
   can be underlined and the ones that must be selected again. */

/** What kind of look a link gets: a question card, a Q&A card saved from an answer, an annotation (kept questions and answers, 批注 mode) or (when notes carry a passage) a note. */
export const linkKind = link => (link?.kind === 'note' ? 'note' : link?.kind === 'annotation' ? 'annotation' : link?.sourceQa ? 'qa' : 'question');

/** A stable identity for a passage, used to keep one passage focused across refreshes of the links. */
export const groupKey = selection => JSON.stringify([selection?.documentId, selection?.revision, selection?.sourceId, selection?.start, selection?.end, selection?.quote]);

const REASONS = new Set(['stale', 'missing', 'ambiguous']);
const reasonOf = status => (REASONS.has(status) ? status : 'unavailable');

/** Notes written from any of the passage's cards, once each: a note is made of cards, so it follows its cards. */
function notesOf(links, noteBadges) {
  const notes = new Map();
  for (const link of links) for (const note of noteBadges?.[link.cardId] || []) if (!notes.has(note.noteId)) notes.set(note.noteId, note);
  return [...notes.values()];
}

/**
 * `groups` from groupPassageLinks; `noteBadges` is the snapshot's card -> notes map.
 * A passage is underlined only when its position resolves in the current revision; anything else is listed with the reason.
 */
export function buildLinkModel(groups = [], { noteBadges } = {}) {
  const active = [], stale = [];
  for (const group of groups) {
    if (!group.selection?.quote) continue;
    const key = groupKey(group.selection), links = group.links || [];
    if (links.some(item => item.status === 'resolved')) {
      const counts = { question: 0, qa: 0, annotation: 0 };
      for (const item of links) { const kind = linkKind(item); if (kind in counts) counts[kind]++; }
      const kind = counts.question ? 'question' : counts.qa ? 'qa' : counts.annotation ? 'annotation' : links.some(item => linkKind(item) === 'note') ? 'note' : 'question';
      active.push({ key, number: group.number, selection: group.selection, kind, links, counts, notes: notesOf(links, noteBadges),
        followups: links.reduce((total, item) => total + (item.followups?.length || 0), 0) });
    } else stale.push({ key, number: group.number, selection: group.selection, reason: reasonOf(links[0]?.status), links });
  }
  return { groups: active, stale };
}

/** "2 questions · 1 Q&A · 1 note" for the hover text of an underline; `t` supplies the words. */
export function groupTitle(group, t) {
  return [group.counts?.question && t.questions(group.counts.question), group.counts?.qa && t.qa(group.counts.qa), group.counts?.annotation && t.annotations(group.counts.annotation), group.notes?.length && t.notes(group.notes.length)]
    .filter(Boolean).join(' · ');
}

/** The answer of a card as text (a multiple-answer card has a list). */
export const answerText = answer => (Array.isArray(answer) ? answer.join('、') : answer == null ? '' : String(answer));
export const clip = (text, max) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** What to call a link in a list: a Q&A card's front is its quoted passage then its question, so only the question is shown. */
const QUOTED_FRONT = /^(?:>[^\n]*\n?)+\s*/;
export const displayPrompt = link => (linkKind(link) === 'qa' ? String(link.prompt || '').replace(QUOTED_FRONT, '').trim() : String(link.prompt || ''));
