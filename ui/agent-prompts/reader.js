import { getUiLanguage } from '../i18n.js';
import { PAGE_EVIDENCE_MAX, PAGE_RANGE_EVIDENCE_MAX } from '../../lib/ask-prompt.js';
import { nameData, say } from './say.js';

/* 发给主会话 from the reader's 原始 PDF view (issue #456): one page of a material, for what the built-in page question cannot do (a figure, a formula drawn
   as a picture, a scanned page). The message carries the material's name, the page number, the page's saved text (cut at the same cap as the built-in
   answer, lib/ask-prompt.js PAGE_EVIDENCE_MAX, and says so) and what the learner typed. The picture of the page goes into the box beside it where the model takes one (`picture`, #488); otherwise the screenshot is the learner's to paste, on the last line. */

/* The text goes in before any picture does and a picture can be refused, so it never says one is attached (the receipt does): "if this message carries a picture" is true either way.
   Each sentence for one page, and for a range (#488): whole sentences, so the catalogue has them whole. */
const RANGE_WORDS = {
  ask: ['帮我看懂资料 {0} 的第 {1} 页。', '帮我看懂资料 {0} 的第 {1} 页；能看图片的话，这几页的截图我贴在最后。'],
  page: ['页面：这几页保存的文字在 data 围栏里，每页以 [page N] 开头；这条消息带了图的话，图表、画成图片的公式和排版以图为准。', '页面：这几页保存的文字在 data 围栏里，每页以 [page N] 开头；图表、画成图片的公式和排版只在截图里（如果我贴了），两者不一致时以截图为准。'],
  blank: ['页面：这几页没有保存的文字（扫描页或图片页）；这条消息没带图、或你看不了图片时，直接告诉我。', '页面：这几页没有保存的文字（扫描页或图片页）；没有截图、或你看不了图片时，直接告诉我。'],
};

/* The original file of the material, when the library knows where it is (a reference to the learner's own file, or the copy in the library): the main chat can open it, so a figure, a table or
   a formula is read from the page itself, not from what the converter made of it. The path is the learner's own file name, in a name span; the page is the file's own order. */
const ORIGINAL_WORDS = {
  page: '原文件：{0}（PDF 的第 {1} 页，按文件的页序，不是书上印的页码）。图表、表格和公式请打开这个 PDF 的这一页来看，不要只信转换出来的文字。',
  range: '原文件：{0}（PDF 的第 {1} 页，按文件的页序，不是书上印的页码）。图表、表格和公式请打开这个 PDF 的这几页来看，不要只信转换出来的文字。',
};
const originalNote = (original, page, range, language) => (original?.path ? say(language, range ? ORIGINAL_WORDS.range : ORIGINAL_WORDS.page, [nameData(original.path), page]) : '');

/** "Help me with page N of <material>; the screenshot follows" (none when a picture is on its way). input: { title, page (a number, or 3–5 with range), range, text, question, picture, original ({ path }: where the original PDF is) }. */
export function pageQuestionPrompt({ title, page, range = false, text = '', question = '', picture, original }, language = getUiLanguage()) {
  const all = String(text ?? ''), kept = all.slice(0, range ? PAGE_RANGE_EVIDENCE_MAX : PAGE_EVIDENCE_MAX), cut = kept.length < all.length;
  // A screenshot would block the message on a model the host says takes no image: nobody is invited to paste one there.
  const attached = picture?.images?.length > 0 || picture?.refused === 'model';
  const words = key => RANGE_WORDS[key][attached ? 0 : 1];
  if (range) return {
    tail: attached ? null : 'images',
    ask: say(language, words('ask'), [nameData(title), page]),
    request: question,
    notes: [say(language, words(all.trim() ? 'page' : 'blank')),
      originalNote(original, page, true, language),
      cut && say(language, '截断：这几页的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这几页讲什么，再回答我的问题；说明每一点来自哪一页；资料里没有的内容要说明是资料以外的。')].filter(Boolean),
    data: [['这几页保存的文字', kept]],
  };
  return {
    ...(attached ? { tail: null } : {}),
    ask: say(language, attached ? '帮我看懂资料 {0} 的第 {1} 页。' : '帮我看懂资料 {0} 的第 {1} 页；能看图片的话，这一页的截图我贴在最后。', [nameData(title), page]),
    request: question,
    notes: [
      all.trim() ? say(language, attached ? '页面：这一页保存的文字在 data 围栏里；这条消息带了图的话，图表、画成图片的公式和排版以图为准。' : '页面：这一页保存的文字在 data 围栏里；图表、画成图片的公式和排版只在截图里（如果我贴了），两者不一致时以截图为准。')
        : say(language, attached ? '页面：这一页没有保存的文字（扫描页或图片页）；这条消息没带图、或你看不了图片时，直接告诉我。' : '页面：这一页没有保存的文字（扫描页或图片页）；没有截图、或你看不了图片时，直接告诉我。'),
      originalNote(original, page, false, language),
      cut && say(language, '截断：这一页的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这一页讲什么，再回答我的问题；资料里没有的内容要说明是资料以外的。'),
    ].filter(Boolean),
    data: [['这一页保存的文字', kept]],
  };
}

/* 发给主会话 from the reader's 思维导图: the tree the reader drew from one chapter's headings (reader/mind-map.js, no model), handed over so the main chat refines
   it from the chapter's pages. The message names the material and the chapter (name spans) and its page range, and carries the tree as an indented list in a data
   fence; it asks for a list in the chat only, nothing saved. The English of each sentence is in ui/locales/en.agent.json. */
const MAP_ASK = '帮我细化资料 {0} 里「{1}」这一章的思维导图（第 {2}–{3} 页）。';
const MAP_ASK_NO_PAGES = '帮我细化资料 {0} 里「{1}」这一章的思维导图。';
const MAP_FIRST = '用 source.pages 按页码读这一章的页面（一次最多 4 页，往后接着读）';
const MAP_HOW = '做法：在 data 里的标题树上细化：补上漏掉的小节和要点，合并重复的，每个节点带页码；用缩进的列表直接回复我。';
const MAP_RULE = '说明：标题树是阅读器按标题自动画的，可能有错，以页面文字为准；这张图只留在这次回复里，不会写进学习库。';

/** The parts of the message that asks the chat to refine a chapter's mind map. input: { title (the material), chapter (its title), from, to (page numbers), outline (the tree as an indented text) }. */
export function mindMapPrompt({ title = '', chapter = '', from = 0, to = 0, outline = '' } = {}, language = getUiLanguage()) {
  const pages = Number.isInteger(from) && from > 0 && Number.isInteger(to) && to >= from;
  return {
    ask: pages ? say(language, MAP_ASK, [nameData(title), nameData(chapter), from, to]) : say(language, MAP_ASK_NO_PAGES, [nameData(title), nameData(chapter)]),
    first: say(language, MAP_FIRST),
    notes: [say(language, MAP_HOW), say(language, MAP_RULE)],
    data: [['这一章的标题树', outline]],
  };
}
