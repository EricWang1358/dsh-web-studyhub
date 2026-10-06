/* What a question-generation job says to the learner (P15, P26–P29): plain
   words in the UI language, keyed by the backend's stable stage codes, with a
   fix for failures. Raw provider/engine prose is only shown behind 技术详情. */
import { ui, uiFormat, getUiLanguage, uiIsEnglish } from './i18n.js';
import { stageCodeOf, stepStageCode } from '../lib/contexts/jobs/contracts.js';
import { isActiveJob, supplementJobLabel } from './job-visibility.js';
import { JOB_STATUS, JOB_TYPES } from '../lib/job-status.js';
import { countDocuments } from '../lib/source-groups.js';
import { GENERATION_SETTINGS_DEFAULTS, resolveGenerationRequest } from '../lib/generation-settings.js';
import { DIMENSIONS, issueCode, reasonLabel } from './quality-reasons.js';
import { classifyFailure } from '../lib/generation-failure.js';
import { formatClauses } from './format.js';
import { USAGE_STAGES, stageUsage } from '../lib/stage-usage.js';
import { DEFAULT_LEVEL } from '../lib/coverage-strength.js';

/** The generate form after a job starts: one source of the defaults (P27). */
export const GENERATION_DEFAULTS = Object.freeze({ kind: GENERATION_SETTINGS_DEFAULTS.kind, count: GENERATION_SETTINGS_DEFAULTS.count,
  difficulty: GENERATION_SETTINGS_DEFAULTS.difficulty, focus: GENERATION_SETTINGS_DEFAULTS.focus, notation: GENERATION_SETTINGS_DEFAULTS.notation, role: '',
  // 覆盖强度 (lib/coverage-strength.js): the form plans by level; a number of questions is only sent when the learner types one (`customCount`).
  coverageLevel: DEFAULT_LEVEL, customCount: '',
  // 花费上限 is typed as 800K / 2.5M (lib/coverage-run.js parseTokenBudget) and optional. (自动补到完整 has no default of its own: it follows the level until the learner ticks it, `gen.autoComplete`.)
  tokenBudget: '' });

export function generationFormDefaults(saved, language = getUiLanguage()) {
  const { performance: _performance, ...content } = resolveGenerationRequest(saved, {}, { language });
  return { ...GENERATION_DEFAULTS, ...content };
}

/** Only inherited defaults follow a settings update; typed choices stay put. */
export function syncGenerationDefaults(current, before, after) {
  let next = current;
  for (const [key, value] of Object.entries(current)) {
    if (!Object.hasOwn(after, key) || value !== before[key] || Object.is(value, after[key])) continue;
    if (next === current) next = { ...current };
    next[key] = after[key];
  }
  return next;
}

/** Start another deck with saved content defaults and the learner's role. */
export const freshGeneration = (gen = {}, saved, language = getUiLanguage()) => { const { autoComplete: _chosen, ...rest } = gen; return { ...rest,
  ...(saved === undefined ? { kind: GENERATION_DEFAULTS.kind, count: GENERATION_DEFAULTS.count, focus: '', notation: GENERATION_DEFAULTS.notation, coverageLevel: GENERATION_DEFAULTS.coverageLevel, customCount: '', tokenBudget: '' }
    : generationFormDefaults(saved, language)), role: gen.role ?? '', title: '', course: undefined }; };

/** Plan contract C3 first (`data.model`), then the legacy `modelReady` flag. */
export function modelReadiness(data) {
  const model = data?.model;
  if (model && typeof model === 'object' && typeof model.ready === 'boolean')
    return { ready: model.ready, reason: model.reason || (model.ready ? 'ok' : 'unknown'), label: model.label || '' };
  const ready = !!data?.modelReady;
  return { ready, reason: ready ? 'ok' : 'no-route', label: '' };
}

/** Materials as the learner counts them: a PDF is one material, not one per page. */
export const documentCount = countDocuments;

export const jobCode = (job) => (typeof job?.stageCode === 'string' && job.stageCode) || stageCodeOf(job);
const draftOf = (job, drafts = []) => (job?.draftId && drafts.find((draft) => draft.id === job.draftId)) || null;
const ownProse = (job) => job?.type === JOB_TYPES.DRAFT_PUBLISH || job?.type === JOB_TYPES.DRAFT_REPAIR;

