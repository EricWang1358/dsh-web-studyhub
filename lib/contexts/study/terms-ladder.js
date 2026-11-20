import { samePrompt } from '../../capture.js';
import { NOTES_LIMITS } from '../../course-book.js';

export const TERMS_LIMITS = Object.freeze({
  minTerms: 1,
  maxTerms: 6,
  maxTermChars: 60,
  maxLadderSteps: 10,
  maxDeeper: 6,
  stepTermMax: NOTES_LIMITS.termName,
  altMax: 120,
  problemMax: NOTES_LIMITS.termPlain,
  plainMax: NOTES_LIMITS.termPlain,
  formalMax: NOTES_LIMITS.termPitch,
  exampleMax: NOTES_LIMITS.termPlain,
  reasonMax: 240,
});

const NEWLINE_RE = /[\r\n\u2028\u2029]/;
const ALLOWED_CARD_KEYS = new Set([
  'kind',
  'topic',
  'objective',
  'prompt',
  'answer',
  'hint',
  'explanation',
  'misconception',
  'citations',
]);
const REQUIRED_CARD_TEXT_KEYS = ['topic', 'objective', 'prompt', 'answer', 'hint', 'misconception'];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function requireLine(value, max, label) {
  if (typeof value !== 'string' || NEWLINE_RE.test(value)) {
    throw new Error(`${label}格式无效，不能包含换行`);
  }
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > max) {
    throw new Error(`${label}长度须在 1–${max} 字之间`);
  }
  return clean;
}

function requireText(value, max, label) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const clean = value.trim();
  if (!clean || clean.length > max) {
    throw new Error(`${label}长度须在 1–${max} 字之间`);
  }
  return clean;
}

/**
 * Validate and deduplicate learner-marked unknown terms for `assist` mode `terms`.
 * Rejects empty lists, > 6 items, newlines, empty items, or items > 60 chars.
 */
export function normalizeTermsList(rawTerms) {
  if (!Array.isArray(rawTerms) || rawTerms.length < TERMS_LIMITS.minTerms) {
    throw new Error('请先标出 1–6 个不认识的词');
  }
  if (rawTerms.length > TERMS_LIMITS.maxTerms) {
    throw new Error(`一次最多补齐 ${TERMS_LIMITS.maxTerms} 个词`);
  }
  const seen = new Set();
  const terms = [];
  for (const raw of rawTerms) {
    if (typeof raw !== 'string' || NEWLINE_RE.test(raw)) {
      throw new Error('每个词条必须是不含换行的文本');
    }
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('词条不能为空');
    if (clean.length > TERMS_LIMITS.maxTermChars) {
      throw new Error(`单个词条不能超过 ${TERMS_LIMITS.maxTermChars} 字`);
    }
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(clean);
    }
  }
  return terms;
}

