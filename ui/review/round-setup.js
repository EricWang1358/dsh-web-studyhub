import { practiceArgs } from '../learning-navigation.js';
import { resolvePracticeSettings } from '../../lib/practice-settings.js';

/* 本轮设置 (#1010), the pure side: what the popover next to a start button shows first, and the review.start arguments it makes of a choice.
   A choice is { size, range: 'mixed' | 'due' | 'new' | 'wrong', chapter: { deckId, topic } | null }.
   There is no second settings system here: the defaults are resolvePracticeSettings' (设置 › 练习), the bounds are lib/practice-settings.js ROUND_SIZE_LIMITS (the
   backend validates with them), and a round is started by the same review.start every other start uses. A context says where the popover stands:
     { course, scope, range, size, base }
   course: the course whose daily round it is (undefined: every active course); scope: the questions the round is about, for a round of a chosen scope (the
   result page of one); range and size: what the plain start button beside it starts on (新题 and its own count for 继续下一批新题; the setting's size and the
   mixed day otherwise); base: the arguments of that button, which the popover sends as they are while nothing is changed. */

/** The key a course's last choice is remembered under (settings.practice.lastRounds): the course's name, '' for every active course. */
export const roundKey = (course) => (typeof course === 'string' ? course : '');
const scoped = (context) => Array.isArray(context?.scope) && context.scope.length > 0;

/** The choice nothing was chosen for: the size of 设置 › 练习, the context's range, no chapter. */
export const roundDefaults = (practice, context = {}) => ({ size: context.size ?? resolvePracticeSettings(practice).roundSize, range: context.range ?? 'mixed', chapter: null });

export const sameRound = (a, b) => a.size === b.size && a.range === b.range && (a.chapter?.deckId ?? '') === (b.chapter?.deckId ?? '') && (a.chapter?.topic ?? '') === (b.chapter?.topic ?? '');

/** The topics of a deck as the snapshot knows them (data.progress[deckId].topics, lib/insights.js studyMap). */
const topicsOf = (data, deckId) => (data?.progress?.[deckId]?.topics || []).filter((topic) => topic?.name);
const titleOf = (data, deckId) => (data?.decks || []).find((deck) => deck.id === deckId)?.title ?? data?.progress?.[deckId]?.title ?? deckId;

/** The chapters offered: the topics of the decks `refs` name ({ deckId }[], a course's scope or a round's), each as { value, label, ref }. Several decks: the deck is named. */
export function chaptersOf(data, refs) {
  const wanted = [...new Set((Array.isArray(refs) ? refs : []).map((ref) => ref?.deckId).filter(Boolean))].filter((id) => topicsOf(data, id).length > 0);
  return wanted.flatMap((deckId) => topicsOf(data, deckId).map((topic) => ({
    value: JSON.stringify([deckId, topic.name]), label: wanted.length > 1 ? `${titleOf(data, deckId)} · ${topic.name}` : topic.name, ref: { deckId, topic: topic.name } })));
}
const chapterExists = (data, chapter) => !!chapter && topicsOf(data, chapter.deckId).some((topic) => topic.name === chapter.topic);

/** What the popover opens on: the course's last choice (settings.practice.lastRounds) when it still makes sense, else the defaults. A round of a chosen scope remembers nothing. */
export function roundChoice(practice, context = {}, data) {
  const defaults = roundDefaults(practice, context);
  const last = scoped(context) ? null : resolvePracticeSettings(practice).lastRounds?.[roundKey(context.course)];
  if (!last) return defaults;
  return { size: last.size, range: last.range, chapter: chapterExists(data, last.chapter) ? { ...last.chapter } : null };
}

/**
 * The review.start arguments of a choice. Left as the defaults, the round is the plain start button's own (`context.base`), argument for argument;
 * anything else is a fresh path round that names only what differs: `size` when it is not the setting (always for a chapter or a scope, which are studied whole
 * without it), `only` for a range, the chapter as the scope. The server validates them with the bounds of 设置 › 练习.
 */
export function roundArgs(choice, context = {}, defaults = roundDefaults(undefined, context)) {
  const extent = scoped(context);
  if (!choice.chapter && sameRound(choice, defaults) && context.base) return context.base;
  const scope = choice.chapter ? [{ ...choice.chapter }] : extent ? context.scope : undefined;
  const size = choice.chapter || extent || choice.size !== defaults.size ? { size: choice.size } : {};
  return practiceArgs(scope, { fresh: true, ...(!scope && context.course !== undefined ? { course: context.course, daily: true } : {}), ...size, ...(choice.range !== 'mixed' ? { only: choice.range } : {}) });
}

/**
 * Where the result page's popover stands, or null when its next-round button does not start a round of the course or of a scope (an exam, a round from the
 * reader, a detour back to the question, a learning flow, a plan task, a course batch, a round still open). `destination` is the page's continueDestination;
 * `newBatch` the arguments of 继续下一批新题 when that is the next-round button (the page builds them once for the button and for this): the popover then opens
 * on that button's own size and range, in its scope, and sends its arguments as they are until something is changed.
 */
export function resultTarget(run, destination, { newBatch = null } = {}) {
  if (!run?.complete || !['path', 'new'].includes(run.mode) || run.returnTo || run.reading || run.workflow) return null;
  if (destination?.kind !== 'scope' && destination?.kind !== 'path') return null;
  if (run.mode === 'new' && newBatch) return { course: undefined, scope: newBatch.scope, range: 'new', size: newBatch.count, base: newBatch };
  return destination.kind === 'scope' ? { course: undefined, scope: destination.scope, range: undefined } : { course: destination.course, scope: undefined, range: undefined };
}

/** The remembered-rounds patch of a start from the popover: the choice when it differs from the defaults, `null` (forget) when it is back at them. */
export function rememberPatch(choice, context = {}, defaults = roundDefaults(undefined, context)) {
  if (scoped(context)) return null;
  const round = sameRound(choice, defaults) ? null : { size: choice.size, range: choice.range, ...(choice.chapter ? { chapter: { ...choice.chapter } } : {}) };
  return { lastRounds: { [roundKey(context.course)]: round } };
}
