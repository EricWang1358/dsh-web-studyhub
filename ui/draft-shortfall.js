/* A draft that came out short, in plain words (the 补题 flow).

   A 20-question run can finish with every step 已完成 and 10 questions in the
   draft. The review and the local checks drop questions silently; what the
   learner needs is which ones, why, and what is working on the draft now. This
   module reads that from the draft itself (`editorial.omitted`, or for drafts
   from before it existed the omitted issues of each batch's audit and the
   failure lines) and from the job list, and says it in the UI language.
   Pure; the components are ui/DraftShortfall.jsx. */
import { ui, uiFormat } from './i18n.js';
import { describeFailure } from './generation-status.js';
import { isActiveJob } from './job-visibility.js';
import { JOB_STATUS, JOB_TYPES } from '../lib/job-status.js';
import { missingQuestions } from '../lib/draft-continuation.js';

export { missingQuestions, canContinueDraft } from '../lib/draft-continuation.js';

/**
 * What is working on this draft right now: `{ kind, job }` with kind
 * 'topup' (a continuation of this draft), 'generating' (the run that is still
 * writing it), 'publish' or 'repair'; null when nothing is.
 */
export function draftWork(draft, jobs = []) {
  const job = (jobs || []).find((item) => item.draftId === draft?.id && isActiveJob(item));
  if (!job) return null;
  const kind = job.type === JOB_TYPES.DRAFT_PUBLISH ? 'publish' : job.type === JOB_TYPES.DRAFT_REPAIR ? 'repair' : job.continued ? 'topup' : 'generating';
  return { kind, job };
}

/** The label of the draft's action button while something works on it, so it says what is really happening. */
export function draftWorkLabel(work, draft) {
  const { kind, job } = work;
  const saved = job.savedCount ?? draft?.cards?.length, total = job.requestedTotal ?? draft?.editorial?.requested;
  const progress = Number.isInteger(saved) && Number.isInteger(total) && total > 0;
  if (kind === 'publish') return job.status === 'queued' ? ui('发布检查排队中') : ui('发布检查中…');
  if (kind === 'repair') return job.status === 'queued' ? ui('修题排队中') : ui('后台修题中…');
  if (job.status === JOB_STATUS.CANCELLING) return ui('正在停止…');
  if (job.status === 'queued') return kind === 'topup' ? ui('补题排队中') : ui('排队中…');
  if (kind === 'topup') return progress ? uiFormat('补题中 · 草稿 {0}/{1} 题', [saved, total]) : ui('补题中…');
  return progress ? uiFormat('生成中 · 草稿 {0}/{1} 题', [saved, total]) : ui('生成中…');
}

/* ---------- why questions did not reach the draft ---------- */

const DIMENSIONS = { selfContained: 'self-contained', answerLeak: 'answer-leak', optionQuality: 'options',
  learningValue: 'value', sourceSupport: 'source', explanationQuality: 'explanation' };

/** The reason an issue line stands for, or null when it is only the reviewer's prose. */
export function issueCode(issue) {
  const text = String(issue ?? '');
  if (text === 'over-count') return 'over-count';
  const dimension = /\b(selfContained|answerLeak|optionQuality|learningValue|sourceSupport|explanationQuality)\b(?: failed| in )/.exec(text);
  if (dimension) return DIMENSIONS[dimension[1]];
  if (/explanation only repeats the answer/.test(text)) return 'explanation';
  if (/depends on unavailable/.test(text)) return 'self-contained';
  if (/must use requested kind/.test(text)) return 'kind';
  if (/duplicate (?:learning objective|prompt|id)|repeats an already covered/.test(text)) return 'duplicate';
  if (/citation|quote|unknown source/i.test(text)) return 'source';
  /* The structural gate's `Card N:` lines, one precise code each; 'structure' is only what none of them says. */
  if (/formula outside math delimiters/.test(text)) return 'formula';
  if (/the stem asks what the source says/.test(text)) return 'source-voice';
  if (/hint reveals the answer/.test(text)) return 'answer-leak';
  if (/missing, unknown or duplicate targetId/.test(text)) return 'binding';
  if (/need 3.6 options|options have an invalid shape|invalid correct option count|duplicate option|each option requires/.test(text)) return 'options-shape';
  if (/\b(?:id|kind|topic|objective|prompt|answer|hint|explanation|misconception) (?:is required|must be text)/.test(text)) return 'missing-field';
  if (/^Card \d+:/.test(text)) return 'structure';
  return null;
}