export const TERMS_INSTRUCTION = [
  'The learner marked unfamiliar terms (`request.terms` when supplied, otherwise `terms.unknown`) while studying the current card. `terms.unknown` lists terms the learner does not know—if you use any, briefly explain it in one sentence first; `terms.known` lists terms the learner already knows and may be used directly; `terms.hasCard` (when supplied) lists terms that already have explanations and check questions—do NOT generate `ladder` steps or `skipped` entries for them, though `layer: 1` steps may cite them in `needs` and use them in `formal`. Build a bottom-up concept ladder for the requested terms (`request.terms` if supplied, else `terms.unknown`) from the most foundational term upward.',
  'Follow all 7 rules strictly:',
  '1. Each term to teach is one step in `ladder`, strictly ordered foundations first: if understanding A requires knowing B first, B MUST appear earlier in `ladder` than A.',
  '2. Every step in `ladder` must include in order: `problem` (what problem this concept exists to solve, <= 240 chars), `plain` (plain-words explanation using only everyday words, <= 240 chars), `formal` (formal definition usable in exams or interviews, including the English name or standard abbreviation when relevant, <= 300 chars), `example` (one concrete example, <= 240 chars), and `card` (one check flashcard testing the formal definition—NOT repeating an everyday metaphor; do NOT write `card.explanation` because the app generates it from those four sections, and keep `prompt`, `answer`, `hint`, and `misconception` concise).',
  '3. Inside `formal`, use only terms already explained in earlier steps of `ladder`, listed in `terms.hasCard`, or listed in `terms.known`. If another technical term is truly unavoidable, briefly gloss it in parentheses in a few words. If one sentence would require more than two unintroduced terms, turn those foundational terms into earlier steps.',
  '4. Every explained requested term MUST have `layer: 1`, and ONLY requested terms may have `layer: 1` (never mark an unrequested term you added as `layer: 1`). Foundational steps you add on your own (terms NOT in the requested terms, needed to explain layer-1 terms) may go only ONE layer deeper and MUST have `layer: 2`.',
  '5. Do NOT go to layer 3 or deeper, and do NOT let a `layer: 2` step depend on any other step: every `layer: 2` step MUST have `"needs": []`. If a `layer: 2` step still relies on more unintroduced prerequisites, list up to 6 still-missing terms in `deeper` (1–60 chars each) instead of adding deeper steps or `needs` entries.',
  '6. If a requested item is not an explainable term or concept (e.g. a sentence fragment or non-term noise), do NOT force a ladder step for it; place it in `skipped` as `{"term":"exact marked item","reason":"brief explanation"}`.',
  '7. Ground each check card in the supplied `sources` with verbatim `quote` (>= 12 chars) citations. When `sources` do not cover a step, include `"note":"factual supplementary explanation, 40–2000 characters, clearly marked as supplementary knowledge"` on that step and cite a verbatim quote (>= 12 chars) from `note` with `"sourceId":"NOTE"`.',
  'Output shape: {"ladder":[{"term":"...","alt":"optional alias/abbr","layer":1,"needs":["earlier step term"],"problem":"...","plain":"...","formal":"...","example":"...","card":{"kind":"flashcard","topic":"...","objective":"...","prompt":"plain text question testing formal definition, never {{blank}} markers","answer":"...","hint":"...","misconception":"common mistake","citations":[{"sourceId":"supplied id or NOTE","quote":"verbatim passage >= 12 chars"}]},"note":"optional 40-2000 char note when sourceId is NOTE"}],"deeper":["optional up to 6 terms"],"skipped":[{"term":"...","reason":"..."}]}.',
  'Constraints: `ladder` has 0–10 steps (`0` only if every requested term is in `skipped`), step `term` values are unique (case-insensitive) and MUST NOT repeat any term in `terms.hasCard`, every `layer: 1` step `term` MUST be one of the requested terms (case-insensitive), every `layer: 2` step MUST have `needs: []`, `needs` on `layer: 1` steps only references `term` values that appeared at an earlier index in `ladder` or terms in `terms.hasCard`, every requested term (`request.terms` if supplied, else `terms.unknown`) appears as either a `layer: 1` step in `ladder` or in `skipped`, and no check card prompt duplicates the current card or uses `{{...}}` markers. Prefer reusing matching candidate card prompts from `candidates` only when one tests the exact same formal definition.',
].join(' ');

function validateStepCard(step, currentCardPrompt) {
  const { card } = step;
  if (!isPlainObject(card) || card.kind !== 'flashcard' || JSON.stringify(card).length > 16000) {
    throw new Error('台阶检查题格式无效');
  }
  if (Object.keys(card).some((key) => !ALLOWED_CARD_KEYS.has(key))) {
    throw new Error('台阶检查题包含不支持的字段');
  }
  for (const field of REQUIRED_CARD_TEXT_KEYS) {
    if (typeof card[field] !== 'string' || !card[field].trim()) {
      throw new Error(`台阶检查题缺少 ${field}`);
    }
  }
  if (['prompt', 'answer'].some((key) => /\{\{[^{}]+\}\}/.test(String(card[key] ?? '')))) {
    throw new Error('台阶检查题不能出现 {{…}} 填空标记');
  }
  if (currentCardPrompt && samePrompt(card.prompt, currentCardPrompt)) {
    throw new Error('台阶检查题不能与当前原题重复');
  }
  if (!Array.isArray(card.citations) || !card.citations.length) {
    throw new Error('台阶检查题缺少资料引用');
  }
  if (step.note !== undefined) {
    const note = requireText(step.note, 2000, '补充笔记');
    if (note.length < 40) throw new Error('补充笔记至少需要 40 字');
  }
}

/**
 * Strictly validate an AI-returned terms ladder against the requested terms.
 * Throws descriptive Chinese errors on any violation so `assist` can retry once or abort cleanly.
 */
