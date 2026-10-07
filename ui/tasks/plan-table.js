import { ui, uiFormat } from '../i18n.js';
import { joinMeta } from '../format.js';
import { filterItems } from '../components/index.js';
import { roundOfText, runPathText, needGotText, reasonWord } from '../coverage/copy.js';

/* 目标与知识点: what a question run set out to do, read from the job's contract alone (docs/job-contract.md detail.targets, detail.partList, detail.run, progress). Plain functions, no React, so a
   test can read them. The points are the planning stage's own (the contract's `detail.targets`: lib/plan-targets.js); nothing here asks a model for anything. A state is claimed only where the
   data supports it: the planning record says kept / failed / omitted; whether a point that is still undecided is waiting, being written or being reviewed is the part's calls' to say
   (`partList[i].stages`); a task that ended with the point undecided says it was stopped; anything else is left empty. */

const WRITING = new Set(['authoring', 'awaiting-review', 'reviewing', 'repairing']);
const ENDED_SHORT = new Set(['cancelled', 'failed', 'interrupted']);

/** What the calls of the round that is being made are doing, per batch: Map(part -> { running, done, failed }), each a Set of call kinds. A batch with no call has not started. */
function activityOf(calls, round) {
  const by = new Map();
  for (const call of calls || []) {
    if (!Number.isInteger(call.part) || (round !== undefined && call.round !== undefined && call.round !== round)) continue;
    const entry = by.get(call.part) || { running: new Set(), done: new Set(), failed: new Set() };
    if (call.status === 'running') entry.running.add(call.kind); else if (call.status === 'ok') entry.done.add(call.kind); else if (call.status === 'failed') entry.failed.add(call.kind);
    by.set(call.part, entry);
  }
  return by;
}

/** The state of one listed point: pending | authoring | awaiting-review | reviewing | repairing | passed | failed | stopped | '' (nothing to claim). */
export function pointState(entry, { live, status, round, parts }) {
  if (entry.state === 'kept') return 'passed';
  if (entry.state === 'failed' || entry.state === 'omitted') return entry.reason === 'cancelled' ? 'stopped' : 'failed';
  if (!live) return ENDED_SHORT.has(status) ? 'stopped' : '';
  // A point of a round that has not begun waits; one of a round that is over without a result is not claimed.
  if (entry.round !== undefined && Number.isInteger(round)) {
    if (entry.round > round) return 'pending';
    if (entry.round < round) return '';
  }
  const seen = parts.get(entry.part);
  if (!seen) return 'pending';
  if (seen.running.has('author') || seen.running.has('blueprint')) return 'authoring';
  if (seen.running.has('review')) return 'reviewing';
  if (seen.running.has('repair')) return 'repairing';
  if (seen.done.has('author') && !seen.done.has('review') && !seen.failed.has('review')) return 'awaiting-review';
  return '';
}

/** The words of a state (the cell and the filter use the same). */
export const STATE_WORD = { pending: '待出', authoring: '出题中', 'awaiting-review': '待审阅', reviewing: '审阅中', repairing: '修复中', passed: '已通过', failed: '没通过', stopped: '被停止' };
export const stateWord = (state) => (STATE_WORD[state] ? ui(STATE_WORD[state]) : '');

/** What a state means and what follows from it, for the tooltip: one sentence and at most one consequence. */
const STATE_MEANING = {
  pending: '这个考点所在的批次还没开始出题。轮到它时才会占用模型调用。',
  authoring: '模型正在为这个考点写题。写完后会交给独立审阅。',
  'awaiting-review': '题已写好，还没开始审阅。审阅通过后才会保留。',
  reviewing: '独立审阅正在检查这个考点的题。通过的题才会保留。',
  repairing: '审阅提出了问题，模型正在修这个考点的题。修好后会再审阅一次。',
  passed: '这个考点已经有一道通过审阅的题。它会计入覆盖。',
  failed: '这个考点没有留下通过审阅的题。想补上可以用「接着做」或「为没覆盖的部分补题」。',
  stopped: '任务结束时，这个考点还没有结果。已通过的题都保留；想补上可以用「接着做」。',
};
export const stateMeaning = (state) => (STATE_MEANING[state] ? ui(STATE_MEANING[state]) : '');

