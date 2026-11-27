import { id as defaultId } from '../../util.js';
import { findCard } from '../../prereq.js';
import { contentKey } from '../../card-content.js';
import { TEACHING_MODEL_TIMEOUT_MS } from '../../teaching.js';
import { evidenceWindows } from '../../coach.js';
import { assistanceEvidence } from '../../study-progress.js';
import { GRADING_BUSY, gradingPending } from './grading-marker.js';
import { SOCRATIC_STAGES, SOCRATIC_MAX_HINT_LEVEL } from './socratic-record.js';
import { askTutor, tutorPayload } from './socratic-tutor.js';

export { SOCRATIC_STAGES, SOCRATIC_MAX_HINT_LEVEL } from './socratic-record.js';
export const SOCRATIC_MAX_TURNS = 24;
export const SOCRATIC_MAX_INPUT_CHARS = 4000;

const STAGE_SET = new Set(SOCRATIC_STAGES);

const normalizeText = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
const collapseSpaces = (value) => normalizeText(value).replace(/\s+/g, ' ');
const resolveLanguage = (lang) => (/^en/i.test(String(lang ?? '').trim()) ? 'en' : 'zh');

function referenceAnswerOf(card) {
  if (!card) return '';
  if (typeof card.answer === 'string' && card.answer.trim()) return card.answer.trim();
  if (Array.isArray(card.options) && card.options.length) {
    const right = card.options.filter((opt) => opt?.correct).map((opt) => collapseSpaces(opt.text || opt.id)).filter(Boolean);
    if (right.length) return right.join('；');
  }
  if (card.cloze && Array.isArray(card.cloze.answers) && card.cloze.answers.length) {
    return card.cloze.answers.map((entry) => collapseSpaces(entry?.value || entry?.text || '')).filter(Boolean).join('；');
  }
  if (typeof card.explanation === 'string' && card.explanation.trim()) return card.explanation.trim();
  return '';
}

/** The entry of this question in the round that already has a verdict (the newest, for a question asked again at the tail). */
function answeredEntry(run, deck, card) {
  return (run?.entries || []).findLast((entry) => (entry.deckId ?? run.deckId) === deck.id && entry.card?.id === card.id && entry.feedback) || null;
}

/** What the learner actually handed in on this question in this round, for the tutor to start from. Null while unanswered. */
function roundAnswerOf(run, deck, card) {
  const entry = answeredEntry(run, deck, card);
  if (!entry) return null;
  const { feedback } = entry;
  const asked = entry.card?.options || card.options || [];
  const chose = (Array.isArray(feedback.selected) ? feedback.selected : [])
    .map((picked) => collapseSpaces(asked.find((option) => option.id === picked)?.text || picked));
  const typed = [entry.response, ...Object.values(feedback.answers || {})].filter((value) => typeof value === 'string' && value.trim()).join('；');
  return {
    correct: typeof feedback.correct === 'boolean' ? feedback.correct : null,
    ...(chose.length ? { chose } : {}),
    ...(typed ? { typed: typed.slice(0, 1000) } : {}),
  };
}

/** The first line costs no model call. It says what the learner can do, and starts from the verdict when this round already has one. */
export function buildCardOpeningQuestion(card, language = 'zh', roundAnswer = null) {
  const en = resolveLanguage(language) === 'en';
  if (roundAnswer?.correct === false) {
    return en
      ? 'This one did not come out right. What were you thinking when you answered? We can work back from there.'
      : '刚才这题没答对。说说你当时是怎么想的？我们从那儿往回找。';
  }
  if (roundAnswer?.correct === true) {
    return en
      ? 'You got it. Can you say why it holds? If part of it still feels shaky, just ask.'
      : '刚才答对了。能说说为什么是这个答案吗？哪里还没把握，也可以直接问。';
  }
  return en
    ? 'No need to see the answer yet. Tell me how you are thinking about it, even half-formed. If anything in the question is unclear, just ask.'
    : '先不急着看答案。说说你现在是怎么想的，想到哪说到哪；题目里哪儿看不懂，也可以直接问我。';
}