export const reasonLabel = (code) => ({
  'answer-leak': ui('提示或题干泄露了答案'),
  options: ui('选项质量不合格（干扰项太弱或比较维度不一致）'),
  value: ui('学习价值不够（太琐碎或一题考了几件事）'),
  source: ui('资料不足以支撑答案，或引用对不上原文'),
  explanation: ui('解析没有讲清推理'),
  'self-contained': ui('离开资料读不懂题干'),
  kind: ui('题型和要求的不一致'),
  duplicate: ui('与已有的题重复'),
  formula: ui('公式没有放进公式格式（会显示成原始文本）'),
  'source-voice': ui('题干在问「资料怎么说」，没有考概念本身'),
  'missing-field': ui('缺少必要字段（如提示、易错点）'),
  'options-shape': ui('选项结构不完整'),
  binding: ui('题目没有对上已核实的考点'),
  structure: ui('题目格式不完整'),
  'over-count': ui('这一批已满额，多出的候选没有采用'),
  review: ui('独立审阅没有通过'),
})[code] || code;

const cardToken = (line) => {
  const match = /^(?:q(\d+)|Card\s+(\d+))\b/i.exec(String(line).trim());
  return match ? `q${match[1] || match[2]}` : null;
};

const words = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

function record(part, lines, extra = {}) {
  const codes = [...new Set(lines.map(issueCode).filter(Boolean))];
  const note = lines.find((line) => issueCode(line) === null);
  return { part, prompt: words(extra.prompt), objective: words(extra.objective), topic: words(extra.topic), codes: codes.length ? codes : ['review'],
    note: note ? String(note).slice(0, 220) : '' };
}

/** What a dropped question is called in the list: its stem, else its objective, else its topic, else its batch; never blank (an author can leave the stem out). */
export function omissionTitle(item) {
  const found = words(item?.prompt) || words(item?.objective) || words(item?.topic);
  if (found) return found;
  return Number.isInteger(item?.part) ? uiFormat('第 {0} 批的一道题', [item.part]) : ui('一道没进入草稿的题');
}

/** Dropped questions as one record each: from `editorial.omitted`, else (older drafts) rebuilt from each batch's omitted issues. */
function records(editorial) {
  if (Array.isArray(editorial.omitted) && editorial.omitted.length)
    return editorial.omitted.map((item) => record(item.part, Array.isArray(item.reasons) ? item.reasons : [], item));
  const out = [];
  for (const audit of Array.isArray(editorial.audits) ? editorial.audits : []) {
    const groups = new Map();
    for (const line of Array.isArray(audit?.omittedIssues) ? audit.omittedIssues : []) {
      const key = cardToken(line) || `other:${groups.size}`;
      groups.set(key, [...(groups.get(key) || []), line]);
    }
    for (const lines of groups.values()) out.push(record(audit.part, lines));
  }
  return out;
}

const RETAINED = /^Part (\d+): retained (\d+)\/(\d+) reviewed questions; omitted or missing candidates/;
const DUPLICATE = /^Part (\d+): duplicate learning target omitted/;
const PART = /^Part (\d+): (.+)$/s;

/**
 * Why the draft has fewer questions than were asked for: `{ missing, records, reasons, partFailures, duplicates }`.
 * `reasons` counts dropped questions per reason (a question can have several), most common first;
 * `partFailures` are whole batches that did not finish.
 */
