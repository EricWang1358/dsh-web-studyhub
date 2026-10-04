import { norm } from './domain.js';
import { answerLeakIssues } from './assessment-quality.js';
import { bareMath } from './tex-text.js';
import { wrapChemistry, chemWhole } from './chem-text.js';
import { bareMathText, wrapMathText, toTex } from './math-text.js';

/* Zero-cost, deterministic repair of the text defects an author leaves on an otherwise sound card (missing hint/topic/explanation/
 * misconception, a hint that gives the answer away, a wrong kind, a formula outside $…$). The program owns the answer, options, rubric,
 * cloze, citations, objective and targetId (bindSupportedAnswers): their content is never rewritten here, only a formula in them gets its
 * delimiters (which cannot change the meaning): TeX, chemistry as `$\ce{…}$`, plain-text math as TeX (√, x^2, (x−1)(x+1)). An ambiguous
 * ion such as SO42− is left for the model. Every rule only fires when its result passes the same check the later gate applies; otherwise the card is left as it is
 * and the gate drops it exactly as before. Pure: the input deck is never mutated. */

const blank = (value) => typeof value !== 'string' || !value.trim();
const english = (language) => /^\s*(?:en\b|english)/i.test(String(language || ''));
const GENERIC_HINT = { zh: '先找出题干里决定答案的条件，再逐一排除', en: 'Find the condition in the stem that decides the answer, then rule out the others' };
const GENERIC_TOPIC = { zh: '核心概念辨析', en: 'Key concept' };

/** True when `field` of the card would be flagged by the answer-leak gate (which already honours topicNoAnswer/hintNoAnswer === false). */
const leaks = (card, field, value, constraints) =>
  answerLeakIssues({ cards: [{ ...card, [field]: value }] }, constraints).some((issue) => issue.includes(`answerLeak in ${field}:`));

/* The delimiters the study cards render (same boundaries as tex-text.js bareMath), to keep already-delimited math untouched. */
const DELIMITED = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?=\S)[^$\n]*?[^\s$\\]\$(?!\d)/g;

