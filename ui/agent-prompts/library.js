import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';

/* The short hand-offs the library home and the results page send to the conversation (ui-consistency #124): ask about a deck or a
   topic, hand over a workspace file, go through the weak topics of a round. They are one sentence each, so deck, topic and course
   names stay inline in 「」 quotes (a name is not free text; the long free text of a card goes through fenceData, see card.js).
   The tool names live here and nowhere else. The English of each sentence is in ui/locales/en.pages.json (or the file it was in). */

/** "Tell me which topics of this deck are weakest and in what order to study." input: { deckTitle }. */
export function deckAnalysisPrompt({ deckTitle }, language = getUiLanguage()) {
  return say(language, '请用 study_workspace 查看题组「{0}」的掌握情况（map），告诉我哪些主题最薄弱，并安排接下来的学习顺序。', [deckTitle]);
}

/** "Explain this topic, then check me with a question or two." input: { topic, deckTitle, mastery (percent), weak (count of weak questions) }. */
export function topicExplainPrompt({ topic, deckTitle, mastery, weak = 0 }, language = getUiLanguage()) {
  return say(language, '请结合学习库里的资料，给我讲解「{0}」（题组「{1}」）。我目前掌握度 {2}%{3}。先讲核心概念，再用一两道小问题检查我是否理解。',
    [topic, deckTitle, mastery, weak ? say(language, '，有 {0} 道题当前薄弱', [weak]) : '']);
}

/** "Read this file in the workspace, add it as a source and generate questions." */
export function workspaceFilePrompt(language = getUiLanguage()) {
  return say(language, '请读取工作区里的 `<文件路径>`，用 study_workspace 添加为学习资料，并生成 10 道题。');
}

/** "These topics are still shaky after the round: explain each and check me." input: { title (the round's name), topics }. */
export function weakTopicsPrompt({ title, topics }, language = getUiLanguage()) {
  return say(language, '我刚在「{0}」里这些主题还没掌握稳：{1}。请结合学习库资料逐个讲清楚，并各出一道小题检查我。', [title, topics.join(', ')]);
}
