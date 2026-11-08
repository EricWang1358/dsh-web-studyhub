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
import { mindMapPrompt, pageQuestionPrompt } from './reader.js';
import { coursePlanPrompt } from './plan.js';
import { guidedStartPrompt } from './guided-start.js';
import { courseFocusPrompt } from './focus.js';
import { customStartPrompt } from './custom.js';
import { selfStartPrompt } from './self.js';
import { methodEditPrompt, methodExplainPrompt } from './method.js';

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
  // 思维导图 of the reader: the chapter's tree drawn from its headings, handed over to be refined from its pages (ui/document-preview/reader/MindMapPanel.jsx)
  'reader.map': { build: (input, language) => mindMapPrompt(input, language) },
  'guide.start': { build: (input, language) => guideStartPrompt(input, language), skill: 'study-guide', tail: 'ask' },
  // 备考计划 on the review book page: drafted with the learner in the chat, saved only after they agree (ui/book/PlanSection.jsx)
  'course.plan': { build: (input, language) => coursePlanPrompt(input, language) },
  // AI 带学 (#549): a sentence that starts guided study, from Settings › 引导 and the empty workbench (ui/guided-study/GuidedStudyStart.jsx)
  'guided.start': { build: (input, language) => guidedStartPrompt(input, language), skill: 'study-tutor' },
  // 录入重点（含只有重点截图 / 照片）: staged under studyhub-work/focus-intake/ for both vision and text-only models (ui/FocusIntakeDialog.jsx)
  'course.focus': { build: (input, language) => courseFocusPrompt(input, language), skill: 'study-import' },
  // 深度定制: the interview that decides what is made of a big book, from a long document's row and the review book's 更多 (ui/custom-entry.js)
  'custom.start': { build: (input, language) => customStartPrompt(input, language), skill: 'study-custom', tail: 'ask' },
  // 自学目标: the interview that turns one sentence into a course with a 学法 (新建课程, ui/CourseSettings.jsx)
  'self.start': { build: (input, language) => selfStartPrompt(input, language), skill: 'study-self', tail: 'ask' },
  // 和主会话改学法 (#775): discuss and shape a course's 学法 flexibly, saved via course.method.save after confirmation (ui/CourseMethodCard.jsx)
  'method.edit': { build: (input, language) => methodEditPrompt(input, language) },
  // 学法「也可以 · AI 带学」 (#775): start guided study scoped to the course and current stage (ui/method-alternatives.js)
  'method.explain': { build: (input, language) => methodExplainPrompt(input, language), skill: 'study-tutor' },
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
