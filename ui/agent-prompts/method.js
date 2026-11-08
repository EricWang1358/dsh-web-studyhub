import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'method.edit': 「和主会话改学法」 on ui/CourseMethodCard.jsx (#775). Carries the course name, the learner's optional free-form thoughts/habits in a request
   fence, and the current method snapshot in a data fence. The main chat reads course.method.get, shapes stages flexibly with the learner (never locking them
   into rigid templates), shows the proposal first, and calls course.method.save only after explicit confirmation.
   'method.explain': scoped AI 带学 started from a stage's 「也可以」 (ui/method-alternatives.js), carrying the course and current stage name.
   'method.draftMaterial': 「请主会话起草」 on a custom-method stage that has no material yet (#776), drafting a Markdown handout marked AI 撰写 · 未核对.
   'method.missed': 「带着错题回主会话」 (#777) when a stage check or practice round has missed questions, diagnosed manually at the learner's own click. */

const ASK_COURSE = '帮我一起调整课程 {0} 的学法：按这门课的学科特点、我的习惯和想法，定制适合我的阶段。';
const ASK_GENERIC = '帮我一起调整这门课的学法：按学科特点、我的习惯和想法，定制适合我的阶段。';

const FIRST = '用 study_workspace 读 library.context {"area":"{0}"}';
const READ = '现状：先调用 course.method.get 读这门课当前的学法、所在阶段和题目检验进度（下方 data 围栏也附了面上的学法快照）。';
const FLEXIBLE = '思路：不要套死板模板，先听我的目标、节奏、备考或项目方式（理工刷题、文科精读、法医考证、语言面试或动手做项目都可以自由发挥），阶段名由我们自己定（1–12 个阶段），主活动和最多两个「也可以」从可选活动里灵活搭配。';
const SAVE = '保存：先列出拟定的阶段名称、每个阶段做什么和过关宽严给我看；等我明确同意后，再调用 course.method.save 保存这门课的学法（若我要退回默认课堂跟学则传 null）。';
const DONE = '做完：保存后告诉我更新后的阶段安排，以及当前这一阶段接下来该怎么开始。';

const EXPLAIN_COURSE_STAGE = '带我学课程 {0} 当前阶段（{1}）的内容：结合资料一步步讲清楚，边讲边确认我真听懂了。';
const EXPLAIN_COURSE = '带我学课程 {0} 这一阶段的内容：结合资料一步步讲清楚，边讲边确认我真听懂了。';
const EXPLAIN_GENERIC = '带我学这一阶段的内容：结合资料一步步讲清楚，边讲边确认我真听懂了。';
const EXPLAIN_SCOPE = '范围：先调用 course.method.get 看这门课当前的阶段与资料，按这一阶段的目标用 study.session.start 开始带学。';
const EXPLAIN_CHECK = '检验：优先用这一阶段范围里已有的题（card.search 配合 study.branch.open 或 panel.open），缺题且经我同意时趁聊天在后台补题（study.question.prepare 或 supplement），绝不现造无出处题；讲解告一段落时排进检验，并明确提醒我「回 StudyHub 做检验题」。';
const EXPLAIN_CONSENT = '确认：现场出新题、修改笔记或归档问答前先征得我同意，默认只结合已有资料讲解与提问。';

const DRAFT_COURSE_STAGE = '帮我为课程 {0} 的第 {1} 阶段（{2}）起草一份 Markdown 讲义并导入到这门课，方便我核对和学习。';
const DRAFT_COURSE = '帮我为课程 {0} 当前阶段起草一份 Markdown 讲义并导入到这门课，方便我核对和学习。';
const DRAFT_GENERIC = '帮我为当前阶段起草一份 Markdown 讲义并导入，方便我核对和学习。';
const DRAFT_READ = '现状：先调用 course.method.get 查看这门课的学法、这一阶段的目标与已有资料，结合我的学科方向、备考或项目要求组织章节。';
const DRAFT_WRITE = '导入：把讲义写成结构清晰的 Markdown 文件存到工作区 studyhub-work/ 下，再用 study_materials 的 document.import 导入这门课并传 provenance 为 "ai-drafted-unverified"（或用 source.add 传 provenance 为 "ai-drafted-unverified"），标题与正文都如实标明「AI 撰写 · 未核对」，不要冒充我的原件。';
const DRAFT_RULE = '核对：一条能核对的资料都没有的阶段不要直接出题；讲义导入后先列出章节让我核对，确认无误再问我要不要出这一阶段的第一批题。';

const MISSED_COURSE_STAGE = '我在课程 {0} 当前阶段（{1}）有几道没过关的题，带我把卡住的地方讲透，讲完我再回 StudyHub 重测。';
const MISSED_COURSE = '我在课程 {0} 有几道没过关的题，带我把卡住的地方讲透，讲完我再回 StudyHub 重测。';
const MISSED_GENERIC = '我有几道没过关的题，带我把卡住的地方讲透，讲完我再回 StudyHub 重测。';
const MISSED_DIAGNOSE = '诊断：结合下方 data 围栏里的错题（必要时用 card.get 读原题与引文，或用 course.method.get 看当前阶段），先问我当时怎么想的，再对照资料把卡住的概念讲透。';
const MISSED_DRILL = '回流：若是案例评分标准题的薄弱评分点，经我同意可用 case.drills 生成对应原理练习题；讲解告一段落时用 panel.open 或 study.branch.open 排好检验题，并明确提醒我「回 StudyHub 做检验题」，绝不现造无出处题。';

function formatMissedList(missed) {
  if (!Array.isArray(missed) || !missed.length) return '';
  return missed.slice(0, 20).map((item, idx) => {
    if (typeof item === 'string') return `${idx + 1}. ${item.trim()}`;
    if (!item || typeof item !== 'object') return '';
    const ref = item.cardId ? `[${item.cardId}] ` : '';
    const topic = item.topic ? `(${item.topic}) ` : '';
    const prompt = String(item.prompt || '').trim();
    return `${idx + 1}. ${ref}${topic}${prompt}`.trim();
  }).filter(Boolean).join('\n');
}

/**
 * input: { course?: string, method?: object | string, note?: string }.
 */
export function methodEditPrompt({ course = '', method = null, note = '' } = {}, language = getUiLanguage()) {
  const courseText = String(course ?? '').trim();
  const noteText = String(note ?? '').trim();
  const methodText = typeof method === 'string'
    ? method.trim()
    : method && typeof method === 'object' ? JSON.stringify(method, null, 2) : '';
  return {
    ask: courseText ? say(language, ASK_COURSE, [nameData(courseText)]) : say(language, ASK_GENERIC),
    request: noteText,
    requestLabel: '我的补充说明',
    first: say(language, FIRST, ['guided']),
    notes: [
      say(language, READ),
      say(language, FLEXIBLE),
      say(language, SAVE),
      say(language, DONE),
    ],
    data: [
      ['目标课程', courseText],
      ['当前学法', methodText],
    ],
    tail: noteText ? null : 'ask',
  };
}

/**
 * input: { course?: string, stage?: string }.
 */
export function methodExplainPrompt({ course = '', stage = '' } = {}, language = getUiLanguage()) {
  const courseText = String(course ?? '').trim();
  const stageText = String(stage ?? '').trim();
  const ask = courseText && stageText
    ? say(language, EXPLAIN_COURSE_STAGE, [nameData(courseText), nameData(stageText)])
    : courseText ? say(language, EXPLAIN_COURSE, [nameData(courseText)]) : say(language, EXPLAIN_GENERIC);
  return {
    ask,
    first: say(language, FIRST, ['guided']),
    notes: [
      say(language, EXPLAIN_SCOPE),
      say(language, EXPLAIN_CHECK),
      say(language, EXPLAIN_CONSENT),
    ],
    data: [
      ['目标课程', courseText],
      ['当前阶段', stageText],
    ],
  };
}

/**
 * input: { course?: string, stage?: string, stageIndex?: number, methodName?: string, note?: string }.
 */
export function methodDraftMaterialPrompt({ course = '', stage = '', stageIndex = 1, methodName = '', note = '' } = {}, language = getUiLanguage()) {
  const courseText = String(course ?? '').trim();
  const stageText = String(stage ?? '').trim();
  const methodText = String(methodName ?? '').trim();
  const noteText = String(note ?? '').trim();
  const num = Number.isInteger(stageIndex) && stageIndex > 0 ? stageIndex : 1;
  const ask = courseText && stageText
    ? say(language, DRAFT_COURSE_STAGE, [nameData(courseText), num, nameData(stageText)])
    : courseText ? say(language, DRAFT_COURSE, [nameData(courseText)]) : say(language, DRAFT_GENERIC);
  const stageSummary = stageText ? `#${num} ${stageText}` : '';
  return {
    ask,
    request: noteText,
    requestLabel: '我的补充说明',
    first: say(language, FIRST, ['imports']),
    notes: [
      say(language, DRAFT_READ),
      say(language, DRAFT_WRITE),
      say(language, DRAFT_RULE),
    ],
    data: [
      ['目标课程', courseText],
      ['当前学法', methodText],
      ['当前阶段', stageSummary],
    ],
  };
}

/**
 * input: { course?: string, stage?: string, missed?: Array<object | string>, note?: string }.
 */
export function methodMissedPrompt({ course = '', stage = '', missed = [], note = '' } = {}, language = getUiLanguage()) {
  const courseText = String(course ?? '').trim();
  const stageText = String(stage ?? '').trim();
  const noteText = String(note ?? '').trim();
  const missedText = formatMissedList(missed);
  const ask = courseText && stageText
    ? say(language, MISSED_COURSE_STAGE, [nameData(courseText), nameData(stageText)])
    : courseText ? say(language, MISSED_COURSE, [nameData(courseText)]) : say(language, MISSED_GENERIC);
  return {
    ask,
    request: noteText,
    requestLabel: '我的补充说明',
    first: say(language, FIRST, ['guided']),
    notes: [
      say(language, MISSED_DIAGNOSE),
      say(language, MISSED_DRILL),
    ],
    data: [
      ['目标课程', courseText],
      ['当前阶段', stageText],
      ['待补错题', missedText],
    ],
  };
}
