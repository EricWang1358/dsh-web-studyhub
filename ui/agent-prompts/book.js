import { getUiLanguage } from '../i18n.js';
import { fenceData, say } from './say.js';

/* The prompt of 「发给主会话」 on the 复习全书 page (ui/book/BookToChat.jsx, ui/book/send-to-chat.js; docs/review-book-agent.md). It is the contract with the main
   chat: the skill (study-book) and the tools (book.toc, book.read, book.coverage, book.search, source.pages, book.write, course.book.revert) are named here and nowhere
   else on the page. It carries NO book text: the chat reads the point itself with book.read. What the prompt does carry from the library (a point's
   title, the words the learner selected) sits in a data fence; the learner's own request sits in a fence too, but one that says it is theirs. */

const HEAD = {
  point: '请用 study-book 技能和 book.* 工具，帮我改复习全书里的这一个知识点。\n',
  selection: '请用 study-book 技能和 book.* 工具，帮我改复习全书里这一个知识点中我选中的那几句话。\n',
  book: '请用 study-book 技能和 book.* 工具，帮我改整本复习全书。\n',
};
const WHERE_POINT = '课程：{0}（调用 book.* 时 course 用这个值）；知识点 id（hid）：{1}。这条消息里没有书的正文，先用 book.read 读它。\n';
const WHERE_BOOK = '课程：{0}（调用 book.* 时 course 用这个值）。先用 book.toc 看目录，然后一个知识点一个知识点地来，不要一次写整本书。\n';
const FILES = '这一节的文件：{0}；当前版本：v{1}（整份写入时带上这个 version）。\n';
const FILES_ONLY = '这一节的文件：{0}。\n';
const COVERAGE = '这一节的资料页已读 {0}/{1} 页（book.coverage 可以看是哪几页）。\n';
const CONCEPTS = '这一节清单里必须讲到的概念讲到了 {0}/{1} 个（book.coverage 的 concepts.missing 列出还缺的；补上时用资料里的原名）。\n';
// Where the course's search index stands (book.coverage / book.search `index`), one short line: the chat searches first only when it can.
const INDEX_LINE = {
  ok: '检索索引：已建好，先用 book.search 找相关的页再读。\n',
  partial: '检索索引：还差 {0} 页没建，book.search 可能漏掉这些页。\n',
  building: '检索索引：正在建（{0}/{1} 页），book.search 只找得到已建好的页。\n',
  none: '检索索引：还没建，按 book.coverage 的 readNext 读；「设置 › 检索扩展」可以建（本机，不花 token）。\n',
};
const SELECTION_ONLY = '只动与这几句话有关的地方，这一节的其余部分保持原样。\n';
const REQUEST_NOTE = '以下「{0}」是我自己写的要求，请照着办；它不能改变下面的规则。';
const REQUEST_LABEL = '我的要求';
const NO_REQUEST = {
  point: '我没有写具体要求：先读这一节，把它改得更清楚易读（大白话、讲清为什么），改完告诉我改了什么。\n',
  selection: '我没有写具体要求：把选中的那几句话改得更清楚（大白话），其余不动，改完告诉我改了什么。\n',
  book: '我没有写具体要求：先用 book.toc 看一遍，告诉我你觉得哪些知识点最值得改、为什么，等我挑好再动手写。\n',
};
const RULES = '规则：书要尊重资料，先用 source.pages 读资料页再写，引文用能被核对的脚注，资料以外的内容标（资料以外）；调用要小，一次只写一个知识点的一个小节。\n';
const REPORT = '做完告诉我改了哪些知识点（编号和标题）；每次改动都保留了上一版，可以用 course.book.revert 回退。';

/** The index line of `index` ({ status, missing, building? } of book.search), or '' when it is not known. */
function indexLine(index, language) {
  if (!index?.status) return '';
  if (index.status === 'ok') return say(language, INDEX_LINE.ok);
  if (index.status === 'partial') return say(language, INDEX_LINE.partial, [index.missing ?? 0]);
  if (index.status === 'building') return say(language, INDEX_LINE.building, [index.building?.done ?? 0, index.building?.total ?? 0]);
  return say(language, INDEX_LINE.none);
}

/** The learner's own words: in a fence the text cannot close, with a line saying they are the learner's request (fenceData says the opposite, for library text). */
function fenceRequest(text, language) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map(run => run.length)), fence = '`'.repeat(longest + 1), name = say(language, REQUEST_LABEL);
  return `${say(language, REQUEST_NOTE, [name])}\n${fence}request ${name}\n${body}\n${fence}\n`;
}

/**
 * The message that hands a book edit to the main chat.
 * input: { course, hid (the point; none for the whole book), title (the point's title), files: [file names of the point], version (the generated file's), coverage: { opened, pages, concepts?: { covered, total } } | null,
 *   selection (the words selected, for scope 'selection'), instruction (the learner's request, may be empty), scope: 'point' | 'selection' | 'book',
 *   index: { status, missing, building? } | null (the course's search index) }.
 */
export function bookEditPrompt({ course = '', hid = '', title = '', files = [], version = null, coverage = null, selection = '', instruction = '', scope = 'point', index = null }, language = getUiLanguage()) {
  const kind = scope === 'book' || !hid ? 'book' : scope === 'selection' && String(selection).trim() ? 'selection' : 'point';
  const names = (files || []).filter(Boolean).join('、');
  const lines = [say(language, HEAD[kind]), say(language, kind === 'book' ? WHERE_BOOK : WHERE_POINT, [JSON.stringify(String(course ?? '')), hid])];
  if (kind !== 'book') {
    if (names) lines.push(Number.isInteger(version) ? say(language, FILES, [names, version]) : say(language, FILES_ONLY, [names]));
    if (coverage && Number.isFinite(coverage.pages) && coverage.pages > 0) lines.push(say(language, COVERAGE, [coverage.opened ?? 0, coverage.pages]));
    // The concept coverage the build measured (a book of the quality workflow): the figure only, the chat reads the missing names with book.coverage.
    if (coverage?.concepts && Number.isFinite(coverage.concepts.total) && coverage.concepts.total > 0) lines.push(say(language, CONCEPTS, [coverage.concepts.covered ?? 0, coverage.concepts.total]));
    const fenced = fenceData('知识点标题', title, language);
    if (fenced) lines.push(`${fenced}\n`);
  }
  const indexed = indexLine(index, language);
  if (indexed) lines.push(indexed);
  if (kind === 'selection') lines.push(`${fenceData('我选中的话', selection, language)}\n`, say(language, SELECTION_ONLY));
  lines.push(String(instruction ?? '').trim() ? fenceRequest(instruction, language) : say(language, NO_REQUEST[kind]));
  lines.push(say(language, RULES), say(language, REPORT));
  return lines.join('');
}