/** `text` with every bare formula wrapped in `$…$` in place, or null when nothing changed or that cannot be done cleanly. */
function wrapped(text) {
  // Code, links and blanks stay literal; a text that mixes them with formulas is left for the gate.
  if (/`|\]\(|https?:|\{\{/.test(text)) return null;
  let current = text;
  for (let guard = 0; guard < 12; guard++) {
    const pieces = bareMath(current);
    if (!pieces.length) return current === text ? null : current;
    const taken = [...current.matchAll(DELIMITED)].map((match) => [match.index, match.index + match[0].length]);
    let at = -1;
    for (let from = current.indexOf(pieces[0]); from >= 0; from = current.indexOf(pieces[0], from + 1))
      if (!taken.some(([a, b]) => from >= a && from < b)) { at = from; break; }
    if (at < 0) return null;
    const [start, end] = formulaSpan(current, at, at + pieces[0].length);
    const pad = (/\w/.test(current[start - 1] || '') ? ' ' : '');
    const after = (/[0-9]/.test(current[end] || '') ? ' ' : '');
    current = `${current.slice(0, start)}${pad}$${current.slice(start, end)}$${after}${current.slice(end)}`;
    // The new span must be one the renderer recognises as math; otherwise stop instead of stacking delimiters.
    if (![...current.matchAll(DELIMITED)].some((match) => match.index === start + pad.length)) return null;
  }
  return null;
}

/** `text` with its bare formulas wrapped in `$…$` in place (TeX, chemistry as \ce, plain-text math as TeX); the text itself when there is none or they cannot be wrapped cleanly. */
export function wrapBareMath(text) {
  if (typeof text !== 'string') return text;
  // Chemistry first: its spans are then delimited math for the passes after it.
  let out = wrapChemistry(text);
  const tex = wrapped(out);
  if (tex && !bareMath(tex).length) out = tex;
  return wrapMathText(out);
}

const CJK = /[㐀-鿿]/;
const delimitedWhole = (text) => /^\$[^$\n]+\$$|^\$\$[\s\S]+\$\$$/.test(text.trim());
/** Whether an option is nothing but a formula: no CJK, no word of two letters (a TeX command does not count), no code, link or blank. */
const formulaShaped = (text) => !!text.trim() && !CJK.test(text) && !/[`$]|https?:|\{\{/.test(text) && !/[A-Za-z]{2,}/.test(text.replace(/\\[A-Za-z]+/g, ''));
const plainNumber = (text) => /^[-−+]?\d+(?:\.\d+)?$|^[a-zπ]$/.test(text.trim());
/** The text of one option once the set is known to be math or chemistry (null when it stays as it is). */
function wholeOption(text, { math, chem }) {
  if (delimitedWhole(text)) return null;
  const trimmed = text.trim();
  if (chem) { const ce = chemWhole(trimmed, { loose: true }); if (ce) return `$\\ce{${ce}}$`; }
  if (!math || !formulaShaped(trimmed)) return null;
  if (plainNumber(trimmed)) return `$${trimmed.replace(/−/g, '-')}$`;
  // TeX written with braces is delimited by the TeX pass in place, so its characters (2·3^{n-1}) stay as authored.
  return bareMathText(trimmed).length && !bareMath(trimmed).length ? `$${toTex(trimmed)}$` : null;
}

/** The options of a choice card with a set that is visually parallel: when any option is math or a formula, every option that is a number,
 * an expression or a formula is wrapped whole ($1$ next to $x+1$, NaOH next to $\ce{H2SO4}$). The same array when nothing changes or two
 * options would become the same text. */
export function wrapOptionSet(options) {
  if (!Array.isArray(options) || options.length < 2) return options;
  const texts = options.map(option => (typeof option?.text === 'string' ? option.text : ''));
  const math = texts.some(text => delimitedWhole(text) || (formulaShaped(text) && (bareMathText(text).length || bareMath(text).length)));
  const chem = texts.some(text => text && chemWhole(text));
  if (!math && !chem) return options;
  const next = texts.map(text => (text ? wholeOption(text, { math, chem }) ?? text : text));
  if (next.every((text, index) => text === texts[index])) return options;
  if (new Set(next.map(norm)).size < new Set(texts.map(norm)).size) return options;
  return options.map((option, index) => (next[index] === texts[index] ? option : { ...option, text: next[index] }));
}

/** The options with their set made parallel and every text's own formulas wrapped; two choices that would become one stay as they were. */
export function wrapChoiceOptions(options) {
  if (!Array.isArray(options)) return options;
  const list = [...wrapOptionSet(options)];
  list.forEach((option, index) => {
    for (const key of ['text', 'explanation']) {
      const next = wrapBareMath(option?.[key]);
      if (next === option?.[key]) continue;
      // Two choices must stay different choices after wrapping.
      if (key === 'text' && list.some((other, at) => at !== index && norm(other?.text) === norm(next))) continue;
      list[index] = { ...list[index], [key]: next };
    }
  });
  return list;
}

/** The smallest sensible span around a found piece: its braces/sub/superscripts, attached operands and a no-space operator chain (a^{2}+b^{2}=c^{2}). */
function formulaSpan(text, start, end) {
  const group = (i, open, close) => {
    let depth = 0;
    for (let j = i; j < text.length && text[j] !== '\n'; j++) {
      if (text[j] === open) depth++;
      else if (text[j] === close && --depth === 0) return j + 1;
    }
    return -1;
  };
  const scripts = (i, command = false) => {
    for (;; command = false) {
      const c = text[i];
      if (c === '{') { const e = group(i, '{', '}'); if (e < 0) return i; i = e; }
      else if ((c === '[' && command) || (c === '(' && text[i - 1] === '}')) { const e = group(i, c, c === '[' ? ']' : ')'); if (e < 0) return i; i = e; }
      else if (c === '^' || c === '_') {
        const next = text[i + 1];
        if (next === '{') { const e = group(i + 1, '{', '}'); if (e < 0) return i; i = e; }
        else if (/[A-Za-z0-9]/.test(next || '')) i += 2;
        else return i;
      } else return i;
    }
  };
  const operand = (i) => {
    let j = i;
    if (text[j] === '\\' && /[A-Za-z]/.test(text[j + 1] || '')) {
      j += 1 + /^[A-Za-z]+/.exec(text.slice(j + 1))[0].length;
      if (text[j] === '[') { const e = group(j, '[', ']'); if (e > 0) j = e; }
    } else if (text[j] === '(') { const e = group(j, '(', ')'); if (e < 0) return i; j = e; }
    else { const run = /^[A-Za-z0-9]+(?:\.[0-9]+)?/.exec(text.slice(j)); if (!run) return i; j += run[0].length; }
    return scripts(j);
  };
  let from = start, to = scripts(end, text[start] === '\\');
  if (text[start] === '\\') from = start - (/[A-Za-z0-9.]*$/.exec(text.slice(0, start))[0].length);
  // Whatever is attached to the formula without a space (a_n=2·, x=) belongs to it; a plain word is not enough on its own.
  const lead = /[A-Za-z0-9.+\-=<>*/×·≤≥≈≠_^(){}]+$/.exec(text.slice(0, from));
  if (lead && /[=+\-<>*/×·≤≥≈≠_^]/.test(lead[0])) from -= lead[0].length;
  for (;;) {
    const op = /^(\s?)([+\-=<>*/×·≤≥≈≠])(\s?)/.exec(text.slice(to));
    if (!op) break;
    const next = to + op[0].length, stop = operand(next);
    if (stop <= next) break;
    if ((op[1] || op[3]) && !/[\\^_{]|\d/.test(text.slice(next, stop))) break;
    to = stop;
  }
  // A formula keeps going across spaces while the next word is itself mathy or an operator (z^l = W^l a^{l-1} + b^l); a number only joins next to an operator.
  const OP = /^[+\-=<>*/×·≤≥≈≠]+$/, mathy = (word) => /[\^_\\{}]/.test(word), plain = (word) => /^\d+(?:\.\d+)?$/.test(word);
  let reach = to, cursor = to, afterOp = false;
  for (;;) {
    const next = /^(\s+)(\S+)/.exec(text.slice(cursor));
    if (!next) break;
    const word = next[2].replace(/[,.;:!?，。；：！？)）]+$/, ''), isOp = OP.test(word);
    if (!word || !(isOp || mathy(word) || (afterOp && plain(word)))) break;
    cursor += next[1].length + word.length;
    if (!isOp) reach = cursor;
    afterOp = isOp;
    if (word.length !== next[2].length) break;
  }
  to = reach;
  let reachBack = from, back = from, beforeOp = false;
  for (;;) {
    const prev = /(\S+)(\s+)$/.exec(text.slice(0, back));
    if (!prev) break;
    const word = prev[1].replace(/^[(（]+/, ''), isOp = OP.test(word);
    if (!word || !(isOp || mathy(word) || (beforeOp && plain(word)))) break;
    back -= prev[2].length + word.length;
    if (!isOp) reachBack = back;
    beforeOp = isOp;
    if (word.length !== prev[1].length) break;
  }
  return [reachBack, to];
}

/** `{ deck, fixes: [{ cardId, field, rule }] }`: the deck with the repairable text defects of every bound card fixed. */
export function autofixDeck(deck, { assessmentPlan, answerBlueprint, expectedKind, constraints, language } = {}) {
  const cards = Array.isArray(deck?.cards) ? deck.cards : [];
  const fixes = [], zh = !english(language), side = (zh ? 'zh' : 'en'), cons = constraints || {};
  const out = cards.map((original) => {
    const target = (assessmentPlan?.targets || []).find((t) => t.targetId === original?.targetId);
    const item = (answerBlueprint?.items || []).find((i) => i.targetId === original?.targetId);
    if (!original || typeof original !== 'object' || !target || !item) return original;
    let card = original;
    const set = (field, value, rule) => { card = { ...card, [field]: value }; fixes.push({ cardId: card.id, field, rule }); };
    const axis = typeof item.comparisonAxis === 'string' && item.comparisonAxis.trim() ? item.comparisonAxis.trim() : '';

    if (expectedKind && card.kind !== expectedKind) {
      set('kind', expectedKind, 'kind');
      // A cloze stem is the blueprint's cloze text, which the binding only copies for cards that already said cloze.
      if (expectedKind === 'cloze' && typeof item.cloze?.text === 'string') card = { ...card, prompt: item.cloze.text };
    }

    if (blank(card.topic) || leaks(card, 'topic', card.topic, cons)) {
      const pick = [target.objective, axis, GENERIC_TOPIC[side]].find((value) => !blank(value) && !leaks(card, 'topic', value, cons));
      if (pick) set('topic', pick.trim(), 'topic');
    }

    if (blank(card.explanation) && !blank(item.reasoning) && norm(item.reasoning) !== norm(card.answer))
      set('explanation', item.reasoning.trim(), 'explanation');

    if (blank(card.misconception)) {
      const wrong = (Array.isArray(card.options) ? card.options : item.options || []).find((o) => o?.correct === false && !blank(o.explanation));
      const pick = wrong?.explanation || axis;
      if (!blank(pick)) set('misconception', pick.trim(), 'misconception');
    }

    if (blank(card.hint) || norm(card.hint) === norm(card.answer) || leaks(card, 'hint', card.hint, cons)) {
      const neutral = axis ? (zh ? `先想清楚：${axis}` : `First think about: ${axis}`) : '';
      const pick = [neutral, GENERIC_HINT[side]].find((value) => value && norm(value) !== norm(card.answer) && !leaks(card, 'hint', value, cons));
      if (pick) set('hint', pick, 'hint');
    }

    // Formulas: wrap in place, field by field (delimiters never change meaning, so the blueprint-bound answer, option texts and rubric
    // take part too: the author cannot fix those and the card would be dropped for it); a field that still shows bare TeX stays as it was.
    // Cloze text and answers, citations and ids are never touched.
    const wrap = (field, rule = 'formula') => {
      const next = wrapBareMath(card[field]);
      if (next !== card[field]) set(field, next, rule);
    };
    for (const field of ['topic', 'prompt', 'hint', 'explanation', 'misconception', 'rubric']) {
      if (field === 'prompt' && card.kind === 'cloze') continue;
      wrap(field);
    }
    if (Array.isArray(card.options)) {
      const before = card.options, options = wrapChoiceOptions(before);
      options.forEach((option, index) => {
        for (const key of ['text', 'explanation'])
          if (option?.[key] !== before[index]?.[key]) fixes.push({ cardId: card.id, field: `options.${index}.${key}`, rule: 'formula' });
      });
      if (options.some((option, index) => option !== before[index])) card = { ...card, options };
      // The answer of a choice card is its correct option's text: it follows that option instead of being wrapped on its own.
      const at = before.findIndex(option => option?.correct === true && norm(option.text) === norm(card.answer));
      if (card.kind !== 'cloze') {
        if (at >= 0 && typeof options[at]?.text === 'string') { if (options[at].text !== card.answer) set('answer', options[at].text, 'formula'); }
        else wrap('answer');
      }
    } else if (card.kind !== 'cloze') wrap('answer');
    return card;
  });
  return { deck: { ...deck, cards: out }, fixes };
}
