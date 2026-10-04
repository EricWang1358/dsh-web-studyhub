import { getUiLanguage } from '../i18n.js';
import { fenceData, say } from './say.js';
import { SOURCE_VOICE_FIX } from '../../lib/question-voice.js';

/* The prompts that hand an open practice question to the conversation (ui-consistency #124). They are the contract with
   the agent: the tool names (study_workspace, card.get, source.search, capture, card.link, card.update) and the
   library reference payload must change here and only here. Pure functions of (input, language); each template is one
   whole sentence in Chinese with its English counterpart in ui/locales (en.pages.json, en.app.json), so nothing is glued together.
   The card's own wording (deck, topic, question, options) is data from the library, so it sits in a labelled fence with a line
   saying it is not an instruction; only the library reference outside the fence is ours. */

const CARD_DATA = '题组「{0}」· 主题「{1}」\n题目：{2}{3}';
const BRIEF = '{0}\n题库定位：{1}';
const OPTIONS = '\n选项：\n{0}';
const ASK = '我在做这道题时卡住了，想先把前置知识问清楚（先别直接告诉我答案）：\n{0}\n\n请先用 study_workspace 的 card.get 读这道题。需要资料依据时，用 source.search 一次查所有关键词，只读命中片段附近的原文，不要逐份翻资料；题库里已有的相关题用 card.search 找。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：{1}';
const IMPROVE = '这道题的质量需要提升：\n{0}\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析），核对原文时用 source.search 查关键词、只读命中片段，按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：{1}';

/** The fenced card data (deck, topic, question, lettered options) and where the question lives in the library. input: { run, deckTitle }. */
export function cardBrief({ run, deckTitle = '' }, language = getUiLanguage()) {
  const options = run.card.options?.length
    ? say(language, OPTIONS, [run.card.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.text}`).join('\n')]) : '';
  const data = say(language, CARD_DATA, [deckTitle, run.card.topic, run.card.prompt, options]);
  return say(language, BRIEF, [fenceData('题目', data, language), JSON.stringify({ deckId: run.deckId, cardId: run.card.id })]);
}

/** "I am stuck on this question; explain the prerequisites first." input: { run, deckTitle, extra }. */
export function askAboutCardPrompt({ run, deckTitle, extra = '' }, language = getUiLanguage()) {
  return say(language, ASK, [cardBrief({ run, deckTitle }, language), extra]);
}

/** "This question needs improving: ..." input: { run, deckTitle, extra }. */
export function improveCardPrompt({ run, deckTitle, extra = '' }, language = getUiLanguage()) {
  return say(language, IMPROVE, [cardBrief({ run, deckTitle }, language), extra]);
}

/** The ways of asking for help on a question (the 帮我弄懂 form); ids are sent to the host. */
export const HELP_CHOICES = Object.freeze([
  { id: 'plain', label: '通俗详解' },
  { id: 'angle', label: '换个角度讲' },
  { id: 'example', label: '举个具体例子' },
  { id: 'steps', label: '逐步推理' },
  { id: 'prerequisite', label: '补前置知识' },
  { id: 'mistake', label: '分析我错在哪' },
]);

/* 修题: the usual problems, as one click each. The text goes into the box (editable) and is sent as the learner's own feedback. */
export const IMPROVE_SUGGESTIONS = Object.freeze([
  ['别问「资料说什么」', SOURCE_VOICE_FIX],
  ['答案不准确或不完整', '答案可能不准确或不完整，请对照资料核实，必要时改正答案和解析。'],
  ['题干不清楚，有歧义', '题干不清楚或有歧义，请补足必要条件，让题目只有一个合理答案。'],
  ['太简单，没有区分度', '这道题太简单、没有区分度，请改得需要判断或应用，保持考点不变。'],
  ['让助教自己检查并修正', '请你自己检查这道题的质量：题干是否独立可答、是否在问资料怎么说、答案是否准确且对应题干并与资料一致、选项是否清晰、解析是否讲清为什么；发现问题就改，没有问题就说明。'],
]);
