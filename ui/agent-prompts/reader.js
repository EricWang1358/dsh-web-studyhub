import { getUiLanguage } from '../i18n.js';
import { PAGE_EVIDENCE_MAX, PAGE_RANGE_EVIDENCE_MAX } from '../../lib/ask-prompt.js';
import { isSlideFormat } from '../../lib/office/limits.js';
import { listText } from './message.js';
import { nameData, say } from './say.js';

/* 发给主会话 from the reader's 原始 PDF view (issue #456) and 阅读 view unread-image handoff (#1457): one page or slide of a material, for what the built-in page question cannot do (a figure, a chart, SmartArt, a formula drawn
   as a picture, a scanned page). The message carries the material's name, the page/slide number, its saved text (cut at the same cap as the built-in
   answer, lib/ask-prompt.js PAGE_EVIDENCE_MAX, and says so) and what the learner typed. The picture of the page goes into the box beside it where the model takes one (`picture`, #488), or is staged to disk for agy CLI (`stagedImages`, #1457); otherwise the screenshot is the learner's to paste, on the last line. */

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
  slide: '原文件：{0}（幻灯片的第 {1} 张）。图片、图表和 SmartArt 请打开这份幻灯片的这一张来看，不要只信提取出来的文字。',
  slideRange: '原文件：{0}（幻灯片的第 {1} 张）。图片、图表和 SmartArt 请打开这份幻灯片的这几张来看，不要只信提取出来的文字。',
};
const originalNote = (original, page, range, slide, language) => {
  if (!original?.path) return '';
  const key = slide ? (range ? ORIGINAL_WORDS.slideRange : ORIGINAL_WORDS.slide) : (range ? ORIGINAL_WORDS.range : ORIGINAL_WORDS.page);
  return say(language, key, [nameData(original.path), page]);
};

const VISUAL_NAMES = Object.freeze({ image: '图片', chart: '图表', smartart: 'SmartArt 图形' });

function unreadVisualsNote({ unreadImages, visuals, slide }, language) {
  if (!unreadImages && !visuals.length) return '';
  if (visuals.length) {
    const names = listText(language, visuals.map(kind => say(language, VISUAL_NAMES[kind])));
    return say(language, slide
      ? '未识别内容：StudyHub 没有读入这一张幻灯片里的{0}，我需要你帮我结合这些视觉内容看懂这一张。'
      : '未识别内容：StudyHub 没有读入这一页里的{0}，我需要你帮我结合这些视觉内容看懂这一页。', [names]);
  }
  return say(language, slide
    ? '未识别内容：StudyHub 没有读入这一张幻灯片里的图片或图表，我需要你帮我结合图里的内容看懂这一张。'
    : '未识别内容：StudyHub 没有读入这一页里的图片或图表，我需要你帮我结合图里的内容看懂这一页。');
}

function stagedImagesNote(paths, range, language) {
  if (!paths.length) return '';
  return say(language, range || paths.length > 1
    ? '页面图片：这几页的截图已存到工作区（路径见下方「页码截图路径」data 围栏），请直接查看这些图片文件来读取图、表和公式，不要只靠提取的文字。'
    : '页面图片：这一页的截图已存到工作区（路径见下方「页码截图路径」data 围栏），请直接查看该图片文件来读取图、表和公式，不要只靠提取的文字。');
}

/**
 * "Help me with page/slide N of <material>; the screenshot follows" (none when a picture is on its way or staged to disk).
 * input: { title, page (a number, or 3–5 with range), range, text, question, picture, original ({ path }), stagedImages?, omittedVisuals?, format?, unreadImages? }.
 */
