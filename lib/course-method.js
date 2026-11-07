/* 学法 (#775, 4.5 S1): the method a course is learned by — its stages, each with a main activity, up to two 「也可以」 and how strict its gate is, plus an
   optional target date. The default package 「课堂跟学」 is exactly today's behaviour: publish, practise in batches, review what is due. It is stored on the
   course (course.method) and copied there when it is attached, so later edits touch that course only. Pure; no model call, no clock. A stage's progress is
   not kept here: it is read from what the learner has answered when the screens need it. */

export const METHOD_VERSION = 1;
/** What a stage is for. The chat may add its own words, the screens show these. */
export const ACTIVITIES = Object.freeze(['publish', 'practice', 'review', 'explain', 'check', 'project']);
/** How strict a stage's gate is: 松 (answered is enough), 中 (about two thirds right), 严 (all of them right). */
export const LEVELS = Object.freeze(['loose', 'medium', 'strict']);
export const STAGES_MAX = 12, ALTERNATIVES_MAX = 2, NAME_MAX = 40;

const ACTIVITY_SET = new Set(ACTIVITIES), LEVEL_SET = new Set(LEVELS);
const clone = value => JSON.parse(JSON.stringify(value));
const isName = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= NAME_MAX;
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
    return { name: stage.name.trim(), activity: stage.activity, alternatives: [...alternatives], level };
  });
  return { version: METHOD_VERSION, name: name.trim(), targetDate: value.targetDate ?? null, stages: checked };
}
