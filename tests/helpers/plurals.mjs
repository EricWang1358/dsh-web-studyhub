/* The English counts of the catalogue (#1073 round 8): a count placeholder followed, anywhere in the value, by a plural noun ("{0} questions", "about {1}
   minutes", "{0}/{1} pages done"), and whether the catalogue gives that count its singular. ui/i18n.js uiFormat (and uiRich) take `<key>#one` when {0} is 1,
   `<key>#one:N` when {N} is 1, and `<key>#one:N,M` when both are, so "1 question" is right wherever the key shows a count. */

/** Words that may stand between the count and its noun ("{0} more due cards", "{1} uncovered sections"). */
const BETWEEN = '(?:more|new|other|further|extra|different|unanswered|missed|open|wrong|due|weak|ungrouped|uncovered|selected|possible|knowledge|practice|retry|reference|model|mid-run|personalised|doubtful|matching|prerequisite|optional|side|conversion|active|recent|focus|retrieval|PDF|AI|text|audio|study|review|exam|sample|draft|deck|card|unread|failed|running|queued|archived|pinned|whole|full|short|long|English|Chinese|unfinished|finished|correct|marked|cited|existing|transcription|examiner-guidance|linked|to-do)';
/** A count and its plural noun: `{N}` (or the whole of `{a}/{N}`), the words between, the noun ending in s (or the old "noun(s)"). A range `{a}–{N}` is
    skipped: "pages 3–3" does not happen. */
const COUNTED = new RegExp(`(?<![–-]\\s?)(?:\\{\\d+\\}\\s?/\\s?)?\\{(\\d+)\\}(?!\\s?[–-])((?:\\s+${BETWEEN})*\\s+)([A-Za-z-]*[a-z])(\\(s\\)|s\\b)`, 'g');
/** Words ending in s that are not plurals (verbs after a count, "is", "this", "process"…). */
const NOT_PLURAL = /^(?:is|was|has|does|its|this|appears|needs|plus|minus|yes|as|us|his|thus|less|always|across|gets|takes|makes|starts|goes|remains|stays|contains|shows|means|runs|uses|covers|leads|reads|keeps|lists|counts|turns|comes|becomes|seems|lets|falls|brings|holds|asks|tries|misses|passes|adds|stops|waits|works|fails|finishes|opens|closes|says|tells|puts|sets|gives|tracks|checks|marks|series|species|analysis|basis|status|focus|bonus|process|access|progress|success|class|pass|miss)$/i;

/** The counts of an English value that a plural noun follows: [{ index, noun }]. */
export function countedNouns(value) {
  const found = [];
  for (const match of String(value).matchAll(COUNTED)) {
    const noun = match[3] + (match[4] === 's' ? 's' : '(s)');
    if (match[4] === 's' && (NOT_PLURAL.test(noun) || /ss$/.test(noun))) continue;
    found.push({ index: Number(match[1]), noun });
  }
  return found;
}

export const SINGULAR_KEY = /#one(?::\d+(?:,\d+)*)?$/;
/** The singular key of the counts `indices` of `key`: `#one` for {0} alone, else `#one:N,M`. */
export const singularKey = (key, indices) => `${key}#one${indices.length === 1 && indices[0] === 0 ? '' : `:${[...indices].sort((a, b) => a - b).join(',')}`}`;

/** The counts of `key` (with a plural after them) that have no singular in the catalogue: each count needs its own form, and two or more counts the form for all of them. */
export function missingSingulars(catalogue, key) {
  const indices = [...new Set(countedNouns(catalogue[key]).map(({ index }) => index))];
  const missing = indices.filter((index) => !Object.hasOwn(catalogue, singularKey(key, [index])));
  if (indices.length > 1 && !Object.hasOwn(catalogue, singularKey(key, indices))) missing.push(indices.join(','));
  return missing;
}
