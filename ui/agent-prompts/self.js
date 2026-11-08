import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'self.start': the message behind 「自学目标（求职 / 考证 / 自学技能）」 in the new-course control (ui/CourseSettings.jsx, NewCourse). The main chat runs the interview of
   skills/study-self/SKILL.md: at most five option questions, a method it shows before saving, then material and the first batch. The message carries the goal
   the learner typed, when the control knew it, and never the course's content: the chat reads library.context and the library itself. The English of each
   sentence is in ui/locales/en.self.json. */

const ASK = {
  goal: '帮我建一门自学课：{0}。先问我最多五个选项，再写出学法给我确认。',
  none: '帮我建一门自学课：先问我最多五个选项，再写出学法给我确认。',
};
const GOAL = '目标：{0}（我在这门课的「新建课程」里写的；课程名就用这个说法，除非我改了）。';
const HOW = '做法：按 skill 里说的顺序一次问我一个问题，用 ask_user_question 给选项，最多五个；答过的不要再问。';
const CONSENT = '保存：确认之前不生成任何东西，也不存任何东西；我确认之后才用 course.save 的 method 存学法，并用 focus.set 切到这门课，再导入资料、出第一批题。';
const RULE = '说明：一条能核对的资料都没有的阶段不要出题；由你起草的讲义经 study_materials 的 document.import（或 source.add）导入时要传 provenance 为 "ai-drafted-unverified"，如实标明「AI 撰写 · 未核对」。';

/**
 * The parts of the message that starts the self-study interview (the registry composes it).
 * input: { goal (what the learner typed in 新建课程; '' or absent: nothing known) }.
 */
export function selfStartPrompt({ goal = '' } = {}, language = getUiLanguage()) {
  const typed = String(goal ?? '').trim().replace(/\s+/g, ' ');
  const ask = typed ? say(language, ASK.goal, [nameData(typed)]) : say(language, ASK.none);
  const notes = typed ? [say(language, GOAL, [JSON.stringify(typed)])] : [];
  notes.push(say(language, HOW), say(language, CONSENT), say(language, RULE));
  return { ask, notes };
}
