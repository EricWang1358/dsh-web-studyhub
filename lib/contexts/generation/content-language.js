/* The content language of new questions (#1002): what a resolved request language means, the ONE instruction every stage that writes or judges learner-facing
   text is sent, and the ONE deterministic check that a card is written in it. The language of new questions is decided once, in lib/generation-settings.js
   (resolveGenerationRequest). Questions for an existing deck or made from an existing card follow ONE order (questionLanguage, below), which
   lib/generation-settings.js deckContentLanguage feeds with the setting. Everything else only reads the value. Pure: no model call, no state.

   The languages (the 出题语言 setting, ui/generate-form.js LANGUAGES):
     English    every learner-facing field in English, whatever the language of the sources;
     中文       every learner-facing field in Chinese;
     中英双语   Chinese is the main language of every field, and the stem also gives its English translation (a cloze sentence stays one Chinese sentence);
                a key term carries its English name in parentheses. The setting itself only says "Chinese & English" (ui/locales/en.json) and nothing else
                defines it for the learner, so this is the rule the model is asked for, and the check accepts any layout of the two (see notBilingual). The
                program already treats Chinese as the main side (card-autofix and fallback titles use it), and the book writer names a term 中文（English）.
   Anything else an API client typed (free-form, e.g. a third language) is asked for as written and never checked. */

const LANGUAGE_NAME_LIMIT = 40;

/** What a resolved request language means: 'en', 'zh', 'both', 'other', or null when no language was given (a direct caller that resolved nothing). */
export function contentLanguage(language) {
  const text = typeof language === 'string' ? language.trim() : '';
  if (!text) return null;
  if (/^(?:en\b|english)/i.test(text)) return 'en';
  if (text === '中英双语' || /bilingual/i.test(text)) return 'both';
  if (text === '中文' || /^(?:zh\b|chinese)/i.test(text)) return 'zh';
  return 'other';
}

const FIELDS = 'deck title, topic, objective, stem, answer, every option and its explanation, hint, explanation, misconception, rubric, cloze sentence and blank values';
const WHATEVER = 'whatever the language of the sources, the focus, the course rules or these instructions';
/** Every model call also carries the interface language preference (lib/language.js); for the questions themselves this rule decides. */
const OUTRANKS = 'This rule holds over any interface language preference.';

/** The one instruction about the content language, the same words for every stage of every path; '' when no language was resolved. */
export function languageRule(language) {
  const meaning = contentLanguage(language);
  if (meaning === 'en') return `Content language: English. Write every learner-facing field (${FIELDS}) in English, ${WHATEVER}: render the knowledge in English instead of copying the source wording. Only citation quotes stay verbatim in the source language; a proper noun, code or a formula may stay as written, and a source term may follow its English rendering once in parentheses. ${OUTRANKS}`;
  if (meaning === 'zh') return `Content language: Chinese (中文). Write every learner-facing field (${FIELDS}) in Simplified Chinese, ${WHATEVER}: render the knowledge in Chinese instead of copying the source wording. Only citation quotes stay verbatim in the source language; a technical term, a proper noun, code or a formula may stay as written. ${OUTRANKS}`;
  if (meaning === 'both') return `Content language: Chinese with English (中英双语). Chinese is the main language of every learner-facing field (${FIELDS}), ${WHATEVER}. The stem gives its Chinese text and then its English translation; a key technical term carries its English name in parentheses at its first mention; options, answer and blank values stay short, in Chinese with an English term in parentheses where it helps; a cloze sentence stays one Chinese sentence. Only citation quotes stay verbatim in the source language. ${OUTRANKS}`;
  if (meaning === 'other') {
    const name = language.trim().slice(0, LANGUAGE_NAME_LIMIT);
    return `Content language: ${name}. Write every learner-facing field (${FIELDS}) in ${name}, ${WHATEVER}. Only citation quotes stay verbatim in the source language. ${OUTRANKS}`;
  }
  return '';
}

/** A stage's system text with the language rule after it (one line: the system text of a sources-first prompt ends at its first blank line, lib/prompt-order.js). */
export const withContentLanguage = (system, language) => {
  const rule = languageRule(language);
  return rule ? `${system} ${rule}` : system;
};

/* ---------- the deterministic check ---------- */

const HAN = /\p{Script=Han}/gu;
/** Text without code and formulas, which are words of no language. */
const withoutCodeAndFormulas = (value) => String(value ?? '')
  .replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  .replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ').replace(/\\\[[\s\S]*?\\\]/g, ' ');
/** The text the English check reads: quotations and bracketed glosses may also be in the source language, so they are taken out too. */
const prose = (value) => withoutCodeAndFormulas(value)
  .replace(/“[^”]*”|"[^"\n]*"|「[^」]*」|『[^』]*』|‘[^’]*’|《[^》]*》/g, ' ')
  .replace(/\([^()]*\)|（[^（）]*）/g, ' ');
const hanCount = (text) => (text.match(HAN) || []).length;
const longestHanRun = (text) => Math.max(0, ...(text.match(/\p{Script=Han}+/gu) || []).map((run) => [...run].length));
const latinWords = (text) => (text.match(/[A-Za-z]{2,}/g) || []).length;

