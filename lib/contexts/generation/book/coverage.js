import { bareName, nameForms } from '../../../course-book-inventory.js';

/* The program's verdict on one written unit, after its independent review: an item counts as covered only when the writer claimed it, its name (or the name
   or gloss of a bilingual one) appears in the text (spaces, hyphens, emphasis and LaTeX aside; a one-character name or a formula is left to the claim and
   the review), and the reviewer did not flag it as missing, only named or undefined. The unit passes when every MUST item
   is covered and the review found no unsupported claim and no contradiction; the other issues (a missing transition, a hard passage) are repaired when a
   repair is made but never fail a unit. No length, template or bullet check: those are the writer's. Pure. */

const FLAGS = new Set(['missing', 'namedrop', 'undefined']);
const BLOCKING = new Set(['unsupported', 'contradiction']);
/** A text as names are compared in it: NFKC, lower case, without cite marks, zero-width characters, spaces, hyphens, Markdown emphasis and LaTeX dollars. */
const squash = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\[\^\d{1,2}\]/g, '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
  .replace(/[\s\-\u2010-\u2015_*`$\\{}]/g, '');

/** Does the text use the item's name (any of its forms: the whole name, the name without its gloss, the gloss of the other script)? */
export const mentions = (text, item) => { const own = squash(text); return nameForms(item.name).some(form => { const wanted = squash(form); return !!wanted && own.includes(wanted); }); };
/** A name too short to find by its letters (one character) or a formula (written many ways) is judged by the writer's claim and the reviewer alone. */
const checkable = item => item.kind !== 'formula' && squash(bareName(item.name)).length > 1;

/**
 * @param review the reviewer's answer ({ issues }) or null (the review failed: nothing can be claimed as checked).
 * @returns { round, reviewed, pass, covered: [item id], missing: [checklist item], blocking: [issue], issues: [issue with `alias` for the repair prompt] }
 */
export function judge(unit, draft, review, round) {
  const flagged = new Set((review?.issues || []).filter(issue => FLAGS.has(issue.kind) && issue.item).map(issue => issue.item));
  const covered = [], missing = [];
  for (const item of unit.checklist) {
    if (draft.claimed.includes(item.id) && (!checkable(item) || mentions(draft.text, item)) && !flagged.has(item.id)) covered.push(item.id);
    else if (item.priority === 'must') missing.push(item);
  }
  const alias = new Map(unit.checklist.map(item => [item.id, item.alias]));
  const issues = (review?.issues || []).map(issue => ({ ...issue, ...(issue.item ? { alias: alias.get(issue.item) } : {}) }));
  for (const item of missing) if (!issues.some(issue => issue.item === item.id)) issues.push({ kind: 'missing', item: item.id, alias: item.alias, note: '' });
  const blocking = issues.filter(issue => BLOCKING.has(issue.kind));
  return { round, reviewed: !!review, pass: !!review && !missing.length && !blocking.length, covered, missing, blocking, issues };
}

/** What a unit leaves open, as stored: the missing items by name, and the issues that still stand (a missing item's own issue is said by the list). */
export function openIssues(verdict, unit) {
  const name = new Map(unit.checklist.map(item => [item.id, item.name]));
  return { missing: verdict.missing.map(item => ({ id: item.id, name: item.name })),
    issues: [...(verdict.reviewed ? [] : [{ kind: 'unreviewed', note: '' }]),
      ...verdict.issues.filter(issue => issue.kind !== 'missing').map(issue => ({ kind: issue.kind, note: issue.note, ...(issue.item ? { name: name.get(issue.item) } : {}) }))] };
}
