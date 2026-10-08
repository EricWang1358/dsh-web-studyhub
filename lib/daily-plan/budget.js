import { check, rootKey, taskProgress, taskView, savedTask, findTask } from './tasks.js';

const defaultProfile = () => ({ weekdayMinutes: 40, weekendMinutes: 60, source: 'default' });
export const allocationMinutes = (plan, card) => plan?.allocations?.[card.id] ?? card.learningTask.minutes;
// The original allocation prices only the units unfinished when the task was created.
export const unitMinutesOf = (task, total) => task.minutes / Math.max(1, total - (task.initialDone || 0));
const weekend = date => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
export function minutes(value) {
  check(Number.isInteger(value) && value >= 0 && value <= 240, '学习时间需要是 0–240 的整数分钟');
  return value;
}

export function planner(board, create = false) {
  if (!board.dailyPlanner && create) board.dailyPlanner = { version: 1, profile: defaultProfile(), plans: {} };
  const value = board.dailyPlanner || { version: 1, profile: defaultProfile(), plans: {} };
  check(
    value.version === 1 && value.profile && value.plans &&
    typeof value.plans === 'object' && !Array.isArray(value.plans),
    '学习安排数据无法读取，请保留原文件并修复',
  );
  minutes(value.profile.weekdayMinutes);
  minutes(value.profile.weekendMinutes);
  return value;
}
export const planKey = (root, date) => `${rootKey(root)}_${date}`;
function effortRecord(board, state, plan, taskId) {
  const card = findTask(board, plan, taskId);
  if (!card?.learningTask) return null;
  const progress = taskProgress(state, card);
  const existing = plan.effort?.[taskId];
  if (existing?.closed) return existing;
  const unitMinutes = existing?.unitMinutes ?? unitMinutesOf(card.learningTask, progress.total);
  const baselineDone = existing?.baselineDone ?? Math.max(
    card.learningTask.initialDone || 0,
    progress.total - Math.round(allocationMinutes(plan, card) / unitMinutes),
  );
  const observedDone = Math.max(existing?.observedDone || baselineDone, progress.done);
  const actualMinutes = existing?.actualMinutes ??
    (card.learningTask.completedDate === plan.date ? card.learningTask.actualMinutes : undefined);
  const completed = existing?.completed || progress.done === progress.total;
  return {
    ...existing, task: savedTask(card), baselineDone, observedDone,
    total: progress.total, unitMinutes, completed,
    ...(actualMinutes !== undefined ? { actualMinutes } : {}),
  };
}

export function recordAllocation(plan, state, card) {
  plan.effort ||= {};
  if (plan.effort[card.id]) return;
  const progress = taskProgress(state, card);
  plan.effort[card.id] = {
    task: savedTask(card), baselineDone: progress.done, observedDone: progress.done,
    total: progress.total, unitMinutes: unitMinutesOf(card.learningTask, progress.total), completed: false,
  };
}

export function effortView(board, state, plan) {
  if (!plan) return {};
  // The ledger keeps spent effort even when a task is unselected, archived or deleted.
  const taskIds = new Set([...(plan.taskIds || []), ...Object.keys(plan.effort || {})]);
  return Object.fromEntries([...taskIds].flatMap(taskId => {
    const record = effortRecord(board, state, plan, taskId);
    return record ? [[taskId, record]] : [];
  }));
}

function recordedEffort(record) {
  return record.actualMinutes ?? Math.max(0, record.observedDone - record.baselineDone) *
    (record.unitMinutes ?? unitMinutesOf(record.task.learningTask, record.total));
}

export const spentEffort = records => Math.ceil(Object.values(records).reduce((sum, record) => sum + recordedEffort(record), 0));

export function syncEffort(board, state, root, date, closePrevious = false) {
  for (const [key, plan] of Object.entries(planner(board).plans)) {
    if (!key.startsWith(`${rootKey(root)}_`) || !plan.acceptedId || plan.date > date) continue;
    plan.effort = effortView(board, state, plan);
    if (closePrevious && plan.date < date) {
      for (const record of Object.values(plan.effort)) record.closed = true;
    }
  }
}
function profileView(board, root, state) {
  const profile = { ...planner(board).profile, sampleDays: 0 };
  const days = Object.entries(planner(board).plans).filter(([key, plan]) => key.startsWith(`${rootKey(root)}_`) && plan.acceptedId);
  const observations = [[], []];
  for (const [, plan] of days) {
    const records = Object.values(effortView(board, state, plan)).filter(record =>
      record.observedDone > record.baselineDone || record.actualMinutes !== undefined);
    if (!records.length || records.some(record =>
      record.actualMinutes === undefined || !record.completed || record.task.learningTask.completedDate !== plan.date)) continue;
    const total = records.reduce((sum, record) => sum + record.actualMinutes, 0);
    if (total > 0 && total <= 240) observations[Number(weekend(plan.date))].push(total);
  }
  profile.sampleDays = observations[0].length + observations[1].length;
  for (const [index, field] of ['observedWeekdayMinutes', 'observedWeekendMinutes'].entries()) {
    if (observations[index].length < 5) continue;
    const sorted = observations[index].sort((a, b) => a - b);
    profile[field] = Math.max(1, Math.round(sorted[Math.floor(sorted.length / 2)] / 5) * 5);
  }
  if (profile.source !== 'explicit' &&
      (profile.observedWeekdayMinutes !== undefined || profile.observedWeekendMinutes !== undefined)) profile.source = 'inferred';
  return profile;
}
export function dto(board, state, root, date) {
  const plan = planner(board).plans[planKey(root, date)];
  const profile = profileView(board, root, state);
  const tasks = (plan?.taskIds || []).flatMap(taskId => {
    const card = findTask(board, plan, taskId);
    if (!card?.learningTask) return [];
    const view = taskView(board, state, card, root);
    const archived = !board.cards[taskId];
    if (archived && view.status !== 'done') return [];
    return [{ ...view, minutes: allocationMinutes(plan, card), ...(archived ? { archived: true, available: false } : {}) }];
  });
  const usual = profile[weekend(date) ? 'weekendMinutes' : 'weekdayMinutes'];
  const observed = profile[weekend(date) ? 'observedWeekendMinutes' : 'observedWeekdayMinutes'];
  const inferred = profile.source !== 'explicit' && observed !== undefined;
  const baseline = inferred ? observed : usual;
  return {
    date, budgetMinutes: plan?.budgetMinutes ?? baseline,
    spentMinutes: spentEffort(effortView(board, state, plan)),
    budgetBasis: plan?.budgetBasis || (inferred ? 'habit' : 'profile'), profile,
    proposal: plan?.proposal || null, tasks,
    // Today was settled (a plan accepted, an empty one included): the page does not offer a new proposal on every visit.
    accepted: !!plan?.acceptedId,
    warnings: tasks.some(task => !task.available && task.status !== 'done')
      ? ['部分任务的学习内容已删除、归档或停用，请重新安排。'] : [],
  };
}
