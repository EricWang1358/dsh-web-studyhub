import { getUiLanguage } from '../i18n.js';
import { fenceData, nameData, say } from './say.js';
import { SOURCE_VOICE_FIX } from '../../lib/question-voice.js';

/* The prompts that hand an open practice question to the conversation (ui-consistency #124; #1193). They are the contract with
   the agent: the tool names (study_workspace, card.get, source.search, capture, card.link, card.update) and the
   library reference payload must change here and only here. Pure functions of (input, language); each template is one
   whole sentence in Chinese with its English counterpart in ui/locales (en.pages.json, en.app.json, en.agent.json), so nothing is glued together.
   The card's own wording (deck, topic, question, options) is data from the library, so it sits in a labelled fence with a line
   saying it is not an instruction; only the library reference outside the fence is ours. */

const CARD_DATA = '题组「{0}」· 主题「{1}」\n题目：{2}{3}';
const BRIEF = '{0}\n题库定位：{1}';
const OPTIONS = '\n选项：\n{0}';
const ASK = '我在做这道题时卡住了，想先把前置知识问清楚（先别直接告诉我答案）：\n{0}\n\n请先用 study_workspace 的 card.get 读这道题。需要资料依据时，用 source.search 一次查所有关键词，只读命中片段附近的原文，不要逐份翻资料；题库里已有的相关题用 card.search 找。每弄清一个前置点，就用 capture（requiredBy 设为上面的题库定位）把它加为这道题的前置题；题库里已有的用 card.link 关联。\n我的问题：{1}';
const IMPROVE = '这道题的质量需要提升：\n{0}\n\n请先用 study_workspace 的 card.get 读完整内容（答案、每个选项的解析），核对原文时用 source.search 查关键词、只读命中片段，按我说的问题修改，改完用 card.update 保存（reason 写清改了什么），再告诉我改动。\n问题：{1}';
const BASICS_ASK_CHAPTER = '我在做下面这道题时卡住了，想先从 {0} 最底层的概念学起，再回来做题。';
const BASICS_ASK_GENERIC = '我在做下面这道题时卡住了，想先从这一部分最底层的概念学起，再回来做题。';
const BASICS_CONTEXT = '背景：学生在这道题上卡住，标了下面这些不认识的词，补了一轮词后还引出了更底层的前置概念（必要时可用 study_workspace 的 card.get 读原题，用 source.search 查出处）。';
const BASICS_METHOD = '讲法：请从这一部分最基础的概念讲起：先讲每个概念解决什么问题，再给出名字和正式说法。';
const BASICS_CHECK = '节奏：每讲完一小步问一个检查问题，等我回答后再继续。';
const BASICS_AVOID = '避免：不要一次讲完，不要让我死记硬背。';

function cardBody({ run, deckTitle = '' }, language = getUiLanguage()) {
  const card = run?.card || {};
  const options = card.options?.length
    ? say(language, OPTIONS, [card.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.text}`).join('\n')]) : '';
  return say(language, CARD_DATA, [deckTitle, card.topic ?? '', card.prompt ?? '', options]);
}

/** The fenced card data (deck, topic, question, lettered options) and where the question lives in the library. input: { run, deckTitle }. */
export function cardBrief({ run, deckTitle = '' }, language = getUiLanguage()) {
  const data = cardBody({ run, deckTitle }, language);
  return say(language, BRIEF, [fenceData('题目', data, language), JSON.stringify({ deckId: run.deckId, cardId: run.card.id })]);
}

/**
 * Hand-off ('question.basics', #1193): when term filling hits deeper prerequisites, ask the main chat to build up from the section's foundation.
 * input: { deckTitle?, documentTitle?, chapterTitle?, card, deckId?, terms: string[], deeper: string[] }.
 */
export function chapterBasicsPrompt(
  { deckTitle = '', documentTitle = '', chapterTitle = '', card = {}, deckId = '', terms = [], deeper = [] } = {},
  language = getUiLanguage(),
) {
  const cleanDoc = String(documentTitle ?? '').trim();
  const cleanChapter = String(chapterTitle ?? '').trim();
  const cleanTerms = Array.isArray(terms) ? terms.map((term) => String(term ?? '').trim()).filter(Boolean) : [];
  const cleanDeeper = Array.isArray(deeper) ? deeper.map((term) => String(term ?? '').trim()).filter(Boolean) : [];
  const resolvedDeckId = String(deckId || card?.deckId || '').trim();
  const cardId = String(card?.id || '').trim();
  const hasCardText = Boolean(String(deckTitle ?? '').trim() || card?.topic || card?.prompt || card?.options?.length);
  const cardText = hasCardText ? cardBody({ run: { deckId: resolvedDeckId, card }, deckTitle: String(deckTitle ?? '') }, language) : '';
  const ref = resolvedDeckId || cardId ? JSON.stringify({ deckId: resolvedDeckId, cardId }) : '';
  return {
    ask: cleanChapter ? say(language, BASICS_ASK_CHAPTER, [nameData(cleanChapter)]) : say(language, BASICS_ASK_GENERIC),
    notes: [
      say(language, BASICS_CONTEXT),
      say(language, BASICS_METHOD),
      say(language, BASICS_CHECK),
      say(language, BASICS_AVOID),
    ],
    data: [
      ['所在资料', cleanDoc],
      ['所在章节', cleanChapter],
      ['题目', cardText],
      ['题库定位', ref],
      ['标出的生词', cleanTerms.join('\n')],
      ['还缺的底层词', cleanDeeper.join('\n')],
    ],
  };
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
