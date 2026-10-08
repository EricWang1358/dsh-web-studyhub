import { ui, uiFormat } from '../i18n.js';
import { documentCount } from '../generation-status.js';
import { TERMS } from '../mastery-terms.js';
import { workspaceFilePrompt } from '../agent-prompts/library.js';
import { joinMeta, formatDateTime } from '../format.js';
import { JOB_TYPES } from '../../lib/job-status.js';
import { practiceArgs } from '../learning-navigation.js';

/**
 * What `start` is given for today's path: the current course's round (due, weak, then new, at most the round size), which is the number the home card
 * counts (lib/daily-path.js); every active course's path in 笔试 / 面试 mode and when no course is current. `today` is the snapshot's `data.today`.
 */
export const dailyPathArgs = (today) => practiceArgs(undefined, { fresh: false, ...(today?.course != null ? { course: today.course, daily: true } : {}) });

/**
 * What the home card offers. The card offers exactly one action: a newcomer's
 * next step, else an open run, else today's path of the current course (due,
 * weak, then new: one number, the breakdown counted over the same cards); every
 * other start (the course's next batch, new questions only, the work waiting in
 * other courses) stays reachable as a quiet link beside it. Pure: `actions` are
 * the handlers a click calls and `revealActivity` scrolls the progress card into view.
 *
 * Returns { interview, route, starter, headline, plan, alternatives, shownRun,
 * otherRuns, otherCourse, todayLabel }. `plan` is { kind, eyebrow, count, unit,
 * detail, action: { label, run, disabled }, also: [[label, run]], depth }.
 */
