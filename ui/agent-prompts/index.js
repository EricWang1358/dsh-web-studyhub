import { getUiLanguage } from '../i18n.js';
import { languageTail, say } from './say.js';
import { bookEditPrompt } from './book.js';
import { ingestPrompt } from './ingest.js';
import { importFilePrompt } from './import.js';
import { deckAnalysisPrompt, topicExplainPrompt, weakTopicsPrompt } from './library.js';
import { archifySkeletonPrompt, designSkeletonPrompt, extendSkeletonPrompt } from './skeleton.js';
import { workflowDesignPrompt, workflowSkeletonPrompt, workflowStepPrompt } from './workflow.js';
import { groupPrompt } from '../topic-group-prompt.js';
import { pathBrief } from '../generation-path-flow.js';

/* The registry of 「发给主会话」 messages (the hand-off plan, section 1.3): every message a StudyHub page hands to the main chat has an id here, and
   ui/hand-off/ sends only ids from it. An entry builds the body from its input; handOffText adds what every message ends with, in this order: the skill
   line (when the entry names a skill), the one language sentence, and the last line the learner types after ('ask': 我想：, 'file': the @ that opens the
   chat's file picker). The builders stay in the files of their area (book.js, skeleton.js …); the tool names live there and nowhere else.
   S2a/S2b hold the hand-offs that already existed (every one is used by a page: the tests count them), and 'import.file' for the audio page; the new
   ones (built on situation.js) are added with their pages. */

/** id -> { build(input, language) -> text, skill?: 'study-book' | 'study-import', tail?: 'ask' | 'file' }. */
export const HAND_OFFS = Object.freeze({
  'book.edit': { build: (input, language) => bookEditPrompt(input, language) },
  'ingest.start': { build: (input, language) => ingestPrompt(input, language) },
  'topic.explain': { build: (input, language) => topicExplainPrompt(input, language) },
  'deck.ask': { build: (input, language) => deckAnalysisPrompt(input, language), tail: 'ask' },
  'topics.group': { build: (input, language) => groupPrompt(input, language), tail: 'ask' },
  'import.file': { build: (input, language) => importFilePrompt(input, language), tail: 'file' },
  'skeleton.design': { build: (input, language) => designSkeletonPrompt(input, language) },
  'skeleton.archify': { build: (input, language) => archifySkeletonPrompt(input, language) },
  'skeleton.extend': { build: (input, language) => extendSkeletonPrompt(input, language) },
  'review.weakTopics': { build: (input, language) => weakTopicsPrompt(input, language) },
  'workflow.design': { build: (input, language) => workflowDesignPrompt(input, language) },
  'workflow.skeleton': { build: (input, language) => workflowSkeletonPrompt(input, language) },
  'workflow.step': { build: (input, language) => workflowStepPrompt(input, language) },
  'path.brief': { build: (input, language) => pathBrief({ ...input, language }) },
});

const SKILL_LINE = '先读 skill {0}。';
const TAILS = { ask: '我想：', file: '文件（不在工作区就粘贴完整路径）：@' };

/** Whether `id` names a registered hand-off. */
export const isHandOff = id => Object.hasOwn(HAND_OFFS, id);

/**
 * The whole message of hand-off `id` in `language`: the entry's body, its skill line, the language sentence and its last line. An unknown id throws (a
 * page must not hand over a message nobody registered).
 */
export function handOffText(id, input = {}, language = getUiLanguage()) {
  if (!isHandOff(id)) throw new Error(`Unknown hand-off: ${id}`);
  return composeHandOff(HAND_OFFS[id], input, language);
}

/** One entry's whole message (handOffText of a registered id; the tests compose made-up entries with it). */
export function composeHandOff(entry, input = {}, language = getUiLanguage()) {
  const lines = [String(entry.build(input ?? {}, language) ?? '').trimEnd()];
  if (entry.skill) lines.push(say(language, SKILL_LINE, [entry.skill]));
  lines.push(languageTail(language));
  if (entry.tail) lines.push(say(language, TAILS[entry.tail]));
  return lines.join('\n');
}
