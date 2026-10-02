/* What a question-generation job says to the learner (P15, P26–P29): plain
   words in the UI language, keyed by the backend's stable stage codes, with a
   fix for failures. Raw provider/engine prose is only shown behind 技术详情. */
import { ui, uiFormat, getUiLanguage } from './i18n.js';
import { stageCodeOf, stepStageCode } from '../lib/contexts/jobs/contracts.js';
import { supplementJobLabel } from './job-visibility.js';

/** The generate form after a job starts: one source of the defaults (P27). */
export const GENERATION_DEFAULTS = Object.freeze({ kind: 'mixed', count: 10, difficulty: 'mixed', focus: '', role: '' });

/** Clear what belongs to one deck (title, focus, course); keep the learner's standing preferences. */
export const freshGeneration = (gen = {}) => ({ ...gen, kind: GENERATION_DEFAULTS.kind, count: GENERATION_DEFAULTS.count,
  title: '', focus: '', course: undefined });

/** Plan contract C3 first (`data.model`), then the legacy `modelReady` flag. */
export function modelReadiness(data) {
  const model = data?.model;
  if (model && typeof model === 'object' && typeof model.ready === 'boolean')
    return { ready: model.ready, reason: model.reason || (model.ready ? 'ok' : 'unknown'), label: model.label || '' };
  const ready = !!data?.modelReady;
  return { ready, reason: ready ? 'ok' : 'no-route', label: '' };
}

/** Materials as the learner counts them: a PDF is one material, not one per page. */
export const documentCount = (sources = []) =>
  new Set(sources.map((source) => source.document?.id ? `document:${source.document.id}` : `source:${source.id}`)).size;

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
export const jobCode = (job) => (typeof job?.stageCode === 'string' && job.stageCode) || stageCodeOf(job);
const draftOf = (job, drafts = []) => (job?.draftId && drafts.find((draft) => draft.id === job.draftId)) || null;
const ownProse = (job) => job?.type === 'draft-publish' || job?.type === 'draft-repair';