/** Where a job is, as a short status. */
export function stageCodeLabel(code) {
  return ({
    queued: ui('排队中，前面的任务完成后开始'),
    planning: ui('正在提取知识点与原文'),
    blueprinting: ui('正在确定答案与情景'),
    authoring: ui('正在出题'),
    reviewing: ui('正在审阅题目'),
    repairing: ui('正在修复没通过的题'),
    publishing: ui('正在检查并发布'),
    cancelling: ui('正在停止…'),
    cancelled: ui('已停止'),
    done: ui('草稿已生成，检查后即可发布'),
    partial: ui('草稿已保存，但少了一些题'),
    failed: ui('没有完成'),
  })[code] || '';
}

const STAGE_ROW_LABEL = { plan: '提取知识点与原文', blueprint: '确定答案与情景', author: '出题与自查', review: '独立审阅', repair: '修复题目' };
/** The generation details' per-stage table: what each stage used (tokens, calls, seconds) next to what the estimate said, in stage order. */
export function stageUsageRows(job = {}) {
  const used = stageUsage(job), estimated = job.estimate?.stageTotals || {};
  return USAGE_STAGES.filter((code) => used[code]).map((code) => ({ code, label: ui(STAGE_ROW_LABEL[code]), ...used[code],
    estimate: estimated[code] ? { low: estimated[code].low, high: estimated[code].high } : null }));
}

/** One finished or running model step, as a noun for the execution list. */
function stepCodeLabel(code) {
  return ({
    planning: ui('提取知识点与原文'),
    blueprinting: ui('确定答案与情景'),
    authoring: ui('出题与自查'),
    reviewing: ui('独立审阅'),
    repairing: ui('修复题目'),
    publishing: ui('发布检查'),
  })[code] || '';
}

/** Generation prose from an older backend without codes, in Chinese (kept for unknown steps). */
export function legacyStageText(stage = '') {
  if (uiIsEnglish()) return stage;
  return String(stage).replace(/^Part (\d+)\/(\d+) · /, '第 $1/$2 批 · ')
    .replace(/Generation reached its (\d+)-minute total budget; approved questions were retained/, '已达到 $1 分钟执行时限；已验收题目已保留')
    .replace(/Generation reached its (\d+)-minute budget for this round; approved questions were retained/, '这一轮已达到 $1 分钟时限；已验收题目已保留')
    .replace(/Draft ready with (\d+)\/(\d+) questions; (\d+) part\(s\) failed/, '草稿已保留 $1/$2 题；$3 批未完成')
    .replace(/Group (\d+)\/(\d+)/g, '第 $1/$2 组')
    .replace(/Parallel generation · up to (\d+) batches/, '并行生成 · 最多 $1 批同时进行')
    .replace('Planning evidence and learning targets', '生成前：规划考点与证据边界')
    .replace('Preparing supported answers and scenarios', '确定答案与情景')
    .replace('Self-checking and improving every question', '生成后：逐题自查与改写')
    .replace('Writing and self-checking questions', '出题与自查')
    .replace('Writing source-grounded questions', '出题')
    .replace('Checking citations, coverage and distractors', '核验引用与题目结构')
    .replace('Reviewing ambiguity and source support', '独立审阅')
    .replace('Repairing flagged questions', '修复审阅发现的问题')
    .replace('Reviewing repaired questions', '复审修复后的题目')
    .replace('Reviewing retained questions', '单独验收保留的合格题目')
    .replace('Waiting for the previous generation', '等待前面的任务')
    .replace('Draft ready for review', '草稿已就绪');
}

/** A step of the execution list: its batch and what it did. */
export function stepLabel(step, job = {}) {
  if (ownProse(job)) return step?.stage || '';
  const code = stepStageCode(step), base = stepCodeLabel(code);
  if (!base) return legacyStageText(step?.stage);
  const group = /Group (\d+)\/(\d+)/.exec(step.stage || '');
  if (group && Number(group[2]) > 1) return uiFormat('第 {0}/{1} 组 · {2}', [group[1], group[2], base]);
  return step.part && job.parts > 1 ? uiFormat('第 {0}/{1} 批 · {2}', [step.part, job.parts, base]) : base;
}

