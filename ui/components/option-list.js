/* The data side of Select and Combobox: no React, no DOM, so the filtering, the highlight ranges, the course/chapter tree and the
   footer actions are plain functions with plain tests. Both components feed these into Base UI (which only draws the popup).

   An option is { value, label, hint?, disabled?, keywords?, level?, icon? }:
   - `label` is a string (it is what type-ahead and the search match);
   - `hint` is the secondary text on the right (a folder, a count);
   - `level` (default 1) makes a tree: an option owns the options after it that have a higher level, until one of the same or a lower level
     (a course, then its chapters at level 2). Level 2 and up is drawn on the hairline and carries aria-level.
   An entry of the list is an option or a group { group: 'Heading', options: [option, ...] }, groups are not nested. */

export const isGroup = (entry) => !!entry && Array.isArray(entry.options);

/** The options of a list in order, each with the heading of its group (undefined for a top-level option). */
export function flattenOptions(entries = []) {
  const flat = [];
  for (const entry of entries) {
    if (isGroup(entry)) for (const option of entry.options) flat.push({ ...option, group: entry.group });
    else if (entry) flat.push({ ...entry });
  }
  return flat;
}

const normal = (text) => String(text ?? '').toLowerCase();

/** The words of a query: split on whitespace, lower-cased; none for an empty query. */
export const queryTokens = (query) => normal(query).split(/\s+/).filter(Boolean);

/** [start, end) ranges of `text` that the query's words match, merged and in order (every occurrence of every word). */
export function matchRanges(text, query) {
  const source = normal(text), ranges = [];
  for (const token of queryTokens(query)) {
    for (let at = source.indexOf(token); at >= 0; at = source.indexOf(token, at + token.length)) ranges.push([at, at + token.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** `text` cut into [{ text, match }] pieces along the ranges, for drawing the matches. One piece without a query. */
export function highlightParts(text, query) {
  const value = String(text ?? ''), ranges = matchRanges(value, query);
  if (!ranges.length) return [{ text: value, match: false }];
  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: value.slice(cursor, start), match: false });
    parts.push({ text: value.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), match: false });
  return parts;
}

const searchable = (option) => [option.label, option.hint, ...[].concat(option.keywords ?? [])].map(normal).join('\n');

/** Whether every word of the query is found in the option's label, hint or keywords. An empty query matches. */
export function optionMatches(option, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const text = searchable(option);
  return tokens.every((token) => text.includes(token));
}

const levelOf = (option) => Math.max(1, Number(option.level) || 1);

/** The options that survive a query inside one list, keeping the tree: an option stays when it matches, when an ancestor does (a
    matching course keeps all its chapters) or when one of its descendants does. That last case is only context (`context: true`): the
    course is drawn above the chapter that matched, but is not a choice in that view (Enter must pick the chapter that was typed). */
function filterBranch(options, query) {
  const keep = new Array(options.length).fill(false), context = new Array(options.length).fill(false);
  for (let index = 0; index < options.length; index++) {
    if (!optionMatches(options[index], query)) continue;
    keep[index] = true;
    // Up: every ancestor (the nearest earlier option with a lower level, and so on).
    let wanted = levelOf(options[index]);
    for (let back = index - 1; back >= 0 && wanted > 1; back--) {
      if (levelOf(options[back]) < wanted) { if (!keep[back]) { keep[back] = true; context[back] = true; } wanted = levelOf(options[back]); }
    }
    // Down: its descendants.
    for (let next = index + 1; next < options.length && levelOf(options[next]) > levelOf(options[index]); next++) keep[next] = true;
  }
  // An ancestor that matched on its own, or whose own descendants were kept by it, is a choice again.
  for (let index = 0; index < options.length; index++) if (keep[index] && optionMatches(options[index], query)) context[index] = false;
  return options.flatMap((option, index) => (!keep[index] ? [] : context[index] ? [{ ...option, context: true }] : [option]));
}

/** The list after a query, same shape as the input: groups with no option left disappear; a group whose heading matches stays whole. */
export function filterEntries(entries = [], query = '') {
  if (!queryTokens(query).length) return entries;
  const result = [];
  const looseKept = [];
  const flushLoose = () => { if (looseKept.length) result.push(...filterBranch(looseKept.splice(0), query)); };
  for (const entry of entries) {
    if (!isGroup(entry)) { if (entry) looseKept.push(entry); continue; }
    flushLoose();
    const options = optionMatches({ label: entry.group }, query) ? entry.options : filterBranch(entry.options, query);
    if (options.length) result.push({ ...entry, options });
  }
  flushLoose();
  return result;
}

/** The popup's rows in order: { type: 'group', label } headings, { type: 'context', option, level } (a course shown only to place the
    matching chapter under it) and { type: 'option', option, index, level } (index counts the choices only: the position keyboard
    navigation uses). */
export function listRows(entries = []) {
  const rows = [];
  let index = 0;
  const push = (option) => rows.push(option.context ? { type: 'context', option, level: levelOf(option) } : { type: 'option', option, index: index++, level: levelOf(option) });
  for (const entry of entries) {
    if (isGroup(entry)) {
      if (entry.group) rows.push({ type: 'group', label: entry.group, key: `group:${entry.group}` });
      entry.options.forEach(push);
    } else if (entry) push(entry);
  }
  return rows;
}

/** Footer actions are { id, label, icon?, onSelect(query), when?(query), disabled? }. `label` may be a function of the typed text
    ("新建题组「…」"). Returns the ones to show for this query, labels resolved. They are buttons, never options. */
export function resolveActions(actions = [], query = '') {
  const text = String(query ?? '').trim();
  return actions.filter((action) => action && (!action.when || action.when(text)))
    .map((action) => ({ ...action, label: typeof action.label === 'function' ? action.label(text) : action.label }));
}

/** The options a learner can choose in this list (a context-only ancestor is not one). */
export const selectableOptions = (entries) => flattenOptions(entries).filter((option) => !option.context);

/** The option whose value is `value` (strict equality), searched through groups; undefined when none. */
export const findOption = (entries, value) => flattenOptions(entries).find((option) => option.value === value);
