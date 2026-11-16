import { ui, uiFormat } from '../i18n.js';
import { stripTermMarkers } from '../term-marker.js';

export const staleTagText = () => ui('[待核对原句]');

export function markStyleLabel(style) {
  if (style === 'highlight') return ui('荧光笔');
  if (style === 'bold') return ui('加粗');
  if (style === 'queue') return ui('待出题');
  return ui('划线');
}

const cleanQuote = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
const cleanAnswer = value => {
  if (Array.isArray(value)) return stripTermMarkers(value.join(ui('、'))).trim();
  return stripTermMarkers(String(value ?? '')).trim();
};

function formatPageHeading(page, slides = false) {
  return Number.isInteger(page) && page > 0
    ? uiFormat(slides ? '第 {0} 张' : '第 {0} 页', [page])
    : '';
}

function resolveChapter(chapters, sourceId, page) {
  if (!Array.isArray(chapters) || !chapters.length) return null;
  if (sourceId) {
    const bySource = chapters.findIndex(ch => Array.isArray(ch.sourceIds) && ch.sourceIds.includes(sourceId));
    if (bySource >= 0) return { index: bySource, chapter: chapters[bySource] };
  }
  if (Number.isInteger(page) && page > 0) {
    const byPage = chapters.findIndex(ch => Number.isInteger(ch.startPage) && Number.isInteger(ch.endPage) && page >= ch.startPage && page <= ch.endPage);
    if (byPage >= 0) return { index: byPage, chapter: chapters[byPage] };
  }
  return null;
}

function buildHeading({ chapter, page, sourceTitle, multiSource, stale, placed, slides }) {
  const pageText = formatPageHeading(page, slides);
  const chapterTitle = typeof chapter?.title === 'string' ? chapter.title.trim() : '';
  if (!placed && stale) {
    return pageText ? `${pageText} · ${ui('旧版待核对')}` : ui('旧版待核对');
  }
  if (chapterTitle && pageText) return `${chapterTitle} · ${pageText}`;
  if (chapterTitle) return chapterTitle;
  if (pageText) return pageText;
  if (multiSource && sourceTitle) return sourceTitle;
  return ui('正文摘录');
}

