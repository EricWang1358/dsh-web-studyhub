import { createHash } from 'node:crypto';
import { assertMaterials } from '../../../exam-point-list.js';
import { currentCourse } from '../../../focus.js';
import { ARCHETYPES, MOUNT_MODES } from './contracts.js';
import { blueprintPrompt, act1Prompt, act2Prompt } from './prompts.js';

export const MAX_SOURCE_BUDGET_CHARS = 32000;

const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'over', 'under',
  'what', 'when', 'where', 'which', 'while', 'how', 'why', 'who', 'whom', 'whose',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'about',
  'through', 'between', 'interactive', 'companion', 'lesson', 'build', 'explain',
  'understand', 'study', 'course', 'chapter', 'section', 'lecture', 'notes',
]);

const HEADING_RE = /^(?:#{1,6}\s+\S+|(?:Chapter|Section|Lecture|Part|Unit|Appendix)\s+[\dIVXLC]+|第[一二三四五六七八九十百零\d]+[章节讲部分篇单元]\b|\d+(?:\.\d+){1,3}\s+\S+)/i;
const DEFINITION_EN_RE = /(?:^|\b)(?:Definition|Theorem|Lemma|Proposition|Corollary|Proof|Axiom|Postulate|Principle|Law|Criterion|Condition|Counterexample|Pitfall|Warning|Remark|Example|Case|Invariant|Equilibrium|Necessary|Sufficient)(?:\b|\s*\d)/i;
const DEFINITION_ZH_RE = /(?:定义|定理|引理|命题|推论|证明|公理|原理|定律|判据|准则|充要条件|必要条件|充分条件|反例|误区|陷阱|易错|注意|例题|案例|公式|方程|不变量|临界|死点|平衡态)/;
const FORMULA_OR_CODE_RE = /(?:\$\$[\s\S]+?\$\$|(?<!\$)\$(?!\$)[^\n$]{2,}(?<!\$)\$(?!\$)|\\(?:frac|sum|int|oint|lim|sqrt|begin\{|implies|iff|vdash|models|equiv)|```|[=≈≠≤≥→⇔]\s*[-+A-Za-z0-9\\(])/;
const BOILERPLATE_RE = /(?:\.{6,}\s*\d+\s*$|^(?:Copyright|All rights reserved|ISBN\b|Page\s+\d+\s+of\s+\d+)$)/im;

/** Extract meaningful English and CJK search keywords from topic + course strings. */
export function extractTopicKeywords(topic = '', course = '') {
  const combined = `${topic || ''} ${course || ''}`.trim();
  if (!combined) return [];
  const out = new Set();

  for (const match of combined.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/g)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    if (EN_STOPWORDS.has(lower)) continue;
    const isAcronymOrTech = raw.length >= 2 && (/[A-Z]{2,}/.test(raw) || /\d/.test(raw));
    if (lower.length >= 3 || isAcronymOrTech) out.add(lower);
  }

  for (const match of combined.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const parts = match[0]
      .split(/[的了与和及在中对把被向从以按用是怎么什么如何为什么成因原理概念基础导论分析讲解问题方法比较区别作用特性课]+/g)
      .filter(seg => seg.length >= 2);
    for (const seg of parts.length ? parts : [match[0]]) {
      if (seg.length <= 8) out.add(seg);
      if (seg.length >= 4) {
        for (let i = 0; i <= seg.length - 2; i++) out.add(seg.slice(i, i + 2));
      }
    }
  }

  return [...out].slice(0, 32);
}

function splitIntoChunks(normalizedText) {
  const rawParas = normalizedText.split(/\n\s*\n+/);
  const chunks = [];
  for (const para of rawParas) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 900) {
      chunks.push(trimmed);
      continue;
    }
    const lines = trimmed.split('\n');
    if (lines.length === 1) {
      for (let pos = 0; pos < trimmed.length; pos += 750) {
        chunks.push(trimmed.slice(pos, pos + 750));
      }
      continue;
    }
    let buf = '';
    for (const line of lines) {
      if (buf && buf.length + line.length + 1 > 800) {
        chunks.push(buf.trim());
        buf = line;
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  return chunks;
}

function clipClean(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 4) return text.slice(0, Math.max(0, maxChars));
  const slice = text.slice(0, maxChars - 1);
  const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('. '));
  if (breakAt >= Math.floor(maxChars * 0.6)) {
    return `${slice.slice(0, breakAt + 1).trimEnd()}…`;
  }
  return `${slice.trimEnd()}…`;
}

/**
 * Extract structured high-signal windows (headings, definitions/theorems/formulas, and topic-keyword
 * matching sections) in document order when a source exceeds `cap`, instead of blind head truncation.
 */
export function extractStructuredSourceExcerpt(rawText, { cap, topic = '', course = '' } = {}) {
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  if (limit <= 0) return '';
  const full = String(rawText ?? '').replace(/\r\n/g, '\n');
  if (full.length <= limit) return full;

  const chunks = splitIntoChunks(full);
  if (chunks.length <= 1) return clipClean(full, limit);

  const keywords = extractTopicKeywords(topic, course);
  let activeHeading = '';
  let activeHeadingIdx = -1;
  const headings = [];

  const blocks = chunks.map((text, index) => {
    const firstLine = text.split('\n', 1)[0].trim();
    const isHeading = firstLine.length <= 140 && HEADING_RE.test(firstLine);
    if (isHeading) {
      activeHeading = firstLine;
      activeHeadingIdx = index;
      headings.push(firstLine.replace(/^#+\s*/, '').trim());
    }
    const lower = text.toLowerCase();
    const headingLower = activeHeading.toLowerCase();

    let score = index === 0 ? 5.5 : 0;
    if (isHeading) score += 3.5;
    if (DEFINITION_EN_RE.test(text) || DEFINITION_ZH_RE.test(text)) score += 6;
    if (FORMULA_OR_CODE_RE.test(text)) score += 4.5;
    if (BOILERPLATE_RE.test(text)) score -= 6;

    let keywordHits = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        keywordHits++;
        score += 8;
      } else if (headingLower && headingLower.includes(kw)) {
        score += 3.5;
      }
    }

    return {
      index,
      text,
      isHeading,
      heading: activeHeading,
      headingIndex: activeHeadingIdx,
      keywordHits,
      score,
    };
  });

  // Propagate signal from headings / theorem headers to their immediately following body block
  for (let i = 0; i < blocks.length - 1; i++) {
    const cur = blocks[i];
    if ((cur.isHeading && cur.score >= 6) || (cur.text.length <= 260 && cur.score >= 8)) {
      blocks[i + 1].score += 5;
    }
  }

  let outlineHeader = '';
  if (headings.length >= 3 && limit >= 1200) {
    const uniqueHeadings = [...new Set(headings)].slice(0, 14);
    const rawOutline = `[Outline: ${uniqueHeadings.join(' | ')}]\n\n`;
    const maxOutline = Math.min(420, Math.floor(limit * 0.12));
    if (rawOutline.length <= maxOutline) {
      outlineHeader = rawOutline;
    } else {
      outlineHeader = `${rawOutline.slice(0, maxOutline - 4).trimEnd()}…]\n\n`;
    }
  }

  const sepGap = '\n\n[…]\n\n';
  let remaining = limit - outlineHeader.length;
  const selected = new Map();
  const singleBlockCap = Math.max(400, Math.floor(limit * 0.42));

  // Always anchor opening context smoothly
  const leadText = clipClean(blocks[0].text, Math.min(blocks[0].text.length, Math.max(220, Math.floor(limit * 0.18))));
  if (leadText.length <= remaining) {
    selected.set(0, leadText);
    remaining -= leadText.length;
  }

  const ranked = [...blocks]
    .filter(b => b.index !== 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  for (const cand of ranked) {
    if (remaining <= 60) break;
    // Include enclosing section heading if not yet selected so the excerpt window has structural context
    if (
      cand.headingIndex >= 0
      && cand.headingIndex !== cand.index
      && !selected.has(cand.headingIndex)
    ) {
      const hBlock = blocks[cand.headingIndex];
      const hText = clipClean(hBlock.text, 160);
      if (hText.length + sepGap.length + 120 <= remaining) {
        selected.set(cand.headingIndex, hText);
        remaining -= hText.length + sepGap.length;
      }
    }

    const allowance = remaining - sepGap.length;
    if (allowance < 60) break;
    const clipped = clipClean(cand.text, Math.min(singleBlockCap, allowance));
    if (!clipped) continue;
    selected.set(cand.index, clipped);
    remaining -= clipped.length + sepGap.length;
  }

  const orderedIndices = [...selected.keys()].sort((a, b) => a - b);
  let assembled = outlineHeader;
  for (let i = 0; i < orderedIndices.length; i++) {
    const idx = orderedIndices[i];
    const prevIdx = i > 0 ? orderedIndices[i - 1] : null;
    const joiner = prevIdx === null ? '' : (idx === prevIdx + 1 ? '\n\n' : sepGap);
    const piece = selected.get(idx);
    if (assembled.length + joiner.length + piece.length <= limit) {
      assembled += joiner + piece;
    } else {
      const room = limit - assembled.length - joiner.length;
      if (room >= 60) {
        assembled += joiner + clipClean(piece, room);
      }
      break;
    }
  }

  return assembled.length <= limit ? assembled : clipClean(assembled, limit);
}

export function planCompanionBuild(state, args = {}) {
  const language = args.language === 'en' || args.uiLanguage === 'en' ? 'en' : 'zh';
  const course = String(args.course ?? currentCourse(state) ?? '').trim();
  if (!course) {
    const err = new Error('course required');
    err.code = 'companion-course-required';
    throw err;
  }

  const rawTopic = String(args.topic || args.prompt || '').trim().slice(0, 2000);
  const sourceIds = Array.isArray(args.sourceIds) ? [...new Set(args.sourceIds.filter(id => typeof id === 'string' && id.trim()))] : [];

  if (!rawTopic && !sourceIds.length) {
    const err = new Error('topic or sourceIds required');
    err.code = 'companion-topic-or-source-required';
    throw err;
  }

  const chosenSources = [];
  if (sourceIds.length) {
    for (const id of sourceIds) {
      const found = (state?.sources || []).find(s => s.id === id && !s.archived);
      if (!found) {
        const err = new Error(`Missing source ${id}`);
        err.code = 'companion-source-missing';
        throw err;
      }
      chosenSources.push(found);
    }
    assertMaterials(chosenSources);
  }

  const totalBudget = Number.isFinite(Number(args.maxSourceBudgetChars)) && Number(args.maxSourceBudgetChars) >= 500
    ? Math.min(MAX_SOURCE_BUDGET_CHARS, Math.floor(Number(args.maxSourceBudgetChars)))
    : MAX_SOURCE_BUDGET_CHARS;

  let budgetLeft = totalBudget;
  const excerpts = [];
  for (let i = 0; i < chosenSources.length; i++) {
    if (budgetLeft <= 0) break;
    const src = chosenSources[i];
    const sourcesRemaining = chosenSources.length - i;
    const fairShare = Math.floor(budgetLeft / sourcesRemaining);
    const perSourceCap = Math.min(budgetLeft, Math.max(Math.min(2500, budgetLeft), fairShare));
    const rawText = String(src.text || '');
    const excerpt = rawText.length <= perSourceCap
      ? rawText
      : extractStructuredSourceExcerpt(rawText, {
          cap: perSourceCap,
          topic: rawTopic,
          course,
        });
    excerpts.push({
      id: src.id,
      title: src.title || src.id,
      excerpt,
    });
    budgetLeft -= excerpt.length;
  }

  const archetype = ARCHETYPES.includes(args.archetype) ? args.archetype : 'auto';
  const mountMode = MOUNT_MODES.includes(args.mountMode) ? args.mountMode : 'auto';
  const grounded = excerpts.length > 0;
  const displayTopic = rawTopic || excerpts.map(s => s.title).join(' · ').slice(0, 120);
  const title = language === 'en'
    ? `Interactive Companion · ${displayTopic.slice(0, 64)}`
    : `交互伴学 · ${displayTopic.slice(0, 48)}`;

  const scopeHash = createHash('sha256')
    .update(JSON.stringify({ course, rawTopic, sourceIds, archetype, mountMode, language }))
    .digest('hex')
    .slice(0, 16);

  return {
    course,
    topic: rawTopic,
    displayTopic,
    title,
    sourceIds,
    excerpts,
    grounded,
    archetype,
    mountMode,
    language,
    workspace: typeof args.workspace === 'string' ? args.workspace : '',
    scopeHash,
    planKey: scopeHash,
    steps: 4,
  };
}

export function estimateCalls(plan) {
  const sampleBp = {
    id: 'sample-lesson',
    title: plan.displayTopic,
    lead: plan.displayTopic,
    archetype: plan.archetype === 'auto' ? 'sandbox' : plan.archetype,
    minutes: 25,
    needs: ['Foundation 1', 'Foundation 2'],
    after: ['Outcome 1', 'Outcome 2', 'Outcome 3'],
    terms: { TermA: 'Plain explanation' },
    act1Slides: Array.from({ length: 8 }, (_, i) => ({ slide: i + 1, beat: 'open', title: `Slide ${i + 1}`, blocks: ['text'] })),
    act2Slides: Array.from({ length: 8 }, (_, i) => ({ slide: i + 9, beat: 'fix', title: `Slide ${i + 9}`, blocks: ['sandbox'] })),
  };
  const c1 = blueprintPrompt(plan);
  const c2 = act1Prompt(plan, sampleBp);
  const c3 = act2Prompt(plan, sampleBp, [{ beat: 'predict', title: 'P', blocks: [{ t: 'predict', id: 'p1', q: '?', options: ['A', 'B'], answer: 0 }] }]);
  return [
    { kind: 'plan', system: c1.system, prompt: c1.prompt, outputTokens: 1600 },
    { kind: 'author', system: c2.system, prompt: c2.prompt, outputTokens: 4200 },
    { kind: 'author', system: c3.system, prompt: c3.prompt, outputTokens: 4200 },
  ];
}
