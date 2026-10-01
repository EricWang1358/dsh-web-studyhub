/* Text helpers behind "为你推荐" and the wrong-book page. No imports on purpose:
   the browser bundle uses them too. */

const ENGLISH_STOP = new Set(['what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how', 'the', 'and', 'for', 'are', 'was',
  'were', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'does', 'did', 'following', 'correct', 'incorrect', 'true', 'false',
  'statement', 'statements', 'best', 'not', 'all', 'any', 'can', 'will', 'would', 'should', 'about', 'between', 'there', 'their',
  'answer', 'question', 'choose', 'select', 'option', 'options', 'none', 'both', 'above', 'most', 'least', 'than', 'then', 'each']);
// Question boilerplate that many unrelated prompts share.
const CJK_STOP = new Set(['下列', '哪个', '哪些', '哪项', '哪种', '以下', '关于', '正确', '错误', '说法', '描述', '属于', '是指', '可以', '如何',
  '为什', '什么', '这个', '以及', '下面', '表述', '叙述', '的是', '不是', '是否', '一个', '之一', '最佳', '最好', '主要', '通常', '一般',
  '下述', '包括', '其中', '对于', '应该', '需要', '请问', '选择', '判断', '以上', '都是', '哪一', '一项', '关系', '作用', '特点']);

/** Topic names compare case-, spacing- and punctuation-insensitively; 未分类 is no topic at all. */
export function normalizeTopic(topic) {
  const text = String(topic ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  return text === '未分类' ? '' : text;
}

/** CJK bigrams plus latin words, minus question boilerplate. */
export function promptTokens(text) {
  const out = new Set();
  const value = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const word of value.match(/[a-z][a-z0-9+#.-]{2,}/g) || []) {
    const clean = word.replace(/[.-]+$/, '');
    if (clean.length >= 3 && !ENGLISH_STOP.has(clean)) out.add(clean);
  }
  for (const run of value.match(/\p{Script=Han}+/gu) || [])
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_STOP.has(bigram)) out.add(bigram);
    }
  return out;
}

/** Titles as the learner reads them: the repeated course prefix and "｜90题" counters are noise. */
export function deckShortTitles(titles, course) {
  const unique = [...new Set(titles.map((title) => String(title ?? '')))];
  const split = new Map(unique.map((title) => {
    let parts = title.split(/[｜|]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1 && /^\d+\s*(题|questions?|cards?)$/i.test(parts.at(-1))) parts = parts.slice(0, -1);
    const name = String(course ?? '').trim();
    if (name && parts.length > 1 && parts[0].toLowerCase() === name.toLowerCase()) parts = parts.slice(1);
    else if (name && parts[0].length > name.length && parts[0].toLowerCase().startsWith(name.toLowerCase())) {
      const rest = parts[0].slice(name.length).replace(/^[\s·\-:：—]+/, '');
      if (rest && rest !== parts[0].slice(name.length)) parts[0] = rest;
    }
    return [title, parts];
  }));
  const wordsOf = (title) => title.split(/[｜|]/).map((part) => part.trim()).filter(Boolean);
  if (unique.length > 1) {
    const first = [...split.values()][0][0];
    while ([...split.values()].every((parts) => parts.length > 1 && parts[0] === first))
      for (const [title, parts] of split) split.set(title, parts.slice(1));
  }
  return new Map(unique.map((title) => {
    const parts = split.get(title);
    // A title with nothing to trim keeps its exact text.
    return [title, parts.join('') === wordsOf(title).join('') ? title : parts.join(' · ') || title];
  }));
}