export function validateTermsReply(result, requestedTerms, currentCardPrompt = '', hasCardTerms = []) {
  if (!isPlainObject(result)) throw new Error('补词结果格式无效');
  if (!Array.isArray(result.ladder)) throw new Error('补词结果缺少台阶列表');
  if (result.ladder.length > TERMS_LIMITS.maxLadderSteps) {
    throw new Error(`补词台阶最多 ${TERMS_LIMITS.maxLadderSteps} 级`);
  }
  if (result.skipped !== undefined && !Array.isArray(result.skipped)) {
    throw new Error('补词结果的跳过列表格式无效');
  }
  if (result.deeper !== undefined && !Array.isArray(result.deeper)) {
    throw new Error('补词结果的延伸词列表格式无效');
  }

  const hasCardByKey = new Map();
  for (const raw of Array.isArray(hasCardTerms) ? hasCardTerms : []) {
    if (typeof raw !== 'string') continue;
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean) hasCardByKey.set(clean.toLowerCase(), clean);
  }
  const requestedByKey = new Map(requestedTerms.map((term) => [term.toLowerCase(), term]));
  const skippedMap = new Map();
  const skipped = [];
  for (const rawItem of result.skipped || []) {
    if (!isPlainObject(rawItem)) throw new Error('跳过项格式无效');
    const term = requireLine(rawItem.term, TERMS_LIMITS.stepTermMax, '跳过词条');
    const reason = requireLine(rawItem.reason, TERMS_LIMITS.reasonMax, '跳过原因');
    const key = term.toLowerCase();
    if (hasCardByKey.has(key)) {
      throw new Error('已有检查题的词不用再生成台阶，请直接移除或在 needs 中引用');
    }
    if (!requestedByKey.has(key)) {
      throw new Error('跳过列表只能包含本次标出的词条');
    }
    if (skippedMap.has(key)) throw new Error('跳过列表包含重复词条');
    skippedMap.set(key, reason);
    skipped.push({ term, reason });
  }

  const seenTerms = new Set();
  const seenPrompts = [];
  const priorTerms = new Map();
  const layer1Keys = new Set();
  const ladder = [];

  for (const rawStep of result.ladder) {
    if (!isPlainObject(rawStep)) throw new Error('台阶项格式无效');
    const term = requireLine(rawStep.term, TERMS_LIMITS.stepTermMax, '台阶词条');
    const key = term.toLowerCase();
    if (seenTerms.has(key)) throw new Error('台阶中出现重复词条');
    if (skippedMap.has(key)) throw new Error('同一个词不能既在台阶中又在跳过列表中');
    if (hasCardByKey.has(key)) {
      throw new Error('已有检查题的词不用再生成台阶，请直接移除或在 needs 中引用');
    }
    if (rawStep.layer !== 1 && rawStep.layer !== 2) {
      throw new Error('台阶层级只能是 1 或 2');
    }
    if (rawStep.layer === 1 && !requestedByKey.has(key)) {
      throw new Error('第 1 层台阶只能是学生标出的词；为了讲清楚而加的词请标 layer 2');
    }
    let alt = '';
    if (rawStep.alt !== undefined && rawStep.alt !== null && String(rawStep.alt).trim() !== '') {
      alt = requireLine(rawStep.alt, TERMS_LIMITS.altMax, '词条别名');
    }
    const rawNeeds = rawStep.needs === undefined ? [] : rawStep.needs;
    if (!Array.isArray(rawNeeds)) throw new Error('台阶前置依赖格式无效');
    if (rawStep.layer === 2 && rawNeeds.length > 0) {
      throw new Error('第 2 层台阶不能再依赖别的词（needs 须为空）；还需要更底层的词请写进 deeper');
    }
    const needs = [];
    const seenNeeds = new Set();
    for (const rawNeed of rawNeeds) {
      const need = requireLine(rawNeed, TERMS_LIMITS.stepTermMax, '台阶前置词条');
      const needKey = need.toLowerCase();
      const resolvedNeed = priorTerms.get(needKey) ?? hasCardByKey.get(needKey);
      if (!resolvedNeed) {
        throw new Error(
          hasCardByKey.size
            ? '台阶前置依赖必须指向前面已经讲过的词条或已有检查题的词'
            : '台阶前置依赖必须指向前面已经讲过的词条',
        );
      }
      if (!seenNeeds.has(needKey)) {
        seenNeeds.add(needKey);
        needs.push(resolvedNeed);
      }
    }

    const problem = requireText(rawStep.problem, TERMS_LIMITS.problemMax, '问题说明');
    const plain = requireText(rawStep.plain, TERMS_LIMITS.plainMax, '大白话说明');
    const formal = requireText(rawStep.formal, TERMS_LIMITS.formalMax, '正式说法');
    const example = requireText(rawStep.example, TERMS_LIMITS.exampleMax, '具体例子');
    validateStepCard(rawStep, currentCardPrompt);
    if (seenPrompts.some((prompt) => samePrompt(prompt, rawStep.card.prompt))) {
      throw new Error('不同台阶的检查题题干不能重复');
    }

    seenTerms.add(key);
    seenPrompts.push(rawStep.card.prompt);
    priorTerms.set(key, term);
    if (rawStep.layer === 1) layer1Keys.add(key);

    const { explanation: _ignoredExplanation, ...card } = rawStep.card;

    ladder.push({
      term,
      ...(alt ? { alt } : {}),
      layer: rawStep.layer,
      needs,
      problem,
      plain,
      formal,
      example,
      card,
      ...(rawStep.note !== undefined ? { note: rawStep.note } : {}),
    });
  }

  if (!ladder.length && !skipped.length) {
    throw new Error('补词结果为空，既没有台阶也没有跳过说明');
  }
  for (const [key] of requestedByKey) {
    if (!layer1Keys.has(key) && !skippedMap.has(key)) {
      throw new Error('请求的每个词条都必须出现在第 1 层台阶或跳过列表中');
    }
  }

  const rawDeeper = result.deeper || [];
  if (rawDeeper.length > TERMS_LIMITS.maxDeeper) {
    throw new Error(`延伸词最多列 ${TERMS_LIMITS.maxDeeper} 个`);
  }
  const seenDeeper = new Set();
  const deeper = [];
  for (const raw of rawDeeper) {
    const clean = requireLine(raw, TERMS_LIMITS.maxTermChars, '延伸词');
    const key = clean.toLowerCase();
    if (!seenDeeper.has(key)) {
      seenDeeper.add(key);
      deeper.push(clean);
    }
  }

  return { ladder, deeper, skipped };
}

