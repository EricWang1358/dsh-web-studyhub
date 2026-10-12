import { bareName, nameForms } from '../../../course-book-inventory.js';

/* The program's verdict on one written unit, after its independent review: an item counts as covered only when the writer claimed it, the reviewer did not
   flag it as missing, only named or undefined, and its name (or the name or gloss of a bilingual one) is in the text: spaces, hyphens, emphasis and LaTeX
   aside, a short Latin name as a whole word, a name never found only inside a longer name the course also teaches (covariance does not count for variance). A
   one-character name or a formula is written too many ways to find: the REVIEWER must confirm it (`checked`). The unit passes when every MUST item is
   covered and the review found no unsupported claim and no contradiction; the other issues (a missing transition, a hard passage) are repaired when a
   repair is made but never fail a unit. No length, template or bullet check: those are the writer's. Pure. */

const FLAGS = new Set(['missing', 'namedrop', 'undefined']);
const BLOCKING = new Set(['unsupported', 'contradiction']);
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
/** A text as names are compared in it: NFKC, lower case, without cite marks, zero-width characters, Markdown emphasis and LaTeX dollars; spaces kept as one. */
const plain = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\[\^\d{1,2}\]/g, '').replace(ZERO_WIDTH, '').replace(/[*_`$\\{}]/g, '')
  .replace(/[\s\-‐-―]+/g, ' ');
/** The same without any space (a name written "Threat-modelling", "threat modelling" or "threatmodelling" is one name). */
const squash = text => plain(text).replace(/ /g, '');
const SHORT_LATIN = /^[a-z0-9 ]{1,4}$/;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` use the name `form`? A short Latin name as a whole word; any other name with spaces and hyphens aside. */
function found(text, form) {
  const wanted = plain(form).trim();
  if (!wanted) return false;
  if (SHORT_LATIN.test(wanted)) return new RegExp(`(?<![a-z0-9])${escape(wanted)}(?![a-z0-9])`).test(plain(text));
  return squash(text).includes(squash(wanted));
}

/**
 * Does the text use the item's name (any of its forms: the whole name, the name without a translation gloss, the gloss alone)? `known`: names of other
 * items of the course; where one of them contains this name (covariance for variance), its occurrences are taken out first.
 */
export function mentions(text, item, known = []) {
  const own = plain(item.name).trim();
  const longer = known.map(name => plain(name).trim()).filter(name => name !== own && own && name.includes(own) && name.length > own.length);
  let rest = plain(text);
  for (const name of longer.sort((a, b) => b.length - a.length)) rest = rest.split(name).join(' ');
  return nameForms(item.name).some(form => found(rest, form));
}
/** A name too short to find by its letters (one character) or a formula (written many ways) needs the reviewer's confirmation. */
const checkable = item => item.kind !== 'formula' && squash(bareName(item.name)).length > 1;

/**
 * @param review the reviewer's answer ({ issues, checked? }) or null (the review failed: nothing can be claimed as checked).
 * @returns { round, reviewed, pass, covered: [item id], missing: [checklist item], blocking: [issue], issues: [issue with `alias` for the repair prompt] }
 */
export function judge(unit, draft, review, round) {
  const flagged = new Set((review?.issues || []).filter(issue => FLAGS.has(issue.kind) && issue.item).map(issue => issue.item));
  const confirmed = new Set(review?.checked || []), known = unit.checklist.map(item => item.name);
  const covered = [], missing = [];
  for (const item of unit.checklist) {
    const seen = checkable(item) ? mentions(draft.text, item, [...known, ...(item.longer || [])]) : confirmed.has(item.id);
    if (draft.claimed.includes(item.id) && seen && !flagged.has(item.id)) covered.push(item.id);
    else if (item.priority === 'must') missing.push(item);
  }
  const alias = new Map(unit.checklist.map(item => [item.id, item.alias]));
  const issues = (review?.issues || []).map(issue => ({ ...issue, ...(issue.item ? { alias: alias.get(issue.item) } : {}) }));
  for (const item of missing) if (!issues.some(issue => issue.item === item.id)) issues.push({ kind: 'missing', item: item.id, alias: item.alias, note: '' });
  const blocking = issues.filter(issue => BLOCKING.has(issue.kind));
  // A unit with no must item (a pass whose pages teach nothing listed) is only checked for what it claims; a POINT with none is never complete (bodyOf: unchecked).
  const must = unit.checklist.some(item => item.priority === 'must');
  return { round, reviewed: !!review, pass: !!review && !missing.length && !blocking.length, unchecked: !must, covered, missing, blocking, issues };
}

/** What a unit leaves open, as stored: the missing items by name, and the issues that still stand (a missing item's own issue is said by the list). */
export function openIssues(verdict, unit) {
  const name = new Map(unit.checklist.map(item => [item.id, item.name]));
  return { missing: verdict.missing.map(item => ({ id: item.id, name: item.name })),
    issues: [...(verdict.reviewed ? [] : [{ kind: 'unreviewed', note: '' }]),
      ...verdict.issues.filter(issue => issue.kind !== 'missing').map(issue => ({ kind: issue.kind, note: issue.note, ...(issue.item ? { name: name.get(issue.item) } : {}) }))] };
}
