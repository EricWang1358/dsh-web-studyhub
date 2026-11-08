/* 学法 (#775, 4.5 S1; #777, 4.5 S3): the method a course is learned by — its stages, each with a main activity, up to two 「也可以」, how strict its gate is,
   and an optional stage scope (deckIds / sourceIds / topics), plus an optional target date and manual stage progression state (stageIndex / skippedStages /
   selfReportedStages). The default package 「课堂跟学」 is exactly today's behaviour: publish, practise in batches, review what is due. It is stored on the
   course (course.method) and copied there when it is attached, so later edits touch that course only. Pure; no model call, no clock. */

export const METHOD_VERSION = 1;
/** What a stage is for. The chat may add its own words, the screens show these. */
export const ACTIVITIES = Object.freeze(['publish', 'practice', 'review', 'explain', 'check', 'project']);
/** How strict a stage's gate is: 松 (answered is enough), 中 (about two thirds right), 严 (all of them right). */
export const LEVELS = Object.freeze(['loose', 'medium', 'strict']);
export const STAGES_MAX = 12, ALTERNATIVES_MAX = 2, NAME_MAX = 40;
export const SCOPE_KEYS = Object.freeze(['deckIds', 'sourceIds', 'topics']);
export const SCOPE_MAX = 200, SCOPE_ITEM_MAX = 200;

const ACTIVITY_SET = new Set(ACTIVITIES), LEVEL_SET = new Set(LEVELS), SCOPE_KEY_SET = new Set(SCOPE_KEYS);
const clone = value => JSON.parse(JSON.stringify(value));
const isName = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= NAME_MAX;
const isScopeItem = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= SCOPE_ITEM_MAX;
const isDate = value => value === null || value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
const fail = message => { throw new Error(message); };

/** Each gate (the stage's level): what makes one question count, the share that passes the stage's check, and the share that is enough to go on.
    松一点 counts an answer of any grade; 适中 a last answer that was right (grade 3 or more, the line lib/mastery.js draws between weak and the rest), two
    thirds passing the check and four fifths enough to go on (owner, #777); 严格一点 asks for all of them right. */
export const GATE_RULES = Object.freeze({
  loose: Object.freeze({ counts: 'answered', pass: 2 / 3, advance: 0.8 }),
  medium: Object.freeze({ counts: 'right', pass: 2 / 3, advance: 0.8 }),
  strict: Object.freeze({ counts: 'right', pass: 1, advance: 1 }),
});
export const gateRule = level => GATE_RULES[level] || GATE_RULES.medium;
/** The fewest of `total` that make `share` (2/3 of 12 is 8, not 7.99…). */
export const atLeast = (share, total) => Math.ceil(share * total - 1e-9);
export const RUBRIC_WEAK_RATIO = 0.6;
export const isCaseStudyDeck = deck => deck?.format === 'case-study' && !!deck.case && typeof deck.case === 'object';

/** Hands-on task static check pass rule (#778): passes ONLY when every acceptance criterion is satisfied (never on partial > 50% marks). */
export function taskStaticAttemptPassed(attempt) {
  const counts = attempt?.taskCheck?.counts;
  if (counts && typeof counts === 'object') {
    return (Number(counts.satisfied) || 0) > 0 && (Number(counts.missing) || 0) === 0 && (Number(counts.issue) || 0) === 0;
  }
  return attempt?.correct === true;
}

/**
 * Case / rubric question pass rule (#777): when `assessment === 'rubric'`, strictly more than half of the marks (`score / maxScore > 0.5`) OR strictly
 * more than half of the rubric criteria meeting standard (`>= 0.6` of criterion marks, or `passed === true`) passes the stage check.
 * Hands-on task static checks (`attempt.taskCheck` / `assessment === 'task-static'`, #778) require all acceptance criteria satisfied.
 */
export function rubricAttemptPassed(attempt) {
  if (!attempt) return false;
  if (attempt.taskCheck || attempt.assessment === 'task-static') return taskStaticAttemptPassed(attempt);
  if (attempt.assessment !== 'rubric' && !attempt.rubric) return false;
  const rawScore = attempt.score !== undefined ? Number(attempt.score) : Number(attempt.rubric?.total);
  const rawMax = attempt.maxScore !== undefined ? Number(attempt.maxScore) : Number(attempt.rubric?.max);
  if (Number.isFinite(rawScore) && Number.isFinite(rawMax) && rawMax > 0 && rawScore / rawMax > 0.5) return true;
  const criteria = Array.isArray(attempt.rubric?.criteria) ? attempt.rubric.criteria : (Array.isArray(attempt.criteria) ? attempt.criteria : []);
  if (criteria.length > 0) {
    const met = criteria.filter(criterion => {
      if (!criterion) return false;
      if (criterion.passed === true) return true;
      const cMax = Number(criterion.max ?? criterion.maxScore ?? criterion.points);
      const cScore = Number(criterion.score);
      if (Number.isFinite(cMax) && cMax > 0 && Number.isFinite(cScore)) return cScore / cMax >= RUBRIC_WEAK_RATIO;
      return Number.isFinite(cScore) && cScore > 0;
    }).length;
    if (met / criteria.length > 0.5) return true;
  }
  return false;
}

