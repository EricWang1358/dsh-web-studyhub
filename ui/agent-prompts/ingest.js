import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';

/* "Record the questions I paste into this conversation": the options of the setup form (Ingest.jsx) and the prompt that
   hands them to the conversation's agent (ui-consistency #124). One registry describes each option once: the label and hint the
   form shows, and the sentence the prompt gives the agent. The English of every sentence is in ui/locales/en.pages.json. */

/** Question types: id, form label, form hint, and what the agent is told to make. */
export const INGEST_KINDS = Object.freeze([
  { id: 'auto', label: '自动识别', hint: '有选项保持单选/多选，没有选项做成问答闪卡', instruction: '自动识别（有选项的保持单选/多选，没有选项的做成问答闪卡）' },
  { id: 'flashcard', label: '闪卡', hint: '一律做成问答闪卡', instruction: '一律闪卡' },
  { id: 'quiz', label: '单选 MQ', hint: '一律做成单选，没有选项的补干扰项', instruction: '一律单选 MQ' },
  { id: 'multi', label: '多选', hint: '一律做成多选', instruction: '一律多选' },
  { id: 'open', label: '开放问答', hint: '需要论述的题，附评分标准', instruction: '一律开放问答' },
]);

/** Which recorded questions count as mistakes: id, form label, form hint, and what the agent is told to do. */
export const INGEST_MISTAKES = Object.freeze([
  { id: 'auto', label: '按我标注的', hint: '标了自己选错的才记为错题', instruction: '我标明自己选错的记为错题' },
  { id: 'all', label: '全部当错题', hint: '这批都是错题记录，全部优先复习', instruction: '这批全部当错题' },
  { id: 'none', label: '都不算错题', hint: '只是收集题目', instruction: '都不记为错题' },
]);

const optionOf = (list, id) => list.find((item) => item.id === id) || list[0];

const FOLDER = '（目录 {0}）';
const START = '开始录题：接下来这段对话里我贴的题目（刷题软件、Canvas 错题记录、截图都可能），请都用 study_workspace 的 ingest 直接录入学习库，不用再问我确认。\n'
  + '- 题组：「{0}」{1}\n'
  + '- 题型：{2}\n'
  + '- 错题：{3}\n'
  + '- 截图请先逐字转写题目、选项和答案再录入；一次贴很多题时可以分批。\n'
  + '- 如果我贴的是讲义 PDF 而不是现成题目，请用 source.import 按页导入，再用 generate 生成新题草稿，沿用上述题组名称；不要把讲义当错题录入。\n'
  + '- 每批录完简短告诉我：录入几道、哪些重复、哪些没录成功及原因、哪些答案是推断的需要我核对。\n'
  + '- 我说「停止录题」时调用 ingest.stop。\n'
  + '第一批题目：\n';

/** The hand-off for `ingest.start`'s result. input: { deckTitle, folder, kind, mistakes } (kind and mistakes are registry ids). */
export function ingestPrompt({ deckTitle = '', folder = '', kind = 'auto', mistakes = 'auto' }, language = getUiLanguage()) {
  return say(language, START, [
    deckTitle,
    folder ? say(language, FOLDER, [folder]) : '',
    say(language, optionOf(INGEST_KINDS, kind).instruction),
    say(language, optionOf(INGEST_MISTAKES, mistakes).instruction),
  ]);
}
