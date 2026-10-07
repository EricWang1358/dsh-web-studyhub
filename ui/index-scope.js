import { ui, uiFormat } from './i18n.js';
import { formatNumber } from './format.js';
import { displayTitle } from '../lib/document-title.js';
import { courseScope } from '../lib/course-tree.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';

/* The words that say WHAT a page number counts (the 资料 page used to show 404, 422 and 588 about one book, each right, none saying whose pages it was).
   One document has one count: the pages that have text, which are the pages a reader can open, choose and index. The original file's length is said once,
   beside it. The index badge counts this document; the course line counts the course and names the materials whose pages are not indexed. Pure; the
   components render these strings and put each of them behind a hover. */

/* How many materials the course line names before it says "and N in all", and how long a name may be there. */
const NAMED = 3, NAME_CHARS = 28;
const clip = (text) => { const chars = [...String(text)]; return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS - 1).join('')}…` : chars.join(''); };

/** { readable, original, gap } of a document: pages that have text (the document's pages), pages of the original file when it says (0 = unknown), and the difference. */
export function pageFacts(item) {
  const readable = item?.pages?.length || 0, original = Number(item?.totalPages) || 0;
  return { readable, original, gap: original > readable ? original - readable : 0 };
}

/* Only a paged document with something missing has anything to say. */
const hasGap = (item) => item?.format === 'pdf' && pageFacts(item).readable > 0 && pageFacts(item).gap > 0;

/** “原 PDF 422 页”: beside the document's own page count, when the original file has more pages than the document has with text; else ''. */
export function pageGapNote(item) {
  return hasGap(item) ? uiFormat('原 PDF {0} 页', [formatNumber(pageFacts(item).original)]) : '';
}

/** What the difference is (one sentence, then what follows from it): a converter's output skips pictures and blank pages; a PDF may also have been imported in part. */
export function pageGapHint(item) {
  if (!hasGap(item)) return '';
  const { readable, original, gap } = pageFacts(item), numbers = [formatNumber(readable), formatNumber(original), formatNumber(gap)];
  const cause = item.converted
    ? uiFormat('{0} 页有文字；原 PDF 共 {1} 页，其余 {2} 页是图片或空白页，转换结果里没有文字。', numbers)
    : uiFormat('{0} 页有文字；原 PDF 共 {1} 页，其余 {2} 页没有可读文字（扫描图片或空白页），或导入时没有选中。', numbers);
  return `${cause}\n${uiFormat('所以这份资料只有这 {0} 页能打开、选择和建索引。', [numbers[0]])}`;
}

/** The hover of the 大教材建议 title: why a long book is advised by chapter (the reason, then when the card appears). */
export function adviceTip() {
  return `${ui('整本书一次交给 AI，既花得多又不聚焦；按章节选，或用检索只取相关页面，更省也更准。')}\n${uiFormat('超过 {0} 页的资料才会出现这张建议卡。', [LARGE_DOCUMENT_LIMITS.advisePages])}`;
}

/** The hover of the index badge: [what it means for this document, what it does not count]. */
export function indexTip(info) {
  const { indexed, total, stale } = info || {}, n = (value) => formatNumber(value ?? 0);
  const first = !info ? '' : info.state === 'indexed' ? uiFormat('这份资料的 {0} 页都已编进检索目录：对整本书提问或出题时，只把相关页面发给 AI。', [n(total)])
    : info.state === 'partial' ? uiFormat('这份资料 {1} 页里，{0} 页已编进检索目录，其余还没编。', [n(indexed), n(total)])
      : info.state === 'stale' ? uiFormat('这份资料有 {0} 页在编目录之后改过，目录里还是旧内容。', [n(stale)])
        : info.state === 'building' ? uiFormat('正在编检索目录；这份资料现在已编 {0}/{1} 页。', [n(indexed), n(total)])
          : ui('这份资料还没有检索目录；建好后，对整本书提问或出题时只把相关页面发给 AI。');
  return [first, ui('这里只数这份资料自己的页，不含课程里的其他资料。')];
}

/** The line under the course picker: which course, how many pages and materials it has, and which materials still have pages without an index. */
export function courseScopeLine(plan, course) {
  if (!plan) return '';
  const label = course ? uiFormat('「{0}」这门课', [course]) : ui('全部资料');
  if (!plan.pages) return uiFormat('{0}还没有资料页。', [label]);
  const head = Number.isFinite(plan.documents) ? uiFormat('{0}共 {1} 页（含 {2} 份资料）', [label, formatNumber(plan.pages), formatNumber(plan.documents)])
    : uiFormat('{0}共 {1} 页', [label, formatNumber(plan.pages)]);
  if (plan.toIndex === 0 && !plan.toRemove) return `${head}${ui('，索引已是最新。')}`;
  if (plan.toIndex === 0) return `${head}${uiFormat('；有 {0} 页的旧索引要清理。', [formatNumber(plan.toRemove)])}`;
  const shown = (plan.missing || []).slice(0, NAMED);
  const names = shown.map((entry) => uiFormat('《{0}》（{1} 页）', [clip(displayTitle(entry.title)), formatNumber(entry.pages)])).join(ui('、'));
  const more = plan.missingDocuments > shown.length ? uiFormat('等 {0} 份', [plan.missingDocuments]) : '';
  return `${head}${uiFormat('：其中 {0} 页还没建索引', [formatNumber(plan.toIndex)])}${names ? `${uiFormat('，来自{0}', [`${names}${more}`])}` : ''}${uiFormat('；{0} 页已经建好。', [formatNumber(plan.unchanged)])}`;
}

/**
 * Whose pages a build of `course` would add, seen from one document ({ info, courses }: its index state and its courses; `names`: the library's course names):
 * 'own' (this document has pages without an index), 'others' (it is complete, the missing pages are other materials'), 'other-course' (the chosen
 * course does not hold this document), or null (no document, or its index state is not known yet).
 */
export function indexTarget(document, course, names = []) {
  if (!document?.info) return null;
  const inside = !course || (document.courses || []).some(courseScope(course, names));
  if (!inside) return 'other-course';
  return document.info.state === 'indexed' ? 'others' : 'own';
}

/** The build button for a course: { label, variant, note }. It is the loud one only when the document it sits under is the one with missing pages. */
export function indexAction({ plan, document, course, names }) {
  const generic = { label: ui('为这门课建立检索索引'), variant: 'primary', note: '' };
  if (!plan || indexTarget(document, course, names) !== 'others') return generic;
  if (!plan.toIndex) return { ...generic, variant: 'secondary' };
  return { label: uiFormat('为这门课补建 {0} 页索引', [formatNumber(plan.toIndex)]), variant: 'secondary',
    note: uiFormat('这份资料自己的 {0} 页已经全部建好；还没建的是这门课里其他资料的页。', [formatNumber(document.info.total)]) };
}
