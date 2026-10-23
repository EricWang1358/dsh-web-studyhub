import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';
import { listText, partsOf } from './message.js';

/* The message of 「发给主会话」 on the 复习全书 page (ui/book/BookAsk.jsx, ui/book/send-to-chat.js; docs/review-book-agent.md). It is the contract with the main
   chat: the tools (book.toc, book.read, book.coverage, source.pages, course.book.revert) are named here and nowhere else on the page, and the registry
   entry opens the notes with the skill (study-book). It carries NO book text: the chat reads the point itself with book.read. The point's title is a name
   span in the learner's sentence, the words they selected sit in a data fence, and their own request in a request fence (ui/agent-prompts/message.js). */

/** The learner's sentence: [nothing typed, typed (their words follow in a request fence)]. */
const ASK = {
  point: ['帮我把复习全书的知识点 {0} 改得更清楚易懂：大白话，讲清为什么。', '帮我按下面的要求改复习全书的知识点 {0}：'],
  selection: ['帮我把复习全书 {0} 里我选中的那几句改得更清楚（大白话），其余不动。', '帮我按下面的要求改复习全书 {0} 里我选中的那几句，其余不动：'],
  book: ['帮我看看整本复习全书：哪些知识点最值得改、为什么？等我挑好再动手。', '帮我按下面的要求改整本复习全书：'],
};
const THIS_POINT = '这个知识点';
const FIRST = { book: '用 book.toc 看目录', point: '用 book.read 读这一节（这条消息里没有书的正文）' };
const WHERE_BOOK = '位置：课程 {0}（调用 book.* 时 course 用它）。';
const ONE_AT_A_TIME = '做法：一个知识点一个知识点地来，不要一次写整本。';
const WHERE_POINT = '位置：课程 {0}（调用 book.* 时 course 用它）· 知识点 hid {1}。';
const FILES = '文件：{0}；当前版本 v{1}（整份写入时带上这个 version）。';
const FILES_ONLY = '文件：{0}。';
const PROGRESS = '进度：{0}。';
const PAGES = '资料页已读 {0}/{1}（哪几页见 book.coverage）';
const CONCEPTS = '必讲概念讲到 {0}/{1}（缺的见 book.coverage 的 concepts.missing，补时用资料原名）';
const RULES = '规则：先用 source.pages 读资料页再写；引文只用能核对的脚注；资料以外的内容按书的语言标（资料以外）或 (beyond the materials)；一次只写一个小节。';
/* The book's language is known (course.book.open's `language`): only its own marker, as the book writes it (lib/course-book-files.js WORDS). */
const RULES_MARKED = '规则：先用 source.pages 读资料页再写；引文只用能核对的脚注；资料以外的内容标{0}；一次只写一个小节。';
// (the marker as the book writes it, keyed by the book's language: data for the assistant, not a sentence of the interface)
const BEYOND = new Map([['zh', '（资料以外）'], ['en', '(beyond the materials)']]);
const REPORT = '做完：告诉我改了哪些知识点（编号和标题）；每次改动都留着上一版，可以用 course.book.revert 回退。';
const SELECTED = '我选中的话';

/**
 * The parts of the message that hands a book edit to the main chat (the registry composes it).
 * input: { course, hid (the point; none for the whole book), title (the point's title), files: [file names of the point], version (the generated file's), coverage: { opened, pages, concepts?: { covered, total } } | null,
 *   selection (the words selected, for scope 'selection'), instruction (the learner's request, may be empty), scope: 'point' | 'selection' | 'book',
 *   bookLanguage (the book's own language, 'zh' | 'en': the rules name only its marker; unknown: both) }.
 */
export function bookEditPrompt({ course = '', hid = '', title = '', files = [], version = null, coverage = null, selection = '', instruction = '', scope = 'point', bookLanguage = '' }, language = getUiLanguage()) {
  const kind = scope === 'book' || !hid ? 'book' : scope === 'selection' && String(selection).trim() ? 'selection' : 'point';
  const asked = String(instruction ?? '').trim();
  const point = nameData(title) || say(language, THIS_POINT);
  const courseValue = JSON.stringify(String(course ?? ''));
  const notes = [];
  if (kind === 'book') notes.push(say(language, WHERE_BOOK, [courseValue]), say(language, ONE_AT_A_TIME));
  else {
    notes.push(say(language, WHERE_POINT, [courseValue, hid]));
    const names = listText(language, files || []);
    if (names) notes.push(Number.isInteger(version) ? say(language, FILES, [names, version]) : say(language, FILES_ONLY, [names]));
    const progress = [];
    if (coverage && Number.isFinite(coverage.pages) && coverage.pages > 0) progress.push(say(language, PAGES, [coverage.opened ?? 0, coverage.pages]));
    // The concept coverage the build measured (a book of the quality workflow): the figure only, the chat reads the missing names with book.coverage.
    if (coverage?.concepts && Number.isFinite(coverage.concepts.total) && coverage.concepts.total > 0) progress.push(say(language, CONCEPTS, [coverage.concepts.covered ?? 0, coverage.concepts.total]));
    if (progress.length) notes.push(say(language, PROGRESS, [partsOf(language, progress)]));
  }
  notes.push(BEYOND.has(bookLanguage) ? say(language, RULES_MARKED, [BEYOND.get(bookLanguage)]) : say(language, RULES), say(language, REPORT));
  return {
    ask: say(language, ASK[kind][asked ? 1 : 0], [point]),
    request: asked,
    first: say(language, kind === 'book' ? FIRST.book : FIRST.point),
    notes,
    data: kind === 'selection' ? [[SELECTED, selection]] : [],
  };
}
