import { getUiLanguage } from '../i18n.js';
import { PAGE_EVIDENCE_MAX } from '../../lib/ask-prompt.js';
import { nameData, say } from './say.js';

/* 发给主会话 from the reader's 原始 PDF view (issue #456): one page of a material, for what the built-in page question cannot do (a figure, a formula drawn
   as a picture, a scanned page). The message carries the material's name, the page number, the page's saved text (cut at the same cap as the built-in
   answer, lib/ask-prompt.js PAGE_EVIDENCE_MAX, and says so) and what the learner typed. The picture of the page goes into the box beside it where the host takes one (`images`, #488); otherwise the screenshot is the learner's to paste, on the last line. */

/** "Help me with page N of <material>; the picture is attached / the screenshot follows." input: { title, page, text, question, images }. */
export function pageQuestionPrompt({ title, page, text = '', question = '', images }, language = getUiLanguage()) {
  const all = String(text ?? ''), kept = all.slice(0, PAGE_EVIDENCE_MAX), cut = kept.length < all.length, attached = images?.length > 0;
  return {
    ...(attached ? { tail: null } : {}),
    ask: say(language, attached ? '帮我看懂资料 {0} 的第 {1} 页；这一页的图在这条消息的附件里，你能看图片的话请对照着看。' : '帮我看懂资料 {0} 的第 {1} 页；能看图片的话，这一页的截图我贴在最后。', [nameData(title), page]),
    request: question,
    notes: [
      all.trim() ? say(language, attached ? '页面：这一页保存的文字在 data 围栏里；图表、画成图片的公式和排版只在附图里，两者不一致时以附图为准。' : '页面：这一页保存的文字在 data 围栏里；图表、画成图片的公式和排版只在截图里（如果我贴了），两者不一致时以截图为准。')
        : say(language, attached ? '页面：这一页没有保存的文字（扫描页或图片页），内容都在附图里；你看不了图片时，直接告诉我。' : '页面：这一页没有保存的文字（扫描页或图片页）；没有截图、或你看不了图片时，直接告诉我。'),
      cut && say(language, '截断：这一页的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这一页讲什么，再回答我的问题；资料里没有的内容要说明是资料以外的。'),
    ].filter(Boolean),
    data: [['这一页保存的文字', kept]],
  };
}