/** 默认学法「课堂跟学」: today's flow, said in stages (owner: 一个都不变, only the words are new). */
export const CLASSROOM_METHOD = Object.freeze({
  version: METHOD_VERSION,
  name: '课堂跟学',
  targetDate: null,
  stages: Object.freeze([
    // Short on purpose: the names are what the card and the home line show. Batch sizes and the review order live in the practice settings, not here.
    Object.freeze({ name: '课前：导入资料', activity: 'publish', alternatives: Object.freeze(['explain']), level: 'loose' }),
    Object.freeze({ name: '课后：出题，按批练习', activity: 'practice', alternatives: Object.freeze(['explain', 'check']), level: 'medium' }),
    Object.freeze({ name: '考前：到期复习', activity: 'review', alternatives: Object.freeze(['check']), level: 'medium' }),
  ]),
});

/** The method a course is learned by: its own, else the default package. Always a value the screens can draw. */
export const courseMethod = course => (course?.method ? clone(course.method) : clone(CLASSROOM_METHOD));

/**
 * Optional per-stage scope (#777): `{ deckIds?, sourceIds?, topics? }` when any filter is non-empty, else `null`
 * (whole-course fallback, preserving 100% compatibility with methods that specify no stage scope). Accepts both `stage.scope` and top-level shorthand keys.
 */
export function stageScope(stage) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return null;
  const rawScope = stage.scope && typeof stage.scope === 'object' && !Array.isArray(stage.scope) ? stage.scope : null;
  const out = {};
  for (const key of SCOPE_KEYS) {
    const raw = rawScope && rawScope[key] !== undefined ? rawScope[key] : stage[key];
    if (!Array.isArray(raw)) continue;
    const items = [...new Set(raw.filter(isScopeItem).map(item => item.trim()))].slice(0, SCOPE_MAX);
    if (items.length) out[key] = items;
  }
  return Object.keys(out).length ? out : null;
}

function checkedStageScope(stage, at) {
  const hasScopeObj = stage.scope !== undefined && stage.scope !== null;
  if (hasScopeObj && (typeof stage.scope !== 'object' || Array.isArray(stage.scope))) {
    fail(`第 ${at} 个阶段的范围（scope）需为对象`);
  }
  if (hasScopeObj) {
    for (const key of Object.keys(stage.scope)) {
      if (!SCOPE_KEY_SET.has(key)) fail(`第 ${at} 个阶段的范围只支持 ${SCOPE_KEYS.join(' / ')}`);
    }
  }
  const out = {};
  for (const key of SCOPE_KEYS) {
    const raw = hasScopeObj && stage.scope[key] !== undefined ? stage.scope[key] : stage[key];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw) || raw.length > SCOPE_MAX || raw.some(item => !isScopeItem(item))) {
      fail(`第 ${at} 个阶段的 ${key} 需为不超过 ${SCOPE_MAX} 项的非空文本列表（每项不超过 ${SCOPE_ITEM_MAX} 字）`);
    }
    const items = [...new Set(raw.map(item => item.trim()))];
    if (items.length) out[key] = items;
  }
  return Object.keys(out).length ? out : null;
}

function checkedStageIndices(raw, max, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max || raw.some(idx => !Number.isInteger(idx) || idx < 0 || idx >= max)) {
    fail(`${label}需为 0–${max - 1} 的阶段序号列表`);
  }
  return [...new Set(raw)].sort((a, b) => a - b);
}

/**
 * Clamp `stageIndex`, `skippedStages` and `selfReportedStages` after stage edits (add/remove/reorder) so saved indices stay valid.
 */
