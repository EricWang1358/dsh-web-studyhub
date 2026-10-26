import { getUiLanguage } from '../i18n.js';
import { composeMessage } from './message.js';
import { bookEditPrompt } from './book.js';
import { ingestPrompt } from './ingest.js';
import { importFilePrompt } from './import.js';
import { jobFailedPrompt } from './job.js';
import { deckAnalysisPrompt, topicExplainPrompt, weakTopicsPrompt } from './library.js';
import { archifySkeletonPrompt, designSkeletonPrompt, extendSkeletonPrompt } from './skeleton.js';
import { workflowDesignPrompt, workflowSkeletonPrompt, workflowStepPrompt } from './workflow.js';
import { groupPrompt } from '../topic-group-prompt.js';
import { pathBrief } from './path.js';
import { guideStartPrompt } from './guide.js';
import { pageQuestionPrompt } from './reader.js';

/* The registry of 「发给主会话」 messages (the hand-off plan, section 1.3): every message a StudyHub page hands to the main chat has an id here, and
   ui/hand-off/ sends only ids from it. An entry's builder returns the parts of one message (ui/agent-prompts/message.js: the learner's sentence, the notes
   for the assistant, the data fences); handOffText lays them out the one way every message has: the sentence, the notes (opened by the entry's skill,
   closed by the one language sentence), and the line the learner types after ('paste': 第一批题目：, 'file': the @ that opens the chat's file picker).
   The builders stay in the files of their area (book.js, skeleton.js …); the tool names live there and nowhere else. */

/** id -> { build(input, language) -> message parts, skill?: 'study-book' | 'study-import', tail?: 'ask' | 'paste' | 'file' | 'image' (a message may set its own) }. */
export const HAND_OFFS = Object.freeze({
  'book.edit': { build: (input, language) => bookEditPrompt(input, language), skill: 'study-book' },
  'ingest.start': { build: (input, language) => ingestPrompt(input, language), tail: 'paste' },
  'topic.explain': { build: (input, language) => topicExplainPrompt(input, language) },
  'deck.ask': { build: (input, language) => deckAnalysisPrompt(input, language) },
  'topics.group': { build: (input, language) => groupPrompt(input, language) },
  'import.file': { build: (input, language) => importFilePrompt(input, language), skill: 'study-import', tail: 'file' },
  'job.failed': { build: (input, language) => jobFailedPrompt(input, language) },
  'skeleton.design': { build: (input, language) => designSkeletonPrompt(input, language) },
  'skeleton.archify': { build: (input, language) => archifySkeletonPrompt(input, language) },
  'skeleton.extend': { build: (input, language) => extendSkeletonPrompt(input, language) },
  'review.weakTopics': { build: (input, language) => weakTopicsPrompt(input, language) },
  'workflow.design': { build: (input, language) => workflowDesignPrompt(input, language) },
  'workflow.skeleton': { build: (input, language) => workflowSkeletonPrompt(input, language) },
  'workflow.step': { build: (input, language) => workflowStepPrompt(input, language) },
  'path.brief': { build: (input, language) => pathBrief(input, language) },
  'reader.page': { build: (input, language) => pageQuestionPrompt(input, language), tail: 'image' },
  'guide.start': { build: (input, language) => guideStartPrompt(input, language), skill: 'study-guide', tail: 'ask' },
});

/** Whether `id` names a registered hand-off. */
export const isHandOff = id => Object.hasOwn(HAND_OFFS, id);

/**
 * The whole message of hand-off `id` in `language` (ui/agent-prompts/message.js lays it out). An unknown id throws (a page must not hand over a message
 * nobody registered).
 */
export function handOffText(id, input = {}, language = getUiLanguage()) {
  if (!isHandOff(id)) throw new Error(`Unknown hand-off: ${id}`);
  return composeHandOff(HAND_OFFS[id], input, language);
}

/** One entry's whole message (handOffText of a registered id; the tests compose made-up entries with it). A builder that returns text is its sentence. */
export function composeHandOff(entry, input = {}, language = getUiLanguage()) {
  const built = entry.build(input ?? {}, language);
  const message = typeof built === 'string' ? { ask: built } : built;
  return composeMessage(message, { skill: entry.skill, tail: entry.tail ?? null, language });
}