export function pageQuestionPrompt({
  title, page, range = false, text = '', question = '', picture, original,
  stagedImages = [], omittedVisuals = [], format = '', unreadImages = false,
}, language = getUiLanguage()) {
  const all = String(text ?? ''), kept = all.slice(0, range ? PAGE_RANGE_EVIDENCE_MAX : PAGE_EVIDENCE_MAX), cut = kept.length < all.length;
  const stagedPaths = (Array.isArray(stagedImages) ? stagedImages : []).map(item => String(item ?? '').trim()).filter(Boolean);
  const visuals = [...new Set((Array.isArray(omittedVisuals) ? omittedVisuals : []).filter(kind => Object.hasOwn(VISUAL_NAMES, kind)))];
  const slide = isSlideFormat(format);
  // A screenshot would block the message on a model the host says takes no image: nobody is invited to paste one there.
  // Staged page images already live on disk for agy CLI / external agents, so no screenshot-paste tail is added either.
  const attached = picture?.images?.length > 0 || picture?.refused === 'model' || stagedPaths.length > 0;
  const stagedFence = stagedPaths.length ? [['页码截图路径', stagedPaths.join('\n')]] : [];
  const words = key => RANGE_WORDS[key][attached ? 0 : 1];
  if (range) return {
    tail: attached ? null : 'images',
    ask: say(language, words('ask'), [nameData(title), page]),
    request: question,
    notes: [
      say(language, words(all.trim() ? 'page' : 'blank')),
      unreadVisualsNote({ unreadImages, visuals, slide }, language),
      stagedImagesNote(stagedPaths, true, language),
      originalNote(original, page, true, slide, language),
      cut && say(language, '截断：这几页的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这几页讲什么，再回答我的问题；说明每一点来自哪一页；资料里没有的内容要说明是资料以外的。'),
    ].filter(Boolean),
    data: [['这几页保存的文字', kept], ...stagedFence],
  };
  if (slide) return {
    ...(attached ? { tail: null } : {}),
    ask: say(language, attached ? '帮我看懂幻灯片 {0} 的第 {1} 张。' : '帮我看懂幻灯片 {0} 的第 {1} 张；能看图片的话，这一张的截图我贴在最后。', [nameData(title), page]),
    request: question,
    notes: [
      all.trim()
        ? say(language, attached ? '页面：这一张幻灯片保存的文字在 data 围栏里；这条消息带了图的话，图片、图表、SmartArt 和排版以图为准。' : '页面：这一张幻灯片保存的文字在 data 围栏里；图片、图表、SmartArt 和排版只在截图或原文件里，两者不一致时以原图为准。')
        : say(language, attached ? '页面：这一张幻灯片没有保存的文字（仅含图片或图表）；这条消息没带图、或你看不了图片时，直接告诉我。' : '页面：这一张幻灯片没有保存的文字（仅含图片或图表）；没有截图、或你看不了图片时，直接告诉我。'),
      unreadVisualsNote({ unreadImages, visuals, slide: true }, language),
      stagedImagesNote(stagedPaths, false, language),
      originalNote(original, page, false, true, language),
      cut && say(language, '截断：这一张幻灯片的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这一张幻灯片讲什么，再结合图里的内容回答我的问题；资料里没有的内容要说明是资料以外的。'),
    ].filter(Boolean),
    data: [['这一张保存的文字', kept], ...stagedFence],
  };
  return {
    ...(attached ? { tail: null } : {}),
    ask: say(language, attached ? '帮我看懂资料 {0} 的第 {1} 页。' : '帮我看懂资料 {0} 的第 {1} 页；能看图片的话，这一页的截图我贴在最后。', [nameData(title), page]),
    request: question,
    notes: [
      all.trim() ? say(language, attached ? '页面：这一页保存的文字在 data 围栏里；这条消息带了图的话，图表、画成图片的公式和排版以图为准。' : '页面：这一页保存的文字在 data 围栏里；图表、画成图片的公式和排版只在截图里（如果我贴了），两者不一致时以截图为准。')
        : say(language, attached ? '页面：这一页没有保存的文字（扫描页或图片页）；这条消息没带图、或你看不了图片时，直接告诉我。' : '页面：这一页没有保存的文字（扫描页或图片页）；没有截图、或你看不了图片时，直接告诉我。'),
      unreadVisualsNote({ unreadImages, visuals, slide: false }, language),
      stagedImagesNote(stagedPaths, false, language),
      originalNote(original, page, false, false, language),
      cut && say(language, '截断：这一页的文字较长，只附了前 {0} 字（共 {1} 字）。', [kept.length, all.length]),
      say(language, '做法：先用一两句话说这一页讲什么，再回答我的问题；资料里没有的内容要说明是资料以外的。'),
    ].filter(Boolean),
    data: [['这一页保存的文字', kept], ...stagedFence],
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
