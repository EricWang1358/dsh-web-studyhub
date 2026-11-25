/* 0-token active book asset compiler (StudyHub 5.0.0 · Evolution 2 Items #1 & #2):
   1. `compileConfusablesToLesson(pairs, opts)`: compiles >=1 `C001` confusable pair (`confusablesView`) into a
      valid 4–6 slide `studyhub-lesson/1` `dialectic` lesson (`matrix` with `predictBeforeReveal: true` + `quiz`
      boundary discrimination + `hid` anchor), passing `validate.js` and offline 0-external-link HTML compile.
   2. `parseTemplateSlots(template)` & `maskTemplateSlots(template, opts)`: KaTeX- and Markdown-safe `[slot]`
      parser/masker for `T01` exam answer kit templates. Pure, zero I/O, zero model calls, browser-safe. */

const MAX_LAB_PAIRS = 3;
const CJK_RE = /[\u4e00-\u9fff]/;
const SLOT_MAX = 80;
const ASPECT_ORDER = ['what', 'when', 'difference', 'mistake'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
function fnv1aShort(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
const slug = value => {
  const raw = clean(value);
  const base = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || (raw ? `lab-${fnv1aShort(raw)}` : 'confusables-lab');
};

function normalizePairs(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const names = Array.isArray(item.names) ? item.names.map(clean).filter(Boolean) : [];
    const rows = Array.isArray(item.rows) ? item.rows
      .filter(r => r && typeof r.aspect === 'string' && Array.isArray(r.cells) && r.cells.length >= 2)
      .map(r => ({ aspect: r.aspect, cells: [clean(r.cells[0]), clean(r.cells[1])] }))
      .filter(r => r.cells[0] && r.cells[1]) : [];
    if (names.length < 2 || !rows.length) continue;
    out.push({
      id: clean(item.id) || `C${String(out.length + 1).padStart(3, '0')}`,
      items: Array.isArray(item.items) ? item.items.map(clean).filter(Boolean) : [],
      names: [names[0], names[1]],
      hids: Array.isArray(item.hids) ? item.hids.map(clean).filter(Boolean) : [],
      rows,
    });
    if (out.length >= MAX_LAB_PAIRS) break;
  }
  return out;
}

const rowOf = (pair, aspect) => pair.rows.find(r => r.aspect === aspect) ?? null;
const firstRow = pair => rowOf(pair, 'when') || rowOf(pair, 'difference') || rowOf(pair, 'what') || pair.rows[0];
const aspectTitle = (aspect, en) => (en
  ? ({ what: 'Core definition', when: 'When to use', difference: 'Key difference', mistake: 'Common trap' }[aspect] || aspect)
  : ({ what: '是什么', when: '什么时候用', difference: '关键区别', mistake: '常见误区' }[aspect] || aspect));
const aspectPrompt = (aspect, names, en) => (en
  ? ({
      what: `Before revealing, state the core definition of **${names[0]}** vs **${names[1]}**.`,
      when: `Which scenario calls for **${names[0]}** and which calls for **${names[1]}**?`,
      difference: `What is the sharpest boundary separating **${names[0]}** from **${names[1]}**?`,
      mistake: `Which trap do learners most often fall into with **${names[0]}** and **${names[1]}**?`,
    }[aspect] || `Compare **${names[0]}** and **${names[1]}**.`)
  : ({
      what: `揭晓前先想想：**${names[0]}** 与 **${names[1]}** 各自的核心定义是什么？`,
      when: `什么场景该用 **${names[0]}**，什么场景该用 **${names[1]}**？`,
      difference: `区分 **${names[0]}** 与 **${names[1]}** 最关键的分界线是什么？`,
      mistake: `面对 **${names[0]}** 与 **${names[1]}**，最容易踩中哪两个误区？`,
    }[aspect] || `对比 **${names[0]}** 与 **${names[1]}**。`));

function buildMatrixBlock(pair, en) {
  const ordered = ASPECT_ORDER.map(aspect => rowOf(pair, aspect)).filter(Boolean);
  const rows = ordered.length ? ordered : pair.rows;
  return {
    t: 'matrix',
    predictBeforeReveal: true,
    frameworks: [{ id: 'a', name: pair.names[0] }, { id: 'b', name: pair.names[1] }],
    scenarios: rows.map(row => ({
      id: `${slug(pair.id)}-${row.aspect}`,
      title: aspectTitle(row.aspect, en),
      prompt: aspectPrompt(row.aspect, pair.names, en),
      cells: [
        { badge: pair.items[0] || pair.names[0], verdict: row.cells[0], why: row.aspect === 'mistake' ? (en ? 'Watch out for this confusion.' : '注意避开这个常见混淆。') : (en ? `Applies to ${pair.names[0]}.` : `属于「${pair.names[0]}」的判断线索。`), tone: row.aspect === 'mistake' ? 'warning' : 'success' },
        { badge: pair.items[1] || pair.names[1], verdict: row.cells[1], why: row.aspect === 'mistake' ? (en ? 'Watch out for this confusion.' : '注意避开这个常见混淆。') : (en ? `Applies to ${pair.names[1]}.` : `属于「${pair.names[1]}」的判断线索。`), tone: row.aspect === 'mistake' ? 'warning' : 'success' },
      ],
    })),
  };
}

function buildQuizBlock(pair, en, side = 0) {
  const cueRow = rowOf(pair, 'when') || rowOf(pair, 'difference') || rowOf(pair, 'what') || pair.rows[0];
  const other = side === 0 ? 1 : 0;
  const targetName = pair.names[side], distractorName = pair.names[other];
  const targetCue = cueRow.cells[side], distractorCue = cueRow.cells[other];
  const q = en
    ? `Which concept matches this boundary cue: "${targetCue}"?`
    : `下面哪一个概念对应这一边界线索：「${targetCue}」？`;
  return {
    t: 'quiz',
    q,
    options: [
      { text: targetName, ok: true, why: en ? `Correct — ${targetName}: ${targetCue}` : `正确——${targetName}：${targetCue}` },
      { text: distractorName, ok: false, why: en ? `Not ${distractorName}: ${distractorName} is characterized by "${distractorCue}".` : `不是 ${distractorName}：${distractorName} 的特征是「${distractorCue}」。` },
    ],
  };
}

/**
 * Compile >=1 valid `confusablesView` C001 pair into a 4–6 slide `studyhub-lesson/1` dialectic lesson JSON.
 * 0 model calls, offline-safe, passes `lib/companion-template/validate.js` and `compileLessonHtml()`.
 */
export function compileConfusablesToLesson(rawPairs, { course = '', hid = '', language = '', title = '' } = {}) {
  const pairs = normalizePairs(rawPairs);
  if (!pairs.length) throw new Error('compileConfusablesToLesson requires at least one valid confusable pair');
  const sampleText = pairs.map(p => `${p.names.join(' ')} ${p.rows.map(r => r.cells.join(' ')).join(' ')}`).join(' ');
  const lang = language === 'en' || language === 'zh' ? language : (CJK_RE.test(sampleText) ? 'zh' : 'en');
  const en = lang === 'en';
  const primary = pairs[0];
  const resolvedHid = clean(hid) || primary.hids[0] || '';
  const defaultTitle = pairs.length === 1
    ? (en ? `Contrast Lab: ${primary.names[0]} vs ${primary.names[1]}` : `辩证对比实验：${primary.names[0]} vs ${primary.names[1]}`)
    : (en ? `Contrast Lab: ${pairs.map(p => p.id).join(', ')} (${primary.names[0]} vs ${primary.names[1]})` : `辩证对比实验：${pairs.map(p => p.id).join(' · ')}（${primary.names[0]} 等）`);
  const lessonTitle = clean(title) || defaultTitle;
  const lessonCourse = clean(course) || (en ? 'Review Book' : '复习全书');
  const leadCue = firstRow(primary);

  const slide1 = {
    beat: 'predict',
    title: en ? `First hunch: ${primary.names[0]} or ${primary.names[1]}?` : `先猜一猜：${primary.names[0]} 还是 ${primary.names[1]}？`,
    blocks: [
      { t: 'text', md: en
        ? `Exam questions often swap **${primary.names[0]}** and **${primary.names[1]}**. Make a prediction before revealing the contrast matrix.`
        : `考题常把 **${primary.names[0]}** 与 **${primary.names[1]}** 放在一起混淆。先做一次直觉判断，再揭晓对照矩阵。` },
      {
        t: 'predict',
        id: 'pred-1',
        q: en ? `Which concept fits this description: "${leadCue.cells[0]}"?` : `哪一个概念符合这条线索：「${leadCue.cells[0]}」？`,
        options: [primary.names[0], primary.names[1]],
        answer: 0,
      },
    ],
  };

  const slide2 = {
    beat: 'why',
    title: en ? `Dialectic matrix: ${primary.names[0]} vs ${primary.names[1]}` : `辩证对照矩阵：${primary.names[0]} vs ${primary.names[1]}`,
    blocks: [
      { t: 'reveal', of: 'pred-1', md: en
        ? `**${primary.names[0]}** matches that cue (${leadCue.cells[0]}), whereas **${primary.names[1]}** is: ${leadCue.cells[1]}.`
        : `对应的是 **${primary.names[0]}**（${leadCue.cells[0]}）；而 **${primary.names[1]}** 则是：${leadCue.cells[1]}。` },
      buildMatrixBlock(primary, en),
    ],
  };

  const extraSlides = pairs.slice(1).map(pair => ({
    beat: 'why',
    title: en ? `Dialectic matrix: ${pair.names[0]} vs ${pair.names[1]}` : `辩证对照矩阵：${pair.names[0]} vs ${pair.names[1]}`,
    blocks: [buildMatrixBlock(pair, en)],
  }));

  const trapLines = pairs.flatMap(pair => {
    const m = rowOf(pair, 'mistake') || rowOf(pair, 'difference') || pair.rows[0];
    return [`- **${pair.names[0]}**: ${m.cells[0]}`, `- **${pair.names[1]}**: ${m.cells[1]}`];
  });
  const diffRow = rowOf(primary, 'difference') || rowOf(primary, 'what') || primary.rows[0];
  const slideTrap = {
    beat: 'fix',
    title: en ? 'Traps & oral boundary check' : '易踩误区与开口辨析',
    blocks: [
      { t: 'callout', tone: 'warning', title: en ? 'Watch out for these traps' : '最容易踩中的误区', md: trapLines.join('\n') },
      {
        t: 'say',
        prompt: en
          ? `Explain in one sentence how to tell **${primary.names[0]}** and **${primary.names[1]}** apart without looking at the table.`
          : `不看表格，用一句话讲清楚 **${primary.names[0]}** 和 **${primary.names[1]}** 的根本区别。`,
        points: [
          `${primary.names[0]}: ${diffRow.cells[0]}`,
          `${primary.names[1]}: ${diffRow.cells[1]}`,
        ],
        model: en
          ? `${primary.names[0]} focuses on ${diffRow.cells[0]}, while ${primary.names[1]} focuses on ${diffRow.cells[1]}.`
          : `${primary.names[0]} 的关键在于「${diffRow.cells[0]}」，而 ${primary.names[1]} 的关键在于「${diffRow.cells[1]}」。`,
      },
    ],
  };

  const quizzes = pairs.length === 1
    ? [buildQuizBlock(primary, en, 0), buildQuizBlock(primary, en, 1)]
    : pairs.map((pair, idx) => buildQuizBlock(pair, en, idx % 2));
  const cardItems = pairs.flatMap(pair => {
    const d = rowOf(pair, 'difference') || rowOf(pair, 'what') || pair.rows[0];
    return [
      { q: en ? `When distinguishing ${pair.names[0]} vs ${pair.names[1]}, what defines ${pair.names[0]}?` : `辨析 ${pair.names[0]} 与 ${pair.names[1]} 时，${pair.names[0]} 的关键是什么？`, a: d.cells[0] },
      { q: en ? `When distinguishing ${pair.names[0]} vs ${pair.names[1]}, what defines ${pair.names[1]}?` : `辨析 ${pair.names[0]} 与 ${pair.names[1]} 时，${pair.names[1]} 的关键是什么？`, a: d.cells[1] },
    ];
  });
  const slideCheck = {
    beat: 'check',
    title: en ? 'Boundary discrimination check' : '边界辨析小测',
    blocks: [...quizzes, { t: 'cards', items: cardItems }],
  };

  const terms = {};
  for (const pair of pairs) {
    const what = rowOf(pair, 'what') || pair.rows[0];
    terms[pair.names[0]] = what.cells[0];
    terms[pair.names[1]] = what.cells[1];
  }

  return {
    format: 'studyhub-lesson/1',
    template: 'dialectic',
    id: `${slug(primary.id)}-${slug(primary.names[0])}-vs-${slug(primary.names[1])}`,
    title: lessonTitle,
    course: lessonCourse,
    language: lang,
    minutes: 4 + extraSlides.length,
    ...(resolvedHid ? { hid: resolvedHid } : {}),
    terms,
    slides: [slide1, slide2, ...extraSlides, slideTrap, slideCheck],
  };
}

/** Find protected KaTeX math / Markdown code spans where `[...]` must never be parsed as a T01 slot. */
function protectedRanges(text) {
  const ranges = [];
  const patterns = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]+`/g, /\$\$[\s\S]*?\$\$/g, /\\\[[\s\S]*?\\\]/g, /\\\([\s\S]*?\\\)/g, /(?<!\\)\$(?!\$)(?:\\.|[^$\\\n])+\$/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

const insideRanges = (ranges, start, end) => ranges.some(([a, b]) => start < b && end > a);

/**
 * KaTeX- and Markdown-safe `[slot]` parser for `T01` answer kit templates.
 * Leaves math (`$...$`, `$$...$$`, `\[...\]`, `\(...\)`), code spans, footnotes (`[^1]`), and Markdown links/images untouched.
 * -> `Array<{ text: string, slot?: true, label?: string, index?: number }>`
 */
export function parseTemplateSlots(template) {
  const text = String(template ?? ''), parts = [];
  if (!text) return parts;
  const blocked = protectedRanges(text);
  const slotRe = new RegExp(`\\[([^\\]\\[\\n]{1,${SLOT_MAX}})\\]`, 'g');
  let cursor = 0, slotIdx = 0;
  for (const m of text.matchAll(slotRe)) {
    const start = m.index, end = start + m[0].length, inner = m[1];
    if (insideRanges(blocked, start, end)) continue;
    if (inner.startsWith('^')) continue; // Markdown footnote [^1]
    if (start > 0 && text[start - 1] === '!') continue; // Markdown image ![alt](url)
    if (text[end] === '(' || text[end] === '[') continue; // Markdown link [text](url) / [text][ref]
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: m[0], slot: true, label: inner.trim(), index: slotIdx++ });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Mask unrevealed `[slot]` items in a T01 template while preserving KaTeX formulas, Markdown syntax, and triggers. */
export function maskTemplateSlots(template, { revealed = new Set(), placeholder = '___' } = {}) {
  const parts = parseTemplateSlots(template);
  let slotCount = 0;
  const maskedText = parts.map(part => {
    if (!part.slot) return part.text;
    slotCount += 1;
    return revealed.has(part.index) ? part.text : placeholder;
  }).join('');
  return { parts, slotCount, maskedText };
}