export function jobDeckName(job = {}, drafts = []) {
  return job.deckTitle || (job.type === JOB_TYPES.SUPPLEMENT && job.targetTitle) || draftOf(job, drafts)?.title || job.targetTitle || ui('新题组');
}

const incomplete = (job) => jobCode(job) === 'partial' && !ownProse(job);
/* A finished partial card describes the draft it left behind, and the draft has moved on since: a top-up may have added
   questions. The count and what is missing are read from the draft as it is now, falling back to what the job saw. */
function standing(job, draft) {
  const requested = job.requestedTotal || draft?.editorial?.requested || 0, saved = draft ? draft.cards?.length ?? 0 : job.savedCount ?? 0;
  return { requested, saved, missing: Math.max(0, requested - saved) };
}

/** Saved questions, with the denominator belonging to the same scope. A continued
 * job's count is only this top-up; requestedTotal is the whole draft's target. */
export function jobSavedProgress(job = {}, drafts = []) {
  if (ownProse(job) || !(job.requestedTotal > 0)) return null;
  const supplement = job.type === JOB_TYPES.SUPPLEMENT, draft = draftOf(job, drafts);
  const saved = supplement ? job.savedCount ?? 0 : Math.max(job.savedCount ?? 0, draft?.cards?.length ?? 0);
  return { saved, total: job.requestedTotal,
    label: supplement ? job.publication || job.origin === 'selection' ? ui('本次已补入') : ui('本次已保存') : ui('草稿已保存'),
    note: supplement && job.publication?.total >= 0 ? uiFormat('题组现有 {0} 题', [job.publication.total])
      : job.continued && job.count > 0 ? uiFormat('本次计划补 {0} 题', [job.count]) : '' };
}

/** Collapse only identical batch causes; callers keep the untouched log available. */
export function repeatedJobFailure(text = '') {
  const raw = String(text), parts = raw.split(/(?:;\s*|\n)(?=Part \d+:)/).map(line => /^Part \d+:\s*([\s\S]+)$/.exec(line.trim()));
  if (parts.length < 2 || parts.some(part => !part || part[1] !== parts[0][1])) return null;
  return { count: parts.length, cause: parts[0][1], raw };
}

/** The card's first line: what happened to which deck. */
export function jobHeadline(job = {}, drafts = []) {
  const name = jobDeckName(job, drafts), named = (label) => uiFormat('{0} ·「{1}」', [label, name]);
  if (job.type === JOB_TYPES.SUPPLEMENT) {
    const label = supplementJobLabel(job);
    return named(uiFormat(label.text, label.args || []));
  }
  if (job.type === JOB_TYPES.DRAFT_PUBLISH)
    return named(job.status === 'queued' ? ui('发布检查排队中') : job.status === 'running' ? ui('正在检查并发布题组')
      : job.status === 'failed' ? ui('发布未完成') : job.rejected ? job.accepted ? ui('已发布部分题目') : ui('题目未通过发布检查') : ui('题组已发布'));
  if (job.type === JOB_TYPES.DRAFT_REPAIR)
    return named(job.status === 'running' ? ui('后台修题中') : job.status === 'queued' ? ui('修题排队中')
      : job.status === 'failed' ? job.savedCount ? uiFormat('修题中断 · {0}/{1} 题已修好', [job.savedCount, job.count]) : ui('未修好题目')
        : job.status === 'partial' ? uiFormat('部分修好 · {0}/{1} 题', [job.savedCount, job.count])
          : job.status === JOB_STATUS.CANCELLING ? ui('正在停止修题')
            : job.status === 'cancelled' ? ui('修题已取消') : uiFormat('全部修好 · {0}/{1} 题', [job.savedCount, job.count]));
  // Case papers (WP12) read as cases; queueing and stopping read as any generation.
  if (job.kind === 'case' && !['queued', JOB_STATUS.CANCELLING, 'cancelled'].includes(jobCode(job))) {
    const code = jobCode(job);
    if (code === 'done') return job.publication ? uiFormat('案例「{0}」已导入，{1} 题已批改', [name, job.graded || 0]) : uiFormat('案例「{0}」草稿已生成', [name]);
    if (code === 'failed') return uiFormat('案例「{0}」没有生成完成', [name]);
    return uiFormat('正在出案例「{0}」', [name]);
  }
  // A run the host stopped under: nothing is wrong with the work, it waits to be continued (it is not "being filled"). A run the learner paused between rounds waits too.
  if (job.status === 'interrupted' && !ownProse(job)) return uiFormat('「{0}」已中断', [name]);
  if (isActiveJob(job) && !ownProse(job) && (job.paused === true || job.coverageRun?.state === 'paused')) return uiFormat('「{0}」已暂停', [name]);
  switch (jobCode(job)) {
    case 'queued': return uiFormat('「{0}」排队中', [name]);
    case JOB_STATUS.CANCELLING: return uiFormat('正在停止「{0}」', [name]);
    case 'cancelled': return uiFormat('已停止生成「{0}」', [name]);
    case 'failed': return uiFormat('「{0}」没有生成完成', [name]);
    case 'partial': {
      // What the draft holds is said once, in the line under the title (ui/coverage/copy.js shortfallLine): the title only says it is not complete.
      const { missing } = standing(job, draftOf(job, drafts));
      return missing > 0 || !job.requestedTotal ? uiFormat('「{0}」草稿待补齐', [name]) : uiFormat('「{0}」草稿已生成', [name]);
    }
    case 'done': return uiFormat('「{0}」草稿已生成', [name]);
    default: return job.continued ? uiFormat('正在补齐「{0}」', [name]) : uiFormat('正在生成「{0}」', [name]);
  }
}