/** Why a point did not pass, in the words the log and the plan block already use (ui/coverage/copy.js reasonWord); '' when the record has no reason. */
export const pointWhy = (reason) => (reason && reason !== 'pending' ? reasonWord(reason) : '');
/** The same reason with what to do about it, for the tooltip. */
export const pointWhyLong = (reason) => (reason && reason !== 'pending' ? uiFormat('原因：{0}。{1}', [reasonWord(reason), ui('这个考点的题没有留下来；已通过的题不受影响。')]) : '');

/** 「Book · 第 12 页」: the source of a point as a cell shows it. */
export function sourceText(source) {
  if (!source) return '';
  return source.page ? joinMeta([source.title, uiFormat('第 {0} 页', [source.page])]) : source.title || '';
}

const keyOf = (round, part) => `${round ?? 0}:${part}`;

/**
 * The table of a task: { points, more, planning, groups: [{ key, round?, part, range?, short?, rows: [{ key, id, part, objective, source?, at?, state, reason? }] }], counts }.
 * `points` is how many points are listed, `more` how many past the bound are only counted. `planning`: a running task whose plan has not returned yet. A task without a record (one that predates it, or whose
 * kind lists none) has no groups. `counts` are over all listed points: passed, failed, stopped, running (being written / reviewed), pending.
 */
export function planTable(contract) {
  const targets = contract.detail?.targets, run = contract.detail?.run, live = ['queued', 'running', 'pausing', 'paused', 'cancelling'].includes(contract.status);
  const round = run ? (run.running ?? run.round) : undefined, parts = activityOf(contract.calls, Number.isInteger(round) ? round : undefined), ranges = new Map((contract.detail?.partList || []).map((part) => [part.part, part.range]));
  const context = { live, status: contract.status, round: Number.isInteger(round) ? round : undefined, parts };
  const counts = { passed: 0, failed: 0, stopped: 0, running: 0, pending: 0 }, groups = [], by = new Map();
  for (const entry of targets?.list || []) {
    const key = keyOf(entry.round, entry.part), state = pointState(entry, context);
    let group = by.get(key);
    if (!group) {
      const here = entry.round === undefined || entry.round === context.round, range = here ? ranges.get(entry.part) : undefined;
      const short = (targets.short || []).find((item) => item.part === entry.part && item.round === entry.round);
      group = { key, ...(entry.round !== undefined ? { round: entry.round } : {}), part: entry.part, ...(range ? { range } : {}), ...(short ? { short } : {}), rows: [] };
      by.set(key, group); groups.push(group);
    }
    if (state === 'passed') counts.passed++; else if (state === 'failed') counts.failed++; else if (state === 'stopped') counts.stopped++; else if (WRITING.has(state)) counts.running++; else if (state === 'pending') counts.pending++;
    group.rows.push({ key: `${key}:${entry.id}`, id: entry.id, part: entry.part, objective: entry.objective, ...(entry.source ? { source: entry.source } : {}), ...(entry.at !== undefined ? { at: entry.at } : {}),
      state, ...(entry.reason ? { reason: entry.reason } : {}) });
  }
  // A part the plan could not fill at all has no points to list, only the numbers: it is still a group, so the table says where the plan fell short.
  for (const short of targets?.short || []) {
    const key = keyOf(short.round, short.part);
    if (!by.has(key)) { const group = { key, ...(short.round !== undefined ? { round: short.round } : {}), part: short.part, short, rows: [] }; by.set(key, group); groups.push(group); }
  }
  groups.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.part - b.part);
  const planning = !targets && live && ['generation', 'supplement'].includes(contract.kind) && !(contract.calls || []).some((call) => ['author', 'review'].includes(call.kind));
  return { points: (targets?.list || []).length, more: targets?.more || 0, planning, groups, counts };
}

