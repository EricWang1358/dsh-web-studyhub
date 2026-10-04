import { win32 } from 'node:path';
import { boardAction, boardTransaction, boardUnchanged } from './board.js';
import { id } from './util.js';
import { available, check, columnOf, findTask, rootKey, taskProgress, taskView, validDate } from './daily-plan/tasks.js';
import { allocationMinutes, dto, effortView, minutes, planKey, planner, recordAllocation, spentEffort, syncEffort } from './daily-plan/budget.js';
import { contentDigest, negotiateProposal } from './daily-plan/proposal.js';
import { startPracticeRun } from './daily-plan/practice-run.js';

const now = () => new Date().toISOString();

function place(board, taskId, done) {
  const from = columnOf(board, taskId);
  const to = done ? board.columns.find(column => column.done)
    : board.columns.find(column => column.id === 'doing' && !column.done);
  if (from && to && from !== to) {
    from.cardIds = from.cardIds.filter(value => value !== taskId);
    to.cardIds.push(taskId);
  }
}

/** The six public operations own board transactions and consent; learning evidence stays in its library. */
export function dailyPlanOperations(ports) {
  const { state: storage, light, complete, language } = ports;
  const root = storage.root;

  const get = async args => {
    const date = validDate(args.date);
    const state = await storage.view();
    const board = await boardAction('board.get');
    const hasCompletionEvidence = card => {
      if (!card.learningTask || card.learningTask.kind === 'reading' || rootKey(card.studyRef?.root || '') !== rootKey(root)) return false;
      const progress = taskProgress(state, card);
      return progress.done === progress.total;
    };
    const needsSync = Object.values(board.cards).some(card => hasCompletionEvidence(card) && !card.learningTask.completedAt);
    if (needsSync && !board.readOnly) return boardTransaction(latest => {
      for (const card of Object.values(latest.cards)) {
        if (!hasCompletionEvidence(card) || card.learningTask.completedAt) continue;
        card.learningTask.completedAt = now();
        card.learningTask.completedDate = date;
        place(latest, card.id, true);
      }
      syncEffort(latest, state, root, date);
      return dto(latest, state, root, date);
    });
    const view = dto(board, state, root, date);
    if (board.readOnly) view.warnings.push(board.error);
    return view;
  };

  const profile = async args => {
    const date = validDate(args.date);
    const state = await storage.view();
    const weekdayMinutes = minutes(args.weekdayMinutes), weekendMinutes = minutes(args.weekendMinutes);
    return boardTransaction(board => {
      planner(board, true).profile = { weekdayMinutes, weekendMinutes, source: 'explicit', updatedAt: now() };
      return dto(board, state, root, date);
    });
  };

  const suggest = async args => {
    const date = validDate(args.date);
    const state = await storage.view();
    const board = await boardAction('board.get');
    check(!board.readOnly, board.error);
    check(args.feedback === undefined || typeof args.feedback === 'string' && args.feedback.length <= 2000, '调整意见最多 2000 字');
    const before = planner(board), previous = before.plans[planKey(root, date)];
    if (args.proposalId) check(previous?.proposal?.id === args.proposalId, '建议已更新，请重新查看再调整');
    const baseline = dto(board, state, root, date);
    const { budget, budgetBasis, preferences, proposal } = await negotiateProposal({
      args, state, board, root, date, language, previous,
      budget: args.minutes === undefined ? baseline.budgetMinutes : minutes(args.minutes),
      budgetBasis: args.minutes === undefined ? baseline.budgetBasis : 'today',
      spent: spentEffort(effortView(board, state, previous)), model: light || complete,
    });
    return boardTransaction(latest => {
      const data = planner(latest, true), current = data.plans[planKey(root, date)];
      check(
        (current?.proposal?.id || null) === (previous?.proposal?.id || null) &&
        (current?.acceptedId || null) === (previous?.acceptedId || null),
        '安排已更新，请重新查看再生成建议',
      );
      check(JSON.stringify(data.profile) === JSON.stringify(before.profile), '长期学习量已更新，请重新生成建议');
      syncEffort(latest, state, root, date);
      data.plans[planKey(root, date)] = {
        ...current, date, budgetMinutes: budget, budgetBasis, feedbackHistory: preferences, proposal,
      };
      return dto(latest, state, root, date);
    });
  };

  const accept = async args => {
    const date = validDate(args.date);
    check(typeof args.proposalId === 'string' && args.proposalId.length <= 100, '请提供要接受的建议');
    return boardTransaction(async board => {
      const state = await storage.view();
      const plan = planner(board, true).plans[planKey(root, date)];
      check(plan, '还没有可接受的学习建议');
      if (plan.acceptedId === args.proposalId) return boardUnchanged(dto(board, state, root, date));
      check(plan.proposal?.id === args.proposalId, '建议已更新，请重新查看再接受');
      const items = plan.proposal.items;
      const destination = board.columns.find(column => column.id === 'todo' && !column.done)
        || board.columns.find(column => !column.done);
      check(destination || !items.length, '请先在待办中保留一个未完成列');

      syncEffort(board, state, root, date, true);
      const taskIds = Object.keys(plan.effort || {}).filter(taskId => plan.effort[taskId].completed);
      const allocations = Object.fromEntries(taskIds.map(taskId =>
        [taskId, allocationMinutes(plan, findTask(board, plan, taskId))]));
      const spent = spentEffort(plan.effort || {});
      check(
        items.reduce((sum, item) => sum + item.minutes, 0) <= Math.max(0, plan.budgetMinutes - spent),
        '今日进度或实际用时已更新，请重新生成预算内的建议',
      );
      for (const item of items) {
        const candidateCard = item.taskId ? board.cards[item.taskId] : { studyRef: item.studyRef, learningTask: item };
        check(candidateCard && available(state, candidateCard, root), '建议中的内容已删除、归档或停用，请重新生成建议');
        check(item.contentDigest === contentDigest(state, item), '建议中的学习内容已更新，请重新生成建议');
        if (item.taskId) check(taskView(board, state, candidateCard, root).status !== 'done', '任务已完成，请重新生成建议');
        const taskId = item.taskId || id();
        if (!item.taskId) {
          const stamp = now();
          board.cards[taskId] = {
            id: taskId, title: item.title, note: item.reason, due: date, labels: ['学习计划'],
            createdAt: stamp, updatedAt: stamp,
            origin: { workspace: root, workspaceTitle: win32.isAbsolute(root) ? win32.basename(root) : root.split('/').at(-1) },
            studyRef: item.studyRef,
            learningTask: {
              version: 1, kind: item.kind, minutes: item.minutes, reason: item.reason, scope: item.scope,
              createdDate: date, initialDone: item.progress.done,
              ...(item.stepCount ? { stepCount: item.stepCount } : {}),
            },
          };
          destination.cardIds.push(taskId);
        }
        taskIds.push(taskId);
        allocations[taskId] = item.minutes;
        recordAllocation(plan, state, board.cards[taskId]);
      }
      plan.taskIds = [...new Set(taskIds)];
      plan.allocations = allocations;
      plan.acceptedId = args.proposalId;
      plan.acceptedAt = now();
      plan.proposal = null;
      return dto(board, state, root, date);
    });
  };

  const start = async args => {
    const date = validDate(args.date);
    return boardTransaction(async board => {
      const plan = planner(board).plans[planKey(root, date)], card = board.cards[args.taskId];
      check(plan?.taskIds?.includes(args.taskId) && card?.learningTask, '任务已移除或不属于这份学习安排');
      const state = await storage.view();
      check(available(state, card, root), '学习内容已删除、归档或停用，请重新安排');
      check(taskView(board, state, card, root).status !== 'done', '这项任务已完成');
      const task = card.learningTask;
      const run = task.kind === 'practice' ? await startPracticeRun(storage, card, root) : undefined;
      if (run) task.runId = run.id;
      task.startedAt ||= now();
      card.updatedAt = now();
      place(board, card.id, false);
      return { run, studyRef: card.studyRef, task: taskView(board, await storage.view(), card, root) };
    });
  };

  const finish = async args => {
    const date = validDate(args.date), actual = args.minutes === undefined ? undefined : minutes(args.minutes);
    return boardTransaction(async board => {
      const plan = planner(board).plans[planKey(root, date)], card = board.cards[args.taskId];
      check(plan?.taskIds?.includes(args.taskId) && card?.learningTask, '任务已移除或不属于这份学习安排');
      const state = await storage.view(), task = card.learningTask;
      check(available(state, card, root), '学习内容已删除、归档或停用，请重新安排');
      const progress = taskProgress(state, card);
      check(task.kind === 'reading' || progress.done === progress.total, '请先实际完成练习或学习流；打开或跳过不会算作完成');
      task.completedAt ||= now();
      task.completedDate ||= date;
      if (actual !== undefined) task.actualMinutes = actual;
      card.updatedAt = now();
      place(board, card.id, true);
      syncEffort(board, state, root, date);
      const record = plan.effort?.[card.id];
      if (record && actual !== undefined) record.actualMinutes = actual;
      return dto(board, state, root, date);
    });
  };

  return {
    'daily.plan.get': get,
    'daily.plan.profile': profile,
    'daily.plan.suggest': suggest,
    'daily.plan.accept': accept,
    'daily.plan.start': start,
    'daily.plan.complete': finish,
  };
}