export function buildHomePlan({ data, today, runs, runFor, activeJobs, inFocus, actions, canChat, revealActivity }) {
  const { start, resume, openDraft, addSource, importLibrary, askInChat, generateFromSources, startCourseFlow, onCoachPractice, onWeakPoints } = actions;
  const todayRun = runFor(today.scope ?? []);
  /* No decks yet: the card walks a newcomer from materials to a first deck
     (D1): add a material → generate from it → check and publish the draft.
     JSON import stays one link away for people who already have questions. */
  const materials = documentCount(data.sources || []), newestDraft = data.drafts?.at(-1);
  const generating = activeJobs.some((job) => job.type !== JOB_TYPES.DRAFT_REPAIR);
  const jsonLink = [ui('已有题目？导入 JSON 题组'), importLibrary];
  /* The sample course (设置 › 学习画像与导览) can stay after its tour; it is not the learner's library, so it does not hide the way to a first deck of their own. */
  const sampleIds = new Set([data.sample?.deckId, data.sample?.caseDeckId].filter(Boolean));
  const starter = data.decks.some((deck) => !sampleIds.has(deck.id)) ? null
    : newestDraft ? { kind: 'empty', step: 2, eyebrow: ui('下一步'), headline: ui('检查草稿，就能开始练习'),
      title: ui('草稿已生成'), next: ui('草稿里的每道题都能修改；发布时还会再检查一遍。'),
      action: { label: ui('检查并发布草稿'), run: () => openDraft(newestDraft) }, also: [jsonLink] }
      : generating ? { kind: 'empty', step: 1, eyebrow: ui('正在出题'), headline: ui('第一组题正在生成'),
        title: ui('正在出第一组题'), next: ui('出题在后台进行，离开这一页也不会中断；完成后草稿会出现在上方。'),
        action: { label: ui('查看进度'), run: revealActivity }, also: [] }
        : materials ? { kind: 'empty', step: 1, eyebrow: ui('下一步'), headline: ui('用资料出第一组题'),
          title: uiFormat('{0} 份资料已就绪', [materials]), next: ui('选好资料、题型和题数，AI 出题后会逐题检查，再交给你确认。'),
          action: { label: uiFormat('用这 {0} 份资料出题', [materials]), run: () => generateFromSources?.(data.sources.map((source) => source.id)) },
          also: [[ui('＋ 再添加资料'), addSource], jsonLink] }
          : { kind: 'empty', step: 0, eyebrow: ui('开始'), headline: ui('从一份资料开始'),
            title: ui('还没有资料'), next: ui('添加讲义、笔记或 PDF，AI 会据此出题；发布后这里会给出学习路径。'),
            action: { label: ui('添加第一份资料'), run: addSource },
            also: [jsonLink, ...(canChat ? [[ui('在对话中用工作区文件出题'), () => askInChat(
              workspaceFilePrompt())]] : [])] };
  const breakdown = [
    today.due && uiFormat('{0} 题到期', [today.due]),
    today.weak && uiFormat('{0} 题薄弱', [today.weak]),
    today.new && uiFormat('{0} 题未学', [today.new]),
  ].filter(Boolean);
  const later = today.more > 0 ? uiFormat('另有 {0} 题留到下一轮', [today.more]) : '';
  const headline = starter ? starter.headline : today.ahead ? ui('今天的任务都完成了') : breakdown.join(' · ') || ui('暂无可学习的题目');
  const interview = data.focus?.mode === 'interview';
  const freshCount = Math.min(10, data.focus?.fresh?.length || 0);
  const todayLabel = formatDateTime(new Date(), 'longDay');
  const startFresh = () => start({ mode: 'new', currentCourse: true, count: 10, fresh: true });
  const startPath = () => (todayRun ? resume(todayRun.id) : start(dailyPathArgs(today)));
  const startEverywhere = () => start(practiceArgs(undefined, { fresh: false }));
  // 课程路线 (class mode): an unfinished batch first, else the next batch in chapter order.
  const route = !interview ? data.focus?.route : null;
  const courseRun = route && runs.find((r) => r.purpose === 'course' && r.course === route.course);
  const startCourse = () => (courseRun ? resume(courseRun.id) : start({ mode: 'course' }));
  const flowLink = startCourseFlow && route?.next?.fresh ? [[ui('先讲后练 · 学习流'), () => startCourseFlow()]] : [];
  /* The ways to start that are not the round: the course's next batch (chapter order), new questions only, and whatever waits in the other courses. */
  const otherStarts = [
    ...(route?.next ? [[uiFormat('课程下一批 · {0} 题', [route.next.fresh + route.next.reviews]), startCourse]] : []),
    ...(!interview && freshCount ? [[uiFormat('只学当前课程新题 · {0} 题', [freshCount]), startFresh]] : []),
    ...flowLink,
    ...(today.elsewhere > 0 ? [[uiFormat('其他课程另有 {0} 题到期或薄弱 · 一起学', [today.elsewhere]), startEverywhere]] : []),
  ];
  const base = starter
    ? starter
    : courseRun
      ? { kind: 'resume', eyebrow: ui('继续课程'), count: courseRun.total - courseRun.index, unit: ui('题未完成'),
        detail: uiFormat('这一批已做到第 {0} / {1} 题', [courseRun.index + 1, courseRun.total]),
        action: { label: ui('接着学'), run: startCourse }, also: otherStarts.filter(([, run]) => run !== startCourse) }
      : todayRun
        ? { kind: 'resume', eyebrow: ui('继续今日'), count: todayRun.total - todayRun.index, unit: ui('题未完成'),
          detail: uiFormat('已做到第 {0} / {1} 题', [todayRun.index + 1, todayRun.total]),
          action: { label: ui('继续学习'), run: startPath }, also: otherStarts }
        : { kind: today.size ? 'path' : 'clear', eyebrow: today.ahead ? ui('提前巩固') : ui('今日学习'),
          count: today.size, unit: ui('题待学'),
          detail: today.ahead ? ui('今天的任务都完成了') : today.size ? joinMeta([breakdown.join(' · '), later]) : ui('今天已经清空'),
          action: { label: today.ahead ? ui('提前巩固') : ui('开始今日学习'), run: startPath, disabled: !today.size },
          also: otherStarts };
  /* The run the learner was last inside (the rail's 回到题目) outranks a new
     batch: a deck, topic or 为你定制 run left half done must not sink into
     the fold below while the big button quietly starts something else. */
  const lastRunFound = data.decks.length ? runs.find((r) => r.id === data.lastRun?.id) : null;
  // A half-done practice in a parked course is not pushed as 接着做; it stays in the list below with its state.
  const lastOpen = lastRunFound && !lastRunFound.inactive ? lastRunFound : null;
  /* A semester holds several courses and any of them may be the one left half
     done, so a run from outside the course in the heading names its course
     instead of being held back. System decks (为你定制) belong to no course. */
  const otherCourse = (r) => {
    const courses = new Set((r.deckIds || [r.deckId]).map((id) => data.decks.find((d) => d.id === id)).filter((d) => d && !d.systemKind).map((d) => d.course));
    const [course] = courses;
    return courses.size === 1 && (interview || !inFocus(course ?? '')) ? course : '';
  };
  const baseLink = base.kind === 'path' ? uiFormat('今日学习 · {0} 题', [base.count]) : '';
  const plan = lastOpen && lastOpen !== courseRun && lastOpen !== todayRun
    ? { kind: 'resume', eyebrow: ui('接着上次'), count: lastOpen.total - lastOpen.index, unit: ui('题未完成'),
      detail: uiFormat('{0} · 已做到第 {1} / {2} 题', [[otherCourse(lastOpen), lastOpen.title].filter(Boolean).join(' › '), lastOpen.index + 1, lastOpen.total]),
      action: { label: ui('接着做'), run: () => resume(lastOpen.id) },
      also: [...(baseLink ? [[baseLink, base.action.run]] : []), ...base.also.filter(([label]) => label !== baseLink)] }
    : base;
  const shownRun = plan === base ? courseRun || todayRun : lastOpen;
  /* The other ways to start (new questions, due review, the flow, personalised questions, weak points) sit under one folded
     line: the card is the one thing to continue, the recommendation the one next step. */
  const alternatives = [
    ...plan.also.map(([label, run]) => [label, run]),
    ...(data.coach?.ready > 0 && onCoachPractice ? [[uiFormat('刷 {0} 道为你定制的题', [data.coach.ready]), onCoachPractice,
      ui('从你答错、标记太简单/太难和只练了概念的地方出发，换成具体场景再练一遍。')]] : []),
    ...(today.weak > 0 && onWeakPoints ? [[uiFormat('{0} 题薄弱 · 看错题与待巩固', [today.weak]), onWeakPoints, ui(TERMS.weak.hint)]] : []),
  ];
  // Cards visible behind the top one: the stack is as thick as the day.
  plan.depth = plan.kind === 'empty' ? 0 : Math.min(2, Math.max(0, (plan.count || 0) - 1));
  return { interview, route, starter, headline, plan, alternatives, shownRun, otherRuns: runs.filter((r) => r !== shownRun), otherCourse, todayLabel };
}
