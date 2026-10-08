import { useEffect, useMemo, useState } from 'react';
import { uiFormat, getUiLanguage } from './i18n.js';
import { useToast } from './components/index.js';
import { useStudy } from './study-context.jsx';
import { applyPathRefinement, planGenerationPath, STEP_CHARS } from '../lib/generation-path.js';
import { failureGroups, pathBrief, queueSteps, selectedItems } from './generation-path-flow.js';
import { stepTitle } from './generation-path-titles.js';

/* The state and the actions of the 分步出题 path (ui/GenerationPath.jsx draws the steps; 创建题组 draws the one button that queues them): the plan the app cuts from the
   chapters (instant, always valid), the model's optional refinement, the learner's edits, the steps in use, queuing them as generation jobs and the report of the ones that
   did not start. A different selection is a different plan: nothing of the old one carries over. */

/**
 * Props: sources, selectedIds, gen (the form: kind, difficulty, language, … for each step's request), course, goal, indexCoverage, onQueued(result).
 * Returns { available, total, steps, included, questions, indexed, ai, aiState, queueing, report, patch, refine, chat, queue, groups }.
 */
export function useGenerationPath({ sources, selectedIds, gen, course = '', goal = '', indexCoverage = null, onQueued }) {
  const { call, askInChat } = useStudy();
  const toast = useToast();
  const items = useMemo(() => selectedItems(sources, selectedIds), [sources, selectedIds]);
  const total = items.reduce((sum, item) => sum + (item.chars || 0), 0);
  const base = useMemo(() => planGenerationPath(items), [items]);
  const signature = base.steps.map(step => `${step.id}:${step.chars}`).join('|');
  const [ai, setAi] = useState(null), [aiState, setAiState] = useState({ phase: 'idle' });
  const [edits, setEdits] = useState({}), [queueing, setQueueing] = useState(false), [report, setReport] = useState(null);
  useEffect(() => { setAi(null); setEdits({}); setAiState({ phase: 'idle' }); setReport(null); }, [signature]);
  const ordered = ai ? applyPathRefinement(base.steps, { steps: ai }).steps : base.steps;
  const steps = ordered.map(step => ({ ...step, ...(edits[step.id] || {}) }));
  const included = steps.filter(step => step.included !== false);
  const indexed = !!indexCoverage && selectedIds.length > 0 && selectedIds.every(id => indexCoverage.indexed?.includes(id));
  const available = !!total && !(total <= STEP_CHARS && base.steps.length < 2);
  const patch = (id, change) => setEdits(current => ({ ...current, [id]: { ...(current[id] || {}), ...change } }));

  async function refine() {
    setAiState({ phase: 'loading' });
    try {
      const result = await call('generate.path.suggest', { steps: base.steps.map(({ id, title, pages, chars }) => ({ id, title, pages, chars })), course, ...(goal ? { goal } : {}) });
      if (result?.source === 'model' && result.steps?.length) { setAi(result.steps); setAiState({ phase: 'done' }); }
      else setAiState({ phase: 'unavailable', unavailable: result?.unavailable || { reason: 'nothing-usable' } });
    } catch (error) { setAiState({ phase: 'unavailable', unavailable: { reason: 'failed', message: String(error?.message || error) } }); }
  }
  async function queue() {
    setQueueing(true); setReport(null);
    const result = await queueSteps(call, included, gen, { course });
    setQueueing(false); setReport(result);
    if (result.started.length) { toast.success(uiFormat('已按顺序排队 {0} 个出题任务。', [result.started.length])); onQueued?.(result); }
  }
  // The conversation gets every step (in the language of the screen): the ones switched off are listed as steps to skip.
  const chat = () => askInChat?.(pathBrief({ steps: steps.map(step => ({ ...step, title: stepTitle(step) })), course, goal, indexed, language: getUiLanguage() }));
  const groups = report?.failed?.length ? failureGroups(report.failed, stepTitle) : [];
  return { available, total, steps, included, indexed, ai, aiState, queueing, report, groups, patch, refine, chat, queue };
}
