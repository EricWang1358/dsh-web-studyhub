import { ui, uiFormat } from '../i18n.js';
import { META_DOT } from '../format.js';

/* What the 「下一步」 card says in each state (ui/study-map/next-step.js names the state; ui/study-map/NextStepCard.jsx draws this). Every card names the situation
   with a fact (a count, a title, a day) and offers one action; the words follow docs/voice-and-tone.zh-CN.md: say what is, then the one next step, no guilt,
   no exclamation mark. The first three states (model before a first deck, sources, questions) are drawn by the first-run line, not here.

   handlers: { plan, generate(sourceIds), wrong(), exam(course), modelSettings(), settingsLabel }. `plan` is buildHomePlan's `plan` (the home's own card): the
   states that are about today's round use its button as it is, so the one verb (接着做, 继续学习, 开始今日学习) is the same on both cards. */

const breakdown = (today) => [today.weak > 0 && uiFormat('{0} 题薄弱', [today.weak]), today.new > 0 && uiFormat('{0} 题未学', [today.new])].filter(Boolean).join(META_DOT);

const act = (label, run, disabled = false, usage = 'home.next') => (typeof run === 'function' && label ? { label, run, disabled: !!disabled, usage } : null);

/**
 * { id, eyebrow, headline, detail, action } for state `id`; `action` is { label, run, disabled } or null (nothing to press).
 */
export function nextCardView(id, facts, handlers = {}) {
  const eyebrow = ui('下一步');
  const { today, newSources, exam } = facts;
  const plan = handlers.plan;
  const planAction = plan?.action ? act(plan.action.label, plan.action.run, plan.action.disabled, 'home.start') : null;
  switch (id) {
    case 'model':
      return { id, eyebrow, headline: ui('还没有可用的 AI 模型'), detail: ui('出题要用它。已有的题照常练习和复习。'), action: act(handlers.settingsLabel, handlers.modelSettings) };
    case 'due':
      return { id, eyebrow, headline: uiFormat('今天有 {0} 题到期', [today.due]), detail: breakdown(today), action: planAction };
    case 'resume':
      return { id, eyebrow, headline: ui('有一组练习没做完'), detail: plan?.detail || '', action: planAction };
    case 'new-source':
      return newSources.count === 1
        ? { id, eyebrow, headline: uiFormat('「{0}」还没出过题', [newSources.title]), detail: ui('选好题型和题数就能出，出好的题先放进草稿。'),
          action: act(ui('用这份资料出题'), () => handlers.generate?.(newSources.sourceIds), !handlers.generate) }
        : { id, eyebrow, headline: uiFormat('{0} 份新资料还没出过题', [newSources.count]), detail: ui('选好题型和题数就能出，出好的题先放进草稿。'),
          action: act(uiFormat('用这 {0} 份新资料出题', [newSources.count]), () => handlers.generate?.(newSources.sourceIds), !handlers.generate) };
    case 'wrong':
      return { id, eyebrow, headline: uiFormat('有 {0} 题待巩固', [facts.wrong]), detail: ui('答错或自评没掌握的题。再答对一次，它就移到「已订正」，记录仍保留。'),
        action: act(ui('看错题与待巩固'), handlers.wrong) };
    case 'exam':
      return { id, eyebrow, headline: exam.days === 0 ? uiFormat('「{0}」今天考试', [exam.course]) : exam.days === 1 ? uiFormat('「{0}」明天考试', [exam.course])
        : uiFormat('「{0}」{1} 天后考试', [exam.course, exam.days]), detail: ui('复习全书能按剩下的天数，排好每天读哪几节。'),
      action: act(ui('打开复习全书'), () => handlers.exam?.(exam.course), !handlers.exam) };
    default:
      return today.ahead
        ? { id: 'done', eyebrow, headline: ui('今天的任务都完成了'), detail: ui('想多练的话，可以提前巩固。'), action: null }
        : { id: 'done', eyebrow, headline: ui('今天没有要做的复习'), detail: ui('有新资料、新错题或临近的考试时，下一步会出现在这里。'), action: null };
  }
}
