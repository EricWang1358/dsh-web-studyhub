/* The words of the reader's chapters (reader/chapters.js). Every string is a literal ui()/uiFormat() call so the English catalogue
   (ui/locales/en.reader.json) is checked against it. */
import { ui, uiFormat } from '../../i18n.js';

/** Where a chapter lies: 第 21–37 页 (第 3–9 张 for slides). */
export function chapterRange({ startPage, endPage }, slides = false) {
  if (startPage === endPage) return slides ? uiFormat('第 {0} 张', [startPage]) : uiFormat('第 {0} 页', [startPage]);
  return slides ? uiFormat('第 {0}–{1} 张', [startPage, endPage]) : uiFormat('第 {0}–{1} 页', [startPage, endPage]);
}

/** A chapter's own title: its name, 前言与目录 for the pages before the first chapter, '' for a block of pages (its range says it). */
export const chapterTitle = chapter => chapter.title || (chapter.front ? ui('前言与目录') : '');

/** A chapter in one line: 导论 · 第 21–37 页, or only the range. */
export const chapterName = (chapter, slides = false) => [chapterTitle(chapter), chapterRange(chapter, slides)].filter(Boolean).join(' · ');

export const previousChapterWord = () => ui('上一章');
export const nextChapterWord = () => ui('下一章');
export const chapterPagerLabel = () => ui('上一章与下一章');
export const elsewhereLabel = () => ui('其他章节');
/** "第 3 页 · 2 处": a chapter's first page with a match and how many the chapter has. */
export const elsewhereCount = (page, count, slides = false) => uiFormat('{0} · {1} 处', [slides ? uiFormat('第 {0} 张', [page]) : uiFormat('第 {0} 页', [page]), count]);