export function clampMethodStageIndices(method) {
  if (!method || typeof method !== 'object' || !Array.isArray(method.stages) || !method.stages.length) return method;
  const max = method.stages.length - 1;
  const next = { ...method };
  if (Number.isInteger(next.stageIndex)) next.stageIndex = Math.max(0, Math.min(max, next.stageIndex));
  else delete next.stageIndex;
  if (Array.isArray(next.skippedStages)) {
    const kept = [...new Set(next.skippedStages.filter(idx => Number.isInteger(idx) && idx >= 0 && idx <= max))].sort((a, b) => a - b);
    if (kept.length) next.skippedStages = kept;
    else delete next.skippedStages;
  }
  if (Array.isArray(next.selfReportedStages)) {
    const kept = [...new Set(next.selfReportedStages.filter(idx => Number.isInteger(idx) && idx >= 0 && idx <= max))].sort((a, b) => a - b);
    if (kept.length) next.selfReportedStages = kept;
    else delete next.selfReportedStages;
  }
  if (!Array.isArray(next.skippedStages) && 'skippedStages' in next) delete next.skippedStages;
  if (!Array.isArray(next.selfReportedStages) && 'selfReportedStages' in next) delete next.selfReportedStages;
  return next;
}

/** Permute a single stage index when moving stage `from` to `to` (pure). */
export function remapStageIndexOnMove(idx, from, to) {
  if (!Number.isInteger(idx) || from === to) return idx;
  if (idx === from) return to;
  if (from < to && idx > from && idx <= to) return idx - 1;
  if (from > to && idx >= to && idx < from) return idx + 1;
  return idx;
}

/** Reorder `draft.stages` (`from` -> `to`) and permute `stageIndex`, `skippedStages`, and `selfReportedStages` accordingly (pure). */
export function remapMethodOnStageMove(draft, from, to) {
  if (!draft || !Array.isArray(draft.stages)) return draft;
  const len = draft.stages.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= len || to >= len) return draft;
  const stages = [...draft.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved);
  const next = { ...draft, stages };
  if (Number.isInteger(draft.stageIndex) && draft.stageIndex >= 0 && draft.stageIndex < len) {
    next.stageIndex = remapStageIndexOnMove(draft.stageIndex, from, to);
  }
  if (Array.isArray(draft.skippedStages)) {
    const mapped = [...new Set(draft.skippedStages
      .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < len)
      .map(idx => remapStageIndexOnMove(idx, from, to)))].sort((a, b) => a - b);
    if (mapped.length) next.skippedStages = mapped;
    else delete next.skippedStages;
  }
  if (Array.isArray(draft.selfReportedStages)) {
    const mapped = [...new Set(draft.selfReportedStages
      .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < len)
      .map(idx => remapStageIndexOnMove(idx, from, to)))].sort((a, b) => a - b);
    if (mapped.length) next.selfReportedStages = mapped;
    else delete next.selfReportedStages;
  }
  return next;
}

/** Remove `draft.stages[removedIndex]` (keeping >= 1 stage) and shift/drop `stageIndex`, `skippedStages`, and `selfReportedStages` accordingly (pure). */
export function remapMethodOnStageRemove(draft, removedIndex) {
  if (!draft || !Array.isArray(draft.stages)) return draft;
  const len = draft.stages.length;
  if (len <= 1 || !Number.isInteger(removedIndex) || removedIndex < 0 || removedIndex >= len) return draft;
  const stages = draft.stages.filter((_, at) => at !== removedIndex);
  const next = { ...draft, stages };
  if (Number.isInteger(draft.stageIndex) && draft.stageIndex >= 0 && draft.stageIndex < len) {
    if (draft.stageIndex > removedIndex) next.stageIndex = draft.stageIndex - 1;
    else if (draft.stageIndex === removedIndex) next.stageIndex = Math.min(removedIndex, stages.length - 1);
    else next.stageIndex = draft.stageIndex;
  }
  const shiftList = list => [...new Set(list
    .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < len && idx !== removedIndex)
    .map(idx => (idx > removedIndex ? idx - 1 : idx)))].sort((a, b) => a - b);
  if (Array.isArray(draft.skippedStages)) {
    const mapped = shiftList(draft.skippedStages);
    if (mapped.length) next.skippedStages = mapped;
    else delete next.skippedStages;
  }
  if (Array.isArray(draft.selfReportedStages)) {
    const mapped = shiftList(draft.selfReportedStages);
    if (mapped.length) next.selfReportedStages = mapped;
    else delete next.selfReportedStages;
  }
  return next;
}

/**
 * Pure stage switch / advance (#777): moves `method` to `targetIndex`. Any stage passed over without its check satisfied is recorded honestly in
 * `skippedStages` (「未完成就前进」) — or `selfReportedStages` when `selfReported` is true — and any stage whose check IS satisfied is cleared from both.
 */
