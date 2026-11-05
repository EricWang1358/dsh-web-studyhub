/* Choice options a learner can rule out without knowing the content (owner, 2026-11-05: 「选项还是有一点点太容易区分错误了」).
   Pure, no imports: the answer stage, the 为你定制 variants and the reviewer share DISTRACTOR_RULE, and the program sends back what
   it can see without a model (`optionCueIssues`: one line per cue, shaped like every other `Card N:` gate line).

   Research behind the rule: Haladyna, Downing & Rodriguez (2002), "A review of multiple-choice item-writing guidelines": every
   distractor plausible and written from typical student errors, options homogeneous in content, grammar and length, and none of the
   cues a test-wise student uses (the correct option longest or most qualified, a stem word echoed only by it, absolute words only in
   wrong options, absurd or joke options, "all/none of the above"). Recent LLM work (arXiv 2603.15547, "Can LLMs Model Incorrect
   Student Reasoning?") finds model distractors valid but not the errors real learners make: solve the item first, then simulate
   named misconceptions, then pick the set.

   Only a clear mechanical cue is a blocker; every fuzzy one (a joke option, a weak distractor, a missing misconception) is the
   reviewer's, never a program rejection. */

export const DISTRACTOR_WRITING = "Choice options: decide the correct answer first, then write each wrong option as one specific "
  + "misconception or typical error a learner of THIS material holds (prefer the material's own warnings and confusable concepts; for "
  + "numbers a unit slip, sign error, wrong formula or off-by-one step), and let its explanation name that misconception. Keep all "
  + "options the same type, grammar, length and detail.";
export const DISTRACTOR_CUES = "A learner who does not know the content must not be able to rule an option out by a cue: the correct "
  + "option longest or most qualified, a stem phrase repeated only in it, an absolute word (always/never/一定/所有) only in wrong "
  + "options, an absurd or joke option, a repeated option, or \"all/none of the above\" (以上都…).";
/** The one rule for choice options: the answer stage writes by it, 为你定制 variants too, and the reviewer fails a card that breaks it. */
export const DISTRACTOR_RULE = `${DISTRACTOR_WRITING} ${DISTRACTOR_CUES}`;

/** The correct option must be longer than every wrong one by this ratio AND by this many characters (not spaces) to count as an
 * outlier. Simulated (200 000 sets of 4-5 options with log-normal lengths around 30 characters, one distribution for all): ratio 1.5
 * and gap 10 flag 1.5-2.4% of sets at spread 0.25 and 3.6-5.4% at 0.35, where 1.4 and 8 would flag 2.5-3.9% and 5.0-7.4%; 1.6 and
 * 12 would miss more of the clear ones. A gap in a short option (O(n) against O(n log n)) is never a cue, hence the gap. */
export const LENGTH_RATIO = 1.5;
export const LENGTH_GAP = 10;
/** How many wrong options must carry an absolute word, with none in the correct ones, before it is a cue: one is a style choice. */
export const ABSOLUTE_WRONG = 2;
/** The least a stem phrase echoed only by the correct option must weigh: six CJK characters or ten others (a term, not a common word). */
export const ECHO_WEIGHT = 10;

