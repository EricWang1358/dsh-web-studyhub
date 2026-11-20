import { createHash } from 'node:crypto';
import { assertMaterials } from '../../../exam-point-list.js';
import { currentCourse } from '../../../focus.js';
import { learnerAnswer } from '../../../coach.js';
import { isCountedWrongBookAttempt } from '../../../mastery.js';
import { currentCourseNotes, isCourseNotesSource } from '../../../course-book.js';
import { withCardNumbers, leavesOf } from '../../../course-book-card-numbers.js';
import { confusablesView } from '../../../course-book-confusables.js';
import { currentCourseOutline } from '../../../course-outline-book.js';
import { isJsonCardSource } from '../../../source-provenance.js';
import { formatNotationFence, resolveCourseNotationLedger } from '../inventory/notation-ledger.js';
import { ARCHETYPES, MOUNT_MODES } from './contracts.js';
import { blueprintPrompt, act1Prompt, act2Prompt, rescueLessonPrompt } from './prompts.js';

export const MAX_SOURCE_BUDGET_CHARS = 32000;
export const MAX_RESCUE_SOURCE_BUDGET_CHARS = 10000;

const MATH_SANDBOX_RE = /(?:\$[^$]+\$|\\frac|\\sqrt|\\int|\\sum|\\lim|[=≈≠≤≥]\s*[-+A-Za-z0-9\\(]|导数|积分|极限|方程|函数|曲线|阻尼|收敛|概率|矩阵|方差|derivative|integral|limit|equation|function|curve|damping|convergence|variance|parameter)/i;
const CODE_EMPIRICAL_RE = /(?:```|\b(?:thread|lock|mutex|cas|race|deadlock|async|await|sql|index|hash|pointer|recursion|complexity|O\()\b|线程|锁|并发|死锁|递归|指针|索引|事务|复杂度)/i;
const DERIVATION_RE = /(?:推导|步骤|证明|条件|假设|前提|公式|计算|step|proof|derive|derivation|condition|assumption|premise|boundary)/i;

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

function isUsableEvidenceSource(src) {
  if (!src || src.archived) return false;
  if (isCourseNotesSource(src) || src.blueprint || src.courseOutline || src.courseInventory || src.companionId || isJsonCardSource(src)) {
    return false;
  }
  return typeof src.text === 'string' && src.text.trim().length > 0;
}

function resolveBookRescueSignals(state, { course, hid, cards }) {
  const notesSrc = course ? currentCourseNotes(state?.sources, course) : null;
  const outlineSrc = course ? currentCourseOutline(state?.sources, course) : null;
  const notes = notesSrc?.courseNotes || null;
  const leaves = Array.isArray(notes?.leaves) ? notes.leaves : [];

  let resolvedHid = typeof hid === 'string' && hid.trim() ? hid.trim() : '';
  if (!resolvedHid) {
    for (const entry of cards) {
      const cardHid = entry.card?.hid || entry.card?.companionRef?.hid;
      if (typeof cardHid === 'string' && cardHid.trim()) {
        resolvedHid = cardHid.trim();
        break;
      }
    }
  }
  if (!resolvedHid && leaves.length && cards.length) {
    const citedSourceIds = new Set(cards.flatMap(e => (e.card?.citations || []).map(c => c?.sourceId).filter(Boolean)));
    const topicNeedles = cards.map(e => String(e.card?.topic || '').trim().toLowerCase()).filter(t => t.length >= 2);
    const byAnchor = leaves.find(leaf => Array.isArray(leaf?.anchors)
      && leaf.anchors.some(anc => anc?.sourceId && citedSourceIds.has(anc.sourceId)));
    const byTitle = !byAnchor && topicNeedles.length
      ? leaves.find(leaf => topicNeedles.some(t => String(leaf?.title || '').toLowerCase().includes(t) || t.includes(String(leaf?.title || '').toLowerCase())))
      : null;
    const hitLeaf = byAnchor || byTitle;
    if (hitLeaf?.id) resolvedHid = String(hitLeaf.id).trim();
  }

  // Extract matching C001 confusable pairs from courseNotes if present
  const matchedConfusables = [];
  if (notes && Array.isArray(notes.confusables) && notes.confusables.length) {
    const rawTree = Array.isArray(outlineSrc?.courseOutline?.nodes)
      ? outlineSrc.courseOutline.nodes
      : leaves.map(leaf => ({ hid: leaf.id, leaf: true, title: leaf.title, cards: leaf.cards || [] }));
    const numberedTree = withCardNumbers(rawTree);
    const numberedLeaves = leavesOf(numberedTree);
    const allConfusables = confusablesView(notes.confusables, numberedTree);
    const targetLeafCodes = resolvedHid
      ? new Set((numberedLeaves.find(lf => lf.hid === resolvedHid)?.cards || []).map(c => c.code))
      : new Set();
    const cardHaystack = cards
      .map(e => `${e.card?.topic || ''} ${e.card?.prompt || ''} ${e.chosenWrongAnswer || ''} ${e.card?.explanation || ''}`)
      .join(' ')
      .toLowerCase();

    for (const pair of allConfusables) {
      const hitsHid = targetLeafCodes.size > 0 && pair.items.some(code => targetLeafCodes.has(code));
      const hitsText = pair.names.some(name => name && name.length >= 2 && cardHaystack.includes(name.toLowerCase()));
      if (hitsHid || hitsText) {
        matchedConfusables.push({
          id: pair.id,
          names: pair.names,
          rows: (pair.rows || []).map(r => ({ aspect: r.aspect, cells: r.cells })),
        });
        if (matchedConfusables.length >= 3) break;
      }
    }
  }

  const leafSummary = resolvedHid
    ? leaves.find(lf => lf.id === resolvedHid)
    : null;
  const notationLedger = formatNotationFence(resolveCourseNotationLedger(state, course, { max: 16 }), { max: 16 });

  return {
    resolvedHid,
    leafTitle: leafSummary?.title ? String(leafSummary.title).trim() : '',
    confusables: matchedConfusables,
    notationLedger,
  };
}

function buildRescueContext(state, { course, cardIds, deckId, hid, errorReason, thinkingNote, language }) {
  const wantedIds = new Set(cardIds);
  const matchedEntries = [];

  for (const deck of state?.decks || []) {
    if (deck.archived || deck.systemKind) continue;
    if (deckId && deck.id !== deckId) continue;
    for (const card of deck.cards || []) {
      if (!wantedIds.has(card.id)) continue;
      let latestFailed = null;
      let missedCount = 0;
      for (const attempt of state?.attempts || []) {
        if (!isCountedWrongBookAttempt(attempt) || attempt.deckId !== deck.id || attempt.quiz_id !== card.id) continue;
        if (attempt.grade < 3) {
          missedCount++;
          if (!latestFailed || String(attempt.timestamp || '') >= String(latestFailed.timestamp || '')) {
            latestFailed = attempt;
          }
        }
      }
      const runEntry = latestFailed?.runId
        ? (state?.runs || []).find(r => r.id === latestFailed.runId)?.entries?.findLast(e => e.card?.id === card.id && !e.retry && e.feedback)
        : null;
      const shownCard = runEntry?.card || card;
      const parsedAns = runEntry
        ? learnerAnswer(shownCard, runEntry.feedback, { selfGraded: latestFailed?.assessment === 'self', language })
        : null;
      const chosenWrongAnswer = parsedAns && parsedAns.kind !== 'self-assessment'
        ? String(parsedAns.text || '').trim().slice(0, 320)
        : (typeof latestFailed?.answer === 'string' && latestFailed.answer.trim() ? latestFailed.answer.trim().slice(0, 320) : '');
      const cardErrorReason = String(errorReason || latestFailed?.errorReason || '').trim().slice(0, 40);
      const cardThinkingNote = String(thinkingNote || latestFailed?.thinkingNote || '').trim().slice(0, 240);

      matchedEntries.push({
        deck,
        card,
        chosenWrongAnswer,
        missedCount,
        errorReason: cardErrorReason,
        thinkingNote: cardThinkingNote,
      });
      if (matchedEntries.length >= 4) break;
    }
    if (matchedEntries.length >= 4) break;
  }

  const resolvedCourse = course || String(matchedEntries[0]?.deck?.course || matchedEntries[0]?.deck?.folder || '').trim();
  const bookSignals = resolveBookRescueSignals(state, { course: resolvedCourse, hid, cards: matchedEntries });

  // Auto-discover original cited sourceIds (never courseNotes/outline/json-card sources)
  const autoSourceIds = [];
  for (const entry of matchedEntries) {
    for (const cite of entry.card?.citations || []) {
      if (cite?.sourceId && !autoSourceIds.includes(cite.sourceId)) autoSourceIds.push(cite.sourceId);
    }
    if (entry.card?.sourceId && !autoSourceIds.includes(entry.card.sourceId)) autoSourceIds.push(entry.card.sourceId);
  }
  const usableAutoSources = autoSourceIds
    .map(id => (state?.sources || []).find(s => s.id === id))
    .filter(isUsableEvidenceSource);

  const combinedText = matchedEntries
    .map(e => `${e.card.topic || ''} ${e.card.prompt || ''} ${e.card.explanation || ''} ${e.card.misconception || ''} ${e.chosenWrongAnswer}`)
    .join(' ');
  const primaryReason = String(errorReason || matchedEntries[0]?.errorReason || '').trim().toLowerCase();

  let recommendedArchetype = 'auto';
  if (primaryReason === 'concept' || bookSignals.confusables.length > 0) {
    recommendedArchetype = 'dialectic';
  } else if (primaryReason === 'derivation') {
    recommendedArchetype = 'mechanism';
  } else if (MATH_SANDBOX_RE.test(combinedText)) {
    recommendedArchetype = 'sandbox';
  } else if (CODE_EMPIRICAL_RE.test(combinedText)) {
    recommendedArchetype = 'empirical';
  }

  const suggestSpotSlide = primaryReason === 'condition'
    || primaryReason === 'derivation'
    || (primaryReason !== 'concept' && (CODE_EMPIRICAL_RE.test(combinedText) || DERIVATION_RE.test(combinedText)));

  return {
    resolvedCourse,
    resolvedHid: bookSignals.resolvedHid,
    targetCardIds: matchedEntries.map(e => e.card.id),
    usableAutoSources,
    recommendedArchetype,
    context: {
      ...(bookSignals.resolvedHid ? { hid: bookSignals.resolvedHid, pointTitle: bookSignals.leafTitle } : {}),
      ...(primaryReason ? { errorReason: primaryReason } : {}),
      ...(thinkingNote ? { thinkingNote: String(thinkingNote).trim().slice(0, 240) } : {}),
      suggestSpotSlide,
      cards: matchedEntries.map(e => ({
        cardId: e.card.id,
        deckId: e.deck.id,
        kind: e.card.kind || 'flashcard',
        topic: String(e.card.topic || '').slice(0, 120),
        prompt: String(e.card.prompt || '').slice(0, 600),
        correctAnswer: String(e.card.answer || '').slice(0, 400),
        ...(Array.isArray(e.card.options) && e.card.options.length
          ? { options: e.card.options.slice(0, 6).map(o => ({ text: String(o.text || '').slice(0, 220), correct: Boolean(o.correct) })) }
          : {}),
        ...(e.chosenWrongAnswer ? { chosenWrongAnswer: e.chosenWrongAnswer } : {}),
        missedCount: e.missedCount,
        ...(e.errorReason ? { errorReason: e.errorReason } : {}),
        ...(e.thinkingNote ? { thinkingNote: e.thinkingNote } : {}),
        ...(e.card.misconception ? { misconception: String(e.card.misconception).slice(0, 300) } : {}),
        ...(e.card.explanation ? { explanation: String(e.card.explanation).slice(0, 500) } : {}),
        citations: (e.card.citations || []).slice(0, 3).map(c => ({
          sourceId: c.sourceId,
          ...(c.quote ? { quote: String(c.quote).slice(0, 280) } : {}),
          ...(c.page != null ? { page: c.page } : {}),
        })),
      })),
      ...(bookSignals.confusables.length ? { confusables: bookSignals.confusables } : {}),
      ...(bookSignals.notationLedger.length ? { notationLedger: bookSignals.notationLedger } : {}),
    },
  };
}

export function planCompanionBuild(state, args = {}) {
  const language = args.language === 'en' || args.uiLanguage === 'en' ? 'en' : 'zh';
  const mode = args.mode === 'rescue' ? 'rescue' : 'full';
  const isRescue = mode === 'rescue';

  const rawCardIds = [
    ...(Array.isArray(args.cardIds) ? args.cardIds : []),
    ...(typeof args.cardId === 'string' ? [args.cardId] : []),
  ].map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  const uniqueCardIds = [...new Set(rawCardIds)];
  const rawHid = typeof args.hid === 'string' ? args.hid.trim() : '';

  const rescue = isRescue
    ? buildRescueContext(state, {
        course: String(args.course ?? '').trim(),
        cardIds: uniqueCardIds,
        deckId: typeof args.deckId === 'string' ? args.deckId.trim() : '',
        hid: rawHid,
        errorReason: args.errorReason,
        thinkingNote: args.thinkingNote,
        language,
      })
    : null;

  const course = String(args.course || '').trim() || rescue?.resolvedCourse || String(currentCourse(state) || '').trim();
  if (!course) {
    const err = new Error('course required');
    err.code = 'companion-course-required';
    throw err;
  }

  const rawTopic = String(args.topic || args.prompt || '').trim().slice(0, 2000);
  const sourceIds = Array.isArray(args.sourceIds) ? [...new Set(args.sourceIds.filter(id => typeof id === 'string' && id.trim()))] : [];
  const hasRescueAnchor = Boolean(isRescue && (rescue?.targetCardIds?.length || rescue?.resolvedHid || rawHid));

  if (!rawTopic && !sourceIds.length && !hasRescueAnchor) {
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
  } else if (isRescue && rescue?.usableAutoSources?.length) {
    chosenSources.push(...rescue.usableAutoSources.slice(0, 4));
  }

  const defaultBudget = isRescue ? MAX_RESCUE_SOURCE_BUDGET_CHARS : MAX_SOURCE_BUDGET_CHARS;
  const totalBudget = Number.isFinite(Number(args.maxSourceBudgetChars)) && Number(args.maxSourceBudgetChars) >= 500
    ? Math.min(MAX_SOURCE_BUDGET_CHARS, Math.floor(Number(args.maxSourceBudgetChars)))
    : defaultBudget;

  const rescueTopicSeed = rescue?.context?.cards?.[0]?.topic
    || rescue?.context?.pointTitle
    || rescue?.context?.cards?.[0]?.prompt?.slice(0, 80)
    || rescue?.resolvedHid
    || '';

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
          topic: rawTopic || rescueTopicSeed,
          course,
        });
    excerpts.push({
      id: src.id,
      title: src.title || src.id,
      excerpt,
    });
    budgetLeft -= excerpt.length;
  }

  const requestedArchetype = ARCHETYPES.includes(args.archetype) ? args.archetype : 'auto';
  const archetype = isRescue && requestedArchetype === 'auto' && rescue?.recommendedArchetype
    ? rescue.recommendedArchetype
    : requestedArchetype;
  const mountMode = MOUNT_MODES.includes(args.mountMode) ? args.mountMode : 'auto';
  const grounded = excerpts.length > 0;
  const displayTopic = rawTopic || rescueTopicSeed || excerpts.map(s => s.title).join(' · ').slice(0, 120);
  const title = isRescue
    ? (language === 'en' ? `Rescue Lab · ${displayTopic.slice(0, 64)}` : `急救实验 · ${displayTopic.slice(0, 48)}`)
    : (language === 'en' ? `Interactive Companion · ${displayTopic.slice(0, 64)}` : `交互伴学 · ${displayTopic.slice(0, 48)}`);

  const effectiveSourceIds = chosenSources.map(s => s.id);
  const resolvedHid = rescue?.resolvedHid || rawHid;
  const targetCardIds = isRescue ? (rescue?.targetCardIds?.length ? rescue.targetCardIds : uniqueCardIds) : [];

  const scopeHash = createHash('sha256')
    .update(JSON.stringify({
      mode,
      course,
      rawTopic,
      sourceIds: effectiveSourceIds,
      archetype,
      mountMode,
      language,
      ...(isRescue ? { hid: resolvedHid, targetCardIds } : {}),
    }))
    .digest('hex')
    .slice(0, 16);

  const notationLedger = formatNotationFence(resolveCourseNotationLedger(state, course, { max: 24 }), { max: 24 });
  return {
    mode,
    course,
    topic: rawTopic,
    displayTopic,
    title,
    sourceIds: effectiveSourceIds,
    excerpts,
    grounded,
    archetype,
    mountMode,
    language,
    workspace: typeof args.workspace === 'string' ? args.workspace : '',
    scopeHash,
    planKey: scopeHash,
    steps: isRescue ? 2 : 4,
    ...(notationLedger.length ? { notationLedger } : {}),
    ...(resolvedHid ? { hid: resolvedHid } : {}),
    ...(targetCardIds.length ? { targetCardIds } : {}),
    ...(rescue ? { rescueContext: rescue.context } : {}),
  };
}

export function estimateCalls(plan) {
  if (plan?.mode === 'rescue') {
    const r = rescueLessonPrompt(plan);
    return [
      { id: 'author', system: r.system, prompt: r.prompt, outputChars: { low: 2400, high: 5200 } },
    ];
  }
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
    { id: 'plan', system: c1.system, prompt: c1.prompt, outputChars: { low: 2800, high: 5600 } },
    { id: 'author', system: c2.system, prompt: c2.prompt, outputChars: { low: 7000, high: 15000 } },
    { id: 'author', system: c3.system, prompt: c3.prompt, outputChars: { low: 7000, high: 15000 } },
  ];
}