/** Text meant to be English that is not: a Chinese phrase (five characters in a row) or more Chinese characters than English words. A short proper noun passes. */
export const notEnglish = (value) => {
  const text = prose(value), han = hanCount(text);
  return longestHanRun(text) >= 5 || (han >= 2 && han > latinWords(text));
};
/** The language a card's stem is written in, '中文' or 'English', or null when it has no words (code and formulas are no language: 「求 $\int x dx$」 is Chinese). */
const stemLanguage = (card) => {
  const text = prose(card?.prompt), han = hanCount(text);
  if (!han && !latinWords(text)) return null;
  return longestHanRun(text) >= 5 || han > latinWords(text) ? '中文' : 'English';
};
/**
 * The language of new questions for an existing deck (补题: a passage added to it) or made from an existing card (a variant, a rewrite after feedback,
 * 修题, 出成题), in this order:
 *   1. `asked`     the language the caller asked for;
 *   2. the language the deck was generated in (editorial.generation.language);
 *   3. the language of the card the questions are made from (an imported deck has no record);
 *   4. `fallback`  the 出题语言 setting as a run resolves it (auto: the interface language); undefined when the caller has no setting.
 * A deck and a card keep their language before today's setting, so changing the setting or the interface never turns an English deck's variant Chinese.
 */
export const questionLanguage = ({ asked, deck, card, fallback } = {}) =>
  asked || deck?.editorial?.generation?.language || stemLanguage(card) || fallback || undefined;
/** A bilingual stem that lacks one of its two languages. Any layout of the two counts (the English in brackets, a second sentence, a short English stem:
    「什么是闭包？(What is a closure?)」「定义熵。Define entropy.」); only code and formulas are not words of either. */
const notBilingual = (value) => { const text = withoutCodeAndFormulas(value); return hanCount(text) < 2 || latinWords(text) < 2; };
/** A flashcard front may be just the term, and a cloze sentence stays one Chinese sentence: their stems are not checked for both languages. */
const ONE_LANGUAGE_STEM = new Set(['flashcard', 'cloze']);

/* Chinese is asked for (languageRule) but not checked: English material studied with the default 中文 often keeps an English term or a whole English
   formula sentence, and an English stem in a Chinese run is a lesser harm than a sound question held back. */
const LABEL = { en: 'English', both: 'Chinese with English' };
/** The phrase every language issue carries (ui/quality-reasons.js and lib/generation-yield.js read it). */
export const LANGUAGE_ISSUE = 'is not in the requested content language';
/** The version of this check a run's questions were written for, recorded with its language (editorial.generation.languageCheck). */
export const LANGUAGE_CHECK = 1;
/** The language publication checks a draft against: none for a draft generated before the check existed, which was never asked for the rule. */
export const checkedLanguage = (generation) => generation?.languageCheck ? generation.language : null;

/** The learner-facing text of a card, by the field name an issue reports (an option by its id; the correct one is named so, since a repair may not touch it). */
function fieldsOf(card) {
  const out = [];
  const add = (name, value) => { if (typeof value === 'string' && value.trim()) out.push([name, value]); };
  for (const key of ['topic', 'prompt', 'answer', 'hint', 'explanation', 'misconception', 'rubric']) add(key, card[key]);
  for (const option of Array.isArray(card.options) ? card.options : []) {
    if (!option || typeof option !== 'object') continue;
    const name = `${option.correct === true ? 'correct option' : 'option'} ${option.id}`;
    add(name, option.text); add(name, option.explanation);
  }
  if (card.cloze && typeof card.cloze === 'object') {
    add('cloze', card.cloze.text);
    for (const blank of Array.isArray(card.cloze.answers) ? card.cloze.answers : []) add('cloze', blank?.value);
  }
  for (const criterion of Array.isArray(card.rubricCriteria) ? card.rubricCriteria : []) { add('rubric', criterion?.label); add('rubric', criterion?.descriptor); }
  return out;
}

/**
 * Every card field that is not in the requested content language, as `Card N: <field> is not in the requested content language (<language>)`.
 * English: any learner-facing field with substantial Chinese text. 中英双语: a stem (not a cloze or a flashcard) needs both its Chinese and its English; the other
 * fields may be Chinese only. Nothing for Chinese (see LABEL), a free-form or an unresolved language.
 */
export function languageIssues(deck, language) {
  const meaning = contentLanguage(language);
  if (!LABEL[meaning]) return [];
  return (Array.isArray(deck?.cards) ? deck.cards : []).flatMap((card, index) => {
    if (!card || typeof card !== 'object') return [];
    const wrong = new Set();
    if (meaning === 'en') for (const [name, value] of fieldsOf(card)) { if (notEnglish(value)) wrong.add(name); }
    else if (typeof card.prompt === 'string' && card.prompt.trim() && !ONE_LANGUAGE_STEM.has(card.kind) && notBilingual(card.prompt)) wrong.add('prompt');
    return [...wrong].map((name) => `Card ${index + 1}: ${name} ${LANGUAGE_ISSUE} (${LABEL[meaning]})`);
  });
}
