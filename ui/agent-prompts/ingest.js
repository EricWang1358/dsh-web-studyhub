import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

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

const ASK = '接下来我会在这里贴题目，帮我直接录进题组 {0}。';
const RECORD = '录入：用 study_workspace 的 ingest 直接录进学习库，不用再问我确认{0}。';
const FOLDER = '；目录 {0}';
const KIND = '题型：{0}。';
const MISTAKES = '错题：{0}。';
const NOTES = [
  '语言：题目、选项和答案保持原文语言，不要翻译。',
  '截图：先逐字转写题目、选项和答案再录入；题多可以分批。',
  '讲义：我贴的是讲义 PDF 而不是现成题目时，用 study_materials 的 document.import 导入，再用 generate 出新题草稿，题组名照旧；不要当错题录入。',
  '题册：我给的是整本题册文件时，按 skill study-import 按章录入。',
  '每批：简短告诉我录入几道、哪些重复、哪些没录成及原因、哪些答案是推断的需要我核对。',
  '停止：我说「停止录题」时调用 ingest.stop。',
];

/** The parts of the hand-off for `ingest.start`'s result; the registry ends it with 第一批题目：. input: { deckTitle, folder, kind, mistakes } (kind and mistakes are registry ids). */
export function ingestPrompt({ deckTitle = '', folder = '', kind = 'auto', mistakes = 'auto' }, language = getUiLanguage()) {
  return {
    ask: say(language, ASK, [nameData(deckTitle)]),
    notes: [
      say(language, RECORD, [folder ? say(language, FOLDER, [nameData(folder)]) : '']),
      say(language, KIND, [say(language, optionOf(INGEST_KINDS, kind).instruction)]),
      say(language, MISTAKES, [say(language, optionOf(INGEST_MISTAKES, mistakes).instruction)]),
      ...NOTES.map(line => say(language, line)),
    ],
  };
}