export function advanceMethodStage(method, targetIndex, { currentIndex = 0, gateSatisfied = false, stageSatisfied = null, selfReported = false } = {}) {
  const copy = courseMethod({ method });
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= copy.stages.length) {
    fail(`目标阶段序号需为 0–${copy.stages.length - 1} 的整数`);
  }
  const from = Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : 0;
  const skipped = new Set(Array.isArray(copy.skippedStages) ? copy.skippedStages : []);
  const reported = new Set(Array.isArray(copy.selfReportedStages) ? copy.selfReportedStages : []);
  const isSatisfied = index => (typeof stageSatisfied === 'function'
    ? Boolean(stageSatisfied(index))
    : index === from && Boolean(gateSatisfied));

  if (targetIndex > from) {
    for (let idx = from; idx < targetIndex; idx += 1) {
      if (isSatisfied(idx)) {
        skipped.delete(idx);
        reported.delete(idx);
      } else if (selfReported && idx === from) {
        reported.add(idx);
        skipped.delete(idx);
      } else {
        skipped.add(idx);
      }
    }
  }
  if (typeof stageSatisfied === 'function') {
    for (let idx = 0; idx < copy.stages.length; idx += 1) {
      if (stageSatisfied(idx)) {
        skipped.delete(idx);
        reported.delete(idx);
      }
    }
  }
  copy.stageIndex = targetIndex;
  const nextSkipped = [...skipped].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < copy.stages.length).sort((a, b) => a - b);
  const nextReported = [...reported].filter(idx => Number.isInteger(idx) && idx >= 0 && idx < copy.stages.length).sort((a, b) => a - b);
  if (nextSkipped.length) copy.skippedStages = nextSkipped;
  else delete copy.skippedStages;
  if (nextReported.length) copy.selfReportedStages = nextReported;
  else delete copy.selfReportedStages;
  return checkedMethod(copy);
}

/**
 * A method as stored: undefined is "not given, leave what is there", null is "detach, back to the default". Anything else is checked and throws the sentence
 * the chat reads out when it does not hold.
 */
export function checkedMethod(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('学法需为对象');
  const name = value.name === undefined ? '课堂跟学' : value.name;
  if (!isName(name)) fail(`学法名称需为 1–${NAME_MAX} 个字`);
  if (!isDate(value.targetDate)) fail('学法目标日期需为 YYYY-MM-DD，或不填');
  const stages = value.stages;
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > STAGES_MAX) fail(`学法需有 1–${STAGES_MAX} 个阶段`);
  const checked = stages.map((stage, index) => {
    const at = index + 1;
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) fail(`第 ${at} 个阶段需为对象`);
    if (!isName(stage.name)) fail(`第 ${at} 个阶段的名称需为 1–${NAME_MAX} 个字`);
    if (!ACTIVITY_SET.has(stage.activity)) fail(`第 ${at} 个阶段的主活动需为 ${ACTIVITIES.join(' / ')} 之一`);
    const alternatives = stage.alternatives === undefined ? [] : stage.alternatives;
    if (!Array.isArray(alternatives) || alternatives.length > ALTERNATIVES_MAX) fail(`第 ${at} 个阶段最多 ${ALTERNATIVES_MAX} 个「也可以」`);
    for (const activity of alternatives) if (!ACTIVITY_SET.has(activity)) fail(`第 ${at} 个阶段的「也可以」需为 ${ACTIVITIES.join(' / ')} 之一`);
    if (new Set(alternatives).size !== alternatives.length) fail(`第 ${at} 个阶段的「也可以」有重复`);
    if (alternatives.includes(stage.activity)) fail(`第 ${at} 个阶段的「也可以」不能与主活动相同`);
    const level = stage.level === undefined ? 'medium' : stage.level;
    if (!LEVEL_SET.has(level)) fail(`第 ${at} 个阶段的过关宽严需为 ${LEVELS.join(' / ')} 之一`);
    const scope = checkedStageScope(stage, at);
    return {
      name: stage.name.trim(),
      activity: stage.activity,
      alternatives: [...alternatives],
      level,
      ...(scope ? { scope } : {}),
    };
  });
  let stageIndex;
  if (value.stageIndex !== undefined && value.stageIndex !== null) {
    if (!Number.isInteger(value.stageIndex) || value.stageIndex < 0 || value.stageIndex >= checked.length) {
      fail(`当前阶段序号需为 0–${checked.length - 1} 的整数，或不填`);
    }
    stageIndex = value.stageIndex;
  }
  const skippedStages = checkedStageIndices(value.skippedStages, checked.length, '未完成就前进的阶段');
  const selfReportedStages = checkedStageIndices(value.selfReportedStages, checked.length, '自报完成的阶段');
  return {
    version: METHOD_VERSION,
    name: name.trim(),
    targetDate: value.targetDate ?? null,
    stages: checked,
    ...(stageIndex !== undefined ? { stageIndex } : {}),
    ...(skippedStages.length ? { skippedStages } : {}),
    ...(selfReportedStages.length ? { selfReportedStages } : {}),
  };
}
