/* Localized strings and CJK text patterns for exam-scope slicing (lib/contexts/generation/book/exam-scope-*.js). */

export const ZH_STOPWORDS = [
  '考试', '期末', '期中', '范围', '重点', '考点', '复习', '大纲', '提纲', '说明',
  '章节', '内容', '概述', '导论', '简介', '总结', '基础',
];

export const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export const ZH_NUM_RE = /^[零〇一二两三四五六七八九十百]+$/;
export const ZH_HUNDRED = '百';
export const ZH_TEN = '十';

export const CHAPTER_LIST_SEP_RE = /(?:,|，|、|\band\b|&|和|及|与)+/i;
export const CHAPTER_RANGE_RE = /^([0-9ivx零〇一二两三四五六七八九十百]+)\s*[-–—~到至]\s*([0-9ivx零〇一二两三四五六七八九十百]+)$/i;
const ZH_NUM_SEQ = '[0-9零〇一二两三四五六七八九十百]+';
const ZH_NUM_SPAN = `${ZH_NUM_SEQ}(?:\\s*[-–—~到至]\\s*${ZH_NUM_SEQ})?`;
const ZH_NUM_LIST = `${ZH_NUM_SPAN}(?:\\s*[、,，和及与]\\s*${ZH_NUM_SPAN})*`;
export const ZH_CH_REF = new RegExp(`第\\s*(${ZH_NUM_LIST})\\s*[章讲节]`, 'g');
export const ZH_TITLE_CH_RE = new RegExp(`^第\\s*(${ZH_NUM_SEQ})\\s*[章讲节]`);
export const ZH_PREFIX_CH_RE = new RegExp(`^第\\s*${ZH_NUM_LIST}\\s*[章讲节]\\s*[:：\\-—,，、]?\\s*`);
export const ZH_SCOPE_HEAD_RE = /^(?:期末|期中|考试|复习)?(?:范围|重点|内容)\s*[:：\-—]\s*/iu;
export const ZH_CUE_HEAD_RE = /^(?:重点(?:考|考查|考察)?|主要(?:考|考查|考察)?|必考|考查|考察|focus(?:es)?\s+on|covering|covers|emphasis\s+on|including)\s*[:：\-—]?\s*/iu;
export const ZH_ONLY_HEAD_RE = /^(?:期末|期中|考试|复习)?(?:范围|重点|内容|考|covers?|covering|exam\s*scope|midterm|final|only)\s*[:：\-—]?\s*/gi;
export const GUIDANCE_BULLET_RE = /^(?:[-*•·▪▸▶►✓✔☆★]+|\(?\d{1,3}[.)、．]|\([一二三四五六七八九十]+\)|[一二三四五六七八九十]+[、．.]|[①-⑳])\s+/u;

export const formatChapterRefLabel = (num, zh) => (zh ? `第 ${num} 章` : `Chapter ${num}`);

export function formatCoverageNote({ matchedCount, totalChapters, unmatchedCount, topicCount, refCount, language }) {
  const en = language === 'en';
  if (!topicCount && !refCount) {
    return en
      ? 'No exam scope topics or notes are set yet; add focus topics or select chapters manually.'
      : '还没有设置考试范围主题或说明，请先录入重点知识点或手动勾选章节。';
  }
  if (!matchedCount) {
    return en
      ? `No chapters matched automatically (0 of ${totalChapters}); ${unmatchedCount} topic(s) need manual chapter selection.`
      : `未自动匹配到章节（0 / ${totalChapters} 章）；有 ${unmatchedCount} 个主题未匹配，请手动勾选对应章节。`;
  }
  if (unmatchedCount > 0) {
    return en
      ? `Matched ${matchedCount} of ${totalChapters} chapters; ${unmatchedCount} topic(s) did not match any chapter—review and select manually if needed.`
      : `匹配到 ${matchedCount} / ${totalChapters} 章；有 ${unmatchedCount} 个主题未匹配到章节，请核对并手动勾选。`;
  }
  return en
    ? `Matched ${matchedCount} of ${totalChapters} chapters; all exam scope topics were covered.`
    : `匹配到 ${matchedCount} / ${totalChapters} 章，所有考试范围主题均已匹配。`;
}