/** The filters of the table: 全部 / 进行中 / 没通过, with the count each has. */
export const FILTERS = [['all', '全部'], ['active', '进行中'], ['failed', '没通过']];
const inFilter = (row, filter) => (filter === 'active' ? WRITING.has(row.state) : filter === 'failed' ? row.state === 'failed' : true);
export function filterCounts(table) {
  const all = table.groups.flatMap((group) => group.rows);
  return { all: all.length, active: all.filter((row) => inFilter(row, 'active')).length, failed: all.filter((row) => inFilter(row, 'failed')).length };
}

/** The table narrowed by a filter and a search (case- and width-insensitive, every word must be in the point or its source); groups left without a row are dropped, except when nothing narrows. */
export function narrowTable(table, { filter = 'all', query = '' } = {}) {
  const narrowing = filter !== 'all' || !!String(query).trim();
  if (!narrowing) return table.groups;
  const match = (row) => `${row.objective} ${sourceText(row.source)}`;
  return table.groups.map((group) => ({ ...group, rows: filterItems(group.rows.filter((row) => inFilter(row, filter)), query, match) })).filter((group) => group.rows.length > 0);
}

/** 「第 2 批 · 5 个考点」, with the round in front for a coverage run. `count` is how many rows the group shows. */
export function groupTitle(group, count = group.rows.length) {
  const batch = count > 0 || !group.short ? uiFormat('第 {0} 批 · {1} 个考点', [group.part, count]) : uiFormat('第 {0} 批', [group.part]);
  return group.round !== undefined ? joinMeta([uiFormat('第 {0} 轮', [group.round]), batch]) : batch;
}

/** What the plan could not fill for a group, 「要 3 个考点，只给出 1 个」, or ''. */
export const groupShort = (group) => (group.short ? needGotText(group.short) : '');

/**
 * The goal of the task in a few plain lines (the same numbers and words as the facts above it: the questions asked for and kept, the round, the coverage path): [{ key, text }].
 * `material` is the title of the one material the task concerns (ui/tasks/task-material.js), or ''; `kindLabel` the name of the kind (出题 / 补题).
 */
export function goalLines(contract, { material = '', kindLabel = '', table } = {}) {
  const { progress, detail } = contract, lines = [], run = detail?.run;
  const sourceCount = new Set((detail?.partList || []).flatMap((part) => part.sourceIds || [])).size;
  const from = material ? uiFormat('来自「{0}」', [material]) : sourceCount > 0 ? uiFormat('来自 {0} 份资料', [sourceCount]) : '';
  const asked = progress.total > 0 ? uiFormat('{0}：目标 {1} 题', [kindLabel, progress.total]) : kindLabel;
  lines.push({ key: 'what', text: joinMeta([asked, progress.total > 0 ? uiFormat('已出 {0}/{1} 题', [progress.done, progress.total]) : '', from]) });
  const ranges = [...new Set((detail?.partList || []).map((part) => part.range).filter(Boolean))];
  if (ranges.length) lines.push({ key: 'where', text: uiFormat('范围：{0}', [ranges.length > 3 ? uiFormat('{0} 等 {1} 处', [ranges.slice(0, 2).join(ui('、')), ranges.length]) : ranges.join(ui('、'))]) });
  if (run?.total) lines.push({ key: 'round', text: joinMeta([run.ended ? uiFormat('共 {0} 轮', [run.done]) : roundOfText(run.round, run.rounds), runPathText(run) || (Number.isFinite(run.percent) ? uiFormat('覆盖 {0}%', [run.percent]) : '')]) });
  if (table?.points) {
    const { counts } = table, total = table.points + table.more;
    lines.push({ key: 'points', text: joinMeta([uiFormat('规划了 {0} 个考点', [total]), uiFormat('已通过 {0}', [counts.passed]), counts.failed > 0 ? uiFormat('没通过 {0}', [counts.failed]) : '', counts.stopped > 0 ? uiFormat('被停止 {0}', [counts.stopped]) : '',
      counts.running > 0 ? uiFormat('进行中 {0}', [counts.running]) : '', table.more > 0 ? uiFormat('另有 {0} 个未列出', [table.more]) : '']) });
  }
  return lines;
}

/** The number on the tab: how many points are listed (with the ones past the bound), or '' while it is not known. */
export const planCount = (contract) => { const targets = contract.detail?.targets; return targets ? targets.list.length + (targets.more || 0) : ''; };