const FLAT = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/`/g, "");
const LABEL = /^(?:选项\s*)?[(（]?[a-f][)）.、:：]\s*/;
const EDGE = /^[\s.,;:!?。，；：！？、"'“”‘’()（）《》「」『』]+|[\s.,;:!?。，；：！？、"'“”‘’()（）《》「」『』]+$/g;
/** An option without what is no part of the answer: case and width, a letter label ("A."), spaces, the punctuation around it. */
const canon = (text) => FLAT(text).trim().replace(LABEL, "").replace(EDGE, "").replace(/\s+/g, "");
const size = (text) => FLAT(text).replace(/\s/g, "").length;

const CATCHALL = [
  /(?:以上|上述|前述)(?:各项|各选项|选项|所有|全部|说法|答案|几项|两项|三项)?(?:都|皆|均|全|全部|全都)/u,
  /(?:都|均|皆|全)不(?:正确|对|是|成立)|均不(?:正确|对)/u,
  /[a-f]\s*(?:和|与|及|、|,|，)\s*[a-f]\s*(?:都|均|皆|同时)\s*(?:对|正确|成立|是)/iu,
  /\b(?:all|none|neither|both)\s+of\s+(?:the\s+)?(?:above|these|those|them|the\s+options)\b|\b(?:all|none)\s+(?:of\s+)?the\s+above\b/iu,
  /\bnone\s+of\s+these\b|\bboth\s+[a-f]\s+(?:and|&)\s+[a-f]\b|\b[a-f]\s+(?:and|&)\s+[a-f]\s+(?:are\s+)?(?:both\s+)?(?:correct|true|right)\b/iu,
];
// Words that make a claim too strong to be true; 一定的 / 绝对值 / 完全二叉树 are ordinary terms and are left out.
const ABSOLUTE = [
  /一定(?!的|程度|范围|条件|数量|比例|时间|规模|量|数)|必定|总是|永远|始终|从不|绝不|无一例外|毫无例外|任何情况下|百分之百|不可能/u,
  /绝对(?!值|路径|地址|误差|零度|温度|引用|时间|定位)/u,
  /\b(?:always|never|invariably|absolutely|impossible|without exception|in all cases|under no circumstances|every single)\b|\b100\s?%/iu,
];
const hasAbsolute = (text) => ABSOLUTE.some((pattern) => pattern.test(FLAT(text)));
// What every stem is made of and so echoes nothing: the question words and the frame of a "which of the following" stem.
const STEM_FRAME = new RegExp("下列|以下|下面|关于|哪一个|哪一项|哪个|哪项|哪种|哪些|正确的是|错误的是|不正确的是|说法|描述|叙述|表述|是什么|什么|为什么|如何|怎样|请问|"
  + "\\b(?:which|what|why|how|when|where|who|does|do|is|are|was|were|of|the|a|an|to|in|on|for|and|or|following|statements?|correct|incorrect|"
  + "true|false|best|most|about|describes?|difference|between)\\b", "gu");
const CJK = /[㐀-鿿]/u;

/** The stretches of a text to compare: its segments between punctuation and frame words, spaces taken out. */
const segments = (text) => FLAT(text).replace(STEM_FRAME, "|").split(/[^\p{L}\p{N}\s+#]+/u).map((part) => part.replace(/\s+/g, "")).filter(Boolean);
const weight = (run) => [...run].reduce((sum, char) => sum + (CJK.test(char) ? 5 / 3 : 1), 0);

/** The runs of the stem that sit in `inside` and in none of `outside`, each at least ECHO_WEIGHT long (windows of 4 characters with CJK, 8 without). */
function echoes(stem, inside, outside) {
  const found = [];
  for (const part of segments(stem)) {
    const covered = new Array(part.length).fill(false);
    for (let at = 0; at < part.length; at++) {
      for (const width of [4, 8]) {
        const gram = part.slice(at, at + width);
        if (gram.length < width || CJK.test(gram) !== (width === 4)) continue;
        if (inside.includes(gram) && !outside.some((other) => other.includes(gram))) covered.fill(true, at, at + width);
      }
    }
    let from = -1;
    for (let at = 0; at <= part.length; at++) {
      if (covered[at] && from < 0) from = at;
      if (!covered[at] && from >= 0) {
        const run = part.slice(from, at);
        if (weight(run) >= ECHO_WEIGHT) found.push(run);
        from = -1;
      }
    }
  }
  return found;
}

/**
 * The cues of one quiz or multi card: `[{ code, message }]`, codes duplicate · catchall · length · absolute · clang. `stem: false`
 * skips the one cue that needs the written question (the answer stage has none yet). A card that is not a well-formed choice card
 * has none (the structural gate says what is wrong with it).
 */
export function optionCues(card, { stem = true } = {}) {
  const all = Array.isArray(card?.options) ? card.options : [];
  const options = all.filter((option) => typeof option?.text === "string" && typeof option.correct === "boolean");
  if (!["quiz", "multi"].includes(card?.kind) || options.length < 3 || options.length !== all.length) return [];
  const cues = [], right = options.filter((option) => option.correct), wrong = options.filter((option) => !option.correct);
  const ids = (list) => list.map((option) => option.id).join(", ");
  const seen = new Map();
  for (const option of options) {
    const key = canon(option.text);
    if (key && seen.has(key)) cues.push({ code: "duplicate", message: `options ${seen.get(key)} and ${option.id} are the same text; every option must be a different answer` });
    else seen.set(key, option.id);
  }
  for (const option of options)
    if (CATCHALL.some((pattern) => pattern.test(FLAT(option.text))))
      cues.push({ code: "catchall", message: `option ${option.id} is "all/none of the above" or a combination of other options; `
        + "replace it with a concrete answer that stands alone" });
  if (right.length && wrong.length) {
    const shortestRight = Math.min(...right.map((option) => size(option.text)));
    const longestWrong = Math.max(...wrong.map((option) => size(option.text)));
    if (shortestRight >= longestWrong * LENGTH_RATIO && shortestRight - longestWrong >= LENGTH_GAP)
      cues.push({ code: "length", message: `the correct option is clearly longer than every wrong one (${shortestRight} against at most `
        + `${longestWrong} characters); give the wrong options as much detail, or shorten the correct one` });
    const loud = wrong.filter((option) => hasAbsolute(option.text));
    if (loud.length >= ABSOLUTE_WRONG && !right.some((option) => hasAbsolute(option.text)))
      cues.push({ code: "absolute", message: `wrong options ${ids(loud)} use an absolute word (always, never, 一定, 总是…) that the correct `
        + "option does not; write them as believable near-misses worded like it" });
  }
  if (stem && typeof card.prompt === "string" && right.length === 1) {
    const echo = echoes(card.prompt, segments(right[0].text).join("|"), wrong.map((option) => segments(option.text).join("|")));
    if (echo.length) cues.push({ code: "clang", message: `the stem's wording "${echo[0]}" is repeated only in the correct option ${right[0].id}; `
      + "leave it out of that option or use the same terms in the wrong ones" });
  }
  return cues;
}

/** The cues of every choice card of a deck as gate lines, `Card 2: option cue (length): …` (what generation sends back, like clozeIssues). */
export function optionCueIssues(deck, options) {
  return (Array.isArray(deck?.cards) ? deck.cards : []).flatMap((card, index) =>
    optionCues(card, options).map((cue) => `Card ${index + 1}: option cue (${cue.code}): ${cue.message}`));
}

/** The pattern of those lines (the repair path reads it to know the options are what to rewrite). */
export const OPTION_CUE_ISSUE = /^Card \d+: option cue \((\w+)\)/;
