import { mainlyChinese } from '../lib/live-correction-settings.js';

/* How the live page shows text it does not own: spacing and punctuation between Chinese characters (the recogniser writes a space between every word, and
   half-width marks), whether a sentence is Chinese, and the "recent part" the selection bar picks. Display only: nothing here changes a stored sentence. */

const HAN = '[㐀-鿿]';
const FULL = { ',': '，', '.': '。', '?': '？', '!': '！', ';': '；', ':': '：' };

/**
 * The text as a reader should see it: no spaces between two Chinese characters, and a half-width , . ? ! ; : that follows a Chinese character written as the
 * full-width mark (with no space around it). English, numbers (3.5) and the spaces around Latin words are left alone. Idempotent; '' for nothing.
 */
export function tidyCjk(text) {
  const value = String(text ?? '');
  if (!new RegExp(HAN).test(value)) return value;
  return value
    .replace(new RegExp(`(?<=${HAN})\\s*([,?!;:])`, 'g'), (_all, mark) => FULL[mark])
    .replace(new RegExp(`(?<=${HAN}|[，？！；：])\\s*\\.(?!\\d)(?=\\s|$|${HAN})`, 'g'), '。')
    .replace(new RegExp(`(?<=${HAN}|[，。？！；：、])[^\\S\\n]+(?=${HAN}|[，。？！；：、])`, 'g'), '')
    .replace(/(?<=[，。？！；：])[^\S\n]+(?=\S)/g, '');
}

/** A sentence that is mainly Chinese is read as it is (the same rule as the translation step, lib/live-correction-settings.js). */
export const isChinese = segment => mainlyChinese(segment.en);

/** Whether a Chinese line stands under the sentence: not for a sentence that is Chinese already, nor where nothing is translated (zhState 'none'). */
export const showsTranslation = segment => segment.zhState !== 'none' && !isChinese(segment);

/** 最近一段: about this many characters of the newest sentences, a number of sentences that follows how long they are. */
export const RECENT_CHARS = 1200;

/** The newest sentences whose text adds up to at most RECENT_CHARS, and never fewer than the newest one (even when it alone is longer). */
export function recentWindow(segments, limit = RECENT_CHARS) {
  const picked = [];
  let chars = 0;
  for (let index = segments.length - 1; index >= 0; index--) {
    const length = String(segments[index].en || '').length;
    if (picked.length && chars + length > limit) break;
    picked.unshift(segments[index]); chars += length;
  }
  return picked;
}