/** The card's second line: the stage in plain words, its batch and what is saved. */
export function jobStageLabel(job = {}, drafts = [], jobs = [], { includeSaved = true } = {}) {
  const code = jobCode(job), draft = draftOf(job, drafts);
  if (job.kind === 'case' && job.publication && code === 'done') return ui('批改结果已进信箱；这套案例在学习库里，可以随时再练。');
  // A passage supplement saves into the deck itself: there is no draft to check.
  if (job.origin === 'selection' && !isActiveJob(job)) {
    if (code === 'cancelled') return ui('已停止，题组没有变化。');
    if (code === 'done') return ui('已通过独立审阅，并保存到题组。');
    if (code === 'partial') return ui('只有部分题通过了独立审阅；通过的已保存到题组。');
  }
  if (ownProse(job) && code !== 'failed') return job.stage || stageCodeLabel(code);
  if (code === 'cancelled') {
    const kept = draft ? job.savedCount || draft.cards?.length || 0 : 0;
    return kept ? uiFormat('已停止。已生成的 {0} 题保存在草稿里。', [kept]) : ui('已停止，还没有生成题目。');
  }
  if (job.status === 'interrupted' && !ownProse(job)) return ui('已中断；已出的题都保留，点「接着做」继续。');
  if (code === 'failed') return ownProse(job) ? job.stage || stageCodeLabel(code) : describeFailure(job.stage, { hasDraft: !!draft }).title;
  if (code === 'partial' && incomplete(job)) {
    const { requested, saved, missing } = standing(job, draft);
    // A top-up of this very draft is already running: the advice to start one would be wrong, and the numbers are about to change.
    if (missing > 0 && jobs.some((other) => other !== job && other.draftId === job.draftId && isActiveJob(other) && !ownProse(other)))
      return uiFormat('还差 {0} 题，正在补题；进度见新的任务卡。', [missing]);
    return missing > 0 ? uiFormat('已出 {0}/{1} 题', [saved, requested]) : ui('草稿已补齐，检查后即可发布');
  }
  if (!isActiveJob(job) || code === 'queued' || code === JOB_STATUS.CANCELLING) return stageCodeLabel(code);
  // While running, the newest step in flight says more than the job-level stage.
  const step = [...(job.steps || [])].reverse().find((item) => ['starting', 'running', 'finishing'].includes(item.status));
  const stepCode = step && stepStageCode(step);
  let label = stageCodeLabel(code === 'authoring' && stepCode ? stepCode : code);
  if (stepCode && step.part && job.parts > 1) label = uiFormat('第 {0}/{1} 批 · {2}', [step.part, job.parts, label]);
  // Parts that are filling a gap (the automatic extra rounds) say which round and how many questions are still missing.
  const filling = Object.values(job.fills || {});
  if (filling.length) label = uiFormat('{0} · 第 {1} 轮补题 · 还差 {2} 题', [label, Math.max(...filling.map((item) => item.round)), filling.reduce((sum, item) => sum + item.missing, 0)]);
  if (includeSaved && job.savedCount > 0 && job.requestedTotal > 0) label = uiFormat('{0} · 已保存 {1}/{2} 题', [label, job.savedCount, job.requestedTotal]);
  return label;
}