export function buildRevealMessage(card, language = 'zh') {
  const en = resolveLanguage(language) === 'en';
  const answer = referenceAnswerOf(card);
  const explanation = collapseSpaces(card?.explanation || '');
  return [
    answer ? (en ? `**Reference answer**: ${answer}` : `**参考答案**：${answer}`) : (en ? 'This question has no stored reference answer.' : '这道题没有存参考答案。'),
    explanation && explanation !== answer ? (en ? `**Why**: ${explanation}` : `**为什么**：${explanation}`) : '',
  ].filter(Boolean).join('\n\n');
}

/* A bare acknowledgement, or the tutor's or the reference's words handed back, is never an explanation in the learner's own words,
   whatever the model says: this is the one thing the round's record must not take on trust. */
/** Words that carry no reasoning: saying one understood, the fillers before it, the thanks and particles after it. Spaces are dropped before matching. */
const NO_REASONING_WORDS = Object.freeze([
  '懂', '知道', '明白', '会', '理解', '清楚', '是', '对', '行', '好', '的', '我', '嗯', '哦', '噢',
  '了', '啦', '啊', '呀', '哈', '吧', '呢', '嘛', '吗', '谢谢', '谢啦',
  'i', 'it', 'see', 'get', 'got', 'now', 'understood', 'understand', 'makes', 'sense', 'yes', 'yeah', 'yep', 'sure', 'right', 'ok', 'okay',
  'thanks', 'thank', 'you', 'thx',
]);
const ONLY_NO_REASONING = new RegExp(`^(?:${[...NO_REASONING_WORDS].sort((a, b) => b.length - a.length).join('|')})+$`, 'u');
/** The text with punctuation, symbols and spaces taken out, lower-cased: what is left is what was said. */
const wordsOnly = (text) => collapseSpaces(text).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
/** 「我懂了」「懂了，谢谢」「ok got it thanks」: nothing is left once the no-reasoning words are taken out. */
const isBareAcknowledgement = (text) => {
  const said = wordsOnly(text);
  return !said || ONLY_NO_REASONING.test(said);
};
const ECHO_MIN_CHARS = 12;
const squash = (value) => collapseSpaces(value).replace(/[\s*`>#]/g, '').toLowerCase();

function isOwnExplanation(text, card, turns) {
  const said = squash(text);
  if (!said || isBareAcknowledgement(text)) return false;
  if (said.length < ECHO_MIN_CHARS) return true;
  const others = [referenceAnswerOf(card), card.explanation, ...(turns || []).filter((turn) => turn.role !== 'learner').map((turn) => turn.text)];
  return !others.some((other) => squash(other).includes(said));
}

const SHORTEST_QUOTABLE_ANSWER = 8;

/**
 * The reference answer or a right option, word for word, in a reply: the answer was shown, whatever the model says it gave. It only ever adds help.
 * Words the learner said first are theirs: a tutor repeating them back (「你说对了的那一点是…」) shows nothing.
 */
function statesAnswer(reply, card, learnerWords) {
  const said = squash(reply);
  const theirs = learnerWords.map(squash);
  const answers = [referenceAnswerOf(card), ...(card.options || []).filter((option) => option?.correct).map((option) => option.text)];
  return answers.map(squash).some((answer) => answer.length >= SHORTEST_QUOTABLE_ANSWER && said.includes(answer) && !theirs.some((words) => words.includes(answer)));
}

const learnerWordsOf = (turns) => (turns || []).filter((turn) => turn.role === 'learner').map((turn) => turn.text);

/** What a model's reply was made from. If any of it has changed by the time the reply arrives, the reply answers something that is gone. */
const basisOf = (card) => ({
  content: contentKey(card),
  startedAt: card.socratic?.startedAt ?? null,
  lastTurn: card.socratic?.turns?.at(-1)?.id ?? null,
});

function assertSameBasis(card, basis, lang) {
  if (!basis) return;
  const now = basisOf(card);
  if (Object.keys(basis).every((key) => basis[key] === now[key])) return;
  throw new Error(lang === 'en'
    ? 'The question or this conversation changed while the tutor was replying. Nothing was saved; send it again.'
    : '老师回复的时候，题目或这段对话刚刚变了。这一步没有保存，请再发一次。');
}

const SOCRATIC_STORED_HINT = Object.freeze({
  zh: (hint) => `题目自带的提示：${hint}`,
  en: (hint) => `The hint stored with this question: ${hint}`,
});

const NO_MODEL = Object.freeze({
  zh: '带学对话需要模型：请先在设置里连接模型。参考答案和题目自带的提示不需要模型。',
  en: 'Tutoring needs a model: connect one in Settings first. The reference answer and the hint stored with the question need none.',
});

function appendTurn(record, turn) {
  record.turns ||= [];
  record.turns.push({
    id: turn.id || defaultId(),
    role: turn.role,
    kind: turn.kind,
    stage: STAGE_SET.has(turn.stage) ? turn.stage : record.stage,
    hintLevel: Number.isInteger(turn.hintLevel) ? turn.hintLevel : record.hintLevel,
    text: normalizeText(turn.text),
    at: turn.at || Date.now(),
  });
  if (record.turns.length > SOCRATIC_MAX_TURNS) {
    record.turns.splice(0, record.turns.length - SOCRATIC_MAX_TURNS);
  }
}

/** One verdict per opening a question can start with: unanswered, answered right, answered wrong. */
const OPENING_VERDICTS = Object.freeze([null, { correct: true }, { correct: false }]);

/**
 * The opening the drawer showed, when a first step names one this question can start with. The drawer reads the opening once; if the learner
 * answers afterwards, the record still starts from the line they saw, not from the new verdict. Anything else is not taken (null).
 */
function shownOpening(card, language, text) {
  const shown = normalizeText(text);
  if (!shown) return null;
  return OPENING_VERDICTS.map((verdict) => buildCardOpeningQuestion(card, language, verdict)).find((opening) => opening === shown) ?? null;
}

/** The record a first step starts: from the opening the drawer showed when it names a valid one, else from this round's verdict. */
const firstRecordOf = (card, args, { language, now, roundAnswer }) => createCardSocraticRecord(card, {
  language, now, roundAnswer, opening: shownOpening(card, resolveLanguage(language), args.opening),
});

export function createCardSocraticRecord(card, { language = 'zh', now = Date.now(), preserveMaxHint = 0, roundAnswer = null, opening = null } = {}) {
  const lang = resolveLanguage(language);
  const record = {
    version: 1,
    language: lang,
    stage: 'answer',
    hintLevel: 0,
    maxHintLevelUsed: Math.max(0, Math.min(SOCRATIC_MAX_HINT_LEVEL, Number(preserveMaxHint) || 0)),
    retellPassed: false,
    answeredCorrectly: false,
    revealed: false,
    currentAnswer: '',
    startedAt: now,
    updatedAt: now,
    turns: [],
    summary: null,
  };
  appendTurn(record, {
    role: 'tutor',
    kind: 'question',
    stage: 'ask',
    hintLevel: 0,
    text: opening || buildCardOpeningQuestion(card, lang, roundAnswer),
    at: now,
  });
  return record;
}

/** What the drawer is given. `hasHint`: the question carries its own hint, so a hint can be shown with no model. */
const viewOf = (deck, card, record, persisted) => ({
  deckId: deck.id,
  cardId: card.id,
  topic: card.topic || deck.title || '',
  prompt: card.prompt || '',
  hasHint: Boolean(collapseSpaces(card.hint || '')),
  persisted,
  state: record,
});

const runOf = (state, runId) => (runId ? (state.runs || []).find((item) => item.id === runId) || null : null);

/**
 * Pure read (0 model calls, 0 writes) for opening the inline drawer beside a question.
 * Returns the persisted `card.socratic` when present so an interrupted conversation resumes where it was.
 */
export function getCardSocraticView(state, ref = {}, { language = 'zh' } = {}) {
  const { deck, card } = findCard(state, ref, '这道题');
  const persisted = Boolean(card.socratic && typeof card.socratic === 'object');
  const record = persisted
    ? card.socratic
    : createCardSocraticRecord(card, { language, roundAnswer: roundAnswerOf(runOf(state, ref.runId), deck, card) });
  return viewOf(deck, card, record, persisted);
}

/**
 * Evaluates a step BEFORE committing it. A learner message, and a hint when a model is there, is one model call with the conversation so far;
 * the reference answer and the stored hint are read from the question. A call that gives no reply throws, so nothing is saved.
 */
export async function evaluateCardSocraticStep(state, args = {}, { complete = null, language = 'zh', timeoutMs = TEACHING_MODEL_TIMEOUT_MS } = {}) {
  const { deck, card } = findCard(state, args, '这道题');
  const run = openRunOf(state, args.runId);
  const roundAnswer = roundAnswerOf(run, deck, card);
  const existing = card.socratic || firstRecordOf(card, args, { language: args.language || language, roundAnswer });
  const lang = resolveLanguage(args.language || existing.language || language);
  const action = args.action === 'retell' || !args.action ? 'answer' : args.action;
  const model = args.offline === true || typeof complete !== 'function' ? null : complete;

  if (action === 'reset') return { action, language: lang };
  if (action === 'reveal') return { action, language: lang, reply: buildRevealMessage(card, lang), usedModel: false };

  const basis = basisOf(card);
  const ask = (request, message) => askTutor(model, tutorPayload({
    card,
    referenceAnswer: referenceAnswerOf(card),
    sources: Array.isArray(state?.sources) ? evidenceWindows(state.sources, [card], { radius: 800, budget: 3000 }) : [],
    roundAnswer,
    turns: existing.turns,
    request,
    message,
    answerMustStayHidden: gradingNow(run, deck, card),
    language: lang,
  }), { language: lang, timeoutMs });

  if (action === 'hint') {
    if (model) {
      const verdict = await ask('hint', '');
      const help = verdict.help === 'answer' || statesAnswer(verdict.reply, card, learnerWordsOf(existing.turns)) ? 'answer' : 'hint';
      return { action, language: lang, reply: verdict.reply, help, basis, usedModel: true };
    }
    const stored = collapseSpaces(card.hint || '');
    if (!stored) {
      throw new Error(lang === 'en'
        ? 'This question stores no hint. With a model connected the tutor can give one; the reference answer is also available.'
        : '这道题没有自带提示。连接模型后可以按你的思路给提示，也可以直接看参考答案。');
    }
    return { action, language: lang, reply: SOCRATIC_STORED_HINT[lang](stored), help: 'hint', usedModel: false };
  }

  const said = normalizeText(args.text ?? args.answer ?? args.input ?? '');
  if (!said) throw new Error(lang === 'en' ? 'Please enter your response first.' : '请先输入你的想法或回答再提交。');
  if (said.length > SOCRATIC_MAX_INPUT_CHARS) throw new Error(lang === 'en' ? 'Response is too long.' : '输入内容过长。');
  if (!model) throw new Error(NO_MODEL[lang]);
  const verdict = await ask('reply', said);
  return {
    action: 'answer',
    language: lang,
    text: said,
    reply: verdict.reply,
    understood: verdict.understood && isOwnExplanation(said, card, existing.turns),
    help: statesAnswer(verdict.reply, card, [...learnerWordsOf(existing.turns), said]) ? 'answer' : verdict.help,
    basis,
    usedModel: true,
  };
}

/** The open run a step names, if any. An exam in progress refuses tutoring outright: the drawer would answer its questions. */
function openRunOf(state, runId) {
  if (!runId) return null;
  const run = (state.runs || []).find((item) => item.id === runId);
  if (!run || run.closedAt) return null;
  if (run.mode === 'exam' && !run.submittedAt) throw new Error('Submit the exam before using Socratic tutoring');
  return run;
}

/** The reference answer waits for the grade like review.reveal does (#1031): not shown while an answer to this question is being graded. */
function gradingNow(run, deck, card) {
  return (run?.entries || []).some((entry) => (entry.deckId ?? run.deckId) === deck.id && entry.card?.id === card.id && gradingPending(entry));
}

function assertRevealNotGrading(run, deck, card) {
  if (gradingNow(run, deck, card)) throw new Error(GRADING_BUSY);
}

/** What the drawer has shown, in the words every other help path records (review.draft.save, study.scene.get, review.reveal). */
function socraticAssistance(record) {
  return {
    askedTutorBeforeAnswer: true,
    hintUsed: (record.hintLevel || 0) > 0,
    revealedBeforeAnswer: Boolean(record.revealed),
  };
}

/** The entries of this question in the run still waiting for an answer (no feedback, not being graded). No run: none. */
function waitingEntries(run, deck, card) {
  return (run?.entries || []).filter((entry) => (entry.deckId ?? run.deckId) === deck.id && entry.card?.id === card.id
    && !entry.feedback && !gradingPending(entry));
}

/**
 * The one rule (#1322 review): whatever the drawer shows before the question is answered is evidence on that answer. Each waiting entry of this
 * question in the run gets it, and review.answer then grades and records the answer as assisted like any other. An answered entry keeps what it proved.
 * With no run (the drawer outside a round) there is no answer to mark; the help stays on card.socratic. Evidence only adds up.
 */
function noteRunAssistance(run, deck, card, record) {
  const evidence = socraticAssistance(record);
  for (const entry of waitingEntries(run, deck, card)) entry.assistance = assistanceEvidence(entry.assistance, evidence);
}

/** A saved record shows help when it holds more than the opening question: a learner turn, a tutor reply, a hint level or the reference answer. */
const showsHelp = (record) => Boolean(record && (record.revealed || (record.hintLevel || 0) > 0
  || (record.turns || []).some((turn) => turn.kind !== 'question')));

/** Reopening the drawer shows the saved record again: the run's waiting question that would see that help (null when nothing is to be recorded). */
function reopenedHelp(state, ref) {
  const { deck, card } = findCard(state, ref, '这道题');
  const run = openRunOf(state, ref.runId);
  return showsHelp(card.socratic) && waitingEntries(run, deck, card).length ? { run, deck, card } : null;
}

/** Does opening the drawer for `ref` (with its runId) have help to record? Read-only; lets the caller skip a write when there is none. */
export const socraticViewRecordsHelp = (state, ref = {}) => Boolean(reopenedHelp(state, ref));

/** Records the saved help that opening the drawer shows on the run's waiting question, through the same rule as a step. No model call. */
export function recordSocraticViewHelp(state, ref = {}) {
  const target = reopenedHelp(state, ref);
  if (target) noteRunAssistance(target.run, target.deck, target.card, target.card.socratic);
}

/** Marks what a tutor reply gave away on the record. A reply that states the answer counts as the reference answer shown. */
function giveHelp(record, help, { run, deck, card }) {
  if (help === 'answer') {
    assertRevealNotGrading(run, deck, card);
    record.revealed = true;
    record.hintLevel = SOCRATIC_MAX_HINT_LEVEL;
  } else if (help === 'hint') {
    record.hintLevel = Math.min(SOCRATIC_MAX_HINT_LEVEL, (record.hintLevel || 0) + 1);
  } else return false;
  record.maxHintLevelUsed = Math.max(record.maxHintLevelUsed || 0, record.hintLevel);
  return true;
}

const TUTOR_KIND = Object.freeze({ hint: 'hint', answer: 'reveal', none: 'reply' });

/** How a closed conversation ended, from the help on the record so far. */
function closingSummary(record, lang) {
  const hintLevel = record.hintLevel || 0;
  const mastered = hintLevel === 0 && !record.revealed;
  return {
    mastered,
    needsReview: !mastered,
    hintLevel,
    maxHintLevelUsed: record.maxHintLevelUsed || hintLevel,
    nextStep: mastered
      ? (lang === 'en' ? 'Return to the question and finish it on your own.' : '回到原题独立做一次。')
      : (lang === 'en' ? 'Try the question again later without hints.' : '过后不看提示再做一次。'),
  };
}

/** The learner explained it. What counts is the help given BEFORE this: the confirmation's own recap is not help. */
function closeAsUnderstood(record, lang) {
  record.retellPassed = true;
  record.answeredCorrectly = !record.revealed;
  record.stage = 'summary';
  record.summary = closingSummary(record, lang);
}

/** The help a record has given, which a restart keeps: when and in which round, so an answer of that round still counts as helped (lib/exam-coach.js). */
const helpGivenOn = (record) => (record?.helpAt ? { helpRunId: record.helpRunId ?? null, helpAt: record.helpAt } : {});

/**
 * Atomically commits the evaluated step onto `card.socratic`, and the help it showed onto the run's unanswered question.
 * The answer log (`state.attempts`) is never written: a Socratic step is not an answer.
 */
export function commitCardSocraticStep(state, args = {}, evaluation = {}, now = Date.now()) {
  const { deck, card } = findCard(state, args, '这道题');
  const run = openRunOf(state, args.runId);
  const lang = resolveLanguage(evaluation.language || card.socratic?.language);
  const roundAnswer = roundAnswerOf(run, deck, card);
  // A hint or the reference answer is help; the round it was given in is remembered on the record so that it can only
  // count for that round's answer (#1367-1, #1395 review). Answering in the drawer, or merely opening it, is not help.
  let gaveHelp = false;

  if (evaluation.action === 'reset') {
    const prevMax = card.socratic?.maxHintLevelUsed ?? card.socratic?.hintLevel ?? 0;
    card.socratic = { ...createCardSocraticRecord(card, { language: lang, now, preserveMaxHint: prevMax, roundAnswer }), ...helpGivenOn(card.socratic) };
    return viewOf(deck, card, card.socratic, true);
  }

  assertSameBasis(card, evaluation.basis, lang);
  if (!card.socratic || typeof card.socratic !== 'object') {
    card.socratic = firstRecordOf(card, args, { language: lang, now, roundAnswer });
  }
  const record = card.socratic;
  const say = (kind, text) => appendTurn(record, { role: 'tutor', kind, stage: record.stage, hintLevel: record.hintLevel || 0, text, at: now });
  const ongoing = () => { if (record.stage !== 'summary') record.stage = 'answer'; };

  if (evaluation.action === 'hint') {
    gaveHelp = giveHelp(record, evaluation.help || 'hint', { run, deck, card });
    ongoing();
    say(TUTOR_KIND[evaluation.help] || 'hint', evaluation.reply);
  } else if (evaluation.action === 'reveal') {
    gaveHelp = giveHelp(record, 'answer', { run, deck, card });
    ongoing();
    say('reveal', evaluation.reply || buildRevealMessage(card, lang));
  } else if (evaluation.action === 'answer') {
    ongoing();
    appendTurn(record, { role: 'learner', kind: 'answer', stage: 'answer', hintLevel: record.hintLevel || 0, text: evaluation.text, at: now });
    record.currentAnswer = evaluation.text;
    if (evaluation.understood && !record.retellPassed) {
      closeAsUnderstood(record, lang);
      say('summary', evaluation.reply);
    } else {
      gaveHelp = giveHelp(record, evaluation.help, { run, deck, card });
      say(TUTOR_KIND[evaluation.help] || 'reply', evaluation.reply);
    }
  }

  if (gaveHelp) {
    record.helpRunId = run?.id || null;
    record.helpAt = now;
    // Help after the close still changes how it ended: the result shown and copied must not say 「没用提示」 under a hint or the answer.
    if (record.stage === 'summary') record.summary = closingSummary(record, lang);
  }
  record.updatedAt = now;
  noteRunAssistance(run, deck, card, record);
  return viewOf(deck, card, record, true);
}
