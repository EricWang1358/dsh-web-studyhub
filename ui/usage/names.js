import { uiCatalogue } from '../i18n.js';

/* A control's name, in a form that is the same in Chinese and in English and carries nothing but the app's own copy.

   The Chinese source string of every sentence the app can show is the key of the English catalogue (ui/i18n.js). A name found on the page is
   normalised (spacing, numbers → N, decorative arrows and ellipses off the ends) and looked up in the catalogue, in either language; a hit
   resolves to ONE canonical Chinese string (the first source whose English reads the same), a miss resolves to nothing. So a deck, a source, a
   course, a file or anything the learner wrote can never become part of a key: it is not in the catalogue. `开始做这 12 道题` and
   "Start these 12 questions" both resolve to `开始做这 N 道题`.

   The index is built the first time a name is asked for, which only happens once the record is on. */

const NUMBER = /\{\d+\}|\d+(?:[.,:：]\d+)*/g;
const EDGE = /^[\s←→+＋◈·•▸›»«]+|[\s→…›»«:：]+$/gu;
const LONGEST = 80;

export const normalizeName = text => (typeof text === 'string'
  ? text.replace(/\s+/g, ' ').trim().replace(NUMBER, 'N').replace(EDGE, '').replace(/\s+/g, ' ').trim() : '');
const meaningful = name => name.length > 0 && name.length <= LONGEST && /\p{L}/u.test(name.replace(/\bN\b/g, ''));

let index = null;
function build() {
  const english = new Map(), zhCanonical = new Map(), display = new Map(), catalogue = uiCatalogue();
  const entries = Object.entries(catalogue).map(([zh, en]) => [normalizeName(zh), normalizeName(en)]).filter(([zh, en]) => meaningful(zh) && meaningful(en));
  for (const [zh, en] of entries) if (!english.has(en)) english.set(en, zh);
  for (const [zh, en] of entries) { if (!zhCanonical.has(zh)) zhCanonical.set(zh, english.get(en)); if (!display.has(english.get(en))) display.set(english.get(en), en); }
  return { english, zhCanonical, display };
}

/** The canonical (Chinese, numbers as N) form of a name, or null when the text is not one of the app's own sentences. */
export function canonicalName(text) {
  const name = normalizeName(text);
  if (!meaningful(name)) return null;
  index ||= build();
  return index.zhCanonical.get(name) ?? index.english.get(name) ?? null;
}

/** A canonical name to show: itself in Chinese, the English copy of it in English (numbers still N). */
export function displayName(canonical, language) {
  if (language !== 'en') return canonical;
  index ||= build();
  return index.display.get(canonical) ?? canonical;
}

/** For tests and a language switch: forget the index. */
export const resetNames = () => { index = null; };