const FAILURES = [
  ['quota', /insufficient[ _-]?(balance|quota|credit)|exceeded your current quota|\b402\b|余额不足|额度不足|ACCOUNT_QUOTA/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b|限流/i],
  ['model-retired', /model[_ ]not[_ ]found|model[^.;:\n]{0,60}(does not exist|not supported|unsupported|deprecated|decommission|retired|no longer (available|supported))|unsupported model|模型[^；;。]{0,20}(已下线|已停用|不再支持|不存在)/i],
  ['rejected', /\b40[13]\b|unauthori[sz]ed|authenticat|permission[_ ]?error|forbidden|invalid api[ _-]?key|incorrect api[ _-]?key|服务拒绝/i],
  ['credential', /api[ _-]?key|credential|NO_ADAPTER|未注册模型提供方|没有可用模型|密钥|Configure a model provider/i],
  ['budget', /total budget|time budget|minute budget|执行时限/i],
  ['timeout', /timed? ?out|timeout|超时|did not respond|没有回应/i],
  ['network', /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|connection (error|reset|refused|closed|terminated)|network|连不上|网络/i],
  ['unavailable', /overloaded|\b5\d\d\b|unavailable|暂时不可用/i],
  ['sources', /资料[^；;。]*(删除|缺失)|Select at least one source/i],
  ['grounding', /is not in source|quote must match|unknown source|not one of the provided sources|引用的原文/i],
  ['plan', /Assessment plan is not usable/i],
  ['blueprint', /Answer blueprint/i],
  ['evidence', /insufficient evidence|fewer supported knowledge points|no supported knowledge points/i],
  ['quality', /Quality gate failed|Editorial review still found issues|No questions were generated|Author returned no questions|没有题目通过/i],
];

/** The kind a failure text is, by the table above ('unknown' when nothing matches). The one lookup describeFailure, describeModelError and hitTimeLimit all read. */
const kindOfText = (text) => FAILURES.find(([, pattern]) => pattern.test(String(text ?? '')))?.[0] || 'unknown';
/** Did the run's OWN time limit end it? The row's 「生成用时太长，已自动停止」 and the 任务 page's time-limit strip both ask this and nothing else (the 'budget' row of the table). */
export const hitTimeLimit = (text) => kindOfText(text) === 'budget';
/** Is a failed call's own error the model not answering in time (the 'timeout' row of the table)? With how long it ran, that is a call that hit the limit of ONE call. */
export const hitCallTimeout = (text) => kindOfText(text) === 'timeout';

/**
 * One table for every model failure, whether a generation job or the learning flow reports it: kind -> title, hint and what the learner
 * can do about it ('settings' opens the model settings, 'retry' asks again). The strings are the translation keys. Generation adds its
 * own kinds (a spent time budget, bad citations, a failed quality gate...) in describeFailure.
 */
export const FAILURE_COPY = Object.freeze({
  credential: { action: 'settings', title: '还没有可用的模型密钥', hint: '在模型设置里填好 API Key 后再试。' },
  rejected: { action: 'settings', title: '模型服务拒绝了请求', cause: '模型服务拒绝了请求（密钥无效或没有权限）', hint: '密钥失效，或这个模型已停用 / 不再支持。请在模型设置里检查密钥，或换一个模型。' },
  'model-retired': { action: 'settings', title: '这个模型已经不能用了', hint: '模型服务不再提供所选的模型。请在模型设置里换一个模型再试。' },
  quota: { action: 'settings', title: '模型账户的余额或额度不足', hint: '充值，或在设置里换一个模型后再试。' },
  'rate-limit': { action: 'retry', title: '模型服务太忙了', hint: '请求太频繁，被模型服务限流了。等一两分钟再试，或在设置里换一个模型。' },
  timeout: { action: 'retry', title: '模型长时间没有回应', hint: '可能是网络或服务繁忙，稍后再试。' },
  network: { action: 'retry', title: '连不上模型服务', hint: '检查网络后重试。' },
  unavailable: { action: 'retry', title: '模型服务暂时不可用', hint: '稍后再试。' },
});
const copyOf = (kind) => { const entry = FAILURE_COPY[kind]; return { kind, action: entry.action, title: ui(entry.title), ...(entry.cause ? { cause: ui(entry.cause) } : {}), hint: ui(entry.hint) }; };

