import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'course.plan': the message of 「发给主会话」 on the review book page's 备考计划 (ui/book/PlanSection.jsx; docs/review-book.md). The plan is drafted WITH the
   learner in the chat: the message names the course, says whether the course has an exam date and a plan already, and tells the assistant the one rule that
   matters (nothing is saved before the learner agrees). It carries no book text and no plan text: the chat reads the area plan, course.plan and course.get
   itself. The course is a name span in the learner's sentence and a JSON string in the note that names the tool argument. The English of each sentence is in
   ui/locales/en.agent.json. */

const ASK = {
  draft: '帮我和你一起为课程 {0} 定一份备考计划：按考试日期和复习全书里各节的掌握情况，排阶段、每周节奏和模拟卷。',
  revise: '帮我看看课程 {0} 的备考计划要不要调整：按现在的进度和掌握情况，改阶段、节奏或模拟卷的日子。',
};
const WHERE = '位置：课程 {0}（调用 course.* 和 book.* 时 course 用它）。';
const EXAM = '考试日期：{0}（课程信息里已有）。';
const NO_EXAM = '考试日期：这门课还没有；先问我，我同意后用 course.save 的 exam 存下来，没有考试日期备考计划排不出日子。';
const HOW = '做法：先读 library.context 的 plan 区，再用 course.plan 看现在的排期和各节掌握情况；先和我商量阶段、每周节奏（模拟卷、复习日、休息）和每天的分钟数。';
const CONSENT = '保存：我同意之后才用 course.save 存 plan，不要自己存；已有计划时把整份 plan 发回去。';
const HAS_PLAN = '已有计划：course.plan 里的 plan 就是现在存着的，改动前先给我看差别。';
const RULE = '说明：计划只是建议，不是掌握的证据；最后一周每天读什么仍由期末一周（book.crunch）排。';

/**
 * The parts of the message that hands a 备考计划 to the main chat (the registry composes it).
 * input: { course (the course name; '' is the uncategorised one), examDate ('YYYY-MM-DD' | null), hasPlan (a plan is saved) }.
 */
export function coursePlanPrompt({ course = '', examDate = null, hasPlan = false } = {}, language = getUiLanguage()) {
  const notes = [say(language, WHERE, [JSON.stringify(String(course ?? ''))]), examDate ? say(language, EXAM, [examDate]) : say(language, NO_EXAM), say(language, HOW), say(language, CONSENT)];
  if (hasPlan) notes.push(say(language, HAS_PLAN));
  notes.push(say(language, RULE));
  return { ask: say(language, ASK[hasPlan ? 'revise' : 'draft'], [nameData(course)]), notes };
}