function groupAnnotationThreads(annotations = []) {
  const byKey = new Map();
  for (const item of annotations || []) {
    if (!item) continue;
    const key = item.key || item.id || item.selection?.quote || item.quote || '';
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  return [...byKey.values()].map(nodes => {
    const root = nodes.find(node => (node.parentId ?? null) === null) || nodes[0];
    const children = nodes.filter(node => node !== root);
    const stale = nodes.every(node => node.status === 'stale' || node.stale === true);
    return {
      id: `annotation:${root.id || root.key}`,
      annotationKey: root.key,
      kind: 'annotation',
      explain: root.kind === 'explain',
      quote: cleanQuote(root.selection?.quote ?? root.quote),
      question: String(root.label || root.question || '').trim(),
      note: String(root.note || '').trim(),
      answer: cleanAnswer(root.answer ?? root.qa?.answer),
      followups: children.map(child => ({
        id: child.id,
        question: String(child.term || child.label || child.question || '').trim(),
        answer: cleanAnswer(child.answer),
      })).filter(item => item.question || item.answer),
      stale,
      selection: root.selection || (root.sourceId ? { sourceId: root.sourceId, start: root.start, end: root.end, quote: root.quote, page: root.page } : null),
      page: root.selection?.page ?? root.page,
    };
  });
}

function normalizeStaleAnnotationEntries(staleAnnotations = []) {
  const out = [];
  for (const entry of staleAnnotations || []) {
    if (!entry) continue;
    if (Array.isArray(entry.threads)) {
      for (const thread of entry.threads) {
        out.push({
          id: `stale-annotation:${entry.revision || 'old'}:${thread.key || thread.quote}`,
          kind: 'annotation',
          quote: cleanQuote(thread.quote || thread.selection?.quote),
          question: String(thread.question || thread.qa?.question || '').trim(),
          note: String(thread.note || '').trim(),
          answer: cleanAnswer(thread.answer ?? thread.qa?.answer),
          followups: [],
          stale: true,
          selection: thread.selection || null,
          page: thread.page ?? thread.selection?.page,
        });
      }
    } else if (entry.quote || entry.selection?.quote || entry.question || entry.note || entry.answer || entry.qa) {
      out.push({
        id: `stale-annotation:${entry.id || entry.key || entry.quote}`,
        kind: 'annotation',
        quote: cleanQuote(entry.quote || entry.selection?.quote),
        question: String(entry.question || entry.qa?.question || '').trim(),
        note: String(entry.note || '').trim(),
        answer: cleanAnswer(entry.answer ?? entry.qa?.answer),
        followups: [],
        stale: true,
        selection: entry.selection || null,
        page: entry.page ?? entry.selection?.page,
      });
    }
  }
  return out;
}

/**
 * Collect and order all reader marks, annotations, Q&A links, and stale items for a document by chapter/page and offset.
 */
export function collectMarksSummary({
  title = '',
  sources = [],
  chapters = [],
  marks = [],
  staleMarks = [],
  annotations = [],
  staleAnnotations = [],
  links = [],
  slides = false,
} = {}) {
  const sourceOrder = new Map();
  const sourceById = new Map();
  (sources || []).forEach((source, index) => {
    if (!source?.id) return;
    if (!sourceOrder.has(source.id)) sourceOrder.set(source.id, index);
    sourceById.set(source.id, source);
  });
  const multiSource = sourceById.size > 1;
  const rawEntries = [];
  let seq = 0;

  const placeEntry = item => {
    const sel = item.selection || null;
    const sourceId = sel?.sourceId || item.sourceId || '';
    const source = sourceId ? sourceById.get(sourceId) : null;
    const placed = !!source && !item.stale;
    const rawPage = sel?.page ?? item.page ?? source?.document?.page;
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;
    const foundChapter = resolveChapter(chapters, placed ? sourceId : '', page);
    const chapter = foundChapter?.chapter || (source?.document?.chapter?.title ? source.document.chapter : null);
    const chapterIdx = foundChapter ? foundChapter.index : (placed ? 9999 : 99999);
    const sourceIdx = placed ? (sourceOrder.get(sourceId) ?? 9999) : 99999;
    const start = Number.isInteger(sel?.start) ? sel.start : Number.MAX_SAFE_INTEGER;
    const heading = buildHeading({
      chapter,
      page,
      sourceTitle: source?.title || '',
      multiSource,
      stale: !!item.stale,
      placed,
      slides,
    });
    return {
      ...item,
      sourceId: placed ? sourceId : (sourceId || ''),
      placed,
      page,
      start,
      heading,
      _order: [placed ? 0 : 1, chapterIdx, sourceIdx, page ?? 99999, start, seq++],
    };
  };

  for (const mark of marks || []) {
    if (!mark) continue;
    const quote = cleanQuote(mark.selection?.quote ?? mark.quote);
    if (!quote) continue;
    const isStale = mark.status === 'stale' || mark.stale === true;
    rawEntries.push(placeEntry({
      id: `mark:${mark.id || mark.key || quote}`,
      kind: 'mark',
      style: mark.style || 'highlight',
      styleLabel: markStyleLabel(mark.style),
      quote,
      question: '',
      note: String(mark.note || '').trim(),
      answer: '',
      followups: [],
      stale: isStale,
      selection: mark.selection || null,
      page: mark.page ?? mark.selection?.page,
    }));
  }

  for (const staleMark of staleMarks || []) {
    if (!staleMark) continue;
    const quote = cleanQuote(staleMark.quote ?? staleMark.selection?.quote);
    if (!quote) continue;
    const id = `mark:${staleMark.id || staleMark.key || quote}`;
    if (rawEntries.some(existing => existing.id === id)) continue;
    rawEntries.push(placeEntry({
      id,
      kind: 'mark',
      style: staleMark.style || 'highlight',
      styleLabel: markStyleLabel(staleMark.style),
      quote,
      question: '',
      note: String(staleMark.note || '').trim(),
      answer: '',
      followups: [],
      stale: true,
      selection: staleMark.selection || null,
      page: staleMark.page ?? staleMark.selection?.page,
    }));
  }

  for (const thread of groupAnnotationThreads(annotations)) {
    if (!thread.quote && !thread.question && !thread.answer && !thread.note) continue;
    rawEntries.push(placeEntry(thread));
  }

  for (const staleThread of normalizeStaleAnnotationEntries(staleAnnotations)) {
    if (!staleThread.quote && !staleThread.question && !staleThread.answer && !staleThread.note) continue;
    rawEntries.push(placeEntry(staleThread));
  }

  for (const link of links || []) {
    if (!link || link.kind === 'annotation') continue;
    if (!link.sourceQa && link.kind !== 'note') continue;
    const quote = cleanQuote(link.selection?.quote ?? link.quote);
    const prompt = String(link.prompt || link.title || '').replace(/^(?:>[^\n]*\n?)+\s*/, '').trim();
    const answer = cleanAnswer(link.answer || link.explanation);
    if (!quote && !prompt && !answer) continue;
    const isStale = link.status !== 'resolved' || link.stale === true;
    rawEntries.push(placeEntry({
      id: `link:${link.deckId || ''}:${link.cardId || link.noteId || prompt}`,
      kind: link.kind === 'note' ? 'note' : 'qa',
      quote,
      question: link.kind === 'note' ? '' : prompt,
      note: link.kind === 'note' ? prompt : '',
      answer,
      followups: (link.followups || []).map(item => ({
        id: item.id,
        question: String(item.question || '').trim(),
        answer: cleanAnswer(item.answer),
      })).filter(item => item.question || item.answer),
      stale: isStale,
      selection: link.selection || null,
      page: link.selection?.page ?? link.page,
    }));
  }

  rawEntries.sort((a, b) => {
    for (let i = 0; i < a._order.length; i++) {
      if (a._order[i] !== b._order[i]) return a._order[i] - b._order[i];
    }
    return 0;
  });

  const entries = rawEntries.map(({ _order, ...entry }) => entry);
  const sections = [];
  const byHeading = new Map();
  for (const entry of entries) {
    let section = byHeading.get(entry.heading);
    if (!section) {
      section = { heading: entry.heading, entries: [] };
      byHeading.set(entry.heading, section);
      sections.push(section);
    }
    section.entries.push(entry);
  }
  return {
    title: String(title || '').trim() || ui('资料批注与划线'),
    entries,
    sections,
    total: entries.length,
    staleCount: entries.filter(entry => entry.stale).length,
  };
}

function formatBlockquote(quote, stale) {
  const tag = stale ? ` ${staleTagText()}` : '';
  const text = cleanQuote(quote);
  if (!text) return stale ? `> ${staleTagText()}` : '';
  const lines = text.split('\n');
  return lines.map((line, index) => `> ${line}${index === lines.length - 1 ? tag : ''}`).join('\n');
}

/**
 * Format a document's marks, notes, and Q&A summary as clean Markdown.
 * Accepts either `collectMarksSummary(...)` output or raw summary input options.
 */
export function formatMarksMarkdown(input = {}) {
  const summary = Array.isArray(input?.sections) ? input : collectMarksSummary(input);
  const docTitle = String(summary.title || input.title || '').trim() || ui('资料批注与划线');
  const blocks = [`# ${docTitle}`];
  if (!summary.sections?.length) {
    blocks.push(ui('暂无划线或批注。'));
    return `${blocks.join('\n\n')}\n`;
  }
  for (const section of summary.sections) {
    blocks.push(`## ${section.heading}`);
    for (const entry of section.entries) {
      const itemLines = [];
      const quoteBlock = formatBlockquote(entry.quote, entry.stale);
      if (quoteBlock) itemLines.push(quoteBlock);
      const bullets = [];
      if (entry.kind === 'mark') {
        const label = `${entry.styleLabel || markStyleLabel(entry.style)}${entry.stale ? ` ${staleTagText()}` : ''}`;
        bullets.push(uiFormat('- **标记**：{0}', [label]));
      } else if (entry.stale) {
        bullets.push(uiFormat('- **核对状态**：{0}', [staleTagText()]));
      }
      if (entry.note) bullets.push(uiFormat('- **笔记**：{0}', [entry.note]));
      if (entry.question) bullets.push(uiFormat('- **提问**：{0}', [entry.question]));
      if (entry.answer) bullets.push(uiFormat('- **回答**：{0}', [entry.answer]));
      for (const followup of entry.followups || []) {
        bullets.push(followup.question
          ? uiFormat('- **追问**（{0}）：{1}', [followup.question, followup.answer])
          : uiFormat('- **追问**：{0}', [followup.answer]));
      }
      if (bullets.length) itemLines.push(bullets.join('\n'));
      blocks.push(itemLines.join('\n\n'));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

export function marksExportFilename(title = '') {
  const cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const base = cleaned || 'document';
  return `${base}-${ui('批注与划线')}.md`;
}
