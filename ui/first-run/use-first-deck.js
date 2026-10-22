import { useMemo } from 'react';
import { useUsageEstimate } from '../TokenUsage.jsx';
import { courseNamesOf } from '../PageScope.jsx';
import { courseForSources } from '../../lib/source-courses.js';
import { estimateMinutes, estimateRequestOf, kindsLabel, kindsOfForm, selectionStats, summaryLine } from '../generate-form.js';
import { generateAdvice } from '../large-document-advice.js';
import { referenceSelection } from '../reference-questions.js';
import { META_DOT } from '../format.js';
import { startGeneration } from '../generate-start.js';

/* The first deck, made from the first-run line itself (3.6 D4, the owner's option A): the line's third step says what will be made and what it is expected to
   cost BEFORE anything is spent, and its 「出第一组题」 sends the very request 创建题组 would send for the same materials and the same form. Nothing here is a
   second generation flow: the summary is 创建题组's summaryLine (plus the question types, which that form says in its own line), the estimate is the same
   usage.estimate request (estimateRequestOf), and the run starts through startGeneration, 创建题组's own submit. The form's state (`gen`) is the app's one copy:
   what the learner changed under 「改题型和题数」 and left there is what the line makes. */

const NONE = Object.freeze([]);

/**
 * What a selection the line cannot send as it is lacks, or ''. 'too-big': more than one run takes (创建题组 offers the steps or the pages by topic); 'reference':
 * the sample questions chosen in the form do not fit this selection. Both are settled in 创建题组 (「改题型和题数」).
 */
export function firstDeckBlock({ sources = [], sourceIds = [], gen = {} } = {}) {
  if (generateAdvice({ sources, selectedIds: sourceIds, focus: gen.focus }).blocked) return 'too-big';
  const references = gen.referenceSourceIds || [];
  if (references.length && referenceSelection(sources, references, sourceIds, gen.referenceLimits, gen.referenceFormat).reason) return 'reference';
  return '';
}

/** The one line of what will be made: 创建题组's summary sentence (materials, the planned count once known, difficulty, language, time from earlier runs) and the types. */
export function firstDeckSummary({ data, gen, sourceIds, goal = null }) {
  if (!sourceIds.length) return '';
  const stats = selectionStats(data?.sources || [], sourceIds);
  const sentence = summaryLine({ ...stats, count: goal, difficulty: gen.difficulty, language: gen.language, minutes: goal ? estimateMinutes(data?.jobs, goal) : null });
  return [sentence, kindsLabel(kindsOfForm(gen))].filter(Boolean).join(META_DOT);
}

/**
 * The line's third step, ready: { summary, estimate, block, start }. `deck` is firstRunLine's third step; the estimate is asked only while it is 'ready' (no
 * run, no draft yet). `start()` runs the generate request; nothing calls it but the learner's own click. `services` are the app's { call, act, notify }.
 */
export function useFirstDeck({ data, gen, setGen, deck, reasoningEffort = '', services = {} }) {
  const { call, act, notify } = services;
  const ready = !!data && !!gen && deck?.status === 'ready';
  const references = gen?.referenceSourceIds || NONE;
  const key = ready ? deck.sourceIds.join(',') : '';
  // The materials 出第一组题 sends: every material of the learner's own, as 创建题组 ticks them, the form's sample questions left out (they are not evidence).
  const sourceIds = useMemo(() => (ready ? deck.sourceIds.filter((id) => !references.includes(id)) : NONE), [key, references]); // eslint-disable-line react-hooks/exhaustive-deps
  const course = ready ? gen.course ?? courseForSources({ sources: data.sources }, sourceIds, data.focus?.course || '', courseNamesOf(data)) : '';
  const request = ready ? estimateRequestOf(gen, { course, sourceIds, reasoningEffort }) : null;
  const block = ready ? firstDeckBlock({ sources: data.sources, sourceIds, gen }) : '';
  const estimate = useUsageEstimate(call, request, { enabled: ready && sourceIds.length > 0 && block !== 'reference' });
  const goal = estimate.status === 'ready' ? estimate.estimate?.coverage?.goal ?? null : null;
  const summary = ready ? firstDeckSummary({ data, gen, sourceIds, goal }) : '';
  const start = () => (ready && !block && sourceIds.length && act ? startGeneration({ act, notify, setGen, data, gen, course, sourceIds }) : undefined);
  return { summary, estimate, block, start, sourceIds };
}