const PART_SPLIT = /(?:^|;\s*)Part (\d+):\s*/;
const QUESTION_SPLIT = /;\s+(?=(?:q\d+|Card \d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23})\s*[:：])/;
const QUESTION_TOKEN = /^(?:(q\d+)|Card (\d+)|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23}))\s*[:：]/;

/** The reason codes one failure line stands for (a review line can name several dimensions; prose names none and reads as the review's own words). */
function lineCodes(line) {
  const codes = new Set(), first = issueCode(line);
  if (first && first !== 'structure') codes.add(first);
  for (const [name, code] of Object.entries(DIMENSIONS)) if (new RegExp(`\\b${name}\\b`).test(line)) codes.add(code);
  if (first === 'structure' && !codes.size) codes.add('structure');
  return [...codes];
}

/**
 * What a failed run's message says, one row per question: `{ part, question, codes, severity, raw }`. The message joins English lines of the
 * independent review and the structural checks ("q2: answerLeak failed…", "Card 4: hint reveals the answer", prose with a card id), grouped by
 * part and question. Every line in a failure is a blocker (suggestions never reject a card). A failure that is not about questions has no rows.
 */
export function failureBreakdown(text = '') {
  const raw = String(text || ''), pieces = raw.split(PART_SPLIT), rows = new Map();
  const bodies = pieces.length === 1 ? [[undefined, raw]] : Array.from({ length: (pieces.length - 1) / 2 }, (_, index) => [Number(pieces[index * 2 + 1]), pieces[index * 2 + 2]]);
  for (const [part, body] of bodies) {
    let lines = String(body).replace(/^(?:Quality gate failed|Editorial review still found issues):\s*/, '');
    if (lines.startsWith('[')) { try { lines = JSON.parse(lines).join('; '); } catch { /* read it as text */ } }
    for (const line of lines.split(QUESTION_SPLIT)) {
      const found = QUESTION_TOKEN.exec(line.trim());
      if (!found) continue;
      const question = found[1] || (found[2] ? `q${found[2]}` : found[3]), key = `${part ?? ''}:${question}`;
      const row = rows.get(key) || { part, question, codes: [], severity: 'blocker', raw: [] };
      row.raw.push(line.trim());
      for (const code of lineCodes(line)) if (!row.codes.includes(code)) row.codes.push(code);
      rows.set(key, row);
    }
  }
  return [...rows.values()].map((row) => ({ ...row, codes: row.codes.length ? row.codes : ['review'] }));
}

/** One row of the technical detail as a line: "q2 · reasons (must fix)". */
export function failureRowLabel(row) {
  return uiFormat('{0} · {1}（必须修）', [row.question, formatClauses(row.codes.map(reasonLabel))]);
}

/* Causes only the generation pipeline has, named by lib/generation-failure.js: the learner's wording of each (title, the cause in one clause, what to do). */
const OWN_FAILURES = Object.freeze({
  'plan-short': { action: 'retry', title: '模型给出的考点比计划的少', cause: '模型给出的考点不够数',
    hint: '模型这一次给出的考点不够数，补问一次后仍然不足；这不等于这一节没有可考的内容，再试一次可能就够了。可以点「为没覆盖的部分补题」再试，或换成「精简」强度。' },
  'review-protocol': { action: 'retry', title: '审阅回复的格式不对，没能完成审阅', cause: '审阅回复的格式不对',
    hint: '点「为没覆盖的部分补题」补上这一批；经常出现的话，可以在设置里换一个输出更稳定的模型。' },
  'no-reply': { action: 'retry', title: '模型没有返回内容', cause: '模型没有返回内容', hint: '可能是服务暂时的问题，稍后再试。' },
  cancelled: { action: 'retry', title: '已被停止', cause: '已被停止', hint: '已通过检查的题保存在草稿里。' },
});
/** The code a legacy kind of this table has in the pipeline's vocabulary (the part report, the planned targets of a draft). */
const CODE_OF_KIND = { grounding: 'quote', rejected: 'credential' };
const PART_BODY = /(?:^|;\s*)Part \d+:\s*/;
/** The one cause a whole failure text names; a text that mixes causes of several parts names none (the generic table reads it). */
function ownCause(raw) {
  const codes = new Set(raw.split(PART_BODY).filter((piece) => piece.trim()).map((piece) => classifyFailure(piece).code));
  return codes.size === 1 && Object.hasOwn(OWN_FAILURES, [...codes][0]) ? [...codes][0] : null;
}
const retriedNote = (code, retries) => (!(retries > 0) ? '' : code === 'review-protocol' ? uiFormat('已自动重新审阅 {0} 次仍然格式不对', [retries]) : uiFormat('已自动重试 {0} 次', [retries]));
const clipRaw = (value, size = 160) => (value.length > size ? `${value.slice(0, size - 1)}…` : value);

