/* The two facts a folded AI block of the review book shows on its one row (docs/review-book.md "AI blocks"): its first real sentence and its size. Pure, no React,
   no DOM. A whole-point block is written in a template (「这段在讲什么 / 1. 小标题 / 原文说：… / 意思就是：… / 资料原文 / 补充（资料以外）」), so its first line is
   never what it says: the template's labels, headings, list numbers and the 关于：「…」 line are skipped, a label with words after it gives its words. */
import { firstSentence, plainLine } from './point-parts.js';

// The labels of the template, Chinese and English (lib/ask-prompt.js), tested on the plain words of a line, so a bold label (**原文说：** …) is one too.
const LABEL = /^(?:这段在讲什么|原文说|意思就是|资料原文|补充[（(]资料以外[）)]|What this passage is about|The source says|In plain words|From the materials|Extra\s*\((?:beyond|outside) the materials\))\s*[:：]?\s*/i;
const ABOUT = /^(?:关于|About)\s*[:：]/;
// A line that is only structure: a heading, a rule, a table or a code fence; a bold line alone; a number or a bullet that has no sentence after it.
const STRUCTURE = /^(?:#{1,6}\s|[-*_]{3,}\s*$|\||```|~~~|<|\$\$)/;
const BOLD_ALONE = /^\*\*[^*]+\*\*\s*[:：]?\s*$/;
const NUMBER = /^\d+\s*[.)、．]\s*/;
const ENDS_A_SENTENCE = /[。！？.!?」”）)]\s*(?:\[\^\d+\])*$/;
const MAX = 120;

/** The first real sentence of an AI block's body as plain words ('' when it has none). */
export function aiSummary(body) {
  for (const raw of String(body ?? '').split('\n')) {
    let line = raw.trim().replace(/<!--.*?-->/g, '').trim();
    if (!line || STRUCTURE.test(line) || BOLD_ALONE.test(line) || ABOUT.test(line)) continue;
    // 「1. 小标题」: a numbered line with no sentence in it is a heading; a numbered sentence says what it says.
    const numbered = NUMBER.test(line);
    line = line.replace(NUMBER, '').replace(/^[-*+]\s+/, '').replace(/^>\s*/, '');
    if (numbered && !ENDS_A_SENTENCE.test(line)) continue;
    // Marks off first, then a label alone is structure and a label with words after it gives the words.
    const plain = plainLine(line).replace(LABEL, '');
    if (plain.length < 2 || ABOUT.test(plain)) continue;
    const sentence = firstSentence(plain)?.text ?? plain;
    return sentence.length > MAX ? `${sentence.slice(0, MAX - 1)}…` : sentence;
  }
  return '';
}

/** The size of an AI block's text for its row: the characters, rounded (to 100 from a thousand, else to 10) so that it reads as the estimate it is. */
export function aiSize(body) {
  const length = String(body ?? '').length;
  return length >= 1000 ? Math.round(length / 100) * 100 : length >= 100 ? Math.round(length / 10) * 10 : length;
}