export function shortfall(draft) {
  const editorial = draft?.editorial || {};
  const found = records(editorial), counts = new Map(), partFailures = [];
  let duplicates = 0;
  for (const item of found) for (const code of item.codes) counts.set(code, (counts.get(code) || 0) + 1);
  for (const line of Array.isArray(editorial.failures) ? editorial.failures : []) {
    if (DUPLICATE.test(line) || line === '补题时跳过了一道与已有草稿重复的题') { duplicates++; continue; }
    if (RETAINED.test(line)) continue;
    const part = PART.exec(line);
    if (part) partFailures.push({ part: Number(part[1]), ...describeFailure(part[2]) });
  }
  const reasons = [...counts].map(([code, count]) => ({ code, count, label: reasonLabel(code) })).sort((a, b) => b.count - a.count);
  return { missing: missingQuestions(draft), records: found, reasons, partFailures, duplicates, report: describePartReport(editorial.partReport) };
}

/**
 * What happened to the parts of the run, in the UI language: `{ lead, reasons }` from the draft's `editorial.partReport` (lib/generation-report.js),
 * or null for a draft that has none. `reasons` is one plain sentence per reason, for example "5 个部分的引用在资料里找不到".
 */
export function describePartReport(report) {
  if (!report || !(report.total > 0) || report.passed === report.total) return null;
  const reasons = report.reasons || {}, line = {
    quote: (n) => uiFormat('{0} 个部分的引用在资料里找不到', [n]),
    plan: (n) => uiFormat('{0} 个部分的考点规划没有通过检查', [n]),
    quality: (n) => uiFormat('{0} 个部分的题没有通过质量审阅', [n]),
    other: (n) => uiFormat('{0} 个部分因其他原因没有完成', [n]),
  };
  return { lead: uiFormat('共 {0} 个部分：{1} 个全部通过，{2} 个只保留了部分题，{3} 个没有出题。', [report.total, report.passed, report.partial, report.failed]),
    reasons: Object.entries(reasons).filter(([, count]) => count > 0).map(([code, count]) => (line[code] || line.other)(count)),
    ...(report.citationsRepaired ? { repaired: uiFormat('已自动重试并修正了 {0} 道题的引用。', [report.citationsRepaired]) } : {}) };
}

const clipLine = (value, size = 200) => (value.length > size ? value.slice(0, size - 1) + '…' : value);
/** The text of a record line: a string as is, an object by its message / error / reason / text, anything else nothing. */
const recordText = (line) => {
  if (typeof line === 'string') return line.trim();
  if (line && typeof line === 'object') for (const key of ['message', 'error', 'reason', 'text']) if (typeof line[key] === 'string' && line[key].trim()) return line[key].trim();
  return '';
};

/** A generation record kept on the draft by the backend (English prose with a part number), as a sentence in the UI language. */
export function describeGenerationRecord(line) {
  const text = recordText(line);
  const retained = RETAINED.exec(text);
  if (retained) return uiFormat('第 {0} 批：计划 {2} 题，通过检查 {1} 题；其余没有通过，原因见「没进入草稿的题」。', [retained[1], retained[2], retained[3]]);
  const duplicate = DUPLICATE.exec(text);
  if (duplicate) return uiFormat('第 {0} 批：有一道题与前面的题考点重复，已略过。', [duplicate[1]]);
  if (text === '补题时跳过了一道与已有草稿重复的题') return ui('补题时跳过了一道与已有草稿重复的题');
  const part = PART.exec(text);
  if (part) {
    const found = describeFailure(part[2]);
    // A reason none of the patterns knows would read "没有完成：生成没有完成"; keep the pipeline's own words next to it.
    return uiFormat('第 {0} 批没有完成：{1}', [part[1], found.kind === 'unknown' ? `${found.title}（${clipLine(part[2].trim(), 160)}）` : found.title]);
  }
  return clipLine(text);
}

/** The records of a draft as sentences, one per line that has anything to say: an empty or unreadable line is dropped, so no list shows a blank row. */
export function generationRecordLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(describeGenerationRecord).filter((line) => line.trim());
}
