import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'method.edit': 「和主会话改学法」 on ui/CourseMethodCard.jsx (#775). Carries the course name, the learner's optional free-form thoughts/habits in a request
   fence, and the current method snapshot in a data fence. The main chat reads course.method.get, shapes stages flexibly with the learner (never locking them
   into rigid templates), shows the proposal first, and calls course.method.save only after explicit confirmation.
   'method.explain': scoped AI 带学 started from a stage's 「也可以」 (ui/method-alternatives.js), carrying the course and current stage name. */

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
const EXPLAIN_CONSENT = '确认：现场出新题、修改笔记或归档问答前先征得我同意，默认只结合已有资料讲解与提问。';

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
      say(language, EXPLAIN_CONSENT),
    ],
    data: [
      ['目标课程', courseText],
      ['当前阶段', stageText],
    ],
  };
}