/**
 * A generation failure in plain words, THE one description every place uses (the banner's per-part lines, 查看记录, the job card, a call in the 任务 console):
 * `{ kind, code, title, cause, retried, hint, action }`. `code` is the pipeline's cause (lib/generation-failure.js); `title` is the headline, `cause` the same
 * in one clause (for an unknown cause: the plain headline with the first 160 characters of the raw text, never the raw English alone), `retried` what was
 * already tried again automatically ('' when nothing was), `hint` what to do. action is 'settings' (open the model settings), 'retry' (set the same
 * materials up again) or 'open-draft' (questions were kept).
 */
export function describeFailure(text = '', options = {}) {
  const raw = String(text || ''), found = classifyFailure(raw), own = ownCause(raw);
  if (own) {
    const copy = OWN_FAILURES[own];
    return { kind: own, code: own, action: copy.action, title: ui(copy.title), cause: ui(copy.cause), retried: retriedNote(own, found.retries), hint: ui(copy.hint) };
  }
  const legacy = failureKind(raw, options);
  return { ...legacy, code: CODE_OF_KIND[legacy.kind] || legacy.kind, cause: legacy.kind === 'unknown' && raw.trim() ? uiFormat('{0}（{1}）', [legacy.title, clipRaw(raw.trim())]) : legacy.cause || legacy.title,
    retried: retriedNote(legacy.kind, found.retries) };
}

/** One failure as the sentence the lists print after "第 N 批没有完成：" (the cause, then what was already tried again). */
export const failureSentence = (found) => formatClauses([found.cause, found.retried].filter(Boolean));

/** A failed model call of a job (its `error` text) in plain words in the UI language; a text nothing recognises is shown as it is. */
export function callErrorText(text = '') {
  // The console already writes a model failure in plain Chinese (lib/model-retry.js modelFailureMessage); in a Chinese UI that is the sentence.
  if (!uiIsEnglish() && /[㐀-鿿]/.test(String(text))) return String(text);
  const found = describeFailure(text);
  return found.code === 'unknown' ? String(text) : failureSentence(found);
}