/** Where a job is, as a short status. */
export function stageCodeLabel(code) {
  return ({
    queued: ui('排队中，前面的任务完成后开始'),
    planning: ui('正在规划考点'),
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

/** One finished or running model step, as a noun for the execution list. */
function stepCodeLabel(code) {
  return ({
    planning: ui('规划考点'),
    authoring: ui('出题与自查'),
    reviewing: ui('独立审阅'),
    repairing: ui('修复题目'),
    publishing: ui('发布检查'),
  })[code] || '';
}

/** Generation prose from an older backend without codes, in Chinese (kept for unknown steps). */
export function legacyStageText(stage = '') {
  if (getUiLanguage() === 'en') return stage;
  return String(stage).replace(/^Part (\d+)\/(\d+) · /, '第 $1/$2 批 · ')
    .replace(/Generation reached its (\d+)-minute total budget; approved questions were retained/, '已达到 $1 分钟执行时限；已验收题目已保留')
    .replace(/Draft ready with (\d+)\/(\d+) questions; (\d+) part\(s\) failed/, '草稿已保留 $1/$2 题；$3 批未完成')
    .replace(/Group (\d+)\/(\d+)/g, '第 $1/$2 组')
    .replace('Parallel generation · up to 3 batches', '并行生成 · 最多 3 批同时进行')
    .replace('Planning evidence and learning targets', '生成前：规划考点与证据边界')
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
  return job.deckTitle || (job.type === 'supplement' && job.targetTitle) || draftOf(job, drafts)?.title || job.targetTitle || ui('新题组');
}

const incomplete = (job) => jobCode(job) === 'partial' && !ownProse(job);
/* A finished partial card describes the draft it left behind, and the draft has moved on since: a top-up may have added
   questions. The count and what is missing are read from the draft as it is now, falling back to what the job saw. */
function standing(job, draft) {
  const requested = job.requestedTotal || draft?.editorial?.requested || 0, saved = draft ? draft.cards?.length ?? 0 : job.savedCount ?? 0;
  return { requested, saved, missing: Math.max(0, requested - saved) };
}

/** The card's first line: what happened to which deck. */
export function jobHeadline(job = {}, drafts = []) {
  const name = jobDeckName(job, drafts), named = (label) => uiFormat('{0} ·「{1}」', [label, name]);
  if (job.type === 'supplement') {
    const label = supplementJobLabel(job);
    return named(uiFormat(label.text, label.args || []));
  }
  if (job.type === 'draft-publish')
    return named(job.status === 'queued' ? ui('发布检查排队中') : job.status === 'running' ? ui('正在检查并发布题组')
      : job.status === 'failed' ? ui('发布未完成') : job.rejected ? job.accepted ? ui('已发布部分题目') : ui('题目未通过发布检查') : ui('题组已发布'));
  if (job.type === 'draft-repair')
    return named(job.status === 'running' ? ui('后台修题中') : job.status === 'queued' ? ui('修题排队中')
      : job.status === 'failed' ? job.savedCount ? uiFormat('修题中断 · {0}/{1} 题已修好', [job.savedCount, job.count]) : ui('未修好题目')
        : job.status === 'partial' ? uiFormat('部分修好 · {0}/{1} 题', [job.savedCount, job.count])
          : job.status === 'cancelling' ? ui('正在停止修题')
            : job.status === 'cancelled' ? ui('修题已取消') : uiFormat('全部修好 · {0}/{1} 题', [job.savedCount, job.count]));
  // Case papers (WP12) read as cases; queueing and stopping read as any generation.
  if (job.kind === 'case' && !['queued', 'cancelling', 'cancelled'].includes(jobCode(job))) {
    const code = jobCode(job);
    if (code === 'done') return job.publication ? uiFormat('案例「{0}」已导入，{1} 题已批改', [name, job.graded || 0]) : uiFormat('案例「{0}」草稿已生成', [name]);
    if (code === 'failed') return uiFormat('案例「{0}」没有生成完成', [name]);
    return uiFormat('正在出案例「{0}」', [name]);
  }
  switch (jobCode(job)) {
    case 'queued': return uiFormat('「{0}」排队中', [name]);
    case 'cancelling': return uiFormat('正在停止「{0}」', [name]);
    case 'cancelled': return uiFormat('已停止生成「{0}」', [name]);
    case 'failed': return uiFormat('「{0}」没有生成完成', [name]);
    case 'partial': {
      const { requested, saved, missing } = standing(job, draftOf(job, drafts));
      return missing > 0 || !job.requestedTotal ? uiFormat('「{0}」草稿待补齐 · {1}/{2} 题', [name, saved, requested]) : uiFormat('「{0}」草稿已生成', [name]);
    }
    case 'done': return uiFormat('「{0}」草稿已生成', [name]);
    default: return job.continued ? uiFormat('正在补齐「{0}」', [name]) : uiFormat('正在生成「{0}」', [name]);
  }
}

/** The card's second line: the stage in plain words, its batch and what is saved. */
export function jobStageLabel(job = {}, drafts = [], jobs = []) {
  const code = jobCode(job), draft = draftOf(job, drafts);
  if (job.kind === 'case' && job.publication && code === 'done') return ui('批改结果已进信箱；这套案例在学习库里，可以随时再练。');
  // A passage supplement saves into the deck itself: there is no draft to check.
  if (job.origin === 'selection' && !ACTIVE.has(job.status)) {
    if (code === 'cancelled') return ui('已停止，题组没有变化。');
    if (code === 'done') return ui('已通过独立审阅，并保存到题组。');
    if (code === 'partial') return ui('只有部分题通过了独立审阅；通过的已保存到题组。');
  }
  if (ownProse(job) && code !== 'failed') return job.stage || stageCodeLabel(code);
  if (code === 'cancelled') {
    const kept = draft ? job.savedCount || draft.cards?.length || 0 : 0;
    return kept ? uiFormat('已停止。已生成的 {0} 题保存在草稿里。', [kept]) : ui('已停止，还没有生成题目。');
  }
  if (code === 'failed') return ownProse(job) ? job.stage || stageCodeLabel(code) : describeFailure(job.stage, { hasDraft: !!draft }).title;
  if (code === 'partial' && incomplete(job)) {
    const { missing } = standing(job, draft);
    // A top-up of this very draft is already running: the advice to start one would be wrong, and the numbers are about to change.
    if (missing > 0 && jobs.some((other) => other !== job && other.draftId === job.draftId && ACTIVE.has(other.status) && !ownProse(other)))
      return uiFormat('还差 {0} 题，正在补题；进度见新的任务卡。', [missing]);
    return missing > 0 ? uiFormat('少了 {0} 题；可以打开草稿补齐。', [missing]) : ui('草稿已补齐，检查后即可发布');
  }
  if (!ACTIVE.has(job.status) || code === 'queued' || code === 'cancelling') return stageCodeLabel(code);
  // While running, the newest step in flight says more than the job-level stage.
  const step = [...(job.steps || [])].reverse().find((item) => ['starting', 'running', 'finishing'].includes(item.status));
  const stepCode = step && stepStageCode(step);
  let label = stageCodeLabel(code === 'authoring' && stepCode ? stepCode : code);
  if (stepCode && step.part && job.parts > 1) label = uiFormat('第 {0}/{1} 批 · {2}', [step.part, job.parts, label]);
  if (job.savedCount > 0 && job.requestedTotal > 0) label = uiFormat('{0} · 已保存 {1}/{2} 题', [label, job.savedCount, job.requestedTotal]);
  return label;
}

const FAILURES = [
  ['quota', /insufficient[ _-]?(balance|quota|credit)|exceeded your current quota|\b402\b|余额不足|额度不足|ACCOUNT_QUOTA/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b|限流/i],
  ['credential', /api[ _-]?key|credential|NO_ADAPTER|unauthori[sz]ed|\b40[13]\b|authenticat|未注册模型提供方|没有可用模型|密钥|Configure a model provider/i],
  ['budget', /total budget|time budget|执行时限/i],
  ['timeout', /timed? ?out|timeout|超时|did not respond|没有回应/i],
  ['network', /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|connection (error|reset|refused|closed|terminated)|network|连不上|网络/i],
  ['unavailable', /overloaded|\b5\d\d\b|unavailable|暂时不可用/i],
  ['sources', /资料[^；;。]*(删除|缺失)|Select at least one source/i],
  ['plan', /Assessment plan is not usable/i],
  ['quality', /Quality gate failed|Editorial review still found issues|No questions were generated|Author returned no questions|insufficient evidence|没有题目通过/i],
];

/**
 * A generation failure in plain words: { kind, title, hint, action } where
 * action is 'settings' (open the model settings), 'retry' (set the same
 * materials up again) or 'open-draft' (questions were kept).
 */
export function describeFailure(text = '', { hasDraft = false } = {}) {
  const raw = String(text || '');
  const kind = FAILURES.find(([, pattern]) => pattern.test(raw))?.[0] || 'unknown';
  switch (kind) {
    case 'credential': return { kind, action: 'settings', title: ui('还没有可用的模型密钥'),
      hint: ui('出题要调用 AI 模型。在模型设置里填好 API Key，再重新生成。') };
    case 'quota': return { kind, action: 'settings', title: ui('模型账户的余额或额度不足'),
      hint: ui('充值或换一个模型后，再重新生成。') };
    case 'rate-limit': return { kind, action: 'retry', title: ui('模型服务太忙了'),
      hint: ui('请求太频繁，被模型服务限流了。等一两分钟再重新生成。') };
    case 'budget': return { kind: 'timeout', action: hasDraft ? 'open-draft' : 'retry', title: ui('生成用时太长，已自动停止'),
      hint: hasDraft ? ui('已通过检查的题保存在草稿里，可以打开草稿继续。') : ui('可以减少题数或资料后重新生成。') };
    case 'timeout': return { kind, action: 'retry', title: ui('模型长时间没有回应'),
      hint: ui('可能是网络或服务繁忙，稍后重新生成。') };
    case 'network': return { kind, action: 'retry', title: ui('连不上模型服务'), hint: ui('检查网络连接后重新生成。') };
    case 'unavailable': return { kind, action: 'retry', title: ui('模型服务暂时不可用'), hint: ui('稍后再重新生成。') };
    case 'sources': return { kind, action: 'retry', title: ui('出题用的资料已被删除'), hint: ui('重新选择资料后再生成。') };
    case 'plan': return { kind, action: 'retry', title: ui('考点规划没有通过检查'),
      hint: ui('资料里能稳妥出题的内容可能不够。换几份内容更完整的资料，或减少题数再试。') };
    case 'quality': return { kind, action: 'retry', title: ui('没有题目通过检查'),
      hint: ui('资料可能太短，或缺少可以考的内容。换几份内容更完整的资料，或减少题数再试。') };
    default: return { kind, action: 'retry', title: ui('生成没有完成'), hint: ui('可以按原资料重新设置后再试。') };
  }
}

/**
 * A model failure anywhere in the learning flow, in plain words: { kind, title,
 * hint, detail }. `detail` is the raw provider text for a 详情 toggle; an error
 * that is not recognised passes through as the title with no detail.
 */
export function describeModelError(text = '') {
  const raw = String(text || '').trim();
  const found = FAILURES.find(([, pattern]) => pattern.test(raw))?.[0];
  const copy = {
    'rate-limit': [ui('模型当前限流'), ui('稍等一两分钟再点重新生成；或在设置里换一个模型。')],
    quota: [ui('模型账户的余额或额度不足'), ui('充值，或在设置里换一个模型后再试。')],
    credential: [ui('还没有可用的模型密钥'), ui('在模型设置里填好 API Key 后再试。')],
    timeout: [ui('模型太久没有回应'), ui('稍后再试一次。')],
    budget: [ui('模型太久没有回应'), ui('稍后再试一次。')],
    network: [ui('连接模型失败'), ui('检查网络后重试。')],
    unavailable: [ui('模型服务暂时不可用'), ui('稍后再试。')],
  }[found];
  if (!copy) return { kind: 'unknown', title: raw, hint: '', detail: '' };
  return { kind: found === 'budget' ? 'timeout' : found, title: copy[0], hint: copy[1], detail: raw };
}

/** The toast after a generation starts (P26): which deck, and that it is on its way. */
export function generationStartedNotice(job = {}, gen = {}, materials = 0) {
  const title = String(gen.title || '').trim();
  const text = job.status === 'queued'
    ? title ? uiFormat('「{0}」已加入队列，前面还有 {1} 个任务。', [title, job.queuedBehind ?? 1])
      : uiFormat('已加入队列，前面还有 {0} 个任务。', [job.queuedBehind ?? 1])
    : title ? uiFormat('已开始生成「{0}」…完成后在这里打开草稿。', [title])
      : uiFormat('已开始用 {0} 份资料出题…完成后在这里打开草稿。', [materials]);
  return { text, tone: 'success' };
}