/** Build the 4-section Markdown explanation stored on each step's check flashcard. */
export function formatStepCardExplanation(step, language = 'zh') {
  const isEn = language === 'en';
  const h = isEn
    ? { problem: 'Problem', plain: 'Plain words', formal: 'Formal definition', example: 'Example' }
    : { problem: '问题', plain: '大白话', formal: '正式说法', example: '例子' };
  return [
    `### ${h.problem}\n${step.problem}`,
    `### ${h.plain}\n${step.plain}`,
    `### ${h.formal}\n${step.formal}`,
    `### ${h.example}\n${step.example}`,
  ].join('\n\n');
}

/** Build the single readable Markdown followup attached to the original card. */
export function formatTermsFollowupMarkdown({ ladder, skipped = [], reused = [] }, language = 'zh', maxChars = 8000) {
  const isEn = language === 'en';
  const labels = isEn
    ? { problem: 'Problem', plain: 'Plain words', formal: 'Formal definition', example: 'Example', check: 'Check question' }
    : { problem: '问题', plain: '大白话', formal: '正式说法', example: '例子', check: '检查题' };
  const colon = isEn ? ': ' : '：';

  const sections = ladder.map((step) => {
    const title = step.alt
      ? (isEn ? `### **${step.term}** (${step.alt})` : `### **${step.term}**（${step.alt}）`)
      : `### **${step.term}**`;
    const stem = String(step.card?.prompt || '').replace(/\s+/g, ' ').trim();
    return [
      title,
      `- ${labels.problem}${colon}${step.problem}`,
      `- ${labels.plain}${colon}${step.plain}`,
      `- ${labels.formal}${colon}${step.formal}`,
      `- ${labels.example}${colon}${step.example}`,
      `- ${labels.check}${colon}${stem}`,
    ].join('\n');
  });

  if (reused.length) {
    sections.push(
      isEn
        ? `- Reused existing check question${reused.length === 1 ? '' : 's'} (already filled in earlier): ${reused.join(', ')}`
        : `- 已有检查题（以前补过，已直接关联）：${reused.join('、')}`,
    );
  }

  if (skipped.length) {
    const skippedLines = skipped.map((item) =>
      isEn ? `- Skipped: ${item.term} (${item.reason})` : `- 没有补：${item.term}（${item.reason}）`,
    );
    sections.push(skippedLines.join('\n'));
  }

  let markdown = sections.join('\n\n').trim();
  if (!markdown) {
    markdown = isEn ? 'All marked items were skipped.' : '本次标出的内容均已跳过。';
  }
  if (markdown.length > maxChars) {
    markdown = `${markdown.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return markdown;
}