function failureKind(text = '', { hasDraft = false } = {}) {
  const raw = String(text || '');
  const kind = kindOfText(raw);
  if (Object.hasOwn(FAILURE_COPY, kind)) return copyOf(kind);
  switch (kind) {
    // The limit itself is on the 任务 page (ui/tasks/TimeLimit.jsx, with the way to change it): the hint only points there, in the same sentence as what to do next.
    case 'budget': return { kind: 'timeout', action: hasDraft ? 'open-draft' : 'retry', title: ui('生成用时太长，已自动停止'),
      hint: hasDraft ? ui('已通过检查的题保存在草稿里，可以打开草稿继续；时限和调整入口在「任务」页的详情里。') : ui('可以减少题数或资料后重新生成；时限和调整入口在「任务」页的详情里。') };
    case 'sources': return { kind, action: 'retry', title: ui('出题用的资料已被删除'), hint: ui('重新选择资料后再生成。') };
    case 'grounding': return { kind, action: hasDraft ? 'open-draft' : 'retry', title: ui('引用的原文在资料里找不到'),
      hint: hasDraft ? ui('AI 引用的句子和资料原文对不上；通过检查的题已保存在草稿里。打开草稿用「为没覆盖的部分补题」补上缺的题，不必重新选页。')
        : ui('AI 引用的句子和资料原文对不上。请确认所选页包含要引用的原文；如果原文在相邻页，重新选页后再生成。') };
    case 'plan': return { kind, action: 'retry', title: ui('考点规划没有通过检查'),
      hint: ui('资料里能稳妥出题的内容可能不够。换几份内容更完整的资料，或减少题数再试。') };
    case 'blueprint': return { kind, action: hasDraft ? 'open-draft' : 'retry', title: ui('答案与情景设计没有通过检查'),
      hint: hasDraft ? ui('已通过的题保存在草稿里。其余考点还没有形成可靠的答案与情景，可以打开草稿后调整范围继续。')
        : ui('考点已找到，但答案、情景或选项依据还不完整。可选择更聚焦的资料，或减少题数后重试。') };
    // Too little in the sources is a signal of its own (the planning stage found no supported target); only then are other sources the advice.
    case 'evidence': return { kind, action: 'retry', title: ui('资料里能稳妥出题的内容不够'),
      hint: ui('资料可能太短，或缺少可以考的内容。换几份内容更完整的资料，或减少题数再试。') };
    case 'quality': {
      // The review rejected the questions: say what it found and what to do, never blame the sources.
      const counts = new Map();
      for (const row of failureBreakdown(raw)) for (const code of row.codes) if (code !== 'review') counts.set(code, (counts.get(code) || 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code]) => reasonLabel(code));
      const next = hasDraft ? ui('打开草稿点「为没覆盖的部分补题」再补一轮；也可以在「设置 › 出题偏好」里调整题型、难度和侧重点。')
        : ui('点「按原资料重新设置」再试一次；也可以在「设置 › 出题偏好」里调整题型、难度和侧重点。');
      return { kind, action: hasDraft ? 'open-draft' : 'retry', title: top.length ? ui('出的题都没通过质量审阅') : ui('没有题目通过检查'),
        hint: top.length ? uiFormat('主要原因：{0}。{1}', [formatClauses(top), next]) : uiFormat('具体原因见技术详情。{0}', [next]) };
    }
    default: return { kind, action: 'retry', title: ui('生成没有完成'), hint: ui('可以按原资料重新设置后再试。') };
  }
}

/**
 * A model failure anywhere in the learning flow, in plain words: { kind, title,
 * hint, action, detail }. Same table as describeFailure. `detail` is the raw
 * provider text for a technical-details toggle; an error that is not recognised
 * passes through as the title with no detail.
 */
export function describeModelError(text = '') {
  const raw = String(text || '').trim();
  const found = kindOfText(raw);
  const kind = found === 'budget' ? 'timeout' : found;
  if (!Object.hasOwn(FAILURE_COPY, kind)) return { kind: 'unknown', title: raw, hint: '', detail: '' };
  return { ...copyOf(kind), detail: raw };
}

/** A background-assistant task's failure text without the prefix the backend puts on it (the page adds its own sentence). */
export const plainAssistFailure = (text = '') => String(text || '').replace(/^\s*后台助教未完成[：:]\s*/, '');

/** The toast after a generation starts (P26): which deck, and that it is on its way. */
export function generationStartedNotice(job = {}, gen = {}, materials = 0) {
  const title = String(gen.title || '').trim();
  const text = job.status === 'queued'
    ? title ? uiFormat('「{0}」已加入队列，前面还有 {1} 个任务。', [title, job.queuedBehind ?? 1])
      : uiFormat('已加入队列，前面还有 {0} 个任务。', [job.queuedBehind ?? 1])
    : title ? uiFormat('已开始生成「{0}」…完成后在这里打开草稿。', [title])
      : uiFormat('已开始用 {0} 份资料出题…完成后在这里打开草稿。', [materials]);
  // A plan of several rounds: this run makes the first (the heaviest sections); the rest is said, not left to be found out.
  const rounds = job.plan?.rounds > 1 ? ` ${uiFormat('共分 {0} 轮、约 {1} 题；这次先出第 1 轮（约 {2} 题），其余在草稿页继续。', [job.plan.rounds, job.plan.goal, job.plan.questions])}` : '';
  return { text: text + rounds, tone: 'success' };
}
